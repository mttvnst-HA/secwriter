/**
 * Cross-backend storage contract tests.
 *
 * Asserts that all three RoomStorageBase subclasses obey the same shared
 * contract (write/read round-trip, ydoc-last ordering, archive/restore
 * lifecycle, listArchivedRooms { id, archivedAt } shape, etc.) so adding a
 * fourth backend doesn't slip past the per-backend mocks.
 *
 * Per-backend tests still cover SDK-specific quirks (lease, pagination,
 * historical S3 quarantine layout, etc.); this file is the shared minimum.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { mockClient } from 'aws-sdk-client-mock';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  CopyObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';

const require = createRequire(import.meta.url);
const { LocalStorageBackend } = require('../storage-local.cjs');
const { AzureStorageBackend } = require('../storage-azure.cjs');
const { S3StorageBackend } = require('../storage-s3.cjs');
require('../dom-polyfill.cjs');
const Y = require('yjs');
const {
  needsMigration,
  migrateRoom,
  createMigrationCoordinator,
  SCHEMA_VERSION_KEY,
  SCHEMA_V2,
  MIGRATION_PARTIAL_KEY,
} = require('../migrate-pm-substrate.cjs');

/* ── Backend factories ─────────────────────────────────────────────────── */

function localFactory() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sim-contract-'));
  return {
    backend: new LocalStorageBackend(dir),
    cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ } },
  };
}

function azureFactory() {
  const blobs = new Map();
  const container = {
    async createIfNotExists() {},
    getBlockBlobClient(blobName) {
      return {
        async upload(content, byteLength, options) {
          const buf = Buffer.isBuffer(content) ? content : Buffer.from(content);
          blobs.set(blobName, { content: buf, metadata: (options && options.metadata) || {} });
        },
        async downloadToBuffer() {
          const e = blobs.get(blobName);
          if (!e) { const err = new Error('404'); err.statusCode = 404; throw err; }
          return Buffer.from(e.content);
        },
        async getProperties() {
          const e = blobs.get(blobName);
          if (!e) { const err = new Error('404'); err.statusCode = 404; throw err; }
          return { lastModified: new Date(), contentLength: e.content.length, metadata: e.metadata };
        },
        async deleteIfExists() { blobs.delete(blobName); },
        async exists() { return blobs.has(blobName); },
        getBlobLeaseClient: () => ({
          async acquireLease() { return { leaseId: 'lease' }; },
          async releaseLease() {},
        }),
      };
    },
    listBlobsFlat(opts) {
      const prefix = (opts && opts.prefix) || '';
      const matches = [];
      for (const k of blobs.keys()) {
        if (k.startsWith(prefix)) matches.push({ name: k });
      }
      return { async *[Symbol.asyncIterator]() { for (const m of matches) yield m; } };
    },
  };
  return {
    backend: new AzureStorageBackend({ containerClient: container }),
    cleanup: () => { blobs.clear(); },
  };
}

function s3Factory() {
  const objects = new Map();
  const objectMeta = new Map();
  const s3Mock = mockClient(S3Client);
  s3Mock.reset();

  s3Mock.on(PutObjectCommand).callsFake(async (input) => {
    const buf = Buffer.isBuffer(input.Body) ? input.Body
      : input.Body instanceof Uint8Array ? Buffer.from(input.Body)
      : Buffer.from(input.Body);
    objects.set(input.Key, buf);
    if (input.Metadata) objectMeta.set(input.Key, input.Metadata);
    return {};
  });
  s3Mock.on(GetObjectCommand).callsFake(async (input) => {
    if (!objects.has(input.Key)) {
      const err = new Error('NoSuchKey'); err.name = 'NoSuchKey'; throw err;
    }
    const body = objects.get(input.Key);
    return { Body: { transformToByteArray: async () => new Uint8Array(body) } };
  });
  s3Mock.on(DeleteObjectCommand).callsFake(async (input) => {
    objects.delete(input.Key);
    objectMeta.delete(input.Key);
    return {};
  });
  s3Mock.on(ListObjectsV2Command).callsFake(async (input) => {
    const prefix = input.Prefix || '';
    return {
      Contents: [...objects.keys()]
        .filter(k => k.startsWith(prefix))
        .map(Key => ({ Key })),
    };
  });
  s3Mock.on(CopyObjectCommand).callsFake(async (input) => {
    const src = String(input.CopySource).split('/').slice(1).join('/');
    if (!objects.has(src)) {
      const err = new Error('NoSuchKey'); err.name = 'NoSuchKey'; throw err;
    }
    objects.set(input.Key, Buffer.from(objects.get(src)));
    if (input.Metadata) objectMeta.set(input.Key, input.Metadata);
    return {};
  });
  s3Mock.on(HeadObjectCommand).callsFake(async (input) => {
    if (!objects.has(input.Key)) {
      const err = new Error('NotFound'); err.name = 'NotFound'; err.$metadata = { httpStatusCode: 404 }; throw err;
    }
    return {
      LastModified: new Date(),
      ContentLength: objects.get(input.Key).length,
      Metadata: objectMeta.get(input.Key) || {},
    };
  });

  return {
    backend: new S3StorageBackend({ client: new S3Client({ region: 'auto' }), bucket: 'test' }),
    cleanup: () => { s3Mock.reset(); objects.clear(); objectMeta.clear(); },
  };
}

