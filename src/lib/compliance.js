/**
 * Compliance — pure reducer + selectors + fix-computation helpers for
 * the UFS 1-300-02 compliance panel.
 *
 * Per ADR-0005, this is the same shape as track-changes.js, comments.js,
 * and linting.js: opaque state struct, pure verbs, pure selectors,
 * property-tested invariants. Compliance differs from the prior three in
 * one important way — `result` is a *snapshot at scan time*, not a live
 * mirror of `blocks`. After a scan, the user edits blocks; the result
 * becomes stale; the user re-runs. The invariants reflect that.
 *
 * State shape:
 *   {
 *     scope: 'document' | 'part' | 'subsection' | 'block',
 *     status: 'idle' | 'checking' | 'ready',
 *     result: { violations, groups, stats, truncated } | null,
 *     decisions: {
 *       acceptedGroups: Set<ruleId>,
 *       rejectedGroups: Set<ruleId>,
 *       acceptedItems:  Set<itemKey>,   // `${blockId}-${index}`
 *       rejectedItems:  Set<itemKey>,
 *     },
 *     activeGroup: ruleId | null,
 *     ai: {
 *       status: 'idle' | 'running' | 'error',
 *       progress: { chunk, totalChunks, blocksProcessed, totalBlocks } | null,
 *       error: string | null,
 *       sessionTokens: number,
 *     },
 *   }
 *
 * Invariants (property-tested):
 *   I1. After setResult, all decision sets are empty and activeGroup is null.
 *   I2. decisions.{accepted,rejected}Groups ⊆ ruleIds(result.groups).
 *   I3. decisions.{accepted,rejected}Items ⊆ instanceKeys(result.groups).
 *   I4. activeGroup === null || ruleIds(result.groups).includes(activeGroup).
 *   I5. AI lifecycle: any verb sequence keeps ai.status ∈ {idle, running, error};
 *       aiSuccess bumps sessionTokens monotonically and never decreases it.
 *
 * The fix-computation helpers (computeItemFix, computeGroupFixes,
 * computeFormattingFixes) are pure functions over (group|violation|result, blocks)
 * — extracted from the panel's handleAccept* callbacks so they're unit-testable
 * without rendering React.
 */

const STATUS_IDLE = 'idle';
const STATUS_CHECKING = 'checking';
const STATUS_READY = 'ready';

const AI_IDLE = 'idle';
const AI_RUNNING = 'running';
const AI_ERROR = 'error';

const VALID_SCOPES = new Set(['document', 'part', 'subsection', 'block']);

function emptyDecisions() {
  return {
    acceptedGroups: new Set(),
    rejectedGroups: new Set(),
    acceptedItems: new Set(),
    rejectedItems: new Set(),
  };
}

function itemKey(blockId, index) {
  return `${blockId}-${index}`;
}

function hasGroup(result, ruleId) {
  if (!result || !Array.isArray(result.groups)) return false;
  return result.groups.some((g) => g.ruleId === ruleId);
}

function hasInstance(result, blockId, index) {
  if (!result || !Array.isArray(result.groups)) return false;
  return result.groups.some((g) =>
    g.instances.some((v) => v.blockId === blockId && v.index === index)
  );
}

// ── Initial state ───────────────────────────────────────────────────────────

export function createInitial({ scope = 'document' } = {}) {
  return {
    scope,
    status: STATUS_IDLE,
    result: null,
    decisions: emptyDecisions(),
    activeGroup: null,
    ai: {
      status: AI_IDLE,
      progress: null,
      error: null,
      sessionTokens: 0,
    },
  };
}

// ── Verbs (all pure) ────────────────────────────────────────────────────────

export function setScope(state, scope) {
  if (!VALID_SCOPES.has(scope)) return state;
  if (state.scope === scope) return state;
  return { ...state, scope };
}

export function startCheck(state) {
  if (state.status === STATUS_CHECKING) return state;
  return { ...state, status: STATUS_CHECKING };
}

