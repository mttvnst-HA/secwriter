/**
 * Tests for AzureStorageBackend (server/storage-azure.cjs).
 *
 * Uses Node's built-in test runner with an in-memory mock of the Azure SDK.
 * Run via:
 *   node --test server/__tests__/storage-azure.test.mjs
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { AzureStorageBackend } = require('../storage-azure.cjs');

/* ── In-memory mock Azure container client ─────────────────────────────── */

function createMockContainerClient() {
  /** @type {Map<string, { content: Buffer, metadata: Record<string,string> }>} */
  const blobs = new Map();

  function mockBlobClient(blobName) {
    return {
      async upload(content, byteLength, options) {
        const buf = Buffer.isBuffer(content) ? content : Buffer.from(content);
        blobs.set(blobName, {
          content: buf,
          metadata: (options && options.metadata) || {},
        });
      },
      async downloadToBuffer() {
        const entry = blobs.get(blobName);
        if (!entry) {
          const err = new Error(`Blob not found: ${blobName}`);
          err.statusCode = 404;
          throw err;
        }
        return Buffer.from(entry.content);
      },
      async getProperties() {
        const entry = blobs.get(blobName);
        if (!entry) {
          const err = new Error(`Blob not found: ${blobName}`);
          err.statusCode = 404;
          throw err;
        }
        return {
          lastModified: new Date(),
          contentLength: entry.content.length,
          metadata: entry.metadata,
        };
      },
      async deleteIfExists() {
        blobs.delete(blobName);
      },
      async exists() {
        return blobs.has(blobName);
      },
      getBlobLeaseClient() {
        return {
          async acquireLease(duration) {
            return { leaseId: `lease-${blobName}-${Date.now()}` };
          },
          async releaseLease() {},
        };
      },
    };
  }

  return {
    _blobs: blobs, // exposed for test assertions
    async createIfNotExists() { /* no-op */ },
    getBlockBlobClient(blobName) {
      return mockBlobClient(blobName);
    },
    listBlobsFlat(options) {
      const prefix = (options && options.prefix) || '';
      const matches = [];
      for (const key of blobs.keys()) {
        if (key.startsWith(prefix)) {
          matches.push({ name: key });
        }
      }
      return {
        async *[Symbol.asyncIterator]() {
          for (const m of matches) yield m;
        },
      };
    },
  };
}

/* ── Helpers ────────────────────────────────────────────────────────────── */

function createMockBackend() {
  const container = createMockContainerClient();
  const backend = new AzureStorageBackend({ containerClient: container });
  return { container, backend };
}

/* ── Tests ─────────────────────────────────────────────────────────────── */

