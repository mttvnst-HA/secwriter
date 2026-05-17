// src/lib/__tests__/structural-undo-origin.test.js
import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import { ySyncPluginKey } from 'y-prosemirror';
import { applyBlocksToYDoc } from '../collab.js';

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
});
