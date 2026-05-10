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
 *
 * PM-mode caveat (sub-PR 1e, #47): when `VITE_PM_EDITOR=true`, blocks are
 * rendered by `PmEditableBlock` which hands its inner DOM to ProseMirror.
 * Direct DOM injection inside PM's owned tree is destroyed on the next
 * dispatch (PM re-renders content from `state.doc`). For PM blocks we
 * resolve the block via `block-registry.getBlockDom()` and check
 * `data-pm-editor="true"` — if present, we skip injection. A PM-native
 * `compliance-highlight` Decoration plugin is the proper fix; tracked as
 * a follow-up (1f/1g). Until then, PM mode loses the visual highlight
 * but keeps the panel's "scroll to block" behavior via `getBlockDom()`.
 */

import { getBlockDom } from './block-registry.js';

export const HIGHLIGHT_CLASS = 'compliance-highlight';
export const HIGHLIGHT_SELECTOR = `.${HIGHLIGHT_CLASS}`;

const TEXT_NODE = 3;
const ELEMENT_NODE = 1;

// PM-owned DOM is re-rendered from state.doc on every dispatch — injecting
// raw spans inside it is destructive and pointless. Skip injection for PM
// blocks (data-pm-editor="true") until a Decoration-based replacement
// lands. The block container itself (returned by getBlockDom) is fine to
// scrollIntoView on; it's the editor's contentEditable subtree that is
// off-limits for ad-hoc DOM mutation.
function isPmOwnedDom(blockEl) {
  if (!blockEl) return false;
  // Either the block container itself OR any descendant carries the marker.
  if (typeof blockEl.querySelector === 'function' && blockEl.querySelector('[data-pm-editor="true"]')) return true;
  if (typeof blockEl.matches === 'function' && blockEl.matches('[data-pm-editor="true"]')) return true;
  return false;
}

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
 * Resolves each instance's block via the App-scoped block-registry first
 * (works for both legacy contentEditable and PM EditorView mounts), then
 * falls back to a `[data-block-id]` lookup for blocks not yet registered
 * (e.g. brand-new isNew=true blocks whose mount-effect hasn't run). Returns
 * the unique block elements that received at least one highlight, in
 * document order — useful for "scroll to first highlighted block" logic.
 *
 * PM blocks are skipped for span injection (PM owns and re-renders its
 * inner DOM, which clobbers any span we inject). They are still returned
 * in the result list so the panel's scroll-to-first behavior works.
 */
export function applyGroupHighlights(rootEl, group) {
  if (!rootEl || !group || !Array.isArray(group.instances)) return [];
  const seen = new Set();
  const blocks = [];
  for (const v of group.instances) {
    const blockEl = getBlockDom(v.blockId)
      || (typeof rootEl.querySelector === 'function'
        ? rootEl.querySelector(`[data-block-id="${v.blockId}"]`)
        : null);
    if (!blockEl) continue;
    if (isPmOwnedDom(blockEl)) {
      // Skip injection — PM will discard the spans on its next dispatch.
      // Still record the block for scroll-to-first behavior.
      if (!seen.has(v.blockId)) {
        seen.add(v.blockId);
        blocks.push(blockEl);
      }
      continue;
    }
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
 *
 * Prefers the registry over a document-scoped querySelector so PM-mounted
 * blocks resolve correctly; falls back to the rootEl scan for legacy /
 * unregistered blocks.
 */
export function findFirstHighlightInBlock(rootEl, blockId) {
  if (!blockId) return null;
  const block = getBlockDom(blockId)
    || (rootEl && typeof rootEl.querySelector === 'function'
      ? rootEl.querySelector(`[data-block-id="${blockId}"]`)
      : null);
  if (!block || typeof block.querySelector !== 'function') return null;
  return block.querySelector(HIGHLIGHT_SELECTOR);
}
