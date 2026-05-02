import { describe, it, expect } from 'vitest';
import * as C from '../compliance.js';

// ── Test fixtures ────────────────────────────────────────────────────────────

/** Make a fake violation. */
function v(ruleId, blockId, index, match, severity = 'medium', extra = {}) {
  const fixFn = extra.fixFn !== undefined ? extra.fixFn : null;
  return {
    ruleId,
    blockId,
    index,
    match,
    severity,
    message: extra.message || `${ruleId} message`,
    ufsRef: extra.ufsRef || 'UFS x.x',
    category: extra.category || 'terminology',
    fixFn,
    sentence: extra.sentence || `Sentence containing ${match}.`,
  };
}

/** Make a fake group from violations sharing a ruleId. */
function group(ruleId, violations, opts = {}) {
  return {
    ruleId,
    category: opts.category || violations[0].category || 'terminology',
    severity: opts.severity || violations[0].severity || 'medium',
    message: opts.message || violations[0].message,
    ufsRef: opts.ufsRef || 'UFS x.x',
    instances: violations,
    representative: violations[0],
  };
}

/** Make a fake result object. */
function result(groups) {
  const violations = groups.flatMap((g) => g.instances);
  const stats = {
    total: violations.length,
    high: violations.filter((v) => v.severity === 'high').length,
    medium: violations.filter((v) => v.severity === 'medium').length,
    low: violations.filter((v) => v.severity === 'low').length,
  };
  return { violations, groups, stats, truncated: false };
}

/** A standard 3-group test result. */
function sampleResult() {
  const r1 = group('TERM-shall', [
    v('TERM-shall', 'b1', 5, 'shall', 'high'),
    v('TERM-shall', 'b2', 12, 'shall', 'high'),
  ]);
  const r2 = group('VAGUE-suitable', [
    v('VAGUE-suitable', 'b1', 30, 'suitable', 'medium'),
  ]);
  const r3 = group('FMT-spacing', [
    v('FMT-spacing', 'b3', 0, '  ', 'low', { category: 'formatting', fixFn: (h) => h.replace(/  /g, ' ') }),
  ]);
  return result([r1, r2, r3]);
}

// ── createInitial ────────────────────────────────────────────────────────────

describe('compliance / createInitial', () => {
  it('starts in idle status with no result, no decisions, scope=document', () => {
    const s = C.createInitial();
    expect(s.scope).toBe('document');
    expect(s.status).toBe('idle');
    expect(s.result).toBeNull();
    expect(s.activeGroup).toBeNull();
    expect(s.decisions.acceptedGroups.size).toBe(0);
    expect(s.decisions.rejectedGroups.size).toBe(0);
    expect(s.decisions.acceptedItems.size).toBe(0);
    expect(s.decisions.rejectedItems.size).toBe(0);
    expect(s.ai.status).toBe('idle');
    expect(s.ai.progress).toBeNull();
    expect(s.ai.error).toBeNull();
    expect(s.ai.sessionTokens).toBe(0);
  });

  it('honors scope override', () => {
    expect(C.createInitial({ scope: 'block' }).scope).toBe('block');
  });
});

// ── setScope ────────────────────────────────────────────────────────────────

describe('compliance / setScope', () => {
  it('updates scope to a valid value', () => {
    const s0 = C.createInitial();
    const s1 = C.setScope(s0, 'part');
    expect(s1.scope).toBe('part');
    expect(s1).not.toBe(s0);
  });

  it('returns same ref when scope unchanged (React bail-out)', () => {
    const s0 = C.createInitial();
    expect(C.setScope(s0, 'document')).toBe(s0);
  });

  it('rejects invalid scope values', () => {
    const s0 = C.createInitial();
    expect(C.setScope(s0, 'bogus')).toBe(s0);
    expect(C.setScope(s0, '')).toBe(s0);
  });
});

// ── startCheck / setResult / clearResult ────────────────────────────────────

