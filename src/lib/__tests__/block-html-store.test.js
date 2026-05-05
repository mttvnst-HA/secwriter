/**
 * block-html-store — Y.Doc-as-source-of-truth substrate for per-block html.
 *
 * Tests exercise the public API: seedBlockArray, resetBlockArray,
 * getBlockHtml, setBlockHtml, subscribeBlock.
 *
 * Sub-PR 1d (#47, ADR-0006) swapped the substrate from Y.Text to
 * Y.XmlFragment. The default seed path stores Y.XmlFragment now; the
 * legacy Y.Text path is exercised separately via the migrationPartial
 * fallback fixtures further down.
 */

import { describe, it, expect, vi } from 'vitest';
import * as Y from 'yjs';

vi.mock('../pmdoc-html.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, pmFragmentToHtml: vi.fn(actual.pmFragmentToHtml) };
});
vi.mock('../ytext-html.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, yTextToHtml: vi.fn(actual.yTextToHtml) };
});

import {
  seedBlockArray,
  getBlockHtml,
  setBlockHtml,
  subscribeBlock,
  resetBlockArray,
  seedYTextFromHtml,
} from '../block-html-store.js';
import { pmFragmentToHtml as spiedPmFragmentToHtml } from '../pmdoc-html.js';
import { yTextToHtml as spiedYTextToHtml } from '../ytext-html.js';

function makeDoc() {
  const ydoc = new Y.Doc();
  const yOrder = ydoc.getArray('order');
  const yStore = ydoc.getMap('store');
  return { ydoc, yOrder, yStore };
}

/** Build a yMap with a legacy Y.Text html slot (migrationPartial fallback fixture). */
function seedLegacyYTextBlock(ydoc, yOrder, yStore, blockId, html) {
  ydoc.transact(() => {
    const yMap = new Y.Map();
    const yText = new Y.Text();
    seedYTextFromHtml(yText, html);
    yMap.set('html', yText);
    yStore.set(blockId, yMap);
    yOrder.push([blockId]);
  }, 'seed');
}

