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

import { useEffect, useRef, useState } from 'react';
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
// captureTransaction rejects transactions whose `addToHistory` meta is
// false. y-prosemirror's sync-plugin propagates the PM-side
// `tr.setMeta('addToHistory', false)` to the resulting Yjs transaction meta
// (sync-plugin.js:228), so PM transactions can opt out of undo capture.
// The comment-reconcile path uses this — see pm-comments.js. Mirrors the
// y-prosemirror UndoPlugin's own filter (undo-plugin.js:71). Must stay in
// lockstep with the in-room counterpart in collab.js.
function makeUndoManager(yOrder, yStore) {
  return new Y.UndoManager([yOrder, yStore], {
    trackedOrigins: new Set(['local-publish', ySyncPluginKey]),
    captureTimeout: 500,
    captureTransaction: tr => tr.meta.get('addToHistory') !== false,
  });
}

// Tracks managers we've already destroyed so the StrictMode double-mount
// (effect cleanup destroys M2, then setup-2's setUndoManager updater
// receives M2 as `prev` and would otherwise call destroy() a second time)
// is a safe no-op rather than relying on Y.UndoManager.destroy() being
// idempotent. Y's destroy() happens to be idempotent today (it just
// `off`s already-removed observers), but the WeakSet makes the contract
// explicit and removes the dependency.
const destroyedManagers = new WeakSet();
function destroyOnce(mgr) {
  if (mgr && !destroyedManagers.has(mgr)) {
    destroyedManagers.add(mgr);
    mgr.destroy();
  }
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
  //
  // Replacement pattern: when the effect runs, it creates a fresh manager
  // and uses a `setUndoManager(prev => …)` updater to destroy the prior
  // manager (the useState seed on first mount, the StrictMode cleanup's
  // already-destroyed instance on the second setup) before returning the
  // new one. This avoids the M1-leaks-an-observer wart where the useState
  // seed's afterTransaction handler stayed attached for the App's lifetime
  // and silently captured duplicate StackItems alongside the live manager.
  // Pinned by the leak-regression test in useLocalSubstrateUndoManager.test.jsx.
  const [undoManager, setUndoManager] = useState(() => makeUndoManager(yOrder, yStore));

  // Live-manager ref read by the stable api methods at invocation time.
  // Updated both during render (so the value tracks `undoManager` state)
  // and from inside the effect (so the post-effect-pre-next-render
  // window also points at the fresh manager). Without these refs, App's
  // useCallback handlers — which capture `localUndo` from the FIRST
  // render to avoid TDZ on `collab` (declared 1300 lines below in App.jsx)
  // — would call methods on the M1 closure even after M1 is destroyed
  // and replaced by M2, making forceFrame a silent no-op out-of-room.
  // Pinned by the "forceFrame from a first-render-captured api routes
  // to the LIVE manager" stale-closure regression test.
  const managerRef = useRef(undoManager);
  managerRef.current = undoManager;

  const helpersRef = useRef(null);
  if (!helpersRef.current || helpersRef.current.manager !== undoManager) {
    helpersRef.current = {
      manager: undoManager,
      helpers: makeUndoHelpers(ydoc, undoManager),
    };
  }

  useEffect(() => {
    const mgr = makeUndoManager(yOrder, yStore);
    setUndoManager(prev => {
      if (prev && prev !== mgr) destroyOnce(prev);
      return mgr;
    });
    // Refresh refs synchronously so handlers firing between this effect
    // and the next render don't see the stale (now-destroyed) manager.
    managerRef.current = mgr;
    helpersRef.current = { manager: mgr, helpers: makeUndoHelpers(ydoc, mgr) };
    return () => { destroyOnce(mgr); };
  }, [yOrder, yStore]);

  // Stable api object — initialized once on first render, returned
  // unchanged across all subsequent renders. Methods read managerRef /
  // helpersRef at invocation time so they always route to the live
  // manager. Consumers (App's useCallback handlers) can capture this
  // object once and call its methods later without staleness.
  const apiRef = useRef(null);
  if (apiRef.current === null) {
    apiRef.current = {
      tryUndo() {
        const m = managerRef.current;
        if (!m || m.undoStack.length === 0) return false;
        m.undo();
        return true;
      },
      tryRedo() {
        const m = managerRef.current;
        if (!m || m.redoStack.length === 0) return false;
        m.redo();
        return true;
      },
      canUndo() { return !!managerRef.current && managerRef.current.undoStack.length > 0; },
      canRedo() { return !!managerRef.current && managerRef.current.redoStack.length > 0; },
      withUndoFrame(fn) { helpersRef.current.helpers.withUndoFrame(fn); },
      forceFrame() { helpersRef.current.helpers.forceFrame(); },
    };
  }

  return apiRef.current;
}
