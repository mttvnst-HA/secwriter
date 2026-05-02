/**
 * Compliance highlight DOM helpers.
 *
 * Pure(-ish) helpers for the compliance panel's "active group" visual
 * indicator. The compute side (findHighlightTargetsInBlock) walks a DOM
 * subtree and returns text-node + offset tuples. The mutate side
 * (injectHighlightSpans, clearHighlightSpans) wraps and unwraps
 * <span class="compliance-highlight"> nodes — these are real DOM
 * mutations rather than CSS Custom Highlights because the compliance
 * highlight existed before linting moved to the Highlight API; switching
 * is tracked separately and out of scope for the panel extraction.
 *
 * Word-boundary aware: the literal "contract" does not match inside
 * "Contractor". Skips text inside <del class="mark-del"> (TC deletions)
 * and inside any existing .compliance-highlight to keep re-application
 * idempotent.
 */

export const HIGHLIGHT_CLASS = 'compliance-highlight';
export const HIGHLIGHT_SELECTOR = `.${HIGHLIGHT_CLASS}`;

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
    if (p.classList && p.classList.contains(HIGHLIGHT_CLASS)) return true;
    p = p.parentNode;
  }
  return false;
}

/**
 * Wrap each target's range in a <span class="compliance-highlight">.
 * Targets are applied in reverse order to avoid offset invalidation when
 * multiple targets share the same text node.
 */
export function injectHighlightSpans(targets) {
  if (!Array.isArray(targets) || targets.length === 0) return;
  for (let i = targets.length - 1; i >= 0; i--) {
    const t = targets[i];
    const doc = t.textNode.ownerDocument;
    if (!doc) continue;
    try {
      const range = doc.createRange();
      range.setStart(t.textNode, t.startOffset);
      range.setEnd(t.textNode, t.startOffset + t.length);
      const span = doc.createElement('span');
      span.className = HIGHLIGHT_CLASS;
      range.surroundContents(span);
    } catch {
      /* invalid range — skip */
    }
  }
}

/**
 * Remove every .compliance-highlight span under `root`, replacing each with
 * its text content and normalizing the parent. Safe to call when no
 * highlights are present.
 */
export function clearHighlightSpans(root) {
  if (!root || typeof root.querySelectorAll !== 'function') return;
  const spans = root.querySelectorAll(HIGHLIGHT_SELECTOR);
  spans.forEach((el) => {
    const parent = el.parentNode;
    if (!parent) return;
    const doc = el.ownerDocument;
    parent.replaceChild(doc.createTextNode(el.textContent || ''), el);
    if (typeof parent.normalize === 'function') parent.normalize();
  });
}

/**
 * Apply highlights for every instance of `group` inside `rootEl`.
 * Looks up each instance's block via `[data-block-id]` attribute. Returns
 * the unique block elements that received at least one highlight, in
 * document order — useful for "scroll to first highlighted block" logic.
 */
export function applyGroupHighlights(rootEl, group) {
  if (!rootEl || !group || !Array.isArray(group.instances)) return [];
  const seen = new Set();
  const blocks = [];
  for (const v of group.instances) {
    const blockEl = rootEl.querySelector(`[data-block-id="${v.blockId}"]`);
    if (!blockEl) continue;
    const targets = findHighlightTargetsInBlock(blockEl, v.match);
    if (targets.length === 0) continue;
    injectHighlightSpans(targets);
    if (!seen.has(v.blockId)) {
      seen.add(v.blockId);
      blocks.push(blockEl);
    }
  }
  return blocks;
}

/**
 * Find the first existing .compliance-highlight under `rootEl` inside the
 * block with id `blockId`. Returns the element (for `scrollIntoView`) or
 * null. Used by the panel to scroll to a clicked sentence/instance after
 * the active-group highlight pass has already run.
 */
export function findFirstHighlightInBlock(rootEl, blockId) {
  if (!rootEl || !blockId) return null;
  const block = rootEl.querySelector(`[data-block-id="${blockId}"]`);
  if (!block) return null;
  return block.querySelector(HIGHLIGHT_SELECTOR);
}
