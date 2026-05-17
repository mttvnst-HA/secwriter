import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import { ySyncPluginKey } from 'y-prosemirror';
import { applyBlocksToYDoc, yBlocksToArray } from '../lib/collab.js';

// Mirrors useLocalSubstrateUndoManager.js's UndoManager config (load-bearing —
// they must stay in lockstep, see the hook's docstring).
function makeLocalUndoManager(yOrder, yStore) {
  return new Y.UndoManager([yOrder, yStore], {
    trackedOrigins: new Set(['local-publish', ySyncPluginKey]),
    captureTimeout: 500,
    captureTransaction: tr => tr.meta.get('addToHistory') !== false,
  });
}

describe('out-of-room structural undo → substrate revert is bridgeable via yBlocksToArray', () => {
  it('after Ctrl+Z on a block-creation, yBlocksToArray returns the pre-create list', () => {
    const ydoc = new Y.Doc();
    const yOrder = ydoc.getArray('order');
    const yStore = ydoc.getMap('store');
    const initial = [
      { id: 'n1', type: 'txt', html: 'first' },
      { id: 'n2', type: 'txt', html: 'second' },
    ];
    // Seed via applyBlocksToYDoc (writes scalars). UndoManager constructed
    // AFTER the seed so the seed is NOT a tracked frame.
    applyBlocksToYDoc(ydoc, yOrder, yStore, initial);
    const um = makeLocalUndoManager(yOrder, yStore);

    // Simulate App.handleEnterKey: setBlocks adds a block, useEffect calls
    // applyBlocksToYDoc with the new list.
    const after = [
      { id: 'n1', type: 'txt', html: 'first' },
      { id: 'n2', type: 'txt', html: 'second' },
      { id: 'n3', type: 'txt', html: '' },
    ];
    applyBlocksToYDoc(ydoc, yOrder, yStore, after);
    expect(yOrder.length).toBe(3);
    expect(um.undoStack.length).toBe(1);

    // Ctrl+Z: localUndo.tryUndo() pops the frame.
    um.undo();

    // App.jsx's fix: sync React blocks from substrate via yBlocksToArray.
    const synced = yBlocksToArray(yOrder, yStore);

    // The list should match the pre-create state in length and key fields.
    // (yBlocksToArray loses React-only transient fields like `isNew`, but the
    // structural shape is what matters for the failing E2E.)
    expect(synced.length).toBe(2);
    expect(synced.map(b => b.id)).toEqual(['n1', 'n2']);
    expect(synced[0].type).toBe('txt');
    expect(synced[1].type).toBe('txt');
  });

  it('redo restores the post-create list', () => {
    const ydoc = new Y.Doc();
    const yOrder = ydoc.getArray('order');
    const yStore = ydoc.getMap('store');
    applyBlocksToYDoc(ydoc, yOrder, yStore, [{ id: 'n1', type: 'txt', html: 'x' }]);
    const um = makeLocalUndoManager(yOrder, yStore);
    applyBlocksToYDoc(ydoc, yOrder, yStore, [
      { id: 'n1', type: 'txt', html: 'x' },
      { id: 'n2', type: 'note', html: 'y' },
    ]);
    um.undo();
    expect(yBlocksToArray(yOrder, yStore).length).toBe(1);
    um.redo();
    const synced = yBlocksToArray(yOrder, yStore);
    expect(synced.length).toBe(2);
    expect(synced[1].id).toBe('n2');
    expect(synced[1].type).toBe('note');
  });
});
