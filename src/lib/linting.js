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
 *     ignored: {
 *       findings: Map<ignoreKey, entry>,        // per-finding suppression; entry may carry tombstone: true
 *       mutedRules: Map<ruleId, entry>,         // per-rule mute; entry may carry tombstone: true
 *     },
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
// inline linting. Empty as of #156: TERM-suitable, TERM-any, TERM-should, and
// VAGUE-applicable were brought back inline via POS-window suppression and
// full-text quote tracking in src/lib/compliance-rules.js (computeQuoteRanges
// + computePosSuppression).
export const DEFERRED_TO_PANEL = new Set([]);

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
    ignored: {
      findings: new Map(),
      mutedRules: new Map(),
    },
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

/**
 * Drop byBlock entries whose blockId is not in `liveIds` (#148). Defends
 * against block-removal paths that don't go through useBlockLinting's
 * per-block unmount cleanup — bulk accept/reject of revisions, undo of an
 * insertion, peer-driven deletion, convertBlock's ID swap, and any block
 * whose linting hook was inactive (editable=false) when it was removed.
 *
 * `liveIds` must be a Set (or any iterable whose membership check is O(1)
 * via .has). Returns the same state ref when no entries are stale.
 */
export function pruneOrphanedBlocks(state, liveIds) {
  if (state.byBlock.size === 0) return state;
  const stale = [];
  for (const id of state.byBlock.keys()) {
    if (!liveIds.has(id)) stale.push(id);
  }
  if (stale.length === 0) return state;
  const byBlock = new Map(state.byBlock);
  for (const id of stale) byBlock.delete(id);
  return { ...state, byBlock };
}

/** Clear all per-block findings. Preserves enabled/suspended. */
export function clearAll(state) {
  if (state.byBlock.size === 0) return state;
  return { ...state, byBlock: new Map() };
}

/**
 * Prefill `byBlock` from a sidecar projection (issue #138). The projection
 * is a `Map<blockId, BlockFindings>` produced by `lint-sidecar.projectDecoded`
 * after fingerprinting the current block array against a decoded payload.
 *
 * Existing entries for the same blockId are overwritten (the sidecar is the
 * authoritative cache for the just-loaded file). Blocks not in the projection
 * are untouched. Returns the same state ref if the projection is empty.
 *
 * Opaque to consumers: the App-side wiring dispatches once on .SEC import
 * after `parseSEC` returns and before the first render that drives the
 * inline-linting effect. The engines see "this block already has findings"
 * and skip their work until the html changes — at which point the existing
 * pipeline overwrites the stale entry naturally.
 */
