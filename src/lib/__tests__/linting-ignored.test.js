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

describe('linting / ignoreFinding', () => {
  const identity = { id: 'u-1', name: 'Alice', color: '#abc' };

  it('adds an IgnoreEntry keyed by ignoreKey', () => {
    const s0 = L.createInitial();
    const s1 = L.ignoreFinding(s0, {
      ignoreKey: 'k1', ruleId: 'TERM-shall', blockHash: 'bh', match: 'shall',
      identity, ts: 1000,
    });
    expect(s1.ignored.findings.get('k1')).toMatchObject({
      ruleId: 'TERM-shall', blockHash: 'bh', match: 'shall',
      ts: 1000, authorId: 'u-1',
    });
    expect(s1.ignored.findings.get('k1').tombstone).toBeFalsy();
  });

  it('overwrites existing entry on duplicate key with newer ts', () => {
    const s0 = L.createInitial();
    const s1 = L.ignoreFinding(s0, { ignoreKey: 'k1', ruleId: 'R', blockHash: 'bh', match: 'm', identity, ts: 1000 });
    const s2 = L.ignoreFinding(s1, { ignoreKey: 'k1', ruleId: 'R', blockHash: 'bh', match: 'm', identity, ts: 2000 });
    expect(s2.ignored.findings.get('k1').ts).toBe(2000);
  });

  it('returns same state ref on missing required fields', () => {
    const s0 = L.createInitial();
    expect(L.ignoreFinding(s0, { ignoreKey: 'k1', ruleId: 'R' /* no blockHash/match */, identity, ts: 1 })).toBe(s0);
  });
});

describe('linting / unignoreFinding', () => {
  it('writes tombstone preserving original ruleId / blockHash / match', () => {
    let s = L.createInitial();
    s = L.ignoreFinding(s, { ignoreKey: 'k1', ruleId: 'R', blockHash: 'bh', match: 'm', identity: { id: 'u' }, ts: 1 });
    s = L.unignoreFinding(s, { ignoreKey: 'k1', ts: 2 });
    expect(s.ignored.findings.get('k1').tombstone).toBe(true);
    expect(s.ignored.findings.get('k1').ts).toBe(2);
    expect(s.ignored.findings.get('k1').ruleId).toBe('R');
  });

  it('returns same state ref when key absent', () => {
    const s0 = L.createInitial();
    expect(L.unignoreFinding(s0, { ignoreKey: 'absent', ts: 1 })).toBe(s0);
  });

  it('isFindingIgnored returns false after tombstone', () => {
    let s = L.createInitial();
    s = L.ignoreFinding(s, { ignoreKey: 'k1', ruleId: 'R', blockHash: 'bh', match: 'm', identity: { id: 'u' }, ts: 1 });
    s = L.unignoreFinding(s, { ignoreKey: 'k1', ts: 2 });
    expect(L.isFindingIgnored(s, 'k1')).toBe(false);
  });
});

describe('linting / applyRemoteIgnored', () => {
  it('overwrites local when remote ts is newer (LWW)', () => {
    let s = L.createInitial();
    s = L.ignoreFinding(s, { ignoreKey: 'k1', ruleId: 'R', blockHash: 'bh', match: 'm', identity: { id: 'a' }, ts: 1 });
    s = L.applyRemoteIgnored(s, { key: 'k1', entry: { ruleId: 'R', blockHash: 'bh', match: 'm', authorId: 'b', ts: 2 } });
    expect(s.ignored.findings.get('k1').authorId).toBe('b');
  });

  it('preserves local when local ts is newer', () => {
    let s = L.createInitial();
    s = L.ignoreFinding(s, { ignoreKey: 'k1', ruleId: 'R', blockHash: 'bh', match: 'm', identity: { id: 'a' }, ts: 10 });
    s = L.applyRemoteIgnored(s, { key: 'k1', entry: { ruleId: 'R', blockHash: 'bh', match: 'm', authorId: 'b', ts: 5 } });
    expect(s.ignored.findings.get('k1').authorId).toBe('a');
  });

  it('breaks ts ties by authorId lexicographic order (deterministic)', () => {
    let s = L.createInitial();
    s = L.ignoreFinding(s, { ignoreKey: 'k1', ruleId: 'R', blockHash: 'bh', match: 'm', identity: { id: 'b' }, ts: 10 });
    s = L.applyRemoteIgnored(s, { key: 'k1', entry: { ruleId: 'R', blockHash: 'bh', match: 'm', authorId: 'a', ts: 10 } });
    // 'a' < 'b' so remote wins
    expect(s.ignored.findings.get('k1').authorId).toBe('a');
  });

  it('inserts entry when key absent locally', () => {
    let s = L.createInitial();
    s = L.applyRemoteIgnored(s, { key: 'k1', entry: { ruleId: 'R', blockHash: 'bh', match: 'm', authorId: 'b', ts: 1 } });
    expect(s.ignored.findings.has('k1')).toBe(true);
  });

  it('returns same state ref on invalid input', () => {
    const s0 = L.createInitial();
    expect(L.applyRemoteIgnored(s0, null)).toBe(s0);
    expect(L.applyRemoteIgnored(s0, { key: null, entry: {} })).toBe(s0);
  });
});