describe('compliance / scan lifecycle', () => {
  it('startCheck transitions idle → checking', () => {
    const s = C.startCheck(C.createInitial());
    expect(s.status).toBe('checking');
  });

  it('startCheck is idempotent while already checking', () => {
    const s1 = C.startCheck(C.createInitial());
    expect(C.startCheck(s1)).toBe(s1);
  });

  it('setResult installs result and transitions to ready', () => {
    const r = sampleResult();
    const s = C.setResult(C.startCheck(C.createInitial()), r);
    expect(s.status).toBe('ready');
    expect(s.result).toBe(r);
  });

  it('setResult resets decisions and activeGroup (Invariant I1)', () => {
    let s = C.setResult(C.createInitial(), sampleResult());
    s = C.acceptGroup(s, 'TERM-shall');
    s = C.rejectItem(s, 'b1', 30);
    s = C.setActiveGroup(s, 'VAGUE-suitable');
    const s2 = C.setResult(s, sampleResult());
    expect(s2.decisions.acceptedGroups.size).toBe(0);
    expect(s2.decisions.rejectedGroups.size).toBe(0);
    expect(s2.decisions.acceptedItems.size).toBe(0);
    expect(s2.decisions.rejectedItems.size).toBe(0);
    expect(s2.activeGroup).toBeNull();
  });

  it('clearResult returns to idle and clears state', () => {
    let s = C.setResult(C.createInitial(), sampleResult());
    s = C.acceptGroup(s, 'TERM-shall');
    s = C.clearResult(s);
    expect(s.status).toBe('idle');
    expect(s.result).toBeNull();
    expect(s.activeGroup).toBeNull();
    expect(s.decisions.acceptedGroups.size).toBe(0);
  });

  it('clearResult on already-clean state returns same ref', () => {
    const s0 = C.createInitial();
    expect(C.clearResult(s0)).toBe(s0);
  });
});

// ── setActiveGroup ──────────────────────────────────────────────────────────

describe('compliance / setActiveGroup', () => {
  it('selects a known group', () => {
    const s = C.setActiveGroup(C.setResult(C.createInitial(), sampleResult()), 'TERM-shall');
    expect(s.activeGroup).toBe('TERM-shall');
  });

  it('clears with null', () => {
    let s = C.setResult(C.createInitial(), sampleResult());
    s = C.setActiveGroup(s, 'TERM-shall');
    s = C.setActiveGroup(s, null);
    expect(s.activeGroup).toBeNull();
  });

  it('rejects unknown ruleIds (Invariant I4)', () => {
    const s = C.setResult(C.createInitial(), sampleResult());
    expect(C.setActiveGroup(s, 'nope').activeGroup).toBeNull();
  });

  it('returns same ref when ruleId unchanged', () => {
    const s = C.setActiveGroup(C.setResult(C.createInitial(), sampleResult()), 'TERM-shall');
    expect(C.setActiveGroup(s, 'TERM-shall')).toBe(s);
  });
});

// ── acceptGroup / rejectGroup ────────────────────────────────────────────────

describe('compliance / acceptGroup + rejectGroup', () => {
  it('acceptGroup records decision and clears activeGroup if matching', () => {
    let s = C.setResult(C.createInitial(), sampleResult());
    s = C.setActiveGroup(s, 'TERM-shall');
    s = C.acceptGroup(s, 'TERM-shall');
    expect(s.decisions.acceptedGroups.has('TERM-shall')).toBe(true);
    expect(s.activeGroup).toBeNull();
  });

  it('acceptGroup leaves a different activeGroup intact', () => {
    let s = C.setResult(C.createInitial(), sampleResult());
    s = C.setActiveGroup(s, 'VAGUE-suitable');
    s = C.acceptGroup(s, 'TERM-shall');
    expect(s.activeGroup).toBe('VAGUE-suitable');
  });

  it('rejectGroup records decision and clears activeGroup if matching', () => {
    let s = C.setResult(C.createInitial(), sampleResult());
    s = C.setActiveGroup(s, 'TERM-shall');
    s = C.rejectGroup(s, 'TERM-shall');
    expect(s.decisions.rejectedGroups.has('TERM-shall')).toBe(true);
    expect(s.activeGroup).toBeNull();
  });

  it('rejects unknown ruleIds (Invariant I2)', () => {
    const s = C.setResult(C.createInitial(), sampleResult());
    expect(C.acceptGroup(s, 'nope')).toBe(s);
    expect(C.rejectGroup(s, 'nope')).toBe(s);
  });

  it('rejects when no result is loaded', () => {
    const s = C.createInitial();
    expect(C.acceptGroup(s, 'anything')).toBe(s);
  });

  it('idempotent on duplicate accept/reject', () => {
    let s = C.setResult(C.createInitial(), sampleResult());
    s = C.acceptGroup(s, 'TERM-shall');
    expect(C.acceptGroup(s, 'TERM-shall')).toBe(s);
  });
});

// ── acceptItem / rejectItem ─────────────────────────────────────────────────

