/**
 * Inline Linter — Real-time compliance + grammar + NLP highlighting for editable blocks.
 *
 * Uses the CSS Custom Highlight API to overlay colored highlights on text
 * that violates UFS 1-300-02 rules, has grammar errors, or uses passive voice,
 * without mutating the DOM tree.
 *
 * Highlights persist across blur/focus — they remain until the violation is
 * fixed or the user dismisses it. Findings are stored per-block so linting
 * one block doesn't clear another's highlights.
 *
 * Three highlight groups:
 *   compliance-error — yellow background (static UFS rules)
 *   grammar-error    — blue background (Harper.js grammar/spelling)
 *   passive-voice    — orange background (compromise.js NLP)
 */

import { runStaticRules } from './compliance-rules.js';
import { checkGrammar, isGrammarReady, initGrammarChecker, getVersion } from './grammar-checker.js';
import { detectNlpIssues, isNlpReady, preloadNlp } from './nlp-rules.js';

// NodeFilter.SHOW_TEXT = 4 (constant, avoids runtime lookup in Node/test environments)
const SHOW_TEXT = 4;

// ── Active findings storage (per-block, per-type) ───────────────────────────

// Map<blockId, Array<{ range, violation }>>
const complianceFindingsByBlock = new Map();
const grammarFindingsByBlock = new Map();
const nlpFindingsByBlock = new Map();

// Track the text that was sent for grammar checking per block, for stale detection
const grammarTextByBlock = new Map();

// Whether grammar was ready when linting started (prevents pop-in)
let grammarWasReadyAtLintStart = false;

/**
 * Get all active findings across all blocks (flat array for tooltip hit-testing).
 * @returns {Array<{ range: Range|null, violation: Object }>}
 */
/**
 * Get the highest severity level for a specific block's findings.
 * Returns 'high', 'medium', 'low', or null if no findings.
 * @param {string} blockId
 * @returns {string|null}
 */
export function getBlockFindingSeverity(blockId) {
  const severityOrder = { high: 0, medium: 1, low: 2 };
  let best = null;
  const allMaps = [complianceFindingsByBlock, nlpFindingsByBlock, grammarFindingsByBlock];
  for (const map of allMaps) {
    const findings = map.get(blockId);
    if (!findings) continue;
    for (const f of findings) {
      const s = f.violation.severity;
      if (!best || (severityOrder[s] ?? 2) < (severityOrder[best] ?? 2)) {
        best = s;
      }
    }
  }
  return best;
}

export function getActiveFindings() {
  const all = [];
  for (const findings of complianceFindingsByBlock.values()) {
    all.push(...findings);
  }
  for (const findings of grammarFindingsByBlock.values()) {
    all.push(...findings);
  }
  for (const findings of nlpFindingsByBlock.values()) {
    all.push(...findings);
  }
  return all;
}

/**
 * Rebuild CSS highlights from all blocks' ranges.
 */
