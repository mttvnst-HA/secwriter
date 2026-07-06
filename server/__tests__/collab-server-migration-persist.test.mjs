/**
 * Regression: a DELETE racing a slow migration-broker persist must not
 * resurrect the deleted room, and the migration's explicit persist call must
 * NOT thread Hocuspocus's `instance` (ADR-0017 follow-up review finding #2).
 *
 * Empirically verified against @hocuspocus/server@4.3.0: `instance.documents`
 * does not yet contain a document while its own onLoadDocument hook is still
 * running (Hocuspocus only calls `this.documents.set(name, doc)` AFTER
 * loadDocument — including onLoadDocument — resolves). If the migration's
 * `database.store({ documentName, document })` call in collab-server.cjs ever
 * threads `instance` too, the identity guard in SecWriterDatabase.store()
 * would compare against `undefined` and trip on EVERY migration persist, not
 * just a raced one. This test pins the current, correct behavior (no
 * `instance`) so that regression can't slip back in:
 *   1. a normal (non-racing) migration persist succeeds — writeRoom is
 *      called with the migrated bytes.
 *   2. a DELETE that lands WHILE the migration's ensureMigrated() is still
 *      awaiting does not get undone by the migration's persist call once it
 *      finally runs — the room stays deleted (tombstone alone, no `instance`,
 *      is sufficient because Hocuspocus's own `loadingDocuments` de-dupe
 *      guarantees no second load can start for the same name until this one
 *      resolves).
 *
 * Uses Node's built-in test runner (NOT vitest).
 * Run: node --test server/__tests__/collab-server-migration-persist.test.mjs
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

// A controllable stand-in for createMigrationCoordinator(): ensureMigrated()
// blocks on `gate` until the test releases it, so the test can deterministically
// force a DELETE to land while a migration's onLoadDocument is still in flight
// (no reliance on real timers).
function makeGatedMigrationCoordinator() {
  let releaseGate;
  const gate = new Promise((resolve) => { releaseGate = resolve; });
  let calls = 0;
  return {
    coordinator: {
      async ensureMigrated(documentName, document) {
        calls += 1;
        await gate;
        return { skipped: false, migrationPartial: false };
      },
      forget() {},
    },
    release: () => releaseGate(),
    get calls() { return calls; },
  };
}

describe('migration-broker explicit persist — instance omission + delete race (ADR-0017 follow-up)', () => {
  it('a DELETE landing during a slow migration persist does not resurrect the room', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-migpersist-'));
    const storage = new LocalStorageBackend(tmpDir);
    let writeCount = 0;
    const originalWriteRoom = storage.writeRoom.bind(storage);
    storage.writeRoom = async (...args) => { writeCount += 1; return originalWriteRoom(...args); };

    const { coordinator, release } = makeGatedMigrationCoordinator();
    const srv = createCollabServer({ storage, host: '127.0.0.1', migrationCoordinator: coordinator });
    await new Promise((r) => srv.httpServer.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${srv.httpServer.address().port}`;
    const roomId = 'migrating';
    const composite = `${PUBLIC}/${roomId}`;

    let conn;
    try {
      await storage.writeRoom(PUBLIC, roomId, { ydocBytes: emptyRoomBytes(), secBytes: null, commentsJson: null });
      writeCount = 0; // only count writes from here on

      // Start loading the room — this synchronously enters onLoadDocument and
      // blocks on ensureMigrated's gate (the "slow migration" window).
      const connectPromise = srv.hocuspocus.openDirectConnection(composite);

      // DELETE while the migration is still in flight. beginRoomDeletion's
      // markDeleted() tombstones the name immediately; storage.deleteRoom()
      // then clears it. The doc is NOT yet resident (onLoadDocument hasn't
      // resolved), so there is nothing for finishRoomDeletion to evict/kick —
      // that's expected and fine, the tombstone is what matters here.
      const del = await httpDelete(base, roomId);
      assert.equal(del.status, 200, `DELETE should succeed, got ${del.status}: ${del.body}`);
      assert.equal(await storage.readRoom(PUBLIC, roomId), null, 'room must be gone from storage right after DELETE');

      // Now let the migration finish and run its explicit persist. With the
      // tombstone already set, database.store() must no-op regardless of
      // `instance` — the room must NOT come back.
      release();
      conn = await connectPromise;

      // Give the persist call's promise chain a chance to settle (it runs
      // synchronously inside onLoadDocument, which openDirectConnection awaits
      // internally before resolving `conn`, so no extra wait should even be
      // needed — but a single microtask flush is cheap insurance for the
      // fire-and-forget log.error() branch, not for the assertion itself).
      await Promise.resolve();

      assert.equal(await storage.readRoom(PUBLIC, roomId), null, 'a raced migration persist must NOT resurrect a deleted room');
      assert.equal(writeCount, 0, 'writeRoom must never have been called for the tombstoned name');
    } finally {
      if (conn) { try { await conn.disconnect(); } catch { /* doc already destroyed */ } }
      srv.cleanup?.();
      srv.httpServer.close();
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  });

  it('a normal (non-racing) migration persist succeeds without threading `instance`', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-migpersist-ok-'));
    const storage = new LocalStorageBackend(tmpDir);

    const coordinator = {
      async ensureMigrated() { return { skipped: false, migrationPartial: false }; },
      forget() {},
    };
    const srv = createCollabServer({ storage, host: '127.0.0.1', migrationCoordinator: coordinator });
    const roomId = 'migrating-ok';
    const composite = `${PUBLIC}/${roomId}`;

    let conn;
    try {
      await storage.writeRoom(PUBLIC, roomId, { ydocBytes: emptyRoomBytes(), secBytes: null, commentsJson: null });
      conn = await srv.hocuspocus.openDirectConnection(composite);
      // openDirectConnection awaits the full load (including onLoadDocument's
      // migration persist) before resolving, so the write has already landed.
      const persisted = await storage.readRoom(PUBLIC, roomId);
      assert.ok(persisted && persisted.ydocBytes, 'a non-racing migration persist must reach storage');
    } finally {
      if (conn) { try { await conn.disconnect(); } catch { /* ignore */ } }
      srv.cleanup?.();
      srv.httpServer.close();
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  });
});

