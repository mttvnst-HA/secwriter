import { describe, it, expect } from 'vitest';
import * as L from '../linting.js';

describe('linting / ignored state shape', () => {
  it('createInitial includes empty ignored.findings and ignored.mutedRules Maps', () => {
    const s = L.createInitial();
    expect(s.ignored).toBeDefined();
    expect(s.ignored.findings).toBeInstanceOf(Map);
    expect(s.ignored.findings.size).toBe(0);
    expect(s.ignored.mutedRules).toBeInstanceOf(Map);
    expect(s.ignored.mutedRules.size).toBe(0);
  });

  it('createInitial preserves enabled flag', () => {
    const s = L.createInitial({ enabled: false });
    expect(s.enabled).toBe(false);
    expect(s.ignored.findings.size).toBe(0);
  });
});

describe('linting / selectors', () => {
  it('isFindingIgnored returns false for unknown key', () => {
    const s = L.createInitial();
    expect(L.isFindingIgnored(s, 'unknown')).toBe(false);
  });

  it('isNlpRuleMuted returns false for unknown rule', () => {
    const s = L.createInitial();
    expect(L.isNlpRuleMuted(s, 'NLP-passive')).toBe(false);
  });

  it('getIgnoredCount returns 0 for empty state', () => {
    const s = L.createInitial();
    expect(L.getIgnoredCount(s)).toBe(0);
  });
});

describe('linting / computeIgnoreKey', () => {
  it('returns 24-character hex string', async () => {
    const key = await L.computeIgnoreKey('TERM-shall', 'abc123def4567890abcd1234', 'shall');
    expect(key).toMatch(/^[0-9a-f]{24}$/);
  });

  it('is deterministic for same inputs', async () => {
    const k1 = await L.computeIgnoreKey('TERM-shall', 'aaaa', 'shall');
    const k2 = await L.computeIgnoreKey('TERM-shall', 'aaaa', 'shall');
    expect(k1).toBe(k2);
  });

  it('differs when ruleId changes', async () => {
    const k1 = await L.computeIgnoreKey('TERM-shall', 'aaaa', 'shall');
    const k2 = await L.computeIgnoreKey('TERM-should', 'aaaa', 'shall');
    expect(k1).not.toBe(k2);
  });

  it('does not collide on pipe characters in match field (regression — joined-string keying would collide)', async () => {
    const k1 = await L.computeIgnoreKey('R-1', 'block1', 'a|b');
    const k2 = await L.computeIgnoreKey('R-1', 'block1|', 'b');
    expect(k1).not.toBe(k2);
  });
});
