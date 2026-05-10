/**
 * relpos-selection.js — Y.RelativePosition save/restore for PM selections.
 *
 * Sub-PR 1e (#47, v2 plan Q28). Both FloatingToolbar and the undo frame
 * snapshot need to save a selection that survives:
 *   - a remote peer's Y.XmlFragment update (which replaces PM nodes inline
 *     and invalidates `Transform.mapping`),
 *   - a local re-render driven by a different block's setState (the saved
 *     DOM Range stays valid but a stash on the App-level state machine is
 *     not survivable across React reconciliation),
 *   - a Ctrl+Z that swaps `blocks[]` to a prior snapshot — the restore
 *     happens after the new EditorView for `blockId` has rendered.
 *
 * Strategy: store `(blockId, relAnchor, relHead)` where the relPos pair is
 * created by y-prosemirror's `getRelativeSelection(binding, state)` — that
 * function walks the binding's PM-position-to-YXmlText mapping cache and
 * anchors the relpos against the leaf YXmlText (NOT the surrounding
 * Y.XmlFragment). Restore therefore MUST use the binding-aware
 * `relativePositionToAbsolutePosition` to convert back to a PM offset.
 *
 * The previous fallback that called `Y.createRelativePositionFromTypeIndex`
 * directly against the fragment was removed — it anchored against the
 * fragment's child slots (paragraph elements) while the restore path read
 * `absPos.index` as if it were a PM offset, producing silent off-by-one
 * selections for any non-trivial doc. If the binding isn't present, the
 * helpers now return null/false honestly rather than fabricate a wrong
 * position.
 *
 * Cross-block selections (e.g. a multi-block highlight before Search/Replace)
 * are out of scope for the per-block PM model. Those stay App-level state.
 *
 * The helpers tolerate missing inputs (no Y.Doc, missing fragment, EditorView
 * destroyed, no binding) and return null rather than throwing — the snapshot
 * path runs frequently and a null snapshot is a perfectly acceptable "no
 * selection to restore" signal.
 */

import { TextSelection } from 'prosemirror-state';
import {
  getRelativeSelection,
  // y-prosemirror's binding-aware position converters. They walk the
  // binding's node mapping to translate between PM-doc-positions (which
  // include paragraph open/close delimiters) and the YXmlText leaves'
  // flat index space.
  absolutePositionToRelativePosition,
  relativePositionToAbsolutePosition,
} from 'y-prosemirror';

/**
 * Save a PM selection as a (blockId, relAnchor, relHead) tuple.
 *
 * REQUIRES a y-prosemirror binding. Production callers (FloatingToolbar
 * post-mount, undo frame snapshot) always have one because the EditorView
 * was instantiated with `ySyncPlugin(yXmlFragment)`. When the binding is
 * absent (e.g. tests that build a Yjs doc but skip the EditorView, or a
 * caller racing the EditorView's first sync), we return null rather than
 * fabricate an off-by-one relpos via the naive `createRelativePositionFromTypeIndex`
 * path — that primitive anchors against the fragment's child slots
 * (paragraph elements), not against PM-document offsets that include
 * paragraph open/close delimiters. Mixing the two produces silently wrong
 * positions, which is worse than a clean null.
 *
 * @param {Object} args
 * @param {string} args.blockId
 * @param {import('prosemirror-view').EditorView} args.view
 * @param {Y.XmlFragment} args.yXmlFragment
 * @param {Object} [args.binding] — y-prosemirror's ProsemirrorBinding (from
 *   `ySyncPluginKey.getState(view.state).binding`). Required for a non-null
 *   result; null otherwise.
 * @returns {{ blockId, relAnchor, relHead } | null}
 */
export function saveSelection(args) {
  if (!args || typeof args !== 'object') return null;
  const { blockId, view, yXmlFragment, binding } = args;
  if (!blockId || !view || !yXmlFragment) return null;
  if (!binding || typeof binding.mapping === 'undefined') return null;
  const sel = view.state.selection;
  if (!sel) return null;

  try {
    const { anchor, head } = getRelativeSelection(binding, view.state);
    if (!anchor || !head) return null;
    return { blockId, relAnchor: anchor, relHead: head };
  } catch {
    return null;
  }
}

/**
 * Restore a saved selection into a PM EditorView.
 *
 * REQUIRES the same binding shape that saveSelection used. The relpos
 * tuples are anchored against YXmlText leaves (via y-prosemirror's
 * `getRelativeSelection`), so `relativePositionToAbsolutePosition` is
 * the only converter that produces valid PM positions back. The legacy
 * `Y.createAbsolutePositionFromRelativePosition` path was removed because
 * it returned indices anchored against a *different* type than the save
 * path used (fragment vs leaf), producing silent off-by-one selections.
 *
 * Caller is responsible for: (a) checking `saved.blockId` matches the view
 * being restored into, (b) deferring the call until the EditorView has
 * mounted/re-rendered for the relevant block.
 *
 * Args:
 *   saved        — value returned by saveSelection
 *   view         — PM EditorView to restore into
 *   ydoc         — the Y.Doc owning the YXmlFragment
 *   yXmlFragment — required, the same fragment passed to saveSelection
 *   binding      — required, y-prosemirror's ProsemirrorBinding
 *
 * @returns {boolean} true on success, false otherwise.
 */
export function restoreSelection(args) {
  if (!args || typeof args !== 'object') return false;
  const { saved, view, ydoc, yXmlFragment, binding } = args;
  if (!saved || !view || !ydoc || !yXmlFragment || !binding) return false;
  const { relAnchor, relHead } = saved;
  if (!relAnchor || !relHead) return false;

  let aIdx;
  let hIdx;
  try {
    aIdx = relativePositionToAbsolutePosition(ydoc, yXmlFragment, relAnchor, binding.mapping);
    hIdx = relativePositionToAbsolutePosition(ydoc, yXmlFragment, relHead, binding.mapping);
  } catch {
    return false;
  }
  if (aIdx == null || hIdx == null) return false;

  // PM positions live in the EditorView's doc; clamp to the doc's content
  // size to avoid throwing if the resolved Y index is past the doc end
  // (can happen mid-tear-down).
  const max = view.state.doc.content.size;
  aIdx = Math.min(Math.max(aIdx, 0), max);
  hIdx = Math.min(Math.max(hIdx, 0), max);

  try {
    const $a = view.state.doc.resolve(aIdx);
    const $h = view.state.doc.resolve(hIdx);
    const tr = view.state.tr.setSelection(TextSelection.between($a, $h));
    view.dispatch(tr);
    return true;
  } catch {
    return false;
  }
}

// Re-export y-prosemirror helpers so call sites that already imported this
// module don't need a parallel y-prosemirror import.
export {
  absolutePositionToRelativePosition,
  relativePositionToAbsolutePosition,
};

