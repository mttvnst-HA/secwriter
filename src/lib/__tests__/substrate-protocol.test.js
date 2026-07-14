// substrate-protocol — architecture-review candidate #5.
//
// Pins the single-source-of-truth for the client substrate UndoManager
// config so the in-room (collab.js) and out-of-room
// (useLocalSubstrateUndoManager.js) managers cannot drift into different
// Ctrl+Z semantics. Both are built by createSubstrateUndoManager; these
// tests assert what that factory guarantees.

import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import { ySyncPluginKey } from 'y-prosemirror';

import {
  LOCAL_PUBLISH,
  TRACKED_ORIGINS,
  SUBSTRATE_CAPTURE_TIMEOUT,
  isUndoableTransaction,
  createSubstrateUndoManager,
} from '../substrate-protocol.js';

function makeScopedManager() {
  const ydoc = new Y.Doc();
  const yOrder = ydoc.getArray('order');
  const yStore = ydoc.getMap('store');
  const mgr = createSubstrateUndoManager([yOrder, yStore]);
  return { ydoc, yOrder, yStore, mgr };
}

// Y.UndoManager's constructor adds `this` to trackedOrigins, so the manager's
// own origin is in the live Set. Strip it to recover the declared membership.
function declaredOrigins(mgr) {
  return [...mgr.trackedOrigins].filter((o) => o !== mgr);
}

describe('substrate-protocol vocabulary', () => {
  it('LOCAL_PUBLISH is the local-prefixed publish origin', () => {
    expect(LOCAL_PUBLISH).toBe('local-publish');
    expect(LOCAL_PUBLISH.startsWith('local-')).toBe(true);
  });

  it('TRACKED_ORIGINS is exactly [LOCAL_PUBLISH, ySyncPluginKey] and frozen', () => {
    expect(TRACKED_ORIGINS).toEqual([LOCAL_PUBLISH, ySyncPluginKey]);
    expect(Object.isFrozen(TRACKED_ORIGINS)).toBe(true);
  });

  it('isUndoableTransaction rejects only addToHistory:false', () => {
    expect(isUndoableTransaction({ meta: new Map() })).toBe(true);
    expect(isUndoableTransaction({ meta: new Map([['addToHistory', true]]) })).toBe(true);
    expect(isUndoableTransaction({ meta: new Map([['addToHistory', false]]) })).toBe(false);
  });
});

describe('createSubstrateUndoManager', () => {
  it('tracks exactly the declared origins with the default captureTimeout', () => {
    const { mgr } = makeScopedManager();
    expect(declaredOrigins(mgr)).toEqual([LOCAL_PUBLISH, ySyncPluginKey]);
    expect(mgr.captureTimeout).toBe(SUBSTRATE_CAPTURE_TIMEOUT);
    expect(SUBSTRATE_CAPTURE_TIMEOUT).toBe(500);
  });

  it('gives each manager an independent trackedOrigins Set (constructor adds `this`)', () => {
    // Sharing one Set across two managers would make each track the other,
    // silently entangling the in-room and out-of-room undo stacks.
    const a = makeScopedManager().mgr;
    const b = makeScopedManager().mgr;
    expect(a.trackedOrigins).not.toBe(b.trackedOrigins);
    expect(a.trackedOrigins.has(b)).toBe(false);
    expect(b.trackedOrigins.has(a)).toBe(false);
    // The shared canonical list is untouched by construction.
    expect(TRACKED_ORIGINS).toEqual([LOCAL_PUBLISH, ySyncPluginKey]);
  });

  it('in-room and out-of-room managers get identical declared config (no drift)', () => {
    const inRoom = makeScopedManager().mgr;
    const outOfRoom = makeScopedManager().mgr;
    expect(declaredOrigins(inRoom)).toEqual(declaredOrigins(outOfRoom));
    expect(inRoom.captureTimeout).toBe(outOfRoom.captureTimeout);
  });

  it('captures a LOCAL_PUBLISH write and skips an addToHistory:false write', () => {
    const { ydoc, yStore, mgr } = makeScopedManager();
    ydoc.transact(() => yStore.set('a', 1), LOCAL_PUBLISH);
    expect(mgr.undoStack.length).toBe(1);

    // An addToHistory:false transaction must not add a frame.
    ydoc.transact((tr) => {
      tr.meta.set('addToHistory', false);
      yStore.set('b', 2);
    }, LOCAL_PUBLISH);
    expect(mgr.undoStack.length).toBe(1);
  });

  it('honors a caller-supplied captureTimeout override', () => {
    const ydoc = new Y.Doc();
    const mgr = createSubstrateUndoManager([ydoc.getMap('m')], { captureTimeout: 0 });
    expect(mgr.captureTimeout).toBe(0);
  });
});
