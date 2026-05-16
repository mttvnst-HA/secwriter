// Sub-PR 1h Q36 Commit A — undo-helpers semantics.
//
// makeUndoHelpers(ydoc, undoManager) returns:
//   - withUndoFrame(fn): wraps `fn` in ydoc.transact(fn, 'local-publish').
//     All Yjs writes inside `fn` collapse into a single UndoManager frame.
//   - forceFrame(): calls undoManager.stopCapturing(). The CURRENT capture
//     window ends; the NEXT 'local-publish' write starts a fresh frame.
//
// Why these are the two helpers (not one):
//   withUndoFrame is the multi-write wrapper for paired sites like
//   handleAcceptAll — N per-block writes inside one ydoc.transact → one
//   undo frame (per the Yjs nested-transact outer-origin-wins rule
//   verified by adversarial Q5 review at yjs Transaction.js:412-447).
//   forceFrame is for single-call sites where the next write should NOT
//   coalesce into the previous keystroke-burst frame.
//
// Commit A intentionally ships these as dead code: no call site uses them
// yet (the 23-site migration is Commit C). These tests pin the semantics
// so the migration in Commit C can assert correct behavior at every site.

import { describe, it, expect, beforeEach } from 'vitest';
import * as Y from 'yjs';

import { makeUndoHelpers } from '../undo-helpers.js';

function makeDoc() {
  const ydoc = new Y.Doc();
  const yMap = ydoc.getMap('store');
  const undoManager = new Y.UndoManager([yMap], {
    trackedOrigins: new Set(['local-publish']),
  });
  return { ydoc, yMap, undoManager };
}

describe('makeUndoHelpers', () => {
  let ctx;
  beforeEach(() => { ctx = makeDoc(); });

  describe('withUndoFrame', () => {
    it('wraps two writes inside one transact → one undo frame', () => {
      const { ydoc, yMap, undoManager } = ctx;
      const { withUndoFrame } = makeUndoHelpers(ydoc, undoManager);

      expect(undoManager.undoStack.length).toBe(0);
      withUndoFrame(() => {
        yMap.set('a', '1');
        yMap.set('b', '2');
      });
      expect(undoManager.undoStack.length).toBe(1);
    });

    it('uses local-publish origin (so the UndoManager tracks it)', () => {
      const { ydoc, yMap, undoManager } = ctx;
      const { withUndoFrame } = makeUndoHelpers(ydoc, undoManager);

      // Sanity: a non-tracked origin produces no frame.
      ydoc.transact(() => { yMap.set('untracked', 'x'); }, 'other-origin');
      expect(undoManager.undoStack.length).toBe(0);

      // withUndoFrame writes ARE tracked.
      withUndoFrame(() => { yMap.set('tracked', 'y'); });
      expect(undoManager.undoStack.length).toBe(1);
    });

    it('one withUndoFrame containing a nested local-publish transact still produces one frame', () => {
      // Verifies the Yjs nested-transact outer-origin-wins behavior the
      // Q38 accept-all walking relies on. If this changes upstream, Q38's
      // "one undo frame" regression test will also catch it — but pinning
      // here gives a single-line localizable failure.
      const { ydoc, yMap, undoManager } = ctx;
      const { withUndoFrame } = makeUndoHelpers(ydoc, undoManager);

      withUndoFrame(() => {
        yMap.set('a', '1');
        ydoc.transact(() => { yMap.set('b', '2'); }, 'local-publish');
      });
      expect(undoManager.undoStack.length).toBe(1);
    });

    it('exception inside fn leaves partial writes committed and undoable', () => {
      // Contract for Commit C migration sites: if a multi-write gesture
      // (paste, accept-all, drag-drop) throws partway through, the
      // writes that landed BEFORE the throw stay applied AND remain
      // undoable as one frame. The user can still Ctrl+Z to back out
      // of the partial state. This matches Yjs's Y.transact semantics
      // (no automatic rollback on throw) — the test pins the user-
      // facing contract that depends on it.
      const { ydoc, yMap, undoManager } = ctx;
      const { withUndoFrame } = makeUndoHelpers(ydoc, undoManager);

      expect(() => withUndoFrame(() => {
        yMap.set('a', '1');
        throw new Error('boom');
      })).toThrow('boom');

      // Partial write survives the throw.
      expect(yMap.get('a')).toBe('1');
      expect(undoManager.undoStack.length).toBe(1);

      // The contract that matters: user can undo the partial state.
      undoManager.undo();
      expect(yMap.get('a')).toBe(undefined);
      expect(undoManager.undoStack.length).toBe(0);
      expect(undoManager.redoStack.length).toBe(1);
    });
  });

  describe('forceFrame', () => {
    it('ends the current capture window — next write starts a fresh frame', () => {
      const { ydoc, yMap, undoManager } = ctx;
      const { forceFrame } = makeUndoHelpers(ydoc, undoManager);

      ydoc.transact(() => { yMap.set('a', '1'); }, 'local-publish');
      expect(undoManager.undoStack.length).toBe(1);

      forceFrame();
      ydoc.transact(() => { yMap.set('b', '2'); }, 'local-publish');
      expect(undoManager.undoStack.length).toBe(2);
    });

    it('without forceFrame, two same-burst writes coalesce by captureTimeout', () => {
      // Counter-test: proves the "two frames" outcome of the previous test
      // is specifically caused by forceFrame and not by Yjs separating
      // transacts. Within the captureTimeout window (default 500ms; pinned
      // explicitly in collab.js), back-to-back 'local-publish' writes
      // share one frame.
      const { ydoc, yMap, undoManager } = ctx;

      ydoc.transact(() => { yMap.set('a', '1'); }, 'local-publish');
      ydoc.transact(() => { yMap.set('b', '2'); }, 'local-publish');
      expect(undoManager.undoStack.length).toBe(1);
    });

    it('forceFrame is a no-op when the UndoManager has no current capture', () => {
      const { undoManager } = ctx;
      const { forceFrame } = makeUndoHelpers(ctx.ydoc, undoManager);

      expect(undoManager.undoStack.length).toBe(0);
      expect(() => forceFrame()).not.toThrow();
      expect(undoManager.undoStack.length).toBe(0);
    });
  });

  describe('shape', () => {
    it('returns an object with exactly { withUndoFrame, forceFrame }', () => {
      const helpers = makeUndoHelpers(ctx.ydoc, ctx.undoManager);
      expect(Object.keys(helpers).sort()).toEqual(['forceFrame', 'withUndoFrame']);
      expect(typeof helpers.withUndoFrame).toBe('function');
      expect(typeof helpers.forceFrame).toBe('function');
    });
  });
});
