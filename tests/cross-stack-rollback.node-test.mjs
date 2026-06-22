/**
 * Cross-stack rollback byte-compare GATE — Phase 9 (#128).
 *
 * Proves that a .ydoc carrying the v2 Y.XmlFragment substrate (what
 * production holds after migration) round-trips through a bare
 * Y.applyUpdate into a fresh gc doc and yields byte-identical .SEC.
 *
 * The real rollback risk: a reverted server (y-websocket path) reading
 * post-migration v2 bytes. This test never boots a relay — it exercises
 * the shared, stack-agnostic room-serializer.serializeRoom that both the
 * old and new servers call.
 *
 * Run: node --test tests/cross-stack-rollback.node-test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert';
import '../server/dom-polyfill.cjs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Y = require('yjs'); // SAME copy the CJS serializer uses
const { serializeRoom, seedRoomFromBlocks } = require('../server/room-serializer.cjs');
const { createMigrationCoordinator, migrateRoom } = require('../server/migrate-pm-substrate.cjs');

test('cross-stack rollback: v2 Y.XmlFragment .ydoc -> bare applyUpdate -> identical .SEC', async () => {
  // 1. Realistic room; DRIVE THE BROKER so html slots are real Y.XmlFragment (v2),
  //    with a TC mark + a note block.
  const hpDoc = new Y.Doc({ gc: true });
  seedRoomFromBlocks(hpDoc, [
    { id: 'a', type: 'txt', part: 1, depth: 0, html: '<ins class="mark-add" data-author-id="u1">added</ins> text' },
    { id: 'b', type: 'note', part: 1, depth: 0, html: 'A note' },
  ]);
  const coord = createMigrationCoordinator({
    storage: { backupRoom: async () => {} },
    log: { info() {}, warn() {}, error() {} },
    migrateImpl: migrateRoom,
  });
  await coord.ensureMigrated('tenantA/rollback', hpDoc);
  const slot = hpDoc.getMap('store').get('a').get('html');
  assert.ok(slot instanceof Y.XmlFragment, 'precondition: broker must yield Y.XmlFragment, not Y.Text');
  const { secBytes: hpSec } = await serializeRoom(hpDoc);
  const ydocBytes = Y.encodeStateAsUpdate(hpDoc);

  // 2. Reverted server: decode the SAME bytes into a fresh gc doc (bare applyUpdate).
  const wsDoc = new Y.Doc({ gc: true });
  Y.applyUpdate(wsDoc, new Uint8Array(ydocBytes));
  const reSlot = wsDoc.getMap('store').get('a').get('html');
  assert.ok(reSlot instanceof Y.XmlFragment, 'reloaded slot must remain Y.XmlFragment after applyUpdate under gc');
  const { secBytes: wsSec } = await serializeRoom(wsDoc);

  // 3. Byte-compare .SEC — gc-driven structural diffs in the XmlFragment must NOT change .SEC.
  assert.deepEqual([...wsSec], [...hpSec], 'rollback .SEC must be byte-identical');
});
