/**
 * RoomStorageBase — base class for SecWriter room persistence backends.
 *
 * Owns the public methodset (writeRoom / readRoom / listRooms / deleteRoom /
 * statRoom / quarantineRoom / archiveRoom / restoreRoom / listArchivedRooms /
 * deleteArchivedRoom) by composing seven adapter primitives:
 *
 *   _putBytes(key, bytes, opts?)
 *   _getBytes(key)            → Buffer | null
 *   _deleteKey(key)           → void  (idempotent)
 *   _listKeys({ prefix? })    → string[]
 *   _statKey(key)             → { lastModified, sizeBytes? } | null
 *   _copyKey(src, dst, opts?) → void
 *   _keyForArtifact(roomId, kind, { archived?, quarantine? }) → string | null
 *
 * Plus three name-parsing hooks for listing:
 *   _parseActiveKey(key, kind)  → roomId | null
 *   _parseArchiveKey(key, kind) → roomId | null
 *
 * Plus one optional override for archive-marker plumbing (Local writes a
 * sidecar file; Azure/S3 use blob metadata):
 *   _writeArchiveMarker(roomId, archivedAt) → void
 *   _readArchiveMarker(roomId, archiveYdocKey) → string | null
 *   _deleteArchiveMarker(roomId) → void
 *
 * Backends extend this class and implement the required primitives. The base
 * class never knows about file paths, blob naming, lease semantics, or
 * SDK-specific error shapes — those stay in the adapter.
 *
 * Atomicity: this base class writes artifacts sequentially with `.ydoc` LAST
 * (via storage-shared's ARTIFACT_CATALOG). True multi-artifact atomicity
 * (stage-rename-rollback) is filesystem-only and lives in storage-local.cjs
 * as a writeRoom override. Azure/S3 inherit the default sequential write
 * since their object models don't support cheap rollback.
 *
 * CJS on purpose (see ADR-0001).
 */
'use strict';

const {
  ARTIFACT_CATALOG,
  ARTIFACT_KIND_YDOC,
  ARTIFACT_KIND_SEC,
  ARTIFACT_KIND_COMMENTS,
  ARTIFACT_KIND_LINT,
  sanitize,
  planArtifactWrites,
} = require('./storage-shared.cjs');

class RoomStorageBase {
  // ── Public methodset ────────────────────────────────────────────────────

  async writeRoom(roomId, artifacts) {
    const plan = planArtifactWrites(artifacts);
    for (const { kind, bytes } of plan) {
      const entry = ARTIFACT_CATALOG.find(c => c.kind === kind);
      const key = this._keyForArtifact(roomId, kind);
      await this._putBytes(key, bytes, { contentType: entry.contentType });
    }
  }

  /**
   * Read a room's artifacts. Returns null if `.ydoc` doesn't exist.
   * Missing optional sidecars (`.SEC`, `.comments.json`, `.lint.json`) are
   * returned as null.
   */
  async readRoom(roomId) {
    const ydocKey = this._keyForArtifact(roomId, ARTIFACT_KIND_YDOC);
    const ydocBytes = await this._getBytes(ydocKey);
    if (ydocBytes == null) return null;

    const secKey = this._keyForArtifact(roomId, ARTIFACT_KIND_SEC);
    const secBytes = await this._getBytes(secKey);

    const commentsKey = this._keyForArtifact(roomId, ARTIFACT_KIND_COMMENTS);
    const commentsBuf = await this._getBytes(commentsKey);
    const commentsJson = commentsBuf == null ? null : commentsBuf.toString('utf-8');

    const lintKey = this._keyForArtifact(roomId, ARTIFACT_KIND_LINT);
    const lintBuf = lintKey == null ? null : await this._getBytes(lintKey);
    const lintJson = lintBuf == null ? null : lintBuf.toString('utf-8');

    return { ydocBytes, secBytes, commentsJson, lintJson };
  }

  async deleteRoom(roomId) {
    for (const { kind } of ARTIFACT_CATALOG) {
      const key = this._keyForArtifact(roomId, kind);
      await this._deleteKey(key);
    }
  }

  async statRoom(roomId) {
    const ydocKey = this._keyForArtifact(roomId, ARTIFACT_KIND_YDOC);
    return this._statKey(ydocKey);
  }

  async listRooms() {
    const ydocKeys = await this._listKeys({ prefix: this._listPrefix(false) });
    const rooms = new Set();
    for (const key of ydocKeys) {
      const id = this._parseActiveKey(key, ARTIFACT_KIND_YDOC);
      if (id != null) rooms.add(id);
    }
    return [...rooms];
  }