describe('AzureStorageBackend', () => {
  let container;
  let backend;

  beforeEach(() => {
    container = createMockContainerClient();
    backend = new AzureStorageBackend({ containerClient: container });
  });

  it('writeRoom + readRoom round-trips all three artifacts', async () => {
    const ydocBytes = Buffer.from([0x01, 0x02, 0x03]);
    const secBytes = Buffer.from('<?xml version="1.0"?><SEC/>', 'utf-8');
    const commentsJson = JSON.stringify({ c1: { text: 'hello' } });

    await backend.writeRoom('demo', { ydocBytes, secBytes, commentsJson });
    const result = await backend.readRoom('demo');

    assert.ok(result, 'readRoom should return an object');
    assert.deepStrictEqual(result.ydocBytes, ydocBytes);
    assert.deepStrictEqual(result.secBytes, secBytes);
    assert.strictEqual(result.commentsJson, commentsJson);
  });

  it('readRoom returns null for nonexistent room', async () => {
    const result = await backend.readRoom('no-such-room');
    assert.strictEqual(result, null);
  });

  it('deleteRoom removes all blobs', async () => {
    await backend.writeRoom('rm-test', {
      ydocBytes: Buffer.from([1]),
      secBytes: Buffer.from([2]),
      commentsJson: '{}',
    });

    // Verify blobs exist
    assert.ok(container._blobs.has('rm-test/room.ydoc'));
    assert.ok(container._blobs.has('rm-test/room.sec'));
    assert.ok(container._blobs.has('rm-test/room.comments.json'));

    await backend.deleteRoom('rm-test');

    // All gone
    assert.ok(!container._blobs.has('rm-test/room.ydoc'));
    assert.ok(!container._blobs.has('rm-test/room.sec'));
    assert.ok(!container._blobs.has('rm-test/room.comments.json'));

    const result = await backend.readRoom('rm-test');
    assert.strictEqual(result, null);
  });

  it('listRooms returns room IDs', async () => {
    await backend.writeRoom('alpha', {
      ydocBytes: Buffer.from([1]),
      secBytes: null,
      commentsJson: null,
    });
    await backend.writeRoom('bravo', {
      ydocBytes: Buffer.from([2]),
      secBytes: null,
      commentsJson: null,
    });

    const rooms = await backend.listRooms();
    rooms.sort();
    assert.deepStrictEqual(rooms, ['alpha', 'bravo']);
  });

  it('quarantineRoom renames blobs (original gone after quarantine)', async () => {
    await backend.writeRoom('sick', {
      ydocBytes: Buffer.from([0xDE, 0xAD]),
      secBytes: Buffer.from('sec-data'),
      commentsJson: '{"note":"test"}',
    });

    await backend.quarantineRoom('sick', 'corrupt');

    // Originals should be gone
    assert.ok(!container._blobs.has('sick/room.ydoc'), 'original .ydoc should be gone');
    assert.ok(!container._blobs.has('sick/room.sec'), 'original .sec should be gone');
    assert.ok(!container._blobs.has('sick/room.comments.json'), 'original .comments.json should be gone');

    // Quarantined copies should exist (with .corrupt. prefix in name)
    let quarantinedCount = 0;
    for (const key of container._blobs.keys()) {
      if (key.startsWith('sick/') && key.includes('.corrupt.')) {
        quarantinedCount++;
      }
    }
    assert.strictEqual(quarantinedCount, 3, 'all three artifacts should be quarantined');

    // readRoom should now return null
    const result = await backend.readRoom('sick');
    assert.strictEqual(result, null);
  });

  it('statRoom returns lastModified or null', async () => {
    // Non-existent
    const none = await backend.statRoom('ghost');
    assert.strictEqual(none, null);

    // After write
    await backend.writeRoom('stat-test', {
      ydocBytes: Buffer.from([1]),
      secBytes: null,
      commentsJson: null,
    });
    const info = await backend.statRoom('stat-test');
    assert.ok(info, 'statRoom should return an object');
    assert.ok(info.lastModified, 'should have lastModified');
  });

  it('archiveRoom moves blobs to archive/ prefix with archivedAt metadata', async () => {
    await backend.writeRoom('arch-test', {
      ydocBytes: Buffer.from([0xAA, 0xBB]),
      secBytes: Buffer.from('sec-content'),
      commentsJson: '{"c":"v"}',
    });

    await backend.archiveRoom('arch-test');

    // Originals should be gone
    assert.ok(!container._blobs.has('arch-test/room.ydoc'), '.ydoc original should be gone');
    assert.ok(!container._blobs.has('arch-test/room.sec'), '.sec original should be gone');
    assert.ok(!container._blobs.has('arch-test/room.comments.json'), '.comments original should be gone');

    // Archive blobs should exist with correct content
    assert.ok(container._blobs.has('archive/arch-test/room.ydoc'), 'archive .ydoc should exist');
    assert.ok(container._blobs.has('archive/arch-test/room.sec'), 'archive .sec should exist');
    assert.ok(container._blobs.has('archive/arch-test/room.comments.json'), 'archive .comments should exist');

    const ydocEntry = container._blobs.get('archive/arch-test/room.ydoc');
    assert.deepStrictEqual(ydocEntry.content, Buffer.from([0xAA, 0xBB]), 'ydoc content preserved');
    assert.ok(ydocEntry.metadata.archivedAt, 'archivedAt metadata set');
  });

  it('restoreRoom moves archive blobs back to original names', async () => {
    await backend.writeRoom('restore-test', {
      ydocBytes: Buffer.from([0xCC]),
      secBytes: Buffer.from('sec-data'),
      commentsJson: '{}',
    });
    await backend.archiveRoom('restore-test');

    // Sanity check: originals are gone
    assert.ok(!container._blobs.has('restore-test/room.ydoc'));

    await backend.restoreRoom('restore-test');

    // Originals restored
    assert.ok(container._blobs.has('restore-test/room.ydoc'), 'ydoc restored');
    assert.ok(container._blobs.has('restore-test/room.sec'), 'sec restored');
    assert.ok(container._blobs.has('restore-test/room.comments.json'), 'comments restored');

    // Archive blobs should be gone
    assert.ok(!container._blobs.has('archive/restore-test/room.ydoc'), 'archive .ydoc removed');
    assert.ok(!container._blobs.has('archive/restore-test/room.sec'), 'archive .sec removed');

    // readRoom should work again
    const result = await backend.readRoom('restore-test');
    assert.ok(result, 'readRoom returns data after restore');
    assert.deepStrictEqual(result.ydocBytes, Buffer.from([0xCC]));
  });

  it('listArchivedRooms returns archived room IDs and archivedAt', async () => {
    await backend.writeRoom('room-x', { ydocBytes: Buffer.from([1]), secBytes: null, commentsJson: null });
    await backend.writeRoom('room-y', { ydocBytes: Buffer.from([2]), secBytes: null, commentsJson: null });
    await backend.archiveRoom('room-x');
    await backend.archiveRoom('room-y');

    const archived = await backend.listArchivedRooms();
    archived.sort((a, b) => a.id.localeCompare(b.id));

    assert.strictEqual(archived.length, 2);
    assert.strictEqual(archived[0].id, 'room-x');
    assert.strictEqual(archived[1].id, 'room-y');
    assert.ok(archived[0].archivedAt, 'archivedAt present for room-x');
    assert.ok(archived[1].archivedAt, 'archivedAt present for room-y');

    // listRooms should not include archived rooms
    const live = await backend.listRooms();
    assert.ok(!live.includes('room-x'), 'archived room not in listRooms');
    assert.ok(!live.includes('room-y'), 'archived room not in listRooms');
  });

  it('deleteArchivedRoom removes all archive blobs', async () => {
    await backend.writeRoom('del-arch', {
      ydocBytes: Buffer.from([5]),
      secBytes: Buffer.from('s'),
      commentsJson: '{}',
    });
    await backend.archiveRoom('del-arch');

    assert.ok(container._blobs.has('archive/del-arch/room.ydoc'), 'archive exists before delete');

    await backend.deleteArchivedRoom('del-arch');

    assert.ok(!container._blobs.has('archive/del-arch/room.ydoc'), 'archive .ydoc deleted');
    assert.ok(!container._blobs.has('archive/del-arch/room.sec'), 'archive .sec deleted');
    assert.ok(!container._blobs.has('archive/del-arch/room.comments.json'), 'archive .comments deleted');

    // Archived list should now be empty
    const archived = await backend.listArchivedRooms();
    assert.strictEqual(archived.length, 0);
  });

  it('writeRoom with null secBytes and commentsJson only writes ydoc', async () => {
    await backend.writeRoom('minimal', {
      ydocBytes: Buffer.from([0x42]),
      secBytes: null,
      commentsJson: null,
    });

    assert.ok(container._blobs.has('minimal/room.ydoc'));
    assert.ok(!container._blobs.has('minimal/room.sec'));
    assert.ok(!container._blobs.has('minimal/room.comments.json'));

    const result = await backend.readRoom('minimal');
    assert.ok(result);
    assert.deepStrictEqual(result.ydocBytes, Buffer.from([0x42]));
    assert.strictEqual(result.secBytes, null);
    assert.strictEqual(result.commentsJson, null);
  });

  it('writeRoom acquires and releases blob lease when available', async () => {
    const leaseLog = [];
    const { backend } = createMockBackend();
    // Monkey-patch to track lease calls
    const origGet = backend._container.getBlockBlobClient.bind(backend._container);
    backend._container.getBlockBlobClient = (name) => {
      const client = origGet(name);
      const origLease = client.getBlobLeaseClient.bind(client);
      client.getBlobLeaseClient = () => {
        const lc = origLease();
        const origAcquire = lc.acquireLease.bind(lc);
        const origRelease = lc.releaseLease.bind(lc);
        lc.acquireLease = async (d) => { leaseLog.push('acquire'); return origAcquire(d); };
        lc.releaseLease = async () => { leaseLog.push('release'); return origRelease(); };
        return lc;
      };
      return client;
    };

    await backend.writeRoom('lease-test', {
      ydocBytes: Buffer.from([1]),
      secBytes: null,
      commentsJson: null,
    });

    assert.ok(leaseLog.includes('acquire'));
    assert.ok(leaseLog.includes('release'));
  });
});
