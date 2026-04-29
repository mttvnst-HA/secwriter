import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mockClient } from 'aws-sdk-client-mock';
import { S3Client, PutObjectCommand, GetObjectCommand,
         ListObjectsV2Command, CopyObjectCommand, DeleteObjectCommand,
         HeadObjectCommand } from '@aws-sdk/client-s3';

const { S3StorageBackend } = await import('../storage-s3.cjs');

const s3Mock = mockClient(S3Client);

describe('S3StorageBackend', () => {
  beforeEach(() => {
    s3Mock.reset();
  });

  test('constructor requires client and bucket', () => {
    assert.throws(() => new S3StorageBackend({}), /requires \{ client \}/);
    assert.throws(
      () => new S3StorageBackend({ client: new S3Client({ region: 'auto' }) }),
      /requires \{ bucket \}/
    );
    const backend = new S3StorageBackend({ client: new S3Client({ region: 'auto' }), bucket: 'test' });
    assert.equal(backend.bucket, 'test');
  });

  test('writeRoom + readRoom round-trips all three artifacts', async () => {
    const stored = new Map();
    s3Mock.on(PutObjectCommand).callsFake(async (input) => {
      stored.set(input.Key, input.Body);
      return {};
    });
    s3Mock.on(GetObjectCommand).callsFake(async (input) => {
      if (!stored.has(input.Key)) {
        const err = new Error('NoSuchKey'); err.name = 'NoSuchKey';
        throw err;
      }
      const body = stored.get(input.Key);
      return {
        Body: {
          transformToByteArray: async () =>
            body instanceof Uint8Array ? body : new Uint8Array(Buffer.from(body)),
        },
      };
    });

    const backend = new S3StorageBackend({ client: new S3Client({ region: 'auto' }), bucket: 'test' });
    const ydocBytes = new Uint8Array([1, 2, 3, 4]);
    const secBytes = new Uint8Array([5, 6, 7]);
    const commentsJson = '{"comments":[]}';

    await backend.writeRoom('myroom', { ydocBytes, secBytes, commentsJson });
    const result = await backend.readRoom('myroom');

    assert.deepEqual(Array.from(result.ydocBytes), [1, 2, 3, 4]);
    assert.deepEqual(Array.from(result.secBytes), [5, 6, 7]);
    assert.equal(result.commentsJson, commentsJson);
  });

  test('readRoom returns null when ydoc missing', async () => {
    s3Mock.on(GetObjectCommand).callsFake(async () => {
      const err = new Error('NoSuchKey'); err.name = 'NoSuchKey';
      throw err;
    });
    const backend = new S3StorageBackend({ client: new S3Client({ region: 'auto' }), bucket: 'test' });
    const result = await backend.readRoom('nope');
    assert.equal(result, null);
  });

  test('writeRoom with null secBytes/commentsJson writes only ydoc', async () => {
    const writes = [];
    s3Mock.on(PutObjectCommand).callsFake(async (input) => {
      writes.push(input.Key);
      return {};
    });
    const backend = new S3StorageBackend({ client: new S3Client({ region: 'auto' }), bucket: 'test' });
    await backend.writeRoom('myroom', { ydocBytes: new Uint8Array([1]), secBytes: null, commentsJson: null });
    assert.deepEqual(writes, ['myroom.ydoc']);
  });

  test('deleteRoom removes all three artifacts', async () => {
    const deleted = [];
    s3Mock.on(DeleteObjectCommand).callsFake(async (input) => {
      deleted.push(input.Key);
      return {};
    });

    const backend = new S3StorageBackend({ client: new S3Client({ region: 'auto' }), bucket: 'test' });
    await backend.deleteRoom('myroom');

    assert.deepEqual(deleted.sort(), ['myroom.SEC', 'myroom.comments.json', 'myroom.ydoc']);
  });

  test('listRooms returns room names from .ydoc objects, excluding quarantine + archive', async () => {
    s3Mock.on(ListObjectsV2Command).resolves({
      Contents: [
        { Key: 'room1.ydoc' },
        { Key: 'room1.SEC' },
        { Key: 'room2.ydoc' },
        { Key: 'room2.comments.json' },
        { Key: 'room3.corrupt.ydoc' },     // quarantined - exclude
        { Key: 'room4.oversize.ydoc' },    // quarantined - exclude
        { Key: 'archive/room5.ydoc' },     // archived - exclude
      ],
    });

    const backend = new S3StorageBackend({ client: new S3Client({ region: 'auto' }), bucket: 'test' });
    const rooms = await backend.listRooms();

    assert.deepEqual(rooms.sort(), ['room1', 'room2']);
  });
});