  async quarantineRoom(roomId, reason) {
    // One timestamp for the whole quarantine so all artifacts share a suffix.
    const ts = Date.now();
    for (const { kind } of ARTIFACT_CATALOG) {
      const srcKey = this._keyForArtifact(roomId, kind);
      const dstKey = this._keyForArtifact(roomId, kind, { quarantine: { reason, ts } });
      // Adapter may opt out of quarantining a kind by returning null
      // (S3 only quarantines .ydoc, since SEC/comments are derivable).
      if (dstKey == null) continue;
      const exists = (await this._statKey(srcKey)) != null;
      if (!exists) continue;
      try {
        await this._copyKey(srcKey, dstKey, {
          metadata: { quarantineReason: String(reason), quarantineTime: String(ts) },
        });
        await this._deleteKey(srcKey);
      } catch (err) {
        this._onPartialOp('quarantine', { roomId, kind, err });
      }
    }
  }

  async archiveRoom(roomId) {
    const archivedAt = new Date().toISOString();
    let copied = false;
    for (const { kind } of ARTIFACT_CATALOG) {
      const srcKey = this._keyForArtifact(roomId, kind);
      const dstKey = this._keyForArtifact(roomId, kind, { archived: true });
      const exists = (await this._statKey(srcKey)) != null;
      if (!exists) continue;
      try {
        await this._copyKey(srcKey, dstKey, { metadata: { archivedat: archivedAt } });
        copied = true;
      } catch (err) {
        this._onPartialOp('archive', { roomId, kind, err });
        continue;
      }
      try {
        await this._deleteKey(srcKey);
      } catch (err) {
        this._onPartialOp('archive', { roomId, kind, err });
      }
    }
    if (copied) await this._writeArchiveMarker(roomId, archivedAt);
  }

  async restoreRoom(roomId) {
    for (const { kind } of ARTIFACT_CATALOG) {
      const srcKey = this._keyForArtifact(roomId, kind, { archived: true });
      const dstKey = this._keyForArtifact(roomId, kind);
      const exists = (await this._statKey(srcKey)) != null;
      if (!exists) continue;
      try {
        await this._copyKey(srcKey, dstKey);
      } catch (err) {
        this._onPartialOp('restore', { roomId, kind, err });
        continue;
      }
      try {
        await this._deleteKey(srcKey);
      } catch (err) {
        this._onPartialOp('restore', { roomId, kind, err });
      }
    }
    await this._deleteArchiveMarker(roomId);
  }

  async listArchivedRooms() {
    const archiveYdocKeys = await this._listKeys({ prefix: this._listPrefix(true) });
    const seen = new Set();
    const result = [];
    for (const key of archiveYdocKeys) {
      const id = this._parseArchiveKey(key, ARTIFACT_KIND_YDOC);
      if (id == null || seen.has(id)) continue;
      seen.add(id);
      const archivedAt = await this._readArchiveMarker(id, key);
      result.push({ id, archivedAt });
    }
    return result;
  }

  async deleteArchivedRoom(roomId) {
    for (const { kind } of ARTIFACT_CATALOG) {
      const key = this._keyForArtifact(roomId, kind, { archived: true });
      await this._deleteKey(key);
    }
    await this._deleteArchiveMarker(roomId);
  }

  // ── Adapter contract: required ──────────────────────────────────────────

  // Subclasses MUST implement:
  //   _putBytes(key, bytes, opts) → Promise<void>
  //   _getBytes(key) → Promise<Buffer | null>      (null on 404)
  //   _deleteKey(key) → Promise<void>              (idempotent — swallow 404)
  //   _listKeys({ prefix }) → Promise<string[]>
  //   _statKey(key) → Promise<{ lastModified, sizeBytes? } | null>
  //   _copyKey(srcKey, dstKey, { metadata? }) → Promise<void>
  //   _keyForArtifact(roomId, kind, { archived?, quarantine? }) → string | null
  //   _parseActiveKey(key, kind) → roomId | null
  //   _parseArchiveKey(key, kind) → roomId | null
  //   _listPrefix(archived) → string | undefined   (passed to _listKeys for listRooms)

  // ── Adapter contract: optional overrides ────────────────────────────────

  /** Default: no-op. Local overrides to write a sidecar marker file. */
  async _writeArchiveMarker(_roomId, _archivedAt) { /* no-op */ }

  /**
   * Default: read `archivedat` metadata from the archived `.ydoc` blob/object.
   * Local overrides to read a sidecar marker file.
   */
  async _readArchiveMarker(_roomId, _archiveYdocKey) { return null; }

  /** Default: no-op. Local overrides to remove the sidecar marker. */
  async _deleteArchiveMarker(_roomId) { /* no-op */ }

  /**
   * Hook for partial-failure logging (archive copy succeeded, delete failed).
   * Default: silent. Adapters may override to plumb to logger.
   */
  _onPartialOp(_op, _ctx) { /* default: silent */ }
}

module.exports = { RoomStorageBase, sanitize };
