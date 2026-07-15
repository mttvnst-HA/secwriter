/**
 * #267 — share-by-email tests for the PATCH /rooms/:roomId/share route.
 *
 * Exercises the real createHttpHandler from http-handler.cjs backed by a real
 * LocalStorageBackend in a temp dir, under auth=jwt (bearer with a tenant
 * claim). Covers: the email pending-invite branch, full-object read-modify-write
 * (roles + pending + display preserved), the MAX_PENDING_INVITES + MAX_ACL_BYTES
 * caps, the pending-remove live-session kick, and owner-only enforcement.
 *
 * The pending shape is NOT surfaced by GET /rooms/:id/acl (that route returns
 * only { ownerId, roles }), so pending assertions read the sidecar directly via
 * storage.readAcl — the same pattern http-endpoints.test.mjs uses.
 *
 * Run: node --test server/__tests__/http-share-email.test.mjs
 */

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import http from 'node:http';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require('../dom-polyfill.cjs');

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const { MAX_PENDING_INVITES, MAX_ACL_BYTES } = require('../auth/authorize.cjs');

function httpJson(url, method, jsonBody, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const payload = jsonBody != null ? JSON.stringify(jsonBody) : '';
    const req = http.request({
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      method,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), ...extraHeaders },
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

const jwt = require('jsonwebtoken');
const AUTHZ_SECRET = 'share-email-test-secret';
function bearer(claims) {
  return { Authorization: `Bearer ${jwt.sign(claims, AUTHZ_SECRET, { algorithm: 'HS256' })}` };
}

// Mirror of http-endpoints.test.mjs's makeAuthServer, plus a stub
// revokeLiveSessions that captures its opts so the pending-remove kick is
// observable. withAclLock is deliberately omitted (the route falls back to
// running its RMW directly — no concurrent promote to race in a test).
function makeShareServer() {
  const { createAuthJwt } = require('../auth/auth-jwt.cjs');
  const { LocalStorageBackend } = require('../storage-local.cjs');
  const { createHttpHandler } = require('../http-handler.cjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sim-share-email-'));
  const storage = new LocalStorageBackend(dir);
  const boundDocs = new Map();
  const kicks = [];
  const handler = createHttpHandler({
    storage, boundDocs,
    flushRoom: async () => {},
    maxDocBytes: 8 * 1024 * 1024,
    authProvider: createAuthJwt({ secret: AUTHZ_SECRET }),
    revokeLiveSessions: (t, r, opts) => kicks.push({ t, r, opts }),
  });
  const server = http.createServer(handler);
  return { server, storage, dir, kicks, cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} } };
}

async function start(h) {
  await new Promise(r => h.server.listen(0, r));
  return `http://127.0.0.1:${h.server.address().port}`;
}