describe('compliance / acceptItem + rejectItem', () => {
  it('records item-level decision keyed by blockId-index', () => {
    let s = C.setResult(C.createInitial(), sampleResult());
    s = C.acceptItem(s, 'b1', 5);
    expect(C.isItemAccepted(s, 'b1', 5)).toBe(true);
    expect(C.isItemAccepted(s, 'b2', 12)).toBe(false);
  });

  it('rejects items not present in any group (Invariant I3)', () => {
    const s = C.setResult(C.createInitial(), sampleResult());
    expect(C.acceptItem(s, 'b9', 999)).toBe(s);
  });

  it('idempotent on duplicate item accept/reject', () => {
    let s = C.setResult(C.createInitial(), sampleResult());
    s = C.acceptItem(s, 'b1', 5);
    expect(C.acceptItem(s, 'b1', 5)).toBe(s);
  });
});

// ── markGroupsAccepted ──────────────────────────────────────────────────────

describe('compliance / markGroupsAccepted', () => {
  it('bulk-accepts a set of group ruleIds', () => {
    let s = C.setResult(C.createInitial(), sampleResult());
    s = C.markGroupsAccepted(s, ['TERM-shall', 'FMT-spacing']);
    expect(s.decisions.acceptedGroups.has('TERM-shall')).toBe(true);
    expect(s.decisions.acceptedGroups.has('FMT-spacing')).toBe(true);
    expect(s.decisions.acceptedGroups.has('VAGUE-suitable')).toBe(false);
  });

  it('skips unknown ruleIds and ids already accepted', () => {
    let s = C.setResult(C.createInitial(), sampleResult());
    s = C.acceptGroup(s, 'TERM-shall');
    const s2 = C.markGroupsAccepted(s, ['TERM-shall', 'nope', 'FMT-spacing']);
    expect(s2.decisions.acceptedGroups.size).toBe(2);
  });

  it('returns same ref when all ids unknown or already accepted', () => {
    const s = C.setResult(C.createInitial(), sampleResult());
    expect(C.markGroupsAccepted(s, ['nope'])).toBe(s);
    expect(C.markGroupsAccepted(s, [])).toBe(s);
  });
});

// ── AI lifecycle ────────────────────────────────────────────────────────────

describe('compliance / AI lifecycle', () => {
  it('aiStart transitions idle → running and clears progress/error', () => {
    let s = C.aiError(C.createInitial(), 'old');
    s = C.aiStart(s);
    expect(s.ai.status).toBe('running');
    expect(s.ai.progress).toBeNull();
    expect(s.ai.error).toBeNull();
  });

  it('aiStart is no-op while already running', () => {
    const s = C.aiStart(C.createInitial());
    expect(C.aiStart(s)).toBe(s);
  });

  it('aiProgress only fires while running', () => {
    const s0 = C.createInitial();
    expect(C.aiProgress(s0, { chunk: 1, totalChunks: 3 })).toBe(s0);
    const s1 = C.aiProgress(C.aiStart(s0), { chunk: 1, totalChunks: 3 });
    expect(s1.ai.progress).toEqual({ chunk: 1, totalChunks: 3 });
  });

  it('aiSuccess returns to idle and bumps sessionTokens monotonically', () => {
    let s = C.aiStart(C.createInitial());
    s = C.aiSuccess(s, 1500);
    expect(s.ai.status).toBe('idle');
    expect(s.ai.sessionTokens).toBe(1500);
    s = C.aiSuccess(C.aiStart(s), 800);
    expect(s.ai.sessionTokens).toBe(2300);
  });

  it('aiSuccess ignores non-finite or negative tokens', () => {
    let s = C.aiSuccess(C.aiStart(C.createInitial()), -10);
    expect(s.ai.sessionTokens).toBe(0);
    s = C.aiSuccess(C.aiStart(s), NaN);
    expect(s.ai.sessionTokens).toBe(0);
  });

  it('aiError captures message and transitions to error state', () => {
    const s = C.aiError(C.aiStart(C.createInitial()), 'bad request');
    expect(s.ai.status).toBe('error');
    expect(s.ai.error).toBe('bad request');
  });

  it('aiAbort transitions running → idle without bumping tokens', () => {
    let s = C.aiStart(C.createInitial());
    s = C.aiProgress(s, { chunk: 1, totalChunks: 2 });
    s = C.aiAbort(s);
    expect(s.ai.status).toBe('idle');
    expect(s.ai.sessionTokens).toBe(0);
  });

  it('aiAbort on idle state returns same ref', () => {
    const s = C.createInitial();
    expect(C.aiAbort(s)).toBe(s);
  });

  it('aiClearError moves error → idle', () => {
    let s = C.aiError(C.aiStart(C.createInitial()), 'oops');
    s = C.aiClearError(s);
    expect(s.ai.status).toBe('idle');
    expect(s.ai.error).toBeNull();
  });

  it('aiClearError on clean state returns same ref', () => {
    const s = C.createInitial();
    expect(C.aiClearError(s)).toBe(s);
  });
});

