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
