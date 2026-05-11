/**
 * pm-toolbar.js — Pure transaction builders for FloatingToolbar's PM path
 * (sub-PR 1f.9, issue #47).
 *
 * Each verb takes an EditorState + parameters and returns a Transaction or
 * null. Never touches DOM, never reads window selection, never dispatches.
 * The caller (FloatingToolbar in PM mode) dispatches via view.dispatch(tr).
 *
 * Two helpers replace PM's built-in rangeHasMark / toggleMark because those
 * compare by MarkType only, ignoring attrs. The schema's inlineMark (kind
 * attr) and revision (kind + authorId attrs) require attr-discrimination:
 * a "RID" toggle must not strip an overlapping "SRF" mark, and a user-A
 * "Mark as Addition" must not strip user-B's existing ADD mark in the same
 * range. See the design spec at
 * docs/superpowers/specs/2026-05-11-pm-editor-1f.9-floating-toolbar-design.md
 * for the full multi-author safety rationale.
 */

/**
 * Walk text nodes in [from, to] and return the first Mark instance whose
 * type matches `markType` and whose attrs satisfy `attrPredicate`. Returns
 * null when no text node carries a matching mark.
 *
 * Used as both presence detection ("any" semantics, like PM's stock
 * rangeHasMark) and as a way to obtain a Mark *instance* to pass to
 * tr.removeMark — passing the instance honors attr-matching, whereas
 * passing only the MarkType would strip every kind / every author.
 */
export function findFirstMatchingMark(doc, from, to, markType, attrPredicate) {
  if (from >= to) return null;
  let found = null;
  doc.nodesBetween(from, to, (node) => {
    if (found) return false; // stop walking
    if (!node.isText) return true;
    for (const m of node.marks) {
      if (m.type === markType && attrPredicate(m.attrs)) {
        found = m;
        return false;
      }
    }
    return true;
  });
  return found;
}

/**
 * Returns true iff EVERY text node in [from, to] carries at least one mark
 * matching (markType, attrPredicate). An empty range or a range that
 * contains no text nodes returns false (NOT vacuously true — this is the
 * safer semantic at the revision toggle-off call site: "don't remove
 * anything if there's nothing to act on"). Used for the revision
 * multi-author safety check: "toggle off only if all revisions in range
 * are mine".
 */
export function rangeAllHaveMarkWithAttrs(doc, from, to, markType, attrPredicate) {
  if (from >= to) return false;
  let foundAnyText = false;
  let allHave = true;
  doc.nodesBetween(from, to, (node) => {
    if (!node.isText) return true;
    foundAnyText = true;
    const has = node.marks.some((m) => m.type === markType && attrPredicate(m.attrs));
    if (!has) allHave = false;
    return true;
  });
  return foundAnyText && allHave;
}

/**
 * From a position, find the contiguous range over which a mark satisfying
 * (markType, attrPredicate) extends across the parent block's children.
 * Returns { from, to, mark } or null.
 *
 * Inclusivity: pm-schema does NOT set `inclusive: false` on revision /
 * inlineMark, so PM defaults to inclusive: true. A cursor at the immediate
 * right boundary of a mark (parentOffset === end-of-marked-text) returns
 * the mark via the *prior* child's marks. A cursor one position past the
 * boundary returns null.
 */
export function findMarkRangeAt(doc, pos, markType, attrPredicate) {
  const $pos = doc.resolve(pos);
  const parent = $pos.parent;
  if (!parent || parent.isLeaf) return null;
  const parentStart = $pos.start();

  // Find the child whose range contains $pos.parentOffset. Edge: if
  // parentOffset === parent.content.size, we treat that as "right at the
  // end of the last child" (inclusive boundary).
  let cursorChildIdx = -1;
  let cursorChildStartOffset = 0;
  let offset = 0;
  for (let i = 0; i < parent.childCount; i++) {
    const childSize = parent.child(i).nodeSize;
    const childEnd = offset + childSize;
    if ($pos.parentOffset < childEnd || (
      // Boundary case: cursor exactly at the end of the last child.
      i === parent.childCount - 1 && $pos.parentOffset === childEnd
    )) {
      cursorChildIdx = i;
      cursorChildStartOffset = offset;
      break;
    }
    offset = childEnd;
  }
  if (cursorChildIdx < 0) return null;

  // If cursor is at the right boundary of child i AND child i+1 doesn't
  // carry the mark, fall back to child i. Conversely, if cursor is right
  // at the left boundary of child i+1 and i+1 has the mark, prefer i+1.
  const cursorChild = parent.child(cursorChildIdx);
  if (!cursorChild.isText) return null;
  let targetMark = cursorChild.marks.find(
    (m) => m.type === markType && attrPredicate(m.attrs),
  );
  if (!targetMark) {
    // Boundary edge: cursor immediately AT the right edge of the prior
    // child might land us on the next child whose marks don't match.
    // Look one child back if we're at its left boundary.
    if ($pos.parentOffset === cursorChildStartOffset && cursorChildIdx > 0) {
      const prev = parent.child(cursorChildIdx - 1);
      if (prev.isText) {
        const m = prev.marks.find(
          (mk) => mk.type === markType && attrPredicate(mk.attrs),
        );
        if (m) {
          // Re-anchor to the prior child.
          cursorChildIdx -= 1;
          cursorChildStartOffset -= prev.nodeSize;
          targetMark = m;
        }
      }
    }
    if (!targetMark) return null;
  }

  // Expand outward — find all adjacent text children carrying an equal mark.
  let fromIdx = cursorChildIdx;
  let toIdx = cursorChildIdx;
  for (let i = cursorChildIdx - 1; i >= 0; i--) {
    const c = parent.child(i);
    if (!c.isText) break;
    if (!c.marks.some((m) => m.eq(targetMark))) break;
    fromIdx = i;
  }
  for (let i = cursorChildIdx + 1; i < parent.childCount; i++) {
    const c = parent.child(i);
    if (!c.isText) break;
    if (!c.marks.some((m) => m.eq(targetMark))) break;
    toIdx = i;
  }

  // Compute absolute from/to positions.
  let from = parentStart;
  for (let i = 0; i < fromIdx; i++) from += parent.child(i).nodeSize;
  let to = parentStart;
  for (let i = 0; i <= toIdx; i++) to += parent.child(i).nodeSize;

  return { from, to, mark: targetMark };
}

