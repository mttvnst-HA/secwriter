/**
 * pm-relpos.js — high-level Y.RelativePosition save/restore for PM
 * EditorViews. Sub-PR 1g.7 (#88), prereq for 1h's UndoManager rewire.
 *
 * Wraps the lower-level primitives in `pm-plugins/relpos-selection.js`
 * with a view-discovery layer: callers pass just an EditorView, and the
 * module pulls the y-prosemirror binding + Y.XmlFragment + Y.Doc out of
 * the view's plugin state.
 *
 * Use cases:
 *   1. FloatingToolbar saved selection (Q28 from v2 plan). The toolbar
 *      stashes the current selection when it opens; a peer's edit between
 *      open and toolbar-action shifts the underlying text. A DOM Range
 *      stash doesn't track that shift — Y.RelativePosition does.
 *   2. 1h's undo-frame caret restoration. Each undo frame snapshots the
 *      caret position; after Ctrl+Z dispatches the inverse Yjs op, the
 *      restored caret is wherever the user was at that frame, not
 *      wherever the inverse op happened to leave the DOM cursor.
 *
 * Cross-fragment limitation (documented):
 *   Y.RelativePosition is anchored to a SPECIFIC Y.XmlFragment. Saving in
 *   block A and restoring in block B silently produces a wrong position
 *   because the relpos walks A's CRDT structure to recover a B-side PM
 *   offset. We guard against this with a `blockId` check: saveSelection
 *   stamps the source block's id (read from `view.dom.dataset.blockId`),
 *   and restoreSelection refuses to restore into a view whose id differs.
 *
 * Binding requirement (also documented):
 *   These primitives REQUIRE a y-prosemirror binding to be present on the
 *   view. Without one, `saveSelection` returns null and `restoreSelection`
 *   returns false. The pre-1g.7 `createRelativePositionFromTypeIndex`
 *   fallback was removed from `relpos-selection.js` because it anchored
 *   against the fragment's child slots instead of PM offsets, producing
 *   silently wrong positions.
 */

import { ySyncPluginKey } from 'y-prosemirror';
import {
  saveSelection as saveSelectionRaw,
  restoreSelection as restoreSelectionRaw,
} from './pm-plugins/relpos-selection.js';

/**
 * Pull the y-prosemirror binding out of an EditorView's plugin state.
 * Returns null when the view isn't constructed with ySyncPlugin, when the
 * binding hasn't initialized yet, or when the view is mid-tear-down.
 */
function getBinding(view) {
  if (!view || !view.state) return null;
  try {
    const pluginState = ySyncPluginKey.getState(view.state);
    if (!pluginState) return null;
    // y-prosemirror's binding object exposes `.mapping` and `.type` (the
    // Y.XmlFragment it's bound to). Existence of `.mapping` is the load-
    // bearing check — that's what `relativePositionToAbsolutePosition`
    // walks.
    if (!pluginState.binding || typeof pluginState.binding.mapping === 'undefined') {
      return null;
    }
    return pluginState.binding;
  } catch {
    return null;
  }
}

/**
 * Read the block id from a view's root DOM element. Used to stamp saved
 * selections so a cross-block restore can refuse rather than silently
 * land at the wrong position. PmEditableBlock sets `data-block-id` on
 * the EditorProps.attributes; legacy and PM both honor this.
 */
function getBlockId(view) {
  if (!view || !view.dom) return null;
  const id = view.dom.getAttribute && view.dom.getAttribute('data-block-id');
  return id || null;
}

/**
 * Save the current PM selection as a Y.RelativePosition tuple.
 *
 * Returns `{ blockId, relAnchor, relHead }` on success, or null when:
 *   - view is missing or destroyed
 *   - no y-prosemirror binding is present (pre-mount race or non-collab view)
 *   - state.selection is null (defensive)
 *   - getRelativeSelection throws (mid-sync race)
 *
 * The returned object is opaque — callers should treat it as a token to
 * pass back to restoreSelection. Do not introspect the relAnchor / relHead
 * fields; they are y-prosemirror RelativePosition objects whose shape may
 * evolve.
 */
export function saveSelection(view) {
  if (!view) return null;
  const binding = getBinding(view);
  if (!binding) return null;
  // binding.type is the Y.XmlFragment this view is bound to.
  const yXmlFragment = binding.type;
  if (!yXmlFragment) return null;
  const blockId = getBlockId(view);
  return saveSelectionRaw({
    blockId: blockId || '__no-block-id__',
    view,
    yXmlFragment,
    binding,
  });
}

/**
 * Restore a saved selection into the given EditorView.
 *
 * Returns true on success, false on any of:
 *   - saved is null/missing
 *   - view is missing or destroyed
 *   - no y-prosemirror binding is present
 *   - cross-fragment mismatch (saved.blockId doesn't match view's blockId —
 *     guards the documented "Y.RelativePosition is per-fragment" limitation)
 *   - relpos can't be resolved (e.g. the anchored text is gone)
 *
 * On cross-block mismatch, returns false BEFORE attempting the conversion —
 * fail-closed protects against the silent wrong-position outcome.
 */
export function restoreSelection(view, saved) {
  if (!saved || !view) return false;
  const binding = getBinding(view);
  if (!binding) return false;
  const yXmlFragment = binding.type;
  if (!yXmlFragment) return false;
  const ydoc = yXmlFragment.doc;
  if (!ydoc) return false;
  // Cross-fragment guard: refuse to restore into a different block than
  // the one the selection was saved from. The sentinel '__no-block-id__'
  // matches itself (used when neither view exposes data-block-id, e.g.
  // unit tests that don't set the attribute).
  const currentBlockId = getBlockId(view) || '__no-block-id__';
  if (saved.blockId && saved.blockId !== currentBlockId) return false;
  return restoreSelectionRaw({ saved, view, ydoc, yXmlFragment, binding });
}
