import { describe, it, expect, afterEach } from 'vitest';
import * as Y from 'yjs';
import { HocuspocusProvider } from '@hocuspocus/provider';
import WS from 'ws';
import { createCollabServer } from '../../../server/collab-server.cjs';
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
