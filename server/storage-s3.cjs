/**
 * S3-compatible blob storage backend (Cloudflare R2, AWS S3, MinIO).
 *
 * Mirrors AzureStorageBackend's interface. Each room produces three
 * objects keyed by room name:
 *   <name>.ydoc            (binary Y.Doc snapshot)
 *   <name>.SEC             (windows-1252 encoded .SEC bytes)
 *   <name>.comments.json   (UTF-8 JSON sidecar)
 *
 * Quarantined rooms: <name>.<reason>.ydoc (e.g. <name>.corrupt.ydoc).
 * Archived rooms: archive/<name>.* prefix.
 *
 * Configured via SIM_S3_ENDPOINT / SIM_S3_REGION / SIM_S3_ACCESS_KEY_ID /
 * SIM_S3_SECRET_ACCESS_KEY / SIM_S3_BUCKET. See server/collab-server.cjs
 * for the env-driven instantiation.
 */

const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand,
        ListObjectsV2Command, CopyObjectCommand, HeadObjectCommand } = require('@aws-sdk/client-s3');

class S3StorageBackend {
  constructor({ client, bucket }) {
    if (!client) throw new Error('S3StorageBackend requires { client }');
    if (!bucket) throw new Error('S3StorageBackend requires { bucket }');
    this.client = client;
    this.bucket = bucket;
  }

  async writeRoom(docName, artifacts) {
    const { ydocBytes, secBytes, commentsJson } = artifacts;
    const writes = [
      this.client.send(new PutObjectCommand({
        Bucket: this.bucket,
        Key: `${docName}.ydoc`,
        Body: ydocBytes,
        ContentType: 'application/octet-stream',
      })),
    ];
    if (secBytes) {
      writes.push(this.client.send(new PutObjectCommand({
        Bucket: this.bucket,
        Key: `${docName}.SEC`,
        Body: secBytes,
        ContentType: 'application/octet-stream',
      })));
    }
    if (commentsJson) {
      writes.push(this.client.send(new PutObjectCommand({
        Bucket: this.bucket,
        Key: `${docName}.comments.json`,
        Body: commentsJson,
        ContentType: 'application/json',
      })));
    }
    await Promise.all(writes);
  }

  async readRoom(docName) {
    const tryGet = async (key) => {
      try {
        const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
        return await res.Body.transformToByteArray();
      } catch (err) {
        if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) return null;
        throw err;
      }
    };

    const ydocBytes = await tryGet(`${docName}.ydoc`);
    if (!ydocBytes) return null;

    const secBytes = await tryGet(`${docName}.SEC`);
    const commentsBytes = await tryGet(`${docName}.comments.json`);
    const commentsJson = commentsBytes ? Buffer.from(commentsBytes).toString('utf8') : null;

    return { ydocBytes, secBytes, commentsJson };
  }
  async deleteRoom(docName) {
    const keys = [`${docName}.ydoc`, `${docName}.SEC`, `${docName}.comments.json`];
    await Promise.all(keys.map(Key =>
      this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key })).catch(err => {
        // Swallow 404 — optional artifacts (SEC, comments) may legitimately not exist.
        if (err.name !== 'NoSuchKey' && err.$metadata?.httpStatusCode !== 404) throw err;
      })
    ));
  }
  async listRooms() { throw new Error('not implemented'); }
  async quarantineRoom(docName, reason) { throw new Error('not implemented'); }
  async archiveRoom(docName) { throw new Error('not implemented'); }
  async restoreRoom(docName) { throw new Error('not implemented'); }
  async listArchivedRooms() { throw new Error('not implemented'); }
  async deleteArchivedRoom(docName) { throw new Error('not implemented'); }
  async statRoom(docName) { throw new Error('not implemented'); }
}

module.exports = { S3StorageBackend };
