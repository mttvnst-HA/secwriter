/**
 * AzureStorageBackend — Azure Blob Storage persistence for SecWriter rooms.
 *
 * Subclass of RoomStorageBase: shared methodset / artifact catalog / write
 * ordering live in room-storage.cjs. This file only owns Azure-specific
 * primitives, blob naming, and the `.ydoc` lease wrapping writeRoom for
 * multi-instance safety.
 *
 * Active layout:    <id>/room.{ydoc|sec|comments.json}
 * Quarantine layout: <id>/room.<ext>.<reason>.<ts>
 * Archive layout:   archive/<id>/room.{ydoc|sec|comments.json}
 *                    + blob metadata `archivedat` (lowercase — Node HTTP
 *                    parser normalizes response header names to lowercase).
 *
 * The containerClient is injected via constructor for testability.
 *
 * CJS on purpose (see ADR-0001).
 */
'use strict';

const { RoomStorageBase } = require('./room-storage.cjs');
const {
  sanitize,
  ARTIFACT_KIND_YDOC,
  ARTIFACT_KIND_SEC,
  ARTIFACT_KIND_COMMENTS,
  ARTIFACT_KIND_LINT,
  planArtifactWrites,
} = require('./storage-shared.cjs');

const SUFFIX_BY_KIND = {
  [ARTIFACT_KIND_YDOC]: 'room.ydoc',
  // Lowercase `.sec` is a historical Azure-only quirk preserved to keep
  // existing rooms readable. (Local/S3 use uppercase `.SEC`.)
  [ARTIFACT_KIND_SEC]: 'room.sec',
  [ARTIFACT_KIND_COMMENTS]: 'room.comments.json',
  [ARTIFACT_KIND_LINT]: 'room.lint.json',
};

class AzureStorageBackend extends RoomStorageBase {
  /** @param {{ containerClient: import('@azure/storage-blob').ContainerClient }} opts */
  constructor({ containerClient }) {
    super();
    this._container = containerClient;
    this._initPromise = containerClient.createIfNotExists();
  }

  // ── Public override: writeRoom with optional .ydoc blob lease ───────────

  async writeRoom(roomId, artifacts) {
    await this._initPromise;
    const plan = planArtifactWrites(artifacts);

    const ydocKey = this._keyForArtifact(roomId, ARTIFACT_KIND_YDOC);
    const ydocBlob = this._container.getBlockBlobClient(ydocKey);

    let leaseClient = null;
    let leaseId = null;
    try {
      leaseClient = ydocBlob.getBlobLeaseClient();
      const leaseResult = await leaseClient.acquireLease(30);
      leaseId = leaseResult.leaseId;
    } catch {
      // Blob may not exist yet (first write) or lease unavailable — proceed.
      leaseClient = null;
    }

    const metadata = { generation: String(Date.now()) };

    try {
      for (const { kind, bytes } of plan) {
        const key = this._keyForArtifact(roomId, kind);
        const blob = this._container.getBlockBlobClient(key);
        const opts = { metadata };
        if (kind === ARTIFACT_KIND_YDOC && leaseId) {
          opts.conditions = { leaseId };
        }
        await blob.upload(bytes, bytes.length, opts);
      }
    } finally {
      if (leaseClient && leaseId) {
        try { await leaseClient.releaseLease(); } catch { /* ignore */ }
      }
    }
  }

  // ── Adapter primitives ──────────────────────────────────────────────────

  async _putBytes(key, bytes, opts = {}) {
    await this._initPromise;
    const blob = this._container.getBlockBlobClient(key);
    const uploadOpts = {};
    if (opts.metadata) uploadOpts.metadata = opts.metadata;
    await blob.upload(bytes, bytes.length, uploadOpts);
  }

  async _getBytes(key) {
    await this._initPromise;
    try {
      const blob = this._container.getBlockBlobClient(key);
      return await blob.downloadToBuffer();
    } catch (err) {
      if (err.statusCode === 404) return null;
      throw err;
    }
  }

  async _deleteKey(key) {
    await this._initPromise;
    const blob = this._container.getBlockBlobClient(key);
    await blob.deleteIfExists();
  }

  async _listKeys({ prefix } = {}) {
    await this._initPromise;
    const keys = [];
    const iter = this._container.listBlobsFlat(prefix ? { prefix } : {});
    for await (const item of iter) keys.push(item.name);
    return keys;
  }

  async _statKey(key) {
    await this._initPromise;
    try {
      const blob = this._container.getBlockBlobClient(key);
      const props = await blob.getProperties();
      return {
        lastModified: props.lastModified ? props.lastModified.toISOString() : null,
        sizeBytes: props.contentLength,
      };
    } catch (err) {
      if (err.statusCode === 404) return null;
      throw err;
    }
  }

  /** Server-side copy via download + upload (Azure SDK pattern). */
  async _copyKey(srcKey, dstKey, opts = {}) {
    await this._initPromise;
    const src = this._container.getBlockBlobClient(srcKey);
    const dst = this._container.getBlockBlobClient(dstKey);
    const content = await src.downloadToBuffer();
    const uploadOpts = {};
    if (opts.metadata) uploadOpts.metadata = opts.metadata;
    await dst.upload(content, content.length, uploadOpts);
  }

  // ── Naming ──────────────────────────────────────────────────────────────

  _keyForArtifact(roomId, kind, opts = {}) {
    const id = sanitize(roomId);
    const suffix = SUFFIX_BY_KIND[kind];
    if (opts.archived) {
      return `archive/${id}/${suffix}`;
    }
    if (opts.quarantine) {
      const { reason, ts } = opts.quarantine;
      return `${id}/${suffix}.${reason}.${ts}`;
    }
    return `${id}/${suffix}`;
  }

  _listPrefix(archived) {
    return archived ? 'archive/' : undefined;
  }

  _parseActiveKey(key, kind) {
    if (kind !== ARTIFACT_KIND_YDOC) return null;
    if (key.startsWith('archive/')) return null;
    if (!key.endsWith('/room.ydoc')) return null;
    const id = key.slice(0, -'/room.ydoc'.length);
    return id.length > 0 ? id : null;
  }

  _parseArchiveKey(key, kind) {
    if (kind !== ARTIFACT_KIND_YDOC) return null;
    if (!key.startsWith('archive/')) return null;
    if (!key.endsWith('/room.ydoc')) return null;
    const withoutPrefix = key.slice('archive/'.length);
    const id = withoutPrefix.slice(0, -'/room.ydoc'.length);
    return id.length > 0 ? id : null;
  }

  // ── Archive marker (Azure uses blob metadata) ───────────────────────────

  async _readArchiveMarker(_roomId, archiveYdocKey) {
    await this._initPromise;
    try {
      const blob = this._container.getBlockBlobClient(archiveYdocKey);
      const props = await blob.getProperties();
      const meta = (props && props.metadata) || {};
      // Lowercase key — Node HTTP parser normalizes response header names
      // to lowercase, so the SDK returns metadata with lowercase keys on
      // read. Fall back to camelCase for blobs archived under earlier code.
      return meta.archivedat || meta.archivedAt || null;
    } catch {
      return null;
    }
  }
}

module.exports = { AzureStorageBackend, sanitize };
