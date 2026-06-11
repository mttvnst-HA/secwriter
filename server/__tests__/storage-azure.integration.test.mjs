/**
 * Integration tests for AzureStorageBackend against the real @azure/storage-blob
 * SDK. The unit suite in storage-azure.test.mjs uses an in-memory mock of
 * ContainerClient — useful, but it can't verify:
 *
 *   - Real RestError shape on 404 (statusCode + code: 'BlobNotFound')
 *   - Blob lease contention (412 PreconditionFailed when another client holds
 *     the lease)
 *   - listBlobsFlat async iteration across real network responses
 *   - Archive → restore round-trips against a live endpoint
 *   - Managed Identity client construction (DefaultAzureCredential path)
 *
 * Gated behind AZURE_STORAGE_CONNECTION_STRING so the suite is a no-op when
 * the Azurite emulator isn't available. CI provisions Azurite as a sidecar.
 *
 * Local run:
 *   docker run --rm -p 10000:10000 mcr.microsoft.com/azure-storage/azurite \
 *     azurite-blob --blobHost 0.0.0.0
 *   AZURE_STORAGE_CONNECTION_STRING="UseDevelopmentStorage=true" \
 *     npm run test:azure:integration
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';

const require = createRequire(import.meta.url);
const { AzureStorageBackend } = require('../storage-azure.cjs');

const T = 'acme'; // tenant for all integration tests

const CONN =
  process.env.AZURE_STORAGE_CONNECTION_STRING ||
  process.env.SIM_AZURE_STORAGE_CONNECTION_STRING;

const skip = !CONN;
const skipReason =
  'AZURE_STORAGE_CONNECTION_STRING not set — skipping Azurite integration tests';

let BlobServiceClient;
if (!skip) {
  ({ BlobServiceClient } = require('@azure/storage-blob'));
}

/** Create a unique container for an isolated test, return a cleanup fn. */
async function createScopedContainer() {
  const containerName = `sim-it-${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  const serviceClient = BlobServiceClient.fromConnectionString(CONN);
  const container = serviceClient.getContainerClient(containerName);
  await container.create();
  return {
    container,
    cleanup: async () => {
      try { await container.deleteIfExists(); } catch { /* best effort */ }
    },
  };
}

describe('AzureStorageBackend (integration — real @azure/storage-blob SDK)', { skip: skip ? skipReason : false }, () => {
  let container;
  let cleanup;
  let backend;

  beforeEach(async () => {
    // Surface the real error — node:test's hook wrapper reports only
    // "failed running beforeEach hook" in TAP output, which hides the
    // underlying Azure SDK error (statusCode, code, response body).
    try {
      ({ container, cleanup } = await createScopedContainer());
      backend = new AzureStorageBackend({ containerClient: container });
      await backend._initPromise;
    } catch (err) {
      console.error('[beforeEach] setup failed:', {
        message: err.message,
        statusCode: err.statusCode,
        code: err.code,
        details: err.details,
        responseBody: err.response?.bodyAsText || err.response?.parsedBody,
      });
      throw err;
    }
  });

  afterEach(async () => {
    await cleanup();
  });

  /* ── 404 / missing-blob shape ────────────────────────────────────────── */

  it('readRoom returns null when .ydoc does not exist (real RestError 404)', async () => {
    const result = await backend.readRoom(T, 'no-such-room');
    assert.strictEqual(result, null);
  });

  it('statRoom returns null for missing .ydoc (real RestError 404)', async () => {
    const result = await backend.statRoom(T, 'ghost-room');
    assert.strictEqual(result, null);
  });

  it('readRoom tolerates missing sidecars (ydoc exists, sec/comments do not)', async () => {
    await backend.writeRoom(T, 'partial-room', {
      ydocBytes: Buffer.from([0x01, 0x02]),
      secBytes: null,
      commentsJson: null,
    });

    const result = await backend.readRoom(T, 'partial-room');
    assert.ok(result, 'readRoom should succeed');
    assert.deepStrictEqual(result.ydocBytes, Buffer.from([0x01, 0x02]));
    assert.strictEqual(result.secBytes, null);
    assert.strictEqual(result.commentsJson, null);
  });

  it('raw SDK 404 surfaces with statusCode=404 (and code=BlobNotFound on real Azure)', async () => {
    // Sanity check: confirms the backend's `err.statusCode === 404` guard
    // matches the real SDK's error shape (not just our in-memory mock).
    // We don't `instanceof RestError` because whether RestError is
    // re-exported from @azure/storage-blob varies by version.
    //
    // err.code is populated from the x-ms-error-code response header.
    // Real Azure Storage sends 'BlobNotFound'; Azurite does not always
    // populate this header on 404s. The backend only depends on
    // statusCode, so statusCode is the hard assertion; err.code is
    // verified only when present.
    const missing = container.getBlockBlobClient(`${T}/does-not-exist/room.ydoc`);
    await assert.rejects(
      missing.downloadToBuffer(),
      (err) => {
        assert.strictEqual(err.statusCode, 404, 'statusCode 404 is what storage-azure.cjs checks');
        if (err.code !== undefined) {
          assert.strictEqual(err.code, 'BlobNotFound');
        }
        return true;
      },
    );
  });

  /* ── Round-trip (sanity check against real service) ──────────────────── */

  it('writeRoom + readRoom round-trips all three artifacts', async () => {
    const ydocBytes = Buffer.from([0xDE, 0xAD, 0xBE, 0xEF]);
    const secBytes = Buffer.from('<?xml version="1.0"?><SEC/>', 'utf-8');
    const commentsJson = JSON.stringify({ c1: { text: 'integration' } });

    await backend.writeRoom(T, 'rt-room', { ydocBytes, secBytes, commentsJson });
    const result = await backend.readRoom(T, 'rt-room');

    assert.ok(result);
    assert.deepStrictEqual(result.ydocBytes, ydocBytes);
    assert.deepStrictEqual(result.secBytes, secBytes);
    assert.strictEqual(result.commentsJson, commentsJson);
  });

  /* ── Blob lease contention ───────────────────────────────────────────── */

  it('blob lease contention: writeRoom against an externally-leased .ydoc rejects with 412', async () => {
    // Seed initial ydoc so a lease can be acquired against it.
    await backend.writeRoom(T, 'lease-room', {
      ydocBytes: Buffer.from('v1', 'utf-8'),
      secBytes: null,
      commentsJson: null,
    });

    // External party (simulates another server instance) acquires a lease.
    const ydocBlob = container.getBlockBlobClient(`${T}/lease-room/room.ydoc`);
    const externalLease = ydocBlob.getBlobLeaseClient();
    await externalLease.acquireLease(30);

    try {
      // Backend's own acquireLease should fail (caught silently), then the
      // unconditional ydoc upload should 412 because another lease is active.
      await assert.rejects(
        backend.writeRoom(T, 'lease-room', {
          ydocBytes: Buffer.from('v2', 'utf-8'),
          secBytes: null,
          commentsJson: null,
        }),
        (err) => err.statusCode === 412,
      );
    } finally {
      // Release under the held leaseId so the breakLease isn't needed.
      await externalLease.releaseLease();
    }

    // Source of truth (.ydoc) still reads as v1 — the failed write did NOT
    // leave partial state ahead of the .ydoc.
    const result = await backend.readRoom(T, 'lease-room');
    assert.deepStrictEqual(result.ydocBytes, Buffer.from('v1', 'utf-8'));
  });

  it('blob lease contention: sequential writes release the lease cleanly', async () => {
    // Two back-to-back writes should both succeed — the first releases its
    // lease in the finally block before the second acquires one.
    await backend.writeRoom(T, 'seq-room', {
      ydocBytes: Buffer.from('a'),
      secBytes: null,
      commentsJson: null,
    });
    await backend.writeRoom(T, 'seq-room', {
      ydocBytes: Buffer.from('b'),
      secBytes: null,
      commentsJson: null,
    });
    const result = await backend.readRoom(T, 'seq-room');
    assert.deepStrictEqual(result.ydocBytes, Buffer.from('b'));
  });

  /* ── listBlobsFlat pagination ────────────────────────────────────────── */

  it('listRooms enumerates many rooms via the real listBlobsFlat iterator', async () => {
    // Azure's default page size is 5000, so 50 rooms fit in a single page —
    // this doesn't hit a page boundary, but it does exercise the async
    // iterator against real SDK responses (not just our mock) and catches
    // regressions like dropped items or premature iterator termination.
    const count = 50;
    const expected = [];
    for (let i = 0; i < count; i++) {
      const id = `page-${String(i).padStart(3, '0')}`;
      expected.push(id);
      await backend.writeRoom(T, id, {
        ydocBytes: Buffer.from([i & 0xff]),
        secBytes: null,
        commentsJson: null,
      });
    }

    const rooms = await backend.listRooms(T);
    rooms.sort();
    expected.sort();
    assert.deepStrictEqual(rooms, expected);
  });

  it('listRooms excludes archive/ prefix entries', async () => {
    await backend.writeRoom(T, 'live-a', {
      ydocBytes: Buffer.from([1]),
      secBytes: null,
      commentsJson: null,
    });
    await backend.writeRoom(T, 'live-b', {
      ydocBytes: Buffer.from([2]),
      secBytes: null,
      commentsJson: null,
    });
    await backend.archiveRoom(T, 'live-b');

    const live = await backend.listRooms(T);
    assert.ok(live.includes('live-a'));
    assert.ok(!live.includes('live-b'), 'archived room should not appear in listRooms');

    const archived = await backend.listArchivedRooms(T);
    assert.strictEqual(archived.length, 1);
    assert.strictEqual(archived[0].id, 'live-b');
    assert.ok(archived[0].archivedAt, 'archivedAt metadata round-trips through real SDK');
  });

  /* ── Archive → restore round-trips ───────────────────────────────────── */

  it('archiveRoom → restoreRoom preserves content end-to-end', async () => {
    const ydocBytes = Buffer.from([0x11, 0x22, 0x33]);
    const secBytes = Buffer.from('real-sec-content', 'utf-8');
    const commentsJson = JSON.stringify({ hello: 'archive' });

    await backend.writeRoom(T, 'ar-room', { ydocBytes, secBytes, commentsJson });
    await backend.archiveRoom(T, 'ar-room');

    // After archive, listRooms excludes it, readRoom returns null.
    assert.strictEqual(await backend.readRoom(T, 'ar-room'), null);

    const archived = await backend.listArchivedRooms(T);
    assert.ok(archived.some((r) => r.id === 'ar-room'));

    await backend.restoreRoom(T, 'ar-room');

    const result = await backend.readRoom(T, 'ar-room');
    assert.ok(result, 'room restored');
    assert.deepStrictEqual(result.ydocBytes, ydocBytes);
    assert.deepStrictEqual(result.secBytes, secBytes);
    assert.strictEqual(result.commentsJson, commentsJson);

    // Archive blobs are cleaned up after restore.
    const stillArchived = await backend.listArchivedRooms(T);
    assert.ok(!stillArchived.some((r) => r.id === 'ar-room'));
  });

  it('deleteArchivedRoom permanently removes archive blobs', async () => {
    await backend.writeRoom(T, 'del-room', {
      ydocBytes: Buffer.from([5]),
      secBytes: Buffer.from('s'),
      commentsJson: '{}',
    });
    await backend.archiveRoom(T, 'del-room');
    await backend.deleteArchivedRoom(T, 'del-room');

    const archived = await backend.listArchivedRooms(T);
    assert.ok(!archived.some((r) => r.id === 'del-room'));

    // Direct blob check — deletions are durable.
    const ydocBlob = container.getBlockBlobClient(`archive/${T}/del-room/room.ydoc`);
    assert.strictEqual(await ydocBlob.exists(), false);
  });

  /* ── quarantineRoom ──────────────────────────────────────────────────── */

  it('quarantineRoom copies artifacts to suffixed names and removes originals', async () => {
    await backend.writeRoom(T, 'sick-room', {
      ydocBytes: Buffer.from([0xAB]),
      secBytes: Buffer.from('bad'),
      commentsJson: '{"x":1}',
    });

    await backend.quarantineRoom(T, 'sick-room', 'corrupt');

    // Originals gone.
    assert.strictEqual(await backend.readRoom(T, 'sick-room'), null);
    const origYdoc = container.getBlockBlobClient(`${T}/sick-room/room.ydoc`);
    assert.strictEqual(await origYdoc.exists(), false);

    // Quarantined copies exist with .corrupt.<ts> suffix.
    let quarantinedCount = 0;
    for await (const item of container.listBlobsFlat({ prefix: `${T}/sick-room/` })) {
      if (item.name.includes('.corrupt.')) quarantinedCount++;
    }
    assert.strictEqual(quarantinedCount, 3, 'all three artifacts quarantined');
  });
});

/* ── Managed Identity (DefaultAzureCredential) ─────────────────────────── */

const MI_URL = process.env.SIM_AZURE_STORAGE_ACCOUNT_URL;
const miSkip = !MI_URL;
const miSkipReason =
  'SIM_AZURE_STORAGE_ACCOUNT_URL not set — skipping Managed Identity integration test';

describe('AzureStorageBackend (integration — Managed Identity)', { skip: miSkip ? miSkipReason : false }, () => {
  it('constructs via DefaultAzureCredential and round-trips a room', async () => {
    const { BlobServiceClient: BSC } = require('@azure/storage-blob');
    const { DefaultAzureCredential } = require('@azure/identity');
    const serviceClient = new BSC(MI_URL, new DefaultAzureCredential());

    const containerName = `sim-mi-${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const container = serviceClient.getContainerClient(containerName);
    await container.create();

    try {
      const backend = new AzureStorageBackend({ containerClient: container });
      await backend._initPromise;

      await backend.writeRoom(T, 'mi-room', {
        ydocBytes: Buffer.from([1, 2, 3]),
        secBytes: null,
        commentsJson: null,
      });
      const result = await backend.readRoom(T, 'mi-room');
      assert.deepStrictEqual(result.ydocBytes, Buffer.from([1, 2, 3]));
    } finally {
      await container.deleteIfExists();
    }
  });
});