/**
 * Install a fresh result. Resets decisions and clears activeGroup (Invariant I1).
 * Caller passes the value returned by `checkCompliance(...)`.
 */
export function setResult(state, result) {
  return {
    ...state,
    status: STATUS_READY,
    result,
    decisions: emptyDecisions(),
    activeGroup: null,
  };
}

/** Discard the current result and return to idle. */
export function clearResult(state) {
  if (
    state.result === null &&
    state.status === STATUS_IDLE &&
    state.activeGroup === null &&
    state.decisions.acceptedGroups.size === 0 &&
    state.decisions.rejectedGroups.size === 0 &&
    state.decisions.acceptedItems.size === 0 &&
    state.decisions.rejectedItems.size === 0
  ) {
    return state;
  }
  return {
    ...state,
    status: STATUS_IDLE,
    result: null,
    decisions: emptyDecisions(),
    activeGroup: null,
  };
}

/**
 * Set or clear the active group. Pass `null` to deselect.
 * Bails (returns same ref) if the ruleId is unknown or already active.
 */
export function setActiveGroup(state, ruleId) {
  if (state.activeGroup === ruleId) return state;
  if (ruleId !== null && !hasGroup(state.result, ruleId)) return state;
  return { ...state, activeGroup: ruleId };
}

export function acceptGroup(state, ruleId) {
  if (!hasGroup(state.result, ruleId)) return state;
  if (state.decisions.acceptedGroups.has(ruleId)) return state;
  const acceptedGroups = new Set(state.decisions.acceptedGroups);
  acceptedGroups.add(ruleId);
  return {
    ...state,
    decisions: { ...state.decisions, acceptedGroups },
    activeGroup: state.activeGroup === ruleId ? null : state.activeGroup,
  };
}

export function rejectGroup(state, ruleId) {
  if (!hasGroup(state.result, ruleId)) return state;
  if (state.decisions.rejectedGroups.has(ruleId)) return state;
  const rejectedGroups = new Set(state.decisions.rejectedGroups);
  rejectedGroups.add(ruleId);
  return {
    ...state,
    decisions: { ...state.decisions, rejectedGroups },
    activeGroup: state.activeGroup === ruleId ? null : state.activeGroup,
  };
}

export function acceptItem(state, blockId, index) {
  if (!hasInstance(state.result, blockId, index)) return state;
  const key = itemKey(blockId, index);
  if (state.decisions.acceptedItems.has(key)) return state;
  const acceptedItems = new Set(state.decisions.acceptedItems);
  acceptedItems.add(key);
  return { ...state, decisions: { ...state.decisions, acceptedItems } };
}

export function rejectItem(state, blockId, index) {
  if (!hasInstance(state.result, blockId, index)) return state;
  const key = itemKey(blockId, index);
  if (state.decisions.rejectedItems.has(key)) return state;
  const rejectedItems = new Set(state.decisions.rejectedItems);
  rejectedItems.add(key);
  return { ...state, decisions: { ...state.decisions, rejectedItems } };
}

/**
 * Bulk-mark a set of group ruleIds as accepted (used by auto-fix-all FMT).
 * Skips ids unknown to the current result and ids already accepted.
 */
export function markGroupsAccepted(state, ruleIds) {
  if (!Array.isArray(ruleIds) || ruleIds.length === 0) return state;
  if (!state.result) return state;
  const valid = new Set(state.result.groups.map((g) => g.ruleId));
  const novel = ruleIds.filter(
    (id) => valid.has(id) && !state.decisions.acceptedGroups.has(id)
  );
  if (novel.length === 0) return state;
  const acceptedGroups = new Set(state.decisions.acceptedGroups);
  for (const id of novel) acceptedGroups.add(id);
  return { ...state, decisions: { ...state.decisions, acceptedGroups } };
}

