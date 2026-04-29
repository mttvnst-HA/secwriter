/**
 * S3-compatible blob storage backend (Cloudflare R2, AWS S3, MinIO).
 *
 * Mirrors AzureStorageBackend's interface. Each room produces three
 * objects keyed by sanitized room name:
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
const { log } = require('./logger.cjs');

/**
 * Sanitize a room name: keep only [a-zA-Z0-9_-], max 64 chars.
 * Duplicated from storage-local.cjs / storage-azure.cjs to keep the three
 * backends aligned without introducing a shared util module.
 */
function _sanitize(name) {
  const safe = String(name).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
  return safe || 'default';
}

class S3StorageBackend {
  constructor({ client, bucket }) {
    if (!client) throw new Error('S3StorageBackend requires { client }');
    if (!bucket) throw new Error('S3StorageBackend requires { bucket }');
    this.client = client;
    this.bucket = bucket;
  }

  /**
   * Write artifacts in sequence with `.ydoc` LAST. Mirrors the Azure backend's
   * crash-safety invariant: if a sidecar write fails, `.ydoc` is left at the
   * older (consistent) state rather than ahead of stale sidecars.
   */
  async writeRoom(docName, artifacts) {
    const { ydocBytes, secBytes, commentsJson } = artifacts;
    const safe = _sanitize(docName);

    if (secBytes) {
      await this.client.send(new PutObjectCommand({
        Bucket: this.bucket,
        Key: `${safe}.SEC`,
        Body: secBytes,
        ContentType: 'application/octet-stream',
      }));
    }
    if (commentsJson != null) {
      await this.client.send(new PutObjectCommand({
        Bucket: this.bucket,
        Key: `${safe}.comments.json`,
        Body: commentsJson,
        ContentType: 'application/json',
      }));
    }
    // .ydoc LAST — source of truth, prevents stale-sidecar reads on partial failure.
    await this.client.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: `${safe}.ydoc`,
      Body: ydocBytes,
      ContentType: 'application/octet-stream',
    }));
  }

  async readRoom(docName) {
    const safe = _sanitize(docName);
    const tryGet = async (key) => {
      try {
        const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
        return await res.Body.transformToByteArray();
      } catch (err) {
        if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) return null;
        throw err;
      }
    };

    const ydocBytes = await tryGet(`${safe}.ydoc`);
    if (!ydocBytes) return null;

    const secBytes = await tryGet(`${safe}.SEC`);
    const commentsBytes = await tryGet(`${safe}.comments.json`);
    const commentsJson = commentsBytes ? Buffer.from(commentsBytes).toString('utf8') : null;

    return { ydocBytes, secBytes, commentsJson };
  }
  async deleteRoom(docName) {
    const safe = _sanitize(docName);
    const keys = [`${safe}.ydoc`, `${safe}.SEC`, `${safe}.comments.json`];
    await Promise.all(keys.map(Key =>
      this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key })).catch(err => {
        // Swallow 404 — optional artifacts (SEC, comments) may legitimately not exist.
        if (err.name !== 'NoSuchKey' && err.$metadata?.httpStatusCode !== 404) throw err;
      })
    ));
  }
  async listRooms() {
    const rooms = new Set();
    let continuationToken;
    do {
      const res = await this.client.send(new ListObjectsV2Command({
        Bucket: this.bucket,
        ContinuationToken: continuationToken,
      }));
      for (const obj of res.Contents || []) {
        const key = obj.Key;
        if (key.startsWith('archive/')) continue;
        // Match exactly <name>.ydoc — name must not contain '.' to exclude
        // <name>.<reason>.ydoc (quarantined).
        const m = key.match(/^([^./]+)\.ydoc$/);
        if (!m) continue;
        // Sanitize-validate: a key whose name contains characters outside the
        // sanitize charset cannot have come from a normal write through this
        // backend, so skip it rather than surfacing it as a real room.
        if (_sanitize(m[1]) !== m[1]) continue;
        rooms.add(m[1]);
      }
      continuationToken = res.NextContinuationToken;
    } while (continuationToken);
    return [...rooms];
  }
  async quarantineRoom(docName, reason) {
    const safe = _sanitize(docName);
    const sourceKey = `${safe}.ydoc`;
    const targetKey = `${safe}.${reason}.ydoc`;
    await this.client.send(new CopyObjectCommand({
      Bucket: this.bucket,
      CopySource: `${this.bucket}/${sourceKey}`,
      Key: targetKey,
    }));
    try {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: sourceKey }));
    } catch (err) {
      // Quarantine target is in place; that's the more important half. Leaving
      // the source behind is preferable to throwing — the operator can clean
      // up manually, and we avoid masking the successful copy.
      log.warn('quarantine.partial', { room: docName, reason, err: err.message });
    }
  }
  async archiveRoom(docName) {
    const safe = _sanitize(docName);
    const suffixes = ['.ydoc', '.SEC', '.comments.json'];
    const archivedAt = new Date().toISOString();
    for (const suffix of suffixes) {
      const sourceKey = `${safe}${suffix}`;
      const targetKey = `archive/${safe}${suffix}`;
      try {
        await this.client.send(new CopyObjectCommand({
          Bucket: this.bucket,
          CopySource: `${this.bucket}/${sourceKey}`,
          Key: targetKey,
          Metadata: { archivedat: archivedAt },
          MetadataDirective: 'REPLACE',
        }));
      } catch (err) {
        // Optional artifacts (SEC, comments) may not exist — skip silently.
        if (err.name !== 'NoSuchKey' && err.$metadata?.httpStatusCode !== 404) throw err;
        continue;
      }
      try {
        await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: sourceKey }));
      } catch (err) {
        // Copy succeeded; if the delete fails we'd otherwise leave the room
        // visible in listRooms() AND in the archive simultaneously. Log and
        // continue rather than rolling back the archive copy.
        log.warn('archive.partial', { room: docName, suffix, err: err.message });
      }
    }
  }

  async restoreRoom(docName) {
    const safe = _sanitize(docName);
    const suffixes = ['.ydoc', '.SEC', '.comments.json'];
    for (const suffix of suffixes) {
      const sourceKey = `archive/${safe}${suffix}`;
      const targetKey = `${safe}${suffix}`;
      try {
        await this.client.send(new CopyObjectCommand({
          Bucket: this.bucket,
          CopySource: `${this.bucket}/${sourceKey}`,
          Key: targetKey,
        }));
      } catch (err) {
        if (err.name !== 'NoSuchKey' && err.$metadata?.httpStatusCode !== 404) throw err;
        continue;
      }
      try {
        await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: sourceKey }));
      } catch (err) {
        // Restored copy is in place. Leaving the archive copy behind is
        // preferable to failing the restore — operator can clean up later.
        log.warn('restore.partial', { room: docName, suffix, err: err.message });
      }
    }
  }

  async listArchivedRooms() {
    const result = [];
    let continuationToken;
    do {
      const res = await this.client.send(new ListObjectsV2Command({
        Bucket: this.bucket,
        Prefix: 'archive/',
        ContinuationToken: continuationToken,
      }));
      for (const obj of res.Contents || []) {
        const m = obj.Key.match(/^archive\/([^./]+)\.ydoc$/);
        if (!m) continue;
        const name = m[1];
        // Sanitize-validate parsed names — see listRooms() comment.
        if (_sanitize(name) !== name) continue;
        let archivedAt = null;
        try {
          const head = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: obj.Key }));
          archivedAt = head.Metadata?.archivedat || null;
        } catch { /* ignore */ }
        result.push({ name, archivedAt });
      }
      continuationToken = res.NextContinuationToken;
    } while (continuationToken);
    return result;
  }

  async deleteArchivedRoom(docName) {
    const safe = _sanitize(docName);
    const keys = [`archive/${safe}.ydoc`, `archive/${safe}.SEC`, `archive/${safe}.comments.json`];
    for (const Key of keys) {
      try {
        await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key }));
      } catch (err) {
        if (err.name !== 'NoSuchKey' && err.$metadata?.httpStatusCode !== 404) throw err;
      }
    }
  }
  async statRoom(docName) {
    const safe = _sanitize(docName);
    try {
      const res = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: `${safe}.ydoc` }));
      return { lastModified: res.LastModified?.toISOString() || null };
    } catch (err) {
      if (err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404) return null;
      throw err;
    }
  }
}

module.exports = { S3StorageBackend };
