/**
 * compliance-checker.js
 *
 * Orchestrator: runs static rules against a scoped set of blocks,
 * collects violations, groups them by rule type, and computes stats.
 */

import { getRules, runStaticRules } from './compliance-rules.js';

// ── Scope Selection ──────────────────────────────────────────────────────────

/**
 * Get blocks within the specified scope.
 */
export function getBlocksInScope(blocks, scopeType, anchorBlockId) {
  switch (scopeType) {
    case 'block':
      return blocks.filter(b => b.id === anchorBlockId);

    case 'subsection': {
      const headingIdx = blocks.findIndex(b => b.id === anchorBlockId);
      if (headingIdx < 0) return [];
      const heading = blocks[headingIdx];
      const result = [heading];
      for (let i = headingIdx + 1; i < blocks.length; i++) {
        if (blocks[i].type === 'title' && blocks[i].depth <= heading.depth) break;
        result.push(blocks[i]);
      }
      return result;
    }

    case 'part': {
      const partBlock = blocks.find(b => b.id === anchorBlockId);
      if (!partBlock) return [];
      return blocks.filter(b => b.part === partBlock.part);
    }

    case 'document':
      return blocks.filter(b => b.type !== 'pagebreak');

    default:
      return [];
  }
}

// ── HTML Stripping ───────────────────────────────────────────────────────────

/**
 * Strip HTML tags to get plain text for rule matching.
 * Preserves text content, strips all tags.
 * When unitDisplay is 'eng' or 'met', strips hidden unit content.
 */
function stripHtml(html, unitDisplay) {
  if (!html) return '';
  let result = html;

  // Remove del content (TC deletions)
  result = result.replace(/<del\b[^>]*>.*?<\/del>/gi, '');

  // Remove hidden unit content based on unitDisplay toggle
  if (unitDisplay === 'eng') {
    // English-only: strip metric spans entirely
    result = result.replace(/<span\b[^>]*class="mark-met"[^>]*>.*?<\/span>/gi, '');
  } else if (unitDisplay === 'met') {
    // Metric-only: strip English spans entirely
    result = result.replace(/<span\b[^>]*class="mark-eng"[^>]*>.*?<\/span>/gi, '');
  }

  // Strip all remaining tags — replace with space to avoid merging words
  // at tag boundaries (e.g., "</span> <span>" → "  " → collapsed to " ")
  return result
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\u200B/g, '')
    .replace(/ {2,}/g, ' ')
    .trim();
}

// ── Main Checker ─────────────────────────────────────────────────────────────

/**
 * Yield to the browser event loop to prevent "Page Unresponsive".
 */
function yieldToMain() {
  return new Promise(resolve => setTimeout(resolve, 0));
}

/**
 * Run compliance check on a scoped set of blocks.
 * Async with chunked processing — yields to the browser every CHUNK_SIZE blocks
 * to prevent "Page Unresponsive" on large documents (~427 blocks × ~81 rules = ~34k regex ops).
 *
 * @param {Array} blocks - Full block array
 * @param {string} scopeType - 'block' | 'subsection' | 'part' | 'document'
 * @param {string} anchorBlockId - Block ID to anchor the scope
 * @param {Object} options - { unitDisplay: 'both'|'eng'|'met' }
 * @returns {Promise<{ violations: Array, groups: Map, stats: Object }>}
 */
export const MAX_VIOLATIONS = 2000;

export async function checkCompliance(blocks, scopeType, anchorBlockId, options = {}) {
  const CHUNK_SIZE = 20; // Process 20 blocks per tick (~1,600 regex ops, well under 50ms budget)
  const { unitDisplay = 'both' } = options;
  const rules = getRules();
  const scopeBlocks = getBlocksInScope(blocks, scopeType, anchorBlockId);

  // Filter to checkable blocks
  const checkable = scopeBlocks.filter(block => {
    if (['table', 'ref', 'pagebreak'].includes(block.type)) return false;
    if (block.type === 'title') return false;
    if (block.type === 'note') return false;
    return true;
  });

  const violations = [];
  let truncated = false;

  for (let i = 0; i < checkable.length; i += CHUNK_SIZE) {
    const chunk = checkable.slice(i, i + CHUNK_SIZE);

    for (const block of chunk) {
      const plainText = stripHtml(block.html, unitDisplay);
      if (!plainText) continue;

      const blockViolations = runStaticRules(plainText, block.id, rules, {
        skipBrackets: true,
      });

      violations.push(...blockViolations);

      if (violations.length >= MAX_VIOLATIONS) {
        violations.length = MAX_VIOLATIONS;
        truncated = true;
        break;
      }
    }

    if (truncated) break;

    // Yield to browser after each chunk (skip on last chunk — no point yielding just to return)
    if (i + CHUNK_SIZE < checkable.length) {
      await yieldToMain();
    }
  }

  // Group violations by rule ID
  const groups = groupViolations(violations);

  // Compute stats
  const stats = computeStats(violations);

  return { violations, groups, stats, truncated };
}

// ── Grouping ─────────────────────────────────────────────────────────────────

/**
 * Group violations by rule ID.
 * Each group has: { rule metadata, instances[], representative context }
 *
 * @returns {Array} Sorted array of groups: [{ ruleId, category, severity, message, ufsRef, instances, representative }]
 */
function groupViolations(violations) {
  const groupMap = new Map();

  for (const v of violations) {
    if (!groupMap.has(v.ruleId)) {
      groupMap.set(v.ruleId, {
        ruleId: v.ruleId,
        category: v.category,
        severity: v.severity,
        message: v.message,
        ufsRef: v.ufsRef,
        replacement: v.replacement,
        instances: [],
        representative: null,
      });
    }
    groupMap.get(v.ruleId).instances.push(v);
  }

  // Set representative to first instance of each group
  for (const group of groupMap.values()) {
    group.representative = group.instances[0];
  }

  // Sort: high severity first, then by instance count descending
  const severityOrder = { high: 0, medium: 1, low: 2 };
  const sorted = Array.from(groupMap.values()).sort((a, b) => {
    const sevDiff = (severityOrder[a.severity] || 9) - (severityOrder[b.severity] || 9);
    if (sevDiff !== 0) return sevDiff;
    return b.instances.length - a.instances.length;
  });

  return sorted;
}

// ── Stats ────────────────────────────────────────────────────────────────────

/**
 * Compute summary stats from violations.
 */
function computeStats(violations) {
  const stats = {
    total: violations.length,
    high: 0,
    medium: 0,
    low: 0,
    autoFixable: 0,
    needsAI: 0,
    byCategory: {},
  };

  for (const v of violations) {
    if (v.severity === 'high') stats.high++;
    else if (v.severity === 'medium') stats.medium++;
    else stats.low++;

    if (v.fixFn !== null) stats.autoFixable++;
    else stats.needsAI++;

    stats.byCategory[v.category] = (stats.byCategory[v.category] || 0) + 1;
  }

  return stats;
}

export { stripHtml, groupViolations, computeStats };
