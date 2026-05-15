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
    it('returns { tryUndo, tryRedo, canUndo, canRedo, withUndoFrame, forceFrame }', () => {
      const { result } = renderHook(() => useLocalSubstrateUndoManager(substrate));
      expect(Object.keys(result.current).sort()).toEqual(
        ['canRedo', 'canUndo', 'forceFrame', 'tryRedo', 'tryUndo', 'withUndoFrame'],
      );
      expect(typeof result.current.tryUndo).toBe('function');
      expect(typeof result.current.tryRedo).toBe('function');
      expect(typeof result.current.canUndo).toBe('function');
      expect(typeof result.current.canRedo).toBe('function');
      expect(typeof result.current.withUndoFrame).toBe('function');
      expect(typeof result.current.forceFrame).toBe('function');
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
      // in dev. This test pins the post-StrictMode contract.
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
