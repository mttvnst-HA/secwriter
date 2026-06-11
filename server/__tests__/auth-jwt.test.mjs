/**
 * Tests for server/auth/auth-jwt.cjs
 *
 * Uses Node's built-in test runner.
 * Run: node --test server/__tests__/auth-jwt.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const jwt = require_('jsonwebtoken');
const { createAuthJwt } = require_('../auth/auth-jwt.cjs');

const SECRET = 'test-secret-key-for-unit-tests';

describe('auth-jwt', () => {
  const auth = createAuthJwt({ secret: SECRET });

  it('validates a valid HS256 token', async () => {
    const token = jwt.sign({ sub: 'user-1', name: 'Matt V', email: 'matt@example.com' }, SECRET);
    const user = await auth.validateToken(token);
    assert.ok(user);
    assert.strictEqual(user.id, 'user-1');
    assert.strictEqual(user.name, 'Matt V');
    assert.strictEqual(user.email, 'matt@example.com');
  });

  it('returns null for expired token', async () => {
    const token = jwt.sign({ sub: 'user-1', name: 'Test' }, SECRET, { expiresIn: -10 });
    const user = await auth.validateToken(token);
    assert.strictEqual(user, null);
  });

  it('returns null for invalid signature', async () => {
    const token = jwt.sign({ sub: 'user-1', name: 'Test' }, 'wrong-secret');
    const user = await auth.validateToken(token);
    assert.strictEqual(user, null);
  });

  it('returns null for null token', async () => {
    const user = await auth.validateToken(null);
    assert.strictEqual(user, null);
  });

  it('extracts token from Authorization header', () => {
    const req = { headers: { authorization: 'Bearer abc123' } };
    assert.strictEqual(auth.extractToken(req), 'abc123');
  });

  it('returns null for missing Authorization header', () => {
    const req = { headers: {} };
    assert.strictEqual(auth.extractToken(req), null);
  });

  it('validates issuer when configured', async () => {
    const authWithIssuer = createAuthJwt({ secret: SECRET, issuer: 'https://login.example.com' });
    const goodToken = jwt.sign({ sub: 'u1', name: 'T', iss: 'https://login.example.com' }, SECRET);
    const badToken = jwt.sign({ sub: 'u1', name: 'T', iss: 'https://evil.com' }, SECRET);
    assert.ok(await authWithIssuer.validateToken(goodToken));
    assert.strictEqual(await authWithIssuer.validateToken(badToken), null);
  });

  it('uses sub as id and falls back to email for name', async () => {
    const token = jwt.sign({ sub: 'user-2', email: 'test@example.com' }, SECRET);
    const user = await auth.validateToken(token);
    assert.strictEqual(user.id, 'user-2');
    assert.strictEqual(user.name, 'test@example.com');
  });
});

const SECRET2 = 'test-secret';
const providerT = createAuthJwt({ secret: SECRET2 });
const signT = (claims) => jwt.sign(claims, SECRET2, { algorithm: 'HS256' });

describe('auth-jwt tenant + stable subject', () => {
  it('extracts tenant from tenant/org/tid and id from sub/oid', async () => {
    assert.equal((await providerT.validateToken(signT({ sub: 's1', tenant: 'acme' }))).tenant, 'acme');
    assert.equal((await providerT.validateToken(signT({ sub: 's1', org: 'beta' }))).tenant, 'beta');
    assert.equal((await providerT.validateToken(signT({ oid: 'o1', tid: 'azure-t' }))).id, 'o1');
    assert.equal((await providerT.validateToken(signT({ oid: 'o1', tid: 'azure-t' }))).tenant, 'azure-t');
  });

  it('does NOT fall back to email/unknown for id (distinct users must not collapse)', async () => {
    const u = await providerT.validateToken(signT({ email: 'a@b.com', tenant: 'acme' })); // no sub/oid
    assert.equal(u.id, null, 'id is null without sub/oid');
    assert.equal(u.email, 'a@b.com', 'email still populates display identity');
  });

  it('tenant is null when no tenant/org/tid claim present', async () => {
    assert.equal((await providerT.validateToken(signT({ sub: 's1' }))).tenant, null);
  });
});