// ── AI lifecycle verbs ──────────────────────────────────────────────────────

export function aiStart(state) {
  if (state.ai.status === AI_RUNNING) return state;
  return {
    ...state,
    ai: { ...state.ai, status: AI_RUNNING, progress: null, error: null },
  };
}

export function aiProgress(state, progress) {
  if (state.ai.status !== AI_RUNNING) return state;
  if (state.ai.progress === progress) return state;
  return { ...state, ai: { ...state.ai, progress } };
}

export function aiSuccess(state, tokensUsed = 0) {
  const tokens = Number.isFinite(tokensUsed) && tokensUsed > 0 ? tokensUsed : 0;
  return {
    ...state,
    ai: {
      status: AI_IDLE,
      progress: null,
      error: null,
      sessionTokens: state.ai.sessionTokens + tokens,
    },
  };
}

export function aiError(state, message) {
  return {
    ...state,
    ai: {
      ...state.ai,
      status: AI_ERROR,
      progress: null,
      error: message != null ? String(message) : 'Unknown error',
    },
  };
}

/**
 * Cancel an in-flight AI run. Transitions back to idle without bumping tokens.
 * Distinct from aiSuccess so callers can distinguish "user cancelled" telemetry.
 */
export function aiAbort(state) {
  if (state.ai.status === AI_IDLE) return state;
  return {
    ...state,
    ai: { ...state.ai, status: AI_IDLE, progress: null, error: null },
  };
}

export function aiClearError(state) {
  if (state.ai.status !== AI_ERROR && state.ai.error == null) return state;
  return { ...state, ai: { ...state.ai, status: AI_IDLE, error: null } };
}

// ── Selectors (pure) ────────────────────────────────────────────────────────

export function getScope(state) { return state.scope; }
export function getStatus(state) { return state.status; }
export function getResult(state) { return state.result; }
export function getActiveGroup(state) { return state.activeGroup; }

export function isChecking(state) { return state.status === STATUS_CHECKING; }
export function hasResult(state) { return state.result !== null; }
export function isResultTruncated(state) {
  return !!(state.result && state.result.truncated);
}

/** Return the active group object (or null), looked up from the result. */
export function getActiveGroupObject(state) {
  if (!state.activeGroup || !state.result) return null;
  return state.result.groups.find((g) => g.ruleId === state.activeGroup) || null;
}

export function isGroupAccepted(state, ruleId) {
  return state.decisions.acceptedGroups.has(ruleId);
}

export function isGroupRejected(state, ruleId) {
  return state.decisions.rejectedGroups.has(ruleId);
}

export function isGroupActioned(state, ruleId) {
  return (
    state.decisions.acceptedGroups.has(ruleId) ||
    state.decisions.rejectedGroups.has(ruleId)
  );
}

export function isItemAccepted(state, blockId, index) {
  return state.decisions.acceptedItems.has(itemKey(blockId, index));
}

export function isItemRejected(state, blockId, index) {
  return state.decisions.rejectedItems.has(itemKey(blockId, index));
}

/** Filter visible groups by severity. `filter` is one of 'all'|'high'|'medium'|'low'. */
export function getFilteredGroups(state, filter = 'all') {
  if (!state.result) return [];
  if (filter === 'all') return state.result.groups;
  return state.result.groups.filter((g) => g.severity === filter);
}

export function getFmtCount(state) {
  if (!state.result) return 0;
  return state.result.violations.filter(
    (v) => v.category === 'formatting' && v.fixFn !== null
  ).length;
}

export function getNeedsAICount(state) {
  if (!state.result) return 0;
  return state.result.violations.filter((v) => v.fixFn === null).length;
}

/** Severity-bar percentages summing to 100 (or all 0 when no violations). */
export function getStatsBarPercents(state) {
  if (!state.result || !state.result.stats || state.result.stats.total === 0) {
    return { high: 0, medium: 0, low: 0 };
  }
  const t = state.result.stats.total;
  return {
    high: (state.result.stats.high / t) * 100,
    medium: (state.result.stats.medium / t) * 100,
    low: (state.result.stats.low / t) * 100,
  };
}