const BACKENDS = [
  { name: 'Local', factory: localFactory },
  { name: 'Azure', factory: azureFactory },
  { name: 'S3', factory: s3Factory },
];

/* ── Shared contract assertions ─────────────────────────────────────────── */

for (const { name, factory } of BACKENDS) {
  describe(`Storage contract: ${name}`, () => {
    let backend, cleanup;
    const T = 'acme'; // tenant for all contract assertions
    beforeEach(() => { ({ backend, cleanup } = factory()); });
    afterEach(() => { cleanup(); });

    it('writeRoom + readRoom round-trips all three artifacts', async () => {
      const ydocBytes = Buffer.from([0x10, 0x20, 0x30]);
      const secBytes = Buffer.from('<?xml version="1.0"?><SEC/>', 'utf-8');
      const commentsJson = JSON.stringify({ c1: { text: 'hi' } });

      await backend.writeRoom(T, 'demo', { ydocBytes, secBytes, commentsJson });
      const r = await backend.readRoom(T, 'demo');

      assert.ok(r);
      assert.deepStrictEqual(Buffer.from(r.ydocBytes), ydocBytes);
      assert.deepStrictEqual(Buffer.from(r.secBytes), secBytes);
      assert.strictEqual(r.commentsJson, commentsJson);
    });

    it('readRoom returns null for a nonexistent room', async () => {
      assert.strictEqual(await backend.readRoom(T, 'no-such'), null);
    });

    it('writeRoom with only ydocBytes works (sidecars optional)', async () => {
      await backend.writeRoom(T, 'minimal', {
        ydocBytes: Buffer.from([0x42]),
        secBytes: null,
        commentsJson: null,
      });
      const r = await backend.readRoom(T, 'minimal');
      assert.ok(r);
      assert.deepStrictEqual(Buffer.from(r.ydocBytes), Buffer.from([0x42]));
      assert.strictEqual(r.secBytes, null);
      assert.strictEqual(r.commentsJson, null);
    });

    it('deleteRoom removes all artifacts', async () => {
      await backend.writeRoom(T, 'rm', {
        ydocBytes: Buffer.from([1]),
        secBytes: Buffer.from([2]),
        commentsJson: '{}',
      });
      await backend.deleteRoom(T, 'rm');
      assert.strictEqual(await backend.readRoom(T, 'rm'), null);
    });

    it('listRooms returns written room ids', async () => {
      await backend.writeRoom(T, 'alpha', { ydocBytes: Buffer.from([1]), secBytes: null, commentsJson: null });
      await backend.writeRoom(T, 'bravo', { ydocBytes: Buffer.from([2]), secBytes: null, commentsJson: null });
      const rooms = (await backend.listRooms(T)).sort();
      assert.deepStrictEqual(rooms, ['alpha', 'bravo']);
    });

    it('statRoom returns null for unknown, object for existing', async () => {
      assert.strictEqual(await backend.statRoom(T, 'ghost'), null);
      await backend.writeRoom(T, 's1', { ydocBytes: Buffer.from([1]), secBytes: null, commentsJson: null });
      const stat = await backend.statRoom(T, 's1');
      assert.ok(stat);
      assert.ok(stat.lastModified);
    });

    it('archiveRoom + listArchivedRooms returns { id, archivedAt }', async () => {
      await backend.writeRoom(T, 'a1', {
        ydocBytes: Buffer.from([1]),
        secBytes: Buffer.from('s'),
        commentsJson: '{}',
      });
      await backend.archiveRoom(T, 'a1');

      assert.strictEqual(await backend.readRoom(T, 'a1'), null);
      assert.deepStrictEqual(await backend.listRooms(T), []);

      const archived = await backend.listArchivedRooms(T);
      assert.strictEqual(archived.length, 1);
      assert.strictEqual(archived[0].id, 'a1');
      assert.ok(archived[0].archivedAt, 'archivedAt should be set');
      // Must parse to a real Date (collab-server sweep does this)
      assert.ok(!Number.isNaN(new Date(archived[0].archivedAt).getTime()));
    });

    it('restoreRoom moves an archived room back', async () => {
      await backend.writeRoom(T, 'r1', {
        ydocBytes: Buffer.from([0xCC]),
        secBytes: null,
        commentsJson: null,
      });
      await backend.archiveRoom(T, 'r1');
      await backend.restoreRoom(T, 'r1');
      const r = await backend.readRoom(T, 'r1');
      assert.ok(r);
      assert.deepStrictEqual(Buffer.from(r.ydocBytes), Buffer.from([0xCC]));
      assert.deepStrictEqual(await backend.listArchivedRooms(T), []);
    });

    it('deleteArchivedRoom removes archived artifacts', async () => {
      await backend.writeRoom(T, 'd1', { ydocBytes: Buffer.from([1]), secBytes: null, commentsJson: null });
      await backend.archiveRoom(T, 'd1');
      await backend.deleteArchivedRoom(T, 'd1');
      assert.deepStrictEqual(await backend.listArchivedRooms(T), []);
    });

    it('quarantineRoom removes the room from listRooms', async () => {
      await backend.writeRoom(T, 'q1', { ydocBytes: Buffer.from([1]), secBytes: null, commentsJson: null });
      await backend.quarantineRoom(T, 'q1', 'corrupt');
      const rooms = await backend.listRooms(T);
      assert.ok(!rooms.includes('q1'), 'quarantined room should not appear in listRooms');
    });

    // Task 15 (#140) — v2 lint sidecar (ignoredFindings + mutedNlpRules)
    // round-trips through writeRoom + readRoom unchanged.
    it('lintJson with v2 sidecar round-trips through writeRoom + readRoom', async () => {
      const v2Sidecar = {
        v: 2,
        good: 'aabbcc',
        bad: {},
        ignoredFindings: [
          { ignoreKey: 'k1', ruleId: 'GRAM-X', blockHash: 'bh', match: 'm', ts: 1, authorId: 'u1' },
        ],
        mutedNlpRules: [
          { ruleId: 'NLP-passive', ts: 2, authorId: 'u2', tombstone: true },
        ],
      };
      const lintJson = JSON.stringify(v2Sidecar);
      await backend.writeRoom(T, 'lint-v2', {
        ydocBytes: Buffer.from([0xAB]),
        secBytes: null,
        commentsJson: null,
        lintJson,
      });
      const r = await backend.readRoom(T, 'lint-v2');
      assert.ok(r, 'room should be readable');
      assert.strictEqual(r.lintJson, lintJson, 'v2 lintJson must survive save+load verbatim');
      const parsed = JSON.parse(r.lintJson);
      assert.strictEqual(parsed.v, 2);
      assert.strictEqual(parsed.ignoredFindings.length, 1);
      assert.strictEqual(parsed.mutedNlpRules[0].tombstone, true);
    });

    it('writeRoom is idempotent — second write replaces first', async () => {
      await backend.writeRoom(T, 'idem', {
        ydocBytes: Buffer.from([1]),
        secBytes: Buffer.from('first'),
        commentsJson: '{"v":1}',
      });
      await backend.writeRoom(T, 'idem', {
        ydocBytes: Buffer.from([2]),
        secBytes: Buffer.from('second'),
        commentsJson: '{"v":2}',
      });
      const r = await backend.readRoom(T, 'idem');
      assert.deepStrictEqual(Buffer.from(r.ydocBytes), Buffer.from([2]));
      assert.deepStrictEqual(Buffer.from(r.secBytes), Buffer.from('second'));
      assert.strictEqual(r.commentsJson, '{"v":2}');
    });

    it('sanitizes special characters in room ids', async () => {
      // path-traversal / spaces / dots should not bleed into storage
      await backend.writeRoom(T, '../bad name', {
        ydocBytes: Buffer.from([1]),
        secBytes: null,
        commentsJson: null,
      });
      const rooms = await backend.listRooms(T);
      assert.strictEqual(rooms.length, 1);
      assert.ok(!rooms[0].includes('..'));
      assert.ok(!rooms[0].includes(' '));
      assert.ok(!rooms[0].includes('/'));
    });

    it('ACL sidecar round-trips via readAcl/writeAcl and is independent of .ydoc', async () => {
      // writeAcl with NO .ydoc → readRoom is still null (partial create = absent)
      await backend.writeAcl(T, 'r-acl', { ownerId: 'u1', sharedWith: ['u2'] });
      assert.equal(await backend.readRoom(T, 'r-acl'), null, 'no .ydoc → room absent (404 semantics)');
      assert.deepEqual(await backend.readAcl(T, 'r-acl'), { ownerId: 'u1', sharedWith: ['u2'] });

      // missing ACL → null
      assert.equal(await backend.readAcl(T, 'no-such'), null);

      // full create: acl THEN ydoc; both readable; deleteRoom removes both
      const doc = new Y.Doc();
      const ydocBytes = Buffer.from(Y.encodeStateAsUpdate(doc));
      doc.destroy();
      await backend.writeRoom(T, 'r-full', { ydocBytes, secBytes: null, commentsJson: null });
      await backend.writeAcl(T, 'r-full', { ownerId: 'owner', sharedWith: [] });
      assert.ok(await backend.readRoom(T, 'r-full'));
      assert.deepEqual(await backend.readAcl(T, 'r-full'), { ownerId: 'owner', sharedWith: [] });
      await backend.deleteRoom(T, 'r-full');
      assert.equal(await backend.readAcl(T, 'r-full'), null, 'deleteRoom removes the ACL sidecar');
    });

    it('rooms are isolated per tenant — listRooms + readRoom never cross tenants', async () => {
      const doc = new Y.Doc();
      const ydocBytes = Buffer.from(Y.encodeStateAsUpdate(doc));
      doc.destroy();
      await backend.writeRoom('acme', 'shared-name', { ydocBytes, secBytes: null, commentsJson: null });
      await backend.writeAcl('acme', 'shared-name', { ownerId: 'a', sharedWith: [] });
      await backend.writeRoom('beta', 'beta-only', { ydocBytes, secBytes: null, commentsJson: null });

      // listRooms is tenant-scoped
      assert.deepEqual(await backend.listRooms('acme'), ['shared-name']);
      assert.deepEqual(await backend.listRooms('beta'), ['beta-only']);

      // a room under acme is invisible under beta (and vice-versa)
      assert.equal(await backend.readRoom('beta', 'shared-name'), null);
      assert.equal(await backend.readAcl('beta', 'shared-name'), null);
      assert.ok(await backend.readRoom('acme', 'shared-name'));

      // cleanup
      await backend.deleteRoom('acme', 'shared-name');
      await backend.deleteRoom('beta', 'beta-only');
    });

    // Sub-PR 1d (#47, ADR-0006). The broker integration tests live here
    // (not in a new file) so they exercise the same backend instances as
    // the rest of the contract. The broker calls storage.archiveRoom
    // before mutating the doc; archive failure must abort migration; the
    // per-room async lock must collapse concurrent calls.

    describe('migration broker — Q22/Q23 contract', () => {
      function buildV1Doc(blockCount = 2) {
        const ydoc = new Y.Doc();
        const yOrder = ydoc.getArray('order');
        const yStore = ydoc.getMap('store');
        ydoc.transact(() => {
          for (let i = 1; i <= blockCount; i++) {
            const id = `n${i}`;
            const yMap = new Y.Map();
            yMap.set('id', id);
            yMap.set('type', 'txt');
            const yText = new Y.Text();
            yText.insert(0, `Block ${i} content`);
            yMap.set('html', yText);
            yStore.set(id, yMap);
            yOrder.push([id]);
          }
        }, 'seed');
        return ydoc;
      }

      it('archive-then-migrate happy path: archive lands in archived set, doc bumps to v2', async () => {
        // Pre-seed the room so archiveRoom has something to copy.
        await backend.writeRoom(T, 'mig-happy', {
          ydocBytes: Buffer.from([1, 2, 3]),
          secBytes: Buffer.from('seed'),
          commentsJson: null,
        });

        const coord = createMigrationCoordinator({ storage: backend });
        const ydoc = buildV1Doc(2);
        // ensureMigrated takes a composite docName so splitCompositeDocName
        // extracts the right tenant; pass `T/roomId`.
        const result = await coord.ensureMigrated(`${T}/mig-happy`, ydoc);

        assert.strictEqual(result.archived, true);
        assert.strictEqual(result.schemaVersion, SCHEMA_V2);
        assert.strictEqual(result.migrationPartial, false);

        // The active room is gone (archive deletes the source per
        // RoomStorageBase.archiveRoom).
        assert.strictEqual(await backend.readRoom(T, 'mig-happy'), null);

        // The archive set has the room with an archivedAt.
        const archived = await backend.listArchivedRooms(T);
        const found = archived.find(r => r.id === 'mig-happy');
        assert.ok(found, 'migrated room should appear in archive set');
        assert.ok(found.archivedAt);

        // Doc state stamped v2.
        assert.strictEqual(ydoc.getMap('meta').get(SCHEMA_VERSION_KEY), SCHEMA_V2);
      });

      it('archive failure aborts migration: doc stays v1, no schemaVersion stamp', async () => {
        // Wrap archiveRoom to throw without mutating storage.
        const failingStorage = Object.create(backend);
        failingStorage.archiveRoom = async () => { throw new Error('storage offline'); };

        const coord = createMigrationCoordinator({ storage: failingStorage });
        const ydoc = buildV1Doc(2);
        const beforeBytes = Y.encodeStateAsUpdate(ydoc);
        const result = await coord.ensureMigrated(`${T}/mig-archive-fail`, ydoc);

        assert.strictEqual(result.skipped, true);
        assert.strictEqual(result.archived, false);
        // Doc is byte-identical — migration did NOT touch yMaps.
        const afterBytes = Y.encodeStateAsUpdate(ydoc);
        assert.deepStrictEqual(Buffer.from(beforeBytes), Buffer.from(afterBytes));
        assert.strictEqual(ydoc.getMap('meta').get(SCHEMA_VERSION_KEY), undefined);
        assert.strictEqual(ydoc.getMap('meta').get(MIGRATION_PARTIAL_KEY), undefined);

        // needsMigration still true — operator can retry once storage is
        // back online (subsequent connect re-attempts; createMigrationCoordinator's
        // promise cache resolved skipped:true but a fresh coordinator
        // invocation per WS upgrade re-evaluates).
        assert.strictEqual(needsMigration(ydoc), true);
      });

      it('partial migration sets migrationPartial sentinel, NOT schemaVersion (mutual exclusion)', async () => {
        // Pre-seed so archive succeeds.
        await backend.writeRoom(T, 'mig-partial', {
          ydocBytes: Buffer.from([1]),
          secBytes: null,
          commentsJson: null,
        });

        const ydoc = buildV1Doc(3);
        const yStore = ydoc.getMap('store');
        const badSlot = yStore.get('n2').get('html');
        const orig = badSlot.toDelta.bind(badSlot);
        badSlot.toDelta = () => { throw new Error('synthetic per-block fault'); };

        const coord = createMigrationCoordinator({ storage: backend });
        const result = await coord.ensureMigrated(`${T}/mig-partial`, ydoc);
        badSlot.toDelta = orig;

        assert.strictEqual(result.archived, true);
        assert.strictEqual(result.migrationPartial, true);
        assert.strictEqual(result.schemaVersion, null);

        const yMeta = ydoc.getMap('meta');
        assert.strictEqual(yMeta.get(MIGRATION_PARTIAL_KEY), true);
        assert.strictEqual(yMeta.get(SCHEMA_VERSION_KEY), undefined,
          'mutual exclusion: schemaVersion must stay absent when migrationPartial=true');
      });

      it('per-room async lock: two concurrent ensureMigrated calls collapse to one archive', async () => {
        // Pre-seed so archive has source bytes.
        await backend.writeRoom(T, 'mig-lock', {
          ydocBytes: Buffer.from([1, 2, 3]),
          secBytes: null,
          commentsJson: null,
        });

        // Wrap archiveRoom with a counter + tiny delay to widen the race
        // window deterministically.
        let archiveCount = 0;
        const lockingStorage = Object.create(backend);
        lockingStorage.archiveRoom = async (tenant, roomId) => {
          archiveCount++;
          await new Promise(r => setTimeout(r, 30));
          return backend.archiveRoom(tenant, roomId);
        };

        const coord = createMigrationCoordinator({ storage: lockingStorage });
        const ydoc = buildV1Doc(2);
        const [r1, r2] = await Promise.all([
          coord.ensureMigrated(`${T}/mig-lock`, ydoc),
          coord.ensureMigrated(`${T}/mig-lock`, ydoc),
        ]);

        // Per-room lock — both callers see the same migration result.
        assert.strictEqual(r1, r2);
        assert.strictEqual(r1.schemaVersion, SCHEMA_V2);
        // Crucially, archive was called exactly once.
        assert.strictEqual(archiveCount, 1,
          `Expected the per-room lock to collapse onto one migration; archive was called ${archiveCount}× instead.`);
      });
    });
  });
}
