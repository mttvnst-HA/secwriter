// @vitest-environment jsdom
//
// Sub-PR 1h Q36 Commit B — out-of-room Yjs UndoManager hook.
//
// The hook wraps App's local substrate Y.Doc in a Y.UndoManager configured
// with the same trackedOrigins + captureTimeout as the in-room collab
// session's UndoManager (`src/lib/collab.js`). These tests pin three things:
//   1. The UndoManager captures BOTH 'local-publish' AND ySyncPluginKey
//      origins (drift between in-room and out-of-room would yield
//      different Ctrl+Z semantics depending on collab mode).
//   2. tryUndo / tryRedo return false when the respective stack is empty
//      (so App's keydown handler can fall through to useUndoableBlocks).
//   3. The UndoManager is destroyed on unmount (no listener leak across
//      session-mode flips).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { renderHook, cleanup } from '@testing-library/react';
import { StrictMode } from 'react';
import * as Y from 'yjs';
import { ySyncPluginKey } from 'y-prosemirror';

import { useLocalSubstrateUndoManager } from '../useLocalSubstrateUndoManager.js';

function makeSubstrate() {
  const ydoc = new Y.Doc();
  const yOrder = ydoc.getArray('order');
  const yStore = ydoc.getMap('store');
  return { ydoc, yOrder, yStore };
}

let substrate;

beforeEach(() => { substrate = makeSubstrate(); });
afterEach(() => { cleanup(); });