// ── Selectors ───────────────────────────────────────────────────────────────

describe('compliance / selectors', () => {
  it('hasResult / isChecking / isResultTruncated reflect state', () => {
    let s = C.createInitial();
    expect(C.hasResult(s)).toBe(false);
    s = C.startCheck(s);
    expect(C.isChecking(s)).toBe(true);
    s = C.setResult(s, sampleResult());
    expect(C.hasResult(s)).toBe(true);
    expect(C.isResultTruncated(s)).toBe(false);
    const trunc = { ...sampleResult(), truncated: true };
    s = C.setResult(s, trunc);
    expect(C.isResultTruncated(s)).toBe(true);
  });

  it('getActiveGroupObject returns the group, or null', () => {
    let s = C.setResult(C.createInitial(), sampleResult());
    expect(C.getActiveGroupObject(s)).toBeNull();
    s = C.setActiveGroup(s, 'TERM-shall');
    expect(C.getActiveGroupObject(s).ruleId).toBe('TERM-shall');
  });

  it('getFilteredGroups filters by severity', () => {
    const s = C.setResult(C.createInitial(), sampleResult());
    expect(C.getFilteredGroups(s, 'all')).toHaveLength(3);
    expect(C.getFilteredGroups(s, 'high')).toHaveLength(1);
    expect(C.getFilteredGroups(s, 'medium')).toHaveLength(1);
    expect(C.getFilteredGroups(s, 'low')).toHaveLength(1);
  });

  it('getFilteredGroups returns [] without a result', () => {
    expect(C.getFilteredGroups(C.createInitial(), 'all')).toEqual([]);
  });

  it('getFmtCount and getNeedsAICount partition violations by fixability', () => {
    const r = sampleResult();
    // Add an AI-only violation
    const aiV = v('AI-only', 'b1', 100, 'word', 'medium', { fixFn: null });
    r.groups.push(group('AI-only', [aiV]));
    r.violations.push(aiV);
    const s = C.setResult(C.createInitial(), r);
    expect(C.getFmtCount(s)).toBe(1);
    expect(C.getNeedsAICount(s)).toBeGreaterThanOrEqual(1);
  });

  it('getStatsBarPercents handles zero-violation case', () => {
    const empty = { violations: [], groups: [], stats: { total: 0, high: 0, medium: 0, low: 0 }, truncated: false };
    const s = C.setResult(C.createInitial(), empty);
    expect(C.getStatsBarPercents(s)).toEqual({ high: 0, medium: 0, low: 0 });
  });

  it('getStatsBarPercents sums to ~100 with violations', () => {
    const s = C.setResult(C.createInitial(), sampleResult());
    const p = C.getStatsBarPercents(s);
    expect(p.high + p.medium + p.low).toBeCloseTo(100, 5);
  });

  it('isGroupActioned covers both accepted and rejected', () => {
    let s = C.setResult(C.createInitial(), sampleResult());
    s = C.acceptGroup(s, 'TERM-shall');
    s = C.rejectGroup(s, 'VAGUE-suitable');
    expect(C.isGroupActioned(s, 'TERM-shall')).toBe(true);
    expect(C.isGroupActioned(s, 'VAGUE-suitable')).toBe(true);
    expect(C.isGroupActioned(s, 'FMT-spacing')).toBe(false);
  });
});

// ── Pure fix-computation helpers ────────────────────────────────────────────

