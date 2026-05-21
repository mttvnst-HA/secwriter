import { describe, it, expect } from 'vitest';
import * as L from '../linting.js';

// ── Test fixtures ────────────────────────────────────────────────────────────

function v(ruleId, index, match, severity = 'medium', extra = {}) {
  return { ruleId, index, match, severity, ...extra };
}

function f(violation, range = { __range: true }) {
  return { range, violation };
}

// ── Pure helpers ─────────────────────────────────────────────────────────────

describe('linting / pure helpers', () => {
  describe('isDeferredRule', () => {
    // Per #156, the four formerly deferred rules (TERM-suitable, TERM-any,
    // TERM-should, VAGUE-applicable) now run inline via POS-window + quote
    // tracking in compliance-rules.js. DEFERRED_TO_PANEL is empty.
    it('returns false for the four formerly deferred rule ids', () => {
      expect(L.isDeferredRule({ ruleId: 'TERM-suitable' })).toBe(false);
      expect(L.isDeferredRule({ ruleId: 'TERM-any' })).toBe(false);
      expect(L.isDeferredRule({ ruleId: 'TERM-should' })).toBe(false);
      expect(L.isDeferredRule({ ruleId: 'VAGUE-applicable' })).toBe(false);
    });

    it('does not defer ordinary static rules', () => {
      expect(L.isDeferredRule({ ruleId: 'TERM-shall' })).toBe(false);
      expect(L.isDeferredRule({ ruleId: 'TERM-001' })).toBe(false);
    });
  });

  describe('intervalsOverlap', () => {
    it('detects strict overlap', () => {
      expect(L.intervalsOverlap(0, 10, 5, 15)).toBe(true);
    });
    it('treats touching intervals as non-overlapping (half-open)', () => {
      expect(L.intervalsOverlap(0, 5, 5, 10)).toBe(false);
    });
    it('detects containment in either direction', () => {
      expect(L.intervalsOverlap(0, 10, 3, 7)).toBe(true);
      expect(L.intervalsOverlap(3, 7, 0, 10)).toBe(true);
    });
    it('rejects disjoint intervals', () => {
      expect(L.intervalsOverlap(0, 5, 6, 10)).toBe(false);
    });
  });

  describe('dedupNlpAgainstCompliance', () => {
    it('drops NLP findings whose range overlaps any compliance finding', () => {
      const nlp = [v('NLP-passive', 10, 'is provided'), v('NLP-passive', 50, 'was tested')];
      const compliance = [v('TERM-shall', 12, 'shall')];
      const out = L.dedupNlpAgainstCompliance(nlp, compliance);
      expect(out).toHaveLength(1);
      expect(out[0].index).toBe(50);
    });

    it('preserves NLP findings disjoint from compliance', () => {
      const nlp = [v('NLP-passive', 10, 'is provided')];
      const compliance = [v('TERM-shall', 30, 'shall')];
      expect(L.dedupNlpAgainstCompliance(nlp, compliance)).toHaveLength(1);
    });

    it('returns input unchanged when either side is empty', () => {
      const nlp = [v('NLP-passive', 0, 'foo')];
      expect(L.dedupNlpAgainstCompliance(nlp, [])).toBe(nlp);
      expect(L.dedupNlpAgainstCompliance([], nlp)).toEqual([]);
    });
  });

  describe('dedupGrammarAgainstFindings', () => {
    it('drops grammar findings with >50% overlap with another finding', () => {
      const grammar = [v('SPELL-x', 0, 'shallow')];     // length 7
      const others = [v('TERM-shall', 0, 'shall')];     // length 5, overlap = 5, > 7*0.5
      expect(L.dedupGrammarAgainstFindings(grammar, others)).toHaveLength(0);
    });

    it('keeps grammar findings with ≤50% overlap', () => {
      const grammar = [v('SPELL-x', 0, 'shallowness')];  // length 11
      const others = [v('TERM-shall', 0, 'shall')];      // length 5, overlap = 5, < 11*0.5
      expect(L.dedupGrammarAgainstFindings(grammar, others)).toHaveLength(1);
    });

    it('respects custom threshold', () => {
      const grammar = [v('SPELL-x', 0, 'abcdef')]; // 6
      const others = [v('TERM-y', 0, 'abc')];       // 3, overlap = 3
      // threshold 0.4 → 6*0.4=2.4, overlap 3 > 2.4 → drop
      expect(L.dedupGrammarAgainstFindings(grammar, others, 0.4)).toHaveLength(0);
      // threshold 0.6 → 6*0.6=3.6, overlap 3 < 3.6 → keep
      expect(L.dedupGrammarAgainstFindings(grammar, others, 0.6)).toHaveLength(1);
    });

    it('returns input unchanged when either side is empty', () => {
      const g = [v('SPELL-x', 0, 'foo')];
      expect(L.dedupGrammarAgainstFindings(g, [])).toBe(g);
      expect(L.dedupGrammarAgainstFindings([], g)).toEqual([]);
    });
  });

  describe('pickHighestSeverityFinding', () => {
    it('returns the highest-severity finding', () => {
      const findings = [
        f(v('a', 0, 'x', 'low')),
        f(v('b', 0, 'x', 'high')),
        f(v('c', 0, 'x', 'medium')),
      ];
      expect(L.pickHighestSeverityFinding(findings).violation.ruleId).toBe('b');
    });

    it('returns null on empty input', () => {
      expect(L.pickHighestSeverityFinding([])).toBeNull();
    });

    it('treats unknown severity as low', () => {
      const findings = [
        f(v('a', 0, 'x', 'mystery')),
        f(v('b', 0, 'x', 'high')),
      ];
      expect(L.pickHighestSeverityFinding(findings).violation.ruleId).toBe('b');
    });
  });
});

