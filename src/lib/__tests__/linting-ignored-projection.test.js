import { describe, it, expect } from 'vitest';
import * as L from '../linting.js';

describe('linting / projection-layer dedup (engine stores undeduped)', () => {
  // This test acts as a contract: useBlockLinting.js MUST store engine output
  // verbatim in byBlock. Dedup runs in getRangesByTier (covered later).
  it('setBlockFindings stores compliance + nlp + grammar without inter-tier filtering', () => {
    const violation = (ruleId, idx, match) => ({ ruleId, index: idx, match, severity: 'medium' });
    const finding = (v) => ({ range: { __r: true }, violation: v });
    let s = L.createInitial();
    const complianceFindings = [finding(violation('TERM-shall', 10, 'shall'))];
    const nlpFindings = [finding(violation('NLP-passive', 10, 'shall be'))];  // overlaps deliberately
    s = L.setBlockFindings(s, 'b1', { compliance: complianceFindings, nlp: nlpFindings, grammar: [] });
    expect(s.byBlock.get('b1').compliance).toHaveLength(1);
    expect(s.byBlock.get('b1').nlp).toHaveLength(1);  // overlap NOT removed here
  });
});

describe('linting / getRangesByTier projection', () => {
  // Build a block whose findings have known ignoreKey + violation positions.
  function buildState({ compliance = [], nlp = [], grammar = [], blockHash = 'bh' } = {}) {
    let s = L.createInitial();
    s = L.setBlockFindings(s, 'b1', {
      compliance: compliance.map((f, i) => ({ range: { __r: i, kind: 'c' }, violation: f, ignoreKey: f.ignoreKey || null })),
      nlp:        nlp.map((f, i) => ({ range: { __r: i, kind: 'n' }, violation: f, ignoreKey: f.ignoreKey || null })),
      grammar:    grammar.map((f, i) => ({ range: { __r: i, kind: 'g' }, violation: f, ignoreKey: f.ignoreKey || null })),
      blockHash,
    });
    return s;
  }
  const violation = (ruleId, idx, match) => ({ ruleId, index: idx, match, severity: 'medium' });

  it('filters out findings whose ignoreKey is in ignored.findings', () => {
    let s = buildState({ compliance: [{ ...violation('TERM-shall', 10, 'shall'), ignoreKey: 'k1' }] });
    s = L.ignoreFinding(s, { ignoreKey: 'k1', ruleId: 'TERM-shall', blockHash: 'bh', match: 'shall', identity: { id: 'a' }, ts: 1 });
    const r = L.getRangesByTier(s);
    expect(r.compliance).toHaveLength(0);
  });

  it('does NOT filter findings with null ignoreKey (hash cache not populated yet)', () => {
    const s = buildState({ compliance: [{ ...violation('R', 0, 'm'), ignoreKey: null }] });
    const r = L.getRangesByTier(s);
    expect(r.compliance).toHaveLength(1);
  });

  it('filters NLP findings whose ruleId is in mutedRules', () => {
    let s = buildState({ nlp: [{ ...violation('NLP-passive', 5, 'is done'), ignoreKey: 'k2' }] });
    s = L.muteNlpRule(s, { ruleId: 'NLP-passive', identity: { id: 'a' }, ts: 1 });
    expect(L.getRangesByTier(s).nlp).toHaveLength(0);
  });

  it('dedupes NLP against compliance overlaps after ignore-filter (dismiss-static-surfaces-NLP)', () => {
    // Compliance + NLP overlap; both unignored: NLP is dedup-suppressed.
    let s = buildState({
      compliance: [{ ...violation('TERM-shall', 10, 'shall'), ignoreKey: 'kc' }],
      nlp:        [{ ...violation('NLP-passive', 8, 'shall be'), ignoreKey: 'kn' }],
    });
    expect(L.getRangesByTier(s).nlp).toHaveLength(0);  // suppressed by overlap
    expect(L.getRangesByTier(s).compliance).toHaveLength(1);

    // Now dismiss the compliance finding → NLP should resurface.
    s = L.ignoreFinding(s, { ignoreKey: 'kc', ruleId: 'TERM-shall', blockHash: 'bh', match: 'shall', identity: { id: 'a' }, ts: 1 });
    expect(L.getRangesByTier(s).compliance).toHaveLength(0);
    expect(L.getRangesByTier(s).nlp).toHaveLength(1);  // resurfaces
  });

  it('dedupes grammar against compliance+nlp after ignore-filter', () => {
    let s = buildState({
      compliance: [{ ...violation('TERM-shall', 10, 'shall'), ignoreKey: 'kc' }],
      grammar:    [{ ...violation('GRAMMAR-Agreement', 8, 'shall be'), ignoreKey: 'kg' }],
    });
    expect(L.getRangesByTier(s).grammar).toHaveLength(0);  // suppressed by >50% overlap
    s = L.ignoreFinding(s, { ignoreKey: 'kc', ruleId: 'TERM-shall', blockHash: 'bh', match: 'shall', identity: { id: 'a' }, ts: 1 });
    expect(L.getRangesByTier(s).grammar).toHaveLength(1);  // resurfaces
  });

  it('return value is NOT a Promise (sync structural assertion)', () => {
    const s = buildState();
    const r = L.getRangesByTier(s);
    expect(r).not.toBeInstanceOf(Promise);
    expect(r.compliance).toBeInstanceOf(Array);
  });
});
