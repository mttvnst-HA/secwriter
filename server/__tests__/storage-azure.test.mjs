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
});
