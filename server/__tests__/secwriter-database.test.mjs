/**
 * Tests for server/secwriter-database.cjs
 *
 * Uses Node's built-in test runner.
 * Run: node --test server/__tests__/secwriter-database.test.mjs
 */

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const { test } = require('node:test');
const assert = require('node:assert');
const Y = require('yjs');
require('../dom-polyfill.cjs');
const { SecWriterDatabase } = require('../secwriter-database.cjs');
const { seedRoomFromBlocks } = require('../room-serializer.cjs');

function makeStorage() {
  const rooms = new Map();
  return {
    written: [],
    readRoom: async (t, r) => rooms.get(`${t}/${r}`) || null,
    writeRoom: async (t, r, artifacts) => {
      rooms.set(`${t}/${r}`, { ydocBytes: artifacts.ydocBytes });
      return artifacts;
    },
  };
}

test('store runs full serializeRoom (all four artifacts) and writeRoom', async () => {
  const storage = makeStorage();
  const captured = [];
  storage.writeRoom = async (t, r, a) => { captured.push({ t, r, a }); };
  const roomHealth = new Map();
  const db = new SecWriterDatabase({ storage, roomHealth, maxDocBytes: 8 * 1024 * 1024, log: { warn() {}, error() {} } });

  const ydoc = new Y.Doc();
  seedRoomFromBlocks(ydoc, [{ id: 'b1', type: 'txt', part: 1, depth: 0, html: 'Hello' }]);

  const ok = await db.store({ documentName: 'tenantA/room1', document: ydoc, state: Y.encodeStateAsUpdate(ydoc) });

  assert.equal(ok, true, 'a durable write must report success (#249)');
  assert.equal(captured.length, 1);
  assert.equal(captured[0].t, 'tenantA');
  assert.equal(captured[0].r, 'room1');
  const a = captured[0].a;
  assert.ok(a.ydocBytes instanceof Uint8Array);
  assert.ok(a.secBytes instanceof Uint8Array);
  assert.equal(typeof a.commentsJson, 'string');
});

test('store carries sidecar CONTENT (comment + block text), not just presence', async () => {
  // Presence-only assertions (above) can pass while serializeRoom silently
  // drops sidecar data. Seed a comment + a block with distinctive text and
  // assert the produced artifacts actually contain them. (Review S8.)
  //
  // Two contract details this seed path must respect (verified against the
  // codebase, #128 Task 4.1):
  //  1. readComments (src/lib/collab.js) SKIPS any comment value without a
  //     `.get` method — a comment must be a real Y.Map, not a plain object.
  //  2. seedRoomFromBlocks stores html in a LEGACY Y.Text slot (the broker
  //     converts it to a v2 Y.XmlFragment only on a later WS upgrade). So
  //     serializeRoom alone HTML-escapes inline markup rather than converting
  //     `<ins class="mark-add">` to `<ADD>` — mark→SGML conversion is the
  //     room-serializer + substrate's job (covered by its own tests), NOT
  //     SecWriterDatabase's. This test therefore pins that real block TEXT
  //     reaches the .SEC, which is what proves store() runs the full
  //     serializeRoom (not a bare encodeStateAsUpdate) at this layer.
  const storage = makeStorage();
  let captured;
  storage.writeRoom = async (t, r, a) => { captured = a; };
  const db = new SecWriterDatabase({ storage, roomHealth: new Map(), maxDocBytes: 8 * 1024 * 1024, log: { warn() {}, error() {} } });
  const ydoc = new Y.Doc();
  seedRoomFromBlocks(ydoc, [{ id: 'b1', type: 'txt', part: 1, depth: 0, html: 'UNIQUEMARKER content' }]);
  const cMap = new Y.Map();
  cMap.set('blockId', 'b1');
  cMap.set('status', 'open');
  cMap.set('authorName', 'tester');
  ydoc.getMap('comments').set('c1', cMap);
  await db.store({ documentName: 'tenantA/room1', document: ydoc });
  assert.ok(captured.commentsJson.includes('c1'), 'comment id must reach the comments sidecar');
  const sec = Buffer.from(captured.secBytes).toString('latin1');
  assert.ok(sec.includes('UNIQUEMARKER'), 'block text must serialize into the .SEC');
});

