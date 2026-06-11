import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { authorize, checkPrincipal, ACTION } = require('../authorize.cjs');

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
  it('owner can read + delete + share', async () => {
    for (const a of [ACTION.READ, ACTION.DELETE, ACTION.SHARE, ACTION.LOCK_ADMIN]) {
      assert.deepEqual(await authorize({ authProvider: authOn, storage, user: owner, roomId: 'r1', action: a }), { ok: true }, a);
    }
  });
  it('shared user can read but NOT delete/share', async () => {
    assert.deepEqual(await authorize({ authProvider: authOn, storage, user: friend, roomId: 'r1', action: ACTION.READ }), { ok: true });
    assert.equal((await authorize({ authProvider: authOn, storage, user: friend, roomId: 'r1', action: ACTION.DELETE })).status, 404);
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