export function prefillFromSidecar(state, projection) {
  if (!(projection instanceof Map) || projection.size === 0) return state;
  const byBlock = new Map(state.byBlock);
  for (const [blockId, bf] of projection) {
    if (typeof blockId !== 'string' || !bf) continue;
    byBlock.set(blockId, {
      compliance: Array.isArray(bf.compliance) ? bf.compliance : [],
      nlp: Array.isArray(bf.nlp) ? bf.nlp : [],
      grammar: Array.isArray(bf.grammar) ? bf.grammar : [],
      grammarText: typeof bf.grammarText === 'string' ? bf.grammarText : null,
    });
  }
  return { ...state, byBlock };
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
 * CSS.highlights groups. Pipeline per call:
 *   1. Read cached findings + blockHash from byBlock.
 *   2. Skip findings whose f.ignoreKey is null (async hash cache not yet
 *      populated for this engine cycle).
 *   3. Apply ignore-filter (isFindingIgnored) and mute-filter (isNlpRuleMuted).
 *   4. Run cross-tier dedup (dedupNlpAgainstCompliance, dedupGrammarAgainstFindings)
 *      AFTER ignore-filter so dismissing a static finding surfaces the suppressed
 *      NLP/grammar overlap.
 *   5. Collect surviving Ranges into per-tier arrays.
 */
export function getRangesByTier(state) {
  const compliance = [];
  const grammar = [];
  const nlp = [];
  if (!state.byBlock || state.byBlock.size === 0) {
    return { compliance, grammar, nlp };
  }
  // Per-block: filter, dedup, then push.
  for (const bf of state.byBlock.values()) {
    // 1+2+3: filter each tier by ignored / muted + null-key skip
    const cFiltered = filterFindings(bf.compliance, state);
    const nFiltered = filterFindings(bf.nlp, state);
    const gFiltered = filterFindings(bf.grammar, state);

    // 4: cross-tier dedup, post-filter
    const cViolations = cFiltered.map(f => f.violation);
    const nViolationsDeduped = dedupNlpAgainstCompliance(
      nFiltered.map(f => f.violation),
      cViolations,
    );
    const gViolationsDeduped = dedupGrammarAgainstFindings(
      gFiltered.map(f => f.violation),
      [...cViolations, ...nViolationsDeduped],
    );

    // 5: map back to findings (matched by violation identity), collect Ranges
    const nSurvive = new Set(nViolationsDeduped);
    const gSurvive = new Set(gViolationsDeduped);
    for (const f of cFiltered) if (f.range) compliance.push(f.range);
    for (const f of nFiltered) if (f.range && nSurvive.has(f.violation)) nlp.push(f.range);
    for (const f of gFiltered) if (f.range && gSurvive.has(f.violation)) grammar.push(f.range);
  }
  return { compliance, grammar, nlp };
}

/**
 * Filter findings by ignored.findings + ignored.mutedRules.
 * Null-`ignoreKey` findings pass through unfiltered (hash cache lag — see §6.2).
 * Delegates to spec §4.2 selectors `isFindingIgnored` / `isNlpRuleMuted` so the
 * "active" predicate stays in one place.
 */
function filterFindings(findings, state) {
  if (!findings || findings.length === 0) return [];
  if (!state || !state.ignored) return findings;
  const out = [];
  for (const f of findings) {
    if (!f) continue;
    const v = f.violation;
    if (!v) continue;
    // Skip filter when ignoreKey not yet computed (async cache placeholder).
    if (f.ignoreKey != null && isFindingIgnored(state, f.ignoreKey)) continue;
    // Mute NLP rules at projection time.
    if (typeof v.ruleId === 'string' && v.ruleId.startsWith('NLP-')
        && isNlpRuleMuted(state, v.ruleId)) continue;
    out.push(f);
  }
  return out;
}

// ── Persistent dismiss / mute (#140) ────────────────────────────────────────

const IGNORE_KEY_HEX_CHARS = 24;

/**
 * SHA-256(JSON.stringify([ruleId, blockHash, match])) truncated to 24 hex
 * chars. JSON.stringify isolates the components so 'a|b' in match cannot
 * collide with 'block1|' in blockHash (pipe-edge regression — see test).
 *
 * Async because Web Crypto's `crypto.subtle.digest` is async. Pre-cached on
 * each finding via `useBlockLinting.js` — projection layer reads sync.
 */
export async function computeIgnoreKey(ruleId, blockHash, match) {
  const text = JSON.stringify([ruleId, blockHash, match]);
  const subtle = globalThis.crypto?.subtle;
  if (!subtle || typeof subtle.digest !== 'function') {
    return fallbackIgnoreKey(text);
  }
  const bytes = new TextEncoder().encode(text);
  const digest = await subtle.digest('SHA-256', bytes);
  const view = new Uint8Array(digest);
  let out = '';
  for (let i = 0; i < view.length && out.length < IGNORE_KEY_HEX_CHARS; i++) {
    out += view[i].toString(16).padStart(2, '0');
  }
  return out.slice(0, IGNORE_KEY_HEX_CHARS);
}

function fallbackIgnoreKey(text) {
  let h1 = 0xcbf29ce4, h2 = 0x84222325;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = (h1 ^ c) >>> 0;
    h2 = (h2 ^ c) >>> 0;
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 = Math.imul(h2, 0x01000193) >>> 0;
  }
  const a = h1.toString(16).padStart(8, '0');
  const b = h2.toString(16).padStart(8, '0');
  return (a + b + a).slice(0, IGNORE_KEY_HEX_CHARS);
}

/** True when state has a non-tombstoned entry for this ignore-key. */
export function isFindingIgnored(state, ignoreKey) {
  if (!state.ignored || typeof ignoreKey !== 'string') return false;
  const entry = state.ignored.findings.get(ignoreKey);
  return !!entry && entry.tombstone !== true;
}

/** True when state has a non-tombstoned mute entry for this ruleId. */
export function isNlpRuleMuted(state, ruleId) {
  if (!state.ignored || typeof ruleId !== 'string') return false;
  const entry = state.ignored.mutedRules.get(ruleId);
  return !!entry && entry.tombstone !== true;
}

/** Count of active (non-tombstoned) dismissals + mutes. */
export function getIgnoredCount(state) {
  if (!state.ignored) return 0;
  let n = 0;
  for (const e of state.ignored.findings.values()) if (e && e.tombstone !== true) n++;
  for (const e of state.ignored.mutedRules.values()) if (e && e.tombstone !== true) n++;
  return n;
}

