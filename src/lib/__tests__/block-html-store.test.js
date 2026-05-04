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

import { seedBlockArray, getBlockHtml, setBlockHtml } from '../block-html-store.js';
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
