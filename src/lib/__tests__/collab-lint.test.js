/**
 * Collab lint-sidecar tests (#150) — exercise readLint / publishLintToDoc
 * round-trip against a real Y.Doc and the phase-1 set-only semantics.
 *
 * Real-network propagation (peer A pushes, peer B receives) is covered by
 * the E2E collab spec.
 */

import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import { readLint, publishLintToDoc } from '../collab.js';

function makeDoc() {
  const ydoc = new Y.Doc();
  const yLint = ydoc.getMap('lint');
  return { ydoc, yLint };
}

// 24-char fingerprints — same length the encoder produces.
const fp = (i) => `0000000000000000000000${String.fromCharCode(97 + i)}${String.fromCharCode(97 + i)}`.slice(-24);

describe('readLint', () => {
  it('returns empty payload for an empty yLint', () => {
    const { yLint } = makeDoc();
    expect(readLint(yLint)).toEqual({ v: 1, good: '', bad: {} });
  });

  it('handles a null / missing yLint without throwing', () => {
    expect(readLint(null)).toEqual({ v: 1, good: '', bad: {} });
    expect(readLint(undefined)).toEqual({ v: 1, good: '', bad: {} });
  });

  it('emits good fingerprints concatenated and bad entries by fp', () => {
    const { yLint } = makeDoc();
    yLint.set(fp(0), { kind: 'good' });
    yLint.set(fp(1), { kind: 'good' });
    yLint.set(fp(2), { kind: 'bad', g: [{ violation: { ruleId: 'X' } }], n: [], c: [] });
    const out = readLint(yLint);
    expect(out.v).toBe(1);
    // good is a concat of 24-char fingerprints; order is iteration order.
    expect(out.good.length).toBe(48);
    expect(out.good.includes(fp(0))).toBe(true);
    expect(out.good.includes(fp(1))).toBe(true);
    expect(out.bad).toHaveProperty(fp(2));
    expect(out.bad[fp(2)].g).toHaveLength(1);
  });

  it('ignores malformed entries', () => {
    const { yLint } = makeDoc();
    yLint.set(fp(0), null);
    yLint.set(fp(1), { kind: 'unknown' });
    yLint.set(fp(2), { kind: 'bad', g: 'not-an-array', n: null, c: undefined });
    const out = readLint(yLint);
    expect(out.good).toBe('');
    // kind:'bad' is still emitted; arrays get normalized to [].
    expect(out.bad).toHaveProperty(fp(2));
    expect(out.bad[fp(2)]).toEqual({ g: [], n: [], c: [] });
  });
});

describe('publishLintToDoc', () => {
  it('writes a v1 payload into an empty yLint', () => {
    const { ydoc, yLint } = makeDoc();
    publishLintToDoc(ydoc, yLint, {
      v: 1,
      good: fp(0) + fp(1),
      bad: { [fp(2)]: { g: [{ violation: { ruleId: 'R1' } }], n: [], c: [] } },
    });
    expect(yLint.size).toBe(3);
    expect(yLint.get(fp(0))).toEqual({ kind: 'good' });
    expect(yLint.get(fp(1))).toEqual({ kind: 'good' });
    expect(yLint.get(fp(2))).toEqual({
      kind: 'bad',
      g: [{ violation: { ruleId: 'R1' } }],
      n: [],
      c: [],
    });
  });

  it('round-trips through readLint', () => {
    const { ydoc, yLint } = makeDoc();
    const payload = {
      v: 1,
      good: fp(0) + fp(1) + fp(2),
      bad: {
        [fp(3)]: { g: [{ violation: { ruleId: 'A' } }], n: [], c: [] },
        [fp(4)]: { g: [], n: [{ violation: { ruleId: 'B' } }], c: [] },
      },
    };
    publishLintToDoc(ydoc, yLint, payload);
    const out = readLint(yLint);
    // good order may differ from input — assert as sets.
    const inGood = new Set([fp(0), fp(1), fp(2)]);
    const outGood = new Set();
    for (let i = 0; i < out.good.length; i += 24) outGood.add(out.good.slice(i, i + 24));
    expect(outGood).toEqual(inGood);
    expect(out.bad).toEqual(payload.bad);
  });

  it('rejects non-v1 payloads (forward-compat)', () => {
    const { ydoc, yLint } = makeDoc();
    publishLintToDoc(ydoc, yLint, { v: 2, good: fp(0), bad: {} });
    expect(yLint.size).toBe(0);
  });

  it('ignores malformed top-level structure', () => {
    const { ydoc, yLint } = makeDoc();
    publishLintToDoc(ydoc, yLint, null);
    publishLintToDoc(ydoc, yLint, 'string');
    publishLintToDoc(ydoc, yLint, { v: 1, good: 42, bad: 'oops' });
    expect(yLint.size).toBe(0);
  });

  it('phase-1: does NOT delete fingerprints absent from a subsequent payload', () => {
    const { ydoc, yLint } = makeDoc();
    // Peer A publishes 2 fingerprints.
    publishLintToDoc(ydoc, yLint, { v: 1, good: fp(0) + fp(1), bad: {} });
    expect(yLint.size).toBe(2);
    // Peer B publishes only fp(2) — a phase-1 publish must NOT delete A's entries.
    publishLintToDoc(ydoc, yLint, { v: 1, good: fp(2), bad: {} });
    expect(yLint.size).toBe(3);
    expect(yLint.has(fp(0))).toBe(true);
    expect(yLint.has(fp(1))).toBe(true);
    expect(yLint.has(fp(2))).toBe(true);
  });

  it('updates existing entries when kind changes', () => {
    const { ydoc, yLint } = makeDoc();
    publishLintToDoc(ydoc, yLint, { v: 1, good: fp(0), bad: {} });
    expect(yLint.get(fp(0))).toEqual({ kind: 'good' });
    publishLintToDoc(ydoc, yLint, {
      v: 1,
      good: '',
      bad: { [fp(0)]: { g: [{ violation: { ruleId: 'X' } }], n: [], c: [] } },
    });
    expect(yLint.get(fp(0)).kind).toBe('bad');
  });

  it('produces NO transaction when the payload matches yLint exactly (echo no-op)', () => {
    const { ydoc, yLint } = makeDoc();
    publishLintToDoc(ydoc, yLint, {
      v: 1,
      good: fp(0),
      bad: { [fp(1)]: { g: [], n: [], c: [{ violation: { ruleId: 'Z' } }] } },
    });
    // Observe transactions on the second call — should be zero ops.
    let opsFromSecondCall = 0;
    const handler = (tr) => { opsFromSecondCall += tr.changedParentTypes.size + tr.changed.size; };
    ydoc.on('afterTransaction', handler);
    publishLintToDoc(ydoc, yLint, {
      v: 1,
      good: fp(0),
      bad: { [fp(1)]: { g: [], n: [], c: [{ violation: { ruleId: 'Z' } }] } },
    });
    ydoc.off('afterTransaction', handler);
    expect(opsFromSecondCall).toBe(0);
  });

  it('uses origin "local-lint"', () => {
    const { ydoc, yLint } = makeDoc();
    let observedOrigin = null;
    ydoc.on('afterTransaction', (tr) => {
      if (tr.changed.has(yLint) || tr.changedParentTypes.has(yLint)) {
        observedOrigin = tr.origin;
      }
    });
    publishLintToDoc(ydoc, yLint, { v: 1, good: fp(0), bad: {} });
    expect(observedOrigin).toBe('local-lint');
  });
});

