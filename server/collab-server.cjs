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
 *     tight enough for your deployment. Spec content handled by SIM is CUI.
 *
 *   npm run collab
 */

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
  console.warn('║  Spec content is CUI. Do NOT expose this to a network.   ║');
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
const DEBOUNCE_MS = 500;

function roomFile(name) {
  const safe = String(name).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64) || 'default';
  return path.join(DATA_DIR, `${safe}.ydoc`);
}

/** Atomic write: stage to .tmp, then rename. */
function writeSnapshotAtomic(file, bytes) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, bytes);
  fs.renameSync(tmp, file);
}

/** Flush a single room's pending snapshot synchronously. */
function flushRoom(docName) {
  const timer = writeTimers.get(docName);
  if (timer) {
    clearTimeout(timer);
    writeTimers.delete(docName);
  }
  const ydoc = boundDocs.get(docName);
  if (!ydoc) return;
  try {
    const snapshot = Y.encodeStateAsUpdate(ydoc);
    if (snapshot.byteLength > MAX_DOC_BYTES) {
      console.warn(`[collab] REFUSING to persist "${docName}": ${snapshot.byteLength} bytes > MAX_DOC_BYTES (${MAX_DOC_BYTES})`);
      return;
    }
    writeSnapshotAtomic(roomFile(docName), Buffer.from(snapshot));
  } catch (err) {
    console.warn(`[collab] persist failed for "${docName}":`, err.message);
  }
}

setPersistence({
  bindState: async (docName, ydoc) => {
    boundDocs.set(docName, ydoc);
    const file = roomFile(docName);
    if (fs.existsSync(file)) {
      try {
        const stat = fs.statSync(file);
        if (stat.size > MAX_DOC_BYTES) {
          // Preserve the oversized file instead of silently loading or
          // wiping it. An operator can inspect and recover.
          const quarantine = `${file}.oversize.${Date.now()}`;
          fs.renameSync(file, quarantine);
          console.warn(`[collab] room "${docName}" snapshot (${stat.size} bytes) exceeds MAX_DOC_BYTES; moved to ${quarantine}`);
          console.log(`[collab] new room "${docName}"`);
        } else {
          const bytes = fs.readFileSync(file);
          // N1 — Decode into a scratch Y.Doc first so a throw halfway
          // through cannot leave the real `ydoc` in a partially-mutated
          // state that the next joining client would see as garbage.
          // If decode succeeds we re-emit a clean state update into the
          // real ydoc. If it throws, we quarantine and leave ydoc empty.
          let restored = false;
          const scratch = new Y.Doc();
          try {
            Y.applyUpdate(scratch, new Uint8Array(bytes));
            restored = true;
          } catch (err) {
            const quarantine = `${file}.corrupt.${Date.now()}`;
            try { fs.renameSync(file, quarantine); } catch { /* ignore */ }
            console.warn(`[collab] failed to restore "${docName}": ${err.message}; moved to ${quarantine}`);
          }
          if (restored) {
            Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(scratch));
            console.log(`[collab] restored room "${docName}" (${bytes.length} bytes)`);
          } else {
            console.log(`[collab] new room "${docName}"`);
          }
          scratch.destroy();
        }
      } catch (err) {
        console.warn(`[collab] could not read "${docName}":`, err.message);
      }
    } else {
      console.log(`[collab] new room "${docName}"`);
    }

    ydoc.on('update', () => {
      const prev = writeTimers.get(docName);
      if (prev) clearTimeout(prev);
      writeTimers.set(docName, setTimeout(() => flushRoom(docName), DEBOUNCE_MS));
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

// ── Graceful shutdown ────────────────────────────────────────────────────
//
// SIGINT (Ctrl+C) / SIGTERM: flush every room synchronously so edits made
// in the final DEBOUNCE_MS window are not lost. Without this, the
// debounced timer is discarded when the process exits, and up to 500 ms of
// the last edits — potentially the entire initial seed of a fresh room —
// vanish silently.
let shuttingDown = false;
function flushAllRooms() {
  for (const docName of boundDocs.keys()) flushRoom(docName);
}
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[collab] ${signal} received; flushing ${boundDocs.size} room(s)...`);
  flushAllRooms();
  try { wss.close(); } catch { /* ignore */ }
  // Give wss.close() one tick then exit. This keeps the server responsive
  // to a second Ctrl+C if the first one hangs.
  setTimeout(() => process.exit(0), 50);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('beforeExit', () => { if (!shuttingDown) flushAllRooms(); });
