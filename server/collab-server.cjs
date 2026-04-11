#!/usr/bin/env node
/**
 * SIM collaborative editing relay.
 *
 * A thin y-websocket server for the multi-user prototype. Persists each Yjs
 * doc to disk as a binary state snapshot so reconnecting clients recover
 * previous work.
 *
 * CJS on purpose: y-websocket v1 ships its server utils as CJS and imports
 * yjs via `require`. Mixing ESM and CJS loads two copies of Yjs, which breaks
 * instanceof checks (see https://github.com/yjs/yjs/issues/438).
 *
 * ⚠️  PROTOTYPE ONLY — localhost. No auth, no TLS, no rate limiting. Do NOT
 *     expose this to a network without first adding: TLS, origin check, auth,
 *     per-IP rate limit, and confirming the MAX_DOC_BYTES guard below is
 *     tight enough for your deployment.
 *
 *   npm run collab
 */

require('./dom-polyfill.cjs');
const WS = require('ws');
// y-websocket v1.5.4 pins ws@6, which exports the server as `Server` (not
// `WebSocketServer`). Support both so a future ws upgrade doesn't break us.
const WebSocketServer = WS.WebSocketServer || WS.Server;
const Y = require('yjs');
const { setupWSConnection, setPersistence } = require('y-websocket/bin/utils');
const fs = require('node:fs');
const path = require('node:path');

const PORT = Number(process.env.COLLAB_PORT || 1234);
const HOST = process.env.COLLAB_HOST || '127.0.0.1';
const DATA_DIR = path.resolve(process.cwd(), 'server/collab-db');
const { LocalStorageBackend } = require('./storage-local.cjs');
const storage = new LocalStorageBackend(DATA_DIR);

// Hard caps. A single spec section is O(100KB) of text; 8 MB gives plenty of
// headroom for Y.Doc overhead + revision history without letting a runaway
// client fill the disk. Persisted snapshot is rejected on both read and
// write if it exceeds this.
const MAX_DOC_BYTES = 8 * 1024 * 1024;

fs.mkdirSync(DATA_DIR, { recursive: true });

// N4 — Orphan .tmp sweep at startup.
// Atomic writes stage to `<room>.ydoc.tmp` then rename. On Windows a rename
// over an open file can throw EPERM and leave an orphaned `.tmp` on disk.
// A crash between stage and rename has the same effect. Clean these up
// before any room binds so they can't confuse forensics or waste space.
try {
  for (const name of fs.readdirSync(DATA_DIR)) {
    if (name.endsWith('.tmp')) {
      try { fs.unlinkSync(path.join(DATA_DIR, name)); }
      catch (err) { console.warn(`[collab] could not remove orphan ${name}:`, err.message); }
    }
  }
} catch (err) {
  console.warn('[collab] startup tmp sweep failed:', err.message);
}

// Loud warning if the operator has flipped off loopback. The prototype has
// no auth; binding to anything else is a data-exfiltration vector.
if (HOST !== '127.0.0.1' && HOST !== 'localhost' && HOST !== '::1') {
  console.warn('');
  console.warn('╔════════════════════════════════════════════════════════════╗');
  console.warn('║  WARNING: collab-server bound to a non-loopback host.     ║');
  console.warn(`║  HOST=${HOST.padEnd(52)}║`);
  console.warn('║  This prototype has NO auth, NO TLS, NO rate limiting.   ║');
  console.warn('║  Do NOT expose this to a network without hardening.      ║');
  console.warn('╚════════════════════════════════════════════════════════════╝');
  console.warn('');
}

// Debounced per-room file persistence: one <room>.ydoc file per room,
// rewritten at most once every DEBOUNCE_MS after any update. Writes are
// atomic (tempfile + rename) so a crash mid-write can never leave a
// half-written file on disk.
const writeTimers = new Map();
// Track the per-room Y.Doc so the shutdown handler can flush every room
// even if its timer hasn't fired.
const boundDocs = new Map();
// M-2: per-room persist health tracking.
// roomHealth.get(docName) = { persistFailures: number, lastPersistSuccess: number|null }
const roomHealth = new Map();
function getHealth(docName) {
  let h = roomHealth.get(docName);
  if (!h) {
    h = { persistFailures: 0, lastPersistSuccess: null };
    roomHealth.set(docName, h);
  }
  return h;
}
const DEBOUNCE_MS = 500;