/**
 * Toggle a format mark (bold/italic/underline) over the selection.
 * Format marks have no attrs; toggle decision uses "any text in range has
 * the mark" semantics (matches prosemirror-commands.toggleMark).
 *
 * Returns null when the selection is collapsed or the kind is unknown.
 */
export function applyFormatTr(state, kind) {
  const { from, to, empty } = state.selection;
  if (empty) return null;
  const markType = state.schema.marks[kind];
  if (!markType) return null;
  const existing = findFirstMatchingMark(state.doc, from, to, markType, () => true);
  if (existing) {
    return state.tr.removeMark(from, to, markType);
  }
  return state.tr.addMark(from, to, markType.create());
}

/**
 * Toggle an inlineMark (rid/srf/sub/tai/...) over the selection. Attr-
 * discriminated: a RID toggle examines only RID-kind marks in the range,
 * leaving overlapping SRF/SUB marks intact. When toggling off, passes the
 * specific Mark instance to tr.removeMark so attrs match.
 *
 * The optional 3rd arg `optionAttr` is the data-opt value for `tai` marks
 * (legacy: data-opt="<region>" tailoring). Ignored for other kinds.
 */
export function applyInlineMarkTr(state, kind, optionAttr) {
  const { from, to, empty } = state.selection;
  if (empty) return null;
  const markType = state.schema.marks.inlineMark;
  if (!markType) return null;
  const existing = findFirstMatchingMark(
    state.doc, from, to, markType, (a) => a.kind === kind,
  );
  if (existing) {
    return state.tr.removeMark(from, to, existing);
  }
  const attrs = {
    kind,
    option: kind === 'tai' ? (optionAttr ?? null) : null,
  };
  return state.tr.addMark(from, to, markType.create(attrs));
}

/**
 * Apply or toggle a revision mark (ADD/DEL) over the selection.
 *
 * Multi-author safety: toggle off only if EVERY text node in the range
 * carries a revision with the requested kind AND the current user's
 * authorId. Otherwise apply a fresh revision mark with the current author.
 * Under the schema's default excludes: '_', a fresh mark replaces any
 * existing revision in the range — the safety check prevents the
 * stripping-without-replacement bug that stock rangeHasMark would cause
 * across multi-author content.
 *
 * Legacy applyRevision (FloatingToolbar.jsx) uses closest('ins.mark-add')
 * without an author check, which can strip another user's mark. The PM
 * path declines to reproduce that latent bug.
 *
 * Returns null on collapsed selection.
 */
export function applyRevisionTr(state, kind, authorAttrs) {
  const { from, to, empty } = state.selection;
  if (empty) return null;
  const markType = state.schema.marks.revision;
  if (!markType) return null;
  const currentAuthorId = authorAttrs?.authorId ?? null;
  const matchesMine = (a) => a.kind === kind && a.authorId === currentAuthorId;

  const allMine = rangeAllHaveMarkWithAttrs(state.doc, from, to, markType, matchesMine);
  if (allMine) {
    const sample = findFirstMatchingMark(state.doc, from, to, markType, matchesMine);
    if (sample) return state.tr.removeMark(from, to, sample);
  }
  return state.tr.addMark(from, to, markType.create({
    kind,
    authorId: currentAuthorId,
    authorColor: authorAttrs?.authorColor ?? null,
  }));
}
