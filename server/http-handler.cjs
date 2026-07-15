/**
 * HTTP request handler for collab-server download/upload endpoints.
 *
 * Extracted as a factory so the same routing logic can be exercised by both
 * the real collab-server and the test suite.
 *
 * Usage:
 *   const handler = createHttpHandler({ storage, boundDocs, flushRoom, maxDocBytes });
 *   http.createServer(handler);
 */

// CJS seedRoomFromBlocks avoids the Yjs dual-package hazard — ESM collab.js
// creates Y.Map/Y.Text from the ESM Yjs copy, which fails instanceof checks
// against CJS Y.Docs. room-serializer uses the same CJS Yjs as the server.
const { seedRoomFromBlocks } = require('./room-serializer.cjs');
const { migrateRoom } = require('./migrate-pm-substrate.cjs');
const { log } = require('./logger.cjs');
const { sanitize, PUBLIC_TENANT, buildCompositeDocName } = require('./storage-shared.cjs');
const { authorize, checkPrincipal, aclAllowsRead, roleOf, ACTION, GRANTABLE_ROLES,
  resolveRole, pendingInviteTtlMs, normalizeEmail, isValidEmailShape, isPendingExpired,
  exceedsAclByteCap, MAX_PENDING_INVITES } = require('./auth/authorize.cjs');

/**
 * @param {Object} deps
 * @param {import('./storage-local.cjs').LocalStorageBackend} deps.storage
 * @param {Map<string, import('yjs').Doc>} deps.boundDocs
 * @param {(roomId: string) => Promise<void>} deps.flushRoom
 * @param {(tenant: string, roomId: string) => Promise<void>} [deps.deleteRoomTransactionally]
 *   the single room-deletion seam (architecture-review candidate #4). Owns the
 *   whole tombstone -> storage.deleteRoom -> (rollback-on-fail | evict-on-ok)
 *   ordering so the route never re-assembles it: a store racing deleteRoom can't
 *   resurrect the room and a FAILED deleteRoom can't destroy the still-live doc
 *   (ADR-0017 "Live-session revocation"). Rethrows a deleteRoom failure so the
 *   route still surfaces 500. When absent (bare createHttpHandler test harnesses
 *   with no collab-server wiring), the route falls back to storage.deleteRoom
 *   alone — same behavior those harnesses relied on before the seam existed.
 * @param {number} deps.maxDocBytes
 */
