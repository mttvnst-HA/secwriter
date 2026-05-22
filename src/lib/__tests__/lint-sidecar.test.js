import { describe, it, expect } from 'vitest';
import {
  fingerprintBlock,
  encodeSidecar,
  decodeSidecar,
  projectDecoded,
} from '../lint-sidecar.js';
import * as linting from '../linting.js';

// ── Test fixtures ────────────────────────────────────────────────────────────

function v(ruleId, index, match, severity = 'medium', extra = {}) {
  return { ruleId, index, match, severity, ...extra };
}
function f(violation) {
  // Sidecar callers attach a live DOM Range here; the encode path strips it.
  return { range: { _live: true }, violation };
}

const SAMPLE_BLOCKS = [
  { id: 'n1', type: 'note', html: 'NOTE: example block.' },
  { id: 'n2', type: 'txt', html: 'Contractor shall provide widgets.' },
  { id: 'n3', type: 'txt', html: 'Furnish equipment as required.' },
  { id: 'n4', type: 'txt', html: '' }, // empty, but cached as clean
];

// ── fingerprintBlock ─────────────────────────────────────────────────────────

describe('fingerprintBlock', () => {
  it('produces 24 hex chars (96 bits)', async () => {
    const fp = await fingerprintBlock('hello world');
    expect(fp).toMatch(/^[0-9a-f]{24}$/);
  });

  it('is deterministic across runs', async () => {
    const a = await fingerprintBlock('Contractor shall provide widgets.');
    const b = await fingerprintBlock('Contractor shall provide widgets.');
    expect(a).toBe(b);
  });

  it('differs for different inputs', async () => {
    const a = await fingerprintBlock('one');
    const b = await fingerprintBlock('two');
    expect(a).not.toBe(b);
  });

  it('handles empty / non-string inputs without throwing', async () => {
    const a = await fingerprintBlock('');
    const b = await fingerprintBlock(null);
    const c = await fingerprintBlock(undefined);
    expect(a).toMatch(/^[0-9a-f]{24}$/);
    expect(b).toBe(a);
    expect(c).toBe(a);
  });

  it('is sensitive to a single-byte change', async () => {
    const a = await fingerprintBlock('foo');
    const b = await fingerprintBlock('fop');
    expect(a).not.toBe(b);
  });
});

// ── encodeSidecar / decodeSidecar ────────────────────────────────────────────

describe('encodeSidecar', () => {
  it('returns the v1 envelope shape', async () => {
    const payload = await encodeSidecar(new Map(), SAMPLE_BLOCKS);
    expect(payload.v).toBe(1);
    expect(typeof payload.good).toBe('string');
    expect(payload.bad).toEqual({});
  });

  it('packs clean blocks into `good` and dirty into `bad`', async () => {
    const byBlock = new Map([
      ['n1', { compliance: [], nlp: [], grammar: [], grammarText: null }],
      ['n2', { compliance: [f(v('TERM-shall', 10, 'shall'))], nlp: [], grammar: [], grammarText: null }],
    ]);
    const payload = await encodeSidecar(byBlock, SAMPLE_BLOCKS);
    // good is one 24-char fingerprint
    expect(payload.good.length).toBe(24);
    expect(Object.keys(payload.bad).length).toBe(1);
    const badFp = Object.keys(payload.bad)[0];
    expect(badFp.length).toBe(24);
    expect(payload.bad[badFp].c).toEqual([{ violation: v('TERM-shall', 10, 'shall') }]);
    expect(payload.bad[badFp].g).toEqual([]);
    expect(payload.bad[badFp].n).toEqual([]);
  });

  it('strips live Range objects from findings', async () => {
    const byBlock = new Map([
      ['n2', { compliance: [f(v('TERM-shall', 0, 'shall'))], nlp: [], grammar: [], grammarText: null }],
    ]);
    const payload = await encodeSidecar(byBlock, SAMPLE_BLOCKS);
    const badEntry = Object.values(payload.bad)[0];
    for (const finding of [...badEntry.c, ...badEntry.n, ...badEntry.g]) {
      expect(finding.range).toBeUndefined();
      expect(finding.violation).toBeDefined();
    }
  });

  it('skips blocks without a byBlock entry (cache covers only seen blocks)', async () => {
    const byBlock = new Map([
      ['n1', { compliance: [], nlp: [], grammar: [], grammarText: null }],
    ]);
    const payload = await encodeSidecar(byBlock, SAMPLE_BLOCKS);
    // Only n1 is cached, so good has exactly 24 chars
    expect(payload.good.length).toBe(24);
    expect(Object.keys(payload.bad).length).toBe(0);
  });

  it('dedupes identical-html blocks to a single fingerprint entry', async () => {
    const blocks = [
      { id: 'a', html: 'same content' },
      { id: 'b', html: 'same content' },
    ];
    const byBlock = new Map([
      ['a', { compliance: [], nlp: [], grammar: [], grammarText: null }],
      ['b', { compliance: [], nlp: [], grammar: [], grammarText: null }],
    ]);
    const payload = await encodeSidecar(byBlock, blocks);
    // Two clean blocks with identical html → one fingerprint, not two
    expect(payload.good.length).toBe(24);
  });

  it('tolerates non-Map / non-Array inputs without throwing', async () => {
    const a = await encodeSidecar(null, null);
    expect(a.v).toBe(1);
    expect(a.good).toBe('');
    expect(a.bad).toEqual({});
    const b = await encodeSidecar(new Map(), undefined);
    expect(b.good).toBe('');
  });
});

