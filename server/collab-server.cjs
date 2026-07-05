#!/usr/bin/env node
/**
 * SecWriter collaborative editing relay.
 *
 * A Hocuspocus relay for multi-user editing. Persists each Yjs doc via the
 * pluggable storage backend so reconnecting clients recover previous work.
 *
 * CJS on purpose (ADR-0001): Hocuspocus + yjs are required, not imported, so
 * the server shares a single hoisted copy of Yjs with the other CJS server
 * modules — mixing ESM and CJS loads two copies, breaking instanceof checks
 * (see https://github.com/yjs/yjs/issues/438).
 *
 * Auth (JWT), rate limiting, structured logging, and room TTL are available
 * via env vars. TLS must be terminated upstream (reverse proxy). See CLAUDE.md
 * for full env var documentation.
 *
 *   npm run collab
 *
 * Module layout: the server is exposed as a `createCollabServer` factory so
 * tests can spin up an in-process instance without touching env vars or
 * binding a port. The CLI entry-point at the bottom (guarded by
 * `require.main === module`) wires the factory to env-driven config and
 * listens on the configured port.
 *
 * #128 (ADR-0006 / ADR-0002 superseded): the relay was a y-websocket
 * setupWSConnection server until the Hocuspocus cutover. The documentName now
 * travels in-band via the provider `name` (no `/ws/` URL parsing); the token
 * travels in an AuthenticationMessage (no `?token=` in the URL).
 */

require('./dom-polyfill.cjs');
const WS = require('ws');
const WebSocketServer = WS.WebSocketServer || WS.Server;
const Y = require('yjs');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const { createAuthProvider } = require('./auth/auth-provider.cjs');
const { log } = require('./logger.cjs');
const { createRateLimiter } = require('./rate-limiter.cjs');
const { createHttpHandler } = require('./http-handler.cjs');
const { createMigrationCoordinator } = require('./migrate-pm-substrate.cjs');
const { PUBLIC_TENANT, splitCompositeDocName, buildCompositeDocName } = require('./storage-shared.cjs');
const { Hocuspocus } = require('@hocuspocus/server');
const { buildOnAuthenticate, AuthReject } = require('./hocuspocus-auth.cjs');
const { SecWriterDatabase } = require('./secwriter-database.cjs');

// Hard caps. A single spec section is O(100KB) of text; 8 MB gives plenty of
// headroom for Y.Doc overhead + revision history without letting a runaway
// client fill the disk. Persisted snapshot is rejected on both read and
// write if it exceeds this.
const MAX_DOC_BYTES = 8 * 1024 * 1024;

const DEBOUNCE_MS = 500;

// Starvation ceiling on the debounce: a room under continuous edits would
// otherwise keep deferring its store indefinitely. Forces a flush after this
// long regardless. Tune per §8 measurement (Phase 5.2).
const MAX_DEBOUNCE_MS = 10000;

/**
 * Build a collab server in-process. The CLI entry-point at the bottom of
 * this file calls this factory with env-driven config; tests call it
 * directly with explicit storage and listen on an ephemeral port.
 *
 * Returns:
 *   - httpServer:        the http.Server (caller calls .listen() / .close())
 *   - hocuspocus:        the Hocuspocus relay instance.
 *   - database:          the SecWriterDatabase persistence extension (shutdown
 *                        drains its per-key store chains).
 *   - roomHealth:        Map<docName, { persistFailures, lastPersistSuccess }>
 *   - getActiveUsers:    (docName) => [{ id, name, color }] — awareness roster.
 */
