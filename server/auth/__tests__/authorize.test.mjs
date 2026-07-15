import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { authorize, checkPrincipal, roleOf, ACTION } = require('../authorize.cjs');

const authOn = { requiresAuth: true };
const authOff = { requiresAuth: false };

// Fake storage: ACLs keyed by `${tenant}/${roomId}`.
function fakeStorage(acls) {
  return { async readAcl(tenant, roomId) { return acls[`${tenant}/${roomId}`] || null; } };
}

describe('checkPrincipal', () => {
  it('auth off → always ok', () => {
    assert.deepEqual(checkPrincipal(authOff, null), { ok: true });
  });
  it('auth on: no user → 401; no tenant → 403; no id → 403; sentinel tenant → 403', () => {
    assert.equal(checkPrincipal(authOn, null).status, 401);
    assert.equal(checkPrincipal(authOn, { id: 'u1' }).status, 403);            // no tenant
    assert.equal(checkPrincipal(authOn, { tenant: 'acme' }).status, 403);      // no id
    assert.equal(checkPrincipal(authOn, { id: 'u1', tenant: '_public' }).status, 403); // sentinel
    assert.equal(checkPrincipal(authOn, { id: 'u1', tenant: '.public' }).status, 403, 'sanitizes to _public → rejected');
    assert.equal(checkPrincipal(authOn, { id: 'u1', tenant: ' public' }).status, 403, 'sanitizes to _public → rejected');
    // 'archive' is the adapters' archive-namespace prefix — a token tenant
    // landing there would create rooms inside the archive tree: joinable,
    // but invisible to the active listings and the sweep parsers.
    assert.equal(checkPrincipal(authOn, { id: 'u1', tenant: 'archive' }).status, 403, 'archive namespace reserved');
    // '../etc' sanitizes to '___etc' (NOT _public), so the principal is OK —
    // it harmlessly addresses its own sanitized namespace.
    assert.deepEqual(checkPrincipal(authOn, { id: 'u1', tenant: '../etc' }), { ok: true });
    assert.deepEqual(checkPrincipal(authOn, { id: 'u1', tenant: 'acme' }), { ok: true });
  });
});

describe('authorize', () => {
  const storage = fakeStorage({
    'acme/r1': { ownerId: 'owner', sharedWith: ['friend'] },
  });
  const owner = { id: 'owner', tenant: 'acme' };
  const friend = { id: 'friend', tenant: 'acme' };
  const stranger = { id: 'stranger', tenant: 'acme' };
  const otherTenant = { id: 'owner', tenant: 'evilcorp' };

  it('auth off → allow', async () => {
    assert.deepEqual(await authorize({ authProvider: authOff, storage, user: null, roomId: 'r1', action: ACTION.DELETE }), { ok: true });
  });
  it('owner can read + write + delete + share; result carries role', async () => {
    for (const a of [ACTION.READ, ACTION.WRITE, ACTION.DELETE, ACTION.SHARE, ACTION.LOCK_ADMIN]) {
      const dec = await authorize({ authProvider: authOn, storage, user: owner, roomId: 'r1', action: a });
      assert.deepEqual(dec, { ok: true, role: 'owner' }, a);
    }
  });
  it('legacy sharedWith sharee resolves to editor: read+write ok, delete/share NOT (404)', async () => {
    // #239 floor-shape migration: a #211 { sharedWith: ['friend'] } sidecar
    // grants EDITOR (read+write) with no code migration.
    assert.equal(roleOf({ ownerId: 'owner', sharedWith: ['friend'] }, 'friend'), 'editor');
    for (const a of [ACTION.READ, ACTION.WRITE]) {
      assert.deepEqual(await authorize({ authProvider: authOn, storage, user: friend, roomId: 'r1', action: a }), { ok: true, role: 'editor' }, a);
    }
    assert.equal((await authorize({ authProvider: authOn, storage, user: friend, roomId: 'r1', action: ACTION.DELETE })).status, 404);
  });
  it('#239 graded roles table: viewer READ ok but WRITE denied; editor READ+WRITE', async () => {
    const graded = fakeStorage({
      'acme/g': { ownerId: 'owner', roles: { vi: 'viewer', ed: 'editor' } },
    });
    const viewer = { id: 'vi', tenant: 'acme' };
    const editor = { id: 'ed', tenant: 'acme' };
    assert.deepEqual(await authorize({ authProvider: authOn, storage: graded, user: viewer, roomId: 'g', action: ACTION.READ }), { ok: true, role: 'viewer' });
    assert.equal((await authorize({ authProvider: authOn, storage: graded, user: viewer, roomId: 'g', action: ACTION.WRITE })).status, 404);
    assert.deepEqual(await authorize({ authProvider: authOn, storage: graded, user: editor, roomId: 'g', action: ACTION.READ }), { ok: true, role: 'editor' });
    assert.deepEqual(await authorize({ authProvider: authOn, storage: graded, user: editor, roomId: 'g', action: ACTION.WRITE }), { ok: true, role: 'editor' });
    // roles wins over a stale sharedWith when both present.
    assert.equal(roleOf({ ownerId: 'o', roles: { u: 'viewer' }, sharedWith: ['u'] }, 'u'), 'viewer');
  });
  it('stranger same-tenant → 404 (no existence leak)', async () => {
    assert.equal((await authorize({ authProvider: authOn, storage, user: stranger, roomId: 'r1', action: ACTION.READ })).status, 404);
  });
  it('cross-tenant → 404 structurally (reads ACL under caller tenant, which is absent)', async () => {
    assert.equal((await authorize({ authProvider: authOn, storage, user: otherTenant, roomId: 'r1', action: ACTION.READ })).status, 404);
  });
  it('missing ACL → 404', async () => {
    assert.equal((await authorize({ authProvider: authOn, storage, user: owner, roomId: 'ghost', action: ACTION.READ })).status, 404);
  });
});

