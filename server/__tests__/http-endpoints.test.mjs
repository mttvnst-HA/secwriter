/**
 * HTTP endpoint tests for collab-server download/upload routes.
 *
 * Uses the real createHttpHandler from http-handler.cjs backed by a real
 * LocalStorageBackend in a temp directory. Tests cover GET /rooms/:roomId/sec,
 * GET /rooms/:roomId/comments, GET /rooms (list), POST /rooms/:roomId/upload,
 * and 404 for unknown rooms.
 *
 * Run: node --test server/__tests__/http-endpoints.test.mjs
 */

import { describe, it, before, after } from 'node:test';
import { strict as assert } from 'node:assert';
import http from 'node:http';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require('../dom-polyfill.cjs');

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
}

function httpPost(url, body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request({
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', ...extraHeaders },
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

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

function httpDelete(url, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request({
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      method: 'DELETE',
      headers: { ...extraHeaders },
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('HTTP endpoints', () => {
  let tmpDir, server, baseUrl, storage, boundDocs;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sim-http-'));
    const { LocalStorageBackend } = require('../storage-local.cjs');
    storage = new LocalStorageBackend(tmpDir);
    boundDocs = new Map();

    // Seed test data under _public tenant (matches PUBLIC_TENANT used by http-handler)
    await storage.writeRoom('_public', 'test-room', {
      ydocBytes: Buffer.from([1, 2, 3]),
      secBytes: Buffer.from('<?xml version="1.0"?><SEC><TXT>Hello</TXT></SEC>'),
      commentsJson: JSON.stringify({ version: 1, comments: [{ id: 'c1', status: 'open' }] }),
    });

    // Seed a room with .ydoc only (no SEC, no comments) — legacy room
    await storage.writeRoom('_public', 'legacy-room', {
      ydocBytes: Buffer.from([4, 5, 6]),
      secBytes: null,
      commentsJson: null,
    });

    // Use the real HTTP handler from http-handler.cjs
    const { createHttpHandler } = require('../http-handler.cjs');
    const handler = createHttpHandler({
      storage,
      boundDocs,
      flushRoom: async () => {},  // no-op for download/list tests
      maxDocBytes: 8 * 1024 * 1024,
    });
    server = http.createServer(handler);

    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  after(async () => {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('GET /rooms/:roomId/sec returns SEC content with correct headers', async () => {
    const resp = await httpGet(`${baseUrl}/rooms/test-room/sec`);
    assert.strictEqual(resp.status, 200);
    assert.ok(resp.headers['content-type'].includes('application/xml'));
    assert.ok(resp.headers['content-disposition'].includes('test-room.SEC'));
    const body = resp.body.toString();
    assert.ok(body.includes('<?xml'));
    assert.ok(body.includes('Hello'));
  });

  it('GET /rooms/:roomId/comments returns JSON with comment data', async () => {
    const resp = await httpGet(`${baseUrl}/rooms/test-room/comments`);
    assert.strictEqual(resp.status, 200);
    const data = JSON.parse(resp.body.toString());
    assert.strictEqual(data.version, 1);
    assert.strictEqual(data.comments.length, 1);
    assert.strictEqual(data.comments[0].id, 'c1');
  });

  it('GET /rooms/:roomId/sec returns 404 for unknown room', async () => {
    const resp = await httpGet(`${baseUrl}/rooms/nonexistent/sec`);
    assert.strictEqual(resp.status, 404);
    assert.ok(resp.body.toString().includes('not found'));
  });

  it('GET /rooms/:roomId/sec returns 404 for legacy room without SEC', async () => {
    const resp = await httpGet(`${baseUrl}/rooms/legacy-room/sec`);
    assert.strictEqual(resp.status, 404);
    assert.ok(resp.body.toString().includes('not yet generated'));
  });

  it('GET /rooms/:roomId/comments returns empty array for legacy room', async () => {
    const resp = await httpGet(`${baseUrl}/rooms/legacy-room/comments`);
    assert.strictEqual(resp.status, 200);
    const data = JSON.parse(resp.body.toString());
    assert.strictEqual(data.version, 1);
    assert.deepStrictEqual(data.comments, []);
  });

  it('GET /rooms lists all seeded rooms as metadata objects', async () => {
    const resp = await httpGet(`${baseUrl}/rooms`);
    assert.strictEqual(resp.status, 200);
    const data = JSON.parse(resp.body.toString());
    assert.ok(Array.isArray(data.rooms));
    const ids = data.rooms.map(r => r.id);
    assert.ok(ids.includes('test-room'), 'test-room should be in list');
    assert.ok(ids.includes('legacy-room'), 'legacy-room should be in list');
    // Each room should have metadata fields
    const testRoom = data.rooms.find(r => r.id === 'test-room');
    assert.ok(testRoom.lastModified, 'should have lastModified');
    assert.ok(testRoom.sizeBytes > 0, 'should have sizeBytes');
    assert.deepStrictEqual(testRoom.activeUsers, []);
    assert.strictEqual(testRoom.locked, false);
  });

  it('GET /rooms returns room metadata from persisted Y.Doc', async () => {
    const Y = require('yjs');
    const ydoc = new Y.Doc();
    const yMeta = ydoc.getMap('meta');
    ydoc.transact(() => {
      yMeta.set('sectionNumber', '31 00 00');
      yMeta.set('sectionTitle', 'EARTHWORK');
    });
    const ydocBytes = Buffer.from(Y.encodeStateAsUpdate(ydoc));
    await storage.writeRoom('_public', 'test-meta', { ydocBytes, secBytes: null, commentsJson: null });
    ydoc.destroy();

    const resp = await httpGet(`${baseUrl}/rooms`);
    assert.strictEqual(resp.status, 200);
    const body = JSON.parse(resp.body.toString());
    assert.ok(Array.isArray(body.rooms));
    const room = body.rooms.find(r => r.id === 'test-meta');
    assert.ok(room, 'room should be in list');
    assert.strictEqual(room.sectionNumber, '31 00 00');
    assert.strictEqual(room.displayName, '31 00 00 EARTHWORK');
  });

  it('GET /unknown returns 404', async () => {
    const resp = await httpGet(`${baseUrl}/unknown`);
    assert.strictEqual(resp.status, 404);
  });

  // --- Room management endpoints ---

  it('POST /rooms creates a new empty room', async () => {
    const resp = await httpJson(`${baseUrl}/rooms`, 'POST', { id: 'new-room', displayName: 'Test Room' });
    assert.strictEqual(resp.status, 201);
    const data = JSON.parse(resp.body.toString());
    assert.strictEqual(data.id, 'new-room');
    assert.strictEqual(data.ok, true);
    // Verify room exists in storage
    const stored = await storage.readRoom('_public', 'new-room');
    assert.ok(stored, 'room should exist in storage');
    assert.ok(stored.ydocBytes, 'should have ydoc bytes');
  });

  it('POST /rooms returns 409 for existing room', async () => {
    const resp = await httpJson(`${baseUrl}/rooms`, 'POST', { id: 'test-room' });
    assert.strictEqual(resp.status, 409);
    const data = JSON.parse(resp.body.toString());
    assert.ok(data.error.includes('already exists'));
  });

  it('DELETE /rooms/:roomId deletes a room', async () => {
    // Create a room to delete
    await storage.writeRoom('_public', 'del-room', {
      ydocBytes: Buffer.from([10, 11, 12]),
      secBytes: null,
      commentsJson: null,
    });
    const resp = await httpDelete(`${baseUrl}/rooms/del-room`);
    assert.strictEqual(resp.status, 200);
    const data = JSON.parse(resp.body.toString());
    assert.strictEqual(data.ok, true);
    // Verify room is gone
    const stored = await storage.readRoom('_public', 'del-room');
    assert.strictEqual(stored, null);
  });

  it('DELETE /rooms/:roomId returns 404 for nonexistent room', async () => {
    const resp = await httpDelete(`${baseUrl}/rooms/no-such-room`);
    assert.strictEqual(resp.status, 404);
    const data = JSON.parse(resp.body.toString());
    assert.ok(data.error.includes('not found'));
  });

  it('PATCH /rooms/:roomId updates room settings', async () => {
    // Create a room to patch
    const Y = require('yjs');
    const ydoc = new Y.Doc();
    const ydocBytes = Buffer.from(Y.encodeStateAsUpdate(ydoc));
    ydoc.destroy();
    await storage.writeRoom('_public', 'patch-room', { ydocBytes, secBytes: null, commentsJson: null });

    const resp = await httpJson(`${baseUrl}/rooms/patch-room`, 'PATCH', { locked: true });
    assert.strictEqual(resp.status, 200);
    const data = JSON.parse(resp.body.toString());
    assert.strictEqual(data.ok, true);

    // Verify locked was persisted in yMeta
    const stored = await storage.readRoom('_public', 'patch-room');
    const verifyDoc = new Y.Doc();
    Y.applyUpdate(verifyDoc, stored.ydocBytes);
    const yMeta = verifyDoc.getMap('meta');
    assert.strictEqual(yMeta.get('locked'), true);
    verifyDoc.destroy();
  });

  it('PATCH /rooms/:roomId returns 404 for nonexistent room', async () => {
    const resp = await httpJson(`${baseUrl}/rooms/no-such-room`, 'PATCH', { locked: true });
    assert.strictEqual(resp.status, 404);
    const data = JSON.parse(resp.body.toString());
    assert.ok(data.error.includes('not found'));
  });

  // --- #215: locked-room enforcement (DELETE / PATCH / upload return 423) ---

  // Persist a room whose yMeta is locked by `owner`.
  async function seedLockedRoom(id, owner) {
    const Y = require('yjs');
    const ydoc = new Y.Doc();
    const yMeta = ydoc.getMap('meta');
    ydoc.transact(() => {
      yMeta.set('locked', true);
      if (owner) yMeta.set('lockedBy', owner);
    });
    const ydocBytes = Buffer.from(Y.encodeStateAsUpdate(ydoc));
    ydoc.destroy();
    await storage.writeRoom('_public', id, { ydocBytes, secBytes: null, commentsJson: null });
  }

  it('DELETE on a locked room: 423 for non-owner (and no-owner lock), 200 for the lock owner', async () => {
    // Lock with a recorded owner: only the owner may delete.
    await seedLockedRoom('lock-del', 'userA');
    const blocked = await httpDelete(`${baseUrl}/rooms/lock-del`);
    assert.strictEqual(blocked.status, 423);
    assert.ok(JSON.parse(blocked.body.toString()).error.includes('locked'));
    assert.ok(await storage.readRoom('_public', 'lock-del'), 'room must survive a blocked delete');

    const wrong = await httpDelete(`${baseUrl}/rooms/lock-del`, { 'X-Actor-Id': 'someone-else' });
    assert.strictEqual(wrong.status, 423);

    const owner = await httpDelete(`${baseUrl}/rooms/lock-del`, { 'X-Actor-Id': 'userA' });
    assert.strictEqual(owner.status, 200);
    assert.strictEqual(await storage.readRoom('_public', 'lock-del'), null);

    // Locked with NO recorded owner blocks everyone (matches issue verification).
    await seedLockedRoom('lock-del-noowner', null);
    const noOwner = await httpDelete(`${baseUrl}/rooms/lock-del-noowner`);
    assert.strictEqual(noOwner.status, 423);
  });

  it('PATCH on a locked room: non-owner cannot unlock, owner can', async () => {
    await seedLockedRoom('lock-patch', 'userC');

    const blocked = await httpJson(`${baseUrl}/rooms/lock-patch`, 'PATCH', { locked: false });
    assert.strictEqual(blocked.status, 423);

    const owner = await httpJson(`${baseUrl}/rooms/lock-patch`, 'PATCH', { locked: false }, { 'X-Actor-Id': 'userC' });
    assert.strictEqual(owner.status, 200);

    const Y = require('yjs');
    const verify = new Y.Doc();
    Y.applyUpdate(verify, (await storage.readRoom('_public', 'lock-patch')).ydocBytes);
    assert.strictEqual(verify.getMap('meta').get('locked'), false);
    verify.destroy();
  });

  it('POST upload on a locked (live) room: 423 for non-owner, proceeds for the lock owner', async () => {
    const { serializeSEC } = await import('../../src/lib/sec-serializer.js');
    const secXml = serializeSEC(
      [{ id: 'b1', type: 'txt', part: 1, depth: 0, html: 'Hello.' }],
      { sectionNumber: '01 00 00', sectionTitle: 'TEST' },
    );

    // Lock state lives on the live Y.Doc (upload requires an active session).
    const Y = require('yjs');
    const liveDoc = new Y.Doc();
    liveDoc.transact(() => {
      const m = liveDoc.getMap('meta');
      m.set('locked', true);
      m.set('lockedBy', 'userB');
    });
    boundDocs.set('_public/lock-up', liveDoc);
    try {
      const blocked = await httpPost(`${baseUrl}/rooms/lock-up/upload`, Buffer.from(secXml));
      assert.strictEqual(blocked.status, 423);

      const owner = await httpPost(`${baseUrl}/rooms/lock-up/upload`, Buffer.from(secXml), { 'X-Actor-Id': 'userB' });
      assert.strictEqual(owner.status, 200);
      assert.strictEqual(JSON.parse(owner.body.toString()).blocks, 1);
    } finally {
      boundDocs.delete('_public/lock-up');
      liveDoc.destroy();
    }
  });

  it('POST /rooms/:roomId/upload returns 409 when room has no active Y.Doc', async () => {
    // Generate valid SEC content via the serializer
    const { serializeSEC } = await import('../../src/lib/sec-serializer.js');
    const blocks = [
      { id: 'b1', type: 'title', part: 1, depth: 0, html: 'GENERAL' },
      { id: 'b2', type: 'txt', part: 1, depth: 0, section: 'b1', html: 'Hello.' },
    ];
    const secXml = serializeSEC(blocks, { sectionNumber: '01 00 00', sectionTitle: 'TEST' });

    const resp = await httpPost(`${baseUrl}/rooms/inactive-room/upload`, Buffer.from(secXml));
    assert.strictEqual(resp.status, 409);
    assert.ok(resp.body.toString().includes('no active session'));
  });

  it('HTTP returns 401 when auth rejects token', async () => {
    const { createHttpHandler } = require('../http-handler.cjs');
    const rejectAuth = {
      requiresAuth: true,
      async validateToken() { return null; },
      extractToken(req) { return req.headers?.authorization?.slice(7) || null; },
    };
    const handler = createHttpHandler({
      storage, boundDocs: new Map(), flushRoom: async () => {},
      maxDocBytes: 8 * 1024 * 1024, authProvider: rejectAuth,
    });
    const srv = http.createServer(handler);
    await new Promise(r => srv.listen(0, '127.0.0.1', r));
    const port = srv.address().port;
    try {
      const resp = await new Promise((resolve, reject) => {
        const req = http.request({
          hostname: '127.0.0.1', port, path: '/rooms',
          method: 'GET',
          headers: { Authorization: 'Bearer bad-token' },
        }, (res) => {
          const chunks = [];
          res.on('data', c => chunks.push(c));
          res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
        });
        req.on('error', reject);
        req.end();
      });
      assert.strictEqual(resp.status, 401);
      assert.ok(resp.body.toString().includes('Unauthorized'));
    } finally {
      srv.close();
    }
  });

  it('CORS: defaults to wildcard, reflects custom allowedOrigin', async () => {
    // Default handler (already running) should return *
    const resp = await httpGet(`${baseUrl}/rooms`);
    assert.strictEqual(resp.headers['access-control-allow-origin'], '*');

    // Custom origin via allowedOrigin option
    const { createHttpHandler } = require('../http-handler.cjs');
    const customHandler = createHttpHandler({
      storage, boundDocs: new Map(), flushRoom: async () => {},
      maxDocBytes: 8 * 1024 * 1024, allowedOrigin: 'https://example.com',
    });
    const srv = http.createServer(customHandler);
    await new Promise(r => srv.listen(0, '127.0.0.1', r));
    const port = srv.address().port;
    try {
      const r2 = await httpGet(`http://127.0.0.1:${port}/rooms`);
      assert.strictEqual(r2.headers['access-control-allow-origin'], 'https://example.com');
    } finally {
      srv.close();
    }
  });

  it('GET /health returns status ok', async () => {
    const res = await httpGet(`${baseUrl}/health`);
    assert.equal(res.status, 200);
    const data = JSON.parse(res.body.toString());
    assert.equal(data.status, 'ok');
    assert.ok('uptime' in data);
    assert.ok('rooms' in data);
    assert.deepStrictEqual(data.unhealthyRooms, []);
  });

  it('POST /rooms/:roomId/upload with active Y.Doc seeds blocks and returns count', async () => {
    // Generate valid SEC content via the serializer
    const { serializeSEC } = await import('../../src/lib/sec-serializer.js');
    const blocks = [
      { id: 'b1', type: 'title', part: 1, depth: 0, html: 'GENERAL' },
      { id: 'b2', type: 'txt', part: 1, depth: 0, section: 'b1', html: 'Test paragraph.' },
    ];
    const secXml = serializeSEC(blocks, { sectionNumber: '01 00 00', sectionTitle: 'TEST' });

    // Create a Y.Doc and register it in boundDocs
    const Y = require('yjs');
    const ydoc = new Y.Doc();
    ydoc.getArray('order');
    ydoc.getMap('store');
    boundDocs.set('_public/upload-room', ydoc);

    try {
      const resp = await httpPost(`${baseUrl}/rooms/upload-room/upload`, Buffer.from(secXml));
      assert.strictEqual(resp.status, 200);
      const data = JSON.parse(resp.body.toString());
      assert.strictEqual(data.ok, true);
      assert.ok(data.blocks >= 2, `expected ≥2 blocks, got ${data.blocks}`);

      // Verify Y.Doc was actually seeded
      const yOrder = ydoc.getArray('order');
      assert.ok(yOrder.length >= 2, `yOrder should have ≥2 entries, got ${yOrder.length}`);

      // PR #51 review (issue d). Seed clears the migration sentinels so
      // the broker re-runs on the next WS upgrade and promotes the
      // seeded Y.Text slots to Y.XmlFragment. The HTTP path itself is
      // CJS-only (the broker runs in the WS upgrade handler, which is
      // exercised by collab-server tests).
      const yMeta = ydoc.getMap('meta');
      assert.strictEqual(yMeta.get('schemaVersion'), undefined,
        'seed must clear schemaVersion so the broker re-runs on upgrade');
      assert.strictEqual(yMeta.get('migrationPartial'), undefined,
        'seed must clear migrationPartial too');
    } finally {
      ydoc.destroy();
      boundDocs.delete('_public/upload-room');
    }
  });

  it('POST upload preserves windows-1252 smart punctuation through export (issue #212)', async () => {
    const { serializeSEC } = await import('../../src/lib/sec-serializer.js');
    const { encodeWindows1252 } = await import('../../src/lib/encoding.js');
    // em-dash U+2014, curly quotes U+201C/U+201D, bullet U+2022, euro U+20AC
    const punct = '—“”•€';
    const blocks = [
      { id: 'b1', type: 'title', part: 1, depth: 0, html: 'GENERAL' },
      { id: 'b2', type: 'txt', part: 1, depth: 0, section: 'b1', html: 'Dash' + punct + 'end.' },
    ];
    const secXml = serializeSEC(blocks, { sectionNumber: '01 00 00', sectionTitle: 'TEST' });
    // Upload genuine windows-1252 bytes (em-dash = 0x97, not the latin1 C1 codepoint).
    const uploadBytes = Buffer.from(encodeWindows1252(secXml));

    const Y = require('yjs');
    const ydoc = new Y.Doc();
    ydoc.getArray('order');
    ydoc.getMap('store');
    boundDocs.set('_public/punct-room', ydoc);

    try {
      const up = await httpPost(`${baseUrl}/rooms/punct-room/upload`, uploadBytes);
      assert.strictEqual(up.status, 200);

      // flushRoom is a no-op in this harness, so serialize the seeded Y.Doc in-test —
      // the faithful upload-decode → seed → export → bytes path. Corruption at the
      // upload decode turns each high byte into 0x3F ('?') on re-encode.
      const { yBlocksToArray } = await import('../../src/lib/collab.js');
      const seeded = yBlocksToArray(ydoc.getArray('order'), ydoc.getMap('store'));
      const exportXml = serializeSEC(seeded, { sectionNumber: '01 00 00', sectionTitle: 'TEST' });
      const out = Buffer.from(encodeWindows1252(exportXml)); // exported windows-1252 bytes

      // 0x3F also appears legitimately in the XML prolog `<?xml ?>`, so assert presence
      // of the specific high bytes rather than absence of 0x3F.
      for (const [name, byte] of [['em-dash', 0x97], ['left-quote', 0x93], ['right-quote', 0x94], ['bullet', 0x95], ['euro', 0x80]]) {
        assert.ok(out.includes(byte), `${name} byte 0x${byte.toString(16)} must survive upload→export (corrupted to 0x3F?)`);
      }
    } finally {
      ydoc.destroy();
      boundDocs.delete('_public/punct-room');
    }
  });
});

// ── helpers for auth=jwt tests ──────────────────────────────────────────────

const jwt = require('jsonwebtoken');
const AUTHZ_SECRET = 'http-test-secret';
function bearer(claims) {
  return { Authorization: `Bearer ${jwt.sign(claims, AUTHZ_SECRET, { algorithm: 'HS256' })}` };
}
function makeAuthServer() {
  const { createAuthJwt } = require('../auth/auth-jwt.cjs');
  const { LocalStorageBackend } = require('../storage-local.cjs');
  const { createHttpHandler } = require('../http-handler.cjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sim-authz-'));
  const storage = new LocalStorageBackend(dir);
  const boundDocs = new Map();
  const handler = createHttpHandler({
    storage, boundDocs,
    flushRoom: async () => {},
    maxDocBytes: 8 * 1024 * 1024,
    authProvider: createAuthJwt({ secret: AUTHZ_SECRET }),
    migrationCoordinator: { forget() {} },
  });
  const server = http.createServer(handler);
  return { server, storage, dir, cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} } };
}

describe('room authorization (auth=jwt)', () => {
  it('create writes owner ACL; owner reads, strangers + cross-tenant get 404', async () => {
    const h = makeAuthServer();
    await new Promise(r => h.server.listen(0, r));
    const base = `http://127.0.0.1:${h.server.address().port}`;
    try {
      let res = await httpJson(`${base}/rooms`, 'POST', { id: 'r1' }, bearer({ sub: 'owner', tenant: 'acme' }));
      assert.equal(res.status, 201);
      assert.deepEqual(await h.storage.readAcl('acme', 'r1'), { ownerId: 'owner', sharedWith: [] });

      res = await httpJson(`${base}/rooms/r1`, 'DELETE', null, bearer({ sub: 'stranger', tenant: 'acme' }));
      assert.equal(res.status, 404);
      res = await httpJson(`${base}/rooms/r1`, 'DELETE', null, bearer({ sub: 'owner', tenant: 'evil' }));
      assert.equal(res.status, 404);
      res = await httpJson(`${base}/rooms/r1`, 'DELETE', null, bearer({ sub: 'owner', tenant: 'acme' }));
      assert.equal(res.status, 200);

      // Orphan-ACL recovery (crash between writeAcl and writeRoom):
      // seed an ACL with NO .ydoc, confirm a different user can't hijack,
      // the owner's DELETE clears the orphan, and the owner can then re-create.
      await h.storage.writeAcl('acme', 'orphan', { ownerId: 'owner', sharedWith: [] });
      assert.equal((await httpJson(`${base}/rooms`, 'POST', { id: 'orphan' }, bearer({ sub: 'attacker', tenant: 'acme' }))).status, 409); // hijack blocked
      assert.equal((await httpJson(`${base}/rooms/orphan`, 'DELETE', null, bearer({ sub: 'owner', tenant: 'acme' }))).status, 404); // 404 but clears orphan
      assert.equal(await h.storage.readAcl('acme', 'orphan'), null, 'orphan ACL cleared by owner DELETE');
      assert.equal((await httpJson(`${base}/rooms`, 'POST', { id: 'orphan' }, bearer({ sub: 'owner', tenant: 'acme' }))).status, 201); // reclaimed
    } finally { h.server.close(); h.cleanup(); }
  });

  it('missing tenant → 403, missing stable subject → 403, hostile tenant cannot escape', async () => {
    const h = makeAuthServer();
    await new Promise(r => h.server.listen(0, r));
    const base = `http://127.0.0.1:${h.server.address().port}`;
    try {
      assert.equal((await httpJson(`${base}/rooms`, 'GET', null, bearer({ sub: 's' }))).status, 403);
      assert.equal((await httpJson(`${base}/rooms`, 'GET', null, bearer({ tenant: 'acme' }))).status, 403);
      assert.equal((await httpJson(`${base}/rooms`, 'GET', null, bearer({ sub: 's', tenant: '_public' }))).status, 403);
      const r = await httpJson(`${base}/rooms`, 'POST', { id: 'h' }, bearer({ sub: 's', tenant: '../x' }));
      assert.equal(r.status, 201);
      assert.equal(await h.storage.readAcl('___x', 'h') !== null, true); // sanitize('../x') === '___x'
    } finally { h.server.close(); h.cleanup(); }
  });

  it('share route: owner adds sharee → sharee reads /comments; non-owner share → 404; shared user cannot DELETE', async () => {
    const h = makeAuthServer();
    await new Promise(r => h.server.listen(0, r));
    const base = `http://127.0.0.1:${h.server.address().port}`;
    try {
      await httpJson(`${base}/rooms`, 'POST', { id: 'r1' }, bearer({ sub: 'owner', tenant: 'acme' }));
      assert.equal((await httpJson(`${base}/rooms/r1/share`, 'PATCH', { userId: 'x', action: 'add' }, bearer({ sub: 'stranger', tenant: 'acme' }))).status, 404);
      const s = await httpJson(`${base}/rooms/r1/share`, 'PATCH', { userId: 'friend', action: 'add' }, bearer({ sub: 'owner', tenant: 'acme' }));
      assert.equal(s.status, 200);
      assert.deepEqual((await h.storage.readAcl('acme', 'r1')).sharedWith, ['friend']);
      assert.equal((await httpJson(`${base}/rooms/r1/comments`, 'GET', null, bearer({ sub: 'friend', tenant: 'acme' }))).status, 200);
      assert.equal((await httpJson(`${base}/rooms/r1`, 'DELETE', null, bearer({ sub: 'friend', tenant: 'acme' }))).status, 404);
    } finally { h.server.close(); h.cleanup(); }
  });

  it('GET /rooms returns ONLY the caller tenant', async () => {
    const h = makeAuthServer();
    await new Promise(r => h.server.listen(0, r));
    const base = `http://127.0.0.1:${h.server.address().port}`;
    try {
      await httpJson(`${base}/rooms`, 'POST', { id: 'a1' }, bearer({ sub: 'o', tenant: 'acme' }));
      await httpJson(`${base}/rooms`, 'POST', { id: 'b1' }, bearer({ sub: 'o', tenant: 'beta' }));
      const res = await httpJson(`${base}/rooms`, 'GET', null, bearer({ sub: 'o', tenant: 'acme' }));
      const ids = JSON.parse(res.body.toString()).rooms.map(r => r.id);
      assert.deepEqual(ids.sort(), ['a1']);
    } finally { h.server.close(); h.cleanup(); }
  });
});

// PR #51 review (issue e) — regression. The migration coordinator caches
// `{ alreadyV2: true }` per docName. After DELETE /rooms/:id, a fresh
// room created with the same id (or a v1 SEC re-uploaded under it) would
// see the cached short-circuit and skip both archive + migration. The
// DELETE handler must call `migrationCoordinator.forget(roomId)` to drop
// the stale cache entry.
describe('HTTP endpoints — DELETE clears migration cache (issue e)', () => {
  let tmpDir, server, baseUrl, storage, coordCalls;
  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sim-http-cache-'));
    const { LocalStorageBackend } = require('../storage-local.cjs');
    storage = new LocalStorageBackend(tmpDir);
    await storage.writeRoom('_public', 'to-delete', {
      ydocBytes: Buffer.from([1, 2, 3]), secBytes: null, commentsJson: null,
    });
    coordCalls = [];
    const fakeCoordinator = {
      forget(docName) { coordCalls.push(['forget', docName]); },
    };
    const { createHttpHandler } = require('../http-handler.cjs');
    const handler = createHttpHandler({
      storage, boundDocs: new Map(),
      flushRoom: async () => {}, maxDocBytes: 8 * 1024 * 1024,
      migrationCoordinator: fakeCoordinator,
    });
    server = http.createServer(handler);
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });
  after(async () => {
    await new Promise(r => server.close(r));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('DELETE /rooms/:id forwards forget(roomId) to the migration coordinator', async () => {
    const resp = await httpDelete(`${baseUrl}/rooms/to-delete`);
    assert.strictEqual(resp.status, 200);
    // Handler passes composite docName (_public/<roomId>) to the coordinator.
    assert.deepStrictEqual(coordCalls, [['forget', '_public/to-delete']]);
  });

  it('omitted migrationCoordinator does not crash the DELETE path', async () => {
    // Fresh handler without the coordinator dep — the guard in the handler
    // (`typeof forget === 'function'`) must keep it from throwing.
    await storage.writeRoom('_public', 'to-delete-2', {
      ydocBytes: Buffer.from([7, 8]), secBytes: null, commentsJson: null,
    });
    const { createHttpHandler } = require('../http-handler.cjs');
    const handler2 = createHttpHandler({
      storage, boundDocs: new Map(),
      flushRoom: async () => {}, maxDocBytes: 8 * 1024 * 1024,
      // migrationCoordinator omitted on purpose
    });
    const srv2 = http.createServer(handler2);
    await new Promise(r => srv2.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${srv2.address().port}`;
    try {
      const resp = await httpDelete(`${url}/rooms/to-delete-2`);
      assert.strictEqual(resp.status, 200);
    } finally {
      await new Promise(r => srv2.close(r));
    }
  });
});
