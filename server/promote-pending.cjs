'use strict';
const { normalizeEmail, isPendingExpired, higherRole, exceedsAclByteCap } = require('./auth/authorize.cjs');

/**
 * Bind (or upgrade) a pending-by-email invite to the authenticating sub, once
 * per WS connect (#267 seam 3). Fire-and-forget from onAuthenticate — the role
 * verdict already came from resolveRole, so this only PERSISTS the bind + caches
 * the display name. A dropped/retried run re-converges on the next connect.
 *
 * Runs the whole read-modify-write under the shared ACL mutex (seam 4). Two
 * delete-race guards (blocker #2): the read-time null-guard (delete-then-read)
 * AND the isDeleted tombstone check (live-read then delete, checked immediately
 * before the write-back) — the mutex alone does NOT close this because delete
 * is not under the ACL mutex.
 *
 * @param {object} deps
 * @param {object} deps.storage      RoomStorageBase-like { readAcl, writeAcl }
 * @param {string} deps.tenant
 * @param {string} deps.roomId
 * @param {{id:string,email?:string,name?:string}} deps.user
 * @param {(key:string, fn:()=>Promise)=>Promise} deps.withAclLock  seam 4
 * @param {(compositeKey:string)=>boolean} deps.isDeleted  SecWriterDatabase tombstone
 * @param {string} deps.compositeKey  buildCompositeDocName(tenant, roomId)
 * @param {number} deps.now
 * @param {number} deps.ttlMs
 * @param {object} deps.log
 */
async function promotePending({ storage, tenant, roomId, user, withAclLock, isDeleted, compositeKey, now, ttlMs, log }) {
  const email = normalizeEmail(user && user.email);
  await withAclLock(compositeKey, async () => {
    const acl = await storage.readAcl(tenant, roomId);
    if (!acl) return;                                    // blocker #2a: delete-then-read
    if (isDeleted && isDeleted(compositeKey)) return;    // blocker #2b: write-time tombstone
    // 2b is checked with NO await between here and writeAcl below (prune/bind/
    // display/exceedsAclByteCap are all synchronous), so no delete code can slip
    // into that gap on this thread. The residual is a filesystem-level interleave:
    // deleteRoom is NOT under this ACL mutex and does not await this direct
    // storage.writeAcl, so a writeAcl landing after deleteRoom's unlinks resurrects
    // a lone .acl.json. Bounded to a reclaimable 404 orphan (never an ownerless
    // .ydoc) because .acl.json is catalogued BEFORE .ydoc — acceptable under the
    // single-instance design (ADR-0017).

    // Fold current roles into the graded shape, migrating a legacy #211
    // `sharedWith` array into `roles` (each entry → editor) the SAME way the
    // share route does. Without this, a pre-#239 room ({ownerId, sharedWith})
    // would get a manufactured empty `roles:{}` persisted alongside the intact
    // sharedWith; roleOf prefers `roles` when present, so every sharedWith
    // member would silently resolve to null (and then be swept-kicked). We drop
    // the legacy key on write (see `delete next.sharedWith` below).
    const roles = {};
    let foldedSharedWith = false;
    if (acl.roles && typeof acl.roles === 'object') {
      for (const [uid, r] of Object.entries(acl.roles)) if (r === 'viewer' || r === 'editor') roles[uid] = r;
    } else if (Array.isArray(acl.sharedWith)) {
      for (const uid of acl.sharedWith) roles[uid] = 'editor';
      foldedSharedWith = true;
    }
    const pending = (acl.pending && typeof acl.pending === 'object') ? acl.pending : {};
    const display = (acl.display && typeof acl.display === 'object') ? acl.display : {};
    // Migrating sharedWith is itself a change worth persisting even if nothing
    // else moved, so the corrupting empty-roles shape never lands on disk.
    let changed = foldedSharedWith;

    // Prune every expired pending entry first (opportunistic GC). This also
    // drops the connecting user's OWN entry if it's expired, so the bind step
    // below only ever sees a live invite.
    for (const [e, entry] of Object.entries(pending)) {
      if (isPendingExpired(entry, now, ttlMs)) { delete pending[e]; changed = true; }
    }

    // Bind or upgrade THIS user's live invite, then drop it.
    if (email && pending[email] && user.id && user.id !== acl.ownerId) {
      const bound = roles[user.id];
      const winner = higherRole(bound, pending[email].role);
      if (winner && winner !== bound) { roles[user.id] = winner; changed = true; }
      delete pending[email]; changed = true;
    } else if (email && pending[email]) {
      // owner (or missing id) — never write into roles; just drop the entry.
      delete pending[email]; changed = true;
    }

    // Refresh the cosmetic display cache (self-asserted, NEVER authz input).
    if (user.id && user.id !== acl.ownerId) {
      const want = { name: user.name || null, email };
      const cur = display[user.id];
      if (!cur || cur.name !== want.name || cur.email !== want.email) { display[user.id] = want; changed = true; }
    }

    if (!changed) return;
    const next = { ...acl, roles, pending, display };
    delete next.sharedWith; // #239 folded into `roles` above; never persist the legacy key
    if (exceedsAclByteCap(next)) {
      if (log && log.warn) log.warn('promote.acl-too-large', { tenant, roomId });
      return; // access still correct via resolveRole; skip the write (seam 7)
    }
    await storage.writeAcl(tenant, roomId, next);
  });
}
module.exports = { promotePending };
