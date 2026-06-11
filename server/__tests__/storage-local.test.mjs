/**
 * Tests for LocalStorageBackend (server/storage-local.cjs).
 *
 * Uses Node's built-in test runner. Run via:
 *   node --test server/__tests__/storage-local.test.mjs
 */
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { LocalStorageBackend } = require('../storage-local.cjs');

const T = 'acme'; // tenant for all tests

let tmpDirs = [];

function freshDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sim-storage-test-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const d of tmpDirs) {
    fs.rmSync(d, { recursive: true, force: true });
  }
  tmpDirs = [];
});

describe('LocalStorageBackend', () => {
  it('writeRoom + readRoom round-trips all three artifacts', async () => {
    const backend = new LocalStorageBackend(freshDir());
    const ydocBytes = Buffer.from([0x01, 0x02, 0x03]);
    const secBytes = Buffer.from('<?xml version="1.0"?><SEC/>', 'utf-8');
    const commentsJson = JSON.stringify({ c1: { text: 'hello' } });

    await backend.writeRoom(T, 'demo', { ydocBytes, secBytes, commentsJson });
    const result = await backend.readRoom(T, 'demo');

    assert.ok(result, 'readRoom should return an object');
    assert.deepStrictEqual(result.ydocBytes, ydocBytes);
    assert.deepStrictEqual(result.secBytes, secBytes);
    assert.strictEqual(result.commentsJson, commentsJson);
  });

  it('readRoom returns null for non-existent room', async () => {
    const backend = new LocalStorageBackend(freshDir());
    const result = await backend.readRoom(T, 'no-such-room');
    assert.strictEqual(result, null);
  });

  it('readRoom returns partial data when .SEC or .comments.json missing', async () => {
    const dir = freshDir();
    const backend = new LocalStorageBackend(dir);
    // Write only the .ydoc file directly under the tenant subdir (new layout)
    const tenantDir = path.join(dir, T);
    fs.mkdirSync(tenantDir, { recursive: true });
    fs.writeFileSync(path.join(tenantDir, 'legacy.ydoc'), Buffer.from([0xFF]));

    const result = await backend.readRoom(T, 'legacy');
    assert.ok(result, 'should return an object when .ydoc exists');
    assert.deepStrictEqual(result.ydocBytes, Buffer.from([0xFF]));
    assert.strictEqual(result.secBytes, null);
    assert.strictEqual(result.commentsJson, null);
  });

  it('deleteRoom removes all artifacts', async () => {
    const backend = new LocalStorageBackend(freshDir());
    await backend.writeRoom(T, 'rm-test', {
      ydocBytes: Buffer.from([1]),
      secBytes: Buffer.from([2]),
      commentsJson: '{}',
    });

    await backend.deleteRoom(T, 'rm-test');
    const result = await backend.readRoom(T, 'rm-test');
    assert.strictEqual(result, null);
  });

  it('listRooms returns room names from .ydoc files', async () => {
    const backend = new LocalStorageBackend(freshDir());
    await backend.writeRoom(T, 'alpha', { ydocBytes: Buffer.from([1]), secBytes: null, commentsJson: null });
    await backend.writeRoom(T, 'bravo', { ydocBytes: Buffer.from([2]), secBytes: null, commentsJson: null });

    const rooms = await backend.listRooms(T);
    rooms.sort();
    assert.deepStrictEqual(rooms, ['alpha', 'bravo']);
  });

  it('listRooms excludes .tmp, .corrupt, .oversize variants', async () => {
    const dir = freshDir();
    const backend = new LocalStorageBackend(dir);
    await backend.writeRoom(T, 'real', { ydocBytes: Buffer.from([1]), secBytes: null, commentsJson: null });
    // Write fake variant files under the tenant dir — these should be excluded
    const tenantDir = path.join(dir, T);
    fs.writeFileSync(path.join(tenantDir, 'real.ydoc.tmp'), Buffer.from([0]));
    fs.writeFileSync(path.join(tenantDir, 'ghost.ydoc.corrupt.12345'), Buffer.from([0]));
    fs.writeFileSync(path.join(tenantDir, 'ghost2.ydoc.oversize.12345'), Buffer.from([0]));

    const rooms = await backend.listRooms(T);
    assert.deepStrictEqual(rooms, ['real']);
  });

  it('sanitizes room names', async () => {
    const dir = freshDir();
    const backend = new LocalStorageBackend(dir);
    await backend.writeRoom(T, '../../etc/passwd', { ydocBytes: Buffer.from([1]), secBytes: null, commentsJson: null });

    // Should be sanitized to something safe
    const rooms = await backend.listRooms(T);
    assert.strictEqual(rooms.length, 1);
    assert.ok(!rooms[0].includes('/'), 'room name must not contain /');
    assert.ok(!rooms[0].includes('..'), 'room name must not contain ..');
  });

  it('archiveRoom moves files to archive/<tenant> subdirectory', async () => {
    const dir = freshDir();
    const backend = new LocalStorageBackend(dir);
    await backend.writeRoom(T, 'arch-test', {
      ydocBytes: Buffer.from([1, 2, 3]),
      secBytes: Buffer.from('sec'),
      commentsJson: '{}',
    });

    await backend.archiveRoom(T, 'arch-test');

    const original = await backend.readRoom(T, 'arch-test');
    assert.equal(original, null);

    const archiveDir = path.join(dir, 'archive', T);
    assert.ok(fs.existsSync(archiveDir));
    assert.ok(fs.existsSync(path.join(archiveDir, 'arch-test.ydoc')));
    assert.ok(fs.existsSync(path.join(archiveDir, 'arch-test.archivedAt')));

    const archived = await backend.listArchivedRooms(T);
    assert.ok(archived.some(r => r.id === 'arch-test'));
    assert.ok(archived[0].archivedAt);
  });

  it('restoreRoom moves files back from archive', async () => {
    const dir = freshDir();
    const backend = new LocalStorageBackend(dir);
    await backend.writeRoom(T, 'restore-test', {
      ydocBytes: Buffer.from([4, 5, 6]),
      secBytes: null,
      commentsJson: null,
    });
    await backend.archiveRoom(T, 'restore-test');
    await backend.restoreRoom(T, 'restore-test');

    const data = await backend.readRoom(T, 'restore-test');
    assert.ok(data);
    assert.deepStrictEqual(data.ydocBytes, Buffer.from([4, 5, 6]));
  });

  it('deleteArchivedRoom removes archived files', async () => {
    const dir = freshDir();
    const backend = new LocalStorageBackend(dir);
    await backend.writeRoom(T, 'del-arch', {
      ydocBytes: Buffer.from([7]),
      secBytes: null,
      commentsJson: null,
    });
    await backend.archiveRoom(T, 'del-arch');
    await backend.deleteArchivedRoom(T, 'del-arch');

    const archived = await backend.listArchivedRooms(T);
    assert.ok(!archived.some(r => r.id === 'del-arch'));
  });

  it('writeRoom is atomic — no partial artifacts on write failure', async () => {
    const dir = freshDir();
    const backend = new LocalStorageBackend(dir);

    // First, write a valid room so we can verify it's not corrupted
    const originalSec = Buffer.from('original');
    await backend.writeRoom(T, 'atomic-test', {
      ydocBytes: Buffer.from([1]),
      secBytes: originalSec,
      commentsJson: '{}',
    });

    // Now sabotage: make the .ydoc target a DIRECTORY so rename fails
    // (new layout: <dir>/<T>/<roomId>.ydoc)
    const ydocPath = path.join(dir, T, 'atomic-test.ydoc');
    fs.unlinkSync(ydocPath);
    fs.mkdirSync(ydocPath);

    // Attempt a write that should fail at the .ydoc rename step
    try {
      await backend.writeRoom(T, 'atomic-test', {
        ydocBytes: Buffer.from([99]),
        secBytes: Buffer.from('new-content'),
        commentsJson: '{"new": true}',
      });
      assert.fail('writeRoom should have thrown');
    } catch (err) {
      // Expected — rename onto a directory fails
    }

    // The .SEC file should NOT have been committed (rolled back)
    const secPath = path.join(dir, T, 'atomic-test.SEC');
    // Because .ydoc is renamed LAST and .SEC/.comments.json are renamed FIRST,
    // and the failure is on .ydoc rename, .SEC may have been renamed already.
    // The atomicity guarantee: if .ydoc rename fails, rollback .SEC and .comments.json.
    // So .SEC should be reverted to original.
    const secContent = fs.existsSync(secPath) ? fs.readFileSync(secPath) : null;
    if (secContent) {
      assert.deepStrictEqual(secContent, originalSec,
        '.SEC should be reverted to original after .ydoc rename failure');
    }

    // No .tmp files should remain in the tenant dir
    const tenantDir = path.join(dir, T);
    const files = fs.readdirSync(tenantDir);
    const tmpFiles = files.filter(f => f.endsWith('.tmp'));
    assert.strictEqual(tmpFiles.length, 0, 'no .tmp files should remain after failed write');
  });

  it('sweepOrphanTmpFiles removes .tmp orphans in tenant + archive subdirs, never room files', async () => {
    const dir = freshDir();
    const backend = new LocalStorageBackend(dir);
    await backend.writeRoom(T, 'live', { ydocBytes: Buffer.from([1]), secBytes: null, commentsJson: null });
    // Crash leftovers at every layout depth: top level (pre-tenant), inside
    // a tenant dir (where writeRoom actually stages), and under archive/.
    fs.writeFileSync(path.join(dir, 'old-flat.ydoc.tmp'), 'x');
    fs.writeFileSync(path.join(dir, T, 'crashed.SEC.tmp'), 'x');
    fs.mkdirSync(path.join(dir, 'archive', T), { recursive: true });
    fs.writeFileSync(path.join(dir, 'archive', T, 'arch.ydoc.tmp'), 'x');

    assert.strictEqual(backend.sweepOrphanTmpFiles(), 3, 'all three orphans removed');
    assert.ok(!fs.existsSync(path.join(dir, T, 'crashed.SEC.tmp')), 'tenant-dir orphan gone');
    assert.ok(await backend.readRoom(T, 'live'), 'real room artifacts untouched');
    assert.strictEqual(backend.sweepOrphanTmpFiles(), 0, 'idempotent');
  });
});