// Lazy-loaded room serializer — avoids pulling in sec-parser + sec-serializer
// at startup (heavy modules with large data files) when the server may only
// need basic Y.Doc persistence for the first few hundred milliseconds.
let _serializeRoom = null;
async function getSerializeRoom() {
  if (!_serializeRoom) {
    const mod = require('./room-serializer.cjs');
    _serializeRoom = mod.serializeRoom;
  }
  return _serializeRoom;
}

/** Flush a single room to disk: .ydoc + .SEC + .comments.json via storage backend. */
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
      console.warn(
        `[collab] flush REFUSED for room=${docName}: ` +
        `size ${snapshot.byteLength} > cap ${MAX_DOC_BYTES}. ` +
        `Last success: ${health.lastPersistSuccess ? new Date(health.lastPersistSuccess).toISOString() : 'never'}`
      );
      return;
    }

    const serializeRoom = await getSerializeRoom();
    const artifacts = await serializeRoom(ydoc);
    await storage.writeRoom(docName, artifacts);

    // M-2: success → reset failure counter + stamp last-good time.
    health.persistFailures = 0;
    health.lastPersistSuccess = Date.now();
  } catch (err) {
    // M-2: track persist failures and escalate after 3 in a row.
    health.persistFailures = (health.persistFailures || 0) + 1;
    const staleFor = health.lastPersistSuccess
      ? `${Math.round((Date.now() - health.lastPersistSuccess) / 1000)}s`
      : 'never succeeded';
    console.warn(
      `[collab] persist failed for room=${docName} ` +
      `failures=${health.persistFailures} stale=${staleFor} err=${err.message}`
    );
    if (health.persistFailures >= 3) {
      console.error(
        `[collab] ALERT room=${docName} has failed to persist ${health.persistFailures} ` +
        `times in a row; in-memory state is diverging from disk`
      );
    }
  }
}

setPersistence({
  bindState: async (docName, ydoc) => {
    boundDocs.set(docName, ydoc);
    try {
      const roomData = await storage.readRoom(docName);
      if (roomData && roomData.ydocBytes) {
        const bytes = roomData.ydocBytes;
        if (bytes.length > MAX_DOC_BYTES) {
          // Oversized — quarantine via storage backend rename and start fresh.
          await storage.quarantineRoom(docName, 'oversize');
          console.warn(`[collab] room "${docName}" snapshot (${bytes.length} bytes) exceeds MAX_DOC_BYTES; quarantined`);
          console.log(`[collab] new room "${docName}"`);
        } else {
          // N1 — Decode into a scratch Y.Doc first so a throw halfway
          // through cannot leave the real `ydoc` in a partially-mutated
          // state that the next joining client would see as garbage.
          let restored = false;
          const scratch = new Y.Doc();
          try {
            Y.applyUpdate(scratch, new Uint8Array(bytes));
            restored = true;
          } catch (err) {
            await storage.quarantineRoom(docName, 'corrupt');
            console.warn(`[collab] failed to restore "${docName}": ${err.message}; quarantined`);
          }
          if (restored) {
            Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(scratch));
            console.log(`[collab] restored room "${docName}" (${bytes.length} bytes)`);
          } else {
            console.log(`[collab] new room "${docName}"`);
          }
          scratch.destroy();
        }
      } else {
        console.log(`[collab] new room "${docName}"`);
      }
    } catch (err) {
      console.warn(`[collab] could not read "${docName}":`, err.message);
    }

    ydoc.on('update', () => {
      const prev = writeTimers.get(docName);
      if (prev) clearTimeout(prev);
      writeTimers.set(docName, setTimeout(() => flushRoom(docName).catch(err => {
        console.error(`[collab] uncaught flush error room=${docName}:`, err.message);
      }), DEBOUNCE_MS));
    });
  },
  writeState: async () => {
    // Updates flushed eagerly by the listener above; shutdown path flushes
    // via flushAllRooms(). No per-doc writeState work needed.
  },
});

