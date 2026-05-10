/**
 * Compliance range computation.
 *
 * Pure helper that walks a block's DOM and returns text-node + offset
 * tuples for every word-bounded match of a violation's literal `match`
 * string. The App-level compliance highlight effect (App.jsx) feeds these
 * tuples into `Range` objects and pushes them through the CSS Custom
 * Highlight API as `CSS.highlights.set('compliance-active', ...)`.
 *
 * Sub-PR 1f (#47) replaced the previous `<span class="compliance-highlight">`
 * injection model with `CSS.highlights`, matching the linting tier-effect
 * pattern in App.jsx (compliance-error / grammar-error / passive-voice).
 * The DOM-mutation API (injectHighlightSpans / clearHighlightSpans /
 * applyGroupHighlights / findFirstHighlightInBlock) is gone — Range objects
 * survive PM's view re-renders without the old isPmOwnedDom skip.
 *
 * Word-boundary aware: the literal "contract" does not match inside
 * "Contractor". Skips text inside <del class="mark-del"> (TC deletions).
 */

const TEXT_NODE = 3;
const ELEMENT_NODE = 1;

/**
 * Find one highlight target per text node per match in `blockEl`.
 *
 * @param {Element} blockEl - root element to walk
 * @param {string} match - the violation's match text (case-insensitive compare)
 * @returns {Array<{ textNode: Text, startOffset: number, length: number }>}
 */
export function findHighlightTargetsInBlock(blockEl, match) {
  if (!blockEl || !match) return [];
  const matchLower = match.toLowerCase();
  const targets = [];
  walkTextNodes(blockEl, (textNode) => {
    if (insideSkippedAncestor(textNode)) return;
    const text = (textNode.textContent || '').toLowerCase();
    let from = 0;
    let idx;
    while ((idx = text.indexOf(matchLower, from)) >= 0) {
      const charBefore = idx > 0 ? text[idx - 1] : '';
      const charAfter =
        idx + matchLower.length < text.length ? text[idx + matchLower.length] : '';
      const okBefore = !charBefore || !/[a-z]/i.test(charBefore);
      const okAfter = !charAfter || !/[a-z]/i.test(charAfter);
      if (okBefore && okAfter) {
        targets.push({ textNode, startOffset: idx, length: match.length });
        return; // one highlight per text node per violation
      }
      from = idx + 1;
    }
  });
  return targets;
}

function walkTextNodes(root, visit) {
  for (let n = root.firstChild; n; n = n.nextSibling) {
    if (n.nodeType === TEXT_NODE) {
      visit(n);
    } else if (n.nodeType === ELEMENT_NODE) {
      walkTextNodes(n, visit);
    }
  }
}

function insideSkippedAncestor(textNode) {
  let p = textNode.parentNode;
  while (p && p.nodeType === ELEMENT_NODE) {
    if (
      p.tagName === 'DEL' &&
      p.classList &&
      p.classList.contains('mark-del')
    ) {
      return true;
    }
    p = p.parentNode;
  }
  return false;
}
