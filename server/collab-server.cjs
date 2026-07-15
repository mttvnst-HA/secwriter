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
const { ResetConnection } = require('@hocuspocus/common');
const { buildOnAuthenticate, AuthReject } = require('./hocuspocus-auth.cjs');
const { resolveRole, pendingInviteTtlMs, normalizeEmail } = require('./auth/authorize.cjs');
const { SecWriterDatabase } = require('./secwriter-database.cjs');
const { createAclMutex } = require('./acl-mutex.cjs');
const { promotePending } = require('./promote-pending.cjs');

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

  // #267 seam 4: ONE shared ACL RMW mutex for both the share route (HTTP) and
  // promotePending (WS connect). Single-instance-bound (ADR-0017).
  const { withAclLock } = createAclMutex();

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

  // `revokeLiveSessions(tenant, roomId, { subjects, emails })` (#268/#267): force
  // already-open
  // WS sessions in a room to reconnect + re-authenticate NOW, so an ACL role
  // change takes effect on live sessions instead of only at the next reconnect.
  // Kicks by hard-closing the raw socket with ResetConnection (4205) — the ONLY
  // primitive that makes HocuspocusProvider auto-reconnect and re-run
  // onAuthenticate with the fresh role. `Connection.close()` /
  // `hocuspocus.closeConnections()` are a SOFT in-band detach (socket stays open,
  // client goes dormant, never re-auths) — do NOT use them for revocation.
  // Selectors match by `conn.context.user.id` (`subjects`) and/or by
  // normalized `conn.context.user.email` (`emails`, #267 — reaches
  // pending-by-email invitees that have no bound ACL subject). Both selectors
  // undefined = kick every connection (room deletion). Returns the count of
  // sockets closed.
  //
  // INTERNAL REACH — pinned to @hocuspocus/server 4.3.0: `doc.connections` keys
  // are Connection instances; `conn.context` is the onAuthenticate return (so
  // `.user.id` — the same namespace as the ACL key / share `body.userId`), and
  // `conn.webSocket` is the raw ws socket. A Hocuspocus bump that reshapes any of
  // these breaks this silently — the T1–T4 revoke tests in
  // hocuspocus-server.test.mjs are the tripwire (T4 pins the identity match).
  function revokeLiveSessions(tenant, roomId, { subjects, emails } = {}) {
    if (!hocuspocusInstance) return 0;
    const doc = hocuspocusInstance.documents.get(buildCompositeDocName(tenant, roomId));
    if (!doc) return 0; // room not resident — nothing live to revoke
    const subjectSet = subjects && new Set(subjects);
    const emailSet = emails && new Set(emails.map((e) => normalizeEmail(e)));
    const filtering = !!(subjectSet || emailSet); // neither selector = kick ALL
    let n = 0;
    doc.connections.forEach((_v, conn) => {
      const u = conn.context && conn.context.user;
      const uid = u && u.id;
      if (!uid) return;
      if (filtering) {
        const bySubject = subjectSet && subjectSet.has(uid);
        const byEmail = emailSet && u.email && emailSet.has(normalizeEmail(u.email));
        if (!bySubject && !byEmail) return;
      }
      try { conn.webSocket.close(ResetConnection.code, ResetConnection.reason); n += 1; }
      catch (err) { log.warn('revoke.close-failed', { err: err && err.message }); }
    });
    if (n) log.info('revoke.sessions-closed', { tenant, roomId, n, all: !filtering });
    return n;
  }

  // ── Live-session revocation sweep (#268 backstop) ──────────────────
  // The event-triggered kicks on the share/delete routes are the fast path;
  // this periodic re-authorization pass is the safety net for ACL changes that
  // bypass those routes (direct-storage edits, the tenant-migration script, or a
  // future route someone forgets to wire). It bounds worst-case revocation
  // latency for ANY resident room to one interval. Skipped entirely under
  // auth=none — every room is _public / editor there, so there is nothing to
  // revoke. The predicate kicks BOTH directions: a removed member (no role) and
  // a grade mismatch (downgrade editor→viewer, or upgrade viewer→editor where
  // the event path deliberately left the read-only session in place). Exposed on
  // the createCollabServer return so it can be driven deterministically from a
  // test (startFromEnv wraps it in the SIM_REVOKE_SWEEP_MS interval).
  async function revokeSweep() {
    if (!authProvider.requiresAuth) return;
    for (const [composite, doc] of hocuspocusInstance.documents) {
      let acl;
      try {
        const { tenant, roomId } = splitCompositeDocName(composite);
        acl = await storage.readAcl(tenant, roomId);
      } catch (err) {
        log.warn('revoke-sweep.acl-read-failed', { composite, err: err && err.message });
        continue;
      }
      doc.connections.forEach((_v, conn) => {
        const user = conn.context && conn.context.user;
        const uid = user && user.id;
        if (!uid) return;
        // #267: resolveRole so a validly-pending session (admitted via pending,
        // not yet bound by the fire-and-forget promote) is NOT swept-closed
        // during the connect->persist window. Reads the same conn.context.user
        // (id + email) the kick path uses.
        const { role } = resolveRole(acl, user, Date.now(), pendingInviteTtlMs());
        const stale = !role || (role === 'viewer') !== !!conn.readOnly;
        if (stale) {
          try { conn.webSocket.close(ResetConnection.code, ResetConnection.reason); }
          catch (err) { log.warn('revoke-sweep.close-failed', { err: err && err.message }); }
        }
      });
      // Yield between rooms so a large docs map can't starve the event loop
      // (mirrors the GET /rooms setImmediate guard, ADR-0014 pattern #4).
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  // Room deletion is split into three steps so a FAILED storage.deleteRoom
  // never destroys data it can't get back (review finding #1: the earlier
  // single evictRoom() destroyed the live doc unconditionally before
  // deleteRoom ran, so a transient storage fault on deleteRoom permanently
  // lost whatever unflushed edits the doc held, with no way to recover them
  // even though the room technically still existed on disk).
  //
  //   1. beginRoomDeletion(docName) — call BEFORE storage.deleteRoom. Tombstones
  //      the name (so any pending/queued store() no-ops) and awaits any
  //      IN-FLIGHT store so its write lands before deleteRoom runs (deleteRoom
  //      then wins, last writer). Does NOT touch the live doc or connections —
  //      if deleteRoom subsequently fails, the room is still fully live.
  //   2a. On deleteRoom SUCCESS, call finishRoomDeletion(docName) — kicks live
  //       sessions, drops the doc from the resident map, destroys it, and
  //       forgets the migration coordinator's cache entry for the name (folded
  //       in here — review finding #4 — so there is exactly one call site that
  //       guarantees both per-room invalidation mechanisms fire together;
  //       previously the DELETE route had to remember to call both separately).
  //   2b. On deleteRoom FAILURE, call cancelRoomDeletion(docName) instead — lifts
  //       the tombstone so the still-live, still-undestroyed doc resumes
  //       storing normally (the delete didn't happen; nothing should look torn
  //       down).
  // Hocuspocus exposes no awaitable per-doc cancel (unloadDocument early-returns
  // while a store is pending, and the debouncer only exposes executeNow, which
  // FIRES the store), so the no-op is enforced in database.store(), not by
  // cancelling the debounce timer. See ADR-0017 "Live-session revocation".
  async function beginRoomDeletion(docName) {
    if (!hocuspocusDatabase) return;
    hocuspocusDatabase.markDeleted(docName);
    await hocuspocusDatabase.awaitPendingStore(docName);
  }

  function cancelRoomDeletion(docName) {
    if (hocuspocusDatabase) hocuspocusDatabase.unmarkDeleted(docName);
  }

  async function finishRoomDeletion(docName) {
    if (migrationCoordinator && typeof migrationCoordinator.forget === 'function') {
      migrationCoordinator.forget(docName);
    }
    if (!hocuspocusInstance) return;
    const document = hocuspocusInstance.documents.get(docName);
    // revokeLiveSessions (#268) HARD-kicks every live session (ResetConnection)
    // BEFORE the doc leaves the resident map, since it looks the doc up via
    // hocuspocusInstance.documents — this must run before the map delete below.
    // Gives a deleted room's clients the correct forced-reconnect ->
    // onAuthenticate-fails-on-missing-ACL UX, instead of the soft detach
    // closeConnections() alone would leave them in (socket open, client
    // dormant, never re-auths — see revokeLiveSessions' own doc comment).
    try {
      const { tenant, roomId } = splitCompositeDocName(docName);
      revokeLiveSessions(tenant, roomId);
    } catch (err) { log.warn('evict.revoke-failed', { docName, err: err && err.message }); }
    // Soft backstop for any connection revokeLiveSessions didn't reach (e.g. a
    // lookup with no conn.context.user.id, or its own try/catch swallowing a
    // close failure). Does NOT itself trigger a store under unloadImmediately:
    // false; any armed debounce was already handled by beginRoomDeletion.
    try { hocuspocusInstance.closeConnections(docName); } catch { /* best-effort */ }
    if (document) {
      hocuspocusInstance.documents.delete(docName);
      try { document.destroy(); } catch { /* already destroyed */ }
    }
  }

  // Architecture-review candidate #4 — one owning seam for the room-deletion
  // transaction. The begin -> deleteRoom -> (rollback | finish) ordering is a
  // correctness invariant (a store racing deleteRoom must not RESURRECT the
  // room; a FAILED deleteRoom must not DESTROY the still-live doc + its
  // unflushed edits). Previously the DELETE route re-assembled that order by
  // hand at two call sites, glued only by prose — deleting any step still
  // compiled and returned 200 while silently dropping the protection. Folding
  // it here means a caller (existing or future) invokes ONE method and cannot
  // get the sequence wrong. Steps are documented on beginRoomDeletion /
  // finishRoomDeletion / cancelRoomDeletion above. Rethrows a deleteRoom
  // failure AFTER rolling the tombstone back so the route still surfaces 500
  // and the room stays fully live.
  async function deleteRoomTransactionally(tenant, roomId) {
    const docName = buildCompositeDocName(tenant, roomId);
    await beginRoomDeletion(docName);
    try {
      await storage.deleteRoom(tenant, roomId);
    } catch (err) {
      cancelRoomDeletion(docName);
      throw err;
    }
    await finishRoomDeletion(docName);
  }

  // ── HTTP + WebSocket on a single port ────────────────────────────────────
  // When deployed to Render (or any platform that exposes one port), WS and
  // HTTP must share a single listener.
  const httpServer = http.createServer(
    createHttpHandler({
      storage,
      boundDocs: boundDocsView,
      flushRoom,
      deleteRoomTransactionally,
      revokeLiveSessions,
      withAclLock,
      maxDocBytes: MAX_DOC_BYTES,
      authProvider,
      allowedOrigin,
      getActiveUsers,
      rateLimiter,
      roomHealth,
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
          // Deliberately do NOT thread `instance` here (unlike flushRoom's
          // omission, which is safe for a different reason — see its own
          // comment). Verified empirically against @hocuspocus/server@4.3.0:
          // `instance.documents` does NOT yet contain this document while
          // onLoadDocument is still running — Hocuspocus's createDocument only
          // calls `this.documents.set(documentName, doc)` AFTER the whole
          // loadDocument() (including this hook) resolves. Passing `instance`
          // would make the identity guard compare against `undefined` and trip
          // on EVERY migration persist, not just a raced one — silently
          // breaking migration persistence entirely (verified regression, not
          // theoretical). The plain `_deleted` tombstone check alone already
          // fully covers a DELETE racing this call: Hocuspocus's own
          // `loadingDocuments` de-dupes concurrent loads of the same name, so
          // no second/"recreated" document can begin loading (and no fresh
          // fetch() can lift the tombstone) until THIS load — including this
          // store() call — has fully resolved. See
          // server/__tests__/collab-server-migration-persist.test.mjs for the
          // pinning regression (reviewed: 2026-07-06 finding).
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
          // #239 viewer read-only gate: Hocuspocus builds the Connection from
          // `connectionConfig.readOnly` (hocuspocus-server.cjs — Connection ctor
          // reads hookPayload.connectionConfig.readOnly) and drops that
          // connection's Yjs sync/update frames when it is true; it also sends
          // the client its Authenticated scope from the SAME field. The
          // onAuthenticate hook payload exposes `connectionConfig`, NOT a
          // `connection` key — mutating `data.connection.readOnly` was a silent
          // no-op (viewers stayed read-write, client always saw 'read-write').
          // Editors/owners leave it false. Pinned by hocuspocus-server.test.mjs.
          if (ctx && ctx.readOnly && data.connectionConfig) data.connectionConfig.readOnly = true;
          // #267 seam 3: fire-and-forget pending-invite bind. Never blocks the
          // connect verdict — resolveRole (in onAuthenticate) already granted the
          // pending invitee. Runs under the shared ACL mutex; skips a tombstoned
          // room via database.isDeleted. auth=none has no email → no-op.
          if (authProvider && authProvider.requiresAuth && ctx && ctx.user && ctx.user.email) {
            const compositeKey = buildCompositeDocName(ctx.tenant, ctx.roomId);
            promotePending({
              storage, tenant: ctx.tenant, roomId: ctx.roomId, user: ctx.user,
              withAclLock, isDeleted: (k) => database.isDeleted(k), compositeKey,
              now: Date.now(), ttlMs: pendingInviteTtlMs(), log,
            }).catch((err) => log.warn('promote.failed', { err: err && err.message }));
          }
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
    deleteRoomTransactionally,
    revokeLiveSessions,
    revokeSweep,
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

  // ── Live-session revocation sweep (#268 backstop) ──────────────────
  // The sweep itself lives in createCollabServer (exposed as server.revokeSweep
  // so tests can drive it deterministically); here we just arm the periodic
  // interval. See the revokeSweep doc comment in createCollabServer for the
  // safety-net rationale and the both-directions kick predicate.
  const REVOKE_SWEEP_MS = Number(process.env.SIM_REVOKE_SWEEP_MS || 60000);
  const revokeSweepTimer = setInterval(
    () => server.revokeSweep().catch((err) => log.error('revoke-sweep.uncaught', { err: err && err.message })),
    REVOKE_SWEEP_MS,
  );
  if (revokeSweepTimer.unref) revokeSweepTimer.unref();

  // ── Deleted-room tombstone sweep (ADR-0017 follow-up review finding #3) ──
  // SecWriterDatabase._deleted only shrinks on a fresh load of the same name
  // (fetch() lifts it) or a failed-delete rollback (unmarkDeleted()) — a room
  // that's deleted and never recreated would otherwise tombstone forever on
  // this long-running, single-instance process. TOMBSTONE_MAX_AGE_MS
  // comfortably exceeds any legitimate resurrection race window (bounded by
  // maxDebounce + a migration's backupRoom duration, both on the order of
  // seconds), so routine deletions can't outlive it and get swept away too
  // early.
  const TOMBSTONE_SWEEP_MS = Number(process.env.SIM_TOMBSTONE_SWEEP_MS || 60 * 60 * 1000);
  const TOMBSTONE_MAX_AGE_MS = Number(process.env.SIM_TOMBSTONE_MAX_AGE_MS || 24 * 60 * 60 * 1000);
  const tombstoneSweepTimer = setInterval(() => {
    try {
      if (server.database && typeof server.database.sweepDeletedTombstones === 'function') {
        server.database.sweepDeletedTombstones(TOMBSTONE_MAX_AGE_MS);
      }
    } catch (err) {
      log.error('tombstone-sweep.uncaught', { err: err && err.message });
    }
  }, TOMBSTONE_SWEEP_MS);
  if (tombstoneSweepTimer.unref) tombstoneSweepTimer.unref();

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