// PR #51 review (issue e) — regression. The migration coordinator caches
// `{ alreadyV2: true }` per docName. After DELETE /rooms/:id, a fresh room
// created with the same id (or a v1 SEC re-uploaded under it) would see the
// cached short-circuit and skip both archive + migration.
//
// ADR-0017 follow-up review finding #4: this forwarding now lives in
// collab-server.cjs's finishRoomDeletion (folded in alongside the doc-
// eviction/session-kick teardown so the two per-room invalidation mechanisms
// can't drift apart), NOT in http-handler.cjs — exercised here through
// createCollabServer, the layer that actually owns the wiring. (Moved from
// http-endpoints.test.mjs, which tested it at the wrong layer post-split.)
describe('DELETE /rooms/:id clears the migration coordinator cache (issue e)', () => {
  it('forwards forget(composite) to the migration coordinator on successful delete', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-migforget-'));
    const storage = new LocalStorageBackend(tmpDir);
    const coordCalls = [];
    const coordinator = {
      async ensureMigrated() { return { skipped: true }; },
      forget(docName) { coordCalls.push(docName); },
    };
    const srv = createCollabServer({ storage, host: '127.0.0.1', migrationCoordinator: coordinator });
    await new Promise((r) => srv.httpServer.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${srv.httpServer.address().port}`;
    const roomId = 'to-delete';
    const composite = `${PUBLIC}/${roomId}`;

    try {
      await storage.writeRoom(PUBLIC, roomId, { ydocBytes: emptyRoomBytes(), secBytes: null, commentsJson: null });
      const resp = await httpDelete(base, roomId);
      assert.strictEqual(resp.status, 200);
      assert.deepStrictEqual(coordCalls, [composite], 'finishRoomDeletion must forward the composite docName to forget()');
    } finally {
      srv.cleanup?.();
      srv.httpServer.close();
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  });

  it('a migration coordinator without forget() does not crash the DELETE path', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-migforget-noop-'));
    const storage = new LocalStorageBackend(tmpDir);
    // No `forget` method at all — finishRoomDeletion's `typeof forget ===
    // 'function'` guard must keep this from throwing.
    const coordinator = { async ensureMigrated() { return { skipped: true }; } };
    const srv = createCollabServer({ storage, host: '127.0.0.1', migrationCoordinator: coordinator });
    await new Promise((r) => srv.httpServer.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${srv.httpServer.address().port}`;
    const roomId = 'to-delete-2';

    try {
      await storage.writeRoom(PUBLIC, roomId, { ydocBytes: emptyRoomBytes(), secBytes: null, commentsJson: null });
      const resp = await httpDelete(base, roomId);
      assert.strictEqual(resp.status, 200);
    } finally {
      srv.cleanup?.();
      srv.httpServer.close();
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  });
});