describe('decodeSidecar', () => {
  it('round-trips a clean-only payload', async () => {
    const byBlock = new Map([
      ['n1', { compliance: [], nlp: [], grammar: [], grammarText: null }],
    ]);
    const encoded = await encodeSidecar(byBlock, SAMPLE_BLOCKS);
    const decoded = decodeSidecar(encoded);
    expect(decoded.fingerprints.size).toBe(1);
    expect([...decoded.fingerprints.values()][0]).toBe('good');
    expect(decoded.byFingerprint.size).toBe(0);
  });

  it('round-trips a dirty payload (findings preserved, range=null)', async () => {
    const byBlock = new Map([
      ['n2', {
        compliance: [f(v('TERM-shall', 10, 'shall'))],
        nlp: [f(v('NLP-passive', 30, 'is provided'))],
        grammar: [],
        grammarText: null,
      }],
    ]);
    const encoded = await encodeSidecar(byBlock, SAMPLE_BLOCKS);
    const decoded = decodeSidecar(encoded);
    expect(decoded.fingerprints.size).toBe(1);
    const fp = [...decoded.fingerprints.keys()][0];
    expect(decoded.fingerprints.get(fp)).toBe('bad');
    const bf = decoded.byFingerprint.get(fp);
    expect(bf.compliance).toHaveLength(1);
    expect(bf.compliance[0].range).toBeNull();
    expect(bf.compliance[0].violation.ruleId).toBe('TERM-shall');
    expect(bf.nlp).toHaveLength(1);
    expect(bf.nlp[0].violation.match).toBe('is provided');
    expect(bf.grammar).toHaveLength(0);
  });

  it('returns empty maps for malformed payloads', () => {
    expect(decodeSidecar(null).fingerprints.size).toBe(0);
    expect(decodeSidecar({}).fingerprints.size).toBe(0);
    expect(decodeSidecar('not an object').fingerprints.size).toBe(0);
  });

  it('decodes known fields from future-version payload (forward-compat)', () => {
    const future = {
      v: 999,
      good: '0123456789abcdef01234567',  // 24 hex chars
      bad: {},
      futureUnknownField: { stuff: 'ignored' },
    };
    const r = decodeSidecar(future);
    expect(r.fingerprints.size).toBe(1);
    expect(r.fingerprints.get('0123456789abcdef01234567')).toBe('good');
  });

  it('returns empty when payload.v is missing or non-numeric', () => {
    expect(decodeSidecar({ good: '...' }).fingerprints.size).toBe(0);
    expect(decodeSidecar({ v: 'banana', good: '...' }).fingerprints.size).toBe(0);
  });

  it('rejects malformed good string (length not multiple of 24)', () => {
    const decoded = decodeSidecar({ v: 1, good: 'abc', bad: {} });
    expect(decoded.fingerprints.size).toBe(0);
  });

  it('skips bad entries with wrong-length fingerprint keys', () => {
    const decoded = decodeSidecar({
      v: 1,
      good: '',
      bad: { 'short': { c: [], n: [], g: [] } },
    });
    expect(decoded.fingerprints.size).toBe(0);
  });
});

// ── projectDecoded ───────────────────────────────────────────────────────────

describe('projectDecoded', () => {
  it('maps fingerprint hits back to blockIds with rehydrated findings', async () => {
    const byBlock = new Map([
      ['n1', { compliance: [], nlp: [], grammar: [], grammarText: null }],
      ['n2', { compliance: [f(v('TERM-shall', 10, 'shall'))], nlp: [], grammar: [], grammarText: null }],
    ]);
    const encoded = await encodeSidecar(byBlock, SAMPLE_BLOCKS);
    const decoded = decodeSidecar(encoded);
    const projection = await projectDecoded(decoded, SAMPLE_BLOCKS);
    expect(projection.size).toBe(2);
    expect(projection.get('n1')).toEqual({
      compliance: [], nlp: [], grammar: [], grammarText: null,
    });
    const n2 = projection.get('n2');
    expect(n2.compliance).toHaveLength(1);
    expect(n2.compliance[0].violation.ruleId).toBe('TERM-shall');
  });

  it('skips blocks whose html has changed since the cache was written', async () => {
    const byBlock = new Map([
      ['n1', { compliance: [], nlp: [], grammar: [], grammarText: null }],
    ]);
    const encoded = await encodeSidecar(byBlock, SAMPLE_BLOCKS);
    const decoded = decodeSidecar(encoded);
    const mutated = [{ id: 'n1', html: 'NOTE: edited block.' }];
    const projection = await projectDecoded(decoded, mutated);
    expect(projection.size).toBe(0);
  });

  it('returns empty map for empty inputs', async () => {
    expect((await projectDecoded(null, [])).size).toBe(0);
    expect((await projectDecoded({ fingerprints: new Map() }, [])).size).toBe(0);
  });
});