export function getAiStatus(state) { return state.ai.status; }
export function isAiRunning(state) { return state.ai.status === AI_RUNNING; }
export function isAiError(state) { return state.ai.status === AI_ERROR; }
export function getAiProgress(state) { return state.ai.progress; }
export function getAiError(state) { return state.ai.error; }
export function getSessionTokens(state) { return state.ai.sessionTokens; }

// ── Pure fix-computation helpers ────────────────────────────────────────────

/**
 * Apply one violation's fixFn to its block's HTML.
 * Returns { blockId, html } when the fix changes the block, null otherwise.
 */
export function computeItemFix(violation, blocks) {
  if (!violation || violation.fixFn == null) return null;
  if (!Array.isArray(blocks)) return null;
  const block = blocks.find((b) => b.id === violation.blockId);
  if (!block || block.html == null) return null;
  try {
    const fixed = violation.fixFn(block.html);
    if (fixed == null || fixed === block.html) return null;
    return { blockId: block.id, html: fixed };
  } catch {
    return null;
  }
}

/**
 * Apply a group's fixFn (one per block — first instance per block wins) to
 * each affected block. Returns Map<blockId, html> of changed blocks.
 */
export function computeGroupFixes(group, blocks) {
  const fixes = new Map();
  if (!group || !Array.isArray(group.instances)) return fixes;
  if (!Array.isArray(blocks)) return fixes;

  const fixFnByBlock = new Map();
  for (const v of group.instances) {
    if (v.fixFn == null) continue;
    if (!fixFnByBlock.has(v.blockId)) fixFnByBlock.set(v.blockId, v.fixFn);
  }

  for (const [blockId, fixFn] of fixFnByBlock) {
    const block = blocks.find((b) => b.id === blockId);
    if (!block || block.html == null) continue;
    try {
      const fixed = fixFn(block.html);
      if (fixed != null && fixed !== block.html) fixes.set(blockId, fixed);
    } catch {
      /* skip blocks where fix throws */
    }
  }
  return fixes;
}

/**
 * Apply every formatting-category fixFn to its block (auto-fix-all).
 * Multiple fixes per block compose left-to-right.
 *
 * Returns:
 *   {
 *     fixes: Map<blockId, html>,   // blocks whose HTML actually changed
 *     ruleIds: string[],            // formatting groups to mark accepted
 *     count: number,                // total formatting violations matched
 *   }
 */
export function computeFormattingFixes(result, blocks) {
  const fixes = new Map();
  if (!result || !Array.isArray(result.violations)) {
    return { fixes, ruleIds: [], count: 0 };
  }
  if (!Array.isArray(blocks)) {
    return { fixes, ruleIds: [], count: 0 };
  }
  const fmt = result.violations.filter(
    (v) => v.category === 'formatting' && v.fixFn !== null
  );
  if (fmt.length === 0) return { fixes, ruleIds: [], count: 0 };

  const fnsByBlock = new Map();
  for (const v of fmt) {
    if (!fnsByBlock.has(v.blockId)) fnsByBlock.set(v.blockId, []);
    fnsByBlock.get(v.blockId).push(v.fixFn);
  }

  for (const [blockId, fns] of fnsByBlock) {
    const block = blocks.find((b) => b.id === blockId);
    if (!block || block.html == null) continue;
    let html = block.html;
    for (const fn of fns) {
      try {
        const r = fn(html);
        if (r != null) html = r;
      } catch {
        /* skip */
      }
    }
    if (html !== block.html) fixes.set(blockId, html);
  }

  const ruleIds = result.groups
    .filter((g) => g.category === 'formatting')
    .map((g) => g.ruleId);

  return { fixes, ruleIds, count: fmt.length };
}
