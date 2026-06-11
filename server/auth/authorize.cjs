/**
 * Room authorization decision function. See ADR-0017 + the design spec
 * (docs/superpowers/specs/2026-06-11-room-authorization-design.md).
 *
 * Returns { ok: true } or { ok: false, status } where status is one of
 * 401 (no token) / 403 (bad principal) / 404 (cross-tenant, not-shared,
 * missing ACL — existence is hidden). Demo (auth=none) early-returns allow.
 */
'use strict';

const { sanitize, PUBLIC_TENANT, ARCHIVE_NAMESPACE } = require('../storage-shared.cjs');

const ACTION = Object.freeze({
  READ: 'read',         // open WS, GET /sec, GET /comments, POST /upload, content PATCH
  DELETE: 'delete',
  SHARE: 'share',       // share-grant (PATCH /rooms/:id/share)
  LOCK_ADMIN: 'lock',   // lock fields on PATCH /rooms/:id
});

/**
 * Principal-level checks that need no room: token presence, tenant claim,
 * stable subject, and the _public sentinel reservation. Used directly by
 * routes without a room (GET /rooms) and as the first step of authorize().
 */
function checkPrincipal(authProvider, user) {
  if (!authProvider || !authProvider.requiresAuth) return { ok: true };
  if (!user) return { ok: false, status: 401 };
  if (!user.tenant) return { ok: false, status: 403 };
  if (!user.id) return { ok: false, status: 403 };
  // Namespace reservations: a token whose tenant sanitizes to _public would
  // address the auth=none demo namespace (cross-tenant leak); one that
  // sanitizes to 'archive' would address the adapters' archive prefix —
  // rooms created there are joinable but invisible to the active listings
  // and the sweep parsers (orphaned, unswept). Reject both.
  const t = sanitize(user.tenant);
  if (t === PUBLIC_TENANT || t === ARCHIVE_NAMESPACE) return { ok: false, status: 403 };
  return { ok: true };
}

/**
 * Pure read-permission predicate over an ACL sidecar. Shared by authorize()
 * and GET /rooms member-filtering so the owner/sharee rule has one home.
 * A null ACL never permits (legacy/orphan rooms are hidden under auth —
 * same semantics as the per-room 404).
 */
function aclAllowsRead(acl, userId) {
  if (!acl) return false;
  return acl.ownerId === userId ||
    (Array.isArray(acl.sharedWith) && acl.sharedWith.includes(userId));
}

async function authorize({ authProvider, storage, user, roomId, action }) {
  const pre = checkPrincipal(authProvider, user);
  if (!pre.ok) return pre;
  if (!authProvider || !authProvider.requiresAuth) return { ok: true }; // demo open

  // Cross-tenant is structural: the ACL is read under the CALLER's own tenant,
  // so a caller can only ever resolve rooms in its own namespace.
  // NOTE: user.tenant is passed RAW here — every adapter's _keyForArtifact is
  // the single place sanitize() is applied to tenant, and the WS docName is
  // built from sanitize(user.tenant) too, so the ACL-read key and the bound
  // doc agree (sanitize is idempotent). Do NOT move sanitize out of the
  // adapter, or this read diverges from the docName.
  const acl = await storage.readAcl(user.tenant, roomId);
  if (!acl) return { ok: false, status: 404 };

  if (action === ACTION.READ) {
    return aclAllowsRead(acl, user.id) ? { ok: true } : { ok: false, status: 404 };
  }
  // DELETE / SHARE / LOCK_ADMIN are owner-only.
  return acl.ownerId === user.id ? { ok: true } : { ok: false, status: 404 };
}

module.exports = { authorize, checkPrincipal, aclAllowsRead, ACTION };
