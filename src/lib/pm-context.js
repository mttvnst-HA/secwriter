/**
 * pm-context.js - pure resolver that maps a PM EditorState + document
 * position to a context descriptor for the right-click context menu.
 *
 * Kept pure (no view, no DOM) so it is unit-testable without mounting an
 * EditorView. PmEditableBlock's `getContextAtCoords` handle resolves the
 * position via `view.posAtCoords` then delegates here.
 *
 * Read-only short-circuits before mark resolution: in a read-only room the
 * menu is copy-only, so revision/comment/add-comment items never apply.
 */

import { REVISION_MARK_TYPE_NAMES } from './pm-schema.js';
import { findMarkRangeAt } from './pm-toolbar.js';

const REVISION_KINDS = ['add', 'del', 'chg'];

export function resolvePmContextAt(state, pos, { blockId, readOnly }) {
  if (!state) return null;
  const { from, to, empty } = state.selection;
  const desc = {
    blockId, kind: 'pm', pos,
    selectionEmpty: empty, readOnly: !!readOnly,
  };
  if (readOnly) return desc;

  const schema = state.schema;
  for (const k of REVISION_KINDS) {
    const markType = schema.marks[REVISION_MARK_TYPE_NAMES[k]];
    if (!markType) continue;
    const r = findMarkRangeAt(state.doc, pos, markType, () => true);
    if (r) { desc.revision = { kind: k, range: { from: r.from, to: r.to } }; break; }
  }

  const commentType = schema.marks.comment;
  if (commentType) {
    const cr = findMarkRangeAt(state.doc, pos, commentType, () => true);
    if (cr) {
      desc.comment = {
        commentId: cr.mark.attrs.id,
        range: { from: cr.from, to: cr.to },
        resolved: !!cr.mark.attrs.resolved,
      };
    }
  }

  if (!empty && pos >= from && pos <= to) {
    desc.addCommentRange = { from, to };
  }
  return desc;
}