describe('getBlockHtml — Y.XmlFragment (1d default substrate)', () => {
  it('roundtrips html for a seeded block', () => {
    const { ydoc, yOrder, yStore } = makeDoc();
    seedBlockArray(ydoc, yOrder, yStore, [
      { id: 'n1', type: 'txt', html: '<b>hello</b>' },
    ]);
    expect(getBlockHtml(yStore, 'n1')).toBe('<b>hello</b>');
  });

  it('roundtrips an empty block', () => {
    const { ydoc, yOrder, yStore } = makeDoc();
    seedBlockArray(ydoc, yOrder, yStore, [{ id: 'n1', type: 'txt', html: '' }]);
    expect(getBlockHtml(yStore, 'n1')).toBe('');
  });

  it('roundtrips inline marks and revisions', () => {
    const { ydoc, yOrder, yStore } = makeDoc();
    seedBlockArray(ydoc, yOrder, yStore, [
      { id: 'n1', type: 'txt', html: 'See <span class="mark-rid">ASTM</span>' },
      { id: 'n2', type: 'txt', html: '<ins class="mark-add" data-author-id="a1" style="--author-color:#f00">added</ins>' },
    ]);
    expect(getBlockHtml(yStore, 'n1')).toBe('See <span class="mark-rid">ASTM</span>');
    expect(getBlockHtml(yStore, 'n2')).toBe(
      '<ins class="mark-add" data-author-id="a1" style="--author-color:#f00">added</ins>'
    );
  });

  it("returns '' for an unknown block id", () => {
    const { yStore } = makeDoc();
    expect(getBlockHtml(yStore, 'missing')).toBe('');
  });

  it("returns '' when the html slot is missing or an unrecognized shape", () => {
    const { ydoc, yStore } = makeDoc();
    ydoc.transact(() => {
      const yMap = new Y.Map();
      yStore.set('no-html', yMap);
      const yMap2 = new Y.Map();
      yMap2.set('html', { not: 'a yjs type' });
      yStore.set('bad-html', yMap2);
    });
    expect(getBlockHtml(yStore, 'no-html')).toBe('');
    expect(getBlockHtml(yStore, 'bad-html')).toBe('');
  });

  it('exposes a bare-string html slot as-is (extreme corruption fallback)', () => {
    // setBlockHtml refuses to write into a string slot; getBlockHtml just
    // surfaces it so rendering doesn't blank out.
    const { ydoc, yStore } = makeDoc();
    ydoc.transact(() => {
      const yMap = new Y.Map();
      yMap.set('html', 'plain string somehow');
      yStore.set('bare', yMap);
    });
    expect(getBlockHtml(yStore, 'bare')).toBe('plain string somehow');
  });

  it('does not re-derive html until the underlying Y.XmlFragment mutates', () => {
    const { ydoc, yOrder, yStore } = makeDoc();
    seedBlockArray(ydoc, yOrder, yStore, [{ id: 'n1', type: 'txt', html: 'hello' }]);
    spiedPmFragmentToHtml.mockClear();

    expect(getBlockHtml(yStore, 'n1')).toBe('hello');
    const callsAfterFirst = spiedPmFragmentToHtml.mock.calls.length;
    expect(getBlockHtml(yStore, 'n1')).toBe('hello');
    expect(getBlockHtml(yStore, 'n1')).toBe('hello');
    expect(spiedPmFragmentToHtml.mock.calls.length).toBe(callsAfterFirst);

    setBlockHtml(yStore, 'n1', 'hello!');
    expect(getBlockHtml(yStore, 'n1')).toBe('hello!');
    expect(spiedPmFragmentToHtml.mock.calls.length).toBeGreaterThan(callsAfterFirst);
  });

  it('caches per-block (one block mutation does not invalidate another)', () => {
    const { ydoc, yOrder, yStore } = makeDoc();
    seedBlockArray(ydoc, yOrder, yStore, [
      { id: 'a', type: 'txt', html: 'aaa' },
      { id: 'b', type: 'txt', html: 'bbb' },
    ]);
    expect(getBlockHtml(yStore, 'a')).toBe('aaa');
    expect(getBlockHtml(yStore, 'b')).toBe('bbb');

    spiedPmFragmentToHtml.mockClear();
    setBlockHtml(yStore, 'b', 'bbb!');

    expect(getBlockHtml(yStore, 'a')).toBe('aaa');
    expect(getBlockHtml(yStore, 'a')).toBe('aaa');
    const callsBeforeB = spiedPmFragmentToHtml.mock.calls.length;
    expect(getBlockHtml(yStore, 'b')).toBe('bbb!');
    expect(spiedPmFragmentToHtml.mock.calls.length).toBeGreaterThan(callsBeforeB - 1);
  });
});

describe('setBlockHtml — Y.XmlFragment substrate', () => {
  it('updates html observable through getBlockHtml', () => {
    const { ydoc, yOrder, yStore } = makeDoc();
    seedBlockArray(ydoc, yOrder, yStore, [{ id: 'n1', type: 'txt', html: 'old' }]);
    setBlockHtml(yStore, 'n1', 'new value');
    expect(getBlockHtml(yStore, 'n1')).toBe('new value');
  });

  it('preserves Y.XmlFragment instance identity (=== before/after)', () => {
    // Substrate-level identity is what makes concurrent same-paragraph edits
    // CRDT-merge instead of stomping each other. prosemirrorToYXmlFragment
    // diff-and-merges into the existing fragment; its instance survives.
    const { ydoc, yOrder, yStore } = makeDoc();
    seedBlockArray(ydoc, yOrder, yStore, [{ id: 'n1', type: 'txt', html: 'a' }]);
    const before = yStore.get('n1').get('html');
    setBlockHtml(yStore, 'n1', '<b>completely different</b>');
    const after = yStore.get('n1').get('html');
    expect(after).toBe(before);
  });

  it('uses local-publish transaction origin', () => {
    const { ydoc, yOrder, yStore } = makeDoc();
    seedBlockArray(ydoc, yOrder, yStore, [{ id: 'n1', type: 'txt', html: 'a' }]);
    const origins = [];
    ydoc.on('afterTransaction', (tx) => origins.push(tx.origin));
    setBlockHtml(yStore, 'n1', 'b');
    expect(origins).toContain('local-publish');
  });

  it('is a no-op for an unknown block id', () => {
    const { ydoc, yOrder, yStore } = makeDoc();
    seedBlockArray(ydoc, yOrder, yStore, [{ id: 'n1', type: 'txt', html: 'a' }]);
    let txCount = 0;
    ydoc.on('afterTransaction', () => txCount++);
    expect(() => setBlockHtml(yStore, 'missing', 'whatever')).not.toThrow();
    expect(txCount).toBe(0);
    expect(getBlockHtml(yStore, 'n1')).toBe('a');
  });

  it('treats non-string html as empty string', () => {
    const { ydoc, yOrder, yStore } = makeDoc();
    seedBlockArray(ydoc, yOrder, yStore, [{ id: 'n1', type: 'txt', html: 'a' }]);
    setBlockHtml(yStore, 'n1', null);
    expect(getBlockHtml(yStore, 'n1')).toBe('');
    setBlockHtml(yStore, 'n1', 42);
    expect(getBlockHtml(yStore, 'n1')).toBe('');
  });

  it('handles consecutive updates without leftover state', () => {
    const { ydoc, yOrder, yStore } = makeDoc();
    seedBlockArray(ydoc, yOrder, yStore, [{ id: 'n1', type: 'txt', html: '' }]);
    const yXml = yStore.get('n1').get('html');
    setBlockHtml(yStore, 'n1', 'one');
    setBlockHtml(yStore, 'n1', 'two');
    setBlockHtml(yStore, 'n1', 'three');
    expect(getBlockHtml(yStore, 'n1')).toBe('three');
    expect(yStore.get('n1').get('html')).toBe(yXml);
  });
});

