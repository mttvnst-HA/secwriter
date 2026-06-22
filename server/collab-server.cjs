#!/usr/bin/env node
/**
 * SecWriter collaborative editing relay.
 *
 * A thin y-websocket server for the multi-user prototype. Persists each Yjs
 * doc to disk as a binary state snapshot so reconnecting clients recover
 * previous work.
 *
 * CJS on purpose: y-websocket v1.5.4 ships its server utils as CJS and imports
 * yjs via `require`. Mixing ESM and CJS loads two copies of Yjs, which breaks
 * instanceof checks (see https://github.com/yjs/yjs/issues/438).
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
 */

require('./dom-polyfill.cjs');
const WS = require('ws');
// y-websocket v1.5.4 pins ws@6, which exports the server as `Server` (not
// `WebSocketServer`). Support both so a future ws upgrade doesn't break us.
const WebSocketServer = WS.WebSocketServer || WS.Server;
const Y = require('yjs');
const ywsUtils = require('y-websocket/bin/utils');
const { setupWSConnection, setPersistence, getYDoc, docs: ywsDocs } = ywsUtils;
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const { createAuthProvider } = require('./auth/auth-provider.cjs');
const { log } = require('./logger.cjs');
const { createRateLimiter } = require('./rate-limiter.cjs');
const { createHttpHandler } = require('./http-handler.cjs');
const { createMigrationCoordinator } = require('./migrate-pm-substrate.cjs');
const { PUBLIC_TENANT, splitCompositeDocName, buildCompositeDocName, sanitize } = require('./storage-shared.cjs');
const { authorize, ACTION } = require('./auth/authorize.cjs');
const { Hocuspocus } = require('@hocuspocus/server');
const { buildOnAuthenticate, AuthReject } = require('./hocuspocus-auth.cjs');
const { SecWriterDatabase } = require('./secwriter-database.cjs');
// `ws` is already imported for the y-websocket path; reuse that WebSocketServer.

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
 * Extract the docName from a WebSocket request URL.
 *
 * y-websocket's built-in extraction (`req.url.slice(1).split('?')[0]`) treats
 * the entire path-tail as the docName. When the frontend's
 * `VITE_COLLAB_WS_URL` includes a path suffix (e.g. Render's
 * `wss://host/ws`), the WebsocketProvider builds connection URLs as
 * `wss://host/ws/<room>`. The default extraction then yields `"ws/<room>"`,
 * which is a different docName from what the HTTP API uses for the same
 * room. After sanitization (`/` → `_` in storage keys), the room ends up
 * split across two persisted slots — `<room>.ydoc` (HTTP-managed) and
 * `ws_<room>.ydoc` (WS-managed). See issue #17.
 *
 * Strip a leading `/ws/` so the docName matches the HTTP API regardless of
 * what path suffix the frontend's WS URL carries.
 */
function extractDocName(reqUrl) {
  if (typeof reqUrl !== 'string') return '';
  const noQuery = reqUrl.split('?')[0];
  let pathname = noQuery.startsWith('/') ? noQuery.slice(1) : noQuery;
  if (pathname.startsWith('ws/')) pathname = pathname.slice(3);
  return pathname;
}