function createCollabServer(config) {
  if (!config || !config.storage) {
    throw new Error('createCollabServer: storage is required');
  }
  const {
    storage,
    authProvider = createAuthProvider(),
    rateLimiter = createRateLimiter(),
    host = '127.0.0.1',
    allowedOrigin = '*',
    wsRatePerMin = Number(process.env.SIM_RATE_LIMIT_WS_PER_MIN || 10),
    // Sub-PR 1d (#47, ADR-0006): server-side broker that converts v1 rooms
    // (Y.Text-backed html slots) to v2 (Y.XmlFragment) inside onLoadDocument,
    // before the migrated doc is handed to the client. Tests inject a custom
    // coordinator via `migrationCoordinator` (or disable migration by passing
    // `migrationCoordinator: null`).
    migrationCoordinator = createMigrationCoordinator({ storage, log }),
    // Hocuspocus flush cadence (ms). Defaults to DEBOUNCE_MS. Injectable because
    // it also sets the warm-doc window: with unloadImmediately:false a room stays
    // in memory until its debounced store fires after the last disconnect, so a
    // test exercising warm-doc-across-reconnect can widen this past WS connect
    // latency to stay deterministic under parallel load.
    hocuspocusDebounceMs = DEBOUNCE_MS,
  } = config;

  // #128 (Task 8.3): Hocuspocus is the relay, unconditionally. The legacy
  // y-websocket setupWSConnection path is gone. The historic `useHocuspocus`
  // config flag is now a no-op — callers (incl. existing tests) may still pass
  // it harmlessly, but there is no longer an alternative relay behind it.

  // M-2: per-room persist health tracking. Shared with SecWriterDatabase so the
  // persistFailures/lastPersistSuccess counters survive across stores.
  const roomHealth = new Map();

  // The live in-memory docs live in `hocuspocusInstance.documents` (a
  // Map<docName, Document>; Document extends Y.Doc). `getActiveUsers` and the
  // http-handler's `boundDocs` view both read it lazily — the instance is
  // assigned below, after this closure is defined, so they must not capture it
  // at definition time.
  function getActiveUsers(docName) {
    if (!hocuspocusInstance) return [];
    try {
      const hpDoc = hocuspocusInstance.documents.get(docName);
      if (!hpDoc || !hpDoc.awareness) return [];
      const users = [];
      hpDoc.awareness.getStates().forEach((state) => {
        if (state.user && state.user.id && state.user.name) {
          users.push({ id: state.user.id, name: state.user.name, color: state.user.color || '#888' });
        }
      });
      return users;
    } catch {
      return [];
    }
  }

  // `boundDocs` view for the http-handler: the set of currently-resident docs,
  // keyed by composite docName, exposing the Y.Doc subset the handler reads
  // (.get / .keys / .size / .getMap / .transact). Backed live by
  // hocuspocusInstance.documents. Empty Map before the instance is built.
  const boundDocsView = {
    get: (k) => (hocuspocusInstance ? hocuspocusInstance.documents.get(k) : undefined),
    keys: () => (hocuspocusInstance ? hocuspocusInstance.documents.keys() : [][Symbol.iterator]()),
    get size() { return hocuspocusInstance ? hocuspocusInstance.documents.size : 0; },
  };

  // `flushRoom(docName)`: force-persist a resident room now. Routes through the
  // SecWriterDatabase store (per-key re-entrancy + size cap + roomHealth), so
  // the http-handler upload route can `await` durability before its 200.
  // Returns true iff the write actually landed; false when the room isn't
  // resident or the store was refused/failed, so the caller can surface a 5xx
  // instead of confirming a write that did not happen (#249 review).
  async function flushRoom(docName) {
    if (!hocuspocusInstance || !hocuspocusDatabase) return false;
    const document = hocuspocusInstance.documents.get(docName);
    if (!document) return false;
    return hocuspocusDatabase.store({ documentName: docName, document });
  }

  // ── HTTP + WebSocket on a single port ────────────────────────────────────
  // When deployed to Render (or any platform that exposes one port), WS and
  // HTTP must share a single listener.
  const httpServer = http.createServer(
    createHttpHandler({
      storage,
      boundDocs: boundDocsView,
      flushRoom,
      maxDocBytes: MAX_DOC_BYTES,
      authProvider,
      allowedOrigin,
      getActiveUsers,
      rateLimiter,
      roomHealth,
      migrationCoordinator,
    })
  );

  // #128: the relay is a Hocuspocus instance. onAuthenticate gates every
  // connection (cross-tenant/non-canonical names rejected before any load);
  // onLoadDocument runs the v1→v2 migration broker; SecWriterDatabase persists.
  // The upgrade handler installed here is the ONLY WS listener on httpServer.
  function buildHocuspocus() {
    const onAuthenticate = buildOnAuthenticate({ authProvider, storage });
    const database = new SecWriterDatabase({ storage, roomHealth, maxDocBytes: MAX_DOC_BYTES, log });

    const onLoadDocument = async ({ documentName, document }) => {
      // documentName is the validated canonical key — onAuthenticate already
      // rejected any non-canonical/cross-tenant name BEFORE this runs (§3/§6).
      if (!migrationCoordinator) return document;
      try {
        const result = await migrationCoordinator.ensureMigrated(documentName, document);
        // The broker mutates `document` here, INSIDE onLoadDocument — but Hocuspocus
        // attaches the store-triggering document.onUpdate handler only AFTER this hook
        // returns (verified in @hocuspocus/server@4.3.0 loadDocument: the onUpdate
        // bind runs after the awaited onLoadDocument hook). So a freshly-migrated room
        // would NOT auto-persist its v2 substrate; it would reload as v1 and re-run
        // backupRoom every connect. Persist the migrated doc explicitly. Gate on a real
        // migration (skipped:false) so we don't re-write an already-v2 room or one whose
        // backup failed (skipped:true). A partial migration also returns skipped:false —
        // persisting it is intentional: the migrationPartial flag the broker wrote into
        // yMeta must reach disk so the next connect short-circuits via needsMigration
        // instead of re-attempting on a half-migrated doc. backupRoom already completed
        // inside ensureMigrated before any mutation, so the .ydoc we write here is always
        // backed up first (§6 ordering).
        if (result && result.skipped === false) {
          const persisted = await database.store({ documentName, document });
          if (!persisted) {
            // The migrated v2 substrate did NOT reach storage (transient backend
            // fault — store() counts it in roomHealth.persistFailures and returns
            // false rather than throwing). Hocuspocus binds document.onUpdate only
            // AFTER this hook, so nothing re-persists until the next edit or
            // reconnect; until then every connect reloads the v1 bytes and re-runs
            // the broker, and the migration-partial banner sticks. Log at error so
            // the stuck state is visible instead of silently degrading. #249 review.
            log.error('migrate.persist-failed', { documentName });
          }
        }
      } catch (err) {
        // §6: an onLoadDocument THROW has different Hocuspocus semantics (the load is
        // aborted and the connection closed). The broker is designed to "log
        // and continue, room stays editable + shows the migration-partial banner",
        // so CATCH here and return the document. This is the backstop; ensureMigrated
        // already catches its own per-step errors.
        log.warn('migrate.coordinator-failed', { documentName, err: err && err.message });
      }
      return document;
    };

    const hocuspocus = new Hocuspocus({
      name: 'secwriter',
      quiet: true,
      onLoadDocument,
      async onAuthenticate(data) {
        try {
          const ctx = await onAuthenticate(data);
          // #239 viewer read-only gate: mutating data.connection.readOnly here
          // makes Hocuspocus reject (and NOT sync) this connection's document
          // update messages for its whole lifetime — the WS-layer write denial
          // a viewer role requires. Editors/owners leave it false. The returned
          // ctx becomes the connection context (available to later hooks).
          if (ctx && ctx.readOnly && data.connection) data.connection.readOnly = true;
          return ctx;
        } catch (err) {
          if (err instanceof AuthReject) {
            log.warn('ws.auth-reject', { status: err.status, reason: err.reason });
            // Throw a plain Error so Hocuspocus closes the connection with the
            // SAME opaque close for every rejection (no tenant-mismatch vs
            // can't-see-room signal).
            throw new Error('Unauthorized');
          }
          // Storage I/O fault in readAcl: fail CLOSED.
          log.error('ws.authorize-failed', { err: err && err.message });
          throw new Error('Unauthorized');
        }
      },
      extensions: [database],
      // Flush cadence (§2): the debounce coalesces edits into one store;
      // maxDebounce adds a starvation ceiling so a continuously-edited room
      // still persists.
      // CAUTION: the Hocuspocus DEFAULT debounce is 2000ms, NOT 500. We set 500;
      // store() runs the FULL serializeRoom over every
      // block + an S3/Azure write — at 500ms that can fire up to twice a second per
      // active room. Measure serialize+write cost in Phase 5.2 and RAISE this if a
      // realistic room saturates I/O; do not keep 500 by inertia. Sourced from the
      // injectable hocuspocusDebounceMs (defaults to DEBOUNCE_MS) — it also widens
      // the warm-doc window for the Task 7.2 reconnect test.
      debounce: hocuspocusDebounceMs,
      maxDebounce: MAX_DEBOUNCE_MS,
      // gc pinned true to match the v2 substrate's production gc and the
      // cross-stack rollback gate (Phase 9).
      yDocOptions: { gc: true },
      // SEED DURABILITY (Phase 7 / option A companion): keep a room's doc warm
      // briefly after the last client disconnects instead of unloading immediately,
      // so a provider remount re-syncs seeded content from MEMORY (never observes
      // false-empty → never re-seeds) and the seed's debounced store completes
      // before unload.
      unloadImmediately: false,
    });
    const hwss = new WebSocketServer({ noServer: true });
    // An unhandled 'error' on a ws WebSocketServer (or a per-connection socket,
    // below) is an EventEmitter throw → uncaught exception → process crash. The
    // bundled Hocuspocus `Server` wires these internally; this manual noServer
    // pump does not get that for free, so wire them ourselves (matches the
    // pre-#128 y-websocket `wss.on('error')` posture). #249 review.
    hwss.on('error', (err) => {
      log.error('server.ws-error', { err: err && err.message });
    });
    httpServer.on('upgrade', (req, socket, head) => {
      // Pre-auth DoS seam (§1): per-IP WS rate-limit BEFORE handleConnection.
      const ip = socket.remoteAddress || 'unknown';
      const wsCheck = rateLimiter.checkLimit(ip, 'ws', wsRatePerMin);
      if (!wsCheck.allowed) {
        log.warn('ws.rate-limited', { ip, retryAfter: wsCheck.retryAfter });
        socket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n');
        socket.destroy();
        return;
      }
      hwss.handleUpgrade(req, socket, head, (conn) => {
        // documentName + token travel in-band (provider `name`/`token`); auth
        // runs in onAuthenticate. The 3rd arg is the defaultContext.
        // v4 `handleConnection` only CONSTRUCTS the ClientConnection — it does
        // NOT attach socket listeners. The integration must pump messages in
        // (the bundled Server does exactly this; see hocuspocus-server.cjs
        // open/message/close hooks). Without the pump the connection never
        // syncs (onAuthenticate/onLoadDocument never fire).
        const clientConnection = hocuspocus.handleConnection(conn, req, { remoteAddress: ip });
        conn.on('message', (data) => {
          const bytes = Array.isArray(data) ? Buffer.concat(data) : data;
          clientConnection.handleMessage(new Uint8Array(bytes));
        });
        conn.on('close', (code, reason) => {
          clientConnection.handleClose({ code, reason: reason ? reason.toString() : '' });
        });
        // A socket-level error (malformed frame, ECONNRESET, TLS fault) emits
        // 'error' on the ws connection; with no listener Node rethrows it as an
        // uncaught exception and the whole relay dies. ws fires 'close' after
        // 'error', so handleClose still runs — just log and let it close. #249.
        conn.on('error', (err) => {
          log.warn('ws.socket-error', { ip, err: err && err.message });
        });
      });
    });
    // `database` is returned for Phase 5: the shutdown path drains its per-key
    // store chains (the bare Hocuspocus class has no awaitable destroy()). The
    // current call site only pulls `hocuspocus`; Task 5.1 threads `database`
    // onto the factory return.
    return { hocuspocus, hwss, database };
  }

  let hocuspocusInstance = null;
  let hocuspocusDatabase = null;
  {
    const built = buildHocuspocus();
    hocuspocusInstance = built.hocuspocus;
    hocuspocusDatabase = built.database;
  }

  /**
   * Test-friendly cleanup: close every open WS connection so
   * httpServer.close() can complete. Production shutdown drains the
   * SecWriterDatabase store chains first (see startFromEnv's shutdown handler)
   * to persist pending edits before tearing down.
   */
  function cleanup() {
    try { hocuspocusInstance.closeConnections(); } catch { /* ignore */ }
  }

  return {
    httpServer,
    hocuspocus: hocuspocusInstance,
    database: hocuspocusDatabase,
    roomHealth,
    flushRoom,
    getActiveUsers,
    cleanup,
    storage,
  };
}