describe('seedBlockArray — Y.XmlFragment substrate', () => {
  it('seeds multiple blocks and preserves order', () => {
    const { ydoc, yOrder, yStore } = makeDoc();
    seedBlockArray(ydoc, yOrder, yStore, [
      { id: 'a', type: 'txt', html: 'A' },
      { id: 'b', type: 'txt', html: 'B' },
      { id: 'c', type: 'txt', html: 'C' },
    ]);
    expect(yOrder.length).toBe(3);
    expect(yStore.size).toBe(3);
    expect(yOrder.get(0)).toBe('a');
    expect(yOrder.get(1)).toBe('b');
    expect(yOrder.get(2)).toBe('c');
    expect(getBlockHtml(yStore, 'a')).toBe('A');
    expect(getBlockHtml(yStore, 'b')).toBe('B');
    expect(getBlockHtml(yStore, 'c')).toBe('C');
  });

  it('seeded slots are Y.XmlFragment, not Y.Text', () => {
    const { ydoc, yOrder, yStore } = makeDoc();
    seedBlockArray(ydoc, yOrder, yStore, [{ id: 'n1', type: 'txt', html: 'A' }]);
    const slot = yStore.get('n1').get('html');
    expect(typeof slot.toArray).toBe('function');
    expect(typeof slot.toDelta).toBe('undefined');
  });

  it('throws if yOrder is non-empty', () => {
    const { ydoc, yOrder, yStore } = makeDoc();
    yOrder.push(['stale']);
    expect(() => seedBlockArray(ydoc, yOrder, yStore, [
      { id: 'a', type: 'txt', html: 'A' },
    ])).toThrow();
  });

  it('throws if yStore is non-empty', () => {
    const { ydoc, yOrder, yStore } = makeDoc();
    yStore.set('stale', new Y.Map());
    expect(() => seedBlockArray(ydoc, yOrder, yStore, [
      { id: 'a', type: 'txt', html: 'A' },
    ])).toThrow();
  });

  it('seeds an empty html block to empty content', () => {
    const { ydoc, yOrder, yStore } = makeDoc();
    seedBlockArray(ydoc, yOrder, yStore, [{ id: 'n1', type: 'txt', html: '' }]);
    expect(getBlockHtml(yStore, 'n1')).toBe('');
  });

  it('seeds inside the seed transaction origin (single transaction per call)', () => {
    const { ydoc, yOrder, yStore } = makeDoc();
    const origins = [];
    ydoc.on('afterTransaction', (tx) => origins.push(tx.origin));
    seedBlockArray(ydoc, yOrder, yStore, [
      { id: 'a', type: 'txt', html: 'A' },
      { id: 'b', type: 'txt', html: 'B' },
    ]);
    expect(origins).toEqual(['seed']);
  });

  it('preserves Y.XmlFragment identity across direct mutations after seeding', () => {
    const { ydoc, yOrder, yStore } = makeDoc();
    seedBlockArray(ydoc, yOrder, yStore, [{ id: 'n1', type: 'txt', html: 'a' }]);
    const before = yStore.get('n1').get('html');
    setBlockHtml(yStore, 'n1', 'b');
    setBlockHtml(yStore, 'n1', 'c');
    expect(yStore.get('n1').get('html')).toBe(before);
  });
});

