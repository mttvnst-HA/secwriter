import { describe, it, expect } from 'vitest';
import * as L from '../linting.js';

describe('linting / resetIgnored', () => {
  it('tombstones every entry, preserving keys for collab convergence', () => {
    let s = L.createInitial();
    s = L.ignoreFinding(s, { ignoreKey: 'k1', ruleId: 'R', blockHash: 'bh', match: 'm', identity: { id: 'a' }, ts: 1 });
    s = L.muteNlpRule(s, { ruleId: 'NLP-passive', identity: { id: 'a' }, ts: 1 });
    s = L.resetIgnored(s, { ts: 5 });
    expect(s.ignored.findings.get('k1').tombstone).toBe(true);
    expect(s.ignored.mutedRules.get('NLP-passive').tombstone).toBe(true);
    expect(L.getIgnoredCount(s)).toBe(0);
  });
});

describe('linting / resetIgnoredFindings (partial reset)', () => {
  it('tombstones findings only; leaves mutedRules intact', () => {
    let s = L.createInitial();
    s = L.ignoreFinding(s, { ignoreKey: 'k1', ruleId: 'R', blockHash: 'bh', match: 'm', identity: { id: 'a' }, ts: 1 });
    s = L.muteNlpRule(s, { ruleId: 'NLP-passive', identity: { id: 'a' }, ts: 1 });
    s = L.resetIgnoredFindings(s, { ts: 5 });
    expect(s.ignored.findings.get('k1').tombstone).toBe(true);
    expect(s.ignored.mutedRules.get('NLP-passive').tombstone).toBeFalsy();
  });

  it('returns same ref when findings is empty (no allocation)', () => {
    const s = L.createInitial();
    expect(L.resetIgnoredFindings(s, { ts: 1 })).toBe(s);
  });
});

describe('linting / resetMutedRules (partial reset)', () => {
  it('tombstones mutedRules only; leaves findings intact', () => {
    let s = L.createInitial();
    s = L.ignoreFinding(s, { ignoreKey: 'k1', ruleId: 'R', blockHash: 'bh', match: 'm', identity: { id: 'a' }, ts: 1 });
    s = L.muteNlpRule(s, { ruleId: 'NLP-passive', identity: { id: 'a' }, ts: 1 });
    s = L.resetMutedRules(s, { ts: 5 });
    expect(s.ignored.findings.get('k1').tombstone).toBeFalsy();
    expect(s.ignored.mutedRules.get('NLP-passive').tombstone).toBe(true);
  });

  it('returns same ref when mutedRules is empty (no allocation)', () => {
    const s = L.createInitial();
    expect(L.resetMutedRules(s, { ts: 1 })).toBe(s);
  });
});

describe('linting / mergeRemoteIgnored', () => {
  it('LWW per key for overlapping entries', () => {
    let s = L.createInitial();
    s = L.ignoreFinding(s, { ignoreKey: 'k1', ruleId: 'R', blockHash: 'bh', match: 'm', identity: { id: 'a' }, ts: 5 });
    const remote = new Map([
      ['k1', { ruleId: 'R', blockHash: 'bh', match: 'm', authorId: 'b', ts: 10 }],
    ]);
    s = L.mergeRemoteIgnored(s, remote);
    expect(s.ignored.findings.get('k1').authorId).toBe('b');
  });

  it('inserts remote-only entries', () => {
    let s = L.createInitial();
    const remote = new Map([['k2', { ruleId: 'R', blockHash: 'bh', match: 'm', authorId: 'a', ts: 1 }]]);
    s = L.mergeRemoteIgnored(s, remote);
    expect(s.ignored.findings.has('k2')).toBe(true);
  });

  it('preserves local-only entries unconditionally (no seenRemoteIds tombstone-by-absence)', () => {
    let s = L.createInitial();
    s = L.ignoreFinding(s, { ignoreKey: 'k1', ruleId: 'R', blockHash: 'bh', match: 'm', identity: { id: 'a' }, ts: 1 });
    s = L.mergeRemoteIgnored(s, new Map());
    expect(s.ignored.findings.has('k1')).toBe(true);
    expect(s.ignored.findings.get('k1').tombstone).toBeFalsy();
  });

  it('is idempotent under repeated application', () => {
    let s = L.createInitial();
    const remote = new Map([['k1', { ruleId: 'R', blockHash: 'bh', match: 'm', authorId: 'b', ts: 10 }]]);
    s = L.mergeRemoteIgnored(s, remote);
    const s2 = L.mergeRemoteIgnored(s, remote);
    expect(s2.ignored.findings.get('k1')).toEqual(s.ignored.findings.get('k1'));
  });

  it('returns same state ref when remote empty AND no local change needed', () => {
    const s0 = L.createInitial();
    // Empty remote + empty local: must return the same ref (no allocation)
    expect(L.mergeRemoteIgnored(s0, new Map())).toBe(s0);
  });
});

