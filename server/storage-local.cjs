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
  ARTIFACT_KIND_LINT,
  ARTIFACT_KIND_ACL,
  ARTIFACT_CATALOG,
  planArtifactWrites,
} = require('./storage-shared.cjs');

const EXT_BY_KIND = {
  [ARTIFACT_KIND_YDOC]: '.ydoc',
  [ARTIFACT_KIND_SEC]: '.SEC',
  [ARTIFACT_KIND_COMMENTS]: '.comments.json',
  [ARTIFACT_KIND_LINT]: '.lint.json',
  [ARTIFACT_KIND_ACL]: '.acl.json',
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
  async writeRoom(tenant, roomId, artifacts) {
    const plan = planArtifactWrites(artifacts).map(({ kind, bytes }) => {
      const target = this._keyForArtifact(tenant, roomId, kind);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      return {
        target,
        tmp: `${target}.tmp`,
        bytes,
        backup: fs.existsSync(target) ? fs.readFileSync(target) : null,
      };
    });

    for (const item of plan) fs.writeFileSync(item.tmp, item.bytes);

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
    fs.mkdirSync(path.dirname(key), { recursive: true });
    fs.writeFileSync(key, bytes);
  }

  async _putBytesIfAbsent(key, bytes) {
    fs.mkdirSync(path.dirname(key), { recursive: true });
    try {
      fs.writeFileSync(key, bytes, { flag: 'wx' }); // atomic create-or-fail
      return true;
    } catch (err) {
      if (err.code === 'EEXIST') return false;
      throw err;
    }
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
    // A true COPY (not rename): the base-class contract is copy-then-delete,
    // and backupRoom relies on the source surviving. A rename here would
    // silently turn the broker's non-destructive backup into a move.
    fs.mkdirSync(path.dirname(dstKey), { recursive: true });
    fs.copyFileSync(srcKey, dstKey);
  }

  // ── Naming ──────────────────────────────────────────────────────────────

  _keyForArtifact(tenant, roomId, kind, opts = {}) {
    const t = sanitize(tenant);
    const safe = sanitize(roomId);
    const ext = EXT_BY_KIND[kind];
    if (opts.archived) return path.join(this._dir, 'archive', t, `${safe}${ext}`);
    if (opts.quarantine) {
      const { reason, ts } = opts.quarantine;
      return path.join(this._dir, t, `${safe}${ext}.${reason}.${ts}`);
    }
    return path.join(this._dir, t, `${safe}${ext}`);
  }

  _listPrefix(archived, tenant) {
    if (archived) {
      return tenant ? path.join(this._dir, 'archive', sanitize(tenant)) : path.join(this._dir, 'archive');
    }
    return tenant ? path.join(this._dir, sanitize(tenant)) : this._dir;
  }

  _parseActiveKey(fullKey, kind) {
    if (kind !== ARTIFACT_KIND_YDOC) return null;
    const name = path.basename(fullKey);
    // Match "<name>.ydoc" exactly — exclude "<name>.ydoc.tmp",
    // "<name>.ydoc.corrupt.<ts>", "<name>.ydoc.oversize.<ts>".
    if (!name.endsWith('.ydoc') || name.includes('.ydoc.')) return null;
    const roomId = name.slice(0, -'.ydoc'.length);
    if (!roomId) return null;
    const tenant = path.basename(path.dirname(fullKey));
    if (!tenant || tenant === 'archive') return null;
    return { tenant, roomId };
  }

  _parseArchiveKey(fullKey, kind) {
    if (kind !== ARTIFACT_KIND_YDOC) return null;
    const name = path.basename(fullKey);
    if (!name.endsWith('.ydoc') || name.includes('.ydoc.')) return null;
    const roomId = name.slice(0, -'.ydoc'.length);
    if (!roomId) return null;
    const tenant = path.basename(path.dirname(fullKey));
    if (!tenant) return null;
    return { tenant, roomId };
  }

  /** Tenant subdirs under the data dir (excludes the shared `archive` dir). */
  _listTenants() {
    if (!fs.existsSync(this._dir)) return [];
    return fs.readdirSync(this._dir, { withFileTypes: true })
      .filter(d => d.isDirectory() && d.name !== 'archive')
      .map(d => d.name);
  }

  /** Tenant subdirs under <dir>/archive. */
  _listArchivedTenants() {
    const archiveDir = path.join(this._dir, 'archive');
    if (!fs.existsSync(archiveDir)) return [];
    return fs.readdirSync(archiveDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);
  }

  /** Local readdir is non-recursive — walk tenant subdirs for the cross-tenant list. */
  async listAllRooms() {
    const out = [];
    for (const t of this._listTenants()) {
      for (const roomId of await this.listRooms(t)) out.push({ tenant: t, roomId });
    }
    return out;
  }

  async listAllArchivedRooms() {
    const out = [];
    for (const t of this._listArchivedTenants()) {
      for (const r of await this.listArchivedRooms(t)) {
        out.push({ tenant: t, roomId: r.id, archivedAt: r.archivedAt });
      }
    }
    return out;
  }

  // ── Archive marker (Local uses a sidecar file) ──────────────────────────

  async _writeArchiveMarker(tenant, roomId, archivedAt) {
    const dir = path.join(this._dir, 'archive', sanitize(tenant));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${sanitize(roomId)}.archivedAt`), archivedAt, 'utf-8');
  }

  async _readArchiveMarker(tenant, roomId) {
    const markerPath = path.join(this._dir, 'archive', sanitize(tenant), `${sanitize(roomId)}.archivedAt`);
    if (!fs.existsSync(markerPath)) return null;
    try { return fs.readFileSync(markerPath, 'utf-8').trim(); }
    catch { return null; }
  }

  async _deleteArchiveMarker(tenant, roomId) {
    const markerPath = path.join(this._dir, 'archive', sanitize(tenant), `${sanitize(roomId)}.archivedAt`);
    try { fs.unlinkSync(markerPath); } catch { /* may not exist */ }
  }

  // ── Legacy flat layout (pre-tenant): <dir>/<safe>.<ext> at the top level ──

  _legacyFlatKeyForArtifact(roomId, kind) {
    return path.join(this._dir, `${sanitize(roomId)}${EXT_BY_KIND[kind]}`);
  }

  async _listLegacyFlatRoomIds() {
    if (!fs.existsSync(this._dir)) return [];
    const ids = [];
    for (const e of fs.readdirSync(this._dir, { withFileTypes: true })) {
      if (!e.isFile()) continue; // tenant subdirs + 'archive' are dirs — skip
      // "<id>.ydoc" exactly — excludes ".ydoc.tmp" and legacy quarantine
      // "<id>.ydoc.<reason>.<ts>".
      if (e.name.endsWith('.ydoc') && !e.name.includes('.ydoc.')) {
        ids.push(e.name.slice(0, -'.ydoc'.length));
      }
    }
    return ids;
  }

  // Legacy flat ARCHIVE layout: <dir>/archive/<safe>.<ext> files directly in
  // archive/ (+ <safe>.archivedAt marker file). The tenant layout's archived
  // rooms are SUBDIRS of archive/, so flat files there are unambiguous.

  _legacyFlatArchiveKeyForArtifact(roomId, kind) {
    return path.join(this._dir, 'archive', `${sanitize(roomId)}${EXT_BY_KIND[kind]}`);
  }

  async _listLegacyFlatArchivedRoomIds() {
    const archiveDir = path.join(this._dir, 'archive');
    if (!fs.existsSync(archiveDir)) return [];
    const ids = [];
    for (const e of fs.readdirSync(archiveDir, { withFileTypes: true })) {
      if (!e.isFile()) continue; // tenant archive subdirs — skip
      if (e.name.endsWith('.ydoc') && !e.name.includes('.ydoc.')) {
        ids.push(e.name.slice(0, -'.ydoc'.length));
      }
    }
    return ids;
  }

  async _readLegacyFlatArchiveMarker(roomId) {
    const markerPath = path.join(this._dir, 'archive', `${sanitize(roomId)}.archivedAt`);
    if (!fs.existsSync(markerPath)) return null;
    try { return fs.readFileSync(markerPath, 'utf-8').trim(); }
    catch { return null; }
  }

  async _deleteLegacyFlatArchiveMarker(roomId) {
    const markerPath = path.join(this._dir, 'archive', `${sanitize(roomId)}.archivedAt`);
    try { fs.unlinkSync(markerPath); } catch { /* may not exist */ }
  }

  // ── Orphan .tmp sweep ─────────────────────────────────────────────────────

  /**
   * Delete orphaned `*.tmp` staging files anywhere under the data dir.
   * writeRoom stages-then-renames within one call, so any `.tmp` present at
   * boot is a crash leftover. The walk covers tenant subdirs and the archive
   * tree — a top-level-only readdir would miss every post-tenant-layout
   * orphan (writeRoom stages at `<dir>/<tenant>/<room>.<ext>.tmp`).
   * Returns the number of files removed.
   */
  sweepOrphanTmpFiles() {
    let removed = 0;
    const walk = (dir) => {
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
      catch { return; }
      for (const e of entries) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.tmp')) {
          try { fs.unlinkSync(p); removed++; } catch { /* best effort */ }
        }
      }
    };
    walk(this._dir);
    return removed;
  }
}

module.exports = { LocalStorageBackend, sanitize };
