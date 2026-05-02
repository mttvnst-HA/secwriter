/**
 * S3StorageBackend — S3-compatible blob storage (Cloudflare R2, AWS S3, MinIO).
 *
 * Subclass of RoomStorageBase: shared methodset / artifact catalog / write
 * ordering live in room-storage.cjs. This file only owns S3 SDK plumbing,
 * key naming, and the historical S3 quarantine quirks (only `.ydoc` is
 * quarantined, suffix BEFORE extension, no timestamp).
 *
 * Active layout:    <safe>.{ydoc|SEC|comments.json}
 * Quarantine layout: <safe>.<reason>.ydoc           (.ydoc only)
 * Archive layout:   archive/<safe>.{ydoc|SEC|comments.json}
 *                    + object metadata `archivedat`
 *
 * Configured via SIM_S3_ENDPOINT / SIM_S3_REGION / SIM_S3_ACCESS_KEY_ID /
 * SIM_S3_SECRET_ACCESS_KEY / SIM_S3_BUCKET. See server/collab-server.cjs.
 */
'use strict';

const {
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  CopyObjectCommand,
  HeadObjectCommand,
} = require('@aws-sdk/client-s3');

const { RoomStorageBase } = require('./room-storage.cjs');
const {
  sanitize,
  ARTIFACT_KIND_YDOC,
  ARTIFACT_KIND_SEC,
  ARTIFACT_KIND_COMMENTS,
} = require('./storage-shared.cjs');
const { log } = require('./logger.cjs');

const EXT_BY_KIND = {
  [ARTIFACT_KIND_YDOC]: '.ydoc',
  [ARTIFACT_KIND_SEC]: '.SEC',
  [ARTIFACT_KIND_COMMENTS]: '.comments.json',
};

function isNotFound(err) {
  return err.name === 'NoSuchKey' ||
         err.name === 'NotFound' ||
         err.$metadata?.httpStatusCode === 404;
}

class S3StorageBackend extends RoomStorageBase {
  constructor({ client, bucket }) {
    super();
    if (!client) throw new Error('S3StorageBackend requires { client }');
    if (!bucket) throw new Error('S3StorageBackend requires { bucket }');
    this.client = client;
    this.bucket = bucket;
  }

  // ── Adapter primitives ──────────────────────────────────────────────────

  async _putBytes(key, bytes, opts = {}) {
    await this.client.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      Body: bytes,
      ContentType: opts.contentType || 'application/octet-stream',
    }));
  }

  async _getBytes(key) {
    try {
      const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      const bytes = await res.Body.transformToByteArray();
      return Buffer.from(bytes);
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async _deleteKey(key) {
    try {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
  }

  async _listKeys({ prefix } = {}) {
    const keys = [];
    let continuationToken;
    do {
      const cmd = new ListObjectsV2Command({
        Bucket: this.bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      });
      const res = await this.client.send(cmd);
      for (const obj of res.Contents || []) keys.push(obj.Key);
      continuationToken = res.NextContinuationToken;
    } while (continuationToken);
    return keys;
  }

  async _statKey(key) {
    try {
      const res = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return {
        lastModified: res.LastModified ? res.LastModified.toISOString() : null,
        sizeBytes: res.ContentLength,
      };
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async _copyKey(srcKey, dstKey, opts = {}) {
    const cmd = {
      Bucket: this.bucket,
      CopySource: `${this.bucket}/${srcKey}`,
      Key: dstKey,
    };
    if (opts.metadata) {
      cmd.Metadata = opts.metadata;
      cmd.MetadataDirective = 'REPLACE';
    }
    await this.client.send(new CopyObjectCommand(cmd));
  }

  // ── Naming ──────────────────────────────────────────────────────────────

  _keyForArtifact(roomId, kind, opts = {}) {
    const safe = sanitize(roomId);
    const ext = EXT_BY_KIND[kind];
    if (opts.archived) {
      return `archive/${safe}${ext}`;
    }
    if (opts.quarantine) {
      // S3 historical: ONLY `.ydoc` is quarantined, suffix goes BEFORE the
      // extension (not after), and there is no timestamp. Returning null
      // tells RoomStorageBase to skip this kind.
      if (kind !== ARTIFACT_KIND_YDOC) return null;
      const { reason } = opts.quarantine;
      return `${safe}.${reason}.ydoc`;
    }
    return `${safe}${ext}`;
  }

  _listPrefix(archived) {
    return archived ? 'archive/' : undefined;
  }

  _parseActiveKey(key, kind) {
    if (kind !== ARTIFACT_KIND_YDOC) return null;
    if (key.startsWith('archive/')) return null;
    // Match exactly <name>.ydoc — `name` must not contain '.' to exclude
    // <name>.<reason>.ydoc (quarantined).
    const m = key.match(/^([^./]+)\.ydoc$/);
    if (!m) return null;
    // Sanitize-validate parsed names: reject keys whose name contains
    // chars outside the sanitize charset (couldn't have come from a
    // normal write through this backend).
    if (sanitize(m[1]) !== m[1]) return null;
    return m[1];
  }

  _parseArchiveKey(key, kind) {
    if (kind !== ARTIFACT_KIND_YDOC) return null;
    const m = key.match(/^archive\/([^./]+)\.ydoc$/);
    if (!m) return null;
    if (sanitize(m[1]) !== m[1]) return null;
    return m[1];
  }

  // ── Archive marker (S3 uses object metadata) ────────────────────────────

  async _readArchiveMarker(_roomId, archiveYdocKey) {
    try {
      const head = await this.client.send(new HeadObjectCommand({
        Bucket: this.bucket,
        Key: archiveYdocKey,
      }));
      return head.Metadata?.archivedat || null;
    } catch {
      return null;
    }
  }

  // ── Partial-failure logging ─────────────────────────────────────────────

  _onPartialOp(op, { roomId, kind, err }) {
    log.warn(`${op}.partial`, { room: roomId, kind, err: err.message });
  }
}

module.exports = { S3StorageBackend };