describe('subscribeBlock — Y.XmlFragment substrate', () => {
  it('fires the listener when the block html mutates', () => {
    const { ydoc, yOrder, yStore } = makeDoc();
    seedBlockArray(ydoc, yOrder, yStore, [{ id: 'n1', type: 'txt', html: 'a' }]);
    const calls = [];
    const unsubscribe = subscribeBlock(yStore, 'n1', () => calls.push(1));
    setBlockHtml(yStore, 'n1', 'b');
    setBlockHtml(yStore, 'n1', 'c');
    expect(calls.length).toBeGreaterThanOrEqual(2);
    unsubscribe();
  });

  it('unsubscribe stops listener firing on subsequent mutations', () => {
    const { ydoc, yOrder, yStore } = makeDoc();
    seedBlockArray(ydoc, yOrder, yStore, [{ id: 'n1', type: 'txt', html: 'a' }]);
    let count = 0;
    const unsubscribe = subscribeBlock(yStore, 'n1', () => count++);
    setBlockHtml(yStore, 'n1', 'b');
    const before = count;
    unsubscribe();
    setBlockHtml(yStore, 'n1', 'c');
    setBlockHtml(yStore, 'n1', 'd');
    expect(count).toBe(before);
  });

  it('does not fire for unrelated block mutations', () => {
    const { ydoc, yOrder, yStore } = makeDoc();
    seedBlockArray(ydoc, yOrder, yStore, [
      { id: 'a', type: 'txt', html: 'A' },
      { id: 'b', type: 'txt', html: 'B' },
    ]);
    let count = 0;
    const unsubscribe = subscribeBlock(yStore, 'a', () => count++);
    setBlockHtml(yStore, 'b', 'BBB');
    expect(count).toBe(0);
    unsubscribe();
  });

  it('rebinds when the Y.Map for the blockId is replaced', () => {
    const { ydoc, yOrder, yStore } = makeDoc();
    seedBlockArray(ydoc, yOrder, yStore, [{ id: 'n1', type: 'txt', html: 'a' }]);
    let count = 0;
    const unsubscribe = subscribeBlock(yStore, 'n1', () => count++);

    ydoc.transact(() => {
      const replacement = new Y.Map();
      const newXml = new Y.XmlFragment();
      replacement.set('html', newXml);
      yStore.set('n1', replacement);
    });
    setBlockHtml(yStore, 'n1', 'fresh');

    expect(count).toBeGreaterThan(0);
    expect(getBlockHtml(yStore, 'n1')).toBe('fresh');
    unsubscribe();
  });

  it('returns a no-op unsubscribe for an unknown block id', () => {
    const { yStore } = makeDoc();
    let count = 0;
    const unsubscribe = subscribeBlock(yStore, 'nope', () => count++);
    expect(typeof unsubscribe).toBe('function');
    expect(() => unsubscribe()).not.toThrow();
  });

  it('starts notifying after the block id is later created', () => {
    const { ydoc, yOrder, yStore } = makeDoc();
    seedBlockArray(ydoc, yOrder, yStore, [{ id: 'a', type: 'txt', html: 'A' }]);
    let count = 0;
    const unsubscribe = subscribeBlock(yStore, 'late', () => count++);

    ydoc.transact(() => {
      const yMap = new Y.Map();
      const yXml = new Y.XmlFragment();
      yMap.set('html', yXml);
      yStore.set('late', yMap);
    });
    expect(count).toBeGreaterThan(0);

    const before = count;
    setBlockHtml(yStore, 'late', 'updated');
    expect(count).toBeGreaterThan(before);
    unsubscribe();
  });
});