/**
 * Insert/overwrite a finding-ignore entry. `ignoreKey` is the SHA-prefix
 * pre-computed by `useBlockLinting.js`. Tombstoned entries are revived as
 * non-tombstone (a fresh ignoreFinding after an unignore is identity-restore).
 */
export function ignoreFinding(state, { ignoreKey, ruleId, blockHash, match, identity, ts }) {
  if (typeof ignoreKey !== 'string' || typeof ruleId !== 'string') return state;
  if (typeof blockHash !== 'string' || typeof match !== 'string') return state;
  // Local-gesture verb: writes unconditionally. Collab convergence (LWW + lex
  // tiebreak on authorId) is enforced by `applyRemoteIgnored` on the receive
  // side; this verb is for the originating tab's own dispatch.
  const entry = {
    ruleId,
    blockHash,
    match,
    ts: typeof ts === 'number' ? ts : Date.now(),
    authorId: identity?.id || '',
  };
  const findings = new Map(state.ignored.findings);
  findings.set(ignoreKey, entry);
  return { ...state, ignored: { ...state.ignored, findings } };
}

/**
 * Tombstone an existing finding-ignore entry. Preserves ruleId / blockHash /
 * match from the original so peers can still inspect the lineage; only sets
 * `tombstone: true` and bumps `ts`.
 */
export function unignoreFinding(state, { ignoreKey, ts }) {
  if (typeof ignoreKey !== 'string') return state;
  const prev = state.ignored.findings.get(ignoreKey);
  if (!prev) return state;
  const findings = new Map(state.ignored.findings);
  findings.set(ignoreKey, { ...prev, tombstone: true, ts: typeof ts === 'number' ? ts : Date.now() });
  return { ...state, ignored: { ...state.ignored, findings } };
}

/**
 * Per-key remote update — LWW-by-timestamp, ties broken by authorId
 * lexicographic order for deterministic convergence.
 */
export function applyRemoteIgnored(state, args) {
  if (!args || typeof args !== 'object') return state;
  const { key, entry } = args;
  if (typeof key !== 'string' || !entry || typeof entry !== 'object') return state;
  if (typeof entry.ts !== 'number') return state;
  const prev = state.ignored.findings.get(key);
  if (prev) {
    if (prev.ts > entry.ts) return state;
    if (prev.ts === entry.ts) {
      // Lex tiebreak: smaller authorId wins (deterministic on both sides).
      // Empty-id case (`'' <= ''`) returns local-state on both peers — safe in
      // practice because in-room peers always carry a real authorId (the name
      // prompt in `useCollabSession` gates the WebSocketProvider until identity
      // is set). Out-of-room writes never reach this verb.
      if ((prev.authorId || '') <= (entry.authorId || '')) return state;
    }
  }
  const findings = new Map(state.ignored.findings);
  findings.set(key, { ...entry });
  return { ...state, ignored: { ...state.ignored, findings } };
}

/** Adds a NLP-rule mute entry. Silently no-ops on non-NLP rule ids. */
export function muteNlpRule(state, { ruleId, identity, ts }) {
  if (typeof ruleId !== 'string' || !ruleId.startsWith('NLP-')) return state;
  const entry = {
    ts: typeof ts === 'number' ? ts : Date.now(),
    authorId: identity?.id || '',
  };
  const mutedRules = new Map(state.ignored.mutedRules);
  mutedRules.set(ruleId, entry);
  return { ...state, ignored: { ...state.ignored, mutedRules } };
}

/** Tombstone a mute entry. No-op if rule absent. */
export function unmuteNlpRule(state, { ruleId, ts }) {
  if (typeof ruleId !== 'string') return state;
  const prev = state.ignored.mutedRules.get(ruleId);
  if (!prev) return state;
  const mutedRules = new Map(state.ignored.mutedRules);
  mutedRules.set(ruleId, { ...prev, tombstone: true, ts: typeof ts === 'number' ? ts : Date.now() });
  return { ...state, ignored: { ...state.ignored, mutedRules } };
}

/** Per-rule remote update — LWW with authorId tiebreak. */
export function applyRemoteMutedRule(state, args) {
  if (!args || typeof args !== 'object') return state;
  const { ruleId, entry } = args;
  if (typeof ruleId !== 'string' || !entry || typeof entry !== 'object') return state;
  if (typeof entry.ts !== 'number') return state;
  const prev = state.ignored.mutedRules.get(ruleId);
  if (prev) {
    if (prev.ts > entry.ts) return state;
    if (prev.ts === entry.ts) {
      // Lex tiebreak: smaller authorId wins (deterministic on both sides).
      // Empty-id case (`'' <= ''`) returns local-state on both peers — safe in
      // practice because in-room peers always carry a real authorId (the name
      // prompt in `useCollabSession` gates the WebSocketProvider until identity
      // is set). Out-of-room writes never reach this verb.
      if ((prev.authorId || '') <= (entry.authorId || '')) return state;
    }
  }
  const mutedRules = new Map(state.ignored.mutedRules);
  mutedRules.set(ruleId, { ...entry });
  return { ...state, ignored: { ...state.ignored, mutedRules } };
}

