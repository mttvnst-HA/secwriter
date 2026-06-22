import { describe, it, expect, afterEach } from 'vitest';
import * as Y from 'yjs';
import { HocuspocusProvider } from '@hocuspocus/provider';
import WS from 'ws';
import { createCollabServer } from '../../../server/collab-server.cjs';
import { createCollabSession } from '../collab.js';
import { ySyncPluginKey } from 'y-prosemirror';

// Minimal storage stub: no persistence, ACL always allows (auth=none path).
const stubStorage = {
  readRoom: async () => null,
  writeRoom: async () => {},
  readAcl: async () => ({ ownerId: '_public', sharedWith: [] }),
};

let srv;
afterEach(() => { try { srv?.cleanup?.(); srv?.httpServer?.close(); } catch {} });

function waitFor(predicate, timeoutMs = 5000) {
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

describe('Gate A1: HocuspocusProvider remote-update origin', () => {
  it('local edit IS captured; peer edit is NOT (and arrives with a non-local, non-null origin)', async () => {
    srv = createCollabServer({
      storage: stubStorage,
      useHocuspocus: true,
      authProvider: { requiresAuth: false, validateToken: async () => null },
    });
    await new Promise(r => srv.httpServer.listen(0, '127.0.0.1', r));
    const url = `ws://127.0.0.1:${srv.httpServer.address().port}`;
    const room = '_public/gate-a1';

    const docA = new Y.Doc();
    const docB = new Y.Doc();
    // WebSocketPolyfill is REQUIRED in Node or the providers never connect.
    const provA = new HocuspocusProvider({ url, name: room, document: docA, WebSocketPolyfill: WS });
    const provB = new HocuspocusProvider({ url, name: room, document: docB, WebSocketPolyfill: WS });

    // Production trackedOrigins from collab.js.
    const undo = new Y.UndoManager([docA.getArray('order'), docA.getMap('store')], {
      trackedOrigins: new Set(['local-publish', ySyncPluginKey]),
      captureTimeout: 500,
    });

    await waitFor(() => provA.synced && provB.synced);

    // ── Positive control: a tracked LOCAL write IS captured. ──────────────
    docA.transact(() => {
      docA.getArray('order').push(['a1']);
      docA.getMap('store').set('a1', new Y.Map());
    }, 'local-publish');
    expect(undo.undoStack.length).toBe(1); // manager is live + scope intersects
    const stackAfterControl = undo.undoStack.length;

    // ── Record the origin of the NEXT remote-applied transaction on A. ────
    let remoteOrigin = 'UNSEEN';
    const onTx = (tr) => {
      if (tr.origin !== 'local-publish' && tr.changedParentTypes.size > 0) remoteOrigin = tr.origin;
    };
    docA.on('afterTransaction', onTx); // registered BEFORE B writes

    // B's LOCAL edit (tracked on B) arrives on A as a REMOTE update.
    docB.transact(() => {
      docB.getArray('order').push(['b1']);
      docB.getMap('store').set('b1', new Y.Map());
    }, 'local-publish');

    await waitFor(() => docA.getArray('order').length === 2); // a1 + b1
    docA.off('afterTransaction', onTx);

    // ── Undo property: peer edit did NOT grow A's stack, AND the reason is
    //    that its origin is NOT in trackedOrigins. ──────────────────────────
    expect(undo.undoStack.length).toBe(stackAfterControl);
    expect(remoteOrigin).not.toBe('UNSEEN'); // we actually observed a remote tx
    const trackedOrigins = new Set(['local-publish', ySyncPluginKey]);
    expect(trackedOrigins.has(remoteOrigin)).toBe(false); // <-- WHY the stack didn't grow

    // ── Re-emit property (separate concern): not null, not a 'local-' string,
    //    so handleAfterTx does NOT early-return and React still gets the block.
    expect(remoteOrigin).not.toBe(null);
    expect(typeof remoteOrigin === 'string' && remoteOrigin.startsWith('local-')).toBe(false);

    provA.destroy(); provB.destroy(); docA.destroy(); docB.destroy();
  });
});

describe('Gate A2: client re-seed guard holds across two mounts', () => {
  // Exercises createCollabSession's module-level seededRooms guard (collab.js
  // line 186). A new room seeded by session 1 must NOT have its blocks doubled
  // when session 2 mounts for the same room id (the StrictMode/reconnect
  // remount shape). Both the client-side seededRooms guard AND the server-side
  // empty-check inside handleSync participate; the test pins that EXACTLY N
  // blocks survive in the server doc regardless of which guard fires first.

  let srv2;
  afterEach(() => { try { srv2?.cleanup?.(); srv2?.httpServer?.close(); } catch {} });

  it('room seeded once has exactly N blocks after a second session mounts for the same room', async () => {
    srv2 = createCollabServer({
      storage: stubStorage,
      authProvider: { requiresAuth: false, validateToken: async () => null },
      migrationCoordinator: null,
      wsRatePerMin: 10000,
    });
    await new Promise(r => srv2.httpServer.listen(0, '127.0.0.1', r));
    const wsUrl = `ws://127.0.0.1:${srv2.httpServer.address().port}`;
    const room = '_public/reseed1';

    const initialBlocks = [
      { id: 'b1', type: 'txt', part: 1, depth: 0, html: 'Block one' },
      { id: 'b2', type: 'txt', part: 1, depth: 0, html: 'Block two' },
      { id: 'b3', type: 'txt', part: 1, depth: 0, html: 'Block three' },
    ];
    const N = initialBlocks.length;

    // ── Session 1: seed the room ────────────────────────────────────────────
    let initialBlocksReceived1 = null;
    const session1 = createCollabSession({
      room,
      wsUrl,
      wsPolyfill: WS,
      identity: { id: 'u1', name: 'U1', color: '#f00' },
      initialBlocks,
      onRemoteBlocks: (blocks, meta) => {
        if (meta?.initial) initialBlocksReceived1 = blocks;
      },
      onRemoteMeta: () => {},
      onRemoteTc: () => {},
      onRemoteComments: () => {},
      onRemoteLint: () => {},
      onRemoteLintIgnored: () => {},
      onRemoteLintMutedNlp: () => {},
      onPresenceChange: () => {},
      onStatusChange: () => {},
    });

    // Wait until session 1 is synced AND the server doc has exactly N blocks.
    await waitFor(() => {
      const doc = srv2.hocuspocus.documents.get(room);
      return doc != null && doc.getArray('order').length === N;
    });

    session1.destroy();

    // ── Session 2: remount for the same room with the same initialBlocks ────
    // The seededRooms guard (module-level Set) and the server's non-empty room
    // both prevent a second seed. We verify the count stays at exactly N.
    let initialBlocksReceived2 = null;
    const session2 = createCollabSession({
      room,
      wsUrl,
      wsPolyfill: WS,
      identity: { id: 'u2', name: 'U2', color: '#00f' },
      initialBlocks,  // same blocks — would double if guard were absent
      onRemoteBlocks: (blocks, meta) => {
        if (meta?.initial) initialBlocksReceived2 = blocks;
      },
      onRemoteMeta: () => {},
      onRemoteTc: () => {},
      onRemoteComments: () => {},
      onRemoteLint: () => {},
      onRemoteLintIgnored: () => {},
      onRemoteLintMutedNlp: () => {},
      onPresenceChange: () => {},
      onStatusChange: () => {},
    });

    // Wait for session 2's onRemoteBlocks({ initial: true }) to fire.
    await waitFor(() => initialBlocksReceived2 !== null);

    // ── Assertions ─────────────────────────────────────────────────────────
    // Server doc is the authoritative count — it is the shared state both
    // sessions observe; the client-callback count follows from it.
    const serverDoc = srv2.hocuspocus.documents.get(room);
    expect(serverDoc.getArray('order').length).toBe(N);

    // The blocks the second session received on its initial emit must also
    // be exactly N (not 2N) — the seed did not run twice.
    expect(initialBlocksReceived2.length).toBe(N);

    session2.destroy();
  }, 15000);
});
