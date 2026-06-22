/**
 * Server-level security tests for the Hocuspocus relay (#128, Task 3.3).
 *
 * Drives the onAuthenticate security properties (Task 3.2) through REAL
 * HocuspocusProvider connections over a loopback socket:
 *   1. cross-tenant + non-canonical names rejected before load (zero fetch)
 *   2. revocation parity — re-auth on every FRESH connect (per-connect only)
 *   3. readOnly write-frame-drop (#239-readiness lever)
 *
 * Uses Node's built-in test runner (NOT vitest).
 * Run: node --test server/__tests__/hocuspocus-server.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import { createRequire } from 'node:module';
import * as Y from 'yjs';
import { HocuspocusProvider } from '@hocuspocus/provider';
import WS from 'ws';

const require_ = createRequire(import.meta.url);
require_('../dom-polyfill.cjs'); // serializeRoom (Test 4 round-trip) needs the DOM polyfill
const { createCollabServer } = require_('../collab-server.cjs');

// ── Shared helpers ─────────────────────────────────────────────────────────

function waitFor(predicate, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error('waitFor timeout'));
      setTimeout(tick, 20);
    };
    tick();
  });
}

// Boot a createCollabServer instance on an ephemeral loopback port.
async function boot(config) {
  const srv = createCollabServer(config);
  await new Promise((r) => srv.httpServer.listen(0, '127.0.0.1', r));
  const url = `ws://127.0.0.1:${srv.httpServer.address().port}`;
  return { srv, url };
}

// ── Test 1 — cross-tenant + non-canonical rejection, ZERO fetch ─────────────

describe('Hocuspocus relay — WS-level security', () => {
  it('rejects cross-tenant + non-canonical names via provider name, before load (zero fetch)', async () => {
    let fetchCalls = 0;
    const storage = {
      readRoom: async () => { fetchCalls++; return null; },
      writeRoom: async () => {},
      readAcl: async () => ({ ownerId: 'sub-a', sharedWith: [] }),
    };
    const { srv, url } = await boot({
      storage, useHocuspocus: true,
      authProvider: { requiresAuth: true, validateToken: async (t) => t === 'tokA' ? { id: 'sub-a', tenant: 'tenantA' } : null },
    });
    for (const name of ['victimTenant/room', 'tenantA/room/1', 'tenantA/room.1', 'justaroom']) {
      const doc = new Y.Doc();
      let failed = false;
      const prov = new HocuspocusProvider({ url, name, document: doc, token: 'tokA', WebSocketPolyfill: WS, onAuthenticationFailed: () => { failed = true; } });
      await waitFor(() => failed, 4000).catch(() => {});
      assert.strictEqual(failed, true);
      prov.destroy(); doc.destroy();
    }
    // A rejected onAuthenticate must produce ZERO storage reads — proves the
    // load path is gated, not just the canonical parse.
    assert.strictEqual(fetchCalls, 0);
    srv.cleanup?.(); srv.httpServer.close();
  });

  // ── Test 2 — revocation parity: re-auth on every FRESH connect ────────────
  it('re-authenticates on every fresh connect — revoked owner rejected on reconnect', async () => {
    // Mutable ACL store so a mid-test mutation is visible to the NEXT connect.
    const aclMap = new Map();
    aclMap.set('tenantA/room1', { ownerId: 'sub-a', sharedWith: [] });
    const storage = {
      readRoom: async () => null,
      writeRoom: async () => {},
      readAcl: async (tenant, roomId) => aclMap.get(`${tenant}/${roomId}`) || null,
    };
    const { srv, url } = await boot({
      storage, useHocuspocus: true,
      authProvider: { requiresAuth: true, validateToken: async (t) => t === 'tokA' ? { id: 'sub-a', tenant: 'tenantA' } : null },
    });

    // (a) Authorized owner connects and reaches synced.
    const doc1 = new Y.Doc();
    const prov1 = new HocuspocusProvider({ url, name: 'tenantA/room1', document: doc1, token: 'tokA', WebSocketPolyfill: WS });
    await waitFor(() => prov1.synced, 4000);
    assert.strictEqual(prov1.synced, true);

    // (b) Revoke the owner — remove sub-a from the ACL.
    aclMap.set('tenantA/room1', { ownerId: 'someone-else', sharedWith: [] });

    // (c) A FRESH reconnect (brand-new provider) to the same name is REJECTED.
    const doc2 = new Y.Doc();
    let failed2 = false;
    const prov2 = new HocuspocusProvider({ url, name: 'tenantA/room1', document: doc2, token: 'tokA', WebSocketPolyfill: WS, onAuthenticationFailed: () => { failed2 = true; } });
    await waitFor(() => failed2, 4000).catch(() => {});
    assert.strictEqual(failed2, true);

    // NOTE: we deliberately do NOT assert that the still-open prov1 session is
    // severed. Hocuspocus has no periodic re-auth — an already-connected user
    // keeps editing until the socket drops. Revocation is per-connect ONLY;
    // this is the documented true strength of the relay model.

    prov1.destroy(); doc1.destroy();
    prov2.destroy(); doc2.destroy();
    srv.cleanup?.(); srv.httpServer.close();
  });
});

// ── Test 3 — readOnly write-frame-dropped (#239-readiness probe) ────────────

describe('Hocuspocus readOnly lever (#239-readiness)', () => {
  it('drops write frames from a readOnly connection — observer never sees the update', async () => {
    // This boots its OWN minimal standalone Hocuspocus to exercise the readOnly
    // lever in isolation. The production createCollabServer onAuthenticate never
    // sets readOnly (all #128 connections are read-write), so this is a probe of
    // the mechanism #239's viewer role will lean on, NOT a test of the builder.
    const { Hocuspocus } = require_('@hocuspocus/server');
    const hocuspocus = new Hocuspocus({
      name: 'ro-probe',
      quiet: true,
      // The hook RETURN value merges only into context, NOT connectionConfig.
      // To gate writes we MUST MUTATE the passed object.
      async onAuthenticate(data) { data.connectionConfig.readOnly = true; return {}; },
    });

    const httpServer = http.createServer();
    const hwss = new WS.WebSocketServer({ noServer: true });
    httpServer.on('upgrade', (req, socket, head) => {
      hwss.handleUpgrade(req, socket, head, (conn) => {
        const cc = hocuspocus.handleConnection(conn, req, {});
        conn.on('message', (data) => cc.handleMessage(new Uint8Array(Array.isArray(data) ? Buffer.concat(data) : data)));
        conn.on('close', (code, reason) => cc.handleClose({ code, reason: reason ? reason.toString() : '' }));
      });
    });
    await new Promise((r) => httpServer.listen(0, '127.0.0.1', r));
    const url = `ws://127.0.0.1:${httpServer.address().port}`;

    // No canonical gate on this standalone instance — any name works.
    const writerDoc = new Y.Doc();
    const observerDoc = new Y.Doc();
    const writer = new HocuspocusProvider({ url, name: '_public/ro', document: writerDoc, WebSocketPolyfill: WS });
    const observer = new HocuspocusProvider({ url, name: '_public/ro', document: observerDoc, WebSocketPolyfill: WS });
    await waitFor(() => writer.synced && observer.synced, 4000);

    // Writer mutates its local doc — the local apply is NOT blocked.
    writerDoc.transact(() => writerDoc.getArray('order').push(['x']), 'local-publish');

    // Settle: poll a predicate that always times out so we wait without a race.
    await waitFor(() => false, 500).catch(() => {});

    // The server DROPS the write frame (readOnly), so the broadcast never
    // reaches the observer. Assert on the OBSERVER, not the writer (writer's
    // own local doc WILL have length 1 — only server broadcast/persist gates).
    assert.strictEqual(observerDoc.getArray('order').length, 0);

    writer.destroy(); observer.destroy();
    writerDoc.destroy(); observerDoc.destroy();
    hocuspocus.closeConnections?.();
    httpServer.close();
  });
});

// ── Test 5 — GATE: shutdown drain flushes ALL dirty rooms (#128 Task 5.2) ────

describe('Shutdown drain — GATE (#128 Task 5.2)', () => {
  // Test A — flush-all: ≥3 rooms ALL persist, not just the first.
  it('shutdown drain flushes ALL dirty rooms, not just the first', async () => {
    const persisted = new Map();
    const storage = {
      readRoom: async () => null,
      writeRoom: async (t, r, a) => { persisted.set(`${t}/${r}`, a.ydocBytes); },
      readAcl: async () => ({ ownerId: '_public', sharedWith: [] }),
    };
    const { srv, url } = await boot({
      storage, useHocuspocus: true,
      authProvider: { requiresAuth: false, validateToken: async () => null },
      wsRatePerMin: 10000, // 3+ WS connections exceed the default 10/min limit
    });

    const providers = [];
    for (const id of ['r1', 'r2', 'r3']) {
      const doc = new Y.Doc();
      const prov = new HocuspocusProvider({ url, name: `_public/${id}`, document: doc, WebSocketPolyfill: WS });
      await waitFor(() => prov.synced, 6000);
      doc.transact(() => { doc.getArray('order').push([id]); }, 'local-publish');
      // Wait until the edit has propagated to the SERVER-side doc before draining.
      // flushPendingStores() only flushes what the server already holds — draining
      // without this wait is a race (edit may still be in-flight over the WS).
      await waitFor(() => {
        const d = srv.hocuspocus.documents.get(`_public/${id}`);
        return d && d.getArray('order').length >= 1;
      }, 6000);
      providers.push({ prov, doc, id });
    }

    srv.hocuspocus.closeConnections();
    srv.hocuspocus.flushPendingStores();
    await srv.database.drain();

    for (const id of ['r1', 'r2', 'r3']) {
      assert.ok(persisted.has(`_public/${id}`), `room ${id} must be persisted by drain`);
    }

    for (const { prov, doc } of providers) { prov.destroy(); doc.destroy(); }
    try { srv.httpServer.close(); } catch {}
  });

  // Test B — within-grace at scale.
  // N=50 pessimistic rooms (free-plan demo, no prod p99 yet).
  // TODO(#128): re-confirm N against prod /health p99 post-launch.
  // BLOCKS=200 (midpoint of a real UFGS section: 100-300).
  // WRITE_LATENCY_MS=200 simulated S3/Azure PUT worst-case.
  // Grace assertion: elapsed < 20000ms (Render SIGTERM ~25s, 5s safety margin).
  it('shutdown drain completes within Render SIGTERM grace at N=50 rooms × 200 blocks', { timeout: 120000 }, async () => {
    const N = 50;
    const BLOCKS = 200;
    const WRITE_LATENCY_MS = 200;

    const storage = {
      readRoom: async () => null,
      writeRoom: async () => { await new Promise(r => setTimeout(r, WRITE_LATENCY_MS)); },
      readAcl: async () => ({ ownerId: '_public', sharedWith: [] }),
    };
    const { srv, url } = await boot({
      storage, useHocuspocus: true,
      authProvider: { requiresAuth: false, validateToken: async () => null },
      wsRatePerMin: 10000, // N=50 WS connections far exceed the default 10/min limit
    });

    // Build a list of BLOCKS block ids to push into each room's order array.
    const blockIds = Array.from({ length: BLOCKS }, (_, i) => `block-${i}`);

    const providers = [];
    for (let i = 0; i < N; i++) {
      const id = `gate-room-${i}`;
      const doc = new Y.Doc();
      const prov = new HocuspocusProvider({ url, name: `_public/${id}`, document: doc, WebSocketPolyfill: WS });
      await waitFor(() => prov.synced, 10000);
      doc.transact(() => { doc.getArray('order').push(blockIds); }, 'local-publish');
      // Wait for the server-side doc to reflect the full block list before
      // proceeding — skipping this makes drain operate on a partially-populated
      // server doc (not a real race test).
      await waitFor(() => {
        const d = srv.hocuspocus.documents.get(`_public/${id}`);
        return d && d.getArray('order').length >= BLOCKS;
      }, 10000);
      providers.push({ prov, doc });
    }

    const t0 = Date.now();
    srv.hocuspocus.closeConnections();
    srv.hocuspocus.flushPendingStores();
    await srv.database.drain();
    const elapsed = Date.now() - t0;

    // Print for the commit-message record (stderr so it appears in test output).
    console.error('[gate] drain elapsed ms:', elapsed);

    assert.ok(
      elapsed < 20000,
      `drain must finish within 20s Render grace; took ${elapsed}ms (N=${N}, BLOCKS=${BLOCKS}, WRITE_LATENCY_MS=${WRITE_LATENCY_MS})`
    );

    for (const { prov, doc } of providers) { prov.destroy(); doc.destroy(); }
    try { srv.httpServer.close(); } catch {}
  });
});

// ── Test 4 — Y.XmlFragment substrate gc round-trip (#128 Task 4.3) ──────────

describe('SecWriterDatabase gc round-trip (#128 Task 4.3)', () => {
  it('Y.XmlFragment substrate survives store -> fetch -> reload under gc', async () => {
    // CJS require_ so instanceof checks use the same Y class as the CJS server
    // modules (single hoisted yjs copy — Gate A1 finding).
    const Yc = require_('yjs');
    const { seedRoomFromBlocks } = require_('../room-serializer.cjs');
    const { migrateRoom } = require_('../migrate-pm-substrate.cjs');
    const { SecWriterDatabase } = require_('../secwriter-database.cjs');
    const { pmFragmentToHtml } = await import('../../src/lib/pmdoc-html.js');

    // 1. Seed a legacy Y.Text slot, then drive the broker to a real Y.XmlFragment.
    const doc = new Yc.Doc({ gc: true });
    seedRoomFromBlocks(doc, [{ id: 'a', type: 'txt', part: 1, depth: 0, html: '<b>bold</b> text' }]);
    const result = migrateRoom(doc, { log: { info() {}, warn() {}, error() {} } });
    assert.strictEqual(result.migrationPartial, false);
    assert.strictEqual(result.migratedCount, 1);
    const slot = doc.getMap('store').get('a').get('html');
    assert.ok(slot instanceof Yc.XmlFragment, 'broker must produce Y.XmlFragment, not Y.Text');
    const htmlBefore = pmFragmentToHtml(slot);
    assert.ok(htmlBefore, 'pre-store html must be non-empty (else the final equality is vacuous)');

    // 2. Store via the database, fetch the bytes back into a FRESH gc doc.
    const captured = {};
    const db = new SecWriterDatabase({
      storage: {
        // Capture only ydocBytes; the sec/comments/lint sidecars are not under test here.
        writeRoom: async (t, r, a) => { captured.bytes = a.ydocBytes; },
        readRoom: async () => ({ ydocBytes: captured.bytes }),
      },
      roomHealth: new Map(),
      maxDocBytes: 8 * 1024 * 1024,
      log: { warn() {}, error() {} },
    });
    await db.store({ documentName: 'tenantA/room1', document: doc });
    const bytes = await db.fetch({ documentName: 'tenantA/room1' });
    assert.ok(bytes, 'fetch must return the stored bytes');
    const reloaded = new Yc.Doc({ gc: true });
    Yc.applyUpdate(reloaded, bytes);

    // 3. Reloaded slot is STILL a Y.XmlFragment and reads back identical HTML.
    const reSlot = reloaded.getMap('store').get('a').get('html');
    assert.ok(reSlot instanceof Yc.XmlFragment, 'reloaded slot must remain Y.XmlFragment (gc must not collapse it)');
    assert.strictEqual(pmFragmentToHtml(reSlot), htmlBefore);
  });
});

// ── GATE A2 — seed-safety server properties (#128 Task 7.2) ──────────────────

describe('GATE A2 — seed-safety server properties (#128 Task 7.2)', () => {
  // Step 1 — load-ordering: synced fires only AFTER onLoadDocument state is applied.
  // readRoom is deliberately SLOW (800ms) to widen the race window.
  // If lenAtSynced !== 5: STOP — Hocuspocus's synced does NOT wait for onLoadDocument,
  // which breaks the entire option-A seed premise.
  it('synced fires only AFTER onLoadDocument state is applied', { timeout: 30000 }, async () => {
    const { seedRoomFromBlocks } = require_('../room-serializer.cjs');
    // Use CJS Y for seedRoomFromBlocks (same class as room-serializer.cjs uses).
    const Yc = require_('yjs');
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const persisted = new Yc.Doc();
    seedRoomFromBlocks(persisted, [0,1,2,3,4].map(i => ({ id: `b${i}`, type: 'txt', part: 1, depth: 0, html: `B${i}` })));
    const bytes = Yc.encodeStateAsUpdate(persisted);
    const storage = {
      readRoom: async (t, r) => { await sleep(800); return r === 'existing' ? { ydocBytes: bytes } : null; },
      writeRoom: async () => {},
      readAcl: async () => ({ ownerId: '_public', sharedWith: [] }),
    };
    const { srv, url } = await boot({ storage, useHocuspocus: true, authProvider: { requiresAuth: false, validateToken: async () => null } });
    const dExist = new Y.Doc();
    let lenAtSynced = -1;
    const pExist = new HocuspocusProvider({ url, name: '_public/existing', document: dExist, WebSocketPolyfill: WS, onSynced: () => { lenAtSynced = dExist.getArray('order').length; } });
    await waitFor(() => pExist.synced, 10000);
    assert.strictEqual(lenAtSynced, 5, 'server state must be applied to the client doc BEFORE synced fires');
    const dNew = new Y.Doc();
    let newLenAtSynced = -1;
    const pNew = new HocuspocusProvider({ url, name: '_public/newroom', document: dNew, WebSocketPolyfill: WS, onSynced: () => { newLenAtSynced = dNew.getArray('order').length; } });
    await waitFor(() => pNew.synced, 10000);
    assert.strictEqual(newLenAtSynced, 0, 'a genuinely-new room is empty at synced');
    pExist.destroy(); pNew.destroy(); dExist.destroy(); dNew.destroy(); srv.cleanup?.(); srv.httpServer.close();
  });

  // Step 2 — load-once-from-memory (kills two-client doubling).
  // A second client to a room syncs the first's content from the shared in-memory doc
  // WITHOUT a second readRoom call.
  it('second concurrent client loads from memory (one readRoom, sees content)', { timeout: 30000 }, async () => {
    const { seedRoomFromBlocks } = require_('../room-serializer.cjs');
    // Use CJS Y for seedRoomFromBlocks (same class as room-serializer.cjs uses).
    const Yc = require_('yjs');
    let reads = 0;
    const persisted = new Yc.Doc();
    seedRoomFromBlocks(persisted, [{ id: 'a', type: 'txt', part: 1, depth: 0, html: 'A' }]);
    const bytes = Yc.encodeStateAsUpdate(persisted);
    const storage = {
      readRoom: async () => { reads++; return { ydocBytes: bytes }; },
      writeRoom: async () => {},
      readAcl: async () => ({ ownerId: '_public', sharedWith: [] }),
    };
    const { srv, url } = await boot({ storage, useHocuspocus: true, authProvider: { requiresAuth: false, validateToken: async () => null } });
    const dA = new Y.Doc();
    const pA = new HocuspocusProvider({ url, name: '_public/shared', document: dA, WebSocketPolyfill: WS });
    await waitFor(() => pA.synced, 10000);
    const dB = new Y.Doc();
    const pB = new HocuspocusProvider({ url, name: '_public/shared', document: dB, WebSocketPolyfill: WS });
    await waitFor(() => pB.synced, 10000);
    assert.strictEqual(dB.getArray('order').length, 1, 'second client must see the first client content');
    assert.strictEqual(reads, 1, 'load-once: the second client must NOT re-read storage');
    pA.destroy(); pB.destroy(); dA.destroy(); dB.destroy(); srv.cleanup?.(); srv.httpServer.close();
  });

  // Step 3 — warm-doc-across-reconnect (prevents re-seed AND seed loss).
  // With unloadImmediately: false (already configured in buildHocuspocus, Task 4.2),
  // a remount within the warm window re-syncs from MEMORY even though storage returns null.
  // If this fails (length === 0): report DONE_WITH_CONCERNS — unloadImmediately:false may
  // not keep the doc warm long enough, meaning the client seededRooms guard becomes the
  // sole re-seed defense.
  it('reconnect within the warm window syncs from memory (no false-empty)', { timeout: 30000 }, async () => {
    const storage = {
      readRoom: async () => null,
      writeRoom: async () => {},
      readAcl: async () => ({ ownerId: '_public', sharedWith: [] }),
    };
    const { srv, url } = await boot({ storage, useHocuspocus: true, authProvider: { requiresAuth: false, validateToken: async () => null } });
    const d1 = new Y.Doc();
    const p1 = new HocuspocusProvider({ url, name: '_public/warm', document: d1, WebSocketPolyfill: WS });
    await waitFor(() => p1.synced, 10000);
    d1.transact(() => { d1.getArray('order').push(['seeded']); }, 'local-publish');
    p1.destroy();
    const d2 = new Y.Doc();
    const p2 = new HocuspocusProvider({ url, name: '_public/warm', document: d2, WebSocketPolyfill: WS });
    await waitFor(() => p2.synced, 10000);
    assert.strictEqual(d2.getArray('order').length, 1, 'warm memory must retain the seed across an immediate remount');
    p2.destroy(); d1.destroy(); d2.destroy(); srv.cleanup?.(); srv.httpServer.close();
  });
});

// ── Test 6.2 — Broker under onLoadDocument: v1 → v2 + persist + client sync ──

describe('Broker under onLoadDocument (#128 Task 6.2)', () => {
  it('v1 room loaded by server is migrated, persisted, and client syncs v2 substrate', { timeout: 30000 }, async () => {
    // CJS require_ so instanceof checks use the same Y class as the CJS server
    // modules (single hoisted yjs copy — Gate A1 finding, mirroring Task 4.3).
    const Yc = require_('yjs');
    const { seedRoomFromBlocks } = require_('../room-serializer.cjs');
    const { pmFragmentToHtml } = await import('../../src/lib/pmdoc-html.js');

    // 1. Build v1 bytes to seed storage (legacy Y.Text slot, no schemaVersion).
    const v1 = new Yc.Doc();
    seedRoomFromBlocks(v1, [{ id: 'a', type: 'txt', part: 1, depth: 0, html: 'UNIQUEMARKER text' }]);
    const v1Bytes = Yc.encodeStateAsUpdate(v1);
    v1.destroy();

    // 2. Storage stub. backupRoom is REQUIRED — ensureMigrated awaits it before
    // any mutation; without it, migration silently skips (skipped:true), the
    // client receives the un-migrated v1 Y.Text and persisted.bytes stays unset,
    // so BOTH assertions below fail loudly (M2 trap — a hard failure, not a
    // false-positive pass).
    const persisted = {};
    const storage = {
      readRoom: async (t, r) => (t === '_public' && r === 'mig1') ? { ydocBytes: v1Bytes } : null,
      writeRoom: async (t, r, a) => { persisted.bytes = a.ydocBytes; },
      readAcl: async () => ({ ownerId: '_public', sharedWith: [] }),
      backupRoom: async () => {}, // REQUIRED — else ensureMigrated skips (M2 trap)
    };

    // 3. Boot the server and connect a client to _public/mig1.
    const { srv, url } = await boot({
      storage,
      useHocuspocus: true,
      authProvider: { requiresAuth: false, validateToken: async () => null },
      wsRatePerMin: 10000, // avoid default 10/min rate limit for this test
    });

    const clientDoc = new Yc.Doc();
    const prov = new HocuspocusProvider({
      url,
      name: '_public/mig1',
      document: clientDoc,
      WebSocketPolyfill: WS,
    });
    await waitFor(() => prov.synced, 10000);

    // 4a. Client must have received a migrated Y.XmlFragment slot (not legacy Y.Text).
    // Use clientDoc.getMap etc. via the ESM Y class path (HocuspocusProvider applies
    // the sync update using the ESM yjs import, so types in clientDoc are instances of
    // the ESM Y classes, not the CJS Yc classes — dual-yjs-package hazard documented
    // in CLAUDE.md / ADR-0006. Test 4.3 avoids this by applying bytes via Yc.applyUpdate
    // directly; here we gate on the constructor name to stay class-path-agnostic.)
    const slot = clientDoc.getMap('store').get('a').get('html');
    assert.ok(
      slot && slot.constructor && slot.constructor.name === 'YXmlFragment',
      `client must receive a migrated Y.XmlFragment slot, not legacy Y.Text (got: ${slot && slot.constructor && slot.constructor.name})`
    );
    // Duck-type defense: constructor.name alone would pass vacuously if a minifier
    // mangled the class name. Assert the slot quacks like a Y.XmlFragment (has
    // toArray, lacks Y.Text's toDelta) — the same shape pmFragmentToHtml keys on.
    assert.ok(
      typeof slot.toArray === 'function' && typeof slot.toDelta !== 'function',
      'client slot must duck-type as Y.XmlFragment (toArray present, no Y.Text toDelta)'
    );
    assert.ok(
      pmFragmentToHtml(slot).includes('UNIQUEMARKER'),
      'migrated block text must survive to the client'
    );

    // 4b. Migration must have been persisted by onLoadDocument's explicit-persist
    // gate (skipped===false → database.store). Without the explicit persist, the
    // onUpdate bind runs AFTER onLoadDocument returns, so the freshly-migrated
    // doc would never be written and every connect would re-run backupRoom.
    assert.ok(persisted.bytes, 'onLoadDocument must persist the migrated v2 doc');
    const re = new Yc.Doc();
    Yc.applyUpdate(re, persisted.bytes);
    assert.ok(
      re.getMap('store').get('a').get('html') instanceof Yc.XmlFragment,
      'persisted .ydoc must be the v2 substrate (Y.XmlFragment slot)'
    );
    // SCHEMA_VERSION_KEY = 'schemaVersion', SCHEMA_V2 = 2 (confirmed from migrate-pm-substrate.cjs:60-61).
    assert.strictEqual(
      re.getMap('meta').get('schemaVersion'),
      2,
      'persisted .ydoc must carry schemaVersion=2 in yMeta'
    );
    re.destroy();

    // 5. Cleanup (match the rest of the file: cleanup() tears down the relay
    // before closing the HTTP server).
    prov.destroy();
    clientDoc.destroy();
    srv.cleanup?.();
    try { srv.httpServer.close(); } catch {}
  });
});