const { normalizeEmail, isValidEmailShape, higherRole, pendingInviteTtlMs, exceedsAclByteCap, MAX_PENDING_INVITES } = require('../authorize.cjs');

describe('share-by-email helpers (#267)', () => {
  it('normalizeEmail lowercases + trims; non-strings → ""', () => {
    assert.equal(normalizeEmail('  Bob@Corp.COM '), 'bob@corp.com');
    assert.equal(normalizeEmail(''), '');
    assert.equal(normalizeEmail(undefined), '');
    assert.equal(normalizeEmail(null), '');
    assert.equal(normalizeEmail(42), '');
  });
  it('isValidEmailShape basic check', () => {
    assert.equal(isValidEmailShape('bob@corp.com'), true);
    assert.equal(isValidEmailShape('bob@corp'), false);
    assert.equal(isValidEmailShape('bobcorp.com'), false);
    assert.equal(isValidEmailShape('a b@corp.com'), false);
    assert.equal(isValidEmailShape(''), false);
  });
  it('higherRole picks the higher on editor>viewer, null-safe', () => {
    assert.equal(higherRole(null, 'viewer'), 'viewer');
    assert.equal(higherRole('viewer', 'editor'), 'editor');
    assert.equal(higherRole('editor', 'viewer'), 'editor');
    assert.equal(higherRole('editor', 'editor'), 'editor');
    assert.equal(higherRole(null, null), null);
  });
  it('pendingInviteTtlMs: default when unset; invalid → default (no disable)', () => {
    const D = 30 * 24 * 60 * 60 * 1000;
    delete process.env.SIM_PENDING_INVITE_TTL_MS;
    assert.equal(pendingInviteTtlMs(), D);
    process.env.SIM_PENDING_INVITE_TTL_MS = '1000';
    assert.equal(pendingInviteTtlMs(), 1000);
    for (const bad of ['0', '-5', 'NaN', 'abc']) {
      process.env.SIM_PENDING_INVITE_TTL_MS = bad;
      assert.equal(pendingInviteTtlMs(), D, `${bad} → default`);
    }
    delete process.env.SIM_PENDING_INVITE_TTL_MS;
  });
  it('exceedsAclByteCap flags oversize blobs', () => {
    assert.equal(exceedsAclByteCap({ ownerId: 'o', roles: {} }), false);
    const big = { ownerId: 'o', roles: {}, pending: {} };
    for (let i = 0; i < 20000; i++) big.pending[`user${i}@corp.com`] = { role: 'viewer', invitedBy: 'o', invitedAt: '2026-01-01T00:00:00Z' };
    assert.equal(exceedsAclByteCap(big), true);
  });
  it('MAX_PENDING_INVITES is a positive integer', () => {
    assert.equal(Number.isInteger(MAX_PENDING_INVITES) && MAX_PENDING_INVITES > 0, true);
  });
});

const { resolveRole } = require('../authorize.cjs');

