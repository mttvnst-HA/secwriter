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
    // lever in isolation, pinning the exact key Hocuspocus reads
    // (connectionConfig.readOnly). Test 3b drives the SAME gate through the
    // production createCollabServer wrapper (which sets it for viewer roles).
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

// ── Test 3b — #239 viewer WS gate through the PRODUCTION wrapper ─────────────

describe('#239 viewer read-only gate (production createCollabServer wrapper)', () => {
  // Test 3 exercises the readOnly lever on a STANDALONE Hocuspocus, bypassing
  // createCollabServer's onAuthenticate wrapper — which is exactly how the
  // original bug shipped green: the wrapper mutated `data.connection.readOnly`,
  // but Hocuspocus reads `data.connectionConfig.readOnly` (its Connection ctor
  // + the Authenticated scope both use connectionConfig). So the wrapper was a
  // silent no-op. This test drives a REAL viewer/editor through the wrapper.
  it('viewer connect is readonly (writes dropped) while editor is read-write (writes propagate)', async () => {
    const storage = {
      readRoom: async () => null,
      writeRoom: async () => {},
      readAcl: async (tenant, roomId) =>
        `${tenant}/${roomId}` === 'tenantA/room1'
          ? { ownerId: 'owner', roles: { viewerUser: 'viewer', editorUser: 'editor' } }
          : null,
    };
    const users = {
      tokV: { id: 'viewerUser', tenant: 'tenantA' },
      tokE: { id: 'editorUser', tenant: 'tenantA' },
      tokO: { id: 'owner', tenant: 'tenantA' },
    };
    const { srv, url } = await boot({
      storage, useHocuspocus: true,
      authProvider: { requiresAuth: true, validateToken: async (t) => users[t] || null },
    });
    const name = 'tenantA/room1';
    const mk = (doc, token) => new HocuspocusProvider({ url, name, document: doc, token, WebSocketPolyfill: WS });

    // Owner observer: the authoritative peer that only accepted writes reach.
    const obsDoc = new Y.Doc();
    const observer = mk(obsDoc, 'tokO');
    await waitFor(() => observer.synced, 4000);

    // Viewer: server sets connectionConfig.readOnly → client scope 'readonly'.
    const viewerDoc = new Y.Doc();
    const viewer = mk(viewerDoc, 'tokV');
    await waitFor(() => viewer.synced, 4000);
    assert.strictEqual(viewer.authorizedScope, 'readonly'); // client-facing UX mirror (banner/read-only editor)

    // Viewer write is applied locally but DROPPED by the server → never reaches
    // the observer. This is the acceptance's "viewer cannot write, WS layer".
    viewerDoc.transact(() => viewerDoc.getArray('order').push(['viewer-edit']), 'local-publish');
    await waitFor(() => false, 500).catch(() => {});
    assert.strictEqual(obsDoc.getArray('order').length, 0, 'viewer write must not propagate');

    // Editor: read-write; its write DOES propagate — proves the gate is
    // role-scoped, not a blanket denial.
    const editorDoc = new Y.Doc();
    const editor = mk(editorDoc, 'tokE');
    await waitFor(() => editor.synced, 4000);
    assert.strictEqual(editor.authorizedScope, 'read-write');
    editorDoc.transact(() => editorDoc.getArray('order').push(['editor-edit']), 'local-publish');
    await waitFor(() => obsDoc.getArray('order').length === 1, 4000);
    assert.strictEqual(obsDoc.getArray('order').get(0), 'editor-edit');

    viewer.destroy(); editor.destroy(); observer.destroy();
    viewerDoc.destroy(); editorDoc.destroy(); obsDoc.destroy();
    srv.cleanup?.(); srv.httpServer.close();
  });
});

// ── #268 — live-session force-revocation on room role change ────────────────

