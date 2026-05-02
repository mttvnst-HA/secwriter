/**
 * Inline Linter — DOM helpers for the inline linting hook.
 *
 * Per ADR-0005, the state for inline linting (the three Maps and the gating
 * flags) lives in the pure reducer at `src/lib/linting.js`. This file is the
 * thin DOM-touching layer: text extraction from a contentEditable, Range
 * creation against text nodes, fix application, and cursor hit-testing against
 * a supplied findings array.
 *
 * Async engine orchestration (Harper, compromise) and CSS.highlights mutation
 * live in the `useBlockLinting` hook.
 */

// NodeFilter.SHOW_TEXT = 4 (constant, avoids runtime lookup in Node/test environments)
const SHOW_TEXT = 4;

// ── Text Extraction ─────────────────────────────────────────────────────────

/**
 * Extract plain text from a contentEditable block element.
 * Walks text nodes directly, preserving whitespace faithfully.
 * Skips:
 *   - Text inside <del> elements (deleted content in track changes)
 *   - Text inside .mark-eng / .mark-met spans (unit display pairs)
 *
 * Does NOT use stripHtml() from compliance-checker.js (which collapses
 * double spaces and caused FMT-001 false positives).
 *
 * @param {Element} blockEl
 * @returns {string}
 */
export function extractPlainText(blockEl) {
  if (!blockEl) return '';
  let text = '';
  const walker = document.createTreeWalker(blockEl, SHOW_TEXT, null);
  let node;
  while ((node = walker.nextNode())) {
    if (node.parentElement?.closest?.('del')) continue;
    if (node.parentElement?.closest?.('.mark-eng')) continue;
    if (node.parentElement?.closest?.('.mark-met')) continue;
    text += node.textContent;
  }
  return text;
}

// ── Range Creation via String Search ────────────────────────────────────────

/**
 * Find a violation's matched text within the block's text nodes and create
 * a DOM Range targeting it.
 *
 * @param {Element} blockEl
 * @param {string} matchText
 * @param {number} [targetOffset] — character offset hint to disambiguate
 *   repeated short words ("the", "a", "is"). Picks the candidate closest to
 *   this offset in the block's plain text.
 * @returns {Range|null}
 */
export function createRangeForMatch(blockEl, matchText, targetOffset) {
  if (!matchText || !blockEl) return null;

  const walker = document.createTreeWalker(blockEl, SHOW_TEXT, null);
  const matchLower = matchText.toLowerCase();

  const candidates = [];
  let cumulativeOffset = 0;
  let node;

  while ((node = walker.nextNode())) {
    if (node.parentElement?.closest?.('del')) continue;
    if (node.parentElement?.closest?.('.compliance-highlight')) continue;

    const text = node.textContent.toLowerCase();
    let searchFrom = 0;
    let idx;

    while ((idx = text.indexOf(matchLower, searchFrom)) >= 0) {
      const charBefore = idx > 0 ? text[idx - 1] : '';
      const charAfter = idx + matchLower.length < text.length ? text[idx + matchLower.length] : '';
      const isWordBoundaryBefore = !charBefore || !/[a-z]/i.test(charBefore);
      const isWordBoundaryAfter = !charAfter || !/[a-z]/i.test(charAfter);
      if (isWordBoundaryBefore && isWordBoundaryAfter) {
        candidates.push({ node, idx, textOffset: cumulativeOffset + idx });
      }
      searchFrom = idx + 1;
    }
    cumulativeOffset += node.textContent.length;
  }

  if (candidates.length === 0) return null;

  let best = candidates[0];
  if (typeof targetOffset === 'number' && targetOffset >= 0 && candidates.length > 1) {
    let bestDist = Math.abs(best.textOffset - targetOffset);
    for (let i = 1; i < candidates.length; i++) {
      const dist = Math.abs(candidates[i].textOffset - targetOffset);
      if (dist < bestDist) { best = candidates[i]; bestDist = dist; }
    }
  }

  try {
    const range = document.createRange();
    range.setStart(best.node, best.idx);
    range.setEnd(best.node, best.idx + matchText.length);
    return range;
  } catch {
    return null;
  }
}

// ── Cursor Hit-Testing ──────────────────────────────────────────────────────

/**
 * Find the highest-severity finding whose Range contains the cursor position.
 * Pure with respect to module state — caller passes the candidate findings.
 *
 * @param {Array<{ range: Range, violation: { severity? } }>} findings
 * @param {Node} cursorNode
 * @param {number} cursorOffset
 * @returns {Object|null}
 */
export function findFindingAtCursor(findings, cursorNode, cursorOffset) {
  if (!cursorNode || !findings || findings.length === 0) return null;

  const severityOrder = { high: 0, medium: 1, low: 2 };
  let bestMatch = null;

  for (const finding of findings) {
    const range = finding.range;
    if (!range) continue;

    try {
      let isInside = false;

      if (range.startContainer === cursorNode && range.endContainer === cursorNode) {
        isInside = cursorOffset >= range.startOffset && cursorOffset <= range.endOffset;
      } else {
        try {
          const cursorRange = document.createRange();
          cursorRange.setStart(cursorNode, cursorOffset);
          cursorRange.collapse(true);
          const afterStart = range.compareBoundaryPoints(Range.START_TO_START, cursorRange) <= 0;
          const beforeEnd = range.compareBoundaryPoints(Range.END_TO_END, cursorRange) >= 0;
          isInside = afterStart && beforeEnd;
        } catch {
          // compareBoundaryPoints not available (linkedom) — skip cross-node check
        }
      }

      if (isInside) {
        if (
          !bestMatch ||
          (severityOrder[finding.violation.severity] ?? 2) <
            (severityOrder[bestMatch.violation.severity] ?? 2)
        ) {
          bestMatch = finding;
        }
      }
    } catch {
      continue;
    }
  }

  return bestMatch;
}

// ── Fix Computation ─────────────────────────────────────────────────────────

/**
 * Apply a violation's fixFn to produce corrected HTML text.
 *
 * @param {string} html
 * @param {Object} violation
 * @returns {string|null}
 */
export function computeFixedText(html, violation) {
  if (!violation || !violation.fixFn) return null;
  try {
    return violation.fixFn(html, violation.match, violation.replacement);
  } catch {
    return null;
  }
}
