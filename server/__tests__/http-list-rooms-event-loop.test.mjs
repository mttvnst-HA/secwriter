/**
 * Regression test for issue #100: GET /rooms must yield to the event loop
 * between iterations so a backlog of persisted rooms cannot starve other
 * handlers.
 *
 * The bug: http-handler.cjs's GET /rooms loop ran `Y.applyUpdate(tempDoc,
 * bytes)` (synchronous, CPU-bound) for each persisted room with no explicit
 * yield. The surrounding storage awaits resolved from OS file cache without
 * releasing the loop, so listing N rooms froze the loop for N * decode_ms.
 *
 * The fix: `await new Promise(resolve => setImmediate(resolve))` every
 * iteration.
 *
 * The test: pre-seed N rooms with non-trivial Y.Doc state, install a 25ms
 * setInterval that records the max gap between fires, fire GET /rooms,
 * assert max gap stays under a budget.
 *
 * Run: node --test server/__tests__/http-list-rooms-event-loop.test.mjs
 */

import { describe, it, before, after } from 'node:test';
import { strict as assert } from 'node:assert';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require('../dom-polyfill.cjs');

const Y = require('yjs');
const { LocalStorageBackend } = require('../storage-local.cjs');
const { createHttpHandler } = require('../http-handler.cjs');
const { PUBLIC_TENANT } = require('../storage-shared.cjs');

function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
}

// Build a Y.Doc with ~N blocks worth of state so applyUpdate has real CPU work.
function makeRoomBytes(blockCount) {
  const ydoc = new Y.Doc();
  const yMeta = ydoc.getMap('meta');
  yMeta.set('sectionNumber', '31 00 00');
  yMeta.set('sectionTitle', 'EARTHWORK');
  const yOrder = ydoc.getArray('order');
  const yStore = ydoc.getMap('store');
  ydoc.transact(() => {
    for (let i = 0; i < blockCount; i++) {
      const id = `b${i}`;
      yOrder.push([id]);
      const m = new Y.Map();
      m.set('type', 'txt');
      m.set('part', 1);
      m.set('depth', 0);
      const xml = new Y.XmlFragment();
      m.set('html', xml);
      yStore.set(id, m);
      // Insert some text into the fragment so decode has work to do
      const para = new Y.XmlElement('paragraph');
      const text = new Y.XmlText();
      text.insert(0, `Block ${i} content with some realistic text to decode.`);
      para.insert(0, [text]);
      xml.insert(0, [para]);
    }
  });
  const bytes = Buffer.from(Y.encodeStateAsUpdate(ydoc));
  ydoc.destroy();
  return bytes;
}

describe('GET /rooms event-loop yield (issue #100)', () => {
  let tmpDir, server, baseUrl, storage, boundDocs;
  const ROOM_COUNT = 40;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sim-loopyield-'));
    storage = new LocalStorageBackend(tmpDir);
    boundDocs = new Map();

    // Seed enough persisted rooms to exercise the loop. Each room carries
    // ~30 blocks worth of CRDT state to make Y.applyUpdate non-trivial.
    // Seeded under _public — the no-auth handler resolves every request's
    // tenant to PUBLIC_TENANT, so this is the namespace GET /rooms lists.
    for (let i = 0; i < ROOM_COUNT; i++) {
      await storage.writeRoom(PUBLIC_TENANT, `room-${i.toString().padStart(3, '0')}`, {
        ydocBytes: makeRoomBytes(30),
        secBytes: null,
        commentsJson: null,
      });
    }

    const handler = createHttpHandler({
      storage,
      boundDocs,
      flushRoom: async () => {},
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

  it(`GET /rooms with ${ROOM_COUNT} persisted rooms does not block the event loop`, async () => {
    // Install a 25ms interval that records the max gap between fires.
    // Without the yield fix, the gap grows to the cumulative decode time
    // (hundreds of ms for ROOM_COUNT * decode_ms).
    const INTERVAL_MS = 25;
    const STARTUP_SKIP_MS = 50;  // ignore startup jitter
    const startedAt = Date.now();
    let lastFire = Date.now();
    let maxGap = 0;
    const ticker = setInterval(() => {
      const now = Date.now();
      if (now - startedAt < STARTUP_SKIP_MS) {
        lastFire = now;
        return;
      }
      const gap = now - lastFire - INTERVAL_MS;
      if (gap > maxGap) maxGap = gap;
      lastFire = now;
    }, INTERVAL_MS);

    try {
      const resp = await httpGet(`${baseUrl}/rooms`);
      assert.strictEqual(resp.status, 200);
      const data = JSON.parse(resp.body.toString());
      assert.strictEqual(data.rooms.length, ROOM_COUNT);
    } finally {
      clearInterval(ticker);
    }

    // Budget: any single block of the event loop must stay under 200ms.
    // Pre-fix observed up to 2761ms in the wild with 100 rooms; expected
    // post-fix is <50ms per iteration (one Y.applyUpdate worth).
    // 200ms is a generous CI-friendly ceiling that still detects regression.
    assert.ok(
      maxGap < 200,
      `event-loop max stall was ${maxGap}ms with ${ROOM_COUNT} rooms; expected < 200ms (regression of issue #100 fix)`,
    );
  });
});
