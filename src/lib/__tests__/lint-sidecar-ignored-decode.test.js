import { describe, it, expect } from 'vitest';
import { decodeSidecarV2 } from '../lint-sidecar.js';

describe('decodeSidecarV2', () => {
  it('decodes v1 payload — ignoredFindings + mutedNlpRules are empty', () => {
    const r = decodeSidecarV2({ v: 1, good: '', bad: {} });
    expect(r.ignoredFindings).toEqual([]);
    expect(r.mutedNlpRules).toEqual([]);
  });

  it('decodes v2 payload round-trip', () => {
    const r = decodeSidecarV2({
      v: 2, good: '', bad: {},
      ignoredFindings: [{ ignoreKey: 'k1', ruleId: 'R', blockHash: 'bh', match: 'm', ts: 1, authorId: 'a' }],
      mutedNlpRules: [{ ruleId: 'NLP-passive', ts: 2, authorId: 'b' }],
    });
    expect(r.ignoredFindings).toHaveLength(1);
    expect(r.ignoredFindings[0].ignoreKey).toBe('k1');
    expect(r.mutedNlpRules[0].ruleId).toBe('NLP-passive');
  });

  it('decodes v3+ future payload preserving v2 fields it understands', () => {
    const r = decodeSidecarV2({
      v: 3, good: '', bad: {},
      ignoredFindings: [{ ignoreKey: 'k1', ruleId: 'R', blockHash: 'bh', match: 'm', ts: 1, authorId: 'a' }],
      futureField: 'ignored-silently',
    });
    expect(r.ignoredFindings).toHaveLength(1);
  });

  it('silently drops malformed entries (load-boundary tolerance)', () => {
    const r = decodeSidecarV2({
      v: 2, good: '', bad: {},
      ignoredFindings: [
        { ignoreKey: 'k1', ruleId: 'R', blockHash: 'bh', match: 'm', ts: 1, authorId: 'a' },
        null,
        { /* no ignoreKey */ ruleId: 'X' },
        { ignoreKey: 42, ruleId: 'R', blockHash: 'bh', match: 'm', ts: 1, authorId: 'a' }, // wrong type
      ],
      mutedNlpRules: [
        { ruleId: 'NLP-passive', ts: 1, authorId: 'a' },
        { /* no ruleId */ ts: 1 },
      ],
    });
    expect(r.ignoredFindings).toHaveLength(1);
    expect(r.mutedNlpRules).toHaveLength(1);
  });

  it('handles nested objects in match field defensively', () => {
    const r = decodeSidecarV2({
      v: 2, good: '', bad: {},
      ignoredFindings: [{ ignoreKey: 'k1', ruleId: 'R', blockHash: 'bh', match: { nested: 'object' }, ts: 1, authorId: 'a' }],
    });
    expect(r.ignoredFindings).toHaveLength(0);  // match must be string
  });

  it('preserves tombstone flag through decode', () => {
    const r = decodeSidecarV2({
      v: 2, good: '', bad: {},
      ignoredFindings: [{ ignoreKey: 'k1', ruleId: 'R', blockHash: 'bh', match: 'm', ts: 1, authorId: 'a', tombstone: true }],
    });
    expect(r.ignoredFindings[0].tombstone).toBe(true);
  });

  it('does not collide on pipe-character matches', () => {
    // Sanity that the encoded shape (which uses ignoreKey, not joined-string key)
    // doesn't lose distinction.
    const r = decodeSidecarV2({
      v: 2, good: '', bad: {},
      ignoredFindings: [
        { ignoreKey: 'A', ruleId: 'R', blockHash: 'bh', match: 'a|b', ts: 1, authorId: 'a' },
        { ignoreKey: 'B', ruleId: 'R', blockHash: 'bh|', match: 'b', ts: 1, authorId: 'a' },
      ],
    });
    expect(r.ignoredFindings).toHaveLength(2);
  });
});
