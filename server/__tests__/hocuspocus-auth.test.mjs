/**
 * Tests for server/hocuspocus-auth.cjs
 *
 * Uses Node's built-in test runner.
 * Run: node --test server/__tests__/hocuspocus-auth.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const { buildOnAuthenticate, AuthReject } = require_('../hocuspocus-auth.cjs');

// Auth provider that requires auth and trusts a fake token map.
function makeAuthProvider(validUsers) {
  return {
    requiresAuth: true,
    validateToken: async (tok) => validUsers[tok] || null,
  };
}
// Storage stub with an ACL map keyed `<tenant>/<roomId>`.
function makeStorage(acls) {
  return { readAcl: async (tenant, roomId) => acls[`${tenant}/${roomId}`] || null };
}

const userA = { id: 'sub-a', tenant: 'tenantA' };

test('rejects a non-canonical documentName with a slash in the room half', async () => {
  const onAuth = buildOnAuthenticate({
    authProvider: makeAuthProvider({ tokA: userA }),
    storage: makeStorage({ 'tenantA/room_1': { ownerId: 'sub-a', sharedWith: [] } }),
  });
  await assert.rejects(
    () => onAuth({ documentName: 'tenantA/room/1', token: 'tokA' }),
    (e) => e instanceof AuthReject && e.status === 404
  );
});

test('rejects a documentName whose room half is not already sanitize-stable', async () => {
  const onAuth = buildOnAuthenticate({
    authProvider: makeAuthProvider({ tokA: userA }),
    storage: makeStorage({}),
  });
  await assert.rejects(() => onAuth({ documentName: 'tenantA/room.1', token: 'tokA' }),
    (e) => e instanceof AuthReject && e.status === 404);
});

test('rejects a cross-tenant documentName (tenant-A token naming victimTenant)', async () => {
  const onAuth = buildOnAuthenticate({
    authProvider: makeAuthProvider({ tokA: userA }),
    storage: makeStorage({ 'victimTenant/room': { ownerId: 'someone', sharedWith: [] } }),
  });
  await assert.rejects(() => onAuth({ documentName: 'victimTenant/room', token: 'tokA' }),
    (e) => e instanceof AuthReject && e.status === 404);
});

test('rejects a no-slash documentName explicitly (no lenient _public fallback)', async () => {
  const onAuth = buildOnAuthenticate({
    authProvider: makeAuthProvider({ tokA: userA }),
    storage: makeStorage({}),
  });
  await assert.rejects(() => onAuth({ documentName: 'justaroom', token: 'tokA' }),
    (e) => e instanceof AuthReject && e.status === 404);
});

test('rejects missing tenant / subject / reserved sentinel via checkPrincipal (403)', async () => {
  const onAuth = buildOnAuthenticate({
    authProvider: makeAuthProvider({ noTenant: { id: 's' }, pub: { id: 's', tenant: '_public' } }),
    storage: makeStorage({}),
  });
  await assert.rejects(() => onAuth({ documentName: 'x/y', token: 'noTenant' }),
    (e) => e instanceof AuthReject && e.status === 403);
  await assert.rejects(() => onAuth({ documentName: '_public/y', token: 'pub' }),
    (e) => e instanceof AuthReject && e.status === 403);
});

test('accepts a canonical owner connection and returns the user context', async () => {
  const onAuth = buildOnAuthenticate({
    authProvider: makeAuthProvider({ tokA: userA }),
    storage: makeStorage({ 'tenantA/room1': { ownerId: 'sub-a', sharedWith: [] } }),
  });
  const ctx = await onAuth({ documentName: 'tenantA/room1', token: 'tokA' });
  assert.equal(ctx.user.id, 'sub-a');
});

test('rejects a canonical room the caller cannot read (not owner/sharee) with 404', async () => {
  const onAuth = buildOnAuthenticate({
    authProvider: makeAuthProvider({ tokA: userA }),
    storage: makeStorage({ 'tenantA/room1': { ownerId: 'other', sharedWith: [] } }),
  });
  await assert.rejects(() => onAuth({ documentName: 'tenantA/room1', token: 'tokA' }),
    (e) => e instanceof AuthReject && e.status === 404);
});

test('auth=none: canonical _public name accepted; non-canonical STILL rejected', async () => {
  const onAuth = buildOnAuthenticate({
    authProvider: { requiresAuth: false, validateToken: async () => null },
    storage: makeStorage({}),
  });
  const ctx = await onAuth({ documentName: '_public/anything', token: null });
  assert.equal(ctx.tenant, '_public');
  assert.equal(ctx.roomId, 'anything');
  assert.equal(ctx.acl, null);
  await assert.rejects(() => onAuth({ documentName: 'justaroom', token: null }),
    (e) => e instanceof AuthReject && e.status === 404);
  await assert.rejects(() => onAuth({ documentName: 'tenantX/room', token: null }),
    (e) => e instanceof AuthReject && e.status === 404);
  await assert.rejects(() => onAuth({ documentName: '_public/room.1', token: null }),
    (e) => e instanceof AuthReject && e.status === 404);
});
