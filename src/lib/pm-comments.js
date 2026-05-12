/**
 * pm-comments.js — Substrate-side comment reconciliation (sub-PR 1g, issue #47).
 *
 * `reconcileCommentMarks` is a pure verb that compares PM `comment` marks
 * in `state.doc` against the canonical `commentsState.byId`. For each
 * disagreement it builds a transaction that either removes the mark
 * (orphan: id ∉ byId) or removes + re-adds with corrected `resolved` attr
 * (status flip). Returns null when the doc already agrees with state — so
 * receiving peers (whose substrate is already correct via the originator's
 * ySyncPlugin op) dispatch no work.
 *
 * The returned tr is tagged with `COMMENT_RECONCILE_META`. PmEditableBlock's
 * `dispatchTransaction` reads this meta and skips both the synthesized
 * 'input' event (no linter re-run for mark-only changes) and the `onUpdate`
 * debounce (no setBlockHtml echo via the 'local-publish' origin — see
 * `src/lib/__tests__/setblockhtml-echo-behavior.test.js` for the empirical
 * basis of that gate).
 *
 * Walks text nodes end → start so each tr.removeMark/addMark doesn't shift
 * positions of unprocessed ranges. Uses mark INSTANCE (not markType) in
 * removeMark so adjacent comment marks with different ids are preserved.
 */

// Sentinel object exported from this module. Identity-compared in
// PmEditableBlock's dispatchTransaction via tr.getMeta(COMMENT_RECONCILE_META).
export const COMMENT_RECONCILE_META = {};

export function reconcileCommentMarks(state, commentsState) {
  const commentMarkType = state.schema.marks.comment;
  if (!commentMarkType) return null;
  const byId = commentsState?.byId;
  if (!(byId instanceof Map)) return null;

  // Collect ranges first so iteration uses indices that survive splicing.
  const ranges = [];
  state.doc.descendants((node, pos) => {
    if (!node.isText) return true;
    for (const m of node.marks) {
      if (m.type !== commentMarkType) continue;
      ranges.push({ from: pos, to: pos + node.nodeSize, mark: m });
    }
    return true;
  });

  let tr = state.tr;
  let dirty = false;
  for (let i = ranges.length - 1; i >= 0; i--) {
    const { from, to, mark } = ranges[i];
    const comment = byId.get(mark.attrs.id);
    if (!comment) {
      tr = tr.removeMark(from, to, mark);
      dirty = true;
      continue;
    }
    const wantResolved = comment.status === 'resolved';
    if (mark.attrs.resolved !== wantResolved) {
      tr = tr
        .removeMark(from, to, mark)
        .addMark(from, to, commentMarkType.create({ id: mark.attrs.id, resolved: wantResolved }));
      dirty = true;
    }
  }

  if (!dirty) return null;
  return tr.setMeta(COMMENT_RECONCILE_META, true);
}
