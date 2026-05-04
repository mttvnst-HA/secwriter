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