// ── Reducer state ────────────────────────────────────────────────────────────

describe('linting / reducer', () => {
  describe('createInitial', () => {
    it('starts enabled by default', () => {
      const s = L.createInitial();
      expect(s.enabled).toBe(true);
      expect(s.suspended).toBe(false);
      expect(s.byBlock.size).toBe(0);
    });

    it('honors enabled override', () => {
      expect(L.createInitial({ enabled: false }).enabled).toBe(false);
    });
  });

  describe('setEnabled / setSuspended', () => {
    it('returns new state when value changes', () => {
      const s0 = L.createInitial();
      const s1 = L.setEnabled(s0, false);
      expect(s1).not.toBe(s0);
      expect(s1.enabled).toBe(false);
    });

    it('returns same ref when value unchanged (React bail-out)', () => {
      const s0 = L.createInitial();
      expect(L.setEnabled(s0, true)).toBe(s0);
      expect(L.setSuspended(s0, false)).toBe(s0);
    });

    it('isActive reflects both flags', () => {
      let s = L.createInitial();
      expect(L.isActive(s)).toBe(true);
      s = L.setSuspended(s, true);
      expect(L.isActive(s)).toBe(false);
      s = L.setSuspended(s, false);
      s = L.setEnabled(s, false);
      expect(L.isActive(s)).toBe(false);
    });
  });

  describe('setBlockFindings', () => {
    it('inserts findings for a new block', () => {
      const s0 = L.createInitial();
      const s1 = L.setBlockFindings(s0, 'b1', { compliance: [f(v('TERM-shall', 0, 'shall'))] });
      expect(s1.byBlock.get('b1').compliance).toHaveLength(1);
      expect(s1.byBlock.get('b1').nlp).toEqual([]);
      expect(s1.byBlock.get('b1').grammar).toEqual([]);
    });

    it('preserves omitted fields on update', () => {
      const s0 = L.createInitial();
      const fc = [f(v('TERM-shall', 0, 'shall'))];
      const fn = [f(v('NLP-passive', 5, 'is provided'))];
      const s1 = L.setBlockFindings(s0, 'b1', { compliance: fc });
      const s2 = L.setBlockFindings(s1, 'b1', { nlp: fn });
      expect(s2.byBlock.get('b1').compliance).toBe(fc);
      expect(s2.byBlock.get('b1').nlp).toBe(fn);
    });

    it('returns same ref when partial matches existing fields', () => {
      const s0 = L.createInitial();
      const findings = [f(v('TERM-shall', 0, 'shall'))];
      const s1 = L.setBlockFindings(s0, 'b1', { compliance: findings });
      const s2 = L.setBlockFindings(s1, 'b1', { compliance: findings });
      expect(s2).toBe(s1);
    });

    it('returns same ref when empty partial matches empty existing', () => {
      const s0 = L.createInitial();
      const s1 = L.setBlockFindings(s0, 'b1', { compliance: [] });
      // s1.byBlock has 'b1' with empty compliance
      // setting compliance: [] (a new array ref) won't match → s2 != s1
      // setting same ref → s3 == s2
      const same = s1.byBlock.get('b1').compliance;
      const s2 = L.setBlockFindings(s1, 'b1', { compliance: same });
      expect(s2).toBe(s1);
    });

    it('updates grammarText snapshot independently', () => {
      let s = L.createInitial();
      s = L.setBlockFindings(s, 'b1', { grammarText: 'hello world' });
      expect(L.getGrammarText(s, 'b1')).toBe('hello world');
    });
  });

  describe('clearBlock / clearAll', () => {
    it('clearBlock removes one block', () => {
      let s = L.createInitial();
      s = L.setBlockFindings(s, 'b1', { compliance: [f(v('a', 0, 'x'))] });
      s = L.setBlockFindings(s, 'b2', { compliance: [f(v('b', 0, 'y'))] });
      s = L.clearBlock(s, 'b1');
      expect(s.byBlock.has('b1')).toBe(false);
      expect(s.byBlock.has('b2')).toBe(true);
    });

    it('clearBlock returns same ref when block absent', () => {
      const s0 = L.createInitial();
      expect(L.clearBlock(s0, 'b-missing')).toBe(s0);
    });

    it('clearAll preserves enabled/suspended', () => {
      let s = L.createInitial({ enabled: true });
      s = L.setSuspended(s, true);
      s = L.setBlockFindings(s, 'b1', { compliance: [f(v('a', 0, 'x'))] });
      const cleared = L.clearAll(s);
      expect(cleared.enabled).toBe(true);
      expect(cleared.suspended).toBe(true);
      expect(cleared.byBlock.size).toBe(0);
    });

    it('clearAll returns same ref when already empty', () => {
      const s0 = L.createInitial();
      expect(L.clearAll(s0)).toBe(s0);
    });
  });

  describe('pruneOrphanedBlocks (#148)', () => {
    it('drops byBlock entries whose id is not in liveIds', () => {
      let s = L.createInitial();
      s = L.setBlockFindings(s, 'b1', { compliance: [f(v('a', 0, 'x'))] });
      s = L.setBlockFindings(s, 'b2', { compliance: [f(v('b', 0, 'y'))] });
      s = L.setBlockFindings(s, 'b3', { compliance: [f(v('c', 0, 'z'))] });

      // Simulate App.jsx: blocks array is now [b1, b3] — b2 was deleted.
      const pruned = L.pruneOrphanedBlocks(s, new Set(['b1', 'b3']));

      expect(pruned.byBlock.has('b1')).toBe(true);
      expect(pruned.byBlock.has('b2')).toBe(false);
      expect(pruned.byBlock.has('b3')).toBe(true);
    });

    it('returns same ref when every byBlock id is live', () => {
      let s = L.createInitial();
      s = L.setBlockFindings(s, 'b1', { compliance: [f(v('a', 0, 'x'))] });
      const liveIds = new Set(['b1', 'b2', 'b3']);
      expect(L.pruneOrphanedBlocks(s, liveIds)).toBe(s);
    });

    it('returns same ref when byBlock is already empty', () => {
      const s0 = L.createInitial();
      expect(L.pruneOrphanedBlocks(s0, new Set(['b1']))).toBe(s0);
    });

    it('drops every entry when liveIds is empty', () => {
      let s = L.createInitial();
      s = L.setBlockFindings(s, 'b1', { compliance: [f(v('a', 0, 'x'))] });
      s = L.setBlockFindings(s, 'b2', { compliance: [f(v('b', 0, 'y'))] });
      const pruned = L.pruneOrphanedBlocks(s, new Set());
      expect(pruned.byBlock.size).toBe(0);
    });

    it('preserves enabled and suspended flags', () => {
      let s = L.createInitial({ enabled: true });
      s = L.setSuspended(s, true);
      s = L.setBlockFindings(s, 'b1', { compliance: [f(v('a', 0, 'x'))] });
      const pruned = L.pruneOrphanedBlocks(s, new Set());
      expect(pruned.enabled).toBe(true);
      expect(pruned.suspended).toBe(true);
    });

    it('regression: create -> lint -> delete sequence does not leak byBlock', () => {
      // Simulates App's lifecycle: user types in block A (findings stored),
      // user clicks block B (A blurs, findings persist across blur per
      // CLAUDE.md "Inline Linting Architecture"), user deletes block A.
      // The App-level prune effect runs whenever `blocks` changes and
      // pruneOrphanedBlocks must drop A's byBlock entry.
      let s = L.createInitial({ enabled: true });

      // Block A focused, findings stored.
      s = L.setBlockFindings(s, 'block-a', {
        compliance: [f(v('TERM-shall', 0, 'shall'))],
        grammarText: 'shall be tested',
      });
      expect(s.byBlock.has('block-a')).toBe(true);

      // User clicks block B — A blurs. Findings persist (no clearBlock
      // dispatch on blur). byBlock still has 'block-a'.
      expect(s.byBlock.has('block-a')).toBe(true);

      // User deletes block A via handleDelete. blocks now contains only
      // [block-b]. The prune effect runs.
      const liveIds = new Set(['block-b']);
      const pruned = L.pruneOrphanedBlocks(s, liveIds);

      expect(pruned.byBlock.has('block-a')).toBe(false);
      // And it really is gone — getBlockFindings reads through the Map.
      expect(L.getBlockFindings(pruned, 'block-a')).toEqual([]);
    });
  });
});

