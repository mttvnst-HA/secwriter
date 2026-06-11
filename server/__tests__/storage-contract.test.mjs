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
          // Honor conditional create (ifNoneMatch: '*') like real Azure:
          // 409 BlobAlreadyExists when the blob exists.
          if (options?.conditions?.ifNoneMatch === '*' && blobs.has(blobName)) {
            const err = new Error('BlobAlreadyExists'); err.statusCode = 409; throw err;
          }
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
    // Honor conditional create (IfNoneMatch: '*') like real S3/R2/MinIO:
    // 412 PreconditionFailed when the key exists.
    if (input.IfNoneMatch === '*' && objects.has(input.Key)) {
      const err = new Error('PreconditionFailed');
      err.name = 'PreconditionFailed';
      err.$metadata = { httpStatusCode: 412 };
      throw err;
    }
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

    it('quarantineRoom removes the room from listRooms but PRESERVES the ACL', async () => {
      await backend.writeRoom(T, 'q1', { ydocBytes: Buffer.from([1]), secBytes: null, commentsJson: null });
      await backend.writeAcl(T, 'q1', { ownerId: 'owner', sharedWith: [] });
      await backend.quarantineRoom(T, 'q1', 'corrupt');
      const rooms = await backend.listRooms(T);
      assert.ok(!rooms.includes('q1'), 'quarantined room should not appear in listRooms');
      // The ACL must stay active: quarantine fires from bindState while the
      // triggering WS session stays connected to a fresh doc, and its next
      // flush rewrites .ydoc but never the ACL — moving the ACL aside would
      // leave that flushed room ownerless (authorize 404s for everyone,
      // DELETE 404s before orphan recovery, POST /rooms 409s: bricked).
      assert.deepEqual(await backend.readAcl(T, 'q1'), { ownerId: 'owner', sharedWith: [] },
        'quarantine must not move the .acl sidecar');
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

      // writeAclIfAbsent is an atomic claim: first writer wins, second
      // returns false WITHOUT touching the winner's ACL. This is the
      // POST /rooms ownership-claim — without it two concurrent creates
      // both 201 and the last writeAcl silently transfers ownership.
      assert.equal(await backend.writeAclIfAbsent(T, 'r-claim', { ownerId: 'first', sharedWith: [] }), true,
        'first claim must succeed');
      assert.equal(await backend.writeAclIfAbsent(T, 'r-claim', { ownerId: 'second', sharedWith: [] }), false,
        'second claim must lose');
      assert.deepEqual(await backend.readAcl(T, 'r-claim'), { ownerId: 'first', sharedWith: [] },
        'the losing claim must not overwrite the winner');

      // full create: acl THEN ydoc; both readable; deleteRoom removes both
      const doc = new Y.Doc();
      const ydocBytes = Buffer.from(Y.encodeStateAsUpdate(doc));
      doc.destroy();
      await backend.writeRoom(T, 'r-full', { ydocBytes, secBytes: Buffer.from('sec'), commentsJson: '{}' });
      await backend.writeAcl(T, 'r-full', { ownerId: 'owner', sharedWith: [] });
      assert.ok(await backend.readRoom(T, 'r-full'));
      assert.deepEqual(await backend.readAcl(T, 'r-full'), { ownerId: 'owner', sharedWith: [] });

      // Crash-order invariant, two halves:
      //   - sidecars (.SEC/.comments) BEFORE .ydoc — while any stale sidecar
      //     exists the .ydoc does too, so the create route 409s; a crash
      //     mid-delete can never let a re-created room serve the previous
      //     owner's .SEC/.comments (writeRoom skips null sidecars).
      //   - .ydoc BEFORE .acl — a crash between them leaves an orphan ACL
      //     (room absent → 404, reclaimable), never a ydoc with no ACL (an
      //     ownerless, undeletable room). Spy on the primitive to pin order.
      const secKey = backend._keyForArtifact(T, 'r-full', 'sec');
      const commentsKey = backend._keyForArtifact(T, 'r-full', 'comments');
      const ydocKey = backend._keyForArtifact(T, 'r-full', 'ydoc');
      const aclKey = backend._keyForArtifact(T, 'r-full', 'acl');
      const deletedOrder = [];
      const realDeleteKey = backend._deleteKey.bind(backend);
      backend._deleteKey = async (key) => { deletedOrder.push(key); return realDeleteKey(key); };
      await backend.deleteRoom(T, 'r-full');
      backend._deleteKey = realDeleteKey;
      assert.ok(
        deletedOrder.indexOf(secKey) < deletedOrder.indexOf(ydocKey) &&
        deletedOrder.indexOf(commentsKey) < deletedOrder.indexOf(ydocKey),
        '.SEC/.comments sidecars must be deleted before .ydoc (stale-sidecar resurrection guard)',
      );
      assert.ok(
        deletedOrder.indexOf(ydocKey) < deletedOrder.indexOf(aclKey),
        '.ydoc must be deleted before .acl (orphan-ACL, never ownerless-ydoc)',
      );
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

    it('migrateLegacyFlatRooms relocates pre-tenant flat rooms (idempotent, ACL written, acl-before-ydoc order)', async () => {
      // Seed a LEGACY flat room via the adapter's own legacy naming + raw
      // primitive — exactly the keys a pre-tenant deploy left behind.
      const legacyYdoc = backend._legacyFlatKeyForArtifact('legacy1', 'ydoc');
      const legacySec = backend._legacyFlatKeyForArtifact('legacy1', 'sec');
      assert.ok(legacyYdoc, 'backend must declare its legacy flat layout');
      await backend._putBytes(legacyYdoc, Buffer.from([0xAA, 0xBB]));
      await backend._putBytes(legacySec, Buffer.from('SEC-CONTENT'));

      assert.equal(await backend.countLegacyFlatRooms(), 1);
      // Invisible to composite reads before migration — this is the silent
      // data-loss shape: WS preload would serve 'room.new' and overwrite.
      assert.equal(await backend.readRoom(T, 'legacy1'), null);

      // Pin the crash-order: the ACL write must land before the flat .ydoc
      // moves, and the .ydoc must move LAST among the artifacts.
      const ops = [];
      const realWriteAcl = backend.writeAcl.bind(backend);
      const realDeleteKey = backend._deleteKey.bind(backend);
      backend.writeAcl = async (...a) => { ops.push('acl-write'); return realWriteAcl(...a); };
      backend._deleteKey = async (key) => {
        if (key === legacyYdoc) ops.push('ydoc-moved');
        else if (key === legacySec) ops.push('sec-moved');
        return realDeleteKey(key);
      };
      const moved = await backend.migrateLegacyFlatRooms({ tenant: T, owner: 'admin' });
      backend.writeAcl = realWriteAcl;
      backend._deleteKey = realDeleteKey;

      assert.equal(moved, 1);
      assert.ok(ops.indexOf('acl-write') < ops.indexOf('ydoc-moved'),
        `.acl must be written before the flat .ydoc moves (saw ${JSON.stringify(ops)})`);
      assert.ok(ops.indexOf('sec-moved') < ops.indexOf('ydoc-moved'),
        `the flat .ydoc must move LAST (saw ${JSON.stringify(ops)})`);

      // Relocated + readable under the composite key, flat key gone.
      const r = await backend.readRoom(T, 'legacy1');
      assert.ok(r);
      assert.deepStrictEqual(Buffer.from(r.ydocBytes), Buffer.from([0xAA, 0xBB]));
      assert.deepStrictEqual(Buffer.from(r.secBytes), Buffer.from('SEC-CONTENT'));
      assert.deepEqual(await backend.readAcl(T, 'legacy1'), { ownerId: 'admin', sharedWith: [] });
      assert.equal(await backend._statKey(legacyYdoc), null, 'flat .ydoc must be gone');

      // Legacy flat ARCHIVES relocate too. Pre-tenant sweeps archived under
      // un-namespaced archive keys the tenant-scoped parsers never match —
      // unrestorable AND invisible to the DELETE_DAYS sweep (never purged).
      const legacyArchYdoc = backend._legacyFlatArchiveKeyForArtifact('oldarch', 'ydoc');
      assert.ok(legacyArchYdoc, 'backend must declare its legacy flat archive layout');
      await backend._putBytes(legacyArchYdoc, Buffer.from([0xCC]));
      assert.equal(await backend.countLegacyFlatRooms(), 1, 'archived legacy rooms count toward the boot guard');
      assert.equal((await backend.listArchivedRooms(T)).length, 0, 'invisible before migration');

      assert.equal(await backend.migrateLegacyFlatRooms({ tenant: T, owner: 'admin' }), 1);
      const archived = await backend.listArchivedRooms(T);
      assert.equal(archived.length, 1);
      assert.equal(archived[0].id, 'oldarch');
      // archivedAt falls back to the ydoc mtime (no legacy marker seeded) —
      // must be sweep-consumable, i.e. a parseable date, not null.
      assert.ok(archived[0].archivedAt && !Number.isNaN(new Date(archived[0].archivedAt).getTime()),
        `relocated archive needs a parseable archivedAt for the sweep (got ${archived[0].archivedAt})`);
      assert.equal(await backend._statKey(legacyArchYdoc), null, 'flat archive .ydoc must be gone');
      // restoreRoom now reaches it — the legacy archive is no longer stranded.
      await backend.restoreRoom(T, 'oldarch');
      assert.deepStrictEqual(Buffer.from((await backend.readRoom(T, 'oldarch')).ydocBytes), Buffer.from([0xCC]));

      // Idempotent: nothing left to migrate; second run is a no-op.
      assert.equal(await backend.countLegacyFlatRooms(), 0);
      assert.equal(await backend.migrateLegacyFlatRooms({ tenant: T, owner: 'admin' }), 0);
    });

    // Sub-PR 1d (#47, ADR-0006). The broker integration tests live here
    // (not in a new file) so they exercise the same backend instances as
    // the rest of the contract. The broker calls storage.backupRoom (a
    // NON-DESTRUCTIVE snapshot — the active room, including its ACL, stays
    // in place) before mutating the doc; backup failure must abort
    // migration; the per-room async lock must collapse concurrent calls.

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

      it('backup-then-migrate happy path: snapshot lands in archived set, active room + ACL survive, doc bumps to v2', async () => {
        // Pre-seed the room (with an ACL) so backupRoom has something to copy.
        await backend.writeRoom(T, 'mig-happy', {
          ydocBytes: Buffer.from([1, 2, 3]),
          secBytes: Buffer.from('seed'),
          commentsJson: null,
        });
        await backend.writeAcl(T, 'mig-happy', { ownerId: 'owner', sharedWith: [] });

        const coord = createMigrationCoordinator({ storage: backend });
        const ydoc = buildV1Doc(2);
        // ensureMigrated takes a composite docName so splitCompositeDocName
        // extracts the right tenant; pass `T/roomId`.
        const result = await coord.ensureMigrated(`${T}/mig-happy`, ydoc);

        assert.strictEqual(result.archived, true);
        assert.strictEqual(result.schemaVersion, SCHEMA_V2);
        assert.strictEqual(result.migrationPartial, false);

        // The active room SURVIVES — backupRoom is a non-destructive copy.
        // The room keeps being served live after migration; the old
        // archiveRoom move destroyed the active ACL (never rewritten by any
        // flush → authorize 404s for everyone: bricked) and lost the active
        // .ydoc entirely on a crash before the first post-migration flush.
        assert.ok(await backend.readRoom(T, 'mig-happy'),
          'active room must survive the pre-migration backup');
        assert.deepEqual(await backend.readAcl(T, 'mig-happy'), { ownerId: 'owner', sharedWith: [] },
          'active ACL must survive the pre-migration backup');

        // The archive set has the snapshot with an archivedAt.
        const archived = await backend.listArchivedRooms(T);
        const found = archived.find(r => r.id === 'mig-happy');
        assert.ok(found, 'pre-migration snapshot should appear in archive set');
        assert.ok(found.archivedAt);

        // Doc state stamped v2.
        assert.strictEqual(ydoc.getMap('meta').get(SCHEMA_VERSION_KEY), SCHEMA_V2);
      });

      it('backup failure aborts migration: doc stays v1, no schemaVersion stamp', async () => {
        // Wrap backupRoom to throw without mutating storage.
        const failingStorage = Object.create(backend);
        failingStorage.backupRoom = async () => { throw new Error('storage offline'); };

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

        // Wrap backupRoom with a counter + tiny delay to widen the race
        // window deterministically.
        let archiveCount = 0;
        const lockingStorage = Object.create(backend);
        lockingStorage.backupRoom = async (tenant, roomId) => {
          archiveCount++;
          await new Promise(r => setTimeout(r, 30));
          return backend.backupRoom(tenant, roomId);
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