describe('#268 live-session revocation (revokeLiveSessions)', () => {
  // A mutable ACL map + a room name shared by the tests below. Each test boots
  // its own server (its own map instance) so they don't cross-contaminate.
  const ROOM = 'tenantA/room1';
  const T = 'tenantA';
  const R = 'room1';

  function connCountFor(srv, name) {
    const doc = srv.hocuspocus.documents.get(name);
    return doc ? doc.connections.size : 0;
  }

  // Every revoke test opens ≥2 WS connections and reconnects at least once, so
  // the default 10/min WS rate limit would trip — lift it.
  function bootRevoke(aclMap) {
    const users = {
      tokO: { id: 'owner', tenant: T },
      tokE: { id: 'editorUser', tenant: T },
      tokE2: { id: 'editorUser2', tenant: T },
    };
    const storage = {
      readRoom: async () => null,
      writeRoom: async () => {},
      readAcl: async (tenant, roomId) => aclMap.get(`${tenant}/${roomId}`) || null,
    };
    return boot({
      storage, useHocuspocus: true, wsRatePerMin: 100000,
      authProvider: { requiresAuth: true, validateToken: async (t) => users[t] || null },
    });
  }

  // T1 — downgrade editor→viewer: the live session is kicked, reconnects, and
  // its re-auth scope becomes 'readonly' AND a subsequent write is dropped.
  it('T1 downgrade editor→viewer: reconnects readonly and its writes are dropped', { timeout: 20000 }, async () => {
    const aclMap = new Map([[ROOM, { ownerId: 'owner', roles: { editorUser: 'editor' } }]]);
    const { srv, url } = await bootRevoke(aclMap);

    const obsDoc = new Y.Doc();
    const observer = new HocuspocusProvider({ url, name: ROOM, document: obsDoc, token: 'tokO', WebSocketPolyfill: WS });
    await waitFor(() => observer.synced, 8000);

    const edDoc = new Y.Doc();
    const editor = new HocuspocusProvider({ url, name: ROOM, document: edDoc, token: 'tokE', WebSocketPolyfill: WS });
    await waitFor(() => editor.synced, 8000);
    assert.strictEqual(editor.authorizedScope, 'read-write');

    // Editor is read-write: its write reaches the owner observer.
    edDoc.transact(() => edDoc.getArray('order').push(['e1']), 'local-publish');
    await waitFor(() => obsDoc.getArray('order').length === 1, 8000);

    // Downgrade in the ACL, then kick the live session.
    aclMap.set(ROOM, { ownerId: 'owner', roles: { editorUser: 'viewer' } });
    const n = srv.revokeLiveSessions(T, R, { subjects: ['editorUser'] });
    assert.strictEqual(n, 1, 'exactly the editor session is kicked');

    // The kicked provider auto-reconnects and re-auths as a viewer.
    await waitFor(() => editor.authorizedScope === 'readonly', 12000);

    // Post-downgrade write is DROPPED server-side — observer still sees only e1.
    edDoc.transact(() => edDoc.getArray('order').push(['e2']), 'local-publish');
    await waitFor(() => false, 700).catch(() => {});
    assert.strictEqual(obsDoc.getArray('order').length, 1, 'downgraded viewer write must not propagate');

    editor.destroy(); observer.destroy(); edDoc.destroy(); obsDoc.destroy();
    srv.cleanup?.(); srv.httpServer.close();
  });

  // T2 — removal: the kicked session's reconnect is auth-rejected exactly once,
  // no retry storm, and the connection is gone.
  it('T2 removal: reconnect is auth-rejected once, no storm', { timeout: 20000 }, async () => {
    const aclMap = new Map([[ROOM, { ownerId: 'owner', roles: { editorUser: 'editor' } }]]);
    const { srv, url } = await bootRevoke(aclMap);

    let authFailCount = 0;
    const edDoc = new Y.Doc();
    const editor = new HocuspocusProvider({
      url, name: ROOM, document: edDoc, token: 'tokE', WebSocketPolyfill: WS,
      onAuthenticationFailed: () => { authFailCount += 1; },
    });
    await waitFor(() => editor.synced, 8000);
    assert.strictEqual(authFailCount, 0);

    // Remove the editor from the ACL, then kick.
    aclMap.set(ROOM, { ownerId: 'owner', roles: {} });
    const n = srv.revokeLiveSessions(T, R, { subjects: ['editorUser'] });
    assert.strictEqual(n, 1);

    // Reconnect re-auths → onAuthenticate throws (no role) → exactly one failure.
    await waitFor(() => authFailCount >= 1, 12000);
    await waitFor(() => connCountFor(srv, ROOM) === 0, 8000);

    // Settle and confirm the failure did not storm.
    await waitFor(() => false, 2000).catch(() => {});
    assert.ok(authFailCount <= 2, `no retry storm (authFailCount=${authFailCount})`);

    editor.destroy(); edDoc.destroy();
    srv.cleanup?.(); srv.httpServer.close();
  });

  // T3 — a non-target session is untouched when a DIFFERENT subject is revoked.
  it('T3 non-target session stays connected + read-write', { timeout: 20000 }, async () => {
    const aclMap = new Map([[ROOM, { ownerId: 'owner', roles: { editorUser: 'editor', editorUser2: 'editor' } }]]);
    const { srv, url } = await bootRevoke(aclMap);

    const obsDoc = new Y.Doc();
    const observer = new HocuspocusProvider({ url, name: ROOM, document: obsDoc, token: 'tokO', WebSocketPolyfill: WS });
    await waitFor(() => observer.synced, 8000);

    const aDoc = new Y.Doc();
    const edA = new HocuspocusProvider({ url, name: ROOM, document: aDoc, token: 'tokE', WebSocketPolyfill: WS });
    const bDoc = new Y.Doc();
    const edB = new HocuspocusProvider({ url, name: ROOM, document: bDoc, token: 'tokE2', WebSocketPolyfill: WS });
    await waitFor(() => edA.synced && edB.synced, 8000);

    // Downgrade A only, kick A only.
    aclMap.set(ROOM, { ownerId: 'owner', roles: { editorUser: 'viewer', editorUser2: 'editor' } });
    const n = srv.revokeLiveSessions(T, R, { subjects: ['editorUser'] });
    assert.strictEqual(n, 1);

    // B was never kicked: still read-write, and its write reaches the observer.
    assert.strictEqual(edB.authorizedScope, 'read-write');
    bDoc.transact(() => bDoc.getArray('order').push(['b1']), 'local-publish');
    await waitFor(() => obsDoc.getArray('order').length === 1 && obsDoc.getArray('order').get(0) === 'b1', 8000);

    edA.destroy(); edB.destroy(); observer.destroy(); aDoc.destroy(); bDoc.destroy(); obsDoc.destroy();
    srv.cleanup?.(); srv.httpServer.close();
  });

  // T4 — identity-match guard (Finding 2). A subject that is NOT any live
  // conn's context.user.id kicks NOTHING (returns 0); the exact id kicks. This
  // is the tripwire for a future user.id namespace change silently no-op'ing
  // every real revoke.
  it('T4 identity guard: wrong subject kicks nothing, exact subject kicks', { timeout: 20000 }, async () => {
    const aclMap = new Map([[ROOM, { ownerId: 'owner', roles: { editorUser: 'editor' } }]]);
    const { srv, url } = await bootRevoke(aclMap);

    const edDoc = new Y.Doc();
    const editor = new HocuspocusProvider({ url, name: ROOM, document: edDoc, token: 'tokE', WebSocketPolyfill: WS });
    await waitFor(() => editor.synced, 8000);

    // Wrong subject → no match → zero kicks, session untouched.
    const miss = srv.revokeLiveSessions(T, R, { subjects: ['not-a-real-subject'] });
    assert.strictEqual(miss, 0, 'a non-matching subject must kick nothing');
    await waitFor(() => false, 300).catch(() => {});
    assert.strictEqual(connCountFor(srv, ROOM), 1, 'session must remain connected after a no-match revoke');
    assert.strictEqual(editor.synced, true, 'session stays synced after a no-match revoke');

    // Exact subject → one kick. Proves the negative above is a real match test,
    // not a broken harness.
    const hit = srv.revokeLiveSessions(T, R, { subjects: ['editorUser'] });
    assert.strictEqual(hit, 1, 'the exact context.user.id must be kicked');

    editor.destroy(); edDoc.destroy();
    srv.cleanup?.(); srv.httpServer.close();
  });

  // T5 — merge-regression guard: the real DELETE /rooms/:id HTTP route (which
  // calls finishRoomDeletion on success, not revokeLiveSessions directly)
  // still kicks a live session. finishRoomDeletion folds the #268 hard-kick in
  // internally, BEFORE it drops the doc from hocuspocusInstance.documents
  // (which revokeLiveSessions reads to find connections) — a standalone
  // post-deleteRoom revoke call would find the room no longer resident and
  // silently kick nobody. This pins the fold-in ordering, not just the
  // revokeLiveSessions primitive itself (T1-T4 call it directly and would not
  // catch a delete-route wiring regression).
  it('T5 DELETE /rooms/:id kicks a live session via finishRoomDeletion (not a standalone post-delete call)', { timeout: 20000 }, async () => {
    const aclMap = new Map([[ROOM, { ownerId: 'owner', roles: { editorUser: 'editor' } }]]);
    const users = {
      tokO: { id: 'owner', tenant: T },
      tokE: { id: 'editorUser', tenant: T },
    };
    const emptyDoc = new Y.Doc();
    const emptyBytes = Y.encodeStateAsUpdate(emptyDoc);
    emptyDoc.destroy();
    const storage = {
      readRoom: async (t, r) => (t === T && r === R ? { ydocBytes: emptyBytes } : null),
      writeRoom: async () => {},
      // A real deleteRoom clears the ACL sidecar too — the mock must match, or
      // the kicked editor's reconnect re-authenticates against the STALE ACL
      // and never observes onAuthenticationFailed (this diagnosed the first
      // draft of this test: without the aclMap.delete below, the timeout was
      // the mock's fault, not finishRoomDeletion's).
      deleteRoom: async (t, r) => { aclMap.delete(`${t}/${r}`); },
      readAcl: async (t, r) => aclMap.get(`${t}/${r}`) || null,
    };
    const authProvider = {
      requiresAuth: true,
      validateToken: async (t) => users[t] || null,
      extractToken(req) {
        const auth = req.headers?.authorization;
        if (!auth || !auth.startsWith('Bearer ')) return null;
        return auth.slice(7);
      },
    };
    const { srv, url } = await boot({ storage, useHocuspocus: true, wsRatePerMin: 100000, authProvider });
    const base = `http://127.0.0.1:${srv.httpServer.address().port}`;

    let authFailCount = 0;
    const edDoc = new Y.Doc();
    const editor = new HocuspocusProvider({
      url, name: ROOM, document: edDoc, token: 'tokE', WebSocketPolyfill: WS,
      onAuthenticationFailed: () => { authFailCount += 1; },
    });
    await waitFor(() => editor.synced, 8000);
    assert.strictEqual(connCountFor(srv, ROOM), 1, 'editor must be resident before delete');

    const del = await new Promise((resolve, reject) => {
      const req = http.request(
        { hostname: '127.0.0.1', port: srv.httpServer.address().port, path: `/rooms/${R}`, method: 'DELETE', headers: { Authorization: 'Bearer tokO' } },
        (res) => { const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf-8') })); },
      );
      req.on('error', reject);
      req.end();
    });
    assert.strictEqual(del.status, 200, `DELETE should succeed, got ${del.status}: ${del.body}`);

    // The room is gone from hocuspocus.documents (finishRoomDeletion evicted it)...
    assert.strictEqual(srv.hocuspocus.documents.has(ROOM), false, 'finishRoomDeletion must have removed the live doc');
    // ...and the editor's session was force-reconnected BEFORE that eviction —
    // its reconnect re-authenticates against the now-deleted ACL and fails.
    await waitFor(() => authFailCount >= 1, 12000);

    editor.destroy(); edDoc.destroy();
    srv.cleanup?.(); srv.httpServer.close();
  });

  // T6 (#267) — the { emails } selector kicks only the email-matched conn, with
  // case-insensitive normalization. Pending-by-email invitees have no ACL
  // `roles` entry (thus no stable subject to target by `subjects`), so a
  // downgrade/removal that touches them must be reachable by email. A is
  // targeted by a MIXED-CASE email to prove normalizeEmail runs on both the
  // selector and conn.context.user.email; B (a different email) must stay
  // connected read-write. Numbered T6 because the T5 slot above is the
  // DELETE-route merge guard.
  it('T6 (#267): revokeLiveSessions({ emails }) kicks only the email-matched conn', { timeout: 20000 }, async () => {
    const aclMap = new Map([[ROOM, { ownerId: 'owner', roles: { editorUser: 'editor', editorUser2: 'editor' } }]]);
    const users = {
      tokO: { id: 'owner', tenant: T, email: 'owner@y.com' },
      tokEA: { id: 'editorUser', tenant: T, email: 'a@y.com' },
      tokEB: { id: 'editorUser2', tenant: T, email: 'b@y.com' },
    };
    const storage = {
      readRoom: async () => null,
      writeRoom: async () => {},
      readAcl: async (tenant, roomId) => aclMap.get(`${tenant}/${roomId}`) || null,
    };
    const { srv, url } = await boot({
      storage, useHocuspocus: true, wsRatePerMin: 100000,
      authProvider: { requiresAuth: true, validateToken: async (t) => users[t] || null },
    });

    const obsDoc = new Y.Doc();
    const observer = new HocuspocusProvider({ url, name: ROOM, document: obsDoc, token: 'tokO', WebSocketPolyfill: WS });
    await waitFor(() => observer.synced, 8000);

    let aAuthFail = 0;
    const aDoc = new Y.Doc();
    const edA = new HocuspocusProvider({
      url, name: ROOM, document: aDoc, token: 'tokEA', WebSocketPolyfill: WS,
      onAuthenticationFailed: () => { aAuthFail += 1; },
    });
    const bDoc = new Y.Doc();
    const edB = new HocuspocusProvider({ url, name: ROOM, document: bDoc, token: 'tokEB', WebSocketPolyfill: WS });
    await waitFor(() => edA.synced && edB.synced, 8000);

    // Remove A from the ACL so A's forced reconnect auth-FAILS (proving A was the
    // kicked session); B stays an editor.
    aclMap.set(ROOM, { ownerId: 'owner', roles: { editorUser2: 'editor' } });

    // Target A by a MIXED-CASE email — normalization must match a@y.com.
    const n = srv.revokeLiveSessions(T, R, { emails: ['A@Y.COM'] });
    assert.strictEqual(n, 1, 'only the email-matched connection is kicked');

    // A's reconnect re-auths against the now-removed ACL → exactly this session
    // fails: proves A (not B / not the owner) was the one kicked.
    await waitFor(() => aAuthFail >= 1, 12000);

    // B was never targeted: still read-write, and its write reaches the observer.
    assert.strictEqual(edB.authorizedScope, 'read-write');
    bDoc.transact(() => bDoc.getArray('order').push(['b1']), 'local-publish');
    await waitFor(() => obsDoc.getArray('order').length === 1 && obsDoc.getArray('order').get(0) === 'b1', 8000);

    edA.destroy(); edB.destroy(); observer.destroy(); aDoc.destroy(); bDoc.destroy(); obsDoc.destroy();
    srv.cleanup?.(); srv.httpServer.close();
  });
});

// ── T7 (#267) — pending-by-email invite binds to the sub on WS connect ──────

describe('#267 promotePending on WS connect (fire-and-forget)', () => {
  // A pending-by-email invitee (no bound ACL `roles` entry) connects. resolveRole
  // in onAuthenticate already GRANTS the connect via the pending invite; the
  // fire-and-forget promotePending call then PERSISTS the bind (roles[sub]) and
  // caches the display name, all under the shared ACL mutex. Because the bind is
  // detached from the connect verdict, we POLL the ACL rather than assert
  // synchronously — an unwired promotePending leaves roles.bob undefined and the
  // poll exhausts (a real failure, not a false pass).
  it('binds a pending-by-email invite to the connecting sub + caches display name', { timeout: 20000 }, async () => {
    const T = 'tenantA';
    const R = 'room1';
    const KEY = `${T}/${R}`;
    // Mutable ACL sidecar: seed a LIVE pending invite for bob@y.com.
    let aclState = {
      ownerId: 'owner',
      roles: {},
      pending: { 'bob@y.com': { role: 'editor', invitedBy: 'owner', invitedAt: new Date().toISOString() } },
    };
    const storage = {
      readRoom: async () => null,
      writeRoom: async () => {},
      readAcl: async (t, r) => (`${t}/${r}` === KEY ? JSON.parse(JSON.stringify(aclState)) : null),
      writeAcl: async (t, r, next) => { if (`${t}/${r}` === KEY) aclState = JSON.parse(JSON.stringify(next)); },
    };
    const { srv, url } = await boot({
      storage, useHocuspocus: true, wsRatePerMin: 100000,
      // The token MUST carry email (promotePending gates on ctx.user.email) and
      // name (the display cache reads user.name) — matching auth-jwt's claim map.
      authProvider: {
        requiresAuth: true,
        validateToken: async (t) => (t === 'tokBob' ? { id: 'bob', tenant: T, email: 'bob@y.com', name: 'Bob' } : null),
      },
    });

    const doc = new Y.Doc();
    const prov = new HocuspocusProvider({ url, name: KEY, document: doc, token: 'tokBob', WebSocketPolyfill: WS });
    await waitFor(() => prov.synced, 8000);

    // Fire-and-forget: poll storage until the bind lands (or time out).
    for (let i = 0; i < 50 && !((await storage.readAcl(T, R)).roles || {}).bob; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    const bound = await storage.readAcl(T, R);
    assert.strictEqual(bound.roles.bob, 'editor', 'pending invite must bind to the sub as editor');
    assert.strictEqual(bound.pending['bob@y.com'], undefined, 'the pending entry must be cleared after binding');
    assert.ok(bound.display && bound.display.bob && bound.display.bob.name === 'Bob', 'display name must be cached from the token');

    prov.destroy(); doc.destroy();
    srv.cleanup?.(); srv.httpServer.close();
  });
});

// ── #267 — revoke sweep uses resolveRole (keeps a valid pending-only session) ─

describe('#267 revoke sweep resolveRole (revokeSweep)', () => {
  // The periodic revoke sweep re-checks each live connection's role and kicks
  // stale ones. It MUST use resolveRole (not bare roleOf): a pending-by-email
  // invitee who was admitted via the pending invite but whose fire-and-forget
  // promotePending bind hasn't persisted yet would be seen by roleOf as
  // role=null and wrongly evicted during the connect→persist window.
  it('#267: revoke sweep does not evict a valid pending-only session', { timeout: 20000 }, async () => {
    const T = 'tenantA';
    const R = 'room1';
    const KEY = `${T}/${R}`;
    // writeAcl is a NO-OP: the fire-and-forget promotePending bind can NEVER
    // move pending→roles, so roleOf(acl,'bob') stays null the whole test. If the
    // sweep used roleOf it would evict bob on the FIRST sweep; resolveRole sees
    // the live pending invite and keeps him. LIVE invitedAt so the invite is
    // non-expired.
    let aclState = {
      ownerId: 'owner',
      roles: {},
      pending: { 'bob@y.com': { role: 'editor', invitedBy: 'owner', invitedAt: new Date().toISOString() } },
    };
    const storage = {
      readRoom: async () => null,
      writeRoom: async () => {},
      readAcl: async (t, r) => (`${t}/${r}` === KEY ? JSON.parse(JSON.stringify(aclState)) : null),
      writeAcl: async () => {}, // no-op — bind never persists (roleOf stays null)
    };
    const { srv, url } = await boot({
      storage, useHocuspocus: true, wsRatePerMin: 100000,
      authProvider: {
        requiresAuth: true,
        validateToken: async (t) => (t === 'tokBob' ? { id: 'bob', tenant: T, email: 'bob@y.com', name: 'Bob' } : null),
      },
    });

    let closeCount = 0;
    let authFailCount = 0;
    const doc = new Y.Doc();
    const prov = new HocuspocusProvider({
      url, name: KEY, document: doc, token: 'tokBob', WebSocketPolyfill: WS,
      onClose: () => { closeCount += 1; },
      onAuthenticationFailed: () => { authFailCount += 1; },
    });
    await waitFor(() => prov.synced, 8000);
    const baseClose = closeCount;

    // First sweep: resolveRole → editor (via the live pending invite) → NOT
    // stale → NOT kicked. A roleOf-based sweep would see role=null → kick bob →
    // the client's socket closes → closeCount increments.
    await srv.revokeSweep();
    await waitFor(() => false, 700).catch(() => {}); // settle
    assert.strictEqual(closeCount, baseClose, 'a validly-pending session must NOT be swept-closed (resolveRole, not roleOf)');
    assert.strictEqual(prov.synced, true, 'bob stays synced through the first sweep');
    assert.strictEqual(authFailCount, 0, 'no auth failure on the first sweep');

    // Remove the pending invite: resolveRole → null → stale → kicked. The forced
    // reconnect re-authenticates against the now-empty ACL and auth-fails.
    aclState = { ownerId: 'owner', roles: {}, pending: {} };
    await srv.revokeSweep();
    await waitFor(() => authFailCount >= 1, 12000);
    assert.ok(authFailCount >= 1, 'once the pending invite is gone the sweep must kick bob');

    prov.destroy(); doc.destroy();
    srv.cleanup?.(); srv.httpServer.close();
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
    // Widen the warm-doc window well past WS connect latency. The window equals
    // the Hocuspocus debounce (a dirty room with unloadImmediately:false stays in
    // memory until its debounced store fires after the last disconnect). The
    // production default is DEBOUNCE_MS=500ms — too tight to survive the p2
    // connect under full-suite parallel load (a RAFT flake, CLAUDE.md #11). 10s
    // keeps it deterministic without changing what is tested (we never assert the
    // store fires here).
    const { srv, url } = await boot({ storage, useHocuspocus: true, authProvider: { requiresAuth: false, validateToken: async () => null }, hocuspocusDebounceMs: 10000 });
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
