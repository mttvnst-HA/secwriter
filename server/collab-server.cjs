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

const { createAuthProvider } = require('./auth/auth-provider.cjs');
const authProvider = createAuthProvider();

const PORT = Number(process.env.COLLAB_PORT || 1234);
const HOST = process.env.COLLAB_HOST || '127.0.0.1';
const DATA_DIR = path.resolve(process.cwd(), 'server/collab-db');
let storage;
if (process.env.SIM_STORAGE_BACKEND === 'azure') {
  const { BlobServiceClient } = require('@azure/storage-blob');
  const { DefaultAzureCredential } = require('@azure/identity');
  const connectionString = process.env.SIM_AZURE_STORAGE_CONNECTION_STRING;
  const containerName = process.env.SIM_AZURE_STORAGE_CONTAINER || 'sim-collab-rooms';
  let blobServiceClient;
  if (connectionString) {
    blobServiceClient = BlobServiceClient.fromConnectionString(connectionString);
  } else {
    const accountUrl = process.env.SIM_AZURE_STORAGE_ACCOUNT_URL;
    if (!accountUrl) throw new Error('Azure storage requires SIM_AZURE_STORAGE_CONNECTION_STRING or SIM_AZURE_STORAGE_ACCOUNT_URL');
    blobServiceClient = new BlobServiceClient(accountUrl, new DefaultAzureCredential());
  }
  const { AzureStorageBackend } = require('./storage-azure.cjs');
  storage = new AzureStorageBackend({ containerClient: blobServiceClient.getContainerClient(containerName) });
  console.log(`[collab] Storage backend: Azure Blob (container=${containerName})`);
} else {
  const { LocalStorageBackend } = require('./storage-local.cjs');
  storage = new LocalStorageBackend(DATA_DIR);
  console.log(`[collab] Storage backend: local (${DATA_DIR})`);
}

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

wss.on('connection', async (conn, req) => {
  // Auth: extract token from query parameter
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const token = url.searchParams.get('token');
  if (token) {
    const user = await authProvider.validateToken(token);
    if (!user) {
      conn.close(4401, 'Unauthorized');
      return;
    }
    conn.user = user;
  }
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
const { createHttpHandler } = require('./http-handler.cjs');

const httpServer = http.createServer(
  createHttpHandler({ storage, boundDocs, flushRoom, maxDocBytes: MAX_DOC_BYTES, authProvider })
);

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
