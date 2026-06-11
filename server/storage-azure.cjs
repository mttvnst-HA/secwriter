/**
 * AzureStorageBackend — Azure Blob Storage persistence for SecWriter rooms.
 *
 * Subclass of RoomStorageBase: shared methodset / artifact catalog / write
 * ordering live in room-storage.cjs. This file only owns Azure-specific
 * primitives, blob naming, and the `.ydoc` lease wrapping writeRoom for
 * multi-instance safety.
 *
 * Active layout:    <tenant>/<id>/room.{ydoc|sec|comments.json|acl.json}
 * Quarantine layout: <tenant>/<id>/room.<ext>.<reason>.<ts>
 * Archive layout:   archive/<tenant>/<id>/room.{ydoc|sec|comments.json|acl.json}
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
  ARTIFACT_KIND_ACL,
  planArtifactWrites,
} = require('./storage-shared.cjs');

const SUFFIX_BY_KIND = {
  [ARTIFACT_KIND_YDOC]: 'room.ydoc',
  // Lowercase `.sec` is a historical Azure-only quirk preserved to keep
  // existing rooms readable. (Local/S3 use uppercase `.SEC`.)
  [ARTIFACT_KIND_SEC]: 'room.sec',
  [ARTIFACT_KIND_COMMENTS]: 'room.comments.json',
  [ARTIFACT_KIND_LINT]: 'room.lint.json',
  [ARTIFACT_KIND_ACL]: 'room.acl.json',
};

class AzureStorageBackend extends RoomStorageBase {
  /** @param {{ containerClient: import('@azure/storage-blob').ContainerClient }} opts */
  constructor({ containerClient }) {
    super();
    this._container = containerClient;
    this._initPromise = containerClient.createIfNotExists();
  }

  // ── Public override: writeRoom with optional .ydoc blob lease ───────────

  async writeRoom(tenant, roomId, artifacts) {
    await this._initPromise;
    const plan = planArtifactWrites(artifacts);

    const ydocKey = this._keyForArtifact(tenant, roomId, ARTIFACT_KIND_YDOC);
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
        const key = this._keyForArtifact(tenant, roomId, kind);
        const blob = this._container.getBlockBlobClient(key);
        const opts = { metadata };
        if (kind === ARTIFACT_KIND_YDOC && leaseId) opts.conditions = { leaseId };
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

  async _putBytesIfAbsent(key, bytes, opts = {}) {
    await this._initPromise;
    const blob = this._container.getBlockBlobClient(key);
    const uploadOpts = { conditions: { ifNoneMatch: '*' } }; // conditional create
    if (opts.metadata) uploadOpts.metadata = opts.metadata;
    try {
      await blob.upload(bytes, bytes.length, uploadOpts);
      return true;
    } catch (err) {
      // 409 BlobAlreadyExists / 412 ConditionNotMet — another writer won.
      if (err.statusCode === 409 || err.statusCode === 412) return false;
      throw err;
    }
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

  _keyForArtifact(tenant, roomId, kind, opts = {}) {
    const t = sanitize(tenant);
    const id = sanitize(roomId);
    const suffix = SUFFIX_BY_KIND[kind];
    if (opts.archived) return `archive/${t}/${id}/${suffix}`;
    if (opts.quarantine) {
      const { reason, ts } = opts.quarantine;
      return `${t}/${id}/${suffix}.${reason}.${ts}`;
    }
    return `${t}/${id}/${suffix}`;
  }

  _listPrefix(archived, tenant) {
    if (archived) return tenant ? `archive/${sanitize(tenant)}/` : 'archive/';
    return tenant ? `${sanitize(tenant)}/` : undefined;
  }

  _parseActiveKey(key, kind) {
    if (kind !== ARTIFACT_KIND_YDOC) return null;
    if (key.startsWith('archive/')) return null;
    if (!key.endsWith('/room.ydoc')) return null;
    const i = key.indexOf('/');
    if (i < 0) return null;
    const tenant = key.slice(0, i);
    const rest = key.slice(i + 1);                 // <id>/room.ydoc
    const roomId = rest.slice(0, -'/room.ydoc'.length);
    if (!tenant || !roomId || roomId.includes('/')) return null;
    return { tenant, roomId };
  }

  _parseArchiveKey(key, kind) {
    if (kind !== ARTIFACT_KIND_YDOC) return null;
    if (!key.startsWith('archive/')) return null;
    if (!key.endsWith('/room.ydoc')) return null;
    const rest = key.slice('archive/'.length);     // <tenant>/<id>/room.ydoc
    const i = rest.indexOf('/');
    if (i < 0) return null;
    const tenant = rest.slice(0, i);
    const roomId = rest.slice(i + 1).slice(0, -'/room.ydoc'.length);
    if (!tenant || !roomId || roomId.includes('/')) return null;
    return { tenant, roomId };
  }

  // ── Legacy flat layout (pre-tenant): <id>/room.<ext> (one path segment) ──

  _legacyFlatKeyForArtifact(roomId, kind) {
    return `${sanitize(roomId)}/${SUFFIX_BY_KIND[kind]}`;
  }

  async _listLegacyFlatRoomIds() {
    const keys = await this._listKeys({});
    const ids = [];
    for (const key of keys) {
      // Exactly ONE path segment before room.ydoc — the tenant layout
      // (<tenant>/<id>/room.ydoc) and the archive layouts have two.
      const m = key.match(/^([^/]+)\/room\.ydoc$/);
      if (m && m[1] !== 'archive') ids.push(m[1]);
    }
    return ids;
  }

  // Legacy flat ARCHIVE layout: archive/<id>/room.<ext> — one segment
  // between archive/ and room.ydoc (the tenant layout's
  // archive/<tenant>/<id>/room.ydoc has two). archivedAt lives in blob
  // metadata; the base default marker hook reads it via _readArchiveMarker's
  // key parameter.

  _legacyFlatArchiveKeyForArtifact(roomId, kind) {
    return `archive/${sanitize(roomId)}/${SUFFIX_BY_KIND[kind]}`;
  }

  async _listLegacyFlatArchivedRoomIds() {
    const keys = await this._listKeys({ prefix: 'archive/' });
    const ids = [];
    for (const key of keys) {
      const m = key.match(/^archive\/([^/]+)\/room\.ydoc$/);
      if (m) ids.push(m[1]);
    }
    return ids;
  }

  // ── Archive marker (Azure uses blob metadata) ───────────────────────────

  async _readArchiveMarker(_tenant, _roomId, archiveYdocKey) {
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
