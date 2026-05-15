/**
 * useLocalSubstrateUndoManager — Yjs UndoManager bound to App's local
 * substrate Y.Doc, for out-of-room (no collab session) editing.
 *
 * Sub-PR 1h Q36 Commit B. The in-room counterpart is the UndoManager
 * inside `createCollabSession` (`src/lib/collab.js`); the two share the
 * same trackedOrigins (`'local-publish'` + `ySyncPluginKey`) and
 * `captureTimeout` (500ms), so PM-mode Ctrl+Z behaves identically
 * whether or not the user is in a collab room.
 *
 * Why this isn't part of `createCollabSession`:
 *   The collab session is only created when `inRoom && identity`. Until
 *   1i removes legacy mode, ALL editing — typing in a PM block, accept/
 *   reject revisions, slash-convert, etc. — must remain Ctrl+Z-undoable
 *   out of room too. The local substrate Y.Doc is allocated once in App
 *   (`localSubstrate`) and used by `useBlockBinder` for substrate
 *   reads/writes whenever `!inRoom`. This hook wraps that same Y.Doc
 *   in a UndoManager + helper pair so App can route Ctrl+Z through it.
 *
 * Lifetime: the UndoManager is created on first render against
 *   `{yOrder, yStore}` and destroyed when the hook unmounts (or when
 *   the substrate identity changes — App's `localSubstrate` is
 *   `useState(() => …)` so its identity is stable for the App's
 *   lifetime; this destroy path is defensive).
 *
 * trackedOrigins parity with collab.js (load-bearing):
 *   - 'local-publish'   — setBlockHtml binder writes, structural
 *                         applyBlocksToYDoc writes, App-level mutations.
 *   - ySyncPluginKey    — PM-driven per-keystroke ySyncPlugin writes.
 *
 * If the in-room set drifts from this one, in-room and out-of-room
 * users hit different Ctrl+Z semantics — track them together.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import * as Y from 'yjs';
import { ySyncPluginKey } from 'y-prosemirror';

import { makeUndoHelpers } from '../lib/undo-helpers.js';

/**
 * @typedef {Object} LocalSubstrateUndoApi
 * @property {() => boolean} tryUndo
 *   If the UndoManager has frames, pop one and return true. Else return
 *   false so the caller can fall through to a different undo source
 *   (App's `useUndoableBlocks` snapshot stack).
 * @property {() => boolean} tryRedo
 * @property {() => boolean} canUndo
 * @property {() => boolean} canRedo
 * @property {(fn: () => void) => void} withUndoFrame
 *   Wraps `fn` in `ydoc.transact(fn, 'local-publish')` so multi-write
 *   gestures collapse into one undo frame. Parallel surface to
 *   `useCollabSession.withUndoFrame` — Commit C migration sites call
 *   one or the other depending on `inRoom`. App should resolve to the
 *   correct helper via a `useMemo` gated on `inRoom`.
 * @property {() => void} forceFrame
 *   Ends the current capture window; the next 'local-publish' or
 *   ySyncPluginKey write starts a fresh frame. Word-boundary-undo plugin
 *   calls this on space / punctuation / Enter keydowns.
 */

/**
 * @param {{ ydoc: Y.Doc, yOrder: Y.Array<string>, yStore: Y.Map<string, Y.Map> }} substrate
 * @returns {LocalSubstrateUndoApi}
 */
function makeUndoManager(yOrder, yStore) {
  return new Y.UndoManager([yOrder, yStore], {
    trackedOrigins: new Set(['local-publish', ySyncPluginKey]),
    captureTimeout: 500,
  });
}

export function useLocalSubstrateUndoManager(substrate) {
  const { ydoc, yOrder, yStore } = substrate;

  // StrictMode-safe lifecycle: a naïve `useMemo` cache persists across the
  // dev double-mount, so the first cleanup destroys the manager and the
  // second setup re-registers cleanup against the now-dead instance —
  // Ctrl+Z silently breaks in dev. Creating the manager INSIDE the effect
  // means each setup phase produces a fresh, live manager and each
  // cleanup destroys exactly that manager. The initial state seed makes
  // the API live before the effect commits (synchronous reads work).
  // Pinned by the StrictMode test in useLocalSubstrateUndoManager.test.jsx.
  const [undoManager, setUndoManager] = useState(() => makeUndoManager(yOrder, yStore));

  useEffect(() => {
    const mgr = makeUndoManager(yOrder, yStore);
    setUndoManager(mgr);
    return () => { mgr.destroy(); };
  }, [yOrder, yStore]);

  const helpersRef = useRef(null);
  if (!helpersRef.current || helpersRef.current.undoManager !== undoManager) {
    helpersRef.current = {
      undoManager,
      helpers: makeUndoHelpers(ydoc, undoManager),
    };
  }

  const api = useMemo(() => {
    const { helpers } = helpersRef.current;
    return {
      tryUndo() {
        if (undoManager.undoStack.length === 0) return false;
        undoManager.undo();
        return true;
      },
      tryRedo() {
        if (undoManager.redoStack.length === 0) return false;
        undoManager.redo();
        return true;
      },
      canUndo() { return undoManager.undoStack.length > 0; },
      canRedo() { return undoManager.redoStack.length > 0; },
      withUndoFrame: helpers.withUndoFrame,
      forceFrame: helpers.forceFrame,
    };
  }, [undoManager]);

  return api;
}