// ── Selectors ────────────────────────────────────────────────────────────────

describe('linting / selectors', () => {
  it('getBlockFindings flattens tiers in compliance→nlp→grammar order', () => {
    let s = L.createInitial();
    s = L.setBlockFindings(s, 'b1', {
      compliance: [f(v('c', 0, 'x'))],
      nlp: [f(v('n', 0, 'y'))],
      grammar: [f(v('g', 0, 'z'))],
    });
    const out = L.getBlockFindings(s, 'b1').map(x => x.violation.ruleId);
    expect(out).toEqual(['c', 'n', 'g']);
  });

  it('getBlockFindings returns [] for unknown block', () => {
    expect(L.getBlockFindings(L.createInitial(), 'nope')).toEqual([]);
  });

  it('getAllFindings flattens across blocks', () => {
    let s = L.createInitial();
    s = L.setBlockFindings(s, 'b1', { compliance: [f(v('c1', 0, 'x'))] });
    s = L.setBlockFindings(s, 'b2', { nlp: [f(v('n1', 0, 'y'))] });
    expect(L.getAllFindings(s)).toHaveLength(2);
  });

  it('getBlockSeverity picks highest across tiers', () => {
    let s = L.createInitial();
    s = L.setBlockFindings(s, 'b1', {
      compliance: [f(v('c', 0, 'x', 'low'))],
      grammar: [f(v('g', 0, 'z', 'high'))],
    });
    expect(L.getBlockSeverity(s, 'b1')).toBe('high');
  });

  it('getBlockSeverity returns null for empty/missing block', () => {
    let s = L.createInitial();
    expect(L.getBlockSeverity(s, 'nope')).toBeNull();
    s = L.setBlockFindings(s, 'b1', { compliance: [] });
    expect(L.getBlockSeverity(s, 'b1')).toBeNull();
  });

  it('getRangesByTier groups ranges by tier and skips null ranges', () => {
    let s = L.createInitial();
    s = L.setBlockFindings(s, 'b1', {
      compliance: [f(v('c', 0, 'x'), { id: 'r1' }), f(v('c', 5, 'y'), null)],
      grammar: [f(v('g', 0, 'z'), { id: 'r2' })],
      nlp: [f(v('n', 0, 'q'), { id: 'r3' })],
    });
    const groups = L.getRangesByTier(s);
    expect(groups.compliance).toHaveLength(1);
    expect(groups.compliance[0]).toEqual({ id: 'r1' });
    expect(groups.grammar).toHaveLength(1);
    expect(groups.nlp).toHaveLength(1);
  });
});

