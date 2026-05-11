/**
 * pm-del-popup.js — Pure HTML mutator for the Track Changes del-popup
 * accept/reject actions in PM mode (sub-PR 1f.8, issue #47).
 *
 * The PM blur handler already uses an HTML round-trip seam to materialize
 * inline revision marks (`PmEditableBlock.jsx:303-334`). This mutator runs
 * on the same seam: the caller serializes the live PM doc via
 * `pmFragmentToHtml`, identifies which del element the user clicked by
 * its index among `view.dom.querySelectorAll('del.mark-del')`, runs this
 * function, then routes the result through `onRevisionAction` so App's
 * `setBlockHtml` writes the substrate with origin 'local-publish'
 * (UndoManager coverage) and `tc.applyResolveAtBlock` refreshes the TC
 * snapshot.
 *
 * Identifying the del by index — not by mark equality — is intentional:
 * adjacent del marks with different authorIds render as separate
 * <del class="mark-del"> elements (PM compares marks by type+attrs),
 * and the DOM boundaries are explicit. Mark-equality walks would conflate
 * them; index-by-DOM-order doesn't.
 */

export function applyDelAction(html, delIndex, action) {
  if (!html) return html;
  if (action !== 'accept' && action !== 'reject') return html;

  const parser = new DOMParser();
  const doc = parser.parseFromString(
    `<div id="pm-del-popup-root">${html}</div>`,
    'text/html',
  );
  const root = doc.getElementById('pm-del-popup-root');
  if (!root) return html;

  const dels = root.querySelectorAll('del.mark-del');
  if (delIndex < 0 || delIndex >= dels.length) return html;

  const del = dels[delIndex];
  if (action === 'accept') {
    del.remove();
  } else {
    del.replaceWith(doc.createTextNode(del.textContent));
  }
  return root.innerHTML;
}