describe('linting / muteNlpRule', () => {
  it('adds a MuteEntry for a NLP-* rule id', () => {
    const s = L.muteNlpRule(L.createInitial(), { ruleId: 'NLP-passive', identity: { id: 'a' }, ts: 1 });
    expect(s.ignored.mutedRules.get('NLP-passive')).toMatchObject({ ts: 1, authorId: 'a' });
    expect(L.isNlpRuleMuted(s, 'NLP-passive')).toBe(true);
  });

  it('silently no-ops on non-NLP rule (e.g. TERM-shall)', () => {
    const s0 = L.createInitial();
    expect(L.muteNlpRule(s0, { ruleId: 'TERM-shall', identity: { id: 'a' }, ts: 1 })).toBe(s0);
  });

  it('silently no-ops on invalid input', () => {
    const s0 = L.createInitial();
    expect(L.muteNlpRule(s0, { ruleId: null, identity: { id: 'a' }, ts: 1 })).toBe(s0);
  });
});

describe('linting / unmuteNlpRule', () => {
  it('writes tombstone and selector returns false', () => {
    let s = L.createInitial();
    s = L.muteNlpRule(s, { ruleId: 'NLP-passive', identity: { id: 'a' }, ts: 1 });
    s = L.unmuteNlpRule(s, { ruleId: 'NLP-passive', ts: 2 });
    expect(s.ignored.mutedRules.get('NLP-passive').tombstone).toBe(true);
    expect(L.isNlpRuleMuted(s, 'NLP-passive')).toBe(false);
  });

  it('returns same state ref when rule not present', () => {
    const s0 = L.createInitial();
    expect(L.unmuteNlpRule(s0, { ruleId: 'NLP-passive', ts: 1 })).toBe(s0);
  });
});

describe('linting / applyRemoteMutedRule', () => {
  it('LWW per ruleId', () => {
    let s = L.createInitial();
    s = L.muteNlpRule(s, { ruleId: 'NLP-passive', identity: { id: 'a' }, ts: 5 });
    s = L.applyRemoteMutedRule(s, { ruleId: 'NLP-passive', entry: { authorId: 'b', ts: 10 } });
    expect(s.ignored.mutedRules.get('NLP-passive').authorId).toBe('b');
  });

  it('preserves local when local ts newer', () => {
    let s = L.createInitial();
    s = L.muteNlpRule(s, { ruleId: 'NLP-passive', identity: { id: 'a' }, ts: 10 });
    s = L.applyRemoteMutedRule(s, { ruleId: 'NLP-passive', entry: { authorId: 'b', ts: 5 } });
    expect(s.ignored.mutedRules.get('NLP-passive').authorId).toBe('a');
  });

  it('breaks ts ties by authorId', () => {
    let s = L.createInitial();
    s = L.muteNlpRule(s, { ruleId: 'NLP-passive', identity: { id: 'b' }, ts: 10 });
    s = L.applyRemoteMutedRule(s, { ruleId: 'NLP-passive', entry: { authorId: 'a', ts: 10 } });
    expect(s.ignored.mutedRules.get('NLP-passive').authorId).toBe('a');
  });
});
