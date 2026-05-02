/**
 * Linting — pure reducer over inline-linting state.
 *
 * Owns state for the three real-time linting tiers (static UFS, Harper grammar,
 * compromise NLP) plus the global gates (enabled toggle, suspended-while-panel-open).
 * Per ADR-0005, this is the same shape as track-changes.js and comments.js: opaque
 * state, pure verbs, pure selectors, property-tested invariants.
 *
 * The hybrid: Range objects inside Findings are *opaque* to this reducer. Range
 * creation, CSS.highlights mutation, and async dispatch live in useBlockLinting
 * (the hook). The reducer is pure — it can be tested in plain Vitest with no DOM.
 *
 * State shape:
 *   {
 *     enabled: boolean,                         // user toggle
 *     suspended: boolean,                       // CompliancePanel open → suspend inline
 *     byBlock: Map<blockId, BlockFindings>,
 *   }
 *
 * BlockFindings:
 *   {
 *     compliance: Finding[],
 *     nlp: Finding[],
 *     grammar: Finding[],
 *     grammarText: string | null,               // text snapshot for stale detection
 *   }
 *
 * Finding:
 *   { range: Range|null, violation: { ruleId, severity, index, match, ... } }
 */

const SEVERITY_ORDER = { high: 0, medium: 1, low: 2 };

// Context-dependent rules that produce too many false positives in real-time
// inline linting. They still run in the compliance panel where the user
// explicitly requests a full scan and can review.
export const DEFERRED_TO_PANEL = new Set([
  'TERM-suitable',     // "suitable for [specific]" — needs sentence context
  'TERM-any',          // determiner vs. indefinite — needs clause context
  'TERM-should',       // quoted meta-text boilerplate — needs quote detection
  'VAGUE-applicable',  // "applicable codes/standards" — legitimate in many contexts
]);

// ── Pure helpers (testable independently) ────────────────────────────────────

/** Whether this rule should be deferred to the compliance panel for inline linting. */
export function isDeferredRule(violation) {
  return DEFERRED_TO_PANEL.has(violation.ruleId);
}

/** Half-open interval overlap test: [aStart, aEnd) vs [bStart, bEnd). */
export function intervalsOverlap(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && aEnd > bStart;
}

/**
 * NLP findings overlapping any compliance finding are suppressed (static rules
 * win on overlap — they have UFS citations, NLP is heuristic).
 */
export function dedupNlpAgainstCompliance(nlpViolations, complianceViolations) {
  if (!nlpViolations.length || !complianceViolations.length) return nlpViolations;
  const ranges = complianceViolations.map(v => ({
    start: v.index,
    end: v.index + v.match.length,
  }));
  return nlpViolations.filter(v => {
    const start = v.index;
    const end = v.index + v.match.length;
    return !ranges.some(r => intervalsOverlap(start, end, r.start, r.end));
  });
}

/**
 * Grammar findings overlapping >threshold (default 50%) of their length with
 * any other-tier finding are suppressed (static + NLP win — they have stronger
 * signal than Harper's general grammar rules).
 */
export function dedupGrammarAgainstFindings(grammarViolations, otherViolations, threshold = 0.5) {
  if (!grammarViolations.length || !otherViolations.length) return grammarViolations;
  return grammarViolations.filter(g => {
    const gStart = g.index;
    const gEnd = g.index + g.match.length;
    const gLen = g.match.length;
    if (gLen === 0) return true;
    return !otherViolations.some(o => {
      const oStart = o.index;
      const oEnd = oStart + o.match.length;
      const overlapStart = Math.max(gStart, oStart);
      const overlapEnd = Math.min(gEnd, oEnd);
      const overlapLen = Math.max(0, overlapEnd - overlapStart);
      return overlapLen > gLen * threshold;
    });
  });
}

/** Pick the highest-severity finding (high > medium > low). */
export function pickHighestSeverityFinding(findings) {
  let best = null;
  for (const f of findings) {
    if (!best) { best = f; continue; }
    const fOrd = SEVERITY_ORDER[f.violation.severity] ?? 2;
    const bOrd = SEVERITY_ORDER[best.violation.severity] ?? 2;
    if (fOrd < bOrd) best = f;
  }
  return best;
}

// ── Reducer state ────────────────────────────────────────────────────────────

function emptyBlockFindings() {
  return { compliance: [], nlp: [], grammar: [], grammarText: null };
}

