/**
 * RoomStorageBase — base class for SecWriter room persistence backends.
 *
 * Owns the public methodset (writeRoom / readRoom / readAcl / writeAcl /
 * writeAclIfAbsent / listRooms / listAllRooms / deleteRoom / statRoom /
 * quarantineRoom / archiveRoom / backupRoom / restoreRoom /
 * listArchivedRooms / listAllArchivedRooms / deleteArchivedRoom /
 * migrateLegacyFlatRooms / countLegacyFlatRooms) by composing the adapter
 * primitives:
 *
 *   _putBytes(key, bytes, opts?)
 *   _putBytesIfAbsent(key, bytes, opts?) → boolean (conditional create)
 *   _getBytes(key)            → Buffer | null
 *   _deleteKey(key)           → void  (idempotent)
 *   _listKeys({ prefix? })    → string[]
 *   _statKey(key)             → { lastModified, sizeBytes? } | null
 *   _copyKey(src, dst, opts?) → void
 *   _keyForArtifact(tenant, roomId, kind, opts) → string | null
 *
 * Plus three name-parsing hooks for listing:
 *   _parseActiveKey(key, kind)  → { tenant, roomId } | null
 *   _parseArchiveKey(key, kind) → { tenant, roomId } | null
 *
 * Plus one listing-prefix hook:
 *   _listPrefix(archived, tenant?) → string | undefined
 *     Pass tenant to scope a listing to one tenant; omit for cross-tenant.
 *     listAllRooms/listAllArchivedRooms default to a flat parse (no prefix
 *     scope); Local overrides them for its directory layout.
 *
 * Plus optional overrides for archive-marker plumbing (Local writes a
 * sidecar file; Azure/S3 use blob metadata):
 *   _writeArchiveMarker(tenant, roomId, archivedAt) → void
 *   _readArchiveMarker(tenant, roomId, archiveYdocKey) → string | null
 *   _deleteArchiveMarker(tenant, roomId) → void
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
  ARTIFACT_KIND_ACL,
  sanitize,
  planArtifactWrites,
} = require('./storage-shared.cjs');

class RoomStorageBase {
  // ── Public methodset (all keyed by composite (tenant, roomId)) ───────────

  async writeRoom(tenant, roomId, artifacts) {
    const plan = planArtifactWrites(artifacts);
    for (const { kind, bytes } of plan) {
      const entry = ARTIFACT_CATALOG.find(c => c.kind === kind);
      const key = this._keyForArtifact(tenant, roomId, kind);
      await this._putBytes(key, bytes, { contentType: entry.contentType });
    }
  }

  async readRoom(tenant, roomId) {
    const ydocKey = this._keyForArtifact(tenant, roomId, ARTIFACT_KIND_YDOC);
    const ydocBytes = await this._getBytes(ydocKey);
    if (ydocBytes == null) return null;

    const secBytes = await this._getBytes(this._keyForArtifact(tenant, roomId, ARTIFACT_KIND_SEC));

    const commentsBuf = await this._getBytes(this._keyForArtifact(tenant, roomId, ARTIFACT_KIND_COMMENTS));
    const commentsJson = commentsBuf == null ? null : commentsBuf.toString('utf-8');

    const lintKey = this._keyForArtifact(tenant, roomId, ARTIFACT_KIND_LINT);
    const lintBuf = lintKey == null ? null : await this._getBytes(lintKey);
    const lintJson = lintBuf == null ? null : lintBuf.toString('utf-8');

    return { ydocBytes, secBytes, commentsJson, lintJson };
  }

  /** Cheap single-artifact ACL read — used by authorize() before any doc load. */
  async readAcl(tenant, roomId) {
    const key = this._keyForArtifact(tenant, roomId, ARTIFACT_KIND_ACL);
    const bytes = await this._getBytes(key);
    if (bytes == null) return null;
    try { return JSON.parse(bytes.toString('utf-8')); }
    catch { return null; }
  }

  /** Single-artifact ACL write — used by the share route (room already owned). */
  async writeAcl(tenant, roomId, acl) {
    const entry = ARTIFACT_CATALOG.find(c => c.kind === ARTIFACT_KIND_ACL);
    const key = this._keyForArtifact(tenant, roomId, ARTIFACT_KIND_ACL);
    await this._putBytes(key, Buffer.from(JSON.stringify(acl), 'utf-8'), { contentType: entry.contentType });
  }

  /**
   * Atomic ownership claim — write the ACL only if no ACL exists yet.
   * Returns true when this caller claimed the room, false when another
   * writer got there first. POST /rooms uses this instead of writeAcl so
   * two concurrent creates of the same id can't both 201 with the LAST
   * writeAcl silently transferring ownership (check-then-write race).
   * Atomicity comes from the adapter's _putBytesIfAbsent (local `wx` open,
   * S3 `If-None-Match: *`, Azure `ifNoneMatch: '*'`).
   */
  async writeAclIfAbsent(tenant, roomId, acl) {
    const entry = ARTIFACT_CATALOG.find(c => c.kind === ARTIFACT_KIND_ACL);
    const key = this._keyForArtifact(tenant, roomId, ARTIFACT_KIND_ACL);
    return this._putBytesIfAbsent(key, Buffer.from(JSON.stringify(acl), 'utf-8'), { contentType: entry.contentType });
  }

  async deleteRoom(tenant, roomId) {
    // Delete order: optional sidecars first, then `.ydoc`, then `.acl.json`
    // LAST. Two crash invariants:
    //   - sidecars before `.ydoc`: while any stale `.SEC`/`.comments.json`
    //     still exists the `.ydoc` does too, so the create route 409s — a
    //     half-deleted room can never be re-created over stale sidecars
    //     that GET /sec and GET /comments would then serve to the new
    //     owner (writeRoom skips null sidecars rather than deleting them).
    //   - `.ydoc` before `.acl`: a crash between them leaves an orphan ACL
    //     (room absent → 404, reclaimable via the owner-DELETE recovery
    //     path — the same state a crash mid-CREATE produces) — never a
    //     ydoc with no ACL (an ownerless, undeletable, un-recreatable room).
    const order = [
      ...ARTIFACT_CATALOG.filter(c => c.kind !== ARTIFACT_KIND_YDOC && c.kind !== ARTIFACT_KIND_ACL),
      ...ARTIFACT_CATALOG.filter(c => c.kind === ARTIFACT_KIND_YDOC),
      ...ARTIFACT_CATALOG.filter(c => c.kind === ARTIFACT_KIND_ACL),
    ];
    for (const { kind } of order) {
      await this._deleteKey(this._keyForArtifact(tenant, roomId, kind));
    }
  }

  async statRoom(tenant, roomId) {
    return this._statKey(this._keyForArtifact(tenant, roomId, ARTIFACT_KIND_YDOC));
  }

  /** Bare roomIds in ONE tenant. */
  async listRooms(tenant) {
    const t = sanitize(tenant);
    const keys = await this._listKeys({ prefix: this._listPrefix(false, t) });
    const rooms = new Set();
    for (const key of keys) {
      const parsed = this._parseActiveKey(key, ARTIFACT_KIND_YDOC);
      if (parsed && parsed.tenant === t) rooms.add(parsed.roomId);
    }
    return [...rooms];
  }

  /** Cross-tenant: [{ tenant, roomId }]. Used by the server sweep only. */
  async listAllRooms() {
    const keys = await this._listKeys({ prefix: this._listPrefix(false) });
    const seen = new Set();
    const out = [];
    for (const key of keys) {
      const parsed = this._parseActiveKey(key, ARTIFACT_KIND_YDOC);
      if (!parsed) continue;
      const ck = `${parsed.tenant}/${parsed.roomId}`;
      if (seen.has(ck)) continue;
      seen.add(ck);
      out.push(parsed);
    }
    return out;
  }

  async quarantineRoom(tenant, roomId, reason) {
    const ts = Date.now();
    for (const { kind } of ARTIFACT_CATALOG) {
      // The ACL is never quarantined: only the room CONTENT is corrupt or
      // oversize, and the live WS session that triggered the quarantine
      // stays connected to a fresh doc whose next flush rewrites `.ydoc`
      // but never the ACL (planArtifactWrites has no acl kind). Moving the
      // ACL aside would leave that flushed room ownerless — authorize()
      // 404s for everyone, DELETE 404s before its orphan-recovery branch,
      // and POST /rooms 409s on the new `.ydoc`: permanently bricked.
      if (kind === ARTIFACT_KIND_ACL) continue;
      const srcKey = this._keyForArtifact(tenant, roomId, kind);
      const dstKey = this._keyForArtifact(tenant, roomId, kind, { quarantine: { reason, ts } });
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

  async archiveRoom(tenant, roomId) {
    return this._copyRoomToArchive(tenant, roomId, { deleteSource: true, op: 'archive' });
  }

  /**
   * Non-destructive snapshot: copy every artifact into the archive namespace
   * but leave the ACTIVE room (including its ACL) fully intact. Used by the
   * v1→v2 substrate-migration broker (ADR-0006), which needs a pre-mutation
   * BACKUP of a room that keeps being served live — archiveRoom's move
   * semantics would destroy the active ACL (the post-migration flush never
   * rewrites it) and lose the active `.ydoc` entirely if the process crashed
   * before the first post-migration flush.
   */
  async backupRoom(tenant, roomId) {
    return this._copyRoomToArchive(tenant, roomId, { deleteSource: false, op: 'backup' });
  }

  async _copyRoomToArchive(tenant, roomId, { deleteSource, op }) {
    const archivedAt = new Date().toISOString();
    let copied = false;
    for (const { kind } of ARTIFACT_CATALOG) {
      const srcKey = this._keyForArtifact(tenant, roomId, kind);
      const dstKey = this._keyForArtifact(tenant, roomId, kind, { archived: true });
      const exists = (await this._statKey(srcKey)) != null;
      if (!exists) continue;
      try {
        await this._copyKey(srcKey, dstKey, { metadata: { archivedat: archivedAt } });
        copied = true;
      } catch (err) {
        this._onPartialOp(op, { roomId, kind, err });
        continue;
      }
      if (!deleteSource) continue;
      try { await this._deleteKey(srcKey); }
      catch (err) { this._onPartialOp(op, { roomId, kind, err }); }
    }
    if (copied) await this._writeArchiveMarker(tenant, roomId, archivedAt);
  }

  async restoreRoom(tenant, roomId) {
    for (const { kind } of ARTIFACT_CATALOG) {
      const srcKey = this._keyForArtifact(tenant, roomId, kind, { archived: true });
      const dstKey = this._keyForArtifact(tenant, roomId, kind);
      const exists = (await this._statKey(srcKey)) != null;
      if (!exists) continue;
      try { await this._copyKey(srcKey, dstKey); }
      catch (err) { this._onPartialOp('restore', { roomId, kind, err }); continue; }
      try { await this._deleteKey(srcKey); }
      catch (err) { this._onPartialOp('restore', { roomId, kind, err }); }
    }
    await this._deleteArchiveMarker(tenant, roomId);
  }

  /** Archived rooms in ONE tenant: [{ id, archivedAt }]. */
  async listArchivedRooms(tenant) {
    const t = sanitize(tenant);
    const keys = await this._listKeys({ prefix: this._listPrefix(true, t) });
    const seen = new Set();
    const result = [];
    for (const key of keys) {
      const parsed = this._parseArchiveKey(key, ARTIFACT_KIND_YDOC);
      if (!parsed || parsed.tenant !== t || seen.has(parsed.roomId)) continue;
      seen.add(parsed.roomId);
      const archivedAt = await this._readArchiveMarker(parsed.tenant, parsed.roomId, key);
      result.push({ id: parsed.roomId, archivedAt });
    }
    return result;
  }

  /** Cross-tenant archived: [{ tenant, roomId, archivedAt }]. Sweep only. */
  async listAllArchivedRooms() {
    const keys = await this._listKeys({ prefix: this._listPrefix(true) });
    const seen = new Set();
    const out = [];
    for (const key of keys) {
      const parsed = this._parseArchiveKey(key, ARTIFACT_KIND_YDOC);
      if (!parsed) continue;
      const ck = `${parsed.tenant}/${parsed.roomId}`;
      if (seen.has(ck)) continue;
      seen.add(ck);
      const archivedAt = await this._readArchiveMarker(parsed.tenant, parsed.roomId, key);
      out.push({ tenant: parsed.tenant, roomId: parsed.roomId, archivedAt });
    }
    return out;
  }

  async deleteArchivedRoom(tenant, roomId) {
    for (const { kind } of ARTIFACT_CATALOG) {
      await this._deleteKey(this._keyForArtifact(tenant, roomId, kind, { archived: true }));
    }
    await this._deleteArchiveMarker(tenant, roomId);
  }

  // ── Legacy flat-layout migration (pre-tenant keys) ───────────────────────

  /**
   * One-time relocation of pre-tenant FLAT rooms (legacy un-namespaced keys
   * at the storage root) into the composite `<tenant>/` namespace, writing
   * an ACL sidecar per room when `owner` is given. Without it, every
   * pre-existing room is invisible to the composite-key reads: the WS
   * preload logs 'room.new', serves an empty doc, and the first flush
   * persists the empty doc under the new key — silent data loss.
   *
   * Idempotent: relocated rooms no longer match the legacy listing, and a
   * re-run after a mid-room crash re-copies the surviving flat artifacts.
   *
   * Crash-order per room: ACL first (when `owner` is given), then sidecars
   * in catalog order with the flat `.ydoc` moved LAST — a crash mid-room
   * leaves the flat `.ydoc` in place (still listed, re-migratable) and at
   * worst an orphan ACL under the new key (reclaimable), never a relocated
   * room missing its source of truth.
   *
   * Returns the count of rooms moved. Callers: the collab-server boot path
   * (auth=none → tenant '_public', no owner/ACL, matching POST /rooms under
   * auth=none) and server/migrate-tenant-namespace.cjs (auth deploys).
   */
  async migrateLegacyFlatRooms({ tenant, owner = null } = {}) {
    if (!tenant) throw new Error('migrateLegacyFlatRooms: tenant is required');
    const ids = await this._listLegacyFlatRoomIds();
    let moved = 0;
    for (const id of ids) {
      if (owner != null) {
        await this.writeAcl(tenant, id, { ownerId: owner, sharedWith: [] });
      }
      for (const { kind } of ARTIFACT_CATALOG) {
        if (kind === ARTIFACT_KIND_ACL) continue; // no legacy ACLs existed
        const srcKey = this._legacyFlatKeyForArtifact(id, kind);
        if (srcKey == null) continue;
        if ((await this._statKey(srcKey)) == null) continue;
        await this._copyKey(srcKey, this._keyForArtifact(tenant, id, kind));
        await this._deleteKey(srcKey);
      }
      moved++;
    }

    // Legacy flat ARCHIVES too: rooms the pre-tenant sweep archived live at
    // un-namespaced archive keys that the tenant-scoped archive parsers
    // never match — invisible to listArchivedRooms/restoreRoom AND to the
    // DELETE_DAYS sweep, i.e. unrestorable and never purged. Relocate them
    // into the tenant's archive namespace, carrying archivedAt forward
    // (falling back to the ydoc mtime, else now, so the sweep can age them
    // out rather than skipping a null archivedAt forever). No ACL: archived
    // rooms have no active ACL in the new scheme either — restoreRoom
    // surfaces them as orphan content the owner re-claims via create.
    const archivedIds = await this._listLegacyFlatArchivedRoomIds();
    for (const id of archivedIds) {
      const legacyYdocKey = this._legacyFlatArchiveKeyForArtifact(id, ARTIFACT_KIND_YDOC);
      const archivedAt = (await this._readLegacyFlatArchiveMarker(id))
        || (await this._statKey(legacyYdocKey))?.lastModified
        || new Date().toISOString();
      for (const { kind } of ARTIFACT_CATALOG) {
        if (kind === ARTIFACT_KIND_ACL) continue;
        const srcKey = this._legacyFlatArchiveKeyForArtifact(id, kind);
        if (srcKey == null) continue;
        if ((await this._statKey(srcKey)) == null) continue;
        // Carry the marker as object metadata on the ydoc copy (Azure's
        // download+upload _copyKey drops metadata unless passed explicitly;
        // Local ignores opts; S3 REPLACEs with the same value).
        const opts = kind === ARTIFACT_KIND_YDOC ? { metadata: { archivedat: archivedAt } } : undefined;
        await this._copyKey(srcKey, this._keyForArtifact(tenant, id, kind, { archived: true }), opts);
        await this._deleteKey(srcKey);
      }
      await this._writeArchiveMarker(tenant, id, archivedAt);
      await this._deleteLegacyFlatArchiveMarker(id);
      moved++;
    }
    return moved;
  }

  /** Cheap probe for the boot-time guard: how many legacy flat rooms exist? */
  async countLegacyFlatRooms() {
    const active = await this._listLegacyFlatRoomIds();
    const archived = await this._listLegacyFlatArchivedRoomIds();
    return active.length + archived.length;
  }

  // ── Adapter contract: required ──────────────────────────────────────────

  // Subclasses MUST implement:
  //   _putBytes(key, bytes, opts) → Promise<void>
  //   _getBytes(key) → Promise<Buffer | null>      (null on 404)
  //   _deleteKey(key) → Promise<void>              (idempotent — swallow 404)
  //   _listKeys({ prefix }) → Promise<string[]>
  //   _statKey(key) → Promise<{ lastModified, sizeBytes? } | null>
  //   _copyKey(srcKey, dstKey, { metadata? }) → Promise<void>
  //   _keyForArtifact(tenant, roomId, kind, { archived?, quarantine? }) → string | null
  //   _parseActiveKey(key, kind)  → { tenant, roomId } | null
  //   _parseArchiveKey(key, kind) → { tenant, roomId } | null
  //   _listPrefix(archived, tenant?) → string | undefined
  //     Omit tenant for cross-tenant; supply it for single-tenant listing.
  //     listAllRooms/listAllArchivedRooms default to a flat parse;
  //     Local overrides them for its directory layout.

  // ── Adapter contract: optional overrides ────────────────────────────────

  /**
   * Conditional create primitive: write `bytes` at `key` only if the key
   * does not exist; return true if written, false on conflict. The default
   * is stat-then-put — NOT atomic across writers — so every shipped adapter
   * overrides it with a true conditional write (local `wx` open flag, S3
   * `If-None-Match: *`, Azure `ifNoneMatch: '*'`). A new adapter that keeps
   * the default trades the POST /rooms ownership-claim atomicity away.
   */
  async _putBytesIfAbsent(key, bytes, opts) {
    if ((await this._statKey(key)) != null) return false;
    await this._putBytes(key, bytes, opts);
    return true;
  }

  /**
   * Legacy flat-layout hooks (pre-tenant keys). Adapters that predate the
   * composite-key scheme override these so migrateLegacyFlatRooms can find
   * and relocate their old rooms — ACTIVE rooms (first pair) and ARCHIVED
   * rooms (second set; the pre-tenant sweep archived under un-namespaced
   * archive keys). Defaults: no legacy rooms.
   */
  async _listLegacyFlatRoomIds() { return []; }
  _legacyFlatKeyForArtifact(_roomId, _kind) { return null; }
  async _listLegacyFlatArchivedRoomIds() { return []; }
  _legacyFlatArchiveKeyForArtifact(_roomId, _kind) { return null; }
  /**
   * Default reads the `archivedat` object metadata off the legacy archived
   * ydoc via _readArchiveMarker's key parameter (S3/Azure store the marker
   * there). Local overrides — its marker is a sidecar file.
   */
  async _readLegacyFlatArchiveMarker(roomId) {
    const key = this._legacyFlatArchiveKeyForArtifact(roomId, ARTIFACT_KIND_YDOC);
    return key == null ? null : this._readArchiveMarker(null, roomId, key);
  }
  async _deleteLegacyFlatArchiveMarker(_roomId) { /* no-op — metadata moves with the copy */ }

  /** Default: no-op. Local overrides to write a sidecar marker file. */
  async _writeArchiveMarker(_tenant, _roomId, _archivedAt) { /* no-op */ }

  /** Default: read `archivedat` metadata from the archived `.ydoc`. Local overrides. */
  async _readArchiveMarker(_tenant, _roomId, _archiveYdocKey) { return null; }

  /** Default: no-op. Local overrides to remove the sidecar marker. */
  async _deleteArchiveMarker(_tenant, _roomId) { /* no-op */ }

  /**
   * Hook for partial-failure logging (archive copy succeeded, delete failed).
   * Default: silent. Adapters may override to plumb to logger.
   */
  _onPartialOp(_op, _ctx) { /* default: silent */ }
}

module.exports = { RoomStorageBase, sanitize };
