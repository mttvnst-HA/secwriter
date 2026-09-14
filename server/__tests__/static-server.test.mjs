// Static SPA server (root server.js, `npm start`). Spawned as a child process
// against a fixture DIST so the test never depends on a Vite build.
import { describe, it, before, after } from 'node:test';
import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const SERVER_JS = fileURLToPath(new URL('../../server.js', import.meta.url));

let child, base, dist;

// Plain node:http (not fetch): undici's keep-alive pool leaves a handle
// closing at --test-force-exit, which trips a libuv assertion on Windows.
function get(url) {
  return new Promise((resolve, reject) => {
    http.get(url, { agent: false }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: { get: (k) => res.headers[k.toLowerCase()] ?? null },
        text: async () => body,
      }));
    }).on('error', reject);
  });
}

before(async () => {
  dist = fs.mkdtempSync(path.join(os.tmpdir(), 'secwriter-static-'));
  fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><title>SPA</title>');
  fs.mkdirSync(path.join(dist, 'assets'));
  fs.writeFileSync(path.join(dist, 'assets', 'app-abc123.js'), 'console.log(1)');
  // A sibling file OUTSIDE dist that a traversal attempt would target.
  fs.writeFileSync(path.join(dist, '..', 'secwriter-static-secret.txt'), 'SECRET');

  child = spawn(process.execPath, [SERVER_JS], {
    env: { ...process.env, PORT: '0', SIM_STATIC_DIR: dist },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  base = await new Promise((resolve, reject) => {
    let buf = '';
    child.stdout.on('data', (d) => {
      buf += d;
      const m = buf.match(/listening on port ([0-9]+)/);
      if (m) resolve(`http://127.0.0.1:${m[1]}`);
    });
    child.on('exit', (code) => reject(new Error(`server exited early (${code})`)));
    setTimeout(() => reject(new Error('server did not start')), 10000).unref();
  });
});

after(async () => {
  // Await the child's exit before returning: under --test-force-exit on
  // Windows, exiting while the killed child's handle is still closing trips
  // a libuv assertion (src\win\async.c) and fails the file with exit 127.
  if (child && child.exitCode === null) {
    const exited = new Promise((r) => child.once('close', r));
    child.kill();
    await exited;
  }
  try { fs.rmSync(path.join(dist, '..', 'secwriter-static-secret.txt')); } catch {}
  try { fs.rmSync(dist, { recursive: true, force: true }); } catch {}
});

describe('static SPA server', () => {
  it('serves an existing asset with the immutable cache header', async () => {
    const r = await get(`${base}/assets/app-abc123.js`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'application/javascript; charset=utf-8');
    assert.equal(r.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    assert.equal(await r.text(), 'console.log(1)');
  });

  it('falls back to index.html for / and unknown routes (SPA routing)', async () => {
    for (const p of ['/', '/rooms/abc', '/deep/route/']) {
      const r = await get(`${base}${p}`);
      assert.equal(r.status, 200, p);
      assert.equal(r.headers.get('content-type'), 'text/html; charset=utf-8', p);
      assert.equal(r.headers.get('cache-control'), 'no-cache', p);
      assert.ok((await r.text()).includes('<title>SPA</title>'), p);
    }
  });

  it('a directory path falls back to index.html instead of 404', async () => {
    const r = await get(`${base}/assets`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'text/html; charset=utf-8');
  });

  it('a MISSING /assets/* URL serves index.html WITHOUT the immutable cache header', async () => {
    const r = await get(`${base}/assets/gone-999.js`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.equal(r.headers.get('cache-control'), 'no-cache', 'index.html must never be cached as an immutable asset');
  });

  it('path traversal cannot escape DIST', async () => {
    for (const p of ['/../secwriter-static-secret.txt', '/%2e%2e/secwriter-static-secret.txt', '/assets/../../secwriter-static-secret.txt']) {
      const r = await get(`${base}${p}`);
      const body = await r.text();
      assert.notEqual(body, 'SECRET', p);
    }
  });
});
