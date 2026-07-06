/**
 * Regression: DELETE must not be undone by a lingering store (ADR-0017
 * "Live-session revocation" follow-up).
 *
 * Under `unloadImmediately: false` a room's live Y.Doc lingers in memory after
 * the last disconnect, and a debounced onStoreDocument armed by prior edits can
 * fire AFTER storage.deleteRoom and re-persist — silently RESURRECTING the
 * just-deleted room. This drives the REAL server (real Hocuspocus + real
 * debounce timer + real LocalStorageBackend + the real DELETE http route) to
 * reproduce the race deterministically:
 *
 *   1. seed a room on disk,
 *   2. make it resident with an armed (un-fired) debounced store,
 *   3. DELETE it via the http route,
 *   4. wait PAST the debounce window,
 *   5. assert the room did NOT reappear in storage.
 *
 * Uses Node's built-in test runner (NOT vitest).
 * Run: node --test server/__tests__/room-delete-resurrection.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import * as Y from 'yjs';

const require_ = createRequire(import.meta.url);
require_('../dom-polyfill.cjs');
const { createCollabServer } = require_('../collab-server.cjs');
const { LocalStorageBackend } = require_('../storage-local.cjs');

const PUBLIC = '_public';

function httpDelete(base, roomId) {
  return new Promise((resolve, reject) => {
    const u = new URL(`${base}/rooms/${roomId}`);
    const req = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname, method: 'DELETE' },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf-8') }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function emptyRoomBytes() {
  const doc = new Y.Doc();
  const bytes = Buffer.from(Y.encodeStateAsUpdate(doc));
  doc.destroy();
  return bytes;
}

describe('DELETE room — resurrection race (ADR-0017 follow-up)', () => {
  it('a pending debounced store armed before DELETE does NOT re-persist the room', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-del-'));
    const storage = new LocalStorageBackend(tmpDir);
    // Wide debounce so the store armed below is still PENDING (un-fired) when
    // DELETE runs, and only fires during the post-delete wait — the exact race.
    const srv = createCollabServer({ storage, host: '127.0.0.1', hocuspocusDebounceMs: 1000 });
    await new Promise((r) => srv.httpServer.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${srv.httpServer.address().port}`;
    const roomId = 'doomed';
    const composite = `${PUBLIC}/${roomId}`;

    let conn;
    try {
      // 1. Seed the room on disk so the DELETE route's existence check passes.
      await storage.writeRoom(PUBLIC, roomId, { ydocBytes: emptyRoomBytes(), secBytes: null, commentsJson: null });

      // 2. Make it resident (loads into hocuspocus.documents) and arm a pending
      //    store via a real edit — no WS client needed, deterministic in-process.
      conn = await srv.hocuspocus.openDirectConnection(composite);
      await conn.transact((d) => { d.getMap('meta').set('sectionTitle', 'edited before delete'); });
      assert.equal(srv.hocuspocus.documents.has(composite), true, 'room must be resident with a pending store armed');

      // 3. DELETE via the real http route (exercises the evictRoom wiring).
      const del = await httpDelete(base, roomId);
      assert.equal(del.status, 200, `DELETE should succeed, got ${del.status}: ${del.body}`);

      // Storage is cleared immediately after DELETE.
      assert.equal(await storage.readRoom(PUBLIC, roomId), null, 'room must be gone from storage right after DELETE');

      // 4. Wait PAST the debounce window so the armed store fires — with the fix
      //    it hits the tombstone/identity guard in database.store() and no-ops.
      await sleep(1600);

      // 5. The room must NOT have reappeared.
      assert.equal(await storage.readRoom(PUBLIC, roomId), null, 'a pending store must NOT resurrect a deleted room');
      assert.equal(srv.hocuspocus.documents.has(composite), false, 'the live doc must have been evicted');
    } finally {
      if (conn) { try { await conn.disconnect(); } catch { /* doc already destroyed */ } }
      srv.cleanup?.();
      srv.httpServer.close();
      await sleep(50);
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  });
});