describe('useLocalSubstrateUndoManager', () => {
  describe('shape', () => {
    it('returns { tryUndo, tryRedo, canUndo, canRedo, withUndoFrame, forceFrame, clearStack }', () => {
      const { result } = renderHook(() => useLocalSubstrateUndoManager(substrate));
      expect(Object.keys(result.current).sort()).toEqual(
        ['canRedo', 'canUndo', 'clearStack', 'forceFrame', 'tryRedo', 'tryUndo', 'withUndoFrame'],
      );
      expect(typeof result.current.tryUndo).toBe('function');
      expect(typeof result.current.tryRedo).toBe('function');
      expect(typeof result.current.canUndo).toBe('function');
      expect(typeof result.current.canRedo).toBe('function');
      expect(typeof result.current.withUndoFrame).toBe('function');
      expect(typeof result.current.forceFrame).toBe('function');
      expect(typeof result.current.clearStack).toBe('function');
    });
  });

  describe('tracked origins', () => {
    it("captures 'local-publish' writes", () => {
      const { result } = renderHook(() => useLocalSubstrateUndoManager(substrate));
      expect(result.current.canUndo()).toBe(false);

      substrate.ydoc.transact(() => {
        substrate.yStore.set('b1', new Y.Map());
      }, 'local-publish');

      expect(result.current.canUndo()).toBe(true);
    });

    it('captures ySyncPluginKey writes', () => {
      // Parity with collab.js. Without this, PM-driven keystrokes
      // out-of-room would NOT enter the undo stack, and Ctrl+Z would do
      // nothing for typing.
      const { result } = renderHook(() => useLocalSubstrateUndoManager(substrate));
      expect(result.current.canUndo()).toBe(false);

      substrate.ydoc.transact(() => {
        substrate.yStore.set('b1', new Y.Map());
      }, ySyncPluginKey);

      expect(result.current.canUndo()).toBe(true);
    });

    it('coalesces adjacent local-publish + ySyncPluginKey writes into ONE frame', () => {
      // Pins the documented dual-stack-no-coalescing wart claim (collab.js
      // + CLAUDE.md): a PM keystroke produces a `ySyncPluginKey` Yjs op,
      // and the debounced setBlockHtml echo produces a follow-up
      // `'local-publish'` op ~400ms later. Both origins are tracked, but
      // the 500ms captureTimeout window merges adjacent ops regardless of
      // origin, so one Ctrl+Z reverts both. If this empirical Yjs behavior
      // ever drifts (or someone shortens captureTimeout below the echo
      // delay), production typing would gain a confusing "Ctrl+Z reverts
      // half a keystroke" symptom and this test fails first.
      const { result } = renderHook(() => useLocalSubstrateUndoManager(substrate));

      // PM keystroke op.
      substrate.ydoc.transact(() => {
        substrate.yStore.set('pm-op', new Y.Map());
      }, ySyncPluginKey);

      // setBlockHtml echo op, same capture window.
      substrate.ydoc.transact(() => {
        substrate.yStore.set('echo-op', new Y.Map());
      }, 'local-publish');

      expect(result.current.canUndo()).toBe(true);
      // One frame, not two: tryUndo reverts BOTH ops.
      expect(result.current.tryUndo()).toBe(true);
      expect(substrate.yStore.has('pm-op')).toBe(false);
      expect(substrate.yStore.has('echo-op')).toBe(false);
      expect(result.current.canUndo()).toBe(false);
    });

    it("does NOT capture writes from foreign origins (e.g. 'remote' simulation)", () => {
      const { result } = renderHook(() => useLocalSubstrateUndoManager(substrate));

      substrate.ydoc.transact(() => {
        substrate.yStore.set('b1', new Y.Map());
      }, 'remote-peer');

      expect(result.current.canUndo()).toBe(false);
    });

    it("does NOT capture transactions tagged 'addToHistory: false' even on tracked origins", () => {
      // Pins the captureTransaction filter that lets the comment-reconcile
      // path opt out of undo capture (see pm-comments.js). Without this
      // filter, a peer-driven comment status flip would land its
      // transparent reconcile tr on the local user's undo stack — the user
      // could Ctrl+Z it, the next render's reconcile effect would
      // immediately re-apply it (visible flicker), and a real frame would
      // be displaced off the stack. The mechanism mirrors y-prosemirror's
      // own UndoPlugin (undo-plugin.js:71). Must stay in lockstep with
      // collab.js's in-room counterpart.
      const { result } = renderHook(() => useLocalSubstrateUndoManager(substrate));

      // Tracked origin (would normally be captured), but addToHistory=false.
      substrate.ydoc.transact(tr => {
        tr.meta.set('addToHistory', false);
        substrate.yStore.set('opt-out', new Y.Map());
      }, ySyncPluginKey);

      expect(result.current.canUndo()).toBe(false);
      expect(substrate.yStore.has('opt-out')).toBe(true); // write still happened
    });
  });

  describe('tryUndo / tryRedo', () => {
    it('returns false when undo stack is empty (caller falls through)', () => {
      const { result } = renderHook(() => useLocalSubstrateUndoManager(substrate));
      expect(result.current.tryUndo()).toBe(false);
    });

    it('returns false when redo stack is empty', () => {
      const { result } = renderHook(() => useLocalSubstrateUndoManager(substrate));
      expect(result.current.tryRedo()).toBe(false);
    });

    it('returns true and pops a frame when undo stack has entries', () => {
      const { result } = renderHook(() => useLocalSubstrateUndoManager(substrate));
      substrate.ydoc.transact(() => {
        substrate.yStore.set('b1', new Y.Map());
      }, 'local-publish');
      expect(result.current.canUndo()).toBe(true);

      expect(result.current.tryUndo()).toBe(true);
      expect(result.current.canUndo()).toBe(false);
      expect(result.current.canRedo()).toBe(true);
      expect(substrate.yStore.has('b1')).toBe(false);
    });

    it('returns true and pops a frame when redo stack has entries', () => {
      const { result } = renderHook(() => useLocalSubstrateUndoManager(substrate));
      substrate.ydoc.transact(() => {
        substrate.yStore.set('b1', new Y.Map());
      }, 'local-publish');
      result.current.tryUndo();
      expect(result.current.canRedo()).toBe(true);

      expect(result.current.tryRedo()).toBe(true);
      expect(substrate.yStore.has('b1')).toBe(true);
      expect(result.current.canRedo()).toBe(false);
    });
  });

  describe('withUndoFrame / forceFrame', () => {
    it('withUndoFrame wraps multi-write fn into one undo frame', () => {
      const { result } = renderHook(() => useLocalSubstrateUndoManager(substrate));

      result.current.withUndoFrame(() => {
        substrate.yStore.set('b1', new Y.Map());
        substrate.yStore.set('b2', new Y.Map());
      });

      expect(result.current.canUndo()).toBe(true);
      result.current.tryUndo();
      expect(substrate.yStore.has('b1')).toBe(false);
      expect(substrate.yStore.has('b2')).toBe(false);
    });

    it('forceFrame splits adjacent local-publish writes into two frames', () => {
      const { result } = renderHook(() => useLocalSubstrateUndoManager(substrate));

      substrate.ydoc.transact(() => {
        substrate.yStore.set('b1', new Y.Map());
      }, 'local-publish');

      result.current.forceFrame();

      substrate.ydoc.transact(() => {
        substrate.yStore.set('b2', new Y.Map());
      }, 'local-publish');

      // Two separate frames: one Ctrl+Z reverts b2 only.
      expect(result.current.tryUndo()).toBe(true);
      expect(substrate.yStore.has('b1')).toBe(true);
      expect(substrate.yStore.has('b2')).toBe(false);

      // A second Ctrl+Z reverts b1.
      expect(result.current.tryUndo()).toBe(true);
      expect(substrate.yStore.has('b1')).toBe(false);
    });
  });

  describe('lifecycle', () => {
    it('survives React StrictMode double-mount (dev sanity)', () => {
      // main.jsx wraps the app in <React.StrictMode>, which in dev forces
      // every effect to run setup → cleanup → setup. A naïve implementation
      // that creates the UndoManager via useMemo (persists across the
      // cleanup) and destroys it in the effect's cleanup would leave the
      // hook holding a destroyed manager after the StrictMode dance —
      // writes would not enter the stack, and Ctrl+Z would silently break
      // in dev. This test pins the post-StrictMode contract. Also exercises
      // the `destroyOnce` WeakSet contract in useLocalSubstrateUndoManager.js
      // — the second setup's `setUndoManager(prev => ...)` updater receives
      // a manager the first cleanup already destroyed; if `destroyOnce`
      // ever stops short-circuiting, this test fails because the double
      // `.destroy()` re-runs `off('afterTransaction', ...)` on an already-
      // removed observer and Yjs internals could (post-version-bump) start
      // throwing or no-op-mutating internal state.
      const { result } = renderHook(() => useLocalSubstrateUndoManager(substrate), {
        wrapper: ({ children }) => <StrictMode>{children}</StrictMode>,
      });

      // After the StrictMode setup→cleanup→setup dance, a tracked write
      // MUST land in the stack.
      substrate.ydoc.transact(() => {
        substrate.yStore.set('b1', new Y.Map());
      }, 'local-publish');

      expect(result.current.canUndo()).toBe(true);
      expect(result.current.tryUndo()).toBe(true);
      expect(substrate.yStore.has('b1')).toBe(false);
    });

    it('forceFrame from a first-render-captured api routes to the LIVE manager after manager swap', () => {
      // Regression for the stale-closure bug surfaced by Commit C review.
      // App's useCallback handlers capture `localUndo` from FIRST render
      // and never refresh (their deps arrays omit localUndo to avoid TDZ
      // on `collab`). When the hook's StrictMode-safe lifecycle swaps the
      // useState seed (M1) for the effect-created manager (M2), the
      // captured `localUndo` still references M1's bound forceFrame.
      // Post-leak-fix M1 is destroyed, so the call hits a dead manager
      // and the LIVE M2's capture window is NOT reset — out-of-room
      // click actions coalesce with prior typing on Ctrl+Z, defeating
      // Commit C's acceptance criterion 1.
      //
      // To accurately simulate App's closure pattern, capture the api
      // on the FIRST render only (the if-guard mimics useCallback's
      // empty-deps cache). result.current always returns the latest
      // value, so it can't reproduce the bug on its own.
      let capturedApi = null;
      const { result } = renderHook(() => {
        const api = useLocalSubstrateUndoManager(substrate);
        if (!capturedApi) capturedApi = api;
        return api;
      });

      // First write opens a capture window on the LIVE (post-effect) manager.
      substrate.ydoc.transact(() => {
        substrate.yStore.set('pre-force', new Y.Map());
      }, 'local-publish');

      expect(result.current.canUndo()).toBe(true);

      // forceFrame via the FIRST-RENDER api. If the captured api routes
      // to the now-destroyed seed manager, the live manager's window
      // stays open and the next write coalesces into one frame.
      capturedApi.forceFrame();

      substrate.ydoc.transact(() => {
        substrate.yStore.set('post-force', new Y.Map());
      }, 'local-publish');

      // Two frames means forceFrame reached the live manager. One frame
      // means the call was a no-op on the dead seed.
      result.current.tryUndo();
      expect(substrate.yStore.has('post-force')).toBe(false);
      expect(substrate.yStore.has('pre-force')).toBe(true);
    });

    it('leaves no afterTransaction observer attached after unmount', () => {
      // Regression: the original Commit B implementation used a `useState`
      // seed that created an UndoManager immediately on first render, then
      // the effect created a second manager and called setUndoManager —
      // but the seed manager was never destroyed. Its afterTransaction
      // observer stayed attached to the ydoc for the App's lifetime,
      // silently capturing duplicate StackItems alongside the live
      // manager. Symptom-wise this was invisible (canUndo reads the live
      // manager's stack, not the leak's), so a behavioral test couldn't
      // catch it. This test reaches into the ydoc's internal observer
      // map to verify zero net handlers remain after the hook unmounts.
      // Pins the leak fix landed alongside this test.
      function afterTxObservers() {
        return substrate.ydoc._observers?.get('afterTransaction')?.size || 0;
      }
      const baseline = afterTxObservers();

      const { unmount } = renderHook(() => useLocalSubstrateUndoManager(substrate));
      unmount();

      expect(afterTxObservers()).toBe(baseline);
    });

    it('post-unmount writes do NOT enter the destroyed manager (observer detached)', () => {
      // Y.UndoManager.destroy() removes its afterTransaction observer
      // (per yjs source) but keeps the in-memory stacks intact. The
      // contract this test pins is "no new ops captured after unmount" —
      // not "stacks cleared" — because that's what matters for App's
      // session-mode flip (out-of-room → in-room).
      const { result, unmount } = renderHook(() => useLocalSubstrateUndoManager(substrate));

      unmount();

      // Write AFTER unmount. If the observer were still attached, this
      // would push a frame to undoStack.
      substrate.ydoc.transact(() => {
        substrate.yStore.set('b1', new Y.Map());
      }, 'local-publish');

      // result.current still references the destroyed manager; canUndo
      // reads its undoStack directly. With the observer detached, the
      // stack stayed empty — proving destroy() ran.
      expect(result.current.canUndo()).toBe(false);
    });
  });
});
