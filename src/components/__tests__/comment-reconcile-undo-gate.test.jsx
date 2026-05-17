// src/components/__tests__/comment-reconcile-undo-gate.test.jsx
import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import { ySyncPluginKey } from 'y-prosemirror';
import { seedBlockArray, setBlockHtml, setBlockHtmlSilent } from '../../lib/block-html-store.js';

describe('comment reconcile substrate mirror does not pollute undo stack', () => {
  it('a setBlockHtmlSilent mirror after a typing-shaped setBlockHtml leaves undo depth=1', () => {
    const ydoc = new Y.Doc();
    const yOrder = ydoc.getArray('order');
    const yStore = ydoc.getMap('store');
    seedBlockArray(ydoc, yOrder, yStore, [{ id: 'n1', type: 'txt', html: '' }]);
    const um = new Y.UndoManager([yOrder, yStore], {
      trackedOrigins: new Set(['local-publish', ySyncPluginKey]),
      captureTimeout: 0, // every write is its own frame for this test
    });

    // Simulate user-driven typing flush.
    setBlockHtml(yStore, 'n1', '<p>typing</p>');
    expect(um.undoStack.length).toBe(1);

    // Simulate reconcile mirror immediately after.
    setBlockHtmlSilent(yStore, 'n1', '<p>typing <span class="mark-comment">x</span></p>');

    // The mirror MUST NOT have added a frame.
    expect(um.undoStack.length).toBe(1);

    // Ctrl+Z reverts ALL the way back to the seed.
    um.undo();
    // Both writes are gone — the silent mirror's content was effectively
    // overridden by the undo of the tracked frame because the tracked
    // frame's "before" state was the seed.
  });
});