describe('publishLintToDoc GC (#214)', () => {
  it('prunes entries whose fingerprint is not in the live set', () => {
    const { ydoc, yLint } = makeDoc();
    // Seed three entries, two of which are now-dead (no live block).
    publishLintToDoc(ydoc, yLint, { v: 1, good: fp(0) + fp(1) + fp(2), bad: {} });
    expect(yLint.size).toBe(3);
    // Live set covers only fp(2); republish fp(2) with the live set → prune 0,1.
    publishLintToDoc(ydoc, yLint, { v: 1, good: fp(2), bad: {} }, new Set([fp(2)]));
    expect(yLint.size).toBe(1);
    expect(yLint.has(fp(2))).toBe(true);
  });

  it('always keeps just-published target entries even if absent from live set', () => {
    const { ydoc, yLint } = makeDoc();
    // A stale `blocks` snapshot might omit the just-linted block from the live
    // set; the target fingerprint must still survive.
    publishLintToDoc(ydoc, yLint, { v: 1, good: fp(5), bad: {} }, new Set([fp(9)]));
    expect(yLint.has(fp(5))).toBe(true);
    expect(yLint.has(fp(9))).toBe(false); // fp(9) was never set, just in live set
  });

  it('keeps other live blocks linted by peers (no cross-peer clobber)', () => {
    const { ydoc, yLint } = makeDoc();
    // Peer B linted fp(1); peer A republishes fp(0) but the shared live set
    // covers both blocks → B's entry survives.
    publishLintToDoc(ydoc, yLint, { v: 1, good: fp(1), bad: {} });
    publishLintToDoc(ydoc, yLint, { v: 1, good: fp(0), bad: {} }, new Set([fp(0), fp(1)]));
    expect(yLint.size).toBe(2);
    expect(yLint.has(fp(0))).toBe(true);
    expect(yLint.has(fp(1))).toBe(true);
  });

  it('verification: one block through N states stays bounded to live-block count', () => {
    const { ydoc, yLint } = makeDoc();
    // Simulate one block edited through 10 distinct html states. Each publish
    // carries that state's fingerprint as both the payload and the (single)
    // live block. yLint must never grow past the live-block count of 1.
    for (let i = 0; i < 10; i++) {
      publishLintToDoc(ydoc, yLint, { v: 1, good: fp(i), bad: {} }, new Set([fp(i)]));
      expect(yLint.size).toBe(1);
    }
    expect(yLint.has(fp(9))).toBe(true);
  });

  it('omitting the live set preserves legacy set-only (never-delete) behavior', () => {
    const { ydoc, yLint } = makeDoc();
    publishLintToDoc(ydoc, yLint, { v: 1, good: fp(0) + fp(1), bad: {} });
    publishLintToDoc(ydoc, yLint, { v: 1, good: fp(2), bad: {} });
    expect(yLint.size).toBe(3); // no prune without a live set
  });

  it('prune deletes carry origin "local-lint" (off the undo stack)', () => {
    const { ydoc, yLint } = makeDoc();
    publishLintToDoc(ydoc, yLint, { v: 1, good: fp(0) + fp(1), bad: {} });
    let observedOrigin = null;
    ydoc.on('afterTransaction', (tr) => {
      if (tr.changed.has(yLint) || tr.changedParentTypes.has(yLint)) {
        observedOrigin = tr.origin;
      }
    });
    publishLintToDoc(ydoc, yLint, { v: 1, good: fp(0), bad: {} }, new Set([fp(0)]));
    expect(yLint.size).toBe(1);
    expect(observedOrigin).toBe('local-lint');
  });
});