/**
 * Tombstone every dismissal + mute. Preserves keys so peers see explicit
 * tombstone writes for convergence. Race window: a peer's concurrent dismiss
 * landing AFTER this transaction is NOT retroactively cleared.
 */
export function resetIgnored(state, { ts } = {}) {
  const stamp = typeof ts === 'number' ? ts : Date.now();
  if (state.ignored.findings.size === 0 && state.ignored.mutedRules.size === 0) {
    return state;
  }
  const findings = new Map();
  for (const [k, v] of state.ignored.findings) {
    findings.set(k, { ...v, tombstone: true, ts: stamp });
  }
  const mutedRules = new Map();
  for (const [k, v] of state.ignored.mutedRules) {
    mutedRules.set(k, { ...v, tombstone: true, ts: stamp });
  }
  return { ...state, ignored: { findings, mutedRules } };
}

/**
 * Partial reset: tombstone findings only. Used by the Settings "Reset ignored
 * findings" button when the UX requires independent reset of the two columns.
 */
export function resetIgnoredFindings(state, { ts } = {}) {
  if (state.ignored.findings.size === 0) return state;
  const stamp = typeof ts === 'number' ? ts : Date.now();
  const findings = new Map();
  for (const [k, v] of state.ignored.findings) {
    findings.set(k, { ...v, tombstone: true, ts: stamp });
  }
  return { ...state, ignored: { ...state.ignored, findings } };
}

/** Partial reset: tombstone mutedRules only. */
export function resetMutedRules(state, { ts } = {}) {
  if (state.ignored.mutedRules.size === 0) return state;
  const stamp = typeof ts === 'number' ? ts : Date.now();
  const mutedRules = new Map();
  for (const [k, v] of state.ignored.mutedRules) {
    mutedRules.set(k, { ...v, tombstone: true, ts: stamp });
  }
  return { ...state, ignored: { ...state.ignored, mutedRules } };
}

/**
 * Bulk merge for `initial: true` handleSync payload. LWW per key over
 * remoteMap ∪ local; local-only entries preserved unconditionally (never
 * tombstoned by absence — ignores use never-delete tombstones so peer
 * deletions arrive AS entries with tombstone:true, never as absence).
 */
export function mergeRemoteIgnored(state, remoteMap) {
  if (!(remoteMap instanceof Map)) return state;
  if (remoteMap.size === 0) return state;
  let next = state;
  for (const [key, entry] of remoteMap) {
    next = applyRemoteIgnored(next, { key, entry });
  }
  return next;
}

/** Same semantics as mergeRemoteIgnored, for mutedRules. */
export function mergeRemoteMutedRules(state, remoteMap) {
  if (!(remoteMap instanceof Map)) return state;
  if (remoteMap.size === 0) return state;
  let next = state;
  for (const [ruleId, entry] of remoteMap) {
    next = applyRemoteMutedRule(next, { ruleId, entry });
  }
  return next;
}

/**
 * Merge sidecar payload into state. LWW per key; local-only entries preserved.
 * Caller gates to file-mode (in collab mode the room is authoritative).
 */
export function prefillIgnored(state, { findings, mutedRules }) {
  let next = state;
  if (Array.isArray(findings)) {
    for (const f of findings) {
      if (!f || typeof f.ignoreKey !== 'string') continue;
      const entry = {
        ruleId: f.ruleId,
        blockHash: f.blockHash,
        match: f.match,
        authorId: f.authorId || '',
        ts: typeof f.ts === 'number' ? f.ts : 0,
      };
      if (f.tombstone === true) entry.tombstone = true;
      next = applyRemoteIgnored(next, { key: f.ignoreKey, entry });
    }
  }
  if (Array.isArray(mutedRules)) {
    for (const r of mutedRules) {
      if (!r || typeof r.ruleId !== 'string') continue;
      const entry = {
        authorId: r.authorId || '',
        ts: typeof r.ts === 'number' ? r.ts : 0,
      };
      if (r.tombstone === true) entry.tombstone = true;
      next = applyRemoteMutedRule(next, { ruleId: r.ruleId, entry });
    }
  }
  return next;
}