describe('compliance / computeItemFix', () => {
  const fixV = v('TERM-shall', 'b1', 0, 'shall', 'high', {
    fixFn: (h) => h.replace(/shall/g, 'must'),
  });
  const blocks = [
    { id: 'b1', html: 'The Contractor shall provide.' },
    { id: 'b2', html: 'No matches here.' },
  ];

  it('returns { blockId, html } when fix applies', () => {
    const out = C.computeItemFix(fixV, blocks);
    expect(out).toEqual({ blockId: 'b1', html: 'The Contractor must provide.' });
  });

  it('returns null when fixFn is null', () => {
    const noFix = v('VAGUE-x', 'b1', 0, 'foo', 'medium', { fixFn: null });
    expect(C.computeItemFix(noFix, blocks)).toBeNull();
  });

  it('returns null when block missing', () => {
    expect(C.computeItemFix(v('R', 'gone', 0, 'x', 'low', { fixFn: (h) => h }), blocks)).toBeNull();
  });

  it('returns null when fix returns same html', () => {
    const idV = v('R', 'b2', 0, 'x', 'low', { fixFn: (h) => h });
    expect(C.computeItemFix(idV, blocks)).toBeNull();
  });

  it('swallows fixFn exceptions', () => {
    const throwV = v('R', 'b1', 0, 'x', 'low', {
      fixFn: () => { throw new Error('boom'); },
    });
    expect(C.computeItemFix(throwV, blocks)).toBeNull();
  });
});

describe('compliance / computeGroupFixes', () => {
  it('applies first fixFn per block across instances', () => {
    const v1 = v('TERM-shall', 'b1', 5, 'shall', 'high', {
      fixFn: (h) => h.replace(/shall/g, 'must'),
    });
    const v2 = v('TERM-shall', 'b1', 20, 'shall', 'high', { fixFn: () => null });
    const v3 = v('TERM-shall', 'b2', 0, 'shall', 'high', {
      fixFn: (h) => h.replace(/shall/g, 'must'),
    });
    const g = group('TERM-shall', [v1, v2, v3]);
    const blocks = [
      { id: 'b1', html: 'shall ok shall' },
      { id: 'b2', html: 'shall' },
    ];
    const fixes = C.computeGroupFixes(g, blocks);
    expect(fixes.size).toBe(2);
    expect(fixes.get('b1')).toBe('must ok must');
    expect(fixes.get('b2')).toBe('must');
  });

  it('skips violations with null fixFn', () => {
    const v1 = v('R', 'b1', 0, 'shall', 'high', { fixFn: null });
    const g = group('R', [v1]);
    expect(C.computeGroupFixes(g, [{ id: 'b1', html: 'shall' }]).size).toBe(0);
  });

  it('returns empty Map for null/empty group', () => {
    expect(C.computeGroupFixes(null, []).size).toBe(0);
    expect(C.computeGroupFixes({ instances: [] }, []).size).toBe(0);
  });
});

describe('compliance / computeFormattingFixes', () => {
  it('composes multiple FMT fixes per block left-to-right', () => {
    const v1 = v('FMT-1', 'b1', 0, '  ', 'low', {
      category: 'formatting',
      fixFn: (h) => h.replace(/  /g, ' '),
    });
    const v2 = v('FMT-2', 'b1', 5, ',', 'low', {
      category: 'formatting',
      fixFn: (h) => h.replace(/,/g, ';'),
    });
    const r = result([group('FMT-1', [v1], { category: 'formatting' }), group('FMT-2', [v2], { category: 'formatting' })]);
    const blocks = [{ id: 'b1', html: 'a  b, c' }];
    const out = C.computeFormattingFixes(r, blocks);
    expect(out.fixes.get('b1')).toBe('a b; c');
    expect(out.ruleIds).toEqual(['FMT-1', 'FMT-2']);
    expect(out.count).toBe(2);
  });

  it('ignores non-formatting categories', () => {
    const v1 = v('TERM-shall', 'b1', 0, 'shall', 'high', {
      fixFn: (h) => h.replace(/shall/g, 'must'),
    });
    const r = result([group('TERM-shall', [v1])]);
    const out = C.computeFormattingFixes(r, [{ id: 'b1', html: 'shall' }]);
    expect(out.count).toBe(0);
    expect(out.fixes.size).toBe(0);
  });

  it('handles missing or null result gracefully', () => {
    expect(C.computeFormattingFixes(null, []).count).toBe(0);
    expect(C.computeFormattingFixes({ violations: [] }, []).count).toBe(0);
  });
});

// ── Property tests ──────────────────────────────────────────────────────────

