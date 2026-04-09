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
 * Prototype only: no auth, no TLS, no rate limiting. Runs on localhost.
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

fs.mkdirSync(DATA_DIR, { recursive: true });

// Debounced per-room file persistence: one <room>.ydoc file per room,
// rewritten at most once every DEBOUNCE_MS after any update.
const writeTimers = new Map();
const DEBOUNCE_MS = 500;

function roomFile(name) {
  const safe = String(name).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64) || 'default';
  return path.join(DATA_DIR, `${safe}.ydoc`);
}

setPersistence({
  bindState: async (docName, ydoc) => {
    const file = roomFile(docName);
    if (fs.existsSync(file)) {
      try {
        const bytes = fs.readFileSync(file);
        Y.applyUpdate(ydoc, new Uint8Array(bytes));
        console.log(`[collab] restored room "${docName}" (${bytes.length} bytes)`);
      } catch (err) {
        console.warn(`[collab] failed to restore "${docName}":`, err.message);
      }
    } else {
      console.log(`[collab] new room "${docName}"`);
    }

    ydoc.on('update', () => {
      const prev = writeTimers.get(docName);
      if (prev) clearTimeout(prev);
      writeTimers.set(docName, setTimeout(() => {
        try {
          const snapshot = Y.encodeStateAsUpdate(ydoc);
          fs.writeFileSync(file, Buffer.from(snapshot));
        } catch (err) {
          console.warn(`[collab] persist failed for "${docName}":`, err.message);
        }
        writeTimers.delete(docName);
      }, DEBOUNCE_MS));
    });
  },
  writeState: async () => {
    // Updates flushed eagerly by the listener above.
  },
});

const wss = new WebSocketServer({ host: HOST, port: PORT });

wss.on('connection', (conn, req) => {
  setupWSConnection(conn, req, { gc: true });
});

wss.on('listening', () => {
  console.log(`[collab] y-websocket listening on ws://${HOST}:${PORT}`);
  console.log(`[collab] persisting rooms to ${DATA_DIR}`);
});

wss.on('error', (err) => {
  console.error('[collab] server error:', err);
});
