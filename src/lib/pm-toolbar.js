/**
 * pm-toolbar.js — PM toolbar verbs + dispatcher for FloatingToolbar
 * (sub-PR 1f.9, issue #47; dispatcher consolidation 2026-05-19).
 *
 * Two layers in one file:
 *
 *   1. **Verbs** (`applyFormatTr` / `applyInlineMarkTr` / `applyRevisionTr`
 *      / `applyInlineRevisionResolveTr` / `applyChangeCaseTr` /
 *      `applyCommentMarkTr`). Pure. Each takes an EditorState + parameters
 *      and returns a `VerbResult` (`{ tr, settlement, range }`) or null.
 *      Never touch DOM, never read window selection, never dispatch.
 *
 *   2. **Dispatcher** (`dispatchToolbarVerb`). Side-effectful. Owns the
 *      protocol: restore Y.RelativePosition-saved selection -> close prior
 *      UndoManager frame -> view.dispatch(tr) -> snapshot view.state ->
 *      flush or cancel the per-block debounce per the verb's settlement.
 *      Returns `{ dispatched, blockId, state, range }` to the caller.
 *
 *   3. **Extractors** (`extractHtml` / `extractRangeText`). Pure helpers
 *      colocated with the verbs that produce ranges they operate over.
 *      Read a PM EditorState snapshot. PM imports (pmFragmentToHtml,
 *      textBetween) stay in this module — callers (FloatingToolbar) never
 *      touch PM internals.
 *
 * Mirrors the in-file pattern established by `pm-del-popup.js` (verb +
 * dispatch helper in one module). The split-file alternative was rejected
 * because it would orphan a "pm-toolbar-dispatch.js" sibling while
 * `pm-del-popup.js` keeps its dispatch in-file.
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
 *
 * ## VerbResult shape (2026-05-19 dispatcher refactor)
 *
 *   `{ tr: Transaction, settlement: 'self' | 'caller-owned', range: {from, to} }`
 *
 * - `settlement: 'self'` — dispatcher calls `flushPendingUpdateById(blockId)`
 *   after dispatch. The verb's PM op produces a substrate change whose React-
 *   state mirror flows through PmEditableBlock's debounced `onUpdate`; flushing
 *   collapses the 400ms window so React state reflects the new html
 *   synchronously. Used by format/inline-mark/revision-apply/change-case/
 *   comment-create.
 * - `settlement: 'caller-owned'` — dispatcher calls `cancelPendingUpdateById`.
 *   The caller will issue its own setBlocks via a post-dispatch callback
 *   (e.g. `onRefreshTcSnapshot`), so the debounce must be cancelled to prevent
 *   a 400ms-later setBlocks from clobbering the caller's already-settled
 *   snapshot. Used by accept-inline (revision-resolve).
 * - `range` — the pre-dispatch (verb-determined for resolve) selection range
 *   the verb operated on. Exposed to callers via the dispatcher's return so
 *   extractors (`extractRangeText`) can read text by index post-dispatch.
 *   For verbs that don't change document length (add/remove mark), this is
 *   the original selection; for resolve, it's the mark's extent walked by
 *   `findMarkRangeAt`.
 */

import { REVISION_MARK_TYPE_NAMES } from './pm-schema.js';
import { TC_RESOLVE_META } from './pm-tc-mark.js';
import { pmFragmentToHtml } from './pmdoc-html.js';
import {
  flushPendingUpdateById,
  cancelPendingUpdateById,
} from './block-registry.js';
import { restoreSelection as restorePmRelpos } from './pm-relpos.js';

// Order matters — applyInlineRevisionResolveTr tries these in declared
// rank order. The first MarkType with a range at the cursor wins.
export const REVISION_KINDS_IN_ORDER = Object.freeze(['add', 'del', 'chg']);

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
 * Otherwise returns a VerbResult with `settlement: 'self'`.
 */