/** Create initial state. */
export function createInitial({ enabled = true } = {}) {
  return {
    enabled,
    suspended: false,
    byBlock: new Map(),
  };
}

// ── Verbs (all pure) ─────────────────────────────────────────────────────────

/** Toggle the global lint-enabled flag. Disabling does not erase findings — that's clearAll. */
export function setEnabled(state, enabled) {
  if (state.enabled === enabled) return state;
  return { ...state, enabled };
}

/** Set the suspended flag (compliance panel open → suspend inline linting). */
export function setSuspended(state, suspended) {
  if (state.suspended === suspended) return state;
  return { ...state, suspended };
}

/**
 * Replace some-or-all findings for a block. `partial` may include any of:
 *   { compliance, nlp, grammar, grammarText }
 * Omitted fields are preserved. Returns the same state ref if nothing changed.
 */
export function setBlockFindings(state, blockId, partial) {
  const prev = state.byBlock.get(blockId) || emptyBlockFindings();
  const next = {
    compliance: partial.compliance !== undefined ? partial.compliance : prev.compliance,
    nlp: partial.nlp !== undefined ? partial.nlp : prev.nlp,
    grammar: partial.grammar !== undefined ? partial.grammar : prev.grammar,
    grammarText: partial.grammarText !== undefined ? partial.grammarText : prev.grammarText,
  };
  // Bail if nothing actually changed (referential equality)
  if (
    next.compliance === prev.compliance &&
    next.nlp === prev.nlp &&
    next.grammar === prev.grammar &&
    next.grammarText === prev.grammarText
  ) {
    return state;
  }
  const byBlock = new Map(state.byBlock);
  byBlock.set(blockId, next);
  return { ...state, byBlock };
}

/** Drop all findings for a block (e.g., on unmount or focus loss with re-enable). */
export function clearBlock(state, blockId) {
  if (!state.byBlock.has(blockId)) return state;
  const byBlock = new Map(state.byBlock);
  byBlock.delete(blockId);
  return { ...state, byBlock };
}

/** Clear all per-block findings. Preserves enabled/suspended. */
export function clearAll(state) {
  if (state.byBlock.size === 0) return state;
  return { ...state, byBlock: new Map() };
}

// ── Selectors (pure) ─────────────────────────────────────────────────────────

/** Linting is "active" when enabled and not suspended. */
export function isActive(state) {
  return state.enabled && !state.suspended;
}

export function isEnabled(state) {
  return state.enabled;
}

export function isSuspended(state) {
  return state.suspended;
}

/** Flat array of all findings for a block, across all tiers. */
export function getBlockFindings(state, blockId) {
  const b = state.byBlock.get(blockId);
  if (!b) return [];
  return [...b.compliance, ...b.nlp, ...b.grammar];
}

/** Flat array of every finding across every block. */
export function getAllFindings(state) {
  const out = [];
  for (const b of state.byBlock.values()) {
    out.push(...b.compliance, ...b.nlp, ...b.grammar);
  }
  return out;
}

/** Highest-severity tag across this block's findings: 'high'|'medium'|'low'|null. */
export function getBlockSeverity(state, blockId) {
  const b = state.byBlock.get(blockId);
  if (!b) return null;
  let best = null;
  for (const arr of [b.compliance, b.nlp, b.grammar]) {
    for (const f of arr) {
      const s = f.violation.severity;
      if (!best || (SEVERITY_ORDER[s] ?? 2) < (SEVERITY_ORDER[best] ?? 2)) {
        best = s;
      }
    }
  }
  return best;
}

/** Text snapshot last sent to grammar checker for this block (stale detection). */
export function getGrammarText(state, blockId) {
  const b = state.byBlock.get(blockId);
  return b ? b.grammarText : null;
}

/**
 * Return ranges grouped by tier — the projection that App turns into
 * CSS.highlights groups. Skips findings with null Range (createRangeForMatch
 * may have failed if the matched text was inside a skipped span).
 */
export function getRangesByTier(state) {
  const compliance = [];
  const grammar = [];
  const nlp = [];
  for (const b of state.byBlock.values()) {
    for (const f of b.compliance) if (f.range) compliance.push(f.range);
    for (const f of b.grammar) if (f.range) grammar.push(f.range);
    for (const f of b.nlp) if (f.range) nlp.push(f.range);
  }
  return { compliance, grammar, nlp };
}
