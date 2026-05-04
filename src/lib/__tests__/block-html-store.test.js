/**
 * block-html-store — Y.Doc-as-source-of-truth substrate for per-block html.
 *
 * Adapter only. The binder + App.jsx wiring lands in a follow-up sub-PR.
 * Tests exercise only the public API: seedBlockArray, getBlockHtml, setBlockHtml.
 */

import { describe, it, expect, vi } from 'vitest';
import * as Y from 'yjs';

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
} from '../block-html-store.js';
import { yTextToHtml as spiedYTextToHtml } from '../ytext-html.js';

function makeDoc() {
  const ydoc = new Y.Doc();
  const yOrder = ydoc.getArray('order');
  const yStore = ydoc.getMap('store');
  return { ydoc, yOrder, yStore };
}

describe('getBlockHtml', () => {
  it('roundtrips html for a seeded block', () => {
    const { ydoc, yOrder, yStore } = makeDoc();
    seedBlockArray(ydoc, yOrder, yStore, [
      { id: 'n1', type: 'txt', html: '<b>hello</b>' },
    ]);
    expect(getBlockHtml(yStore, 'n1')).toBe('<b>hello</b>');
  });

  it("returns '' for an unknown block id", () => {
    const { yStore } = makeDoc();
    expect(getBlockHtml(yStore, 'missing')).toBe('');
  });

  it("returns '' when the block's html slot is missing or non-Y.Text", () => {
    const { ydoc, yStore } = makeDoc();
    ydoc.transact(() => {
      const yMap = new Y.Map();
      yStore.set('no-html', yMap);
      const yMap2 = new Y.Map();
      yMap2.set('html', 'plain string somehow');
      yStore.set('bad-html', yMap2);
    });
    expect(getBlockHtml(yStore, 'no-html')).toBe('');
    expect(getBlockHtml(yStore, 'bad-html')).toBe('');
  });

  it('does not re-derive html until the underlying Y.Text mutates', () => {
    const { ydoc, yOrder, yStore } = makeDoc();
    seedBlockArray(ydoc, yOrder, yStore, [{ id: 'n1', type: 'txt', html: 'hello' }]);
    const yText = yStore.get('n1').get('html');

    spiedYTextToHtml.mockClear();
    expect(getBlockHtml(yStore, 'n1')).toBe('hello');
    const callsAfterFirst = spiedYTextToHtml.mock.calls.length;
    expect(getBlockHtml(yStore, 'n1')).toBe('hello');
    expect(getBlockHtml(yStore, 'n1')).toBe('hello');
    expect(spiedYTextToHtml.mock.calls.length).toBe(callsAfterFirst);

    ydoc.transact(() => { yText.insert(yText.length, '!'); });
    expect(getBlockHtml(yStore, 'n1')).toBe('hello!');
    expect(spiedYTextToHtml.mock.calls.length).toBe(callsAfterFirst + 1);
  });

  it('caches per-block (one block mutation does not invalidate another)', () => {
    const { ydoc, yOrder, yStore } = makeDoc();
    seedBlockArray(ydoc, yOrder, yStore, [
      { id: 'a', type: 'txt', html: 'aaa' },
      { id: 'b', type: 'txt', html: 'bbb' },
    ]);
    expect(getBlockHtml(yStore, 'a')).toBe('aaa');
    expect(getBlockHtml(yStore, 'b')).toBe('bbb');

    spiedYTextToHtml.mockClear();
    const yTextB = yStore.get('b').get('html');
    ydoc.transact(() => { yTextB.insert(yTextB.length, '!'); });

    // 'a' should not re-derive; 'b' should.
    expect(getBlockHtml(yStore, 'a')).toBe('aaa');
    expect(getBlockHtml(yStore, 'a')).toBe('aaa');
    const callsBeforeB = spiedYTextToHtml.mock.calls.length;
    expect(getBlockHtml(yStore, 'b')).toBe('bbb!');
    expect(spiedYTextToHtml.mock.calls.length).toBe(callsBeforeB + 1);
    expect(getBlockHtml(yStore, 'b')).toBe('bbb!');
    expect(spiedYTextToHtml.mock.calls.length).toBe(callsBeforeB + 1);
  });
});

describe('setBlockHtml', () => {
  it('updates html observable through getBlockHtml', () => {
    const { ydoc, yOrder, yStore } = makeDoc();
    seedBlockArray(ydoc, yOrder, yStore, [{ id: 'n1', type: 'txt', html: 'old' }]);
    setBlockHtml(yStore, 'n1', 'new value');
    expect(getBlockHtml(yStore, 'n1')).toBe('new value');
  });

  it('preserves Y.Text instance identity (=== before/after)', () => {
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
    const yText = yStore.get('n1').get('html');
    setBlockHtml(yStore, 'n1', 'one');
    setBlockHtml(yStore, 'n1', 'two');
    setBlockHtml(yStore, 'n1', 'three');
    expect(getBlockHtml(yStore, 'n1')).toBe('three');
    expect(yStore.get('n1').get('html')).toBe(yText);
  });
});

describe('seedBlockArray', () => {
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

  it('preserves Y.Text identity across direct mutations after seeding', () => {
    const { ydoc, yOrder, yStore } = makeDoc();
    seedBlockArray(ydoc, yOrder, yStore, [{ id: 'n1', type: 'txt', html: 'a' }]);
    const before = yStore.get('n1').get('html');
    setBlockHtml(yStore, 'n1', 'b');
    setBlockHtml(yStore, 'n1', 'c');
    expect(yStore.get('n1').get('html')).toBe(before);
  });
});

describe('subscribeBlock', () => {
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

    // Replace the Y.Map for n1 with a fresh one (simulates a remote-driven
    // structural delete+re-add of the same block id).
    ydoc.transact(() => {
      const replacement = new Y.Map();
      const newText = new Y.Text();
      newText.insert(0, 'fresh');
      replacement.set('html', newText);
      yStore.set('n1', replacement);
    });

    const afterReplace = count;
    expect(afterReplace).toBeGreaterThan(0); // top-level key change notifies
    expect(getBlockHtml(yStore, 'n1')).toBe('fresh');

    // Mutating the NEW Y.Text must still notify
    setBlockHtml(yStore, 'n1', 'mutated');
    expect(count).toBeGreaterThan(afterReplace);
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

    // Create the block id later — top-level key change should fire.
    ydoc.transact(() => {
      const yMap = new Y.Map();
      const yText = new Y.Text();
      yText.insert(0, 'hello');
      yMap.set('html', yText);
      yStore.set('late', yMap);
    });
    expect(count).toBeGreaterThan(0);

    // And subsequent text mutations on the new Y.Text should fire too.
    const before = count;
    setBlockHtml(yStore, 'late', 'updated');
    expect(count).toBeGreaterThan(before);
    unsubscribe();
  });
});

describe('resetBlockArray', () => {
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
    // Single transaction so the document never appears half-cleared to peers.
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
