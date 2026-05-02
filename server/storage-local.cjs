/**
 * LocalStorageBackend — atomic multi-artifact persistence to the local
 * filesystem.
 *
 * Each room stores up to three files (see storage-shared.cjs / ARTIFACT_CATALOG):
 *   <room>.ydoc          — binary Yjs state snapshot
 *   <room>.SEC           — Windows-1252 encoded SEC XML
 *   <room>.comments.json — JSON sidecar
 *
 * `writeRoom` is overridden to provide TRUE atomicity: stage every artifact to
 * a `.tmp` file, then rename them in catalog order (`.ydoc` last). If any
 * rename fails, already-renamed artifacts are restored from in-memory backup
 * and remaining `.tmp` files are cleaned up. Filesystem rename is atomic per
 * file; multi-file atomicity is the wrapping rollback. Azure/S3 inherit the
 * base class's sequential write since their object models cannot rollback
 * cheaply.
 *
 * Active layout:    <dir>/<safe>.{ydoc|SEC|comments.json}
 * Quarantine layout: <dir>/<safe>.<ext>.<reason>.<ts>
 * Archive layout:   <dir>/archive/<safe>.<ext>      (+ <safe>.archivedAt marker)
 *
 * CJS on purpose (see ADR-0001).
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { RoomStorageBase } = require('./room-storage.cjs');
const {
  sanitize,
  ARTIFACT_KIND_YDOC,
  ARTIFACT_KIND_SEC,
  ARTIFACT_KIND_COMMENTS,
  ARTIFACT_CATALOG,
  planArtifactWrites,
} = require('./storage-shared.cjs');

const EXT_BY_KIND = {
  [ARTIFACT_KIND_YDOC]: '.ydoc',
  [ARTIFACT_KIND_SEC]: '.SEC',
  [ARTIFACT_KIND_COMMENTS]: '.comments.json',
};

class LocalStorageBackend extends RoomStorageBase {
  /** @param {string} dataDir — directory for room files (created if absent) */
  constructor(dataDir) {
    super();
    this._dir = path.resolve(dataDir);
    fs.mkdirSync(this._dir, { recursive: true });
  }

  // ── Public override: atomic writeRoom ───────────────────────────────────

  /**
   * Stage all artifacts to .tmp files, then rename in catalog order
   * (`.ydoc` LAST). If any rename fails, restore renamed artifacts from
   * in-memory backup and remove .tmp files.
   */
  async writeRoom(roomId, artifacts) {
    const plan = planArtifactWrites(artifacts).map(({ kind, bytes }) => {
      const target = this._keyForArtifact(roomId, kind);
      return {
        target,
        tmp: `${target}.tmp`,
        bytes,
        backup: fs.existsSync(target) ? fs.readFileSync(target) : null,
      };
    });

    for (const item of plan) {
      fs.writeFileSync(item.tmp, item.bytes);
    }

    const renamed = [];
    try {
      for (const item of plan) {
        fs.renameSync(item.tmp, item.target);
        renamed.push(item);
      }
    } catch (err) {
      for (const done of renamed) {
        try {
          if (done.backup != null) fs.writeFileSync(done.target, done.backup);
          else fs.unlinkSync(done.target);
        } catch { /* best effort */ }
      }
      for (const item of plan) {
        try { fs.unlinkSync(item.tmp); } catch { /* may not exist */ }
      }
      throw err;
    }
  }

  // ── Adapter primitives ──────────────────────────────────────────────────

  async _putBytes(key, bytes) {
    fs.writeFileSync(key, bytes);
  }

  async _getBytes(key) {
    if (!fs.existsSync(key)) return null;
    return fs.readFileSync(key);
  }

  async _deleteKey(key) {
    try { fs.unlinkSync(key); } catch { /* may not exist */ }
  }

  async _listKeys({ prefix } = {}) {
    const dir = prefix || this._dir;
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).map(name => path.join(dir, name));
  }

  async _statKey(key) {
    try {
      const stat = fs.statSync(key);
      return { lastModified: stat.mtime.toISOString(), sizeBytes: stat.size };
    } catch {
      return null;
    }
  }

  async _copyKey(srcKey, dstKey) {
    fs.renameSync(srcKey, dstKey);
  }

  // ── Naming ──────────────────────────────────────────────────────────────

  _keyForArtifact(roomId, kind, opts = {}) {
    const safe = sanitize(roomId);
    const ext = EXT_BY_KIND[kind];
    if (opts.archived) {
      return path.join(this._dir, 'archive', `${safe}${ext}`);
    }
    if (opts.quarantine) {
      const { reason, ts } = opts.quarantine;
      return path.join(this._dir, `${safe}${ext}.${reason}.${ts}`);
    }
    return path.join(this._dir, `${safe}${ext}`);
  }

  _listPrefix(archived) {
    return archived ? path.join(this._dir, 'archive') : this._dir;
  }

  _parseActiveKey(fullKey, kind) {
    if (kind !== ARTIFACT_KIND_YDOC) return null;
    const name = path.basename(fullKey);
    // Match "<name>.ydoc" exactly — exclude "<name>.ydoc.tmp",
    // "<name>.ydoc.corrupt.<ts>", "<name>.ydoc.oversize.<ts>".
    if (!name.endsWith('.ydoc') || name.includes('.ydoc.')) return null;
    const id = name.slice(0, -'.ydoc'.length);
    return id.length > 0 ? id : null;
  }

  _parseArchiveKey(fullKey, kind) {
    if (kind !== ARTIFACT_KIND_YDOC) return null;
    const name = path.basename(fullKey);
    if (!name.endsWith('.ydoc') || name.includes('.ydoc.')) return null;
    const id = name.slice(0, -'.ydoc'.length);
    return id.length > 0 ? id : null;
  }

  // ── Archive marker (Local uses a sidecar file) ──────────────────────────

  async _writeArchiveMarker(roomId, archivedAt) {
    const safe = sanitize(roomId);
    const archiveDir = path.join(this._dir, 'archive');
    fs.mkdirSync(archiveDir, { recursive: true });
    fs.writeFileSync(path.join(archiveDir, `${safe}.archivedAt`), archivedAt, 'utf-8');
  }

  async _readArchiveMarker(roomId) {
    const safe = sanitize(roomId);
    const markerPath = path.join(this._dir, 'archive', `${safe}.archivedAt`);
    if (!fs.existsSync(markerPath)) return null;
    try { return fs.readFileSync(markerPath, 'utf-8').trim(); }
    catch { return null; }
  }

  async _deleteArchiveMarker(roomId) {
    const safe = sanitize(roomId);
    const markerPath = path.join(this._dir, 'archive', `${safe}.archivedAt`);
    try { fs.unlinkSync(markerPath); } catch { /* may not exist */ }
  }

  // ── Override: archiveRoom ensures archive dir exists before copy ────────

  async archiveRoom(roomId) {
    const archiveDir = path.join(this._dir, 'archive');
    fs.mkdirSync(archiveDir, { recursive: true });
    return super.archiveRoom(roomId);
  }
}

module.exports = { LocalStorageBackend, sanitize };
