/**
 * Integration tests for the collab-server factory:
 *   - extractDocName: strips the `/ws/` prefix that VITE_COLLAB_WS_URL
 *     adds in production deploys, so the docName matches what the HTTP API
 *     uses for the same room.
 *   - Race fix (issue #17): the WS connection handler awaits the
 *     persistence load before sync starts, so a fresh client never
 *     observes an empty doc that's actually mid-load. Without the fix, the
 *     client's `seedYBlocks` on sync would CRDT-union with the persisted
 *     state and grow `yOrder` by ~N entries every reload.
 *
 * Run: node --test server/__tests__/collab-server.test.mjs
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const require = createRequire(import.meta.url);
require('../dom-polyfill.cjs');

const Y = require('yjs');
const { WebSocket: NodeWebSocket } = require('ws');
const { WebsocketProvider } = require('y-websocket');
const { docs: ywsDocs } = require('y-websocket/bin/utils');

const { createCollabServer, extractDocName } = require('../collab-server.cjs');
const { LocalStorageBackend } = require('../storage-local.cjs');

// ──────────────────────────────────────────────────────────────────────────
// Pure unit: extractDocName
// ──────────────────────────────────────────────────────────────────────────
describe('extractDocName', () => {
  it('returns the path tail with the leading slash stripped', () => {
    assert.strictEqual(extractDocName('/myroom'), 'myroom');
  });
  it('drops the query string', () => {
    assert.strictEqual(extractDocName('/myroom?token=abc'), 'myroom');
  });
  it('strips a leading /ws/ prefix (VITE_COLLAB_WS_URL=wss://host/ws case)', () => {
    assert.strictEqual(extractDocName('/ws/myroom'), 'myroom');
  });
  it('strips /ws/ even when a token query is present', () => {
    assert.strictEqual(
      extractDocName('/ws/myroom?token=secret'),
      'myroom'
    );
  });
  it('handles room names containing hyphens, underscores, digits', () => {
    assert.strictEqual(extractDocName('/ws/a-room_42'), 'a-room_42');
  });
  it('does not strip an interior /ws/ — only a leading one', () => {
    // A room literally named "wsfoo" must not be confused with the prefix.
    assert.strictEqual(extractDocName('/wsfoo'), 'wsfoo');
  });
  it('returns empty for non-string input', () => {
    assert.strictEqual(extractDocName(null), '');
    assert.strictEqual(extractDocName(undefined), '');
  });
  it('returns empty for the bare root', () => {
    assert.strictEqual(extractDocName('/'), '');
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Integration: bindState race avoidance
// ──────────────────────────────────────────────────────────────────────────
//
// The test simulates a slow storage backend (200 ms readRoom) and connects
// a client that performs the same "seed if empty" gesture App.jsx uses on
// first sync. With the race, the client would see empty → seed → CRDT
// union → 2× yOrder. With the fix, the WS handler awaits the load before
// sync, so the client sees the persisted doc and skips its seed.
//
// We assert two things: (a) yOrder.length stays at N (the persisted size)
// after the round-trip, (b) extractDocName means a `/ws/<room>` URL
// resolves to the same storage key as direct API access.
// ──────────────────────────────────────────────────────────────────────────

class SlowLocalStorageBackend {
  constructor(dir, readDelayMs = 200) {
    this.inner = new LocalStorageBackend(dir);
    this.readDelayMs = readDelayMs;
  }
  async readRoom(name) {
    await new Promise(resolve => setTimeout(resolve, this.readDelayMs));
    return this.inner.readRoom(name);
  }
  // Pass-throughs
  writeRoom(...a) { return this.inner.writeRoom(...a); }
  deleteRoom(...a) { return this.inner.deleteRoom(...a); }
  listRooms(...a) { return this.inner.listRooms(...a); }
  statRoom(...a) { return this.inner.statRoom(...a); }
  quarantineRoom(...a) { return this.inner.quarantineRoom(...a); }
  archiveRoom(...a) { return this.inner.archiveRoom(...a); }
  listArchivedRooms(...a) { return this.inner.listArchivedRooms?.(...a); }
  deleteArchivedRoom(...a) { return this.inner.deleteArchivedRoom?.(...a); }
}

/** Build a Y.Doc with N seeded blocks and serialize to bytes. */
function buildSeededDoc(blockCount) {
  const ydoc = new Y.Doc();
  const yOrder = ydoc.getArray('order');
  const yStore = ydoc.getMap('store');
  ydoc.transact(() => {
    for (let i = 1; i <= blockCount; i++) {
      const id = `n${i}`;
      const ymap = new Y.Map();
      ymap.set('id', id);
      ymap.set('type', 'txt');
      ymap.set('part', 1);
      ymap.set('depth', 0);
      const yText = new Y.Text();
      yText.insert(0, `Block ${i} body text`);
      ymap.set('html', yText);
      yStore.set(id, ymap);
      yOrder.push([id]);
    }
  }, 'seed');
  const bytes = Buffer.from(Y.encodeStateAsUpdate(ydoc));
  ydoc.destroy();
  return bytes;
}

