# Share-by-email room sharing (issue #267) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a room owner share by typing a collaborator's email; the invite binds to that person's stable subject id at their first login, and the invited room shows up in their own room list.

**Architecture:** No new storage artifact — everything rides the existing per-room `.acl.json`, which gains a `pending` (email→invite) map and a `display` (sub→name/email) cache. One pure `resolveRole(acl, user, now, ttlMs)` decision is used by HTTP `authorize()`, WS `onAuthenticate`, the revoke sweep, and the `GET /rooms` listing. A fire-and-forget `promotePending` at WS connect persists the bind under a shared per-composite-key ACL mutex. Email is an authorization INPUT (reverses ADR-0017 decision 6) — safe only under the hard IdP precondition that `email` is verified/immutable/unique-per-subject.

**Tech Stack:** Node ≥22, CJS server modules (ADR-0001), Yjs + Hocuspocus v4 relay, `node --test` server suite (`npm run test:server`), Vitest for the React `ShareDialog` (`npm test`).

**Spec:** `docs/superpowers/specs/2026-07-14-share-by-email-design.md`. Read it before starting — this plan implements its seams 1–7.

---

## File Structure

**Modified:**
- `server/auth/authorize.cjs` — add `resolveRole`, `normalizeEmail`, `isValidEmailShape`, `pendingInviteTtlMs`, `higherRole`, `exceedsAclByteCap`, the `pendingRoleFor`/`isPendingExpired` internals, and the `MAX_PENDING_INVITES`/`MAX_ACL_BYTES` constants; switch `authorize()` to `resolveRole`.
- `server/hocuspocus-auth.cjs` — switch the WS admit-gate + role/readOnly to `resolveRole`.
- `server/secwriter-database.cjs` — expose `isDeleted(documentName)`.
- `server/collab-server.cjs` — instantiate the ACL mutex, thread it into `createHttpHandler`; fire-and-forget `promotePending` in the `onAuthenticate` wrapper; add the `{ emails }` selector to `revokeLiveSessions`; switch the revoke sweep to `resolveRole`.
- `server/http-handler.cjs` — email branch + full-object RMW + caps + pending-remove kick in `PATCH /:id/share`; `pending`+`display` in `GET /:id/acl`; `resolveRole` + `viaPending` in `GET /rooms`.
- `src/components/ShareDialog.jsx` — email input, pending list, `display` names, `refresh()` after email add, "Copy room link".
- `src/App.jsx` — `onShareRoom` passes `email` through.

**Created:**
- `server/acl-mutex.cjs` — `createAclMutex()` → `{ withAclLock }` (seam 4).
- `server/promote-pending.cjs` — `promotePending(...)` (seam 3).
- `server/__tests__/promote-pending.test.mjs`, `server/__tests__/acl-mutex.test.mjs`.
- `server/__tests__/http-share-email.test.mjs` — the #267 HTTP endpoint tests (a NEW file, not appended to `http-endpoints.test.mjs`, which is already at the ≤30-test cap).

**Test files touched (appended to):** `server/auth/__tests__/authorize.test.mjs`, `server/__tests__/hocuspocus-auth.test.mjs`, `server/__tests__/secwriter-database.test.mjs`, `server/__tests__/hocuspocus-server.test.mjs`, `src/components/__tests__/ShareDialog.test.jsx`. (`http-endpoints.test.mjs` is RUN for regression but NOT appended to — it is at the cap.)

---

## Task 1: authorize.cjs — pure helpers + constants

**Files:**
- Modify: `server/auth/authorize.cjs`
- Test: `server/auth/__tests__/authorize.test.mjs`

- [ ] **Step 1: Write the failing test** — append to `authorize.test.mjs`. The file uses `require` (not ESM import), so pull the new symbols from a fresh require line:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:server -- --test-name-pattern="share-by-email helpers"`
Expected: FAIL (`normalizeEmail is not a function` / undefined imports).

- [ ] **Step 3: Add the helpers to `authorize.cjs`** — insert after the `ROLE_ACTIONS` block (before `roleOf`):

```js
// ── Share-by-email (#267) ────────────────────────────────────────────────
// Per-room bound on live pending invites, and a hard byte ceiling on the whole
// .acl.json blob — the WS connect path JSON.stringify+RMWs it every session, so
// unbounded pending/display growth degrades a hot path. See the design spec.
const MAX_PENDING_INVITES = 200;
const MAX_ACL_BYTES = 256 * 1024;
const DEFAULT_PENDING_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// Grantable-role rank for "take the higher role" comparisons. owner is implicit
// (never grantable/pending) and is handled by a short-circuit in resolveRole.
const ROLE_RANK = Object.freeze({ viewer: 1, editor: 2 });

/** lower(trim(s)); non-strings → "". Single normalizer for every email compare. */
function normalizeEmail(s) {
  return typeof s === 'string' ? s.trim().toLowerCase() : '';
}

/** Cheap shape check (no MX/deliverability): one @, a dot in the domain, no spaces. */
function isValidEmailShape(s) {
  return typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

/** Higher of two grantable roles on editor>viewer. Null-safe (unknown ranks 0). */
function higherRole(a, b) {
  const ra = ROLE_RANK[a] || 0;
  const rb = ROLE_RANK[b] || 0;
  if (ra === 0 && rb === 0) return null;
  return ra >= rb ? a : b;
}

let _ttlWarned = false;
/**
 * TTL for pending invites, from SIM_PENDING_INVITE_TTL_MS. A non-finite or
 * <= 0 value logs ONCE and falls back to the 30-day default — it NEVER silently
 * disables sharing (that would leave every invite permanently expired).
 */
function pendingInviteTtlMs() {
  const raw = process.env.SIM_PENDING_INVITE_TTL_MS;
  if (raw === undefined || raw === '') return DEFAULT_PENDING_TTL_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    if (!_ttlWarned) {
      _ttlWarned = true;
      console.error(`[authorize] SIM_PENDING_INVITE_TTL_MS="${raw}" invalid (non-finite or <=0); using ${DEFAULT_PENDING_TTL_MS}ms. Share-by-email stays ENABLED.`);
    }
    return DEFAULT_PENDING_TTL_MS;
  }
  return n;
}

/** True when the serialized ACL would exceed the byte ceiling (seam 7). */
function exceedsAclByteCap(acl) {
  return Buffer.byteLength(JSON.stringify(acl), 'utf-8') > MAX_ACL_BYTES;
}
```

- [ ] **Step 4: Export the helpers** — extend `module.exports` at the bottom:

```js
module.exports = {
  authorize, checkPrincipal, aclAllowsRead,
  roleOf, roleCan, ACTION, ROLE, ROLE_ACTIONS, GRANTABLE_ROLES,
  // #267 share-by-email
  normalizeEmail, isValidEmailShape, higherRole, pendingInviteTtlMs,
  exceedsAclByteCap, MAX_PENDING_INVITES, MAX_ACL_BYTES,
};
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm run test:server -- --test-name-pattern="share-by-email helpers"`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/auth/authorize.cjs server/auth/__tests__/authorize.test.mjs
git commit -F- <<'EOF'
feat(server): add share-by-email pure helpers to authorize.cjs (#267)

normalizeEmail / isValidEmailShape / higherRole / pendingInviteTtlMs /
exceedsAclByteCap + MAX_PENDING_INVITES / MAX_ACL_BYTES. Pure + table-tested.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
```

---

## Task 2: authorize.cjs — resolveRole

**Files:**
- Modify: `server/auth/authorize.cjs`
- Test: `server/auth/__tests__/authorize.test.mjs`

- [ ] **Step 1: Write the failing test** — append to `authorize.test.mjs`:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:server -- --test-name-pattern="resolveRole"`
Expected: FAIL (`resolveRole is not a function`).

- [ ] **Step 3: Add `resolveRole` + internals to `authorize.cjs`** — insert after `aclAllowsRead` (before `authorize`):

```js
/**
 * Fail-closed expiry for a pending entry. Missing/unparseable invitedAt, a
 * non-finite age, or a FUTURE invitedAt (backward clock step) all count as
 * expired. Pure — caller supplies now/ttlMs.
 */
function isPendingExpired(entry, now, ttlMs) {
  const t = Date.parse(entry && entry.invitedAt);
  if (!Number.isFinite(t)) return true;
  const age = now - t;
  if (!Number.isFinite(age)) return true;
  if (age < 0) return true;
  return age >= ttlMs;
}

/** Non-expired pending role matching the user's token email, else null. */
function pendingRoleFor(acl, user, now, ttlMs) {
  if (!acl || !acl.pending || typeof acl.pending !== 'object') return null;
  const email = normalizeEmail(user && user.email);
  if (!email) return null; // blank-email guard (decision #5)
  const entry = acl.pending[email];
  if (!entry || (entry.role !== 'viewer' && entry.role !== 'editor')) return null;
  if (isPendingExpired(entry, now, ttlMs)) return null;
  return entry.role;
}

/**
 * Effective role INCLUDING an unbound pending-by-email invite (#267). Pure —
 * caller supplies now/ttlMs (table-testable, no clock/env read). Returns
 * { role, viaPending }; viaPending is true only when the pending invite is what
 * grants or upgrades the role. Owner short-circuits so a stray pending entry
 * can never downgrade an owner.
 */
