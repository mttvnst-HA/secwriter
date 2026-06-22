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