function createHttpHandler({ storage, boundDocs, flushRoom, deleteRoomTransactionally, revokeLiveSessions, withAclLock, maxDocBytes, authProvider, allowedOrigin = '*', getActiveUsers, rateLimiter, roomHealth }) {
  // Parse rate limit config once at handler creation, not per-request
  const HTTP_READ_RATE = Number(process.env.SIM_RATE_LIMIT_HTTP_READ_PER_MIN || 60);
  const HTTP_WRITE_RATE = Number(process.env.SIM_RATE_LIMIT_HTTP_WRITE_PER_MIN || 20);

  // Route both DELETE branches through the one room-deletion seam. The seam
  // (collab-server's deleteRoomTransactionally) owns the tombstone -> delete ->
  // rollback|evict ordering; the route no longer knows the protocol. Bare test
  // harnesses that construct createHttpHandler without collab-server wiring get
  // the pre-seam behavior (storage.deleteRoom alone). A thrown deleteRoom
  // failure propagates to the route's outer catch -> 500 either way.
  async function performRoomDeletion(tenant, roomId) {
    if (typeof deleteRoomTransactionally === 'function') {
      await deleteRoomTransactionally(tenant, roomId);
    } else {
      await storage.deleteRoom(tenant, roomId);
    }
  }

  // #267: the share route serializes its ACL RMW through the shared mutex when
  // wired (collab-server threads it in); bare test harnesses without it fall
  // back to running fn directly (no concurrent promote to race there).
  const withAclLockOrDirect = typeof withAclLock === 'function'
    ? withAclLock
    : (_key, fn) => fn();

  // #215 — room lock enforcement. The `locked` flag (yMeta.locked + lockedBy)
  // was write-only metadata: DELETE/upload/PATCH never consulted it, so a locked
  // room could still be destroyed or overwritten. These helpers read the lock
  // state (live doc preferred, else persisted bytes) and decide whether the
  // caller may mutate. Amends ADR-0014.
  function readRoomLock(composite, ydocBytes) {
    const live = boundDocs && boundDocs.get(composite);
    if (live) {
      try {
        const m = live.getMap('meta');
        return { locked: !!m.get('locked'), lockedBy: m.get('lockedBy') || null };
      } catch { /* fall through to persisted bytes */ }
    }
    if (ydocBytes) {
      const Y = require('yjs');
      const tmp = new Y.Doc();
      try {
        Y.applyUpdate(tmp, ydocBytes);
        const m = tmp.getMap('meta');
        return { locked: !!m.get('locked'), lockedBy: m.get('lockedBy') || null };
      } catch {
        // Non-Yjs bytes (or decode failure) — treat as unlocked rather than brick.
        return { locked: false, lockedBy: null };
      } finally {
        tmp.destroy();
      }
    }
    return { locked: false, lockedBy: null };
  }

  // Actor identity: authenticated subject when auth is on, else the client-supplied
  // X-Actor-Id header / ?actorId= query (the same identity.id the client writes to
  // lockedBy when locking). Under auth=none this is a cooperative lock — the whole
  // data plane is already unauthenticated (#215 acknowledges this).
  function getActorId(req, url) {
    if (req.user && req.user.id) return String(req.user.id);
    const q = url.searchParams.get('actorId');
    if (q) return q;
    const h = req.headers['x-actor-id'];
    if (h) return String(h);
    return null;
  }

  // Tenant for storage keys: the validated token's tenant under auth, else the
  // reserved _public sentinel under auth=none. NEVER derived from body/header.
  // Only valid AFTER checkPrincipal has passed (req.user.tenant present + non-sentinel).
  function resolveTenant(req) {
    if (authProvider?.requiresAuth) return sanitize(req.user.tenant);
    return PUBLIC_TENANT;
  }

  // Map an authorize()/checkPrincipal() denial to an HTTP response. Returns
  // true if the request was denied (caller should `return`).
  function denied(res, decision) {
    if (decision.ok) return false;
    const map = { 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not found' };
    res.writeHead(decision.status, { 'Content-Type': 'text/plain' });
    res.end(map[decision.status] || 'Error');
    return true;
  }

  // Lock actor: the authenticated subject under auth (NEVER the body/header
  // fallback, which a different user could spoof); the cooperative actorId
  // under auth=none.
  function lockActor(req, url) {
    return authProvider?.requiresAuth ? String(req.user.id) : getActorId(req, url);
  }

  // Blocked when the room is locked and the actor is not the (non-empty) lock owner.
  // A locked room with no recorded owner blocks everyone — matches the issue's
  // verification (PATCH {locked:true} with no lockedBy must still return 423).
  function isLockBlocked(lock, actor) {
    return lock.locked && !(lock.lockedBy && actor && actor === lock.lockedBy);
  }

  function sendLocked(res, lockedBy) {
    res.writeHead(423, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Room is locked', lockedBy: lockedBy || null }));
  }

  return async (req, res) => {
    // CORS — default wildcard for dev; restrict via SIM_COLLAB_ORIGIN in production
    res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Actor-Id');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    if (rateLimiter) {
      const ip = req.socket?.remoteAddress || 'unknown';
      const isWrite = req.method === 'POST' || req.method === 'PATCH' || req.method === 'DELETE';
      const bucket = isWrite ? 'http-write' : 'http-read';
      const limit = isWrite ? HTTP_WRITE_RATE : HTTP_READ_RATE;
      const check = rateLimiter.checkLimit(ip, bucket, limit);
      if (!check.allowed) {
        res.writeHead(429, {
          'Content-Type': 'application/json',
          'Retry-After': String(check.retryAfter),
        });
        res.end(JSON.stringify({ error: 'Too Many Requests', retryAfter: check.retryAfter }));
        return;
      }
    }

    const url = new URL(req.url, `http://${req.headers.host}`);

    // GET /health — unauthenticated health probe
    if (url.pathname === '/health' && req.method === 'GET') {
      const unhealthyRooms = [];
      let unhealthyCount = 0;
      if (roomHealth) {
        for (const [name, h] of roomHealth) {
          if (h.persistFailures >= 3) { unhealthyCount++; unhealthyRooms.push(name); }
        }
      }
      const status = unhealthyCount === 0 ? 'ok' : 'degraded';

      let activeConnections = 0;
      try {
        if (getActiveUsers) {
          for (const id of boundDocs.keys()) activeConnections += getActiveUsers(id).length;
        }
      } catch { /* ignore */ }

      const body = JSON.stringify({
        status,
        uptime: process.uptime(),
        rooms: { active: boundDocs ? boundDocs.size : 0, connections: activeConnections },
        // Redact room names under auth — they are cross-tenant. Counts only.
        ...(authProvider?.requiresAuth ? { unhealthyCount } : { unhealthyRooms }),
      });
      res.writeHead(status === 'ok' ? 200 : 503, { 'Content-Type': 'application/json' });
      res.end(body);
      return;
    }

    // Auth check — enforce when provider requires auth (e.g., auth-jwt)
    if (authProvider?.requiresAuth) {
      const token = authProvider.extractToken(req);
      if (!token) {
        res.writeHead(401, { 'Content-Type': 'text/plain' });
        res.end('Unauthorized');
        return;
      }
      const user = await authProvider.validateToken(token);
      if (!user) {
        res.writeHead(401, { 'Content-Type': 'text/plain' });
        res.end('Unauthorized');
        return;
      }
      req.user = user;
    } else if (authProvider) {
      // Optional auth: validate if token present, but don't require it
      const token = authProvider.extractToken(req);
      if (token) {
        const user = await authProvider.validateToken(token);
        if (user) req.user = user;
      }
    }

    // POST /rooms/:roomId/upload
    const uploadMatch = url.pathname.match(/^\/rooms\/([^/]+)\/upload$/);
    if (uploadMatch && req.method === 'POST') {
      const roomId = uploadMatch[1];
      const chunks = [];
      let totalSize = 0;
      let aborted = false;
      req.on('data', (chunk) => {
        totalSize += chunk.length;
        if (totalSize > maxDocBytes) {
          aborted = true;
          res.writeHead(413, { 'Content-Type': 'text/plain' });
          res.end(`File exceeds ${maxDocBytes} byte limit`);
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', async () => {
        if (aborted) return;
        try {
          const tenant = resolveTenant(req);
          // #239: upload overwrites room content → WRITE (editor + owner). A
          // viewer is denied (was READ-gated under #211's binary model where
          // every sharee could write).
          const dec = await authorize({ authProvider, storage, user: req.user, roomId, action: ACTION.WRITE });
          if (denied(res, dec)) return;
          const composite = buildCompositeDocName(tenant, roomId);

          const body = Buffer.concat(chunks);
          // .SEC files are windows-1252. latin1 is NOT a superset: bytes 0x80–0x9F
          // are C1 controls in latin1 but printable punctuation in windows-1252
          // (0x97 em-dash, 0x93/0x94 curly quotes, 0x95 bullet, 0x80 euro). A pure-JS
          // decoder (NOT TextDecoder) avoids depending on Node's ICU build — a
          // small-ICU Node decodes 'windows-1252' like latin1 and re-encodes to '?'
          // (issue #212). decodeWindows1252 is the exact inverse of the export encoder.
          const { decodeWindows1252 } = await import('../src/lib/encoding.js');
          const secContent = decodeWindows1252(body);

          const { parseSEC } = await import('../src/lib/sec-parser.js');
          const blocks = parseSEC(secContent);
          if (!blocks || blocks.length === 0) {
            res.writeHead(400, { 'Content-Type': 'text/plain' });
            res.end('Failed to parse SEC file — no blocks extracted');
            return;
          }

          // Room must have a live Y.Doc (at least one client connected via WS).
          // Without an active doc, there's nowhere to apply the parsed blocks.
          const ydoc = boundDocs.get(composite);
          if (!ydoc) {
            res.writeHead(409, { 'Content-Type': 'text/plain' });
            res.end(`Room "${roomId}" has no active session — join via WebSocket first`);
            return;
          }

          // #215 — refuse to overwrite a locked room unless the caller owns the lock.
          const lock = readRoomLock(composite, null);
          if (isLockBlocked(lock, lockActor(req, url))) {
            sendLocked(res, lock.lockedBy);
            return;
          }

          seedRoomFromBlocks(ydoc, blocks);
          // #248 — seedRoomFromBlocks writes legacy Y.Text html slots and clears
          // the migration sentinels, relying on the v1→v2 broker re-running on the
          // "next WS upgrade". Under Hocuspocus the broker only runs once per room
          // load (onLoadDocument, warm doc), so an in-memory upload never re-fires
          // it — the seeded Y.Text slots stay unbound by PmEditableBlock's
          // ySyncPlugin (which binds Y.XmlFragment) and live edits don't sync to
          // peers. Call the pure broker directly here (NOT migrationCoordinator,
          // whose per-docName cache short-circuits as alreadyV2 after the empty
          // first load) to promote Y.Text → Y.XmlFragment on the live doc. The
          // migrate-v2 ops broadcast to connected clients, which re-bind via the
          // already-handled broker-swap path.
          migrateRoom(ydoc, { log });
          // Await persist so the 200 only follows a durable write. flushRoom
          // routes through SecWriterDatabase.store, which swallows + counts its
          // own storage failures and resolves to false rather than throwing —
          // so check the result and return a 5xx, else the client trusts a false
          // 200 for a write that never landed (#249 review).
          const persisted = await flushRoom(composite);
          if (!persisted) {
            res.writeHead(500, { 'Content-Type': 'text/plain' });
            res.end('Upload parsed but failed to persist — please retry');
            return;
          }

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, blocks: blocks.length }));
        } catch (err) {
          log.error('upload.failed', { roomId, err: err.message });
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end(`Upload failed: ${err.message}`);
        }
      });
      return;
    }

    // GET /rooms/:roomId/sec  or  GET /rooms/:roomId/comments
    const dlMatch = url.pathname.match(/^\/rooms\/([^/]+)\/(sec|comments)$/);
    if (dlMatch && req.method === 'GET') {
      const [, roomId, artifact] = dlMatch;
      try {
        const tenant = resolveTenant(req);
        const dec = await authorize({ authProvider, storage, user: req.user, roomId, action: ACTION.READ });
        if (denied(res, dec)) return;
        const data = await storage.readRoom(tenant, roomId);
        if (!data) {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end(`Room "${roomId}" not found`);
          return;
        }

        if (artifact === 'sec') {
          if (!data.secBytes) {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('SEC file not yet generated for this room');
            return;
          }
          // Try to get a meaningful filename from yMeta
          let fileName = `${roomId}.SEC`;
          const ydoc = boundDocs.get(buildCompositeDocName(tenant, roomId));
          if (ydoc) {
            try {
              const yMeta = ydoc.getMap('meta');
              const sn = yMeta.get('sectionNumber');
              if (sn) fileName = `${sn.replace(/\s+/g, '_')}.SEC`;
            } catch { /* use default */ }
          }
          res.writeHead(200, {
            'Content-Type': 'application/xml; charset=windows-1252',
            'Content-Disposition': `attachment; filename="${fileName}"`,
          });
          res.end(Buffer.from(data.secBytes));
        } else {
          // comments
          if (!data.commentsJson) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ version: 1, comments: [] }));
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(data.commentsJson);
        }
      } catch (err) {
        log.error('download.failed', { roomId, artifact, err: err.message });
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end(`Download failed: ${err.message}`);
      }
      return;
    }

    // GET /rooms/:roomId/acl — owner-only; the collaborator+role list backing
    // the client share dialog (#239). Normalizes both sidecar shapes to
    // { ownerId, roles: { "<sub>": "viewer"|"editor" } } so the UI never sees
    // the legacy `sharedWith` form.
    const aclMatch = url.pathname.match(/^\/rooms\/([^/]+)\/acl$/);
    if (aclMatch && req.method === 'GET') {
      const roomId = aclMatch[1];
      try {
        const tenant = resolveTenant(req);
        const dec = await authorize({ authProvider, storage, user: req.user, roomId, action: ACTION.SHARE });
        if (denied(res, dec)) return;
        const acl = await storage.readAcl(tenant, roomId);
        if (!acl) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `Room "${roomId}" not found` }));
          return;
        }
        const roles = {};
        if (acl.roles && typeof acl.roles === 'object') {
          for (const [uid, r] of Object.entries(acl.roles)) {
            if (r === 'viewer' || r === 'editor') roles[uid] = r;
          }
        } else if (Array.isArray(acl.sharedWith)) {
          for (const uid of acl.sharedWith) roles[uid] = 'editor';
        }
        // #267: surface pending invites + cached display names. STRICTLY
        // read-only — normalize for the response, never persist from this path
        // (a write here would be a 4th unserialized RMW site that could lose a
        // share/promote update). See the full-object-RMW invariant in the spec.
        const pending = (acl.pending && typeof acl.pending === 'object') ? acl.pending : {};
        const display = (acl.display && typeof acl.display === 'object') ? acl.display : {};
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ownerId: acl.ownerId, roles, pending, display }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end(`ACL read failed: ${err.message}`);
      }
      return;
    }

    // POST /rooms — create a new room
    if (url.pathname === '/rooms' && req.method === 'POST') {
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', async () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
          const rawId = body && body.id;
          if (!rawId || typeof rawId !== 'string') {
            res.writeHead(400, { 'Content-Type': 'text/plain' });
            res.end('Missing or invalid room id');
            return;
          }
          // Sanitize: [a-zA-Z0-9_-], max 64 chars
          const id = String(rawId).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
          if (!id) {
            res.writeHead(400, { 'Content-Type': 'text/plain' });
            res.end('Invalid room id after sanitization');
            return;
          }
          const pre = checkPrincipal(authProvider, req.user);
          if (denied(res, pre)) return;
          const tenant = resolveTenant(req);
          // Fast-path existence check. NOT the race guard — that's the
          // atomic ACL claim below. This also catches a .ydoc with no ACL
          // (legacy/quarantine-flushed rooms), which the claim alone would
          // let a creator silently adopt.
          const existing = await storage.readRoom(tenant, id);
          const existingAcl = authProvider?.requiresAuth ? await storage.readAcl(tenant, id) : null;
          if (existing || existingAcl) {
            res.writeHead(409, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: `Room "${id}" already exists` }));
            return;
          }
          // Create empty Y.Doc with optional displayName in yMeta
          const Y = require('yjs');
          const ydoc = new Y.Doc();
          if (body.displayName) {
            const yMeta = ydoc.getMap('meta');
            ydoc.transact(() => {
              yMeta.set('sectionTitle', String(body.displayName));
            });
          }
          const ydocBytes = Buffer.from(Y.encodeStateAsUpdate(ydoc));
          ydoc.destroy();

          // Crash-order (ADR-0005 amendment): ACL sidecar FIRST, then .ydoc.
          // A crash between the two leaves the room absent (no .ydoc → 404),
          // never an ownerless/hijackable room.
          //
          // The ACL write is an ATOMIC claim (conditional put): two
          // concurrent creates of the same id both pass the existence check
          // above, but exactly one wins the claim — the loser 409s instead
          // of overwriting the winner's ACL (silent ownership transfer).
          // Under auth=none there is no ACL to claim; the residual race
          // (last writeRoom wins) is benign — both writers produce an
          // identical fresh empty doc in the shared _public namespace.
          if (authProvider?.requiresAuth) {
            // #239: new rooms use the graded `roles` shape (empty = owner-only
            // until shared). roleOf() still read-compat's #211's `sharedWith`
            // shape for rooms created before this change.
            const claimed = await storage.writeAclIfAbsent(tenant, id, { ownerId: req.user.id, roles: {} });
            if (!claimed) {
              res.writeHead(409, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: `Room "${id}" already exists` }));
              return;
            }
          }
          await storage.writeRoom(tenant, id, { ydocBytes, secBytes: null, commentsJson: null });
          res.writeHead(201, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ id, ok: true }));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end(`Create room failed: ${err.message}`);
        }
      });
      return;
    }

    // DELETE /rooms/:roomId — delete a room
    const deleteMatch = url.pathname.match(/^\/rooms\/([^/]+)$/);
    if (deleteMatch && req.method === 'DELETE') {
      const roomId = deleteMatch[1];
      try {
        const tenant = resolveTenant(req);
        const dec = await authorize({ authProvider, storage, user: req.user, roomId, action: ACTION.DELETE });
        if (denied(res, dec)) return;
        const composite = buildCompositeDocName(tenant, roomId);
        const existing = await storage.readRoom(tenant, roomId);
        if (!existing) {
          // Orphan-ACL recovery: a crash during create can leave an ACL sidecar
          // with no .ydoc. authorize(DELETE) above already confirmed the caller
          // owns it, so clear the orphan (and its migration-cache entry) to make
          // the id reclaimable rather than permanently bricked. Still 404 — the
          // room proper never finished creating.
          if (authProvider?.requiresAuth && (await storage.readAcl(tenant, roomId))) {
            await performRoomDeletion(tenant, roomId);
          }
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `Room "${roomId}" not found` }));
          return;
        }
        // #215 — refuse to delete a locked room unless the caller owns the lock.
        const lock = readRoomLock(composite, existing.ydocBytes);
        if (isLockBlocked(lock, lockActor(req, url))) {
          sendLocked(res, lock.lockedBy);
          return;
        }
        // Room deletion is a transaction, not a sequence the route assembles:
        // performRoomDeletion -> deleteRoomTransactionally owns tombstone ->
        // storage.deleteRoom -> (rollback-on-fail | evict+kick-on-ok). That
        // ordering guards two correctness invariants — a store racing deleteRoom
        // must not resurrect the room (#268/ADR-0017), and a FAILED deleteRoom
        // must not destroy the still-live doc + its unflushed edits (review
        // finding #1). A deleteRoom throw rolls the tombstone back and rethrows,
        // surfacing 500 below with the room fully live. See the seam's doc block
        // in collab-server.cjs for the per-step detail.
        await performRoomDeletion(tenant, roomId);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end(`Delete room failed: ${err.message}`);
      }
      return;
    }

    // PATCH /rooms/:roomId/share — owner-only. Two variants:
    //   { userId, action:'add'|'remove', role? } — raw-sub grant (unchanged behavior)
    //   { email,  action:'add'|'remove', role? } — #267 pending-by-email invite
    // Every write is a FULL-OBJECT read-modify-write (writeAcl overwrites the
    // whole blob) under the shared ACL mutex, preserving roles + pending + display.
    const shareMatch = url.pathname.match(/^\/rooms\/([^/]+)\/share$/);
    if (shareMatch && req.method === 'PATCH') {
      const roomId = shareMatch[1];
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', async () => {
        try {
          const tenant = resolveTenant(req);
          const dec = await authorize({ authProvider, storage, user: req.user, roomId, action: ACTION.SHARE });
          if (denied(res, dec)) return;

          const body = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
          const action = body && body.action;
          const role = body && body.role;
          const rawEmail = body && body.email;
          const userId = body && body.userId;
          const isEmail = typeof rawEmail === 'string' && rawEmail.length > 0;

          if (action !== 'add' && action !== 'remove') {
            res.writeHead(400, { 'Content-Type': 'text/plain' });
            res.end('action must be "add" or "remove"');
            return;
          }
          if (!isEmail && (typeof userId !== 'string' || !userId)) {
            res.writeHead(400, { 'Content-Type': 'text/plain' });
            res.end('Body must include userId or email');
            return;
          }
          if (action === 'add' && role !== undefined && !GRANTABLE_ROLES.includes(role)) {
            res.writeHead(400, { 'Content-Type': 'text/plain' });
            res.end(`role must be one of ${GRANTABLE_ROLES.join(', ')}`);
            return;
          }
          const email = isEmail ? normalizeEmail(rawEmail) : null;
          if (isEmail && action === 'add' && !isValidEmailShape(email)) {
            res.writeHead(400, { 'Content-Type': 'text/plain' });
            res.end('Malformed email');
            return;
          }

          const composite = buildCompositeDocName(tenant, roomId);
          const now = Date.now();
          const ttlMs = pendingInviteTtlMs();
          const outcome = { status: 200 };

          await withAclLockOrDirect(composite, async () => {
            const acl = await storage.readAcl(tenant, roomId);
            // authorize() confirmed acl existed; a concurrent DELETE could have
            // removed it since (TOCTOU) — fail closed with 404, not a 500 NPE.
            if (!acl) { outcome.status = 404; return; }

            // Fold current roles into the graded shape (migrate #211 sharedWith).
            const roles = {};
            if (acl.roles && typeof acl.roles === 'object') {
              for (const [uid, r] of Object.entries(acl.roles)) if (r === 'viewer' || r === 'editor') roles[uid] = r;
            } else if (Array.isArray(acl.sharedWith)) {
              for (const uid of acl.sharedWith) roles[uid] = 'editor';
            }
            const pending = { ...((acl.pending && typeof acl.pending === 'object') ? acl.pending : {}) };
            const display = { ...((acl.display && typeof acl.display === 'object') ? acl.display : {}) };

            // Prune expired pending first (reuse the exported predicate — no
            // inline re-implementation to drift), so the cap counts only LIVE invites.
            for (const [e, entry] of Object.entries(pending)) {
              if (isPendingExpired(entry, now, ttlMs)) delete pending[e];
            }

            if (isEmail) {
              if (action === 'add') {
                if (!pending[email] && Object.keys(pending).length >= MAX_PENDING_INVITES) { outcome.status = 429; return; }
                pending[email] = { role: role || 'editor', invitedBy: req.user.id, invitedAt: new Date(now).toISOString() };
              } else {
                outcome.pendingRemoved = Object.prototype.hasOwnProperty.call(pending, email);
                delete pending[email];
              }
            } else {
              outcome.prevRole = roleOf(acl, userId);
              if (action === 'add') roles[userId] = role || 'editor'; else { delete roles[userId]; delete display[userId]; }
              outcome.newRole = action === 'add' ? (role || 'editor') : null;
            }
            delete roles[acl.ownerId]; // a grant entry may never equal the owner

            const next = { ...acl, roles, pending, display };
            delete next.sharedWith; // #239 folded into `roles` above; drop the legacy key so it isn't persisted forever
            if (exceedsAclByteCap(next)) { outcome.status = 400; return; }
            await storage.writeAcl(tenant, roomId, next);
            outcome.roles = roles;
          });

          if (outcome.status === 404) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found'); return; }
          if (outcome.status === 429) { res.writeHead(429, { 'Content-Type': 'text/plain' }); res.end(`Too many pending invites (max ${MAX_PENDING_INVITES})`); return; }
          if (outcome.status === 400) { res.writeHead(400, { 'Content-Type': 'text/plain' }); res.end('ACL too large'); return; }

          // #268/#267 live-session revocation. Email remove: kick any session
          // whose token email matches (the bound sub is unknown until connect —
          // major #4). Raw-sub remove/downgrade: kick the sub (unchanged #268).
          if (revokeLiveSessions) {
            if (isEmail) {
              if (action === 'remove' && outcome.pendingRemoved) revokeLiveSessions(tenant, roomId, { emails: [email] });
            } else {
              const isRemoval = action === 'remove';
              const isDowngrade = outcome.newRole === 'viewer' && outcome.prevRole === 'editor';
              if (isRemoval || isDowngrade) revokeLiveSessions(tenant, roomId, { subjects: [userId] });
            }
          }

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, roles: outcome.roles || {} }));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end(`Share failed: ${err.message}`);
        }
      });
      return;
    }

    // PATCH /rooms/:roomId — update room settings
    const patchMatch = url.pathname.match(/^\/rooms\/([^/]+)$/);
    if (patchMatch && req.method === 'PATCH') {
      const roomId = patchMatch[1];
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', async () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
          const tenant = resolveTenant(req);
          const touchesLock = body.locked !== undefined || body.lockedBy !== undefined || body.lockedByName !== undefined;
          // #239: lock fields are owner-only (LOCK_ADMIN); other settings
          // (displayName) are a content mutation → WRITE (editor + owner, not
          // viewer). Under #211 the non-lock branch was READ-gated.
          const dec = await authorize({
            authProvider, storage, user: req.user, roomId,
            action: touchesLock ? ACTION.LOCK_ADMIN : ACTION.WRITE,
          });
          if (denied(res, dec)) return;
          const composite = buildCompositeDocName(tenant, roomId);
          const existing = await storage.readRoom(tenant, roomId);
          if (!existing) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: `Room "${roomId}" not found` }));
            return;
          }
          // #215 — a locked room's settings (including unlock) may only be changed
          // by the lock owner. Reads CURRENT state: locking an unlocked room is
          // always allowed; once locked, only lockedBy can mutate or unlock.
          const lock = readRoomLock(composite, existing.ydocBytes);
          if (isLockBlocked(lock, lockActor(req, url))) {
            sendLocked(res, lock.lockedBy);
            return;
          }
          // Load persisted Y.Doc and update yMeta fields
          const Y = require('yjs');
          const ydoc = new Y.Doc();
          Y.applyUpdate(ydoc, existing.ydocBytes);
          const yMeta = ydoc.getMap('meta');
          ydoc.transact(() => {
            if (body.displayName !== undefined) yMeta.set('sectionTitle', String(body.displayName));
            if (body.locked !== undefined) yMeta.set('locked', !!body.locked);
            if (body.lockedBy !== undefined) yMeta.set('lockedBy', String(body.lockedBy));
            if (body.lockedByName !== undefined) yMeta.set('lockedByName', String(body.lockedByName));
          });
          const ydocBytes = Buffer.from(Y.encodeStateAsUpdate(ydoc));
          ydoc.destroy();

          await storage.writeRoom(tenant, roomId, {
            ydocBytes,
            secBytes: existing.secBytes,
            commentsJson: existing.commentsJson,
            lintJson: existing.lintJson,
          });

          // Also update live doc in boundDocs if active
          const liveDoc = boundDocs.get(composite);
          if (liveDoc) {
            const liveMeta = liveDoc.getMap('meta');
            liveDoc.transact(() => {
              if (body.displayName !== undefined) liveMeta.set('sectionTitle', String(body.displayName));
              if (body.locked !== undefined) liveMeta.set('locked', !!body.locked);
              if (body.lockedBy !== undefined) liveMeta.set('lockedBy', String(body.lockedBy));
              if (body.lockedByName !== undefined) liveMeta.set('lockedByName', String(body.lockedByName));
            }, 'local-meta');
          }

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end(`Patch room failed: ${err.message}`);
        }
      });
      return;
    }

    // GET /rooms — list all rooms with metadata
    if (url.pathname === '/rooms' && req.method === 'GET') {
      try {
        const pre = checkPrincipal(authProvider, req.user);
        if (denied(res, pre)) return;
        const tenant = resolveTenant(req);
        const roomIds = await storage.listRooms(tenant);
        const Y = require('yjs');
        const rooms = [];

        for (const id of roomIds) {
          // Yield to the event loop every iteration. Y.applyUpdate below is
          // CPU-bound and synchronous, and the surrounding storage awaits may
          // resolve from OS file cache without releasing the loop. Without
          // this yield, listing N persisted rooms freezes the loop for
          // N * decode_ms — enough to starve WS handshakes and HTTP handlers
          // for other clients. See issue #100.
          await new Promise(resolve => setImmediate(resolve));

          // Private-by-default: the tenant listing alone would expose every
          // same-tenant room's title, lock state, and active-user roster to
          // non-members. Filter to ACL members (owner or sharee) off the
          // cheap sidecar; rooms with no ACL (legacy/orphan) are hidden —
          // the same semantics as the per-room routes' 404.
          // #239: capture the caller's role so the client can badge viewers
          // and gate the owner-only Share affordance without a second request.
          // Under auth=none everyone is an editor in the _public namespace.
          let callerRole = 'editor';
          let callerViaPending = false;
          if (authProvider?.requiresAuth) {
            const acl = await storage.readAcl(tenant, id);
            // #267: resolveRole (not aclAllowsRead/roleOf) so a caller's OWN
            // pending-by-email invites list too — badged viaPending. Zero extra
            // I/O (the ACL is already loaded for the member filter). Genuine
            // non-members resolve to null → still excluded (unchanged 404).
            const resolved = resolveRole(acl, req.user, Date.now(), pendingInviteTtlMs());
            if (!resolved.role) continue;
            callerRole = resolved.role;
            callerViaPending = resolved.viaPending;
          }

          const composite = buildCompositeDocName(tenant, id);
          const entry = { id, displayName: id, sectionNumber: null, sectionTitle: null, lastModified: null, activeUsers: [], locked: false, sizeBytes: 0, role: callerRole, viaPending: callerViaPending };

          // Try live doc first (has awareness for active users)
          const liveDoc = boundDocs.get(composite);
          if (liveDoc) {
            try {
              const yMeta = liveDoc.getMap('meta');
              entry.sectionNumber = yMeta.get('sectionNumber') || null;
              entry.sectionTitle = yMeta.get('sectionTitle') || null;
              entry.locked = !!yMeta.get('locked');
            } catch { /* ignore */ }
            if (typeof getActiveUsers === 'function') {
              entry.activeUsers = getActiveUsers(composite);
            }
          } else {
            // Fall back to reading persisted .ydoc to extract yMeta
            try {
              const data = await storage.readRoom(tenant, id);
              if (data && data.ydocBytes) {
                const tempDoc = new Y.Doc();
                try {
                  Y.applyUpdate(tempDoc, data.ydocBytes);
                  const yMeta = tempDoc.getMap('meta');
                  entry.sectionNumber = yMeta.get('sectionNumber') || null;
                  entry.sectionTitle = yMeta.get('sectionTitle') || null;
                  entry.locked = !!yMeta.get('locked');
                } finally {
                  tempDoc.destroy();
                }
              }
            } catch { /* ignore — metadata is best-effort */ }
          }

          // Build displayName from metadata
          if (entry.sectionNumber && entry.sectionTitle) {
            entry.displayName = `${entry.sectionNumber} ${entry.sectionTitle}`;
          } else if (entry.sectionNumber) {
            entry.displayName = entry.sectionNumber;
          }

          // Get filesystem stats
          try {
            const stat = await storage.statRoom(tenant, id);
            if (stat) {
              entry.lastModified = stat.lastModified;
              entry.sizeBytes = stat.sizeBytes;
            }
          } catch { /* ignore */ }

          rooms.push(entry);
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ rooms }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end(`List rooms failed: ${err.message}`);
      }
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  };
}

module.exports = { createHttpHandler };
