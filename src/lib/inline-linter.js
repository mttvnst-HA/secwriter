/**
 * Inline Linter — Real-time compliance highlighting for editable blocks.
 *
 * Uses the CSS Custom Highlight API to overlay colored highlights on text
 * that violates UFS 1-300-02 rules, without mutating the DOM tree.
 *
 * Highlights persist across blur/focus — they remain until the violation is
 * fixed or the user dismisses it. Findings are stored per-block so linting
 * one block doesn't clear another's highlights.
 */

import { runStaticRules } from './compliance-rules.js';

// NodeFilter.SHOW_TEXT = 4 (constant, avoids runtime lookup in Node/test environments)
const SHOW_TEXT = 4;

// ── Active findings storage (per-block) ─────────────────────────────────────

// Map<blockId, Array<{ range, violation }>>
const findingsByBlock = new Map();

/**
 * Get all active findings across all blocks (flat array for tooltip hit-testing).
 * @returns {Array<{ range: Range|null, violation: Object }>}
 */
export function getActiveFindings() {
  const all = [];
  for (const findings of findingsByBlock.values()) {
    all.push(...findings);
  }
  return all;
}

/**
 * Rebuild the CSS highlight from all blocks' ranges.
 */
function rebuildHighlight() {
  if (typeof CSS === 'undefined' || !CSS.highlights) return;

  const allRanges = [];
  for (const findings of findingsByBlock.values()) {
    for (const f of findings) {
      if (f.range) allRanges.push(f.range);
    }
  }

  if (allRanges.length > 0) {
    CSS.highlights.set('compliance-error', new Highlight(...allRanges));
  } else {
    CSS.highlights.delete('compliance-error');
  }
}

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
 * @param {Element} blockEl - The contentEditable DOM element
 * @returns {string} Plain text content
 */
export function extractPlainText(blockEl) {
  if (!blockEl) return '';

  let text = '';
  const walker = document.createTreeWalker(blockEl, SHOW_TEXT, null);

  let node;
  while ((node = walker.nextNode())) {
    // Skip text inside <del> elements
    if (node.parentElement?.closest?.('del')) continue;
    // Skip text inside hidden ENG/MET spans
    if (node.parentElement?.closest?.('.mark-eng')) continue;
    if (node.parentElement?.closest?.('.mark-met')) continue;

    text += node.textContent;
  }

  return text;
}

// ── Range Creation via String Search ────────────────────────────────────────

/**
 * Find a violation's matched text within the block's text nodes and create
 * a DOM Range targeting it. Uses the same TreeWalker string-search approach
 * as CompliancePanel.jsx's applyHighlights().
 *
 * @param {Element} blockEl - The contentEditable DOM element
 * @param {string} matchText - The text to find (violation.match)
 * @returns {Range|null} A Range object, or null if not found
 */
function createRangeForMatch(blockEl, matchText) {
  if (!matchText || !blockEl) return null;

  const walker = document.createTreeWalker(blockEl, SHOW_TEXT, null);
  const matchLower = matchText.toLowerCase();

  let node;
  while ((node = walker.nextNode())) {
    // Skip text inside <del> elements
    if (node.parentElement?.closest?.('del')) continue;
    // Skip text inside compliance-highlight spans (from panel)
    if (node.parentElement?.closest?.('.compliance-highlight')) continue;

    const text = node.textContent.toLowerCase();
    let searchFrom = 0;
    let idx;

    while ((idx = text.indexOf(matchLower, searchFrom)) >= 0) {
      // Word boundary checks to avoid substring matches
      const charBefore = idx > 0 ? text[idx - 1] : '';
      const charAfter = idx + matchLower.length < text.length ? text[idx + matchLower.length] : '';
      const isWordBoundaryBefore = !charBefore || !/[a-z]/i.test(charBefore);
      const isWordBoundaryAfter = !charAfter || !/[a-z]/i.test(charAfter);

      if (isWordBoundaryBefore && isWordBoundaryAfter) {
        try {
          const range = document.createRange();
          range.setStart(node, idx);
          range.setEnd(node, idx + matchText.length);
          return range;
        } catch {
          // Range creation failed (node may have changed), skip
        }
      }
      searchFrom = idx + 1;
    }
  }

  return null;
}

