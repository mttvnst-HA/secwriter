/**
 * Regression: DELETE must not be undone by a lingering store, and a FAILED
 * DELETE must not destroy data it can't get back (ADR-0017 "Live-session
 * revocation" follow-up).
 *
 * Under `unloadImmediately: false` a room's live Y.Doc lingers in memory after
 * the last disconnect, and a debounced onStoreDocument armed by prior edits can
 * fire AFTER storage.deleteRoom and re-persist — silently RESURRECTING the
 * just-deleted room.
 *
 * Both tests here drive the REAL server (real Hocuspocus + real
 * LocalStorageBackend + the real DELETE http route) but force the race
 * deterministically instead of sleeping past a real debounce timer (CLAUDE.md
 * testing rule #7 / the hocuspocus-server.test.mjs exemplar pattern): rather
 * than waiting hocuspocusDebounceMs + a wall-clock buffer for Hocuspocus's own
 * internal setTimeout to fire, we reach into `hocuspocus.debouncer` (a plain,
 * non-private instance property — the same "internal but accessible, pinned
 * to @hocuspocus/server@4.3.0" reach already used for revokeLiveSessions'
 * `doc.connections`/`conn.context`/`conn.webSocket`) and call `executeNow()`
 * to fire the pending debounced store on demand. This closes the exact window
 * the old test slept through, without any real-time dependency, so it can't
 * flake under a loaded CI runner.
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

function emptyRoomBytes() {
  const doc = new Y.Doc();
  const bytes = Buffer.from(Y.encodeStateAsUpdate(doc));
  doc.destroy();
  return bytes;
}

// Force the pending debounced onStoreDocument for `composite` to run NOW,
// deterministically, instead of waiting for its real setTimeout. See file
// header for why this reach is safe and precedented in this codebase.
function fireDebouncedStore(hocuspocus, composite) {
  const debounceId = `onStoreDocument-${composite}`;
  return hocuspocus.debouncer.executeNow(debounceId);
}

describe('DELETE room — resurrection race (ADR-0017 follow-up)', () => {
  it('a pending debounced store armed before DELETE does NOT re-persist the room', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-del-'));
    const storage = new LocalStorageBackend(tmpDir);
    const srv = createCollabServer({ storage, host: '127.0.0.1' });
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
      assert.equal(srv.hocuspocus.debouncer.isDebounced(`onStoreDocument-${composite}`), true, 'the edit must have armed a debounced store');

      // 3. DELETE via the real http route (exercises the begin/finishRoomDeletion wiring).
      const del = await httpDelete(base, roomId);
      assert.equal(del.status, 200, `DELETE should succeed, got ${del.status}: ${del.body}`);

      // Storage is cleared immediately after DELETE.
      assert.equal(await storage.readRoom(PUBLIC, roomId), null, 'room must be gone from storage right after DELETE');
      assert.equal(srv.hocuspocus.documents.has(composite), false, 'the live doc must have been evicted');

      // 4. Force the armed store to fire NOW (deterministically standing in for
      //    "the debounce timer eventually fires") — with the fix it hits the
      //    tombstone guard in database.store() and no-ops.
      await fireDebouncedStore(srv.hocuspocus, composite);

      // 5. The room must NOT have reappeared.
      assert.equal(await storage.readRoom(PUBLIC, roomId), null, 'a pending store must NOT resurrect a deleted room');
    } finally {
      if (conn) { try { await conn.disconnect(); } catch { /* doc already destroyed */ } }
      srv.cleanup?.();
      srv.httpServer.close();
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  });

  it('a failed storage.deleteRoom does not destroy the live doc or its unflushed edits', async () => {
    // Review finding #1: the earlier single evictRoom()-before-deleteRoom
    // destroyed the live Y.Doc unconditionally, so a deleteRoom failure (e.g. a
    // transient S3/Azure fault) permanently lost whatever unflushed edits the
    // doc held, even though the room technically still existed. The fix splits
    // eviction into beginRoomDeletion (tombstone only, reversible) and
    // finishRoomDeletion (destroy + kick, only after deleteRoom succeeds), with
    // cancelRoomDeletion rolling the tombstone back on failure.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-del-fail-'));
    const storage = new LocalStorageBackend(tmpDir);
    const srv = createCollabServer({ storage, host: '127.0.0.1' });
    await new Promise((r) => srv.httpServer.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${srv.httpServer.address().port}`;
    const roomId = 'survivor';
    const composite = `${PUBLIC}/${roomId}`;

    let conn;
    const originalDeleteRoom = storage.deleteRoom.bind(storage);
    try {
      await storage.writeRoom(PUBLIC, roomId, { ydocBytes: emptyRoomBytes(), secBytes: null, commentsJson: null });

      conn = await srv.hocuspocus.openDirectConnection(composite);
      await conn.transact((d) => { d.getMap('meta').set('sectionTitle', 'unflushed edit'); });
      const liveDoc = srv.hocuspocus.documents.get(composite);
      assert.ok(liveDoc, 'room must be resident with an unflushed edit');

      // Simulate a transient storage fault on deleteRoom.
      storage.deleteRoom = async () => { throw new Error('simulated transient storage fault'); };

      const del = await httpDelete(base, roomId);
      assert.equal(del.status, 500, `DELETE should surface the storage failure, got ${del.status}`);

      // The room must be untouched: still resident, still the SAME live doc
      // instance (not destroyed/replaced), and the edit still readable there.
      assert.equal(srv.hocuspocus.documents.has(composite), true, 'a failed delete must NOT evict the live doc');
      assert.strictEqual(srv.hocuspocus.documents.get(composite), liveDoc, 'the live doc instance must be untouched');
      assert.equal(liveDoc.getMap('meta').get('sectionTitle'), 'unflushed edit', 'the unflushed edit must survive');

      // The tombstone rollback must have taken effect: a store for this name
      // must succeed again (not silently no-op forever).
      const persisted = await srv.database.store({ documentName: composite, document: liveDoc, instance: srv.hocuspocus });
      assert.equal(persisted, true, 'a store after a failed delete must NOT be permanently suppressed by a stuck tombstone');
      const onDisk = await storage.readRoom(PUBLIC, roomId);
      assert.ok(onDisk && onDisk.ydocBytes, 'the surviving room must be persistable again after the failed delete');
    } finally {
      storage.deleteRoom = originalDeleteRoom;
      if (conn) { try { await conn.disconnect(); } catch { /* ignore */ } }
      srv.cleanup?.();
      srv.httpServer.close();
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  });
});
