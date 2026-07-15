import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { promotePending } = require('../promote-pending.cjs');
const { createAclMutex } = require('../acl-mutex.cjs');
const { roleOf } = require('../auth/authorize.cjs');

const TTL = 30 * 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-07-14T00:00:00Z');
const iso = (ms) => new Date(ms).toISOString();
const log = { warn() {}, error() {}, info() {} };

// In-memory storage stub keyed by `${tenant}/${roomId}`.
function fakeStorage(initial) {
  const acls = { ...initial };
  return {
    writes: [],
    async readAcl(t, r) { const a = acls[`${t}/${r}`]; return a ? JSON.parse(JSON.stringify(a)) : null; },
    async writeAcl(t, r, acl) { acls[`${t}/${r}`] = acl; this.writes.push(JSON.parse(JSON.stringify(acl))); },
    _acls: acls,
  };
}
const deps = (storage, over = {}) => ({
  storage, tenant: 'acme', roomId: 'r1',
  user: { id: 'bob', email: 'bob@y.com', name: 'Bob B' },
  withAclLock: createAclMutex().withAclLock,
  isDeleted: () => false,
  compositeKey: 'acme/r1', now: NOW, ttlMs: TTL, log,
  ...over,
});

describe('promotePending (#267 seam 3)', () => {
  it('binds an unbound invite to the sub, then drops the pending entry', async () => {
    const s = fakeStorage({ 'acme/r1': { ownerId: 'owner', roles: {}, pending: { 'bob@y.com': { role: 'editor', invitedBy: 'owner', invitedAt: iso(NOW) } } } });
    await promotePending(deps(s));
    assert.equal(s._acls['acme/r1'].roles.bob, 'editor');
    assert.equal(s._acls['acme/r1'].pending['bob@y.com'], undefined);
    assert.deepEqual(s._acls['acme/r1'].display.bob, { name: 'Bob B', email: 'bob@y.com' });
  });
  it('upgrades a bound-lower sub (major #5)', async () => {
    const s = fakeStorage({ 'acme/r1': { ownerId: 'owner', roles: { bob: 'viewer' }, pending: { 'bob@y.com': { role: 'editor', invitedAt: iso(NOW) } } } });
    await promotePending(deps(s));
    assert.equal(s._acls['acme/r1'].roles.bob, 'editor');
  });
  it('no role change when already bound >= pending, but drops redundant pending', async () => {
    const s = fakeStorage({ 'acme/r1': { ownerId: 'owner', roles: { bob: 'editor' }, pending: { 'bob@y.com': { role: 'viewer', invitedAt: iso(NOW) }, 'x@y.com': { role: 'viewer', invitedAt: iso(NOW) } } } });
    await promotePending(deps(s));
    assert.equal(s._acls['acme/r1'].roles.bob, 'editor');
    assert.equal(s._acls['acme/r1'].pending['bob@y.com'], undefined);
  });
  it('prunes an expired entry for another user and writes', async () => {
    const s = fakeStorage({ 'acme/r1': { ownerId: 'owner', roles: {}, pending: { 'old@y.com': { role: 'viewer', invitedAt: iso(NOW - TTL - 1) } } } });
    await promotePending(deps(s, { user: { id: 'bob', email: 'bob@y.com', name: 'Bob' } }));
    assert.equal(s._acls['acme/r1'].pending['old@y.com'], undefined);
    assert.equal(s.writes.length, 1);
  });
  it('expired entry for the connecting user is pruned, NOT bound', async () => {
    const s = fakeStorage({ 'acme/r1': { ownerId: 'owner', roles: {}, pending: { 'bob@y.com': { role: 'editor', invitedAt: iso(NOW - TTL - 1) } } } });
    await promotePending(deps(s));
    assert.equal(s._acls['acme/r1'].roles.bob, undefined);
    assert.equal(s._acls['acme/r1'].pending['bob@y.com'], undefined);
  });
  it('writes nothing when nothing changed (idempotent second connect)', async () => {
    const s = fakeStorage({ 'acme/r1': { ownerId: 'owner', roles: { bob: 'editor' }, pending: {}, display: { bob: { name: 'Bob B', email: 'bob@y.com' } } } });
    await promotePending(deps(s));
    assert.equal(s.writes.length, 0);
  });
  it('refreshes a STALE display name for an already-bound user (display-only write)', async () => {
    const s = fakeStorage({ 'acme/r1': { ownerId: 'owner', roles: { bob: 'editor' }, pending: {}, display: { bob: { name: 'Old Name', email: 'bob@y.com' } } } });
    await promotePending(deps(s)); // user.name is 'Bob B'
    assert.equal(s._acls['acme/r1'].display.bob.name, 'Bob B');
    assert.equal(s.writes.length, 1);
  });
  it('delete-then-read: null ACL writes nothing (blocker #2a)', async () => {
    const s = fakeStorage({});
    await promotePending(deps(s));
    assert.equal(s.writes.length, 0);
  });
  it('write-time tombstone: live ACL but isDeleted → no write (blocker #2b)', async () => {
    const s = fakeStorage({ 'acme/r1': { ownerId: 'owner', roles: {}, pending: { 'bob@y.com': { role: 'editor', invitedAt: iso(NOW) } } } });
    await promotePending(deps(s, { isDeleted: () => true }));
    assert.equal(s.writes.length, 0);
  });
  it('oversize result is logged + skipped, no write (seam 7)', async () => {
    const pending = {};
    for (let i = 0; i < 20000; i++) pending[`u${i}@y.com`] = { role: 'viewer', invitedAt: iso(NOW) };
    pending['bob@y.com'] = { role: 'editor', invitedAt: iso(NOW) };
    const s = fakeStorage({ 'acme/r1': { ownerId: 'owner', roles: {}, pending } });
    await promotePending(deps(s));
    assert.equal(s.writes.length, 0);
  });
  it('owner connecting to own stray pending: entry dropped, never written to roles/display', async () => {
    const s = fakeStorage({ 'acme/r1': { ownerId: 'owner', roles: {}, pending: { 'owner@y.com': { role: 'editor', invitedAt: iso(NOW) } } } });
    await promotePending(deps(s, { user: { id: 'owner', email: 'owner@y.com', name: 'The Owner' } }));
    assert.equal(s._acls['acme/r1'].roles.owner, undefined, 'owner never gets a roles entry');
    assert.equal(s._acls['acme/r1'].pending['owner@y.com'], undefined, 'stray pending dropped');
    assert.equal((s._acls['acme/r1'].display || {}).owner, undefined, 'owner not written to display cache');
  });
  it('legacy sharedWith room: promote migrates to roles, sharee still resolves editor (C1)', async () => {
    // Pre-#239 shape: { ownerId, sharedWith:[alice] }, no roles map. A pending
    // invitee (bob) connecting must NOT strand alice by persisting an empty roles:{}.
    const s = fakeStorage({ 'acme/r1': { ownerId: 'owner', sharedWith: ['alice'], pending: { 'bob@y.com': { role: 'editor', invitedAt: iso(NOW) } } } });
    await promotePending(deps(s));
    const acl = s._acls['acme/r1'];
    assert.equal(acl.roles.alice, 'editor', 'legacy sharee folded into roles');
    assert.equal(acl.roles.bob, 'editor', 'pending invitee bound');
    assert.equal(acl.sharedWith, undefined, 'legacy sharedWith key dropped');
    assert.equal(roleOf(acl, 'alice'), 'editor', 'alice still resolves editor after promote');
  });
  it('legacy sharedWith room: a plain sharee connecting still migrates without stranding peers', async () => {
    const s = fakeStorage({ 'acme/r1': { ownerId: 'owner', sharedWith: ['alice', 'carol'] } });
    await promotePending(deps(s, { user: { id: 'alice', email: 'alice@y.com', name: 'Alice' } }));
    const acl = s._acls['acme/r1'];
    assert.equal(roleOf(acl, 'alice'), 'editor');
    assert.equal(roleOf(acl, 'carol'), 'editor', 'peer sharee not stranded');
    assert.equal(acl.sharedWith, undefined);
  });
});