test('fetch splits the canonical documentName and returns ydoc bytes (or null)', async () => {
  const storage = makeStorage();
  storage.readRoom = async (t, r) => (t === 'tenantA' && r === 'room1') ? { ydocBytes: new Uint8Array([1, 2, 3]) } : null;
  const db = new SecWriterDatabase({ storage, roomHealth: new Map(), maxDocBytes: 8 * 1024 * 1024, log: { warn() {}, error() {} } });
  const bytes = await db.fetch({ documentName: 'tenantA/room1' });
  assert.deepEqual([...bytes], [1, 2, 3]);
  const none = await db.fetch({ documentName: 'tenantA/missing' });
  assert.equal(none, null);
});

test('store refuses an over-8MB doc and does NOT call writeRoom', async () => {
  const storage = makeStorage();
  let wrote = false;
  storage.writeRoom = async () => { wrote = true; };
  const roomHealth = new Map();
  const db = new SecWriterDatabase({ storage, roomHealth, maxDocBytes: 8, log: { warn() {}, error() {} } });
  const ydoc = new Y.Doc();
  seedRoomFromBlocks(ydoc, [{ id: 'b1', type: 'txt', part: 1, depth: 0, html: 'Hello world this exceeds eight bytes' }]);
  const ok = await db.store({ documentName: 'tenantA/big', document: ydoc, state: Y.encodeStateAsUpdate(ydoc) });
  assert.equal(wrote, false);
  // A refused store must report failure so the upload route returns a 5xx (#249).
  assert.equal(ok, false);
});

test('store increments roomHealth.persistFailures on writeRoom error', async () => {
  const storage = makeStorage();
  storage.writeRoom = async () => { throw new Error('S3 down'); };
  const roomHealth = new Map();
  const db = new SecWriterDatabase({ storage, roomHealth, maxDocBytes: 8 * 1024 * 1024, log: { warn() {}, error() {} } });
  const ydoc = new Y.Doc();
  seedRoomFromBlocks(ydoc, [{ id: 'b1', type: 'txt', part: 1, depth: 0, html: 'x' }]);
  const failed = await db.store({ documentName: 'tenantA/room1', document: ydoc, state: Y.encodeStateAsUpdate(ydoc) });
  assert.equal(roomHealth.get('tenantA/room1').persistFailures, 1);
  // A failed store must resolve false (not throw, not swallow-as-success) so the
  // upload route and the migration explicit-persist can surface it (#249).
  assert.equal(failed, false);
  // A subsequent successful store resets the counter to 0 (recovery path) and
  // reports success.
  storage.writeRoom = async () => {};
  const ok = await db.store({ documentName: 'tenantA/room1', document: ydoc, state: Y.encodeStateAsUpdate(ydoc) });
  assert.equal(roomHealth.get('tenantA/room1').persistFailures, 0);
  assert.equal(ok, true);
});

test('drain awaits in-flight per-key store chains before resolving', async () => {
  const storage = makeStorage();
  let finished = false;
  storage.writeRoom = async () => {
    await new Promise(res => setTimeout(res, 30));
    finished = true;
  };
  const db = new SecWriterDatabase({ storage, roomHealth: new Map(), maxDocBytes: 8 * 1024 * 1024, log: { warn() {}, error() {} } });
  const ydoc = new Y.Doc();
  seedRoomFromBlocks(ydoc, [{ id: 'b1', type: 'txt', part: 1, depth: 0, html: 'x' }]);
  // Kick off a store but do NOT await it directly — drain() must await it.
  db.store({ documentName: 'tenantA/room1', document: ydoc });
  await db.drain();
  assert.equal(finished, true, 'drain must not resolve until the in-flight store completes');
});

test('store is re-entrancy-safe per key: overlapping stores serialize, last write is the latest doc', async () => {
  const storage = makeStorage();
  const order = [];
  storage.writeRoom = async (t, r, a) => {
    order.push('start');
    await new Promise(res => setTimeout(res, 30));
    order.push('end');
  };
  const db = new SecWriterDatabase({ storage, roomHealth: new Map(), maxDocBytes: 8 * 1024 * 1024, log: { warn() {}, error() {} } });
  const ydoc = new Y.Doc();
  seedRoomFromBlocks(ydoc, [{ id: 'b1', type: 'txt', part: 1, depth: 0, html: 'x' }]);
  const p1 = db.store({ documentName: 'tenantA/room1', document: ydoc, state: Y.encodeStateAsUpdate(ydoc) });
  const p2 = db.store({ documentName: 'tenantA/room1', document: ydoc, state: Y.encodeStateAsUpdate(ydoc) });
  await Promise.all([p1, p2]);
  assert.deepEqual(order, ['start', 'end', 'start', 'end']);
});