describe('compliance / property tests', () => {
  function rand(rng, n) { return Math.floor(rng() * n); }
  function makeRng(seed) {
    let s = seed >>> 0 || 1;
    return () => {
      s = Math.imul(s ^ (s >>> 16), 2246822507) >>> 0;
      s = Math.imul(s ^ (s >>> 13), 3266489909) >>> 0;
      s ^= s >>> 16;
      return (s >>> 0) / 0xffffffff;
    };
  }

  // Invariant I2 + I3: decision sets are subsets of result keys after any
  // sequence of verbs.
  it('Invariant I2/I3: decisions ⊆ result keys after random verb sequences', () => {
    const rng = makeRng(0xfeedface);
    let s = C.createInitial();
    const r = sampleResult();
    s = C.setResult(s, r);
    const ruleIds = r.groups.map((g) => g.ruleId);
    const itemKeys = r.violations.map((v) => `${v.blockId}-${v.index}`);

    for (let step = 0; step < 200; step++) {
      const action = rand(rng, 8);
      switch (action) {
        case 0: s = C.acceptGroup(s, ruleIds[rand(rng, ruleIds.length)]); break;
        case 1: s = C.rejectGroup(s, ruleIds[rand(rng, ruleIds.length)]); break;
        case 2: {
          const v = r.violations[rand(rng, r.violations.length)];
          s = C.acceptItem(s, v.blockId, v.index); break;
        }
        case 3: {
          const v = r.violations[rand(rng, r.violations.length)];
          s = C.rejectItem(s, v.blockId, v.index); break;
        }
        case 4: s = C.acceptGroup(s, 'BOGUS'); break; // should be no-op
        case 5: s = C.acceptItem(s, 'no-block', 9999); break; // should be no-op
        case 6: s = C.markGroupsAccepted(s, [ruleIds[rand(rng, ruleIds.length)]]); break;
        case 7: s = C.setActiveGroup(s, ruleIds[rand(rng, ruleIds.length)]); break;
      }
      // I2
      for (const id of s.decisions.acceptedGroups) expect(ruleIds).toContain(id);
      for (const id of s.decisions.rejectedGroups) expect(ruleIds).toContain(id);
      // I3
      for (const k of s.decisions.acceptedItems) expect(itemKeys).toContain(k);
      for (const k of s.decisions.rejectedItems) expect(itemKeys).toContain(k);
      // I4
      if (s.activeGroup !== null) expect(ruleIds).toContain(s.activeGroup);
    }
  });

  // Invariant I1: setResult always clears decisions and activeGroup.
  it('Invariant I1: setResult clears all decisions and activeGroup', () => {
    const rng = makeRng(0xc0ffee);
    let s = C.setResult(C.createInitial(), sampleResult());
    const ruleIds = s.result.groups.map((g) => g.ruleId);
    for (let trial = 0; trial < 30; trial++) {
      // Random walk into dirty state.
      for (let i = 0; i < 8; i++) {
        const id = ruleIds[rand(rng, ruleIds.length)];
        if (rng() < 0.5) s = C.acceptGroup(s, id);
        else s = C.rejectGroup(s, id);
        if (rng() < 0.3) s = C.setActiveGroup(s, id);
      }
      const reset = C.setResult(s, sampleResult());
      expect(reset.decisions.acceptedGroups.size).toBe(0);
      expect(reset.decisions.rejectedGroups.size).toBe(0);
      expect(reset.decisions.acceptedItems.size).toBe(0);
      expect(reset.decisions.rejectedItems.size).toBe(0);
      expect(reset.activeGroup).toBeNull();
      s = reset;
    }
  });

  // Invariant I5: AI lifecycle never produces an illegal status; sessionTokens
  // is monotonically non-decreasing across verb sequences.
  it('Invariant I5: AI status stays in {idle, running, error}; sessionTokens monotone', () => {
    const rng = makeRng(0xbada55);
    let s = C.createInitial();
    let lastTokens = 0;
    const valid = new Set(['idle', 'running', 'error']);
    for (let step = 0; step < 300; step++) {
      const action = rand(rng, 6);
      switch (action) {
        case 0: s = C.aiStart(s); break;
        case 1: s = C.aiProgress(s, { chunk: rand(rng, 10), totalChunks: 10 }); break;
        case 2: s = C.aiSuccess(s, rand(rng, 1000)); break;
        case 3: s = C.aiError(s, `err-${step}`); break;
        case 4: s = C.aiAbort(s); break;
        case 5: s = C.aiClearError(s); break;
      }
      expect(valid.has(s.ai.status)).toBe(true);
      expect(s.ai.sessionTokens).toBeGreaterThanOrEqual(lastTokens);
      lastTokens = s.ai.sessionTokens;
    }
  });
});
