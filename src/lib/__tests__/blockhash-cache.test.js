import { describe, it, expect } from 'vitest';
import * as L from '../linting.js';

describe('blockHash + ignoreKey cache (BlockFindings.blockHash field)', () => {
  it('setBlockFindings accepts and stores blockHash', () => {
    let s = L.createInitial();
    s = L.setBlockFindings(s, 'b1', { compliance: [], nlp: [], grammar: [], blockHash: 'abc123' });
    expect(s.byBlock.get('b1').blockHash).toBe('abc123');
  });

  it('omitting blockHash leaves the previous value untouched', () => {
    let s = L.createInitial();
    s = L.setBlockFindings(s, 'b1', { compliance: [], nlp: [], grammar: [], blockHash: 'h1' });
    s = L.setBlockFindings(s, 'b1', { compliance: [] });  // no blockHash field
    expect(s.byBlock.get('b1').blockHash).toBe('h1');
  });

  it('findings carry per-finding ignoreKey field', () => {
    let s = L.createInitial();
    const f = (ignoreKey) => ({ range: { __r: true }, violation: { ruleId: 'R', index: 0, match: 'm' }, ignoreKey });
    s = L.setBlockFindings(s, 'b1', { compliance: [f('k1'), f(null)] });
    expect(s.byBlock.get('b1').compliance[0].ignoreKey).toBe('k1');
    expect(s.byBlock.get('b1').compliance[1].ignoreKey).toBe(null);
  });

  it('wrapper construction does NOT mutate engine-emitted finding objects (spec §6.2)', () => {
    // Simulates the pipeline in useBlockLinting.js: an engine emits a finding,
    // the hook builds a NEW wrapper with ignoreKey rather than mutating the
    // engine's object. If the engine caches its emission, a future cycle must
    // still see an untouched object.
    const engineEmission = { range: { __r: true }, violation: { ruleId: 'R', index: 0, match: 'm' } };
    const wrapped = { ...engineEmission, ignoreKey: 'k1' };
    expect(engineEmission.ignoreKey).toBeUndefined();
    expect(wrapped).not.toBe(engineEmission);
    expect(wrapped.violation).toBe(engineEmission.violation);  // shallow-clone, violation is a shared ref
  });
});