const wss = new WebSocketServer({ host: HOST, port: PORT });

wss.on('connection', (conn, req) => {
  setupWSConnection(conn, req, { gc: true });
});

wss.on('listening', () => {
  console.log(`[collab] y-websocket listening on ws://${HOST}:${PORT}`);
  console.log(`[collab] persisting rooms to ${DATA_DIR}`);
  console.log(`[collab] MAX_DOC_BYTES = ${MAX_DOC_BYTES}`);
});

wss.on('error', (err) => {
  console.error('[collab] server error:', err);
});

// ── HTTP endpoints for document download/upload ──────────────────────────
const http = require('node:http');

const httpServer = http.createServer(async (req, res) => {
  // CORS for dev
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url = new URL(req.url, `http://${req.headers.host}`);

  // POST /rooms/:roomId/upload
  const uploadMatch = url.pathname.match(/^\/rooms\/([^/]+)\/upload$/);
  if (uploadMatch && req.method === 'POST') {
    const roomId = uploadMatch[1];
    const chunks = [];
    let totalSize = 0;
    let aborted = false;
    req.on('data', (chunk) => {
      totalSize += chunk.length;
      if (totalSize > MAX_DOC_BYTES) {
        aborted = true;
        res.writeHead(413, { 'Content-Type': 'text/plain' });
        res.end(`File exceeds ${MAX_DOC_BYTES} byte limit`);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', async () => {
      if (aborted) return;
      try {
        const body = Buffer.concat(chunks);
        const secContent = body.toString('latin1');

        const { parseSEC } = await import('../src/lib/sec-parser.js');
        const blocks = parseSEC(secContent);
        if (!blocks || blocks.length === 0) {
          res.writeHead(400, { 'Content-Type': 'text/plain' });
          res.end('Failed to parse SEC file — no blocks extracted');
          return;
        }

        // If room has a live Y.Doc, apply blocks to it
        const ydoc = boundDocs.get(roomId);
        if (ydoc) {
          const { applyBlocksToYDoc } = await import('../src/lib/collab.js');
          const yOrder = ydoc.getArray('order');
          const yStore = ydoc.getMap('store');
          ydoc.transact(() => {
            applyBlocksToYDoc(ydoc, yOrder, yStore, blocks);
          }, 'upload');
          // Trigger persist
          flushRoom(roomId);
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, blocks: blocks.length }));
      } catch (err) {
        console.error(`[collab] upload failed for room=${roomId}:`, err.message);
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
      console.error(`[collab] download failed for room=${roomId}/${artifact}:`, err.message);
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end(`Download failed: ${err.message}`);
    }
    return;
  }

  // GET /rooms — list all rooms
  const listMatch = url.pathname === '/rooms' && req.method === 'GET';
  if (listMatch) {
    try {
      const rooms = await storage.listRooms();
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
});

const HTTP_PORT = Number(process.env.COLLAB_HTTP_PORT || 1235);
httpServer.listen(HTTP_PORT, HOST, () => {
  console.log(`[collab] HTTP endpoints at http://${HOST}:${HTTP_PORT}/rooms/:roomId/{sec,comments,upload}`);
});

// ── Graceful shutdown ────────────────────────────────────────────────────
//
// SIGINT (Ctrl+C) / SIGTERM: flush every room synchronously so edits made
// in the final DEBOUNCE_MS window are not lost. Without this, the
// debounced timer is discarded when the process exits, and up to 500 ms of
// the last edits — potentially the entire initial seed of a fresh room —
// vanish silently.
let shuttingDown = false;
async function flushAllRooms() {
  for (const docName of boundDocs.keys()) await flushRoom(docName);
}
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[collab] ${signal} received; flushing ${boundDocs.size} room(s)...`);
  await flushAllRooms();
  try { wss.close(); } catch { /* ignore */ }
  try { httpServer.close(); } catch { /* ignore */ }
  // Give wss.close() one tick then exit. This keeps the server responsive
  // to a second Ctrl+C if the first one hangs.
  setTimeout(() => process.exit(0), 50);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
// No beforeExit handler — flushAllRooms() is async and beforeExit does not
// await promises. SIGINT/SIGTERM handlers already cover graceful shutdown.
