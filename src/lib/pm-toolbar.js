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
 * attr) and revision* (authorId + authorColor attrs) require attr-
 * discrimination: a "RID" toggle must not strip an overlapping "SRF" mark,
 * and a user-A "Mark as Addition" must not strip user-B's existing ADD
 * mark in the same range. See the design spec at
 * docs/superpowers/specs/2026-05-11-pm-editor-1f.9-floating-toolbar-design.md
 * for the full multi-author safety rationale.
 *
 * Sub-PR 1g.6 (#87): the single `revision` MarkType is split into
 * revisionAdd / revisionDel / revisionChg. Verbs dispatch by MarkType
 * derived from the `kind` argument; the resolve verb tries all three
 * MarkTypes in declared order at the cursor and operates on the first
 * one with a range. Toggle-off semantics shift slightly — under
 * `excludes: ''` (1g.6 schema) two same-MarkType marks with different
 * attrs coexist instead of replacing each other, so the safety check
 * `rangeAllHaveMarkWithAttrs(...)` is what gates removal.
 */

import { REVISION_MARK_TYPE_NAMES } from './pm-schema.js';

// Order matters — applyInlineRevisionResolveTr tries these in declared
// rank order. The first MarkType with a range at the cursor wins.
const REVISION_KINDS_IN_ORDER = Object.freeze(['add', 'del', 'chg']);

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
 * Apply or toggle a revision mark (ADD/DEL/CHG) over the selection.
 *
 * 1g.6 (#87) — dispatches to the specific MarkType (revisionAdd /
 * revisionDel / revisionChg) derived from `kind`. The MarkType is the
 * audit-trail distinction: applying an ADD does NOT remove a coexisting
 * DEL on the same range; the schema's `excludes: ''` lets them coexist.
 *
 * Multi-author safety: toggle off only if EVERY text node in the range
 * carries a revision of the requested MarkType AND the current user's
 * authorId. Otherwise apply a fresh revision mark with the current author.
 * Under `excludes: ''`, two same-MarkType marks with different attrs
 * coexist — the toggle-off check is what prevents Alice's mark from
 * surviving when Bob tries to remove HIS mark in the same range.
 *
 * Legacy applyRevision (FloatingToolbar.jsx) uses closest('ins.mark-add')
 * without an author check, which can strip another user's mark. The PM
 * path declines to reproduce that latent bug.
 *
 * Returns null on collapsed selection or unknown kind.
 */
export function applyRevisionTr(state, kind, authorAttrs) {
  const { from, to, empty } = state.selection;
  if (empty) return null;
  const markTypeName = REVISION_MARK_TYPE_NAMES[kind];
  if (!markTypeName) return null;
  const markType = state.schema.marks[markTypeName];
  if (!markType) return null;
  const currentAuthorId = authorAttrs?.authorId ?? null;
  const matchesMine = (a) => a.authorId === currentAuthorId;

  const allMine = rangeAllHaveMarkWithAttrs(state.doc, from, to, markType, matchesMine);
  if (allMine) {
    const sample = findFirstMatchingMark(state.doc, from, to, markType, matchesMine);
    if (sample) return state.tr.removeMark(from, to, sample);
  }
  return state.tr.addMark(from, to, markType.create({
    authorId: currentAuthorId,
    authorColor: authorAttrs?.authorColor ?? null,
  }));
}

/**
 * Resolve the revision mark at the cursor: accept ADD (strip mark, keep
 * content), reject ADD (delete range), accept DEL (delete range), reject
 * DEL (strip mark, keep content). After the resolution, clears stored
 * marks so the next keystroke doesn't inherit the (now-removed) revision.
 *
 * 1g.6 (#87) — tries each of revisionAdd / revisionDel / revisionChg in
 * declared rank order at the resolved position. The first MarkType with a
 * range at the position wins. This matches the implicit pre-split
 * behavior: with a single `revision` MarkType, findMarkRangeAt returned
 * the one mark at the cursor. With three MarkTypes that can coexist, the
 * caller hasn't told us which to resolve — we default to outermost-first
 * (Add → Del → Chg). When the user clicks specifically on an <ins> or
 * <del> popup, the caller can constrain via the `kindHint` parameter.
 *
 * @param state EditorState
 * @param action 'accept' | 'reject'
 * @param pos? Number — overrides state.selection.from
 * @param kindHint? 'add' | 'del' | 'chg' — constrain the resolution to a
 *   specific kind. Omitted for cursor-based toolbar resolution; supplied
 *   for the del-popup path where the click target identifies the kind.
 *
 * Returns null when no revision mark is at the resolved position.
 */
export function applyInlineRevisionResolveTr(state, action, pos, kindHint) {
  const cursor = pos != null ? pos : state.selection.from;
  const kindsToTry = kindHint != null ? [kindHint] : REVISION_KINDS_IN_ORDER;

  let kind = null;
  let range = null;
  for (const k of kindsToTry) {
    const markTypeName = REVISION_MARK_TYPE_NAMES[k];
    if (!markTypeName) continue;
    const markType = state.schema.marks[markTypeName];
    if (!markType) continue;
    const r = findMarkRangeAt(state.doc, cursor, markType, () => true);
    if (r) {
      kind = k;
      range = r;
      break;
    }
  }
  if (!range) return null;

  let tr;
  if ((action === 'accept' && kind === 'add')
      || (action === 'reject' && kind === 'del')) {
    // Strip mark, keep content.
    tr = state.tr.removeMark(range.from, range.to, range.mark);
  } else if ((action === 'reject' && kind === 'add')
      || (action === 'accept' && kind === 'del')) {
    // Delete range.
    tr = state.tr.delete(range.from, range.to);
  } else if (kind === 'chg') {
    // CHG: accept strips the mark (treats the changed text as final);
    // reject strips the mark (treats the change as withdrawn). Either way
    // the content stays — CHG is a record of "this was changed", not a
    // pending replacement. Matches the legacy 1f.9 behavior, which simply
    // returned null for chg (chg wasn't supported); the new path is more
    // permissive but stays content-preserving.
    tr = state.tr.removeMark(range.from, range.to, range.mark);
  } else {
    return null;
  }
  return tr.setStoredMarks([]);
}

/**
 * Add a `comment` mark over the selection (issue #64 resolution).
 *
 * Unlike inlineMark / revision, comment is purely additive at the toolbar:
 * the user clicks the comment span to open a popup for resolve/delete (no
 * toggle-off via the toolbar). Each invocation creates a new comment with
 * a unique id supplied by the caller.
 *
 * Under the schema's default `excludes: '_'`, applying a comment over a
 * range that already has a different comment will replace it. That edge
 * case is rare in practice (the user clicks the existing comment span to
 * manage it). Cleaner than the legacy `range.surroundContents` path which
 * either throws or produces nested mark-comment spans on overlap.
 *
 * Issue #64 history: the carve-out for this verb was based on a
 * misdiagnosis that y-prosemirror's prosemirrorToYXmlFragment dropped the
 * `comment` mark. Verified empirically: the mark survives the diff-and-
 * merge round-trip. The actual failure that triggered the issue was a
 * Playwright test using legacy `el.innerHTML` injection in PM mode (PM's
 * domObserver doesn't reliably handle wholesale innerHTML replacement);
 * unrelated to mark-attribute serialization. Pinned by pmdoc-html.test.js.
 *
 * Returns null on collapsed selection.
 */
export function applyCommentMarkTr(state, commentId) {
  const { from, to, empty } = state.selection;
  if (empty) return null;
  if (typeof commentId !== 'string' || !commentId) return null;
  const markType = state.schema.marks.comment;
  if (!markType) return null;
  return state.tr.addMark(from, to, markType.create({ id: commentId, resolved: false }));
}

/**
 * Change-case cycle on the selected text: UPPER → lower → Title → UPPER.
 * Mirrors the legacy FloatingToolbar.changeCase logic. Marks on the
 * replaced range are dropped (the inserted text node carries no marks) —
 * matches legacy `range.deleteContents()` behavior. Pinned by the
 * marks-dropped test in pm-toolbar.test.js.
 *
 * Returns null on collapsed or empty-text selection.
 */
export function applyChangeCaseTr(state) {
  const { from, to, empty } = state.selection;
  if (empty) return null;
  const text = state.doc.textBetween(from, to, '\n', '');
  if (!text) return null;
  let newText;
  if (text === text.toUpperCase()) {
    newText = text.toLowerCase();
  } else if (text === text.toLowerCase()) {
    newText = text.replace(/\b\w/g, (c) => c.toUpperCase());
  } else {
    newText = text.toUpperCase();
  }
  return state.tr.replaceWith(from, to, state.schema.text(newText));
}
