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

function httpPost(url, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request({
      hostname: u.hostname,
      port: u.port,
      path: u.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

function httpJson(url, method, jsonBody) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const payload = jsonBody != null ? JSON.stringify(jsonBody) : '';
    const req = http.request({
      hostname: u.hostname,
      port: u.port,
      path: u.pathname,
      method,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

function httpDelete(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request({
      hostname: u.hostname,
      port: u.port,
      path: u.pathname,
      method: 'DELETE',
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

    // Seed test data
    await storage.writeRoom('test-room', {
      ydocBytes: Buffer.from([1, 2, 3]),
      secBytes: Buffer.from('<?xml version="1.0"?><SEC><TXT>Hello</TXT></SEC>'),
      commentsJson: JSON.stringify({ version: 1, comments: [{ id: 'c1', status: 'open' }] }),
    });

    // Seed a room with .ydoc only (no SEC, no comments) — legacy room
    await storage.writeRoom('legacy-room', {
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
    await storage.writeRoom('test-meta', { ydocBytes, secBytes: null, commentsJson: null });
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
    const stored = await storage.readRoom('new-room');
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
    await storage.writeRoom('del-room', {
      ydocBytes: Buffer.from([10, 11, 12]),
      secBytes: null,
      commentsJson: null,
    });
    const resp = await httpDelete(`${baseUrl}/rooms/del-room`);
    assert.strictEqual(resp.status, 200);
    const data = JSON.parse(resp.body.toString());
    assert.strictEqual(data.ok, true);
    // Verify room is gone
    const stored = await storage.readRoom('del-room');
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
    await storage.writeRoom('patch-room', { ydocBytes, secBytes: null, commentsJson: null });

    const resp = await httpJson(`${baseUrl}/rooms/patch-room`, 'PATCH', { locked: true });
    assert.strictEqual(resp.status, 200);
    const data = JSON.parse(resp.body.toString());
    assert.strictEqual(data.ok, true);

    // Verify locked was persisted in yMeta
    const stored = await storage.readRoom('patch-room');
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
    boundDocs.set('upload-room', ydoc);

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
      boundDocs.delete('upload-room');
    }
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
    await storage.writeRoom('to-delete', {
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
    assert.deepStrictEqual(coordCalls, [['forget', 'to-delete']]);
  });

  it('omitted migrationCoordinator does not crash the DELETE path', async () => {
    // Fresh handler without the coordinator dep — the guard in the handler
    // (`typeof forget === 'function'`) must keep it from throwing.
    await storage.writeRoom('to-delete-2', {
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
