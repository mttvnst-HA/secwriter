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
const { log } = require('./logger.cjs');

/**
 * @param {Object} deps
 * @param {import('./storage-local.cjs').LocalStorageBackend} deps.storage
 * @param {Map<string, import('yjs').Doc>} deps.boundDocs
 * @param {(roomId: string) => Promise<void>} deps.flushRoom
 * @param {number} deps.maxDocBytes
 */
function createHttpHandler({ storage, boundDocs, flushRoom, maxDocBytes, authProvider, allowedOrigin = '*', getActiveUsers, rateLimiter, roomHealth, migrationCoordinator }) {
  // Parse rate limit config once at handler creation, not per-request
  const HTTP_READ_RATE = Number(process.env.SIM_RATE_LIMIT_HTTP_READ_PER_MIN || 60);
  const HTTP_WRITE_RATE = Number(process.env.SIM_RATE_LIMIT_HTTP_WRITE_PER_MIN || 20);

  return async (req, res) => {
    // CORS — default wildcard for dev; restrict via SIM_COLLAB_ORIGIN in production
    res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
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
      if (roomHealth) {
        for (const [name, h] of roomHealth) {
          if (h.persistFailures >= 3) unhealthyRooms.push(name);
        }
      }
      const status = unhealthyRooms.length === 0 ? 'ok' : 'degraded';

      let activeConnections = 0;
      try {
        // Sum awareness states across all rooms for total connected clients
        if (getActiveUsers) {
          for (const id of boundDocs.keys()) {
            activeConnections += getActiveUsers(id).length;
          }
        }
      } catch { /* ignore */ }

      const body = JSON.stringify({
        status,
        uptime: process.uptime(),
        rooms: { active: boundDocs ? boundDocs.size : 0, connections: activeConnections },
        unhealthyRooms,
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
          const ydoc = boundDocs.get(roomId);
          if (!ydoc) {
            res.writeHead(409, { 'Content-Type': 'text/plain' });
            res.end(`Room "${roomId}" has no active session — join via WebSocket first`);
            return;
          }

          seedRoomFromBlocks(ydoc, blocks);
          // Await persist so the 200 response guarantees durability.
          await flushRoom(roomId);

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
        const data = await storage.readRoom(roomId);
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
          const ydoc = boundDocs.get(roomId);
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
          // Check if room already exists
          const existing = await storage.readRoom(id);
          if (existing) {
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

          await storage.writeRoom(id, { ydocBytes, secBytes: null, commentsJson: null });
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
        const existing = await storage.readRoom(roomId);
        if (!existing) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `Room "${roomId}" not found` }));
          return;
        }
        await storage.deleteRoom(roomId);
        // Sub-PR 1d (#47, ADR-0006). The migration coordinator caches one
        // promise per docName; a successful migration leaves
        // `{ alreadyV2: true }` in the cache so concurrent broker calls
        // collapse. After a DELETE, that cache entry is stale — if an
        // operator re-creates a room with the same id (or uploads a fresh
        // v1 SEC), the next WS upgrade would short-circuit on the cached
        // result and skip both archive + migration. Drop the entry here
        // so the broker re-evaluates the new doc.
        if (migrationCoordinator && typeof migrationCoordinator.forget === 'function') {
          migrationCoordinator.forget(roomId);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end(`Delete room failed: ${err.message}`);
      }
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
          const existing = await storage.readRoom(roomId);
          if (!existing) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: `Room "${roomId}" not found` }));
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

          await storage.writeRoom(roomId, {
            ydocBytes,
            secBytes: existing.secBytes,
            commentsJson: existing.commentsJson,
            lintJson: existing.lintJson,
          });

          // Also update live doc in boundDocs if active
          const liveDoc = boundDocs.get(roomId);
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
        const roomIds = await storage.listRooms();
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

          const entry = { id, displayName: id, sectionNumber: null, sectionTitle: null, lastModified: null, activeUsers: [], locked: false, sizeBytes: 0 };

          // Try live doc first (has awareness for active users)
          const liveDoc = boundDocs.get(id);
          if (liveDoc) {
            try {
              const yMeta = liveDoc.getMap('meta');
              entry.sectionNumber = yMeta.get('sectionNumber') || null;
              entry.sectionTitle = yMeta.get('sectionTitle') || null;
              entry.locked = !!yMeta.get('locked');
            } catch { /* ignore */ }
            if (typeof getActiveUsers === 'function') {
              entry.activeUsers = getActiveUsers(id);
            }
          } else {
            // Fall back to reading persisted .ydoc to extract yMeta
            try {
              const data = await storage.readRoom(id);
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
            const stat = await storage.statRoom(id);
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
