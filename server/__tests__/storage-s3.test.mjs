import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mockClient } from 'aws-sdk-client-mock';
import { S3Client, PutObjectCommand, GetObjectCommand,
         ListObjectsV2Command, CopyObjectCommand, DeleteObjectCommand,
         HeadObjectCommand } from '@aws-sdk/client-s3';

const { S3StorageBackend } = await import('../storage-s3.cjs');

const T = 'acme'; // tenant for all tests

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

    await backend.writeRoom(T, 'myroom', { ydocBytes, secBytes, commentsJson });
    const result = await backend.readRoom(T, 'myroom');

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
    const result = await backend.readRoom(T, 'nope');
    assert.equal(result, null);
  });

  test('writeRoom with null secBytes/commentsJson writes only ydoc', async () => {
    const writes = [];
    s3Mock.on(PutObjectCommand).callsFake(async (input) => {
      writes.push(input.Key);
      return {};
    });
    const backend = new S3StorageBackend({ client: new S3Client({ region: 'auto' }), bucket: 'test' });
    await backend.writeRoom(T, 'myroom', { ydocBytes: new Uint8Array([1]), secBytes: null, commentsJson: null });
    // Key is now <tenant>/<roomId>.ydoc
    assert.deepEqual(writes, [`${T}/myroom.ydoc`]);
  });

  test('deleteRoom removes all five artifacts (including ACL)', async () => {
    const deleted = [];
    s3Mock.on(DeleteObjectCommand).callsFake(async (input) => {
      deleted.push(input.Key);
      return {};
    });

    const backend = new S3StorageBackend({ client: new S3Client({ region: 'auto' }), bucket: 'test' });
    await backend.deleteRoom(T, 'myroom');

    // Catalog order: sec, comments, lint, acl, ydoc — all prefixed with T/
    assert.deepEqual(
      deleted.sort(),
      [
        `${T}/myroom.SEC`,
        `${T}/myroom.acl.json`,
        `${T}/myroom.comments.json`,
        `${T}/myroom.lint.json`,
        `${T}/myroom.ydoc`,
      ],
    );
  });

  test('listRooms returns room names from .ydoc objects, excluding quarantine + archive', async () => {
    s3Mock.on(ListObjectsV2Command).resolves({
      Contents: [
        { Key: `${T}/room1.ydoc` },
        { Key: `${T}/room1.SEC` },
        { Key: `${T}/room2.ydoc` },
        { Key: `${T}/room2.comments.json` },
        { Key: `${T}/room3.corrupt.ydoc` },     // quarantined - exclude
        { Key: `${T}/room4.oversize.ydoc` },    // quarantined - exclude
        { Key: `archive/${T}/room5.ydoc` },     // archived - exclude
      ],
    });

    const backend = new S3StorageBackend({ client: new S3Client({ region: 'auto' }), bucket: 'test' });
    const rooms = await backend.listRooms(T);

    assert.deepEqual(rooms.sort(), ['room1', 'room2']);
  });

  test('quarantineRoom copies .ydoc to .<reason>.ydoc and deletes original', async () => {
    const copies = [];
    const deletes = [];
    s3Mock.on(CopyObjectCommand).callsFake(async (input) => {
      copies.push({ from: input.CopySource, to: input.Key });
      return {};
    });
    s3Mock.on(DeleteObjectCommand).callsFake(async (input) => {
      deletes.push(input.Key);
      return {};
    });
    // Only .ydoc exists — .acl.json absent — stat returns 404 for it.
    s3Mock.on(HeadObjectCommand).callsFake(async (input) => {
      if (input.Key === `${T}/myroom.ydoc`) return { LastModified: new Date(), ContentLength: 1 };
      const err = new Error('NotFound'); err.name = 'NotFound'; err.$metadata = { httpStatusCode: 404 };
      throw err;
    });

    const backend = new S3StorageBackend({ client: new S3Client({ region: 'auto' }), bucket: 'test' });
    await backend.quarantineRoom(T, 'myroom', 'corrupt');

    // Only ydoc is quarantined when acl.json doesn't exist.
    assert.equal(copies.length, 1);
    assert.equal(copies[0].from, `test/${T}/myroom.ydoc`);
    assert.equal(copies[0].to, `${T}/myroom.corrupt.ydoc`);
    assert.deepEqual(deletes, [`${T}/myroom.ydoc`]);
  });

  test('quarantineRoom also copies and deletes .acl.json sidecar when it exists', async () => {
    const copies = [];
    const deletes = [];
    s3Mock.on(CopyObjectCommand).callsFake(async (input) => {
      copies.push({ from: input.CopySource, to: input.Key });
      return {};
    });
    s3Mock.on(DeleteObjectCommand).callsFake(async (input) => {
      deletes.push(input.Key);
      return {};
    });
    // Both .ydoc and .acl.json exist — stat returns ContentLength for both.
    s3Mock.on(HeadObjectCommand).callsFake(async (input) => {
      if (input.Key === `${T}/myroom.ydoc`) return { LastModified: new Date(), ContentLength: 10 };
      if (input.Key === `${T}/myroom.acl.json`) return { LastModified: new Date(), ContentLength: 42 };
      const err = new Error('NotFound'); err.name = 'NotFound'; err.$metadata = { httpStatusCode: 404 };
      throw err;
    });

    const backend = new S3StorageBackend({ client: new S3Client({ region: 'auto' }), bucket: 'test' });
    await backend.quarantineRoom(T, 'myroom', 'corrupt');

    // Both artifacts must be copied to their quarantine keys.
    const copyTos = copies.map(c => c.to).sort();
    assert.deepEqual(copyTos, [
      `${T}/myroom.corrupt.acl.json`,
      `${T}/myroom.corrupt.ydoc`,
    ]);
    assert.equal(copies.find(c => c.to === `${T}/myroom.corrupt.ydoc`)?.from, `test/${T}/myroom.ydoc`);
    assert.equal(copies.find(c => c.to === `${T}/myroom.corrupt.acl.json`)?.from, `test/${T}/myroom.acl.json`);

    // Both originals must be deleted.
    assert.deepEqual(deletes.sort(), [
      `${T}/myroom.acl.json`,
      `${T}/myroom.ydoc`,
    ]);
  });

  test('archive lifecycle: archive → list → restore → archive → delete', async () => {
    const objects = new Map();
    objects.set(`${T}/myroom.ydoc`, new Uint8Array([1]));
    objects.set(`${T}/myroom.SEC`, new Uint8Array([2]));

    s3Mock.on(ListObjectsV2Command).callsFake(async (input) => ({
      Contents: [...objects.keys()]
        .filter(k => !input.Prefix || k.startsWith(input.Prefix))
        .map(Key => ({ Key })),
    }));
    s3Mock.on(CopyObjectCommand).callsFake(async (input) => {
      const sourceKey = String(input.CopySource).split('/').slice(1).join('/');
      objects.set(input.Key, objects.get(sourceKey));
      return {};
    });
    s3Mock.on(DeleteObjectCommand).callsFake(async (input) => {
      objects.delete(input.Key);
      return {};
    });
    s3Mock.on(HeadObjectCommand).callsFake(async (input) => {
      if (!objects.has(input.Key)) {
        const err = new Error('NotFound'); err.name = 'NotFound'; err.$metadata = { httpStatusCode: 404 };
        throw err;
      }
      return { Metadata: { archivedat: '2026-04-29T00:00:00Z' } };
    });

    const backend = new S3StorageBackend({ client: new S3Client({ region: 'auto' }), bucket: 'test' });

    await backend.archiveRoom(T, 'myroom');
    assert.ok(objects.has(`archive/${T}/myroom.ydoc`));
    assert.ok(objects.has(`archive/${T}/myroom.SEC`));
    assert.ok(!objects.has(`${T}/myroom.ydoc`));

    const archived = await backend.listArchivedRooms(T);
    assert.equal(archived.length, 1);
    // Uniform `id` field across all backends.
    assert.equal(archived[0].id, 'myroom');
    assert.ok(archived[0].archivedAt);

    await backend.restoreRoom(T, 'myroom');
    assert.ok(objects.has(`${T}/myroom.ydoc`));
    assert.ok(!objects.has(`archive/${T}/myroom.ydoc`));

    await backend.archiveRoom(T, 'myroom');
    await backend.deleteArchivedRoom(T, 'myroom');
    assert.ok(!objects.has(`archive/${T}/myroom.ydoc`));
  });

  test('listRooms paginates via ContinuationToken', async () => {
    let calls = 0;
    s3Mock.on(ListObjectsV2Command).callsFake(async (_input) => {
      calls++;
      if (calls === 1) {
        return {
          Contents: [{ Key: `${T}/page1room.ydoc` }],
          NextContinuationToken: 'TOKEN',
        };
      }
      return {
        Contents: [{ Key: `${T}/page2room.ydoc` }],
      };
    });
    const backend = new S3StorageBackend({ client: new S3Client({ region: 'auto' }), bucket: 'test' });
    const rooms = await backend.listRooms(T);
    assert.deepEqual(rooms.sort(), ['page1room', 'page2room']);
    assert.equal(calls, 2);
  });

  test('readRoom propagates non-404 errors', async () => {
    s3Mock.on(GetObjectCommand).callsFake(async () => {
      const err = new Error('AccessDenied');
      err.name = 'AccessDenied';
      err.$metadata = { httpStatusCode: 403 };
      throw err;
    });
    const backend = new S3StorageBackend({ client: new S3Client({ region: 'auto' }), bucket: 'test' });
    await assert.rejects(backend.readRoom(T, 'myroom'), /AccessDenied/);
  });

  test('writeRoom serializes commentsJson body to UTF-8 bytes', async () => {
    let commentsBody = null;
    s3Mock.on(PutObjectCommand).callsFake(async (input) => {
      if (input.Key.endsWith('.comments.json')) commentsBody = input.Body;
      return {};
    });
    const backend = new S3StorageBackend({ client: new S3Client({ region: 'auto' }), bucket: 'test' });
    await backend.writeRoom(T, 'myroom', {
      ydocBytes: new Uint8Array([1]),
      secBytes: null,
      commentsJson: '{"comments":[]}',
    });
    assert.ok(Buffer.isBuffer(commentsBody) || commentsBody instanceof Uint8Array);
    assert.equal(Buffer.from(commentsBody).toString('utf-8'), '{"comments":[]}');
  });

  test('writeRoom sanitizes special characters in room names', async () => {
    const writes = [];
    s3Mock.on(PutObjectCommand).callsFake(async (input) => {
      writes.push(input.Key);
      return {};
    });
    const backend = new S3StorageBackend({ client: new S3Client({ region: 'auto' }), bucket: 'test' });
    await backend.writeRoom(T, 'foo.bar baz', { ydocBytes: new Uint8Array([1]), secBytes: null, commentsJson: null });
    // Sanitize replaces [^a-zA-Z0-9_-] with '_': "foo.bar baz" → "foo_bar_baz"
    // Key is now <T>/<sanitized>.ydoc
    assert.equal(writes.length, 1);
    assert.equal(writes[0], `${T}/foo_bar_baz.ydoc`);
    assert.match(writes[0], /^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+\.ydoc$/);
    assert.ok(!writes[0].includes('.bar'));
    assert.ok(!writes[0].includes(' '));
  });

  test('statRoom returns lastModified or null', async () => {
    s3Mock.on(HeadObjectCommand).callsFake(async (input) => {
      if (input.Key === `${T}/myroom.ydoc`) return { LastModified: new Date('2026-04-29T12:00:00Z') };
      const err = new Error('NotFound'); err.name = 'NotFound'; err.$metadata = { httpStatusCode: 404 };
      throw err;
    });
    const backend = new S3StorageBackend({ client: new S3Client({ region: 'auto' }), bucket: 'test' });
    const stat = await backend.statRoom(T, 'myroom');
    assert.ok(stat.lastModified);
    const missing = await backend.statRoom(T, 'nope');
    assert.equal(missing, null);
  });
});