// ── prefillFromSidecar (linting.js verb) ─────────────────────────────────────

describe('linting.prefillFromSidecar', () => {
  it('absorbs a projection into byBlock', () => {
    const initial = linting.createInitial();
    const projection = new Map([
      ['n1', { compliance: [], nlp: [], grammar: [], grammarText: null }],
      ['n2', { compliance: [f(v('TERM-shall', 10, 'shall'))], nlp: [], grammar: [], grammarText: null }],
    ]);
    const next = linting.prefillFromSidecar(initial, projection);
    expect(next.byBlock.size).toBe(2);
    expect(next.byBlock.get('n1').compliance).toEqual([]);
    expect(next.byBlock.get('n2').compliance).toHaveLength(1);
  });

  it('returns same state ref for empty/null projection', () => {
    const initial = linting.createInitial();
    expect(linting.prefillFromSidecar(initial, new Map())).toBe(initial);
    expect(linting.prefillFromSidecar(initial, null)).toBe(initial);
  });

  it('overwrites existing entries (sidecar is authoritative on import)', () => {
    const existing = linting.setBlockFindings(linting.createInitial(), 'n1', {
      compliance: [f(v('OLD', 0, 'old'))],
    });
    const projection = new Map([
      ['n1', { compliance: [], nlp: [], grammar: [], grammarText: null }],
    ]);
    const next = linting.prefillFromSidecar(existing, projection);
    expect(next.byBlock.get('n1').compliance).toEqual([]);
  });

  it('preserves enabled/suspended flags', () => {
    const initial = linting.setSuspended(linting.setEnabled(linting.createInitial(), false), true);
    const next = linting.prefillFromSidecar(initial, new Map([
      ['n1', { compliance: [], nlp: [], grammar: [], grammarText: null }],
    ]));
    expect(next.enabled).toBe(false);
    expect(next.suspended).toBe(true);
  });
});

// ── End-to-end round-trip ────────────────────────────────────────────────────

describe('lint-sidecar round-trip', () => {
  it('full pipeline: linting.byBlock → encode → JSON → decode → project → linting', async () => {
    const byBlock = new Map([
      ['n1', { compliance: [], nlp: [], grammar: [], grammarText: null }],
      ['n2', {
        compliance: [f(v('TERM-shall', 12, 'shall', 'high'))],
        nlp: [f(v('NLP-passive', 30, 'is provided'))],
        grammar: [f(v('GRAMMAR-Agreement', 5, 'are', 'low'))],
        grammarText: null,
      }],
      ['n3', { compliance: [], nlp: [], grammar: [], grammarText: null }],
    ]);
    const encoded = await encodeSidecar(byBlock, SAMPLE_BLOCKS);
    const json = JSON.stringify(encoded);
    const roundTripped = JSON.parse(json);
    const decoded = decodeSidecar(roundTripped);
    const projection = await projectDecoded(decoded, SAMPLE_BLOCKS);
    const next = linting.prefillFromSidecar(linting.createInitial(), projection);

    expect(next.byBlock.size).toBe(3);
    expect(linting.getBlockFindings(next, 'n1')).toHaveLength(0);
    expect(linting.getBlockFindings(next, 'n2')).toHaveLength(3);
    expect(linting.getBlockFindings(next, 'n3')).toHaveLength(0);

    // n2 ordering by tier
    const n2 = next.byBlock.get('n2');
    expect(n2.compliance.map(x => x.violation.ruleId)).toEqual(['TERM-shall']);
    expect(n2.nlp.map(x => x.violation.ruleId)).toEqual(['NLP-passive']);
    expect(n2.grammar.map(x => x.violation.ruleId)).toEqual(['GRAMMAR-Agreement']);
  });

  it('cache miss when html changes between save and load', async () => {
    const byBlock = new Map([
      ['n1', { compliance: [f(v('TERM-shall', 0, 'shall'))], nlp: [], grammar: [], grammarText: null }],
    ]);
    const encoded = await encodeSidecar(byBlock, SAMPLE_BLOCKS);
    const decoded = decodeSidecar(JSON.parse(JSON.stringify(encoded)));
    // Simulate a structural edit — n1's html mutated, plus n2 inserted.
    const editedBlocks = [
      { id: 'n1', html: 'NOTE: edited block.' },
      { id: 'n_new', html: 'brand-new block' },
    ];
    const projection = await projectDecoded(decoded, editedBlocks);
    expect(projection.size).toBe(0);
  });
});