// ── Main API ────────────────────────────────────────────────────────────────

/**
 * Run static compliance rules on a block and apply CSS Custom Highlight API
 * highlights for any violations found. Only clears/replaces findings for
 * the specified block — other blocks' highlights are preserved.
 *
 * @param {Element} blockEl - The contentEditable DOM element
 * @param {string} blockId - Block identifier
 * @param {string} plainText - Plain text extracted via extractPlainText()
 * @param {Array} rules - Rules from getRules()
 */
export function initInlineLinting(blockEl, blockId, plainText, rules) {
  // Clear previous findings for THIS block only
  findingsByBlock.delete(blockId);

  if (!blockEl || !plainText || !rules) {
    rebuildHighlight();
    return;
  }

  // Run static rules
  const violations = runStaticRules(plainText, blockId, rules, {
    skipBrackets: true,
    isNoteBlock: false,
  });

  if (violations.length > 0) {
    const blockFindings = [];

    for (const v of violations) {
      const range = createRangeForMatch(blockEl, v.match);
      if (range) {
        blockFindings.push({ range, violation: v });
      }
    }

    if (blockFindings.length > 0) {
      findingsByBlock.set(blockId, blockFindings);
    }
  }

  rebuildHighlight();
}

/**
 * Clear findings for a specific block.
 * @param {string} blockId - Block to clear
 */
export function clearBlockLinting(blockId) {
  findingsByBlock.delete(blockId);
  rebuildHighlight();
}

/**
 * Clear all inline linting highlights and reset all findings.
 */
export function clearInlineLinting() {
  if (typeof CSS !== 'undefined' && CSS.highlights) {
    CSS.highlights.delete('compliance-error');
  }
  findingsByBlock.clear();
}

// ── Cursor Hit-Testing ──────────────────────────────────────────────────────

/**
 * Check if a cursor position (node + offset) falls within a finding's Range.
 * Compares the cursor against each active finding's start/end container+offset.
 *
 * @param {Node} cursorNode - The text node containing the cursor
 * @param {number} cursorOffset - The offset within that text node
 * @returns {Object|null} The matching finding, or null
 */
export function findFindingAtCursor(cursorNode, cursorOffset) {
  const allFindings = getActiveFindings();
  if (!cursorNode || allFindings.length === 0) return null;

  // Severity priority: high > medium > low
  const severityOrder = { high: 0, medium: 1, low: 2 };
  let bestMatch = null;

  for (const finding of allFindings) {
    const range = finding.range;
    if (!range) continue;

    // Check if cursor is within this range
    if (range.startContainer === cursorNode && range.endContainer === cursorNode) {
      if (cursorOffset >= range.startOffset && cursorOffset <= range.endOffset) {
        if (!bestMatch ||
          (severityOrder[finding.violation.severity] || 2) < (severityOrder[bestMatch.violation.severity] || 2)) {
          bestMatch = finding;
        }
      }
    }
  }

  return bestMatch;
}

// ── Fix Computation ─────────────────────────────────────────────────────────

/**
 * Apply a violation's fixFn to produce corrected HTML text.
 *
 * @param {string} html - The block's current innerHTML
 * @param {Object} violation - The violation object with fixFn, match, replacement
 * @returns {string|null} The fixed HTML, or null if no fix available
 */
export function computeFixedText(html, violation) {
  if (!violation || !violation.fixFn) return null;

  try {
    return violation.fixFn(html, violation.match, violation.replacement);
  } catch {
    return null;
  }
}

// ── Debounce constant (configurable) ────────────────────────────────────────

export const DEBOUNCE_MS = 500;
