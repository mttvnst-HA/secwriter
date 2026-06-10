// src/lib/__tests__/structural-undo-origin.test.js
import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import { ySyncPluginKey } from 'y-prosemirror';
import { applyBlocksToYDoc } from '../collab.js';
import { seedBlockArray } from '../block-html-store.js';

function makeSubstrate(initial) {
  const ydoc = new Y.Doc();
  const yOrder = ydoc.getArray('order');
  const yStore = ydoc.getMap('store');
  // Seed via applyBlocksToYDoc so SCALAR_KEYS (type, part, depth, ...) land
  // on each yMap; seedBlockArray only seeds the html slot. The UndoManager
  // is constructed AFTER the seed so the seed is not a tracked frame.
  applyBlocksToYDoc(ydoc, yOrder, yStore, initial);
  const undoManager = new Y.UndoManager([yOrder, yStore], {
    trackedOrigins: new Set(['local-publish', ySyncPluginKey]),
    captureTimeout: 500,
    captureTransaction: tr => tr.meta.get('addToHistory') !== false,
  });
  return { ydoc, yOrder, yStore, undoManager };
}

describe('structural undo via applyBlocksToYDoc origin', () => {
  it('out-of-room slash-convert: type change is undoable in one frame', () => {
    const s = makeSubstrate([{ id: 'n1', type: 'txt', html: 'hello' }]);
    // Simulate App.jsx slash-convert: setBlocks → applyBlocksToYDoc.
    applyBlocksToYDoc(s.ydoc, s.yOrder, s.yStore, [
      { id: 'n1', type: 'note', html: 'hello' },
    ]);
    expect(s.yStore.get('n1').get('type')).toBe('note');
    expect(s.undoManager.undoStack.length).toBe(1);
    s.undoManager.undo();
    expect(s.yStore.get('n1').get('type')).toBe('txt');
  });

  it('#219: seedBlockArray + first applyBlocksToYDoc produces zero frames; undo-to-bottom keeps scalars', () => {
    // Mirror App.jsx mount ordering EXACTLY: seed the local substrate via
    // seedBlockArray (the function App's useState initializer calls), THEN
    // construct the UndoManager, THEN run the first applyBlocksToYDoc pass
    // (App's useEffect([blocks]) firing on mount). Pre-fix, seedBlockArray
    // wrote only the html slot, so that first apply set every scalar under
    // 'local-publish' and the manager captured a phantom frame — Ctrl+Z
    // past the first real edit then stripped every block's scalars.
    const initial = [
      { id: 'n1', type: 'txt', part: 1, depth: 0, html: 'PART 1' },
      { id: 'n2', type: 'txt', part: 1, depth: 1, html: 'hello' },
    ];
    const ydoc = new Y.Doc();
    const yOrder = ydoc.getArray('order');
    const yStore = ydoc.getMap('store');
    seedBlockArray(ydoc, yOrder, yStore, initial);
    const undoManager = new Y.UndoManager([yOrder, yStore], {
      trackedOrigins: new Set(['local-publish', ySyncPluginKey]),
      captureTimeout: 500,
      captureTransaction: tr => tr.meta.get('addToHistory') !== false,
    });
    // First apply pass on mount — must be a no-op (scalars already seeded).
    applyBlocksToYDoc(ydoc, yOrder, yStore, initial);
    expect(undoManager.undoStack.length).toBe(0);
    expect(yStore.get('n2').get('type')).toBe('txt');

    // One real user edit (a scalar flip — applyBlocksToYDoc skips html for
    // existing blocks, so html is owned by PM's ySyncPlugin; a type change
    // is the captured structural edit). Then undo past it to the bottom of
    // the stack. The scalars must survive — there is no phantom frame to pop.
    applyBlocksToYDoc(ydoc, yOrder, yStore, [
      initial[0],
      { ...initial[1], type: 'note' },
    ]);
    expect(undoManager.undoStack.length).toBe(1);
    expect(yStore.get('n2').get('type')).toBe('note');
    undoManager.undo();
    undoManager.undo(); // one past the real edit — pre-fix this nuked scalars
    expect(yStore.get('n2').get('type')).toBe('txt');
    expect(yStore.get('n2').get('part')).toBe(1);
    expect(yStore.get('n1').get('type')).toBe('txt');
  });

  it('idempotent applyBlocksToYDoc produces zero undo frames (no spurious capture)', () => {
    const initial = [
      { id: 'n1', type: 'txt', html: 'hello' },
      { id: 'n2', type: 'oli', html: 'world', level: 1 },
    ];
    const s = makeSubstrate(initial);
    const before = s.undoManager.undoStack.length;
    // Re-apply the same blocks unchanged — simulates App.jsx's
    // useEffect([blocks, ...]) firing for a non-scalar reason (e.g.
    // commentsState change re-rendering App without mutating blocks).
    applyBlocksToYDoc(s.ydoc, s.yOrder, s.yStore, initial);
    expect(s.undoManager.undoStack.length).toBe(before);
  });
});