describe('linting / mergeRemoteMutedRules', () => {
  it('LWW per rule + preserves local-only', () => {
    let s = L.createInitial();
    s = L.muteNlpRule(s, { ruleId: 'NLP-passive', identity: { id: 'a' }, ts: 5 });
    const remote = new Map([
      ['NLP-mood-indicative', { authorId: 'b', ts: 10 }],
    ]);
    s = L.mergeRemoteMutedRules(s, remote);
    expect(s.ignored.mutedRules.has('NLP-passive')).toBe(true);
    expect(s.ignored.mutedRules.has('NLP-mood-indicative')).toBe(true);
  });
});

describe('linting / prefillIgnored', () => {
  it('merges sidecar findings with LWW per key', () => {
    let s = L.createInitial();
    s = L.ignoreFinding(s, { ignoreKey: 'k1', ruleId: 'R', blockHash: 'bh', match: 'm', identity: { id: 'a' }, ts: 5 });
    s = L.prefillIgnored(s, {
      findings: [{ ignoreKey: 'k1', ruleId: 'R', blockHash: 'bh', match: 'm', authorId: 'b', ts: 10 }],
      mutedRules: [],
    });
    expect(s.ignored.findings.get('k1').authorId).toBe('b');
  });

  it('preserves local-only entries absent from sidecar', () => {
    let s = L.createInitial();
    s = L.ignoreFinding(s, { ignoreKey: 'k1', ruleId: 'R', blockHash: 'bh', match: 'm', identity: { id: 'a' }, ts: 1 });
    s = L.prefillIgnored(s, { findings: [], mutedRules: [] });
    expect(s.ignored.findings.has('k1')).toBe(true);
  });

  it('handles tombstoned sidecar entries', () => {
    let s = L.createInitial();
    s = L.prefillIgnored(s, {
      findings: [{ ignoreKey: 'k1', ruleId: 'R', blockHash: 'bh', match: 'm', authorId: 'a', ts: 1, tombstone: true }],
      mutedRules: [],
    });
    expect(s.ignored.findings.get('k1').tombstone).toBe(true);
    expect(L.isFindingIgnored(s, 'k1')).toBe(false);
  });
});

describe('linting / ignored property tests', () => {
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

  it('200 randomized verb sequences keep ignored.findings keys monotonic (never lose entries)', () => {
    const rng = makeRng(0xfeed1234);
    let s = L.createInitial();
    let everSeen = new Set();
    for (let i = 0; i < 200; i++) {
      const action = rand(rng, 4);
      const key = `k${rand(rng, 8)}`;
      const ts = i + 1;
      const ruleId = 'NLP-passive';
      switch (action) {
        case 0:
          s = L.ignoreFinding(s, { ignoreKey: key, ruleId: 'R', blockHash: 'bh', match: 'm', identity: { id: 'u' }, ts });
          everSeen.add(key);
          break;
        case 1: s = L.unignoreFinding(s, { ignoreKey: key, ts }); break;
        case 2: s = L.muteNlpRule(s, { ruleId, identity: { id: 'u' }, ts }); break;
        case 3: s = L.unmuteNlpRule(s, { ruleId, ts }); break;
      }
    }
    for (const k of everSeen) expect(s.ignored.findings.has(k)).toBe(true);
  });

  it('mergeRemoteIgnored is idempotent', () => {
    const rng = makeRng(0xc0ffee);
    let s = L.createInitial();
    for (let i = 0; i < 50; i++) {
      const key = `k${rand(rng, 5)}`;
      s = L.ignoreFinding(s, { ignoreKey: key, ruleId: 'R', blockHash: 'bh', match: 'm', identity: { id: 'u' }, ts: i });
    }
    const remote = new Map();
    for (const [k, v] of s.ignored.findings) remote.set(k, v);
    const s2 = L.mergeRemoteIgnored(s, remote);
    const s3 = L.mergeRemoteIgnored(s2, remote);
    expect(s3.ignored.findings.size).toBe(s2.ignored.findings.size);
  });

  it('resetIgnored then ignoreFinding restores entry as non-tombstone', () => {
    let s = L.createInitial();
    s = L.ignoreFinding(s, { ignoreKey: 'k1', ruleId: 'R', blockHash: 'bh', match: 'm', identity: { id: 'a' }, ts: 1 });
    s = L.resetIgnored(s, { ts: 2 });
    expect(s.ignored.findings.get('k1').tombstone).toBe(true);
    s = L.ignoreFinding(s, { ignoreKey: 'k1', ruleId: 'R', blockHash: 'bh', match: 'm', identity: { id: 'a' }, ts: 3 });
    expect(s.ignored.findings.get('k1').tombstone).toBeFalsy();
    expect(L.isFindingIgnored(s, 'k1')).toBe(true);
  });
});
