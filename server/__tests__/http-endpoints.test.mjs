/**
 * HTTP endpoint tests for collab-server download/upload routes.
 *
 * Spins up a minimal HTTP server using the same routing logic as the real
 * collab-server, backed by a real LocalStorageBackend in a temp directory.
 * Tests cover GET /rooms/:roomId/sec, GET /rooms/:roomId/comments,
 * GET /rooms (list), and 404 for unknown rooms.
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

describe('HTTP endpoints', () => {
  let tmpDir, server, baseUrl;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sim-http-'));
    const { LocalStorageBackend } = require('../storage-local.cjs');
    const storage = new LocalStorageBackend(tmpDir);

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

    // Create a minimal HTTP handler using the same logic as collab-server
    const MAX_DOC_BYTES = 8 * 1024 * 1024;
    server = http.createServer(async (req, res) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

      const url = new URL(req.url, `http://${req.headers.host}`);

      // POST /rooms/:roomId/upload — size-limited echo for test purposes
      const uploadMatch = url.pathname.match(/^\/rooms\/([^/]+)\/upload$/);
      if (uploadMatch && req.method === 'POST') {
        const roomId = uploadMatch[1];
        const chunks = [];
        let totalSize = 0;
        let aborted = false;
        req.on('data', (chunk) => {
          totalSize += chunk.length;
          if (totalSize > MAX_DOC_BYTES) {
            aborted = true;
            res.writeHead(413, { 'Content-Type': 'text/plain' });
            res.end(`File exceeds ${MAX_DOC_BYTES} byte limit`);
            req.destroy();
            return;
          }
          chunks.push(chunk);
        });
        req.on('end', () => {
          if (aborted) return;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, roomId, size: totalSize }));
        });
        return;
      }

      // GET /rooms/:roomId/sec  or  GET /rooms/:roomId/comments
      const dlMatch = url.pathname.match(/^\/rooms\/([^/]+)\/(sec|comments)$/);
      if (dlMatch && req.method === 'GET') {
        const [, roomId, artifact] = dlMatch;
        try {
          const data = await storage.readRoom(roomId);
          if (!data) {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end(`Room "${roomId}" not found`);
            return;
          }
          if (artifact === 'sec') {
            if (!data.secBytes) {
              res.writeHead(404, { 'Content-Type': 'text/plain' });
              res.end('SEC file not yet generated for this room');
              return;
            }
            res.writeHead(200, {
              'Content-Type': 'application/xml; charset=windows-1252',
              'Content-Disposition': `attachment; filename="${roomId}.SEC"`,
            });
            res.end(Buffer.from(data.secBytes));
          } else {
            // comments
            if (!data.commentsJson) {
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ version: 1, comments: [] }));
              return;
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(data.commentsJson);
          }
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end(`Download failed: ${err.message}`);
        }
        return;
      }

      // GET /rooms — list all rooms
      if (url.pathname === '/rooms' && req.method === 'GET') {
        try {
          const rooms = await storage.listRooms();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ rooms }));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end(`List rooms failed: ${err.message}`);
        }
        return;
      }

      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
    });

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
});