// ── CLI entry-point ──────────────────────────────────────────────────────
// Auto-listens with env-driven config when invoked directly. Tests
// require() this module to call createCollabServer without binding any port.
function startFromEnv() {
  const PORT = Number(process.env.COLLAB_PORT || 1234);
  const HOST = process.env.COLLAB_HOST || '127.0.0.1';
  // SIM_LOCAL_STORAGE_DIR isolates test storage from dev storage so an E2E
  // run can wipe rooms in its own directory without touching the developer's
  // work-in-progress rooms in server/collab-db/. Without isolation, dev rooms
  // accumulated in shared storage make GET /rooms slow (see issue #100).
  const DATA_DIR = path.resolve(process.cwd(), process.env.SIM_LOCAL_STORAGE_DIR || 'server/collab-db');

  const { createStorageFromEnv } = require('./storage-factory.cjs');
  const { storage, backend, detail } = createStorageFromEnv(process.env);
  log.info('storage.backend', { backend, ...detail });

  if (process.env.SIM_STORAGE_BACKEND !== 'azure' && process.env.SIM_STORAGE_BACKEND !== 's3') {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    // N4 — orphan .tmp sweep at startup. Owned by the storage backend: it
    // knows the layout (writeRoom stages at <dir>/<tenant>/<room>.<ext>.tmp,
    // so a top-level readdir here would never see a post-tenant orphan).
    try {
      if (typeof storage.sweepOrphanTmpFiles === 'function') {
        const removed = storage.sweepOrphanTmpFiles();
        if (removed > 0) log.info('startup.tmp-swept', { removed });
      }
    } catch (err) {
      log.warn('startup.tmp-sweep-failed', { err: err.message });
    }
  }

  // Loud warning if the operator has flipped off loopback. The prototype has
  // no auth; binding to anything else is a data-exfiltration vector.
  if (HOST !== '127.0.0.1' && HOST !== 'localhost' && HOST !== '::1') {
    console.warn('');
    console.warn('╔════════════════════════════════════════════════════════════╗');
    console.warn('║  WARNING: collab-server bound to a non-loopback host.     ║');
    console.warn(`║  HOST=${HOST.padEnd(52)}║`);
    console.warn('║  Ensure TLS is terminated upstream (reverse proxy).       ║');
    console.warn('║  Auth + rate limiting available — see env var docs.      ║');
    console.warn('╚════════════════════════════════════════════════════════════╝');
    console.warn('');
  }

  const allowedOrigin = process.env.SIM_COLLAB_ORIGIN || '*';
  const authProvider = createAuthProvider();
  const server = createCollabServer({ storage, host: HOST, allowedOrigin, authProvider });

  const LISTEN_PORT = Number(process.env.PORT || process.env.COLLAB_PORT || 1234);
  (async () => {
    // Legacy flat-room guard: rooms persisted before the composite-key
    // scheme live at un-namespaced keys that the tenant-prefixed reads can
    // never resolve — every such room would load as 'room.new' and the first
    // flush would overwrite it with an empty doc (silent data loss). Under
    // auth=none, pre-tenant rooms belong in '_public' by definition, so
    // relocate them automatically BEFORE accepting connections (no ACL —
    // matching what POST /rooms writes under auth=none). Under auth, the
    // right tenant/owner is the operator's call — refuse to guess, log
    // loudly, and point at the migration script.
    try {
      if (!authProvider.requiresAuth) {
        const moved = await storage.migrateLegacyFlatRooms({ tenant: PUBLIC_TENANT });
        if (moved > 0) log.info('startup.legacy-rooms-migrated', { moved, tenant: PUBLIC_TENANT });
      } else {
        const count = await storage.countLegacyFlatRooms();
        if (count > 0) {
          log.error('startup.legacy-rooms-detected', {
            count,
            hint: 'pre-tenant rooms are unreachable under composite keys — run: SIM_DEFAULT_TENANT=<tenant> SIM_DEFAULT_OWNER=<sub> node server/migrate-tenant-namespace.cjs',
          });
        }
      }
    } catch (err) {
      log.warn('startup.legacy-check-failed', { err: err.message });
    }

    server.httpServer.listen(LISTEN_PORT, HOST, () => {
      log.info('server.listening', { transport: 'http+ws', host: HOST, port: LISTEN_PORT });
      log.info('server.storage', { dir: DATA_DIR });
      log.info('server.config', { maxDocBytes: MAX_DOC_BYTES });
    });
  })();

  // ── Room TTL/Expiry ────────────────────────────────────────────────
  const ARCHIVE_DAYS = Number(process.env.SIM_ROOM_ARCHIVE_DAYS || 30);
  const DELETE_DAYS = Number(process.env.SIM_ROOM_DELETE_DAYS || 90);
  const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;

  async function sweepRooms() {
    const now = Date.now();
    log.info('sweep.start', {});
    try {
      const rooms = await storage.listAllRooms(); // [{ tenant, roomId }]
      for (const { tenant, roomId } of rooms) {
        const composite = buildCompositeDocName(tenant, roomId);
        // Skip currently-resident rooms — they're being actively edited, and
        // their state lives in memory (not necessarily flushed). The live docs
        // are Hocuspocus's in-memory documents Map, keyed by composite name.
        if (server.hocuspocus.documents.has(composite)) continue;
        const stat = await storage.statRoom(tenant, roomId);
        if (!stat || !stat.lastModified) continue;
        const idleMs = now - new Date(stat.lastModified).getTime();
        const idleDays = idleMs / (24 * 60 * 60 * 1000);
        if (idleDays >= ARCHIVE_DAYS) {
          log.info('sweep.archive', { roomId: composite, idleDays: Math.round(idleDays) });
          await storage.archiveRoom(tenant, roomId);
        }
      }
    } catch (err) {
      log.error('sweep.archive.failed', { err: err.message });
    }
    try {
      if (typeof storage.listAllArchivedRooms === 'function') {
        const archived = await storage.listAllArchivedRooms(); // [{ tenant, roomId, archivedAt }]
        for (const { tenant, roomId, archivedAt } of archived) {
          if (!archivedAt) continue;
          const archivedDays = (now - new Date(archivedAt).getTime()) / (24 * 60 * 60 * 1000);
          if (archivedDays >= DELETE_DAYS) {
            log.info('sweep.delete', { roomId: buildCompositeDocName(tenant, roomId), archivedDays: Math.round(archivedDays) });
            await storage.deleteArchivedRoom(tenant, roomId);
          }
        }
      }
    } catch (err) {
      log.error('sweep.delete.failed', { err: err.message });
    }
    log.info('sweep.done', {});
  }

  setTimeout(() => sweepRooms().catch(err => log.error('sweep.uncaught', { err: err.message })), 5000);
  const sweepTimer = setInterval(() => sweepRooms().catch(err => log.error('sweep.uncaught', { err: err.message })), SWEEP_INTERVAL_MS);
  if (sweepTimer.unref) sweepTimer.unref();

  // ── Graceful shutdown ──────────────────────────────────────────────
  let shuttingDown = false;
  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info('server.shutdown', {
      signal,
      rooms: server.hocuspocus.getDocumentsCount(),
    });
    // The whole drain is wrapped so shutdown is ALWAYS terminal: a drain that
    // rejects must still close the listeners + exit, or the process hangs until
    // Render force-kills it (SIGKILL) — defeating the graceful flush. (A drain
    // that HANGS rather than rejects is still bounded by Render's SIGKILL grace;
    // drain wall-time within that grace is the Task 5.2 gate.)
    try {
      // The bare Hocuspocus class has NO destroy() (Task 1.2). Drain in 3 steps:
      //   1. closeConnections()   — stop accepting new edits.
      //   2. flushPendingStores() — kick the debounced onStoreDocument for every
      //      dirty room. Returns void; does NOT await.
      //   3. await database.drain() — await our own per-key store-chain promises
      //      (SecWriterDatabase._storeChains). This is how we KNOW every store
      //      completed, and it inherits the per-key re-entrancy guard so no two
      //      overlapping stores race the same .ydoc into storage (§2/§8).
      server.hocuspocus.closeConnections();
      server.hocuspocus.flushPendingStores();
      // database is set in lockstep with hocuspocus; the guard is defensive
      // against a future subclass passing a null database.
      if (server.database) await server.database.drain();
    } catch (err) {
      log.error('server.shutdown-drain-failed', { signal, err: err && err.message });
    } finally {
      try { server.httpServer.close(); } catch { /* ignore */ }
      setTimeout(() => process.exit(0), 50);
    }
  }
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  return server;
}

module.exports = { createCollabServer, startFromEnv, MAX_DOC_BYTES };

if (require.main === module) {
  startFromEnv();
}
