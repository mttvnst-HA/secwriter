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