/**
 * Build a collab server in-process. The CLI entry-point at the bottom of
 * this file calls this factory with env-driven config; tests call it
 * directly with explicit storage and listen on an ephemeral port.
 *
 * Returns:
 *   - httpServer:        the http.Server (caller calls .listen() / .close())
 *   - wss:               the WebSocketServer attached to httpServer
 *   - boundDocs:         Map<docName, Y.Doc>
 *   - docLoadPromises:   Map<docName, Promise<void>> — resolves when the
 *                        room's persisted state has finished loading. The
 *                        WS connection handler awaits this before sync
 *                        starts so a fresh client never seeds an empty doc
 *                        that's actually in mid-load (see issue #17).
 *   - roomHealth:        Map<docName, { persistFailures, lastPersistSuccess }>
 *   - flushRoom:         (docName) => Promise — write artifacts now
 *   - flushAllRooms:     () => Promise — write every bound room (shutdown)
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
    // (Y.Text-backed html slots) to v2 (Y.XmlFragment) inside the WS upgrade
    // handler, after preload + the eviction guard but before the upgrade
    // completes. Tests inject a custom coordinator via `migrationCoordinator`
    // (or disable migration by passing `migrationCoordinator: null`).
    migrationCoordinator = createMigrationCoordinator({ storage, log }),
  } = config;

  // Migration scaffolding (#128): when useHocuspocus is set, the relay is a
  // Hocuspocus instance instead of the y-websocket setupWSConnection path.
  // Phase 1 wires a minimal instance (no auth, in-memory) so Gate A1 can run;
  // Phase 3/4 fill in onAuthenticate + SecWriterDatabase.
  const useHocuspocus = config.useHocuspocus === true;

  // Debounced per-room persistence: one set of artifacts per room, rewritten
  // at most once every DEBOUNCE_MS after any update.
  const writeTimers = new Map();
  // Track the per-room Y.Doc so the shutdown handler can flush every room
  // even if its timer hasn't fired.
  const boundDocs = new Map();
  // M-2: per-room persist health tracking.
  const roomHealth = new Map();
  // Issue #17: per-room load promises. Resolved when bindState's persisted
  // state has been applied; the WS connection handler awaits these so the
  // first sync to a fresh client never carries an empty state vector for a
  // room that's currently loading.
  const docLoadPromises = new Map();

  function getHealth(docName) {
    let h = roomHealth.get(docName);
    if (!h) {
      h = { persistFailures: 0, lastPersistSuccess: null };
      roomHealth.set(docName, h);
    }
    return h;
  }

  function getActiveUsers(docName) {
    const ydoc = boundDocs.get(docName);
    if (!ydoc) return [];
    try {
      const wsDoc = ywsUtils.docs.get(docName);
      if (!wsDoc || !wsDoc.awareness) return [];
      const users = [];
      wsDoc.awareness.getStates().forEach((state) => {
        if (state.user && state.user.id && state.user.name) {
          users.push({ id: state.user.id, name: state.user.name, color: state.user.color || '#888' });
        }
      });
      return users;
    } catch {
      return [];
    }
  }

  // Deferred room serializer — the CJS require is synchronous but the heavy
  // ESM modules (sec-parser, sec-serializer) inside it are loaded via dynamic
  // import() on first use, not at require-time.
  let _serializeRoom = null;
  async function getSerializeRoom() {
    if (!_serializeRoom) {
      const mod = require('./room-serializer.cjs');
      _serializeRoom = mod.serializeRoom;
    }
    return _serializeRoom;
  }

  /** Flush a single room: .ydoc + .SEC + .comments.json via storage backend. */
  async function flushRoom(docName) {
    const timer = writeTimers.get(docName);
    if (timer) {
      clearTimeout(timer);
      writeTimers.delete(docName);
    }
    const ydoc = boundDocs.get(docName);
    if (!ydoc) return;
    const health = getHealth(docName);
    try {
      // Quick size check before expensive serialization
      const snapshot = Y.encodeStateAsUpdate(ydoc);
      if (snapshot.byteLength > MAX_DOC_BYTES) {
        log.warn('flush.refused', {
          roomId: docName,
          bytes: snapshot.byteLength,
          cap: MAX_DOC_BYTES,
          lastSuccess: health.lastPersistSuccess ? new Date(health.lastPersistSuccess).toISOString() : 'never',
        });
        return;
      }

      const serializeRoom = await getSerializeRoom();
      const artifacts = await serializeRoom(ydoc);
      const { tenant, roomId } = splitCompositeDocName(docName);
      await storage.writeRoom(tenant, roomId, artifacts);

      health.persistFailures = 0;
      health.lastPersistSuccess = Date.now();
    } catch (err) {
      health.persistFailures = (health.persistFailures || 0) + 1;
      const staleFor = health.lastPersistSuccess
        ? `${Math.round((Date.now() - health.lastPersistSuccess) / 1000)}s`
        : 'never succeeded';
      log.warn('persist.failed', { roomId: docName, failures: health.persistFailures, stale: staleFor, err: err.message });
      if (health.persistFailures >= 3) {
        log.error('persist.alert', { roomId: docName, failures: health.persistFailures });
      }
    }
  }

  // setPersistence is global state in y-websocket — only one persistence
  // adapter can be active at a time. Tests that spin up multiple
  // createCollabServer instances must not run concurrently with this guard
  // in place; the test harness serializes them. (We could namespace per
  // server instance via a custom getYDoc, but that would mean copying more
  // of y-websocket's internals than is healthy.)
  if (!useHocuspocus) setPersistence({
    bindState: (docName, ydoc) => {
      boundDocs.set(docName, ydoc);

      // Race fix (issue #17): expose a per-doc promise that resolves once
      // the persisted state is applied. The WS connection handler awaits
      // this before calling setupWSConnection, so the initial sync step 1
      // carries the loaded state vector — the client can't observe an
      // empty doc and re-seed.
      const loadPromise = (async () => {
        try {
          const { tenant: ldTenant, roomId: ldRoomId } = splitCompositeDocName(docName);
          const roomData = await storage.readRoom(ldTenant, ldRoomId);
          if (!roomData || !roomData.ydocBytes) {
            log.info('room.new', { roomId: docName });
            return;
          }
          const bytes = roomData.ydocBytes;
          if (bytes.length > MAX_DOC_BYTES) {
            await storage.quarantineRoom(ldTenant, ldRoomId, 'oversize');
            log.warn('room.quarantined', { roomId: docName, bytes: bytes.length, reason: 'oversize' });
            log.info('room.new', { roomId: docName });
            return;
          }
          // N1 — Decode into a scratch Y.Doc first so a throw halfway
          // through cannot leave the real `ydoc` in a partially-mutated
          // state that the next joining client would see as garbage.
          let restored = false;
          const scratch = new Y.Doc();
          try {
            Y.applyUpdate(scratch, new Uint8Array(bytes));
            restored = true;
          } catch (err) {
            await storage.quarantineRoom(ldTenant, ldRoomId, 'corrupt');
            log.warn('room.quarantined', { roomId: docName, reason: 'corrupt', err: err.message });
          }
          if (restored) {
            Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(scratch));
            log.info('room.restored', { roomId: docName, bytes: bytes.length });
          } else {
            log.info('room.new', { roomId: docName });
          }
          scratch.destroy();
        } catch (err) {
          log.warn('room.read-failed', { roomId: docName, err: err.message });
        }
      })();
      docLoadPromises.set(docName, loadPromise);

      ydoc.on('update', () => {
        const prev = writeTimers.get(docName);
        if (prev) clearTimeout(prev);
        const t = setTimeout(() => flushRoom(docName).catch(err => {
          log.error('flush.uncaught', { roomId: docName, err: err.message });
        }), DEBOUNCE_MS);
        // unref so a pending debounce doesn't block process exit (matters
        // most for tests; production shutdown explicitly flushAllRooms()).
        if (typeof t.unref === 'function') t.unref();
        writeTimers.set(docName, t);
      });
    },
    writeState: async () => {
      // Updates flushed eagerly by the listener above; shutdown path flushes
      // via flushAllRooms(). No per-doc writeState work needed.
    },
  });

  // ── HTTP + WebSocket on a single port ────────────────────────────────────
  // When deployed to Render (or any platform that exposes one port), WS and
  // HTTP must share a single listener.
  const httpServer = http.createServer(
    createHttpHandler({
      storage,
      boundDocs,
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

  // Migration scaffolding (#128): Phase 1 stands up a minimal Hocuspocus
  // relay behind the useHocuspocus flag. No auth, no persistence — just
  // enough for Gate A1 to boot a two-provider loopback. The y-websocket
  // upgrade handler below is guarded off when this path is active so only
  // one listener handles the upgrade.
  function buildHocuspocus() {
    const onAuthenticate = buildOnAuthenticate({ authProvider, storage });
    const database = new SecWriterDatabase({ storage, roomHealth, maxDocBytes: MAX_DOC_BYTES, log });
    const hocuspocus = new Hocuspocus({
      name: 'secwriter',
      quiet: true,
      async onAuthenticate(data) {
        try {
          return await onAuthenticate(data);
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
      // Flush cadence is a DIFFERENT mechanism (§2): debounce replaces the
      // hand-rolled 500ms ydoc.on('update') timer; maxDebounce adds a starvation
      // ceiling the old timer lacked.
      // CAUTION: the Hocuspocus DEFAULT debounce is 2000ms, NOT 500. We set 500 to
      // match the old timer, but store() runs the FULL serializeRoom over every
      // block + an S3/Azure write — at 500ms that can fire up to twice a second per
      // active room. Measure serialize+write cost in Phase 5.2 and RAISE this if a
      // realistic room saturates I/O; do not keep 500 by inertia.
      debounce: DEBOUNCE_MS,
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
  if (useHocuspocus) {
    const built = buildHocuspocus();
    hocuspocusInstance = built.hocuspocus;
    hocuspocusDatabase = built.database;
  }

  // Issue #17: use noServer + manual upgrade so the WebSocket handshake
  // itself is gated on bindState completion. Without this, y-websocket's
  // bindState runs async-and-not-awaited; setupWSConnection sends sync
  // step 1 with an empty state vector while persisted state is still
  // loading, the client interprets the empty SV as "fresh room", runs
  // its initial-blocks seed, and the persisted state then merges on top.
  // CRDT union of yOrder doubles the document each reload (~+426 in
  // production R2 conditions).
  //
  // Earlier attempts (`conn.pause()`, message-buffering with replay) were
  // racy on fast runners — by the time the connection event fires,
  // sync step 1 may already be parsed and dispatched. Blocking the
  // upgrade is the only place we can guarantee the load completes
  // *before* any WS frame can be received.
  const wss = new WebSocketServer({ noServer: true });

  if (!useHocuspocus) httpServer.on('upgrade', async (req, socket, head) => {
    const ip = socket.remoteAddress || 'unknown';
    const wsCheck = rateLimiter.checkLimit(ip, 'ws', wsRatePerMin);
    if (!wsCheck.allowed) {
      log.warn('ws.rate-limited', { ip, retryAfter: wsCheck.retryAfter });
      socket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n');
      socket.destroy();
      return;
    }

    // Strip the `/ws` path prefix that VITE_COLLAB_WS_URL adds in
    // production deploys, so the docName matches what the HTTP API uses
    // for the same room. Without this strip, a `/ws/<room>` URL produces
    // docName `"ws/<room>"` which sanitizes to a parallel storage key
    // (`ws_<room>.ydoc`) — see issue #17.
    const bareRoomId = extractDocName(req.url);

    const tokenMatch = (req.url || '').match(/[?&]token=([^&]*)/);
    let token = null;
    if (tokenMatch) {
      try {
        token = decodeURIComponent(tokenMatch[1]);
      } catch {
        // Malformed percent-encoding (e.g. `?token=%`) throws URIError.
        // This listener is async, so an uncaught throw here is an
        // unhandledRejection — Node's default policy kills the process: a
        // one-request unauthenticated DoS. Reject the handshake instead.
        socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
        socket.destroy();
        return;
      }
    }

    let user = null;
    if (authProvider.requiresAuth) {
      if (!token) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return; }
      user = await authProvider.validateToken(token);
      if (!user) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return; }
    } else if (token) {
      user = await authProvider.validateToken(token);
    }

    // Authorize from the cheap ACL sidecar BEFORE any doc load — an
    // unauthorized caller never triggers getYDoc/preload, sidestepping the
    // eviction-guard await windows (ADR-0014 pattern #2). Unconditional: never
    // skipped because the doc is already resident (live-session revocation).
    let dec;
    try {
      dec = await authorize({ authProvider, storage, user, roomId: bareRoomId, action: ACTION.READ });
    } catch (err) {
      // A storage I/O fault inside readAcl (S3/Azure network blip) throws out
      // of authorize. Fail CLOSED + close the socket — without this catch the
      // throw is an unhandledRejection AND the half-open socket hangs (no
      // response was written) until the OS connection timeout. Mirrors the
      // per-authorize try/catch the HTTP routes already use.
      log.error('ws.authorize-failed', { roomId: bareRoomId, err: err && err.message });
      socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n');
      socket.destroy();
      return;
    }
    if (!dec.ok) {
      const line = { 401: '401 Unauthorized', 403: '403 Forbidden', 404: '404 Not Found' }[dec.status] || '403 Forbidden';
      socket.write(`HTTP/1.1 ${line}\r\n\r\n`);
      socket.destroy();
      return;
    }

    // Composite docName keys ALL in-memory maps + the migration coordinator.
    const tenant = authProvider.requiresAuth ? sanitize(user.tenant) : PUBLIC_TENANT;
    const docName = buildCompositeDocName(tenant, bareRoomId);

    // Trigger doc creation + bindState (idempotent on repeat calls), then
    // await the load promise BEFORE completing the WS handshake. The
    // handshake response isn't sent until wss.handleUpgrade runs below, so
    // the client's WS doesn't open until then — its sync step 1 can't be
    // sent until the doc is already loaded.
    const doc = getYDoc(docName, true);
    const loadPromise = docLoadPromises.get(docName);
    if (loadPromise) {
      try { await loadPromise; }
      catch (err) { log.warn('preload-failed', { docName, err: err && err.message }); }
    }

    // Socket may have been destroyed during the await (client gave up,
    // network blip). Bail out before handleUpgrade tries to write to it.
    if (socket.destroyed) return;

    // Stale-close eviction guard (issue #17 redux).
    //
    // y-websocket's closeConn (bin/utils.js:208) does `docs.delete(doc.name)`
    // keyed by name, NOT by instance, when a connection's last conn drops.
    // If a previous WS connection for this same room is still in TCP-close
    // teardown when we register OUR new doc, that stale closeConn fires
    // during our `await loadPromise`, removes the entry from the global map,
    // and setupWSConnection's internal getYDoc below then creates a FRESH
    // doc bypassing our preload — sync step 1 fires with empty state, the
    // client seeds, persisted state CRDT-unions on top, yOrder doubles.
    // Re-install our preloaded doc into the map so setupWSConnection finds
    // it.
    //
    // No further await between this guard and setupWSConnection, so the
    // event loop cannot interleave another stale closeConn before
    // setupWSConnection adds a real conn that keeps doc.conns.size > 0.
    if (ywsDocs.get(docName) !== doc) {
      ywsDocs.set(docName, doc);
    }

    // Sub-PR 1d migration broker (#47, ADR-0006). After preload + eviction
    // guard, run the v1 → v2 substrate migration before the WebSocket
    // handshake completes. The coordinator awaits storage.backupRoom
    // (Q23/B2, a non-destructive snapshot — the active ACL and `.ydoc`
    // stay in place) before mutating the doc; per-room async lock (Q22/B1)
    // collapses concurrent v2 clients on a fresh v1 room onto a single
    // migration promise. needsMigration short-circuits on already-v2 rooms
    // and on rooms that already failed migration once (migrationPartial).
    if (migrationCoordinator) {
      try {
        await migrationCoordinator.ensureMigrated(docName, doc);
      } catch (err) {
        // ensureMigrated catches its own per-step errors and resolves
        // either with skipped:true or with a per-block partial. A throw
        // here is unexpected — log and continue, the room stays v1 / the
        // client will surface the migration-partial banner via 1b.1.
        log.warn('migrate.coordinator-failed', { docName, err: err && err.message });
      }

      if (socket.destroyed) return;

      // Re-install the eviction guard a second time: the migration await
      // is another window where a stale closeConn could evict our doc
      // (CLAUDE.md "Two non-obvious patterns" #2). The migration ran
      // against THIS doc instance, so any race-replacement would lose the
      // migration's effects. As before, no further await between this
      // re-install and setupWSConnection.
      if (ywsDocs.get(docName) !== doc) {
        ywsDocs.set(docName, doc);
      }
    }

    wss.handleUpgrade(req, socket, head, (conn) => {
      if (user) conn.user = user;
      setupWSConnection(conn, req, { docName, gc: true });
    });
  });

  wss.on('error', (err) => {
    log.error('server.error', { err: err.message });
  });

  async function flushAllRooms() {
    for (const docName of boundDocs.keys()) await flushRoom(docName);
  }

  /**
   * Test-friendly cleanup: clear any pending debounced write timers, drop
   * tracked Y.Docs, and close all open WebSocket connections so
   * httpServer.close() can complete. Production shutdown should call
   * flushAllRooms() first to persist any pending edits.
   */
  function cleanup() {
    for (const t of writeTimers.values()) clearTimeout(t);
    writeTimers.clear();
    for (const conn of wss.clients) {
      try { conn.terminate(); } catch { /* ignore */ }
    }
    boundDocs.clear();
    docLoadPromises.clear();
  }

  return {
    httpServer,
    wss,
    hocuspocus: hocuspocusInstance,
    database: hocuspocusDatabase,
    boundDocs,
    docLoadPromises,
    roomHealth,
    flushRoom,
    flushAllRooms,
    cleanup,
    storage,
  };
}

// ── CLI entry-point ──────────────────────────────────────────────────────
// Auto-listens with env-driven config when invoked directly. Tests
// require() this module to call createCollabServer / extractDocName
// without binding any port.
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
        if (server.boundDocs.has(composite)) continue;
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
      rooms: server.hocuspocus ? server.hocuspocus.getDocumentsCount() : server.boundDocs.size,
    });
    if (server.hocuspocus) {
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
      if (server.database) await server.database.drain();
    } else {
      await server.flushAllRooms();
    }
    try { server.wss.close(); } catch { /* ignore */ }
    try { server.httpServer.close(); } catch { /* ignore */ }
    setTimeout(() => process.exit(0), 50);
  }
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  return server;
}

module.exports = { createCollabServer, extractDocName, startFromEnv, MAX_DOC_BYTES };

if (require.main === module) {
  startFromEnv();
}