describe('#267 share by email', () => {
  it('email add stores a pending invite (not a roles entry); never-registered ok; malformed → 400', async () => {
    const h = makeShareServer();
    const base = await start(h);
    try {
      await httpJson(`${base}/rooms`, 'POST', { id: 'r1' }, bearer({ sub: 'owner', tenant: 'acme' }));
      const owner = bearer({ sub: 'owner', tenant: 'acme' });

      const add = await httpJson(`${base}/rooms/r1/share`, 'PATCH', { email: 'Bob@Corp.com', action: 'add', role: 'editor' }, owner);
      assert.equal(add.status, 200);

      const acl = await h.storage.readAcl('acme', 'r1');
      assert.equal(acl.pending['bob@corp.com'].role, 'editor', 'email lowercased into pending');
      assert.deepEqual(acl.roles, {}, 'no roles entry created by an email add');

      // No lookup oracle: a never-registered address still stores a pending
      // invite, defaulting to editor when role is omitted.
      const add2 = await httpJson(`${base}/rooms/r1/share`, 'PATCH', { email: 'nobody@corp.com', action: 'add' }, owner);
      assert.equal(add2.status, 200);
      assert.equal((await h.storage.readAcl('acme', 'r1')).pending['nobody@corp.com'].role, 'editor');

      const bad = await httpJson(`${base}/rooms/r1/share`, 'PATCH', { email: 'bad', action: 'add' }, owner);
      assert.equal(bad.status, 400);
    } finally { h.server.close(); h.cleanup(); }
  });

  it('raw-sub add/remove preserves pending + display (full-object RMW, blocker #1)', async () => {
    const h = makeShareServer();
    const base = await start(h);
    try {
      const invitedAt = new Date().toISOString();
      await h.storage.writeAcl('acme', 'r1', {
        ownerId: 'owner',
        roles: {},
        pending: { 'bob@corp.com': { role: 'editor', invitedAt, invitedBy: 'owner' } },
        display: { s1: { name: 'S', email: 's@corp.com' } },
      });

      const add = await httpJson(`${base}/rooms/r1/share`, 'PATCH', { userId: 'x', action: 'add' }, bearer({ sub: 'owner', tenant: 'acme' }));
      assert.equal(add.status, 200);

      const acl = await h.storage.readAcl('acme', 'r1');
      assert.equal(acl.roles.x, 'editor', 'raw-sub grant landed');
      assert.ok(acl.pending['bob@corp.com'], 'pending survived the raw-sub RMW (not wiped by partial rebuild)');
      assert.deepEqual(acl.display.s1, { name: 'S', email: 's@corp.com' }, 'display survived the raw-sub RMW');
    } finally { h.server.close(); h.cleanup(); }
  });

  it('email add at MAX_PENDING_INVITES → 429', async () => {
    const h = makeShareServer();
    const base = await start(h);
    try {
      const invitedAt = new Date().toISOString();
      const pending = {};
      for (let i = 0; i < MAX_PENDING_INVITES; i++) {
        pending[`pending${i}@corp.com`] = { role: 'editor', invitedAt, invitedBy: 'owner' };
      }
      await h.storage.writeAcl('acme', 'r1', { ownerId: 'owner', roles: {}, pending });

      // A NEW email at the cap → 429.
      const over = await httpJson(`${base}/rooms/r1/share`, 'PATCH', { email: 'new@corp.com', action: 'add' }, bearer({ sub: 'owner', tenant: 'acme' }));
      assert.equal(over.status, 429);

      // Re-adding an EXISTING pending email at the cap replaces (does not grow) → 200.
      const replace = await httpJson(`${base}/rooms/r1/share`, 'PATCH', { email: 'pending0@corp.com', action: 'add', role: 'viewer' }, bearer({ sub: 'owner', tenant: 'acme' }));
      assert.equal(replace.status, 200);
      assert.equal((await h.storage.readAcl('acme', 'r1')).pending['pending0@corp.com'].role, 'viewer');
    } finally { h.server.close(); h.cleanup(); }
  });

  it('a write exceeding MAX_ACL_BYTES → 400 (share side, seam 7)', async () => {
    const h = makeShareServer();
    const base = await start(h);
    try {
      // Fill pending with LIVE (unexpired) entries until the serialized ACL is
      // just under MAX_ACL_BYTES, staying well under the count cap so the byte
      // check — not the count check — is what fires.
      const invitedAt = new Date().toISOString();
      const acl = { ownerId: 'owner', roles: {}, pending: {} };
      const pad = 'x'.repeat(3000);
      let i = 0;
      while (i < MAX_PENDING_INVITES - 5) {
        acl.pending[`p${i}@${pad}.example.com`] = { role: 'editor', invitedAt, invitedBy: 'owner' };
        if (Buffer.byteLength(JSON.stringify(acl), 'utf-8') >= MAX_ACL_BYTES - 5000) break;
        i++;
      }
      assert.ok(Buffer.byteLength(JSON.stringify(acl), 'utf-8') < MAX_ACL_BYTES, 'seeded ACL must start under the cap');
      await h.storage.writeAcl('acme', 'r1', acl);

      // A NEW big email add tips it over → 400 'ACL too large'.
      const bigEmail = 'z'.repeat(6000) + '@corp.com';
      const over = await httpJson(`${base}/rooms/r1/share`, 'PATCH', { email: bigEmail, action: 'add' }, bearer({ sub: 'owner', tenant: 'acme' }));
      assert.equal(over.status, 400);
      assert.ok(over.body.toString().includes('ACL too large'));
    } finally { h.server.close(); h.cleanup(); }
  });

  it('email remove kicks the live session ONLY when a pending entry existed (major #4)', async () => {
    const h = makeShareServer();
    const base = await start(h);
    try {
      const invitedAt = new Date().toISOString();
      await h.storage.writeAcl('acme', 'r1', {
        ownerId: 'owner', roles: {},
        pending: { 'bob@corp.com': { role: 'editor', invitedAt, invitedBy: 'owner' } },
      });

      const rm = await httpJson(`${base}/rooms/r1/share`, 'PATCH', { email: 'bob@corp.com', action: 'remove' }, bearer({ sub: 'owner', tenant: 'acme' }));
      assert.equal(rm.status, 200);
      assert.equal(h.kicks.length, 1, 'a removed pending invite kicks live sessions');
      assert.deepEqual(h.kicks[0].opts, { emails: ['bob@corp.com'] });
      assert.equal((await h.storage.readAcl('acme', 'r1')).pending['bob@corp.com'], undefined);

      // Removing a NON-existent pending email is a 200 no-op AND does NOT kick.
      const rm2 = await httpJson(`${base}/rooms/r1/share`, 'PATCH', { email: 'ghost@corp.com', action: 'remove' }, bearer({ sub: 'owner', tenant: 'acme' }));
      assert.equal(rm2.status, 200);
      assert.equal(h.kicks.length, 1, 'a no-op remove must not kick again (gated on pendingRemoved)');
    } finally { h.server.close(); h.cleanup(); }
  });

  it('a non-owner PATCH /share → 404 (owner-only preserved)', async () => {
    const h = makeShareServer();
    const base = await start(h);
    try {
      await httpJson(`${base}/rooms`, 'POST', { id: 'r1' }, bearer({ sub: 'owner', tenant: 'acme' }));
      const res = await httpJson(`${base}/rooms/r1/share`, 'PATCH', { email: 'x@corp.com', action: 'add' }, bearer({ sub: 'editor', tenant: 'acme' }));
      assert.equal(res.status, 404);
    } finally { h.server.close(); h.cleanup(); }
  });

  it('#267: GET /acl returns pending + display alongside roles (read-only)', async () => {
    const h = makeShareServer();
    const base = await start(h);
    try {
      const invitedAt = new Date().toISOString();
      const seeded = {
        ownerId: 'owner',
        roles: { ed: 'editor' },
        pending: { 'bob@y.com': { role: 'editor', invitedAt, invitedBy: 'owner' } },
        display: { ed: { name: 'Ed', email: 'ed@y.com' } },
      };
      await h.storage.writeAcl('acme', 'r1', seeded);
      const before = JSON.stringify(await h.storage.readAcl('acme', 'r1'));

      const res = await httpJson(`${base}/rooms/r1/acl`, 'GET', null, bearer({ sub: 'owner', tenant: 'acme' }));
      assert.equal(res.status, 200);
      const body = JSON.parse(res.body.toString());
      assert.equal(body.ownerId, 'owner');
      assert.equal(body.roles.ed, 'editor');
      assert.equal(body.pending['bob@y.com'].role, 'editor');
      assert.equal(body.display.ed.name, 'Ed');

      // Strictly read-only: the GET must not have normalized/written anything
      // back to the sidecar.
      const after = JSON.stringify(await h.storage.readAcl('acme', 'r1'));
      assert.equal(after, before, 'GET /acl must not persist any normalization');
    } finally { h.server.close(); h.cleanup(); }
  });
});