export function applyFormatTr(state, kind) {
  const { from, to, empty } = state.selection;
  if (empty) return null;
  const markType = state.schema.marks[kind];
  if (!markType) return null;
  const existing = findFirstMatchingMark(state.doc, from, to, markType, () => true);
  const tr = existing
    ? state.tr.removeMark(from, to, markType)
    : state.tr.addMark(from, to, markType.create());
  return { tr, settlement: 'self', range: { from, to } };
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
  let tr;
  if (existing) {
    tr = state.tr.removeMark(from, to, existing);
  } else {
    const attrs = {
      kind,
      option: kind === 'tai' ? (optionAttr ?? null) : null,
    };
    tr = state.tr.addMark(from, to, markType.create(attrs));
  }
  return { tr, settlement: 'self', range: { from, to } };
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
 * Issue #97 — `trackChanges` gate (4th arg). Post-1h Q33 (#94), the per-
 * keystroke marking pipeline wraps every typed character in revisionAdd
 * immediately in `dispatchTransaction`. The legacy toggle-off path then
 * mis-fires: a user selects their just-typed text, clicks "Mark as
 * Addition", and the range — already entirely their own revisionAdd —
 * triggers the toggle-off branch, stripping the marks. The TC gate
 * suppresses toggle-off (returns null) when TC is on AND the range is
 * already entirely the current user's mark: the toolbar verb becomes
 * purely additive in TC mode, since per-keystroke marking owns the
 * removal side via accept/reject. Defaults to false; out-of-TC mode and
 * legacy callers (3-arg form, including the existing toggle-off unit
 * test) are unaffected.
 *
 * Returns null on collapsed selection, unknown kind, OR — in TC mode —
 * when the range is already entirely the current user's mark of the
 * requested kind.
 */
export function applyRevisionTr(state, kind, authorAttrs, trackChanges = false) {
  const { from, to, empty } = state.selection;
  if (empty) return null;
  const markTypeName = REVISION_MARK_TYPE_NAMES[kind];
  if (!markTypeName) return null;
  const markType = state.schema.marks[markTypeName];
  if (!markType) return null;
  const currentAuthorId = authorAttrs?.authorId ?? null;
  const matchesMine = (a) => a.authorId === currentAuthorId;

  const allMine = rangeAllHaveMarkWithAttrs(state.doc, from, to, markType, matchesMine);
  let tr = null;
  if (allMine) {
    if (trackChanges) return null; // per-keystroke marking already owns this range
    const sample = findFirstMatchingMark(state.doc, from, to, markType, matchesMine);
    if (sample) tr = state.tr.removeMark(from, to, sample);
  }
  if (!tr) {
    tr = state.tr.addMark(from, to, markType.create({
      authorId: currentAuthorId,
      authorColor: authorAttrs?.authorColor ?? null,
    }));
  }
  return { tr, settlement: 'self', range: { from, to } };
}

/**
 * Resolve the revision mark at the cursor (or at the optional `pos`
 * override): accept ADD (strip mark, keep content), reject ADD (delete
 * range), accept DEL (delete range), reject DEL (strip mark, keep
 * content). After the resolution, clears stored marks so the next
 * keystroke doesn't inherit the (now-removed) revision.
 *
 * 1g.5 (#86) introduced the optional `pos` argument for the PM del-popup
 * path. The popup's click handler suppresses caret placement (returns
 * true from handleClick), so state.selection isn't on the del when
 * accept/reject fires. The caller resolves a DOM-relative position via
 * view.posAtDOM and passes it here. The FloatingToolbar caller omits
 * `pos` and the function falls back to state.selection.from.
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
  // Every tr this verb builds resolves an EXISTING revision mark, so tag it
  // with TC_RESOLVE_META here rather than at each caller. Without the meta,
  // the delete-range branches (accept-del, reject-add) dispatch a plain
  // tr.delete over an already-marked range and rewriteForTrackChanges
  // re-classifies it as a fresh user edit — accept-del no-ops (issue #96)
  // and reject-add wraps a peer's revisionAdd in revisionDel instead of
  // deleting it. The mark-stripping branches don't strictly need the gate
  // (the rewriter ignores non-text-changing trs), but carrying it uniformly
  // keeps the invariant in the verb.
  tr.setMeta(TC_RESOLVE_META, true);
  return {
    tr: tr.setStoredMarks([]),
    settlement: 'caller-owned',
    range: { from: range.from, to: range.to },
  };
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
  const tr = state.tr.addMark(from, to, markType.create({ id: commentId, resolved: false }));
  return { tr, settlement: 'self', range: { from, to } };
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
  const tr = state.tr.replaceWith(from, to, state.schema.text(newText));
  return { tr, settlement: 'self', range: { from, to } };
}

// ---------------------------------------------------------------------------
// Dispatcher (2026-05-19 refactor — issue #100 follow-up). Owns the post-PM-
// dispatch coordination protocol shared by every FloatingToolbar PM verb.
//
// Pre-refactor: FloatingToolbar.jsx repeated this 7 times across 5 callbacks
// (applyMark / applyRevision / changeCase / handleInlineRevisionAction /
// applyFormat / comment-create), with a one-line variation between flush vs
// cancel:
//
//   restoreSavedRelpos(view, saved);
//   const tr = applyXxxTr(view.state, ...);
//   if (tr) {
//     onForceFrame?.();
//     view.dispatch(tr);
//     if (!__isFlushOverridden?.()) flushPendingUpdateById(blockId);
//     // ... or cancelPendingUpdateById for accept-inline
//   }
//   setVisible(false);
//
// The deletion test for `flushPendingUpdateById` / `cancelPendingUpdateById`
// concentrates complexity here: settlement is a property of the verb's
// effect intent (does the action also issue its own React-side setBlocks?),
// so colocating settlement with the verb (in the VerbResult descriptor)
// and centralizing the dispatch + settlement choice in this function keeps
// every callsite of FloatingToolbar to a single line.
//
// The `__overrideFlush` window test seam was retired with this refactor —
// grep confirmed zero test consumers; the seam was documented but never
// wired. ---------------------------------------------------------------------

/**
 * Dispatch a toolbar verb against an EditorView, honoring the verb's
 * settlement contract.
 *
 * Sequence:
 *   1. If `view` or `saved` is null, bail with `{ dispatched: false }`.
 *   2. Restore the Y.RelativePosition saved on `saved` (no-op if missing /
 *      cross-block / pre-1g.7 caller). MUST happen before `compute(...)`
 *      because most verbs build their tr from `state.selection`; computing
 *      pre-restore would mark/replace the wrong range when a peer's edit
 *      landed between toolbar open and click.
 *   3. Call `compute(view.state)` to derive the VerbResult against the
 *      relpos-corrected state. When the verb declines (collapsed selection,
 *      unknown kind, allMine-in-TC-mode, etc.) it returns null and the
 *      dispatcher bails.
 *   4. Invoke `onForceFrame?.()` so the Yjs UndoManager closes the prior
 *      capture window — the verb's PM op enters a fresh undo frame, not
 *      the user's preceding typing burst.
 *   5. view.dispatch(tr).
 *   6. Snapshot view.state IMMEDIATELY (PM EditorStates are immutable, so
 *      this reference is frozen — no peer-op race when callers read it
 *      asynchronously).
 *   7. Honor the verb's settlement: 'self' -> flushPendingUpdateById,
 *      'caller-owned' -> cancelPendingUpdateById.
 *
 * Returns `{ dispatched: false }` when nothing ran (null view, null saved,
 * or verb returned null), or `{ dispatched: true, blockId, state, range }`
 * after successful dispatch. Callers read `state` (a frozen post-dispatch
 * EditorState) for any post-dispatch extracts via `extractHtml` /
 * `extractRangeText` below.
 *
 * @param {Object} params
 * @param {import('prosemirror-view').EditorView | null} params.view
 * @param {Object | null} params.saved
 *   The selectionRef value from FloatingToolbar — carries `blockId` and
 *   optional `savedRelpos` (Y.RelativePosition). When null, bails.
 * @param {(state: import('prosemirror-state').EditorState) => Object | null} params.compute
 *   Called with the relpos-corrected EditorState. Returns a VerbResult
 *   (`{ tr, settlement, range }`) or null. Typical body:
 *   `(state) => applyFormatTr(state, kind)`.
 * @param {() => void} [params.onForceFrame]
 *   Optional UndoManager frame-closer. Production wiring: App passes
 *   `inRoom ? collab.forceFrame : localUndo.forceFrame`. Tests can omit.
 *
 * @returns {{ dispatched: false } | {
 *   dispatched: true,
 *   blockId: string,
 *   state: import('prosemirror-state').EditorState,
 *   range: { from: number, to: number },
 * }}
 */
export function dispatchToolbarVerb({ view, saved, compute, onForceFrame }) {
  if (!view || !saved) return { dispatched: false };
  if (typeof compute !== 'function') return { dispatched: false };

  const { blockId, savedRelpos } = saved;
  if (savedRelpos) {
    try { restorePmRelpos(view, savedRelpos); }
    catch { /* defensive — fall back to view.state.selection unchanged */ }
  }

  const verbResult = compute(view.state);
  if (!verbResult) return { dispatched: false };

  if (typeof onForceFrame === 'function') onForceFrame();
  view.dispatch(verbResult.tr);

  const stateAfter = view.state;

  if (verbResult.settlement === 'caller-owned') {
    cancelPendingUpdateById(blockId);
  } else {
    flushPendingUpdateById(blockId);
  }

  return {
    dispatched: true,
    blockId,
    state: stateAfter,
    range: verbResult.range,
  };
}

// ---------------------------------------------------------------------------
// Extractors — pure helpers that read a PM EditorState snapshot. Colocated
// with the verbs so PM serialization concerns (pmFragmentToHtml,
// textBetween) stay in this module instead of leaking back into
// FloatingToolbar. Callers use the dispatcher's returned `state` + `range`.
// ---------------------------------------------------------------------------

/** Serialize the doc of a post-dispatch EditorState to html. */
export function extractHtml(state) {
  return pmFragmentToHtml(state.doc);
}

/**
 * Read plain text for a verb's operated-on range from a post-dispatch
 * EditorState. Honors PM's `textBetween` newline behavior (single '\n'
 * between blocks, empty string for inline-leaf separators).
 *
 * Used by comment-create to derive the highlightText for the comments
 * envelope from the snapshot the dispatcher returned, without the caller
 * touching PM internals.
 */
export function extractRangeText(state, range) {
  return state.doc.textBetween(range.from, range.to, '\n', '');
}