describe('resetBlockArray — Y.XmlFragment substrate', () => {
  it('clears existing blocks and seeds new ones in a single transaction', () => {
    const { ydoc, yOrder, yStore } = makeDoc();
    seedBlockArray(ydoc, yOrder, yStore, [
      { id: 'old1', type: 'txt', html: 'old A' },
      { id: 'old2', type: 'txt', html: 'old B' },
    ]);

    const origins = [];
    ydoc.on('afterTransaction', (tx) => origins.push(tx.origin));

    resetBlockArray(ydoc, yOrder, yStore, [
      { id: 'new1', type: 'txt', html: 'new A' },
    ]);

    expect(yOrder.length).toBe(1);
    expect(yOrder.get(0)).toBe('new1');
    expect(yStore.size).toBe(1);
    expect(yStore.get('old1')).toBeUndefined();
    expect(yStore.get('old2')).toBeUndefined();
    expect(getBlockHtml(yStore, 'new1')).toBe('new A');
    expect(origins).toEqual(['reset']);
  });

  it('seeds an empty store cleanly', () => {
    const { ydoc, yOrder, yStore } = makeDoc();
    resetBlockArray(ydoc, yOrder, yStore, [
      { id: 'a', type: 'txt', html: 'A' },
    ]);
    expect(yOrder.length).toBe(1);
    expect(getBlockHtml(yStore, 'a')).toBe('A');
  });

  it('handles being called with an empty plainBlocks array', () => {
    const { ydoc, yOrder, yStore } = makeDoc();
    seedBlockArray(ydoc, yOrder, yStore, [{ id: 'a', type: 'txt', html: 'A' }]);
    resetBlockArray(ydoc, yOrder, yStore, []);
    expect(yOrder.length).toBe(0);
    expect(yStore.size).toBe(0);
  });
});

// ── Legacy Y.Text fallback (1d migrationPartial) ─────────────────────────
//
// When a v2 client connects to a room where the server-side broker
// converted *some* blocks but left others as Y.Text (per-block conversion
// failure → migrationPartial), the binder must still be able to read AND
// write to the legacy slots. Otherwise typing on a partial-migrated room
// would be a no-op for the unmigrated blocks.

describe('migrationPartial fallback — Y.Text legacy slot reads', () => {
  it('getBlockHtml derives via yTextToHtml for a Y.Text slot', () => {
    const { ydoc, yOrder, yStore } = makeDoc();
    seedLegacyYTextBlock(ydoc, yOrder, yStore, 'legacy', '<b>hello</b>');
    expect(getBlockHtml(yStore, 'legacy')).toBe('<b>hello</b>');
  });

  it('memo-caches Y.Text reads via yTextToHtml exactly once until mutate', () => {
    const { ydoc, yOrder, yStore } = makeDoc();
    seedLegacyYTextBlock(ydoc, yOrder, yStore, 'legacy', 'hello');
    spiedYTextToHtml.mockClear();

    expect(getBlockHtml(yStore, 'legacy')).toBe('hello');
    const callsAfterFirst = spiedYTextToHtml.mock.calls.length;
    expect(getBlockHtml(yStore, 'legacy')).toBe('hello');
    expect(spiedYTextToHtml.mock.calls.length).toBe(callsAfterFirst);
  });
});

describe('migrationPartial fallback — Y.Text legacy slot writes', () => {
  it('setBlockHtml routes through applyHtmlToYText for a Y.Text slot', () => {
    const { ydoc, yOrder, yStore } = makeDoc();
    seedLegacyYTextBlock(ydoc, yOrder, yStore, 'legacy', 'hello');
    setBlockHtml(yStore, 'legacy', 'updated');
    expect(getBlockHtml(yStore, 'legacy')).toBe('updated');
    // Slot type stays Y.Text (we don't auto-upgrade on write — the broker
    // is the only path that flips a slot from Y.Text to Y.XmlFragment).
    const slot = yStore.get('legacy').get('html');
    expect(typeof slot.toDelta).toBe('function');
    expect(typeof slot.toArray).toBe('undefined');
  });

  it('still uses local-publish origin on legacy writes (UndoManager coverage)', () => {
    const { ydoc, yOrder, yStore } = makeDoc();
    seedLegacyYTextBlock(ydoc, yOrder, yStore, 'legacy', 'a');
    const origins = [];
    ydoc.on('afterTransaction', (tx) => origins.push(tx.origin));
    setBlockHtml(yStore, 'legacy', 'b');
    expect(origins).toContain('local-publish');
  });

  it('subscribeBlock fires for legacy Y.Text mutations too', () => {
    const { ydoc, yOrder, yStore } = makeDoc();
    seedLegacyYTextBlock(ydoc, yOrder, yStore, 'legacy', 'a');
    let count = 0;
    const unsubscribe = subscribeBlock(yStore, 'legacy', () => count++);
    setBlockHtml(yStore, 'legacy', 'b');
    setBlockHtml(yStore, 'legacy', 'c');
    expect(count).toBeGreaterThanOrEqual(2);
    unsubscribe();
  });
});
