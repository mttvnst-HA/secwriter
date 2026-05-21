import { describe, it, expect } from 'vitest';
import { encodeSidecar, encodeSidecarV2 } from '../lint-sidecar.js';

const IDENT = (id = 'u') => ({ id });
const findings = (ignored) => ignored || [];

describe('encodeSidecar v2', () => {
  it('emits v1 shape when ignoredFindings + mutedNlpRules are both empty', async () => {
    const out = await encodeSidecarV2(new Map(), [], { ignoredFindings: [], mutedNlpRules: [] });
    expect(out.v).toBe(1);
    expect('ignoredFindings' in out).toBe(false);
  });

  it('emits v2 shape when ignoredFindings non-empty', async () => {
    const out = await encodeSidecarV2(new Map(), [], {
      ignoredFindings: [{ ignoreKey: 'k1', ruleId: 'R', blockHash: 'bh', match: 'm', ts: 1, authorId: 'a' }],
      mutedNlpRules: [],
    });
    expect(out.v).toBe(2);
    expect(out.ignoredFindings).toHaveLength(1);
    expect(out.ignoredFindings[0].ignoreKey).toBe('k1');
  });

  it('emits v2 shape when mutedNlpRules non-empty', async () => {
    const out = await encodeSidecarV2(new Map(), [], {
      ignoredFindings: [],
      mutedNlpRules: [{ ruleId: 'NLP-passive', ts: 1, authorId: 'a' }],
    });
    expect(out.v).toBe(2);
    expect(out.mutedNlpRules).toHaveLength(1);
  });

  it('preserves tombstone flag through encode', async () => {
    const out = await encodeSidecarV2(new Map(), [], {
      ignoredFindings: [{ ignoreKey: 'k1', ruleId: 'R', blockHash: 'bh', match: 'm', ts: 1, authorId: 'a', tombstone: true }],
      mutedNlpRules: [],
    });
    expect(out.ignoredFindings[0].tombstone).toBe(true);
  });

  it('sorts arrays by key for deterministic byte-stable output', async () => {
    const out = await encodeSidecarV2(new Map(), [], {
      ignoredFindings: [
        { ignoreKey: 'k2', ruleId: 'R', blockHash: 'bh', match: 'm', ts: 1, authorId: 'a' },
        { ignoreKey: 'k1', ruleId: 'R', blockHash: 'bh', match: 'm', ts: 1, authorId: 'a' },
      ],
      mutedNlpRules: [
        { ruleId: 'NLP-mood-indicative', ts: 1, authorId: 'a' },
        { ruleId: 'NLP-passive', ts: 1, authorId: 'a' },
      ],
    });
    expect(out.ignoredFindings.map(e => e.ignoreKey)).toEqual(['k1', 'k2']);
    expect(out.mutedNlpRules.map(e => e.ruleId)).toEqual(['NLP-mood-indicative', 'NLP-passive']);
  });

  it('round-trips byte-stable across two encode calls with identical input', async () => {
    const ignored = {
      ignoredFindings: [
        { ignoreKey: 'k1', ruleId: 'R', blockHash: 'bh', match: 'm', ts: 1, authorId: 'a' },
      ],
      mutedNlpRules: [],
    };
    const a = await encodeSidecarV2(new Map(), [], ignored);
    const b = await encodeSidecarV2(new Map(), [], ignored);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