describe('resolveRole (#267)', () => {
  const NOW = Date.parse('2026-07-14T00:00:00Z');
  const TTL = 30 * 24 * 60 * 60 * 1000;
  const iso = (ms) => new Date(ms).toISOString();
  const aclWith = (over) => ({ ownerId: 'owner', roles: {}, pending: {}, ...over });

  it('roles-hit → bound role, viaPending false', () => {
    const acl = aclWith({ roles: { u1: 'editor' } });
    assert.deepEqual(resolveRole(acl, { id: 'u1', email: 'x@y.com' }, NOW, TTL), { role: 'editor', viaPending: false });
  });
  it('owner short-circuits (never downgraded by a stray pending)', () => {
    const acl = aclWith({ pending: { 'owner@y.com': { role: 'viewer', invitedAt: iso(NOW) } } });
    assert.deepEqual(resolveRole(acl, { id: 'owner', email: 'owner@y.com' }, NOW, TTL), { role: 'owner', viaPending: false });
  });
  it('pending-hit unbound → pending role, viaPending true', () => {
    const acl = aclWith({ pending: { 'bob@y.com': { role: 'editor', invitedAt: iso(NOW) } } });
    assert.deepEqual(resolveRole(acl, { id: 'bob', email: 'BOB@y.com' }, NOW, TTL), { role: 'editor', viaPending: true });
  });
  it('both present, bound >= pending → bound wins, viaPending false', () => {
    const acl = aclWith({ roles: { bob: 'editor' }, pending: { 'bob@y.com': { role: 'viewer', invitedAt: iso(NOW) } } });
    assert.deepEqual(resolveRole(acl, { id: 'bob', email: 'bob@y.com' }, NOW, TTL), { role: 'editor', viaPending: false });
  });
  it('both present, equal role → bound wins, viaPending false (tie)', () => {
    const acl = aclWith({ roles: { bob: 'editor' }, pending: { 'bob@y.com': { role: 'editor', invitedAt: iso(NOW) } } });
    assert.deepEqual(resolveRole(acl, { id: 'bob', email: 'bob@y.com' }, NOW, TTL), { role: 'editor', viaPending: false });
  });
  it('both present, pending higher → upgrade, viaPending true (major #5)', () => {
    const acl = aclWith({ roles: { bob: 'viewer' }, pending: { 'bob@y.com': { role: 'editor', invitedAt: iso(NOW) } } });
    assert.deepEqual(resolveRole(acl, { id: 'bob', email: 'bob@y.com' }, NOW, TTL), { role: 'editor', viaPending: true });
  });
  it('blank/missing email never matches pending (decision #5)', () => {
    const acl = aclWith({ pending: { 'bob@y.com': { role: 'editor', invitedAt: iso(NOW) } } });
    assert.deepEqual(resolveRole(acl, { id: 'bob', email: '' }, NOW, TTL), { role: null, viaPending: false });
    assert.deepEqual(resolveRole(acl, { id: 'bob' }, NOW, TTL), { role: null, viaPending: false });
  });
  it('expired / unparseable / future invitedAt all fail-closed', () => {
    const mk = (invitedAt) => aclWith({ pending: { 'bob@y.com': { role: 'editor', invitedAt } } });
    const u = { id: 'bob', email: 'bob@y.com' };
    assert.equal(resolveRole(mk(iso(NOW - TTL - 1)), u, NOW, TTL).role, null, 'expired');
    assert.equal(resolveRole(mk('not-a-date'), u, NOW, TTL).role, null, 'unparseable');
    assert.equal(resolveRole(mk(undefined), u, NOW, TTL).role, null, 'missing');
    assert.equal(resolveRole(mk(iso(NOW + 60000)), u, NOW, TTL).role, null, 'future');
  });
  it('no pending, no roles → null', () => {
    assert.deepEqual(resolveRole(aclWith({}), { id: 'z', email: 'z@y.com' }, NOW, TTL), { role: null, viaPending: false });
  });
});

describe('authorize() honors pending invites (#267)', () => {
  const storage = { async readAcl(t, r) {
    return t === 'acme' && r === 'r1'
      ? { ownerId: 'owner', roles: {}, pending: { 'bob@y.com': { role: 'editor', invitedAt: new Date().toISOString() } } }
      : null;
  } };
  const authOn = { requiresAuth: true };
  it('pending invitee passes READ + WRITE over HTTP before bind persists', async () => {
    const bob = { id: 'bob', tenant: 'acme', email: 'bob@y.com' };
    assert.deepEqual(await authorize({ authProvider: authOn, storage, user: bob, roomId: 'r1', action: ACTION.READ }), { ok: true, role: 'editor' });
    assert.deepEqual(await authorize({ authProvider: authOn, storage, user: bob, roomId: 'r1', action: ACTION.WRITE }), { ok: true, role: 'editor' });
  });
  it('pending invitee is NOT owner: DELETE → 404', async () => {
    const bob = { id: 'bob', tenant: 'acme', email: 'bob@y.com' };
    const dec = await authorize({ authProvider: authOn, storage, user: bob, roomId: 'r1', action: ACTION.DELETE });
    assert.equal(dec.status, 404);
  });
  it('non-invitee with no roles entry still 404', async () => {
    const z = { id: 'z', tenant: 'acme', email: 'z@y.com' };
    assert.equal((await authorize({ authProvider: authOn, storage, user: z, roomId: 'r1', action: ACTION.READ })).status, 404);
  });
});
