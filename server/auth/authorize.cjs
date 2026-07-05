/**
 * Room authorization decision function. See ADR-0017 + the design spec
 * (docs/superpowers/specs/2026-06-11-room-authorization-design.md).
 *
 * Returns { ok: true, role } or { ok: false, status, role? } where status is
 * one of 401 (no token) / 403 (bad principal) / 404 (cross-tenant, not-shared,
 * missing ACL, or a capability denial — existence is hidden). `role` (#239) is
 * the caller's resolved role on success, and on a capability-denial 404.
 * Demo (auth=none) early-returns allow with no role.
 */
'use strict';

const { sanitize, PUBLIC_TENANT, ARCHIVE_NAMESPACE } = require('../storage-shared.cjs');

// #239: graded roles (viewer/editor/owner). READ is the connect/view gate
// (all three roles); WRITE is the content-mutation gate (editor + owner) —
// #211's binary model collapsed these because every sharee could write.
const ACTION = Object.freeze({
  READ: 'read',         // open WS (view), GET /sec, GET /comments
  WRITE: 'write',       // POST /upload, content mutation
  DELETE: 'delete',
  SHARE: 'share',       // share-grant / role-grant (PATCH /rooms/:id/share)
  LOCK_ADMIN: 'lock',   // lock fields on PATCH /rooms/:id
});

// #239: valid role lattice. owner ⊃ editor ⊃ viewer. Owner is implicit from
// acl.ownerId; viewer/editor live in acl.roles. The share route rejects
// anything outside {viewer, editor} (owner is not grantable — ownership
// transfer is a separate, out-of-scope concern).
const ROLE = Object.freeze({ VIEWER: 'viewer', EDITOR: 'editor', OWNER: 'owner' });
const GRANTABLE_ROLES = Object.freeze(['viewer', 'editor']);

// role → allowed actions. The single source of truth for "who can do what".
const ROLE_ACTIONS = Object.freeze({
  viewer: Object.freeze([ACTION.READ]),
  editor: Object.freeze([ACTION.READ, ACTION.WRITE]),
  owner: Object.freeze([ACTION.READ, ACTION.WRITE, ACTION.DELETE, ACTION.SHARE, ACTION.LOCK_ADMIN]),
});

/**
 * Resolve a user's effective role on a room from its ACL sidecar. Returns
 * 'owner' | 'editor' | 'viewer' | null (null = no access).
 *
 * Lazy floor-shape migration (#239): a #211 sidecar has `sharedWith[]` and no
 * `roles`; every entry in it is treated as an EDITOR (the binary sharee
 * capability was read+write). New writes emit the `roles` map; both shapes
 * read here so no data migration script is needed. If BOTH keys are present
 * (a room shared post-migration), `roles` wins and `sharedWith` is ignored.
 */
function roleOf(acl, userId) {
  if (!acl || !userId) return null;
  if (acl.ownerId === userId) return ROLE.OWNER;
  if (acl.roles && typeof acl.roles === 'object') {
    const r = acl.roles[userId];
    return (r === ROLE.VIEWER || r === ROLE.EDITOR) ? r : null;
  }
  if (Array.isArray(acl.sharedWith) && acl.sharedWith.includes(userId)) return ROLE.EDITOR;
  return null;
}

/** True when `role` (may be null) is permitted to perform `action`. */
function roleCan(role, action) {
  if (!role) return false;
  const allowed = ROLE_ACTIONS[role];
  return !!allowed && allowed.includes(action);
}

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
 * same semantics as the per-room 404). Any non-null role (viewer included)
 * permits READ — viewers must be able to open the room, just not write.
 */
function aclAllowsRead(acl, userId) {
  return roleCan(roleOf(acl, userId), ACTION.READ);
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

  const role = roleOf(acl, user.id);
  // Uniform 404 for every denial (no role, or a role lacking the requested
  // capability). This preserves #211's no-existence-leak posture — the same
  // opaque failure for "can't see it" and "can't do that" — rather than
  // splitting into 403 for capability failures. The viewer read-only boundary
  // is enforced at the WS layer (data.connection.readOnly) and the HTTP WRITE
  // gate, not by re-statusing authorize denials. Established tests
  // (editor DELETE → 404, editor lock-PATCH → 404) pin this.
  if (!role || !roleCan(role, action)) return { ok: false, status: 404, role };
  return { ok: true, role };
}

module.exports = {
  authorize, checkPrincipal, aclAllowsRead,
  roleOf, roleCan, ACTION, ROLE, ROLE_ACTIONS, GRANTABLE_ROLES,
};