function rebuildHighlights() {
  if (typeof CSS === 'undefined' || !CSS.highlights) return;

  // Compliance highlights
  const complianceRanges = [];
  for (const findings of complianceFindingsByBlock.values()) {
    for (const f of findings) {
      if (f.range) complianceRanges.push(f.range);
    }
  }
  if (complianceRanges.length > 0) {
    CSS.highlights.set('compliance-error', new Highlight(...complianceRanges));
  } else {
    CSS.highlights.delete('compliance-error');
  }

  // Grammar highlights
  const grammarRanges = [];
  for (const findings of grammarFindingsByBlock.values()) {
    for (const f of findings) {
      if (f.range) grammarRanges.push(f.range);
    }
  }
  if (grammarRanges.length > 0) {
    CSS.highlights.set('grammar-error', new Highlight(...grammarRanges));
  } else {
    CSS.highlights.delete('grammar-error');
  }

  // NLP / passive-voice highlights
  const nlpRanges = [];
  for (const findings of nlpFindingsByBlock.values()) {
    for (const f of findings) {
      if (f.range) nlpRanges.push(f.range);
    }
  }
  if (nlpRanges.length > 0) {
    CSS.highlights.set('passive-voice', new Highlight(...nlpRanges));
  } else {
    CSS.highlights.delete('passive-voice');
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
 * a DOM Range targeting it.
 *
 * @param {Element} blockEl - The contentEditable DOM element
 * @param {string} matchText - The text to find (violation.match)
 * @param {number} [targetOffset=-1] - Optional character offset hint from the
 *   violation engine. When provided, the function finds the occurrence closest
 *   to this offset in the block's plain text, avoiding wrong-match on common
 *   short words like "the", "a", "is".
 * @returns {Range|null} A Range object, or null if not found
 */
function createRangeForMatch(blockEl, matchText, targetOffset) {
  if (!matchText || !blockEl) return null;

  const walker = document.createTreeWalker(blockEl, SHOW_TEXT, null);
  const matchLower = matchText.toLowerCase();

  // Collect all candidate matches with their DOM position and text offset
  const candidates = [];
  let cumulativeOffset = 0;
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
        candidates.push({ node, idx, textOffset: cumulativeOffset + idx });
      }
      searchFrom = idx + 1;
    }
    cumulativeOffset += node.textContent.length;
  }

  if (candidates.length === 0) return null;

  // Pick the best candidate: if we have a target offset, choose the closest match
  let best = candidates[0];
  if (typeof targetOffset === 'number' && targetOffset >= 0 && candidates.length > 1) {
    let bestDist = Math.abs(best.textOffset - targetOffset);
    for (let i = 1; i < candidates.length; i++) {
      const dist = Math.abs(candidates[i].textOffset - targetOffset);
      if (dist < bestDist) {
        best = candidates[i];
        bestDist = dist;
      }
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

// ── Main API ────────────────────────────────────────────────────────────────

/**
 * Run static compliance rules on a block and apply CSS Custom Highlight API
 * highlights. Then asynchronously run grammar checking if Harper is ready.
 *
 * @param {Element} blockEl - The contentEditable DOM element
 * @param {string} blockId - Block identifier
 * @param {string} plainText - Plain text extracted via extractPlainText()
 * @param {Array} rules - Rules from getRules()
 */
export function initInlineLinting(blockEl, blockId, plainText, rules, options = {}) {
  const { isNoteBlock = false } = options;

  // Clear previous findings for THIS block (stale Range objects from prior
  // lint cycles may reference DOM nodes replaced by React re-render)
  complianceFindingsByBlock.delete(blockId);
  nlpFindingsByBlock.delete(blockId);
  grammarFindingsByBlock.delete(blockId);

  if (!blockEl || !plainText || !rules) {
    rebuildHighlights();
    return;
  }

  // Check if grammar is ready for this lint cycle
  grammarWasReadyAtLintStart = isGrammarReady();

  // Run static rules (synchronous)
  const violations = runStaticRules(plainText, blockId, rules, {
    skipBrackets: true,
    isNoteBlock,
  });

  if (violations.length > 0) {
    const blockFindings = [];
    for (const v of violations) {
      const range = createRangeForMatch(blockEl, v.match, v.index);
      if (range) {
        blockFindings.push({ range, violation: v });
      }
    }
    if (blockFindings.length > 0) {
      complianceFindingsByBlock.set(blockId, blockFindings);
    }
  }

  // Run NLP rules (synchronous if compromise is loaded)
  // Suppress NLP findings that overlap with compliance findings (static rules take priority)
  if (isNlpReady()) {
    const nlpViolations = detectNlpIssues(plainText, blockId, isNoteBlock);
    if (nlpViolations.length > 0) {
      const nlpFindings = [];
      const complianceMatches = violations.map(v => ({
        start: v.index,
        end: v.index + v.match.length,
      }));

      for (const v of nlpViolations) {
        // Skip NLP findings that overlap with any compliance finding
        const nlpStart = v.index;
        const nlpEnd = v.index + v.match.length;
        const overlapsCompliance = complianceMatches.some(c =>
          nlpStart < c.end && nlpEnd > c.start
        );
        if (overlapsCompliance) continue;

        const range = createRangeForMatch(blockEl, v.match, v.index);
        if (range) {
          nlpFindings.push({ range, violation: v });
        }
      }
      if (nlpFindings.length > 0) {
        nlpFindingsByBlock.set(blockId, nlpFindings);
      }
    }
  } else {
    // Start lazy-loading compromise in the background
    preloadNlp();
  }

  rebuildHighlights();

  // Kick off async grammar check — always try if Harper is ready
  if (isGrammarReady()) {
    runGrammarCheck(blockEl, blockId, plainText);
  } else {
    // Start lazy-loading Harper in the background (don't await)
    grammarFindingsByBlock.delete(blockId);
    // Once Harper loads, re-lint this block if it's still focused
    initGrammarChecker().then(() => {
      if (blockEl && blockEl.isConnected && document.activeElement === blockEl) {
        runGrammarCheck(blockEl, blockId, plainText);
        rebuildHighlights();
      }
    }).catch(() => {});
  }
}

/**
 * Run grammar checking asynchronously and merge results.
 */
async function runGrammarCheck(blockEl, blockId, plainText) {
  // Store the text we're checking for stale detection
  grammarTextByBlock.set(blockId, plainText);
  const versionBefore = getVersion();

  const grammarViolations = await checkGrammar(plainText, blockId);

  // Stale check: if the text changed while we were waiting, discard
  if (grammarTextByBlock.get(blockId) !== plainText) return;

  // Clear previous grammar findings for this block
  grammarFindingsByBlock.delete(blockId);

  if (grammarViolations.length > 0) {
    // De-duplicate: skip grammar findings that overlap >50% with compliance or NLP findings
    const existingFindings = [
      ...(complianceFindingsByBlock.get(blockId) || []),
      ...(nlpFindingsByBlock.get(blockId) || []),
    ];

    const grammarFindings = [];
    for (const v of grammarViolations) {
      // Check overlap with existing findings
      const gStart = v.index;
      const gEnd = v.index + v.match.length;
      const gLen = v.match.length;

      const overlaps = existingFindings.some(f => {
        const fStart = f.violation.index;
        const fEnd = fStart + f.violation.match.length;
        const overlapStart = Math.max(gStart, fStart);
        const overlapEnd = Math.min(gEnd, fEnd);
        const overlapLen = Math.max(0, overlapEnd - overlapStart);
        return overlapLen > gLen * 0.5;
      });
      if (overlaps) continue;

      const range = createRangeForMatch(blockEl, v.match, v.index);
      if (range) {
        grammarFindings.push({ range, violation: v });
      }
    }
    if (grammarFindings.length > 0) {
      grammarFindingsByBlock.set(blockId, grammarFindings);
    }
  }

  rebuildHighlights();
}

/**
 * Clear findings for a specific block (both compliance and grammar).
 * @param {string} blockId - Block to clear
 */
export function clearBlockLinting(blockId) {
  complianceFindingsByBlock.delete(blockId);
  grammarFindingsByBlock.delete(blockId);
  nlpFindingsByBlock.delete(blockId);
  grammarTextByBlock.delete(blockId);
  rebuildHighlights();
}

/**
 * Clear all inline linting highlights and reset all findings.
 */
export function clearInlineLinting() {
  if (typeof CSS !== 'undefined' && CSS.highlights) {
    CSS.highlights.delete('compliance-error');
    CSS.highlights.delete('grammar-error');
    CSS.highlights.delete('passive-voice');
  }
  complianceFindingsByBlock.clear();
  grammarFindingsByBlock.clear();
  nlpFindingsByBlock.clear();
  grammarTextByBlock.clear();
}

// ── Cursor Hit-Testing ──────────────────────────────────────────────────────

/**
 * Check if a cursor position (node + offset) falls within a finding's Range.
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

    try {
      let isInside = false;

      // Fast path: cursor is in same text node as range
      if (range.startContainer === cursorNode && range.endContainer === cursorNode) {
        isInside = cursorOffset >= range.startOffset && cursorOffset <= range.endOffset;
      } else {
        // Cross-node: use Range.compareBoundaryPoints if available
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
        if (!bestMatch ||
          (severityOrder[finding.violation.severity] || 2) < (severityOrder[bestMatch.violation.severity] || 2)) {
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
