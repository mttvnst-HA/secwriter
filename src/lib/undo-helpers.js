/**
 * Undo helpers — sub-PR 1h Q36 Commit A.
 *
 * Two small helpers bound to a (ydoc, undoManager) pair, returned by a
 * factory so the production wiring in `collab.js` and the unit tests in
 * `__tests__/undo-helpers.test.js` exercise the same code path:
 *
 *   withUndoFrame(fn)  →  ydoc.transact(fn, 'local-publish')
 *     All Yjs writes inside `fn` collapse into a single UndoManager frame.
 *     Used by multi-write user gestures (paste, drag-drop, find-replace-all,
 *     accept-all) in the Commit C migration so the gesture is one Ctrl+Z.
 *
 *     The Yjs nested-transact rule (outer-origin-wins; verified by
 *     adversarial Q5 review at yjs Transaction.js:412-447) makes nested
 *     `local-publish` transacts inside `fn` still collapse into the
 *     outer frame — see the "nested" test case.
 *
 *   forceFrame()  →  undoManager.stopCapturing()
 *     Ends the CURRENT capture window. The NEXT 'local-publish' write
 *     starts a fresh frame. Used by single-call sites where the next
 *     write should not coalesce into the previous keystroke-burst frame
 *     (e.g. handlePromote after typing).
 *
 * The helpers are deliberately NOT methods on the UndoManager itself:
 *   - withUndoFrame needs the ydoc, not the manager.
 *   - Both need to be available out-of-room (Commit B's local-substrate
 *     UndoManager hook constructs its own pair).
 *
 * Commit A ships these as dead code — no call site uses them yet. The
 * Commit C migration replaces the 23 `resumeHistory()` sites in App.jsx.
 */

/**
 * @param {Y.Doc} ydoc
 * @param {Y.UndoManager} undoManager
 * @returns {{
 *   withUndoFrame: (fn: () => void) => void,
 *   forceFrame: () => void,
 * }}
 *
 * Partial-write semantic (pinned by undo-helpers.test.js):
 *   If `fn` throws partway through, the writes that landed BEFORE the
 *   throw stay applied AND remain undoable as a single frame — Yjs's
 *   `Y.transact` does not auto-rollback on exception. Commit C
 *   migration sites that wrap fallible work do NOT need a surrounding
 *   try/catch to "undo on failure"; a single Ctrl+Z reverts the partial
 *   state. The throw still propagates to the caller, so caller-level
 *   error handling (toast, log, etc.) remains the caller's job.
 */
export function makeUndoHelpers(ydoc, undoManager) {
  return {
    withUndoFrame(fn) {
      ydoc.transact(fn, 'local-publish');
    },
    forceFrame() {
      undoManager.stopCapturing();
    },
  };
}