function resolveRole(acl, user, now, ttlMs) {
  const bound = roleOf(acl, user && user.id);
  if (bound === ROLE.OWNER) return { role: ROLE.OWNER, viaPending: false };
  const pendRole = pendingRoleFor(acl, user, now, ttlMs);
  if (!pendRole) return { role: bound, viaPending: false };
  const winner = higherRole(bound, pendRole);
  return { role: winner, viaPending: winner === pendRole && winner !== bound };
}
```

- [ ] **Step 4: Export `resolveRole` + internals** — extend the `module.exports` `// #267 share-by-email` line:

```js
  // #267 share-by-email
  normalizeEmail, isValidEmailShape, higherRole, pendingInviteTtlMs,
  exceedsAclByteCap, MAX_PENDING_INVITES, MAX_ACL_BYTES,
  resolveRole, pendingRoleFor, isPendingExpired,
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm run test:server -- --test-name-pattern="resolveRole"`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/auth/authorize.cjs server/auth/__tests__/authorize.test.mjs
git commit -F- <<'EOF'
feat(server): add resolveRole pending-invite decision (#267)

Pure { role, viaPending } over roles + pending, owner short-circuit,
fail-closed expiry (unparseable/future invitedAt), higher-of-bound/pending.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
```

---

## Task 3: authorize() uses resolveRole

**Files:**
- Modify: `server/auth/authorize.cjs:114` (the `roleOf` call inside `authorize`)
- Test: `server/auth/__tests__/authorize.test.mjs`

- [ ] **Step 1: Write the failing test** — append:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:server -- --test-name-pattern="authorize\\(\\) honors pending"`
Expected: FAIL (bob gets 404 — `roleOf` ignores `pending`).

- [ ] **Step 3: Swap the role read** — in `authorize.cjs`, replace:

```js
  const role = roleOf(acl, user.id);
```

with:

```js
  // #267: resolveRole (not bare roleOf) so a pending-by-email invitee passes
  // the capability check immediately, before the connect-time bind persists.
  // authorize() is the impure adapter — it reads the clock + TTL here and feeds
  // them to the pure resolveRole; the purity boundary stays at resolveRole.
  const { role } = resolveRole(acl, user, Date.now(), pendingInviteTtlMs());
```

(Leave the following `if (!role || !roleCan(role, action)) ...` line unchanged.)

- [ ] **Step 4: Run the full authorize suite**

Run: `npm run test:server -- server/auth/__tests__/authorize.test.mjs`
Expected: PASS (existing owner/editor/viewer tests still green; new pending tests green).

- [ ] **Step 5: Commit**

```bash
git add server/auth/authorize.cjs server/auth/__tests__/authorize.test.mjs
git commit -F- <<'EOF'
feat(server): authorize() reads resolveRole so HTTP honors pending (#267)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
```

---

## Task 4: WS onAuthenticate uses resolveRole

**Files:**
- Modify: `server/hocuspocus-auth.cjs:20` (imports), `:63-75` (admit-gate + role)
- Test: `server/__tests__/hocuspocus-auth.test.mjs`

- [ ] **Step 1: Write the failing test** — append a case to `hocuspocus-auth.test.mjs` (match its existing harness; it builds `buildOnAuthenticate({ authProvider, storage })`, calls `onAuthenticate({ documentName, token })`, and stubs `authProvider.validateToken`). **This file imports only `test` from `node:test` and uses `test(...)` — NOT `it(...)`. Bare `it()` throws `ReferenceError` at module load and takes down the whole file, so write the new cases as `test(...)`.** Add:

```js
test('#267: pending-by-email invitee is admitted read-write (editor)', async () => {
  const storage = { async readAcl() {
    return { ownerId: 'owner', roles: {}, pending: { 'bob@y.com': { role: 'editor', invitedAt: new Date().toISOString() } } };
  } };
  const authProvider = { requiresAuth: true, async validateToken() { return { id: 'bob', tenant: 'acme', email: 'bob@y.com' }; } };
  const onAuth = buildOnAuthenticate({ authProvider, storage });
  const ctx = await onAuth({ documentName: 'acme/r1', token: 't' });
  assert.equal(ctx.role, 'editor');
  assert.equal(ctx.readOnly, false);
});
test('#267: pending viewer invitee is admitted read-only', async () => {
  const storage = { async readAcl() {
    return { ownerId: 'owner', roles: {}, pending: { 'bob@y.com': { role: 'viewer', invitedAt: new Date().toISOString() } } };
  } };
  const authProvider = { requiresAuth: true, async validateToken() { return { id: 'bob', tenant: 'acme', email: 'bob@y.com' }; } };
  const onAuth = buildOnAuthenticate({ authProvider, storage });
  const ctx = await onAuth({ documentName: 'acme/r1', token: 't' });
  assert.equal(ctx.role, 'viewer');
  assert.equal(ctx.readOnly, true);
});
```

(If the file lacks the `buildOnAuthenticate` import at top, add `const { buildOnAuthenticate } = require('../hocuspocus-auth.cjs');` alongside the existing requires.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:server -- --test-name-pattern="#267"`
Expected: FAIL (invitee rejected — `aclAllowsRead` throws `not-shared` before role logic).

- [ ] **Step 3: Switch the imports** — in `hocuspocus-auth.cjs` replace line 20:

```js
const { checkPrincipal, aclAllowsRead, roleOf, ROLE } = require('./auth/authorize.cjs');
```

with:

```js
const { checkPrincipal, resolveRole, pendingInviteTtlMs, ROLE } = require('./auth/authorize.cjs');
```

- [ ] **Step 4: Switch the admit-gate + role** — replace lines 63-75 (the block from `const acl = await storage.readAcl(...)` through the `return { user, tenant, roomId, acl, role, readOnly: ... }`):

```js
    const acl = await storage.readAcl(tenant, roomId);
    if (!acl) throw new AuthReject(404, 'no-acl');
    // #267: one resolveRole decision for admit + role + readOnly. A pending-by-
    // email invitee has no `roles` entry, so the old aclAllowsRead(roleOf) gate
    // rejected them before the role logic ran. resolveRole covers pending, so a
    // valid invitee connects; a genuine non-member still resolves to null → 404.
    const { role } = resolveRole(acl, user, Date.now(), pendingInviteTtlMs());
    if (!role) throw new AuthReject(404, 'not-shared');
    return { user, tenant, roomId, acl, role, readOnly: role === ROLE.VIEWER };
```

- [ ] **Step 5: Run the WS auth suite**

Run: `npm run test:server -- server/__tests__/hocuspocus-auth.test.mjs`
Expected: PASS (existing reject/cross-tenant tests green; new #267 tests green).

- [ ] **Step 6: Commit**

```bash
git add server/hocuspocus-auth.cjs server/__tests__/hocuspocus-auth.test.mjs
git commit -F- <<'EOF'
feat(server): WS onAuthenticate admits pending-by-email invitees (#267)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
```

---

## Task 5: SecWriterDatabase.isDeleted predicate

**Files:**
- Modify: `server/secwriter-database.cjs` (add method after `unmarkDeleted`)
- Test: `server/__tests__/secwriter-database.test.mjs`

- [ ] **Step 1: Write the failing test** — append (match the file's harness for constructing a `SecWriterDatabase`). **This file uses `test(...)` (via `const { test } = require('node:test')`), NOT `it(...)` — bare `it()` throws `ReferenceError` and kills the whole file.** Write:

```js
test('#267: isDeleted reflects the tombstone state', () => {
  const db = new SecWriterDatabase({ storage: {}, roomHealth: new Map(), maxDocBytes: 1e9, log: { warn() {}, error() {} } });
  assert.equal(db.isDeleted('acme/r1'), false);
  db.markDeleted('acme/r1');
  assert.equal(db.isDeleted('acme/r1'), true);
  db.unmarkDeleted('acme/r1');
  assert.equal(db.isDeleted('acme/r1'), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:server -- --test-name-pattern="isDeleted reflects"`
Expected: FAIL (`db.isDeleted is not a function`).

- [ ] **Step 3: Add the method** — in `secwriter-database.cjs`, immediately after `unmarkDeleted`:

```js
  /**
   * True iff `documentName` is currently tombstoned (mid-delete). Threaded to
   * promotePending (#267) so its ACL write-back skips a room being deleted —
   * the same guard store() applies via the `_deleted` check.
   */
  isDeleted(documentName) {
    return this._deleted.has(documentName);
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:server -- server/__tests__/secwriter-database.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/secwriter-database.cjs server/__tests__/secwriter-database.test.mjs
git commit -F- <<'EOF'
feat(server): expose SecWriterDatabase.isDeleted for promote guard (#267)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
```

---

## Task 6: ACL mutex module (seam 4)

**Files:**
- Create: `server/acl-mutex.cjs`
- Create: `server/__tests__/acl-mutex.test.mjs`

- [ ] **Step 1: Write the failing test** — `server/__tests__/acl-mutex.test.mjs`:

```js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createAclMutex } = require('../acl-mutex.cjs');

describe('createAclMutex (#267 seam 4)', () => {
  it('serializes two RMWs on the same key (no lost update)', async () => {
    const { withAclLock } = createAclMutex();
    let shared = { n: 0 };
    const order = [];
    const rmw = (tag, delayMs) => withAclLock('acme/r1', async () => {
      const snap = shared.n;               // read
      await new Promise(r => setTimeout(r, delayMs)); // yield mid-RMW
      shared = { n: snap + 1 };            // write-back
      order.push(tag);
    });
    await Promise.all([rmw('A', 20), rmw('B', 1)]);
    // Without serialization both read n=0 and shared.n ends at 1. Serialized → 2.
    assert.equal(shared.n, 2);
    assert.deepEqual(order, ['A', 'B']); // FIFO
  });
  it('a rejecting fn does not poison the next caller', async () => {
    const { withAclLock } = createAclMutex();
    await assert.rejects(withAclLock('k', async () => { throw new Error('boom'); }));
    const ok = await withAclLock('k', async () => 'ok');
    assert.equal(ok, 'ok');
  });
  it('different keys run independently', async () => {
    const { withAclLock } = createAclMutex();
    const a = withAclLock('k1', async () => 1);
    const b = withAclLock('k2', async () => 2);
    assert.deepEqual(await Promise.all([a, b]), [1, 2]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:server -- server/__tests__/acl-mutex.test.mjs`
Expected: FAIL (`Cannot find module '../acl-mutex.cjs'`).

- [ ] **Step 3: Create `server/acl-mutex.cjs`**:

```js
'use strict';
/**
 * One shared per-composite-key ACL read-modify-write mutex (#267 seam 4).
 * `.acl.json` has no compare-and-set and writeAcl is a full-object overwrite,
 * so the share route (HTTP) and promotePending (WS connect) MUST serialize
 * their RMWs through ONE Map instance — two Maps in two modules is not a mutex.
 * Owned by collab-server.cjs, threaded into createHttpHandler like flushRoom.
 * Single-instance-bound (ADR-0017): a multi-instance move needs a distributed
 * lock here too. Same chain shape as SecWriterDatabase._storeChains.
 */
function createAclMutex() {
  const chains = new Map();
  function withAclLock(key, fn) {
    const prev = chains.get(key) || Promise.resolve();
    // Swallow the prior result/error (both branches call fn) so one caller's
    // rejection can't reject the next; each caller still sees its OWN fn's
    // resolution/rejection via `run`.
    const run = prev.then(() => fn(), () => fn());
    // Settle-tracking chain that never rejects, so the Map stays healthy.
    const next = run.then(() => {}, () => {});
    chains.set(key, next);
    next.then(() => { if (chains.get(key) === next) chains.delete(key); });
    return run;
  }
  return { withAclLock };
}
module.exports = { createAclMutex };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:server -- server/__tests__/acl-mutex.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/acl-mutex.cjs server/__tests__/acl-mutex.test.mjs
git commit -F- <<'EOF'
feat(server): add shared per-key ACL RMW mutex (#267 seam 4)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
```

---

## Task 7: promotePending module (seam 3)

**Files:**
- Create: `server/promote-pending.cjs`
- Create: `server/__tests__/promote-pending.test.mjs`

- [ ] **Step 1: Write the failing test** — `server/__tests__/promote-pending.test.mjs`:

```js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { promotePending } = require('../promote-pending.cjs');
const { createAclMutex } = require('../acl-mutex.cjs');

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
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:server -- server/__tests__/promote-pending.test.mjs`
Expected: FAIL (`Cannot find module '../promote-pending.cjs'`).

- [ ] **Step 3: Create `server/promote-pending.cjs`**:

```js
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

    const roles = (acl.roles && typeof acl.roles === 'object') ? acl.roles : {};
    const pending = (acl.pending && typeof acl.pending === 'object') ? acl.pending : {};
    const display = (acl.display && typeof acl.display === 'object') ? acl.display : {};
    let changed = false;

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
    if (exceedsAclByteCap(next)) {
      if (log && log.warn) log.warn('promote.acl-too-large', { tenant, roomId });
      return; // access still correct via resolveRole; skip the write (seam 7)
    }
    await storage.writeAcl(tenant, roomId, next);
  });
}
module.exports = { promotePending };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:server -- server/__tests__/promote-pending.test.mjs`
Expected: PASS (all 9 cases).

- [ ] **Step 5: Commit**

```bash
git add server/promote-pending.cjs server/__tests__/promote-pending.test.mjs
git commit -F- <<'EOF'
feat(server): add promotePending connect-time bind (#267 seam 3)

Bind/upgrade + expired-prune + display cache, under the ACL mutex, guarded
by null-check AND isDeleted tombstone (blocker #2), size-capped (seam 7).

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
```

---

## Task 8: revokeLiveSessions gains the { emails } selector (major #4)

**Files:**
- Modify: `server/collab-server.cjs:173-188` (the `revokeLiveSessions` function), `:48` (import)
- Test: `server/__tests__/hocuspocus-server.test.mjs`

- [ ] **Step 1: Write the failing test** — append a case to the revoke section (T1–T4) of `hocuspocus-server.test.mjs`. Match the existing harness that builds a live server + two providers and asserts sockets close. The assertion: an `{ emails }` kick closes ONLY the connection whose `conn.context.user.email` matches (normalized), leaving a non-matching connection open. If the harness is heavy, add a focused unit instead by constructing a fake `hocuspocusInstance.documents` — but prefer extending the existing T-series since it already pins `conn.context.user`/`conn.webSocket` reach. Skeleton:

```js
it('T5 (#267): revokeLiveSessions({ emails }) kicks only the email-matched conn', async () => {
  // Reuse the T-series two-provider loopback. Connect user A (email a@y.com)
  // and user B (email b@y.com) to the same room, then:
  //   server.revokeLiveSessions(tenant, roomId, { emails: ['A@Y.COM'] });
  // Assert A's socket closed with ResetConnection (4205) and B stayed open.
  // (Follow the exact connect/close-detection pattern the existing T1–T4 use.)
});
```

Implement the body following the file's established T1–T4 pattern (same `waitFor` close-code assertions).

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:server -- --test-name-pattern="T5"`
Expected: FAIL (`emails` selector ignored — both stay open, or both close).

- [ ] **Step 3: Add the import** — in `collab-server.cjs` line 48, extend the authorize require. **KEEP `roleOf`** — the revoke sweep (`:661`) still uses it until Task 13 swaps it; removing it here leaves the sweep referencing an undefined `roleOf` (a `ReferenceError` when the timer fires). `roleOf` is dropped from this import in Task 13, not here:

```js
const { roleOf, resolveRole, pendingInviteTtlMs, normalizeEmail } = require('./auth/authorize.cjs');
```

- [ ] **Step 4: Extend `revokeLiveSessions`** — replace the function body (lines 173-188) with:

```js
  function revokeLiveSessions(tenant, roomId, { subjects, emails } = {}) {
    if (!hocuspocusInstance) return 0;
    const doc = hocuspocusInstance.documents.get(buildCompositeDocName(tenant, roomId));
    if (!doc) return 0; // room not resident — nothing live to revoke
    const subjectSet = subjects && new Set(subjects);
    const emailSet = emails && new Set(emails.map((e) => normalizeEmail(e)));
    const filtering = !!(subjectSet || emailSet); // undefined both = kick ALL
    let n = 0;
    doc.connections.forEach((_v, conn) => {
      const u = conn.context && conn.context.user;
      const uid = u && u.id;
      if (!uid) return;
      if (filtering) {
        const bySubject = subjectSet && subjectSet.has(uid);
        const byEmail = emailSet && u.email && emailSet.has(normalizeEmail(u.email));
        if (!bySubject && !byEmail) return;
      }
      try { conn.webSocket.close(ResetConnection.code, ResetConnection.reason); n += 1; }
      catch (err) { log.warn('revoke.close-failed', { err: err && err.message }); }
    });
    if (n) log.info('revoke.sessions-closed', { tenant, roomId, n, all: !filtering });
    return n;
  }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm run test:server -- server/__tests__/hocuspocus-server.test.mjs`
Expected: PASS (T1–T4 still green; T5 green).

- [ ] **Step 6: Commit**

```bash
git add server/collab-server.cjs server/__tests__/hocuspocus-server.test.mjs
git commit -F- <<'EOF'
feat(server): revokeLiveSessions { emails } selector for pending kick (#267)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
```

---

## Task 9: Wire the ACL mutex + fire-and-forget promotePending into collab-server

**Files:**
- Modify: `server/collab-server.cjs` (add mutex instance + imports; thread `withAclLock` into `createHttpHandler`; call `promotePending` in the `onAuthenticate` wrapper)
- Test: `server/__tests__/hocuspocus-server.test.mjs`

- [ ] **Step 1: Write the failing test** — append an integration case: a JWT user with a pending invite connects via WS; after the connect settles, `storage.readAcl` shows the invite bound to their sub and the pending entry gone. Use the file's existing live-server + provider harness:

```js
it('#267: connecting a pending invitee persists the bind (fire-and-forget)', async () => {
  // Seed .acl.json with pending['bob@y.com']={role:'editor',invitedAt:now}.
  // Connect a provider whose token has sub=bob, email=bob@y.com.
  // Poll storage.readAcl until roles.bob === 'editor' (bind is detached, so
  // wait — do NOT assert synchronously). Assert pending['bob@y.com'] cleared
  // and display.bob.name is set.
});
```

Implement using the harness's JWT/token helper. **The token MUST carry an `email` claim** (`bearer({ sub:'bob', tenant:'acme', email:'bob@y.com' })`) — `promotePending` is gated on `ctx.user.email`, so a token without it silently no-ops and the poll below would time out (a false failure, not a red). `node --test` has no built-in `waitFor`; poll with a bounded loop, e.g. `for (let i=0;i<50 && !(await storage.readAcl('acme','r1')).roles.bob;i++) await new Promise(r=>setTimeout(r,20));` then assert `roles.bob==='editor'`, `pending['bob@y.com']` cleared, `display.bob.name` set.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:server -- --test-name-pattern="persists the bind"`
Expected: FAIL (nothing binds — promotePending not wired).

- [ ] **Step 3: Add imports + mutex instance** — in `collab-server.cjs`, after the existing requires add:

```js
const { createAclMutex } = require('./acl-mutex.cjs');
const { promotePending } = require('./promote-pending.cjs');
```

Then inside `createCollabServer`, near the `const roomHealth = new Map();` declaration, add:

```js
  // #267 seam 4: ONE shared ACL RMW mutex for both the share route (HTTP) and
  // promotePending (WS connect). Single-instance-bound (ADR-0017).
  const { withAclLock } = createAclMutex();
```

- [ ] **Step 4: Thread `withAclLock` into the HTTP handler** — in the `createHttpHandler({ ... })` deps object (around line 282), add `withAclLock,` alongside `flushRoom,`:

```js
      storage,
      boundDocs: boundDocsView,
      flushRoom,
      deleteRoomTransactionally,
      revokeLiveSessions,
      withAclLock,
      maxDocBytes: MAX_DOC_BYTES,
```

- [ ] **Step 5: Fire promotePending in the onAuthenticate wrapper** — in `buildHocuspocus`, inside the `async onAuthenticate(data)` handler, after the `if (ctx && ctx.readOnly && data.connectionConfig) data.connectionConfig.readOnly = true;` line and BEFORE `return ctx;`:

```js
          // #267 seam 3: fire-and-forget pending-invite bind. Never blocks the
          // connect verdict — resolveRole (in onAuthenticate) already granted the
          // pending invitee. Runs under the shared ACL mutex; skips a tombstoned
          // room via database.isDeleted. auth=none has no email → no-op.
          if (authProvider && authProvider.requiresAuth && ctx && ctx.user && ctx.user.email) {
            const compositeKey = buildCompositeDocName(ctx.tenant, ctx.roomId);
            promotePending({
              storage, tenant: ctx.tenant, roomId: ctx.roomId, user: ctx.user,
              withAclLock, isDeleted: (k) => database.isDeleted(k), compositeKey,
              now: Date.now(), ttlMs: pendingInviteTtlMs(), log,
            }).catch((err) => log.warn('promote.failed', { err: err && err.message }));
          }
          return ctx;
```

(`database` is the local const built just above in `buildHocuspocus`; `withAclLock`, `storage`, `promotePending`, `pendingInviteTtlMs`, `buildCompositeDocName`, `log` are all in scope.)

- [ ] **Step 6: Run test to verify it passes**

Run: `npm run test:server -- server/__tests__/hocuspocus-server.test.mjs`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add server/collab-server.cjs server/__tests__/hocuspocus-server.test.mjs
git commit -F- <<'EOF'
feat(server): wire ACL mutex + fire-and-forget promotePending (#267 seams 3+4)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
```

---

## Task 10: Share route — email branch + full-object RMW + caps + pending-remove kick (seam 1)

**Files:**
- Modify: `server/http-handler.cjs:19` (imports), `:37` (deps), `:529-615` (the `PATCH /:id/share` route)
- Create: `server/__tests__/http-share-email.test.mjs`

**Why a new test file, not `http-endpoints.test.mjs`:** that file already holds 29 `it()`; Tasks 10+11+12 add 8+ cases, which would push it to 37, over CLAUDE.md Testing Rule #3's ≤30-per-file cap. Put all #267 endpoint tests in a dedicated file (Tasks 11 and 12 append to this same file). **Copy the real harness from `http-endpoints.test.mjs`** — it uses a REAL `LocalStorageBackend` in a temp dir (real `readAcl`/`writeAcl`), a `bearer({ sub, tenant, email })` JWT-mint helper (`jwt.sign` + `createAuthJwt({ secret })`), and `httpJson`/`httpGet` request helpers over a real listening server. It is NOT a fake storage and does NOT use `fetch`. To assert the pending-remove kick, construct `createHttpHandler` with a **stub** `revokeLiveSessions: (t, r, opts) => kicks.push(opts)` and inspect `kicks`.

- [ ] **Step 1: Write the failing tests** — create `server/__tests__/http-share-email.test.mjs`. Copy the harness preamble (imports, temp-dir storage, `bearer`, `httpJson`/`httpGet`, server start/stop in `before`/`after`) verbatim from `http-endpoints.test.mjs`, then add:

```js
// #267 — share by email. (Uses the same describe/it style as http-endpoints.)
it('email add stores a pending invite (not a roles entry); never-registered ok; malformed → 400', async () => {
  // owner bearer({sub:'owner',tenant:'acme'}).
  // PATCH /rooms/r1/share { email:'Bob@Corp.com', action:'add', role:'editor' } → 200.
  // GET /rooms/r1/acl → pending['bob@corp.com'].role === 'editor' (lowercased), roles unchanged.
  // PATCH { email:'nobody@corp.com', action:'add' } → 200 (no lookup oracle; defaults editor).
  // PATCH { email:'bad', action:'add' } → 400.
});
it('raw-sub add/remove preserves pending + display (full-object RMW, blocker #1)', async () => {
  // Seed r1 acl via storage.writeAcl with roles{}, pending{'bob@corp.com':{role:'editor',invitedAt:now}},
  // display{s1:{name:'S',email:'s@corp.com'}}. PATCH { userId:'x', action:'add' } → 200.
  // GET /acl still shows pending['bob@corp.com'] AND display.s1 intact (not wiped by a partial rebuild).
});
it('email add at MAX_PENDING_INVITES → 429', async () => {
  // Seed acl.pending with MAX_PENDING_INVITES live entries (invitedAt:now). A NEW email add → 429.
  // (Re-adding an EXISTING pending email at the cap is allowed — it replaces, not grows.)
});
it('a write exceeding MAX_ACL_BYTES → 400 (share side, seam 7)', async () => {
  // Seed acl.pending with entries whose serialized size is just under MAX_ACL_BYTES; a NEW email
  // add that tips it over → 400 'ACL too large'. (Prune-expired runs first, so use live invitedAt.)
});
it('email remove kicks the live session ONLY when a pending entry existed (major #4)', async () => {
  // createHttpHandler with stub revokeLiveSessions capturing opts.
  // Seed pending['bob@corp.com']. PATCH { email:'bob@corp.com', action:'remove' } → 200 AND
  // the stub was called with { emails:['bob@corp.com'] }. Then PATCH remove of a NON-existent
  // email → 200 AND the stub was NOT called again (gated on pendingRemoved).
});
it('a non-owner PATCH /share → 404 (owner-only preserved)', async () => {
  // A room owned by 'owner'; bearer({sub:'editor',tenant:'acme'}) PATCH → 404.
});
```

Fill each body using the copied `httpJson`/`httpGet` + `bearer` helpers. Keep the file well under 30 tests.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:server -- server/__tests__/http-share-email.test.mjs`
Expected: FAIL (email path unrecognized; pending wiped by the partial rebuild; caps/kick absent).

- [ ] **Step 3: Extend the imports** — `http-handler.cjs` line 19:

```js
const { authorize, checkPrincipal, aclAllowsRead, roleOf, resolveRole, pendingInviteTtlMs, normalizeEmail, isValidEmailShape, isPendingExpired, exceedsAclByteCap, MAX_PENDING_INVITES, ACTION, GRANTABLE_ROLES } = require('./auth/authorize.cjs');
```

- [ ] **Step 4: Accept `withAclLock` in the factory** — line 37, add `withAclLock` to the destructured deps:

```js
function createHttpHandler({ storage, boundDocs, flushRoom, deleteRoomTransactionally, revokeLiveSessions, withAclLock, maxDocBytes, authProvider, allowedOrigin = '*', getActiveUsers, rateLimiter, roomHealth }) {
```

Add a fallback near the top of the factory body (after `performRoomDeletion`) so bare test harnesses without a mutex still work:

```js
  // #267: the share route serializes its ACL RMW through the shared mutex when
  // wired (collab-server threads it in); bare test harnesses without it fall
  // back to running fn directly (no concurrent promote to race there).
  const withAclLockOrDirect = typeof withAclLock === 'function'
    ? withAclLock
    : (_key, fn) => fn();
```

- [ ] **Step 5: Replace the `PATCH /:id/share` route** — swap the whole block (current lines 529-615) with:

```js
    // PATCH /rooms/:roomId/share — owner-only. Two variants:
    //   { userId, action:'add'|'remove', role? } — raw-sub grant (unchanged behavior)
    //   { email,  action:'add'|'remove', role? } — #267 pending-by-email invite
    // Every write is a FULL-OBJECT read-modify-write (writeAcl overwrites the
    // whole blob) under the shared ACL mutex, preserving roles + pending + display.
    const shareMatch = url.pathname.match(/^\/rooms\/([^/]+)\/share$/);
    if (shareMatch && req.method === 'PATCH') {
      const roomId = shareMatch[1];
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', async () => {
        try {
          const tenant = resolveTenant(req);
          const dec = await authorize({ authProvider, storage, user: req.user, roomId, action: ACTION.SHARE });
          if (denied(res, dec)) return;

          const body = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
          const action = body && body.action;
          const role = body && body.role;
          const rawEmail = body && body.email;
          const userId = body && body.userId;
          const isEmail = typeof rawEmail === 'string' && rawEmail.length > 0;

          if (action !== 'add' && action !== 'remove') {
            res.writeHead(400, { 'Content-Type': 'text/plain' });
            res.end('action must be "add" or "remove"');
            return;
          }
          if (!isEmail && (typeof userId !== 'string' || !userId)) {
            res.writeHead(400, { 'Content-Type': 'text/plain' });
            res.end('Body must include userId or email');
            return;
          }
          if (action === 'add' && role !== undefined && !GRANTABLE_ROLES.includes(role)) {
            res.writeHead(400, { 'Content-Type': 'text/plain' });
            res.end(`role must be one of ${GRANTABLE_ROLES.join(', ')}`);
            return;
          }
          const email = isEmail ? normalizeEmail(rawEmail) : null;
          if (isEmail && action === 'add' && !isValidEmailShape(email)) {
            res.writeHead(400, { 'Content-Type': 'text/plain' });
            res.end('Malformed email');
            return;
          }

          const composite = buildCompositeDocName(tenant, roomId);
          const now = Date.now();
          const ttlMs = pendingInviteTtlMs();
          const outcome = { status: 200 };

          await withAclLockOrDirect(composite, async () => {
            const acl = await storage.readAcl(tenant, roomId);
            if (!acl) { outcome.status = 404; return; }

            // Fold current roles into the graded shape (migrate #211 sharedWith).
            const roles = {};
            if (acl.roles && typeof acl.roles === 'object') {
              for (const [uid, r] of Object.entries(acl.roles)) if (r === 'viewer' || r === 'editor') roles[uid] = r;
            } else if (Array.isArray(acl.sharedWith)) {
              for (const uid of acl.sharedWith) roles[uid] = 'editor';
            }
            const pending = { ...((acl.pending && typeof acl.pending === 'object') ? acl.pending : {}) };
            const display = { ...((acl.display && typeof acl.display === 'object') ? acl.display : {}) };

            // Prune expired pending first (reuse the exported predicate — no
            // inline re-implementation to drift), so the cap counts only LIVE invites.
            for (const [e, entry] of Object.entries(pending)) {
              if (isPendingExpired(entry, now, ttlMs)) delete pending[e];
            }

            if (isEmail) {
              if (action === 'add') {
                if (!pending[email] && Object.keys(pending).length >= MAX_PENDING_INVITES) { outcome.status = 429; return; }
                pending[email] = { role: role || 'editor', invitedBy: req.user.id, invitedAt: new Date(now).toISOString() };
              } else {
                outcome.pendingRemoved = Object.prototype.hasOwnProperty.call(pending, email);
                delete pending[email];
              }
            } else {
              outcome.prevRole = roleOf(acl, userId);
              if (action === 'add') roles[userId] = role || 'editor'; else { delete roles[userId]; delete display[userId]; }
              outcome.newRole = action === 'add' ? (role || 'editor') : null;
            }
            delete roles[acl.ownerId]; // a grant entry may never equal the owner

            const next = { ...acl, roles, pending, display };
            delete next.sharedWith; // #239 folded into `roles` above; drop the legacy key so it isn't persisted forever
            if (exceedsAclByteCap(next)) { outcome.status = 400; return; }
            await storage.writeAcl(tenant, roomId, next);
            outcome.roles = roles;
          });

          if (outcome.status === 404) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found'); return; }
          if (outcome.status === 429) { res.writeHead(429, { 'Content-Type': 'text/plain' }); res.end(`Too many pending invites (max ${MAX_PENDING_INVITES})`); return; }
          if (outcome.status === 400) { res.writeHead(400, { 'Content-Type': 'text/plain' }); res.end('ACL too large'); return; }

          // #268/#267 live-session revocation. Email remove: kick any session
          // whose token email matches (the bound sub is unknown until connect —
          // major #4). Raw-sub remove/downgrade: kick the sub (unchanged #268).
          if (revokeLiveSessions) {
            if (isEmail) {
              // Kick ONLY if a live pending entry was actually removed. Avoids a
              // spurious reconnect and avoids kicking a roles-bound collaborator
              // who happens to share this email (major #4 refinement).
              if (action === 'remove' && outcome.pendingRemoved) revokeLiveSessions(tenant, roomId, { emails: [email] });
            } else {
              const isRemoval = action === 'remove';
              const isDowngrade = outcome.newRole === 'viewer' && outcome.prevRole === 'editor';
              if (isRemoval || isDowngrade) revokeLiveSessions(tenant, roomId, { subjects: [userId] });
            }
          }

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, roles: outcome.roles || {} }));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end(`Share failed: ${err.message}`);
        }
      });
      return;
    }
```

- [ ] **Step 6: Run the new suite + the existing endpoint suite (no regression)**

Run: `npm run test:server -- server/__tests__/http-share-email.test.mjs server/__tests__/http-endpoints.test.mjs`
Expected: PASS (new #267 tests green; existing raw-sub share tests in `http-endpoints.test.mjs` still green — the route change is behavior-preserving for the raw-sub path).

- [ ] **Step 7: Commit**

```bash
git add server/http-handler.cjs server/__tests__/http-share-email.test.mjs
git commit -F- <<'EOF'
feat(server): share route email branch + full-object RMW + caps + kick (#267)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
```

---

## Task 11: GET /:id/acl returns pending + display (read-only)

**Files:**
- Modify: `server/http-handler.cjs:372-400` (the `GET /:id/acl` route)
- Test: `server/__tests__/http-share-email.test.mjs` (append; created in Task 10)

- [ ] **Step 1: Write the failing test** — append to `server/__tests__/http-share-email.test.mjs`:

```js
it('#267: GET /acl returns pending + display alongside roles (read-only)', async () => {
  // Seed acl with roles{ed:'editor'}, pending{'bob@y.com':{role:'editor',invitedAt}},
  // display{ed:{name:'Ed',email:'ed@y.com'}}. Owner GET /rooms/r1/acl returns
  // { ownerId, roles, pending, display } with all three populated.
  // Assert the on-disk ACL is BYTE-IDENTICAL afterward (no normalization write-back).
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:server -- --test-name-pattern="GET /acl returns pending"`
Expected: FAIL (`pending`/`display` absent from the response).

- [ ] **Step 3: Extend the response** — in the `GET /:id/acl` route, replace the final `res.end(JSON.stringify({ ownerId: acl.ownerId, roles }));` with:

```js
        // #267: surface pending invites + cached display names. STRICTLY
        // read-only — normalize for the response, never persist from this path
        // (a write here would be a 4th unserialized RMW site that could lose a
        // share/promote update). See the full-object-RMW invariant in the spec.
        const pending = (acl.pending && typeof acl.pending === 'object') ? acl.pending : {};
        const display = (acl.display && typeof acl.display === 'object') ? acl.display : {};
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ownerId: acl.ownerId, roles, pending, display }));
```

(Delete the pre-existing `res.writeHead(200, ...)` + `res.end(...)` pair that this replaces so there's exactly one write.)

- [ ] **Step 4: Run the new suite + the existing endpoint suite**

Run: `npm run test:server -- server/__tests__/http-share-email.test.mjs server/__tests__/http-endpoints.test.mjs`
Expected: PASS (new read-only ACL test green; existing GET /acl tests in `http-endpoints.test.mjs` still green).

- [ ] **Step 5: Commit**

```bash
git add server/http-handler.cjs server/__tests__/http-share-email.test.mjs
git commit -F- <<'EOF'
feat(server): GET /acl returns pending + display, read-only (#267)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
```

---

## Task 12: GET /rooms listing uses resolveRole + viaPending (option-1 discoverability)

**Files:**
- Modify: `server/http-handler.cjs:721-729` (the listing member-filter + entry)
- Test: `server/__tests__/http-share-email.test.mjs` (append; created in Task 10)

- [ ] **Step 1: Write the failing test** — append to `server/__tests__/http-share-email.test.mjs`:

```js
it('#267: a pending invitee sees the invited room in GET /rooms, badged viaPending', async () => {
  // Seed r1 with pending['bob@y.com']. Bob's GET /rooms lists r1 with
  // role:'editor' and viaPending:true. A genuine non-member (no pending, no
  // roles) does NOT see r1 (excluded) AND GET /rooms/r1/sec → 404.
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:server -- --test-name-pattern="pending invitee sees the invited room"`
Expected: FAIL (invitee excluded — `aclAllowsRead` ignores pending).

- [ ] **Step 3: Swap the filter + add viaPending** — replace the member-filter block (lines 721-726):

```js
          let callerRole = 'editor';
          let callerViaPending = false;
          if (authProvider?.requiresAuth) {
            const acl = await storage.readAcl(tenant, id);
            // #267: resolveRole (not aclAllowsRead/roleOf) so a caller's OWN
            // pending-by-email invites list too — badged viaPending. Zero extra
            // I/O (the ACL is already loaded for the member filter). Genuine
            // non-members resolve to null → still excluded (unchanged 404).
            const resolved = resolveRole(acl, req.user, Date.now(), pendingInviteTtlMs());
            if (!resolved.role) continue;
            callerRole = resolved.role;
            callerViaPending = resolved.viaPending;
          }
```

Then in the `entry` object literal (line 729), add `viaPending: callerViaPending`:

```js
          const entry = { id, displayName: id, sectionNumber: null, sectionTitle: null, lastModified: null, activeUsers: [], locked: false, sizeBytes: 0, role: callerRole, viaPending: callerViaPending };
```

- [ ] **Step 4: Run the new suite + the existing endpoint suite (full)**

Run: `npm run test:server -- server/__tests__/http-share-email.test.mjs server/__tests__/http-endpoints.test.mjs`
Expected: PASS (existing listing/member-filter tests in `http-endpoints.test.mjs` green; new #267 listing test green).

- [ ] **Step 5: Commit**

```bash
git add server/http-handler.cjs server/__tests__/http-share-email.test.mjs
git commit -F- <<'EOF'
feat(server): GET /rooms lists own pending invites via resolveRole (#267)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
```

---

## Task 13: Revoke sweep uses resolveRole (major #3)

**Files:**
- Modify: `server/collab-server.cjs` — relocate `revokeSweep` from `startFromEnv` into `createCollabServer` and expose it on the return; swap its role read to `resolveRole`; drop `roleOf` from the `:48` import (the sweep was its last user).
- Test: `server/__tests__/hocuspocus-server.test.mjs`

**Why the relocation:** `revokeSweep` currently lives inside `startFromEnv` (the CLI path) and is NOT on `createCollabServer`'s return, so a test cannot invoke it directly — only via the racy `SIM_REVOKE_SWEEP_MS` timer. Move the function into `createCollabServer` (which already has `hocuspocusInstance`, `authProvider`, `storage`, `log` in scope) and return it, so the test drives one deterministic `server.revokeSweep()` call. `startFromEnv`'s interval then calls `server.revokeSweep`.

- [ ] **Step 1: Write the failing test** — append to `hocuspocus-server.test.mjs` (`test(...)` if the file uses `test`; it imports `{ describe, it }`, so `it(...)` is fine here). Determinism: inject a storage whose `writeAcl` is a **no-op**, so the fire-and-forget `promotePending` can NEVER move `pending → roles` — `roleOf(acl, bob)` stays null for the whole test (kills the promote-vs-sweep race), while `resolveRole` still grants via the live pending entry.

```js
it('#267: revoke sweep does not evict a valid pending-only session', async () => {
  // Build a server whose storage.writeAcl is a no-op and whose readAcl returns
  // { ownerId:'owner', roles:{}, pending:{ 'bob@y.com': {role:'editor', invitedAt: <now> } } }.
  // Connect a JWT provider for bob (sub=bob, email=bob@y.com). Await the
  // Authenticated scope. Call `server.revokeSweep()` once and assert bob's
  // socket is STILL OPEN (resolveRole → editor, not stale).
  //
  // Then flip readAcl to return pending:{} (invite gone), call
  // `server.revokeSweep()` again, and assert bob's socket CLOSED (resolveRole →
  // null → stale). Copy the two-provider connect + close-detection pattern from
  // the existing T1–T4 revoke tests.
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:server -- --test-name-pattern="revoke sweep does not evict"`
Expected: FAIL — first because `server.revokeSweep` is undefined (not yet exposed), then (after Step 3's relocation but before Step 4's swap) because the sweep uses `roleOf` → null → evicts the valid invitee.

- [ ] **Step 3: Relocate + expose `revokeSweep`, drop `roleOf`** — cut the entire `revokeSweep` function definition out of `startFromEnv` and paste it into `createCollabServer` (place it near `revokeLiveSessions`, which shares its `hocuspocusInstance`/`storage` scope). It references `server.hocuspocus.documents` in `startFromEnv`; inside `createCollabServer` change that to `hocuspocusInstance.documents`. Add `revokeSweep` to the `createCollabServer` return object (alongside `revokeLiveSessions`). In `startFromEnv`, replace the deleted definition's timer body with a call to the exposed method:

```js
  const revokeSweepTimer = setInterval(
    () => server.revokeSweep().catch((err) => log.error('revoke-sweep.uncaught', { err: err && err.message })),
    REVOKE_SWEEP_MS,
  );
  if (revokeSweepTimer.unref) revokeSweepTimer.unref();
```

Then drop `roleOf` from the `:48` import (the relocated sweep is switched off it in Step 4, and it has no other user in this file):

```js
const { resolveRole, pendingInviteTtlMs, normalizeEmail } = require('./auth/authorize.cjs');
```

- [ ] **Step 4: Swap the sweep role read** — in the relocated `revokeSweep`, replace:

```js
        const role = acl ? roleOf(acl, uid) : null;
```

with:

```js
        // #267: resolveRole so a validly-pending session (admitted via pending,
        // not yet bound by the fire-and-forget promote) is NOT swept-closed
        // during the connect->persist window. Reads the same conn.context.user
        // (id + email) the kick path uses.
        const { role } = resolveRole(acl, conn.context && conn.context.user, Date.now(), pendingInviteTtlMs());
```

(Leave the `const stale = !role || (role === 'viewer') !== !!conn.readOnly;` line unchanged.)

- [ ] **Step 5: Run test to verify it passes**

Run: `npm run test:server -- server/__tests__/hocuspocus-server.test.mjs`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/collab-server.cjs server/__tests__/hocuspocus-server.test.mjs
git commit -F- <<'EOF'
fix(server): revoke sweep uses resolveRole, stops evicting pending (#267)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
```

---

## Task 14: ShareDialog — email input, pending list, display names, copy-link

**Files:**
- Modify: `src/components/ShareDialog.jsx`
- Modify: `src/App.jsx:2900-2912` (`onShareRoom` passes `email` through)
- Test: `src/components/__tests__/ShareDialog.test.jsx`

- [ ] **Step 1: Write the failing tests** — append to `ShareDialog.test.jsx`:

```js
it('#267: email add routes to the email branch and refreshes', async () => {
  const loadAcl = vi.fn(async () => ({ ownerId: 'owner', roles: {}, pending: {}, display: {} }));
  const submitShare = vi.fn(async () => ({ roles: {} }));
  render(<ShareDialog roomId="r1" loadAcl={loadAcl} submitShare={submitShare} onClose={vi.fn()} />);
  await waitFor(() => expect(loadAcl).toHaveBeenCalled());
  fireEvent.change(screen.getByPlaceholderText(/email/i), { target: { value: 'bob@corp.com' } });
  fireEvent.click(screen.getByText('Invite').closest('button'));
  await waitFor(() => expect(submitShare).toHaveBeenCalledWith('r1', { email: 'bob@corp.com', action: 'add', role: 'editor' }));
  // refresh() re-fetches so the new pending row appears
  await waitFor(() => expect(loadAcl).toHaveBeenCalledTimes(2));
});
it('#267: renders pending invites (email + role) with a remove control', async () => {
  const loadAcl = vi.fn(async () => ({ ownerId: 'owner', roles: {}, pending: { 'bob@corp.com': { role: 'editor', invitedAt: '2026-07-14T00:00:00Z' } }, display: {} }));
  const submitShare = vi.fn(async () => ({ roles: {} }));
  render(<ShareDialog roomId="r1" loadAcl={loadAcl} submitShare={submitShare} onClose={vi.fn()} />);
  await waitFor(() => expect(screen.getByText('bob@corp.com')).toBeTruthy());
  expect(screen.getByText(/invited/i)).toBeTruthy();
});
it('#267: bound collaborator shows display name with raw-sub fallback', async () => {
  const loadAcl = vi.fn(async () => ({ ownerId: 'owner', roles: { s1: 'editor', s2: 'viewer' }, pending: {}, display: { s1: { name: 'Alice A', email: 'a@corp.com' } } }));
  render(<ShareDialog roomId="r1" loadAcl={loadAcl} submitShare={vi.fn(async () => ({ roles: {} }))} onClose={vi.fn()} />);
  await waitFor(() => expect(screen.getByText('Alice A')).toBeTruthy());
  expect(screen.getByText('s2')).toBeTruthy(); // no display → raw sub
});
it('#267: Copy room link writes the room URL to the clipboard', async () => {
  const writeText = vi.fn(async () => {});
  Object.assign(navigator, { clipboard: { writeText } });
  render(<ShareDialog roomId="r1" loadAcl={vi.fn(async () => ({ ownerId: 'owner', roles: {}, pending: {}, display: {} }))} submitShare={vi.fn()} onClose={vi.fn()} />);
  await waitFor(() => expect(screen.getByText(/Copy room link/i)).toBeTruthy());
  fireEvent.click(screen.getByText(/Copy room link/i).closest('button'));
  await waitFor(() => expect(writeText).toHaveBeenCalledWith(expect.stringContaining('room=r1')));
});
it('#239 raw-sub add path still works (acceptance criterion)', async () => {
  const submitShare = vi.fn(async () => ({ roles: { x: 'editor' } }));
  render(<ShareDialog roomId="r1" loadAcl={vi.fn(async () => ({ ownerId: 'owner', roles: {}, pending: {}, display: {} }))} submitShare={submitShare} onClose={vi.fn()} />);
  await waitFor(() => expect(screen.getByPlaceholderText(/subject id/i)).toBeTruthy());
  fireEvent.change(screen.getByPlaceholderText(/subject id/i), { target: { value: 'x' } });
  fireEvent.click(screen.getByText('Add').closest('button'));
  await waitFor(() => expect(submitShare).toHaveBeenCalledWith('r1', { userId: 'x', action: 'add', role: 'editor' }));
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/components/__tests__/ShareDialog.test.jsx`
Expected: FAIL (no email input, no pending list, no copy-link).

- [ ] **Step 3: Rewrite `ShareDialog.jsx`** — replace the file with:

```jsx
import { useEffect, useState, useCallback } from 'react';
import { X, UserPlus, Mail, Link as LinkIcon } from 'lucide-react';

/**
 * #239 + #267 — owner-only share management for a room.
 *
 * Two add paths: an EMAIL invite (#267 — server stores a pending entry that
 * binds to the invitee's subject id at their next login) and the original
 * raw-subject-id grant (#239, kept as an acceptance criterion). Bound
 * collaborators render their cached display name (raw sub fallback); pending
 * invites render the email with an "invited" tag. A "Copy room link" button
 * eases owner-side delivery.
 *
 * Network is injected so the component stays React-only testable:
 *   loadAcl(roomId)  → { ownerId, roles, pending, display }
 *   submitShare(roomId, { userId|email, action, role }) → { roles } | throws
 */
export default function ShareDialog({ roomId, loadAcl, submitShare, onClose }) {
  const [acl, setAcl] = useState(null); // { ownerId, roles, pending, display }
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [newEmail, setNewEmail] = useState('');
  const [newUserId, setNewUserId] = useState('');
  const [newRole, setNewRole] = useState('editor');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await loadAcl(roomId);
      setAcl(next);
    } catch (err) {
      setError(err?.message || 'Failed to load collaborators');
    } finally {
      setLoading(false);
    }
  }, [roomId, loadAcl]);

  useEffect(() => { refresh(); }, [refresh]);

  // Raw-sub mutations trust the returned roles map (a concurrent owner change
  // is reflected). Email mutations produce NO roles delta, so they refresh()
  // to surface the new pending entry.
  const mutate = useCallback(async (payload, { reload = false } = {}) => {
    setBusy(true);
    setError(null);
    try {
      const res = await submitShare(roomId, payload);
      if (reload) {
        await refresh();
      } else {
        setAcl((prev) => (prev ? { ...prev, roles: res.roles || {} } : prev));
      }
    } catch (err) {
      setError(err?.message || 'Update failed');
    } finally {
      setBusy(false);
    }
  }, [roomId, submitShare, refresh]);

  const handleInvite = () => {
    const email = newEmail.trim();
    if (!email || busy) return;
    mutate({ email, action: 'add', role: newRole }, { reload: true });
    setNewEmail('');
  };
  const handleRemovePending = (email) => mutate({ email, action: 'remove' }, { reload: true });
  const handleAdd = () => {
    const uid = newUserId.trim();
    if (!uid || busy) return;
    mutate({ userId: uid, action: 'add', role: newRole });
    setNewUserId('');
  };

  const copyLink = async () => {
    try {
      const url = `${window.location.origin}${window.location.pathname}?room=${encodeURIComponent(roomId)}`;
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setError('Could not copy link');
    }
  };

  const roleEntries = acl ? Object.entries(acl.roles || {}) : [];
  const pendingEntries = acl ? Object.entries(acl.pending || {}) : [];
  const nameFor = (uid) => (acl?.display?.[uid]?.name) || uid;

  return (
    <div
      role="dialog"
      aria-label="Share room"
      onClick={(e) => e.stopPropagation()}
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'rgba(15,23,42,0.35)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
    >
      <div style={{
        width: 440, maxWidth: '90vw', maxHeight: '80vh',
        background: '#fff', borderRadius: 8, overflow: 'hidden',
        display: 'flex', flexDirection: 'column',
        boxShadow: '0 10px 40px rgba(0,0,0,0.2)',
      }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', borderBottom: '1px solid #e2e8f0' }}>
          <span style={{ fontWeight: 600, fontSize: 14, color: '#1e293b' }}>Share &ldquo;{roomId}&rdquo;</span>
          <div style={{ display: 'flex', gap: 4 }}>
            <button onClick={copyLink} title="Copy room link"
              style={{ border: '1px solid #cbd5e1', background: '#f8fafc', cursor: 'pointer', color: '#334155', padding: '2px 8px', borderRadius: 4, fontSize: 12, display: 'flex', alignItems: 'center', gap: 4 }}>
              <LinkIcon size={13} /> {copied ? 'Copied!' : 'Copy room link'}
            </button>
            <button onClick={onClose} title="Close" style={{ border: 'none', background: 'none', cursor: 'pointer', color: '#64748b', padding: 4, display: 'flex' }}>
              <X size={16} />
            </button>
          </div>
        </div>

        {/* Body */}
        <div style={{ padding: '12px 16px', overflowY: 'auto', flex: 1 }}>
          {error && <div style={{ color: '#b91c1c', fontSize: 12, marginBottom: 8 }}>{error}</div>}
          {loading ? (
            <div style={{ color: '#94a3b8', fontSize: 12 }}>Loading…</div>
          ) : (
            <>
              {acl && (
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '4px 0', fontSize: 12 }}>
                  <span style={{ color: '#1e293b', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{nameFor(acl.ownerId)}</span>
                  <span style={{ color: '#64748b', flexShrink: 0, marginLeft: 8 }}>Owner</span>
                </div>
              )}
              {roleEntries.length === 0 && pendingEntries.length === 0 && (
                <div style={{ color: '#94a3b8', fontSize: 12, padding: '8px 0' }}>No collaborators yet.</div>
              )}
              {roleEntries.map(([uid, role]) => (
                <div key={uid} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '4px 0', fontSize: 12 }}>
                  <span style={{ color: '#1e293b', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{nameFor(uid)}</span>
                  <select value={role} disabled={busy} aria-label={`Role for ${uid}`}
                    onChange={(e) => mutate({ userId: uid, action: 'add', role: e.target.value })}
                    style={{ fontSize: 12, padding: '2px 4px', borderRadius: 4, border: '1px solid #cbd5e1' }}>
                    <option value="viewer">Viewer</option>
                    <option value="editor">Editor</option>
                  </select>
                  <button onClick={() => mutate({ userId: uid, action: 'remove' })} disabled={busy} title="Remove"
                    style={{ border: 'none', background: 'none', cursor: 'pointer', color: '#94a3b8', padding: 4, display: 'flex' }}>
                    <X size={14} />
                  </button>
                </div>
              ))}
              {pendingEntries.map(([email, info]) => (
                <div key={`p-${email}`} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '4px 0', fontSize: 12 }}>
                  <span style={{ color: '#1e293b', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{email}</span>
                  <span style={{ color: '#a16207', background: '#fef9c3', borderRadius: 4, padding: '1px 6px', flexShrink: 0 }}>invited · {info.role}</span>
                  <button onClick={() => handleRemovePending(email)} disabled={busy} title="Revoke invite"
                    style={{ border: 'none', background: 'none', cursor: 'pointer', color: '#94a3b8', padding: 4, display: 'flex' }}>
                    <X size={14} />
                  </button>
                </div>
              ))}
            </>
          )}
        </div>

        {/* Invite by email */}
        <div style={{ display: 'flex', gap: 6, padding: '10px 16px', borderTop: '1px solid #e2e8f0' }}>
          <input type="email" value={newEmail}
            onChange={(e) => setNewEmail(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleInvite(); }}
            placeholder="Invite by email…" aria-label="Invite by email"
            style={{ flex: 1, minWidth: 0, border: '1px solid #cbd5e1', borderRadius: 4, padding: '4px 8px', fontSize: 12, outline: 'none' }} />
          <select value={newRole} onChange={(e) => setNewRole(e.target.value)} aria-label="New collaborator role"
            style={{ fontSize: 12, padding: '2px 4px', borderRadius: 4, border: '1px solid #cbd5e1' }}>
            <option value="viewer">Viewer</option>
            <option value="editor">Editor</option>
          </select>
          <button onClick={handleInvite} disabled={busy || !newEmail.trim()}
            style={{ border: 'none', backgroundColor: '#3b82f6', color: '#fff', borderRadius: 4, padding: '4px 10px', fontSize: 12, fontWeight: 600, cursor: busy || !newEmail.trim() ? 'default' : 'pointer', opacity: busy || !newEmail.trim() ? 0.6 : 1, display: 'flex', alignItems: 'center', gap: 4 }}>
            <Mail size={13} /> Invite
          </button>
        </div>

        {/* Add by raw subject id (kept — acceptance criterion) */}
        <div style={{ display: 'flex', gap: 6, padding: '0 16px 10px', alignItems: 'center' }}>
          <input type="text" value={newUserId}
            onChange={(e) => setNewUserId(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleAdd(); }}
            placeholder="Collaborator subject id…" aria-label="Collaborator subject id"
            style={{ flex: 1, minWidth: 0, border: '1px solid #e2e8f0', borderRadius: 4, padding: '4px 8px', fontSize: 11, outline: 'none', color: '#64748b' }} />
          <button onClick={handleAdd} disabled={busy || !newUserId.trim()}
            style={{ border: '1px solid #cbd5e1', background: '#f8fafc', color: '#334155', borderRadius: 4, padding: '4px 10px', fontSize: 11, cursor: busy || !newUserId.trim() ? 'default' : 'pointer', opacity: busy || !newUserId.trim() ? 0.6 : 1, display: 'flex', alignItems: 'center', gap: 4 }}>
            <UserPlus size={12} /> Add
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Pass `email` through in App.jsx** — replace the `onShareRoom` body (lines 2900-2912) so it forwards whichever of `userId`/`email` is present:

```jsx
            onShareRoom={async (roomId, payload) => {
              // #239 raw-sub grant + #267 email invite. Forward the payload
              // ({ userId|email, action, role }) as-is; the server branches.
              const res = await fetch(`${COLLAB_HTTP_URL}/rooms/${roomId}/share`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json', ...authHeaders },
                body: JSON.stringify(payload),
              });
              if (!res.ok) {
                const msg = await res.text().catch(() => '');
                throw new Error(msg || `Share failed (${res.status})`);
              }
              return res.json();
            }}
```

- [ ] **Step 5: Run the ShareDialog suite**

Before running, re-read the existing `ShareDialog.test.jsx` and confirm every current selector still resolves against the rewritten layout: `getByPlaceholderText(/Collaborator subject id/)` (line 43) matches the raw-sub input's retained `"Collaborator subject id…"` placeholder; `getByText('owner'|'ed'|'vi')`, `getByLabelText('Role for …')`, `getByText('Add')`, and the load-error text all still resolve. If any moved, fix the component (prefer keeping the old text) rather than the test.

Run: `npm test -- src/components/__tests__/ShareDialog.test.jsx`
Expected: PASS (existing #239 tests still green — the raw-sub add path and role change/remove still work; new #267 tests green).

- [ ] **Step 6: Commit**

```bash
git add src/components/ShareDialog.jsx src/App.jsx src/components/__tests__/ShareDialog.test.jsx
git commit -F- <<'EOF'
feat(ui): ShareDialog email invites, pending list, names, copy-link (#267)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
```

---

## Task 15: Docs — ADR-0017 + CLAUDE.md, close #267

**Files:**
- Modify: `docs/adr/0017-room-authorization-model.md`
- Modify: `CLAUDE.md` (Collaboration Server / authorization section)

- [ ] **Step 1: Amend ADR-0017** — under Consequences, replace the "Share discovery limitation" item with the pending-invite model. Cover, in prose:
  1. `pending` (email→{role,invitedBy,invitedAt}) + `display` (sub→{name,email}) added to `.acl.json`; both additive/optional, read-compatible with #211/#239 sidecars.
  2. `resolveRole(acl, user, now, ttlMs)` is the ONE role decision across HTTP `authorize()`, WS `onAuthenticate`, the revoke sweep, AND `GET /rooms` listing (no listing/authorize asymmetry; a caller's own pending-invited rooms list, badged `viaPending`).
  3. `promotePending` at WS connect (fire-and-forget; null-guard + `isDeleted` tombstone guard; prunes expired; upgrades bound-lower).
  4. `SIM_PENDING_INVITE_TTL_MS` lazy expiry (default 30 days, boot-validated, never disables sharing).
  5. Shared per-composite-key ACL mutex (`server/acl-mutex.cjs`), single-instance-bound (same footnote as the `documents` map / revoke sweep / store re-entrancy).
  6. **Reversal of decision 6:** email is now an authz INPUT, safe ONLY under the verified-immutable-unique-per-sub IdP precondition; if the IdP can't guarantee it, disable share-by-email for that deployment.
  7. **New PII-at-rest surface:** `.acl.json` now persists email addresses (pending + display), including lingering expired-but-unpruned invites — note for CUI/retention review.
  8. `MAX_PENDING_INVITES` (200) + `MAX_ACL_BYTES` (256 KB) caps; pending-remove live-session kick via `revokeLiveSessions({ emails })`.

- [ ] **Step 2: Update CLAUDE.md** — in the Collaboration Server authorization section, add: share route now accepts email (cap + pending-remove kick); `resolveRole` as the shared HTTP+WS+revoke-sweep+`GET /rooms` decision; `promotePending` at connect; `.acl.json` gains `pending`/`display`; lazy `SIM_PENDING_INVITE_TTL_MS`; the shared ACL mutex (single-instance-bound); the decision-6 reversal + verified-IdP precondition; and the invariant: **`writeAcl` is a full-object overwrite, so every ACL writer must RMW the COMPLETE object (`ownerId` + `roles` + `pending` + `display`) — never a partial `{ ownerId, roles }`.**

- [ ] **Step 3: Verify no stale references** — Run: `grep -rn "Share discovery limitation" docs/adr/0017-room-authorization-model.md` → expect no match (replaced).

- [ ] **Step 4: Commit**

```bash
git add docs/adr/0017-room-authorization-model.md CLAUDE.md
git commit -F- <<'EOF'
docs: document share-by-email in ADR-0017 + CLAUDE.md (#267)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
```

---

## Task 16: Full server + client suites, then open the PR

**Files:** none (verification + PR)

- [ ] **Step 1: Run the full server suite**

Run: `npm run test:server`
Expected: PASS (authorize, hocuspocus-auth, hocuspocus-server, http-endpoints, http-share-email, secwriter-database, acl-mutex, promote-pending). No regressions. Confirm no file exceeds the ≤30-test cap (`http-endpoints` stays at 29; #267 endpoint tests live in the new `http-share-email` file).

- [ ] **Step 2: Run the client unit suite**

Run: `npm test`
Expected: PASS (ShareDialog + CSP + no-exfil + all existing).

- [ ] **Step 3: Assert single Yjs instance (CI parity)**

Run: `npm ls yjs`
Expected: a single deduped `yjs` (no second non-deduped copy — the CI gate).

- [ ] **Step 4: Open the PR referencing #267**

```bash
git push -u origin claude/caveman-mode-71d11c
```

Then open a PR whose body summarizes the seams (email invite, resolveRole everywhere, promotePending, mutex, caps, kick, listing, copy-link), the decision-6 reversal + IdP precondition, and the new PII-at-rest surface. Title: `feat: share rooms by email (#267)`. Include `Closes #267`.

---

## Notes for the implementer

1. **Task order matters.** Tasks 1→2→3 build `authorize.cjs` bottom-up; 4/5/6/7 are independent leaves; 8 must precede the share route's kick (Task 10) since it adds the `{ emails }` selector; 9 wires the mutex the share route (10) and promote depend on. If you reorder, keep the `roleOf`→`resolveRole` import swap in `collab-server.cjs` (Tasks 8+13) consistent — don't leave a dangling `roleOf` import once the sweep no longer uses it.
2. **`auth-jwt.cjs` does NOT lowercase `email`** (`email: payload.email || null`). Every compare goes through `normalizeEmail` — never compare a raw `user.email`.
3. **The purity boundary is `resolveRole`.** It never reads a clock or env. `authorize()`, `onAuthenticate`, the sweep, and the listing each read `Date.now()` + `pendingInviteTtlMs()` and pass them in.
4. **`promotePending` is fire-and-forget** — the connect verdict already came from `resolveRole`. Never `await` it in `onAuthenticate`.
5. **Never construct a partial `{ ownerId, roles }`** on any ACL write — always spread the full object (`{ ...acl, roles, pending, display }`).
6. **Server tests use `node --test`, not Vitest** (`npm run test:server`). Client tests use Vitest (`npm test`). Don't cross them.
7. When filling the `hocuspocus-server.test.mjs` skeletons (Tasks 8, 9, 13), copy the exact two-provider loopback + close-code assertion pattern from the existing T1–T4 revoke tests rather than inventing a new harness.
