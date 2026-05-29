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
 *
 * @param {import('prosemirror-state').EditorState} state
 * @param {number} pos - document position of the right-click
 * @param {{ blockId: string, readOnly: boolean }} opts
 * @returns {null | { blockId: string, kind: 'pm', pos: number,
 *   selectionEmpty: boolean, readOnly: boolean,
 *   revision?: { kind: 'add'|'del'|'chg', range: { from: number, to: number } },
 *   comment?: { commentId: string, range: { from: number, to: number }, resolved: boolean },
 *   addCommentRange?: { from: number, to: number } }}
 */

import { REVISION_MARK_TYPE_NAMES } from './pm-schema.js';
import { findMarkRangeAt, REVISION_KINDS_IN_ORDER } from './pm-toolbar.js';

export function resolvePmContextAt(state, pos, { blockId, readOnly }) {
  if (!state) return null;
  const { from, to, empty } = state.selection;
  const desc = {
    blockId, kind: 'pm', pos,
    selectionEmpty: empty, readOnly: !!readOnly,
  };
  if (readOnly) return desc;

  const schema = state.schema;
  for (const k of REVISION_KINDS_IN_ORDER) {
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
