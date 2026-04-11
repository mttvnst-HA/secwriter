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

  it('GET /rooms lists all seeded rooms', async () => {
    const resp = await httpGet(`${baseUrl}/rooms`);
    assert.strictEqual(resp.status, 200);
    const data = JSON.parse(resp.body.toString());
    assert.ok(Array.isArray(data.rooms));
    assert.ok(data.rooms.includes('test-room'));
    assert.ok(data.rooms.includes('legacy-room'));
  });

  it('GET /unknown returns 404', async () => {
    const resp = await httpGet(`${baseUrl}/unknown`);
    assert.strictEqual(resp.status, 404);
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
    } finally {
      ydoc.destroy();
      boundDocs.delete('upload-room');
    }
  });
});