// ── Property tests ───────────────────────────────────────────────────────────
//
// These exercise the core invariants under randomized verb sequences. Per
// ADR-0005, every reducer module ships at least one property test for its
// central invariant.

describe('linting / property tests', () => {
  // Random helper utilities
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

  function randomFindings(rng) {
    const n = rand(rng, 4);
    const out = [];
    for (let i = 0; i < n; i++) {
      out.push(f(v(`R-${i}`, i * 5, 'word', ['low', 'medium', 'high'][rand(rng, 3)])));
    }
    return out;
  }

  // Invariant 1: getRangesByTier counts equal sum-of-tier counts across all blocks.
  it('Invariant: getRangesByTier counts == sum of per-block tier sizes (with non-null ranges)', () => {
    const rng = makeRng(0xdeadbeef);
    const blockIds = ['b1', 'b2', 'b3', 'b4'];
    let s = L.createInitial();
    for (let step = 0; step < 200; step++) {
      const action = rand(rng, 6);
      const id = blockIds[rand(rng, blockIds.length)];
      switch (action) {
        case 0: s = L.setBlockFindings(s, id, { compliance: randomFindings(rng) }); break;
        case 1: s = L.setBlockFindings(s, id, { nlp: randomFindings(rng) }); break;
        case 2: s = L.setBlockFindings(s, id, { grammar: randomFindings(rng) }); break;
        case 3: s = L.clearBlock(s, id); break;
        case 4: s = L.setSuspended(s, !s.suspended); break;
        case 5: s = L.setEnabled(s, !s.enabled); break;
      }
      let cExpected = 0, nExpected = 0, gExpected = 0;
      for (const b of s.byBlock.values()) {
        cExpected += b.compliance.filter(f => f.range).length;
        nExpected += b.nlp.filter(f => f.range).length;
        gExpected += b.grammar.filter(f => f.range).length;
      }
      const groups = L.getRangesByTier(s);
      expect(groups.compliance.length).toBe(cExpected);
      expect(groups.nlp.length).toBe(nExpected);
      expect(groups.grammar.length).toBe(gExpected);
    }
  });

  // Invariant 2: getBlockSeverity matches the min ord across that block's findings.
  it('Invariant: getBlockSeverity equals min severity-ord across that block', () => {
    const rng = makeRng(0xc0ffee);
    let s = L.createInitial();
    const ord = { high: 0, medium: 1, low: 2 };
    for (let step = 0; step < 100; step++) {
      const id = `b${rand(rng, 5)}`;
      s = L.setBlockFindings(s, id, {
        compliance: randomFindings(rng),
        nlp: randomFindings(rng),
        grammar: randomFindings(rng),
      });
      const all = L.getBlockFindings(s, id);
      let expected = null;
      for (const f of all) {
        const sev = f.violation.severity;
        if (!expected || (ord[sev] ?? 2) < (ord[expected] ?? 2)) expected = sev;
      }
      expect(L.getBlockSeverity(s, id)).toBe(expected);
    }
  });

  // Invariant 3: clearAll then setEnabled + setSuspended yields a state equivalent
  // to createInitial({ enabled }) + setSuspended (idempotent under enabled/suspended).
  it('Invariant: clearAll preserves enabled/suspended; createInitial round-trips', () => {
    const rng = makeRng(0xbaadf00d);
    let s = L.createInitial({ enabled: rng() > 0.5 });
    if (rng() > 0.5) s = L.setSuspended(s, true);
    for (let i = 0; i < 20; i++) {
      s = L.setBlockFindings(s, `b${rand(rng, 3)}`, { compliance: randomFindings(rng) });
    }
    const enabledBefore = s.enabled;
    const suspendedBefore = s.suspended;
    const cleared = L.clearAll(s);
    expect(cleared.enabled).toBe(enabledBefore);
    expect(cleared.suspended).toBe(suspendedBefore);
    expect(cleared.byBlock.size).toBe(0);
  });

  // Invariant 4: dedup is monotone — adding more compliance findings only removes NLP.
  it('Invariant: dedupNlpAgainstCompliance is monotone in compliance set', () => {
    const rng = makeRng(0x12345678);
    for (let trial = 0; trial < 30; trial++) {
      const nlp = randomFindings(rng).map(x => x.violation);
      const c1 = randomFindings(rng).map(x => x.violation);
      const c2 = [...c1, ...randomFindings(rng).map(x => x.violation)];
      const out1 = L.dedupNlpAgainstCompliance(nlp, c1);
      const out2 = L.dedupNlpAgainstCompliance(nlp, c2);
      expect(out2.length).toBeLessThanOrEqual(out1.length);
    }
  });
});