describe('collab-server: bindState race (issue #17)', () => {
  let tmpDir;
  let server;
  let baseUrl;
  const ROOM_NAME = 'race-test-room';
  const BLOCK_COUNT = 50;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sim-collab-race-'));
    const storage = new SlowLocalStorageBackend(tmpDir, 200);

    // Pre-seed the persisted room. extractDocName('/ws/race-test-room')
    // returns 'race-test-room', so we persist under that key.
    const ydocBytes = buildSeededDoc(BLOCK_COUNT);
    await storage.writeRoom(ROOM_NAME, { ydocBytes, secBytes: null, commentsJson: null });

    server = createCollabServer({ storage });
    await new Promise(resolve => server.httpServer.listen(0, '127.0.0.1', resolve));
    const addr = server.httpServer.address();
    baseUrl = `ws://127.0.0.1:${addr.port}`;
  });

  after(async () => {
    // Force-close all WS connections so httpServer.close() can resolve.
    server.cleanup();
    ywsDocs.clear();
    try { server.wss.close(); } catch { /* ignore */ }
    await new Promise(resolve => {
      // Safety timeout: never hang the suite if a connection won't close.
      const t = setTimeout(resolve, 1000);
      server.httpServer.close(() => { clearTimeout(t); resolve(); });
    });
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    // Fresh y-websocket internal state per test so doc caching from a
    // previous test can't mask a regression in the race fix.
    ywsDocs.clear();
  });

  it('client connecting to /ws/<room> sees persisted state, not an empty doc', async () => {
    const ydoc = new Y.Doc();
    const yOrder = ydoc.getArray('order');
    const yStore = ydoc.getMap('store');

    // Connect with the `/ws` path prefix that production frontends use.
    // y-websocket appends `/${room}`, so the request URL is `/ws/<room>` —
    // exactly the case our extractDocName helper exists to handle.
    const provider = new WebsocketProvider(`${baseUrl}/ws`, ROOM_NAME, ydoc, {
      WebSocketPolyfill: NodeWebSocket,
      connect: true,
    });

    // Wait for sync to complete.
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('sync timeout')), 5000);
      provider.once('sync', () => { clearTimeout(timer); resolve(); });
    });

    // Assertion 1: when 'sync' fires, the doc reflects the persisted state.
    // Without the race fix, sync would fire while the storage read is still
    // in flight and yOrder would be empty.
    assert.strictEqual(
      yOrder.length, BLOCK_COUNT,
      `Expected ${BLOCK_COUNT} blocks from persisted state, got ${yOrder.length}. ` +
      `If 0, the connection handler did not await bindState. If >${BLOCK_COUNT}, ` +
      `the client's seed CRDT-merged with persisted state.`,
    );
    assert.strictEqual(yStore.size, BLOCK_COUNT);

    // Cleanup
    provider.disconnect();
    provider.destroy();
    ydoc.destroy();
  });

  it('reload-style reconnect does not grow yOrder (would have been +N per reload)', async () => {
    // Simulate App.jsx's lifecycle: connect, on sync seed-if-empty, then
    // disconnect and reconnect. With the bug, yOrder grows by BLOCK_COUNT
    // on each reconnect; with the fix it stays at BLOCK_COUNT.
    const reloadCount = 3;
    for (let r = 0; r < reloadCount; r++) {
      // Important: clear y-websocket's module state between reloads to
      // simulate a server cold start (which is what triggers the race in
      // production — the doc isn't cached in memory).
      ywsDocs.clear();

      const ydoc = new Y.Doc();
      const yOrder = ydoc.getArray('order');
      const yStore = ydoc.getMap('store');

      const provider = new WebsocketProvider(`${baseUrl}/ws`, ROOM_NAME, ydoc, {
        WebSocketPolyfill: NodeWebSocket,
        connect: true,
      });

      // Wait for sync.
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`reload ${r}: sync timeout`)), 5000);
        provider.once('sync', () => { clearTimeout(timer); resolve(); });
      });

      // App.jsx behavior: on first sync, seed only if empty.
      const empty = yOrder.length === 0 && yStore.size === 0;
      if (empty) {
        ydoc.transact(() => {
          for (let i = 1; i <= BLOCK_COUNT; i++) {
            const id = `n${i}`;
            const ymap = new Y.Map();
            ymap.set('id', id);
            ymap.set('type', 'txt');
            const yText = new Y.Text();
            yText.insert(0, `Block ${i} body text`);
            ymap.set('html', yText);
            yStore.set(id, ymap);
            yOrder.push([id]);
          }
        }, 'seed');
      }

      // Give the seed a moment to flush over the WS so the server's doc
      // sees any extra inserts the client emitted.
      await new Promise(resolve => setTimeout(resolve, 100));

      // After the round-trip, the client's view must show exactly
      // BLOCK_COUNT entries — never 2× or 3×.
      assert.strictEqual(
        yOrder.length, BLOCK_COUNT,
        `Reload ${r}: yOrder grew to ${yOrder.length}; expected ${BLOCK_COUNT}.`,
      );

      provider.disconnect();
      provider.destroy();
      ydoc.destroy();

      // Wait for the server to debounce-flush so the next reload reads the
      // current (not stale) state from storage.
      await server.flushAllRooms();
    }
  });

  it('survives a stale closeConn evicting our doc mid-preload (deterministic race)', async () => {
    // Reproduces the CI-only flake from issue #17 redux. y-websocket's
    // closeConn (utils.js:208) does `docs.delete(doc.name)` keyed by name
    // when a connection's last conn drops. If a previous WS connection's
    // close fires while a new connection is still in its preload await,
    // that delete evicts the new doc from the global map. Without the
    // re-install guard in the upgrade handler, setupWSConnection then
    // creates a fresh empty doc that bypasses preload — sync fires with
    // empty state, client seeds, persisted state CRDT-unions on top, yOrder
    // doubles.
    //
    // We force the race deterministically by deleting the docs entry while
    // the slow-storage read is still in flight, then asserting yOrder is
    // exactly BLOCK_COUNT after sync.
    ywsDocs.clear();

    const ydoc = new Y.Doc();
    const yOrder = ydoc.getArray('order');
    const yStore = ydoc.getMap('store');

    const provider = new WebsocketProvider(`${baseUrl}/ws`, ROOM_NAME, ydoc, {
      WebSocketPolyfill: NodeWebSocket,
      connect: true,
    });

    // Storage delay is 200 ms; eviction at 50 ms lands inside the preload
    // await window. After this, ywsDocs has no entry for the room — exactly
    // the state a stale closeConn would leave behind.
    setTimeout(() => { ywsDocs.delete(ROOM_NAME); }, 50);

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('sync timeout')), 5000);
      provider.once('sync', () => { clearTimeout(timer); resolve(); });
    });

    // App.jsx behavior: seed-if-empty on first sync.
    const empty = yOrder.length === 0 && yStore.size === 0;
    if (empty) {
      ydoc.transact(() => {
        for (let i = 1; i <= BLOCK_COUNT; i++) {
          const id = `n${i}`;
          const ymap = new Y.Map();
          ymap.set('id', id);
          ymap.set('type', 'txt');
          const yText = new Y.Text();
          yText.insert(0, `Block ${i} body text`);
          ymap.set('html', yText);
          yStore.set(id, ymap);
          yOrder.push([id]);
        }
      }, 'seed');
    }

    // Wait long enough that any second bindState the eviction triggered
    // would have completed its 200 ms slow-storage read AND propagated the
    // CRDT-merged state back to the client. 500 ms covers the worst case
    // (200 ms second-load + propagation buffer).
    await new Promise(resolve => setTimeout(resolve, 500));

    assert.strictEqual(
      yOrder.length, BLOCK_COUNT,
      `Stale-close race: yOrder grew to ${yOrder.length}; expected ${BLOCK_COUNT}. ` +
      `Re-install guard in upgrade handler is missing or ineffective.`,
    );

    provider.disconnect();
    provider.destroy();
    ydoc.destroy();
    await server.flushAllRooms();
  });

  // Sub-PR 1d (#47, ADR-0006): the migration broker introduces a SECOND
  // await between accepting the upgrade and setupWSConnection (preload +
  // migration). The eviction guard must hold across both awaits — without
  // the post-migration re-install, a stale closeConn evicting our doc
  // during the migration window would let setupWSConnection create a
  // fresh empty doc that bypasses both preload AND migration.
  //
  // We force the race by deleting the docs entry mid-migration. The
  // assertion is the same as the preload-window test: yOrder stays at
  // BLOCK_COUNT.
  it('eviction-guard holds across the broker-await window (1d regression)', async () => {
    ywsDocs.clear();

    const ydoc = new Y.Doc();
    const yOrder = ydoc.getArray('order');
    const yStore = ydoc.getMap('store');

    const provider = new WebsocketProvider(`${baseUrl}/ws`, ROOM_NAME, ydoc, {
      WebSocketPolyfill: NodeWebSocket,
      connect: true,
    });

    // The persisted state is v1 (Y.Text slots from the test fixture). The
    // server-side broker will run on this connect; the migration await is
    // a fresh window for stale-close eviction. Schedule the eviction at
    // 250 ms — well past the 200 ms preload await but still inside the
    // migration window.
    setTimeout(() => { ywsDocs.delete(ROOM_NAME); }, 250);

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('sync timeout')), 5000);
      provider.once('sync', () => { clearTimeout(timer); resolve(); });
    });

    const empty = yOrder.length === 0 && yStore.size === 0;
    if (empty) {
      ydoc.transact(() => {
        for (let i = 1; i <= BLOCK_COUNT; i++) {
          const id = `n${i}`;
          const ymap = new Y.Map();
          ymap.set('id', id);
          ymap.set('type', 'txt');
          const yText = new Y.Text();
          yText.insert(0, `Block ${i} body text`);
          ymap.set('html', yText);
          yStore.set(id, ymap);
          yOrder.push([id]);
        }
      }, 'seed');
    }

    await new Promise(resolve => setTimeout(resolve, 500));

    assert.strictEqual(
      yOrder.length, BLOCK_COUNT,
      `Broker-window eviction race: yOrder grew to ${yOrder.length}; expected ${BLOCK_COUNT}. ` +
      `Post-migration re-install of ywsDocs[ROOM_NAME] is missing or ineffective.`,
    );

    provider.disconnect();
    provider.destroy();
    ydoc.destroy();
    await server.flushAllRooms();
  });
});
