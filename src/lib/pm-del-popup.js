/**
 * pm-del-popup.js — PM-transaction dispatcher for the Track Changes
 * del-popup accept/reject actions in PM mode (sub-PR 1g.5, issue #86).
 *
 * Replaces the 1f.8 HTML-string mutator. The earlier path serialized the
 * PM doc to HTML, mutated the string by DOM-index, then wrote back via
 * setBlockHtml('local-publish') — a snapshot-shaped write that fights
 * 1h's per-keystroke marking pipeline. The new path dispatches a PM
 * transaction directly: the substrate write rides ySyncPlugin, no
 * setBlockHtml round-trip.
 *
 * Position resolution: the click event identifies a <del class="mark-del">
 * DOM node. view.posAtDOM(el, 0) yields the PM position at the start of
 * that element. The popup is opened exclusively from a click on a <del>
 * (revisionDel), so we pass kindHint: 'del' to applyInlineRevisionResolveTr
 * (1g.6/#87) — without it, the resolver tries revisionAdd → revisionDel →
 * revisionChg in declared rank order, and a peer's revisionAdd mark
 * overlapping the same character (S3 of pm-tc-merge-semantics) would be
 * resolved instead of the del the user actually clicked.
 *
 * findMarkRangeAt (in pm-toolbar.js) expands outward by mark equality
 * (authorId + authorColor on revisionDel), so two adjacent <del> elements
 * with different authorIds are correctly distinguished even though both
 * bear the same .mark-del class — PM treats them as separate Mark
 * instances.
 *
 * Why "position, not mark equality" as the identifier: the click already
 * disambiguated by DOM element. If we walked PM marks and stopped at the
 * first matching one, we'd conflate adjacent same-attrs marks (rare in
 * practice but possible after merges). Using the click position keeps
 * the user-visible target stable.
 */

import { applyInlineRevisionResolveTr } from './pm-toolbar.js';
import { TC_RESOLVE_META } from './pm-tc-mark.js';

/**
 * Dispatch a PM transaction resolving the revisionDel mark at `delEl`.
 *
 * Returns the dispatched Transaction on success, or null if:
 *   - view/delEl missing or detached
 *   - action is not 'accept' or 'reject'
 *   - posAtDOM throws (mid-tear-down)
 *   - no revisionDel mark is found at the resolved position (idempotent
 *     re-accept on an already-resolved element)
 *
 * The caller (PmEditableBlock.handleDelAction) reads the return value
 * to decide whether to fire onRefreshTcSnapshot — a null return means
 * the transaction was a no-op and no React-state refresh is needed.
 */
export function dispatchDelAction(view, delEl, action) {
  if (!view || !delEl) return null;
  if (action !== 'accept' && action !== 'reject') return null;
  if (!view.dom.contains(delEl)) return null;
  let pos;
  try {
    pos = view.posAtDOM(delEl, 0);
  } catch {
    return null;
  }
  if (typeof pos !== 'number' || pos < 0) return null;
  // kindHint: 'del' — the popup is del-specific. Without it, a peer's
  // overlapping revisionAdd would resolve instead (Add precedes Del in
  // declared rank order).
  // The verb returns `{ tr, settlement: 'caller-owned', range }` post-2026-
  // 05-19 dispatcher refactor; unwrap to the Transaction. We don't go
  // through `dispatchToolbarVerb` here because the del-popup owns its own
  // dispatch (and tags the tr with TC_RESOLVE_META, which the dispatcher
  // doesn't know about) — the same in-file dispatch pattern as before.
  const result = applyInlineRevisionResolveTr(view.state, action, pos, 'del');
  if (!result) return null;
  const tr = result.tr;
  // Tag as a TC resolution so PmEditableBlock.dispatchTransaction skips
  // rewriteForTrackChanges. Without this gate, accept-del dispatches a
  // `tr.delete(from, to)` over a revisionDel-marked range; the rewriter
  // re-classifies the range as a fresh user delete, re-applies revisionDel,
  // and produces a no-op (issue #96). The meta is consumed in
  // PmEditableBlock; the corresponding Yjs op still flows through
  // ySyncPlugin with its normal origin.
  tr.setMeta(TC_RESOLVE_META, true);
  view.dispatch(tr);
  return tr;
}
