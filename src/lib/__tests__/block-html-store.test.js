/**
 * block-html-store — Y.Doc-as-source-of-truth substrate for per-block html.
 *
 * Adapter only. The binder + App.jsx wiring lands in a follow-up sub-PR.
 * Tests exercise only the public API: seedBlockArray, getBlockHtml, setBlockHtml.
 */

import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import { seedBlockArray, getBlockHtml, setBlockHtml } from '../block-html-store.js';

function makeDoc() {
  const ydoc = new Y.Doc();
  const yOrder = ydoc.getArray('order');
  const yStore = ydoc.getMap('store');
  return { ydoc, yOrder, yStore };
}

describe('tracer', () => {
  it('seedBlockArray + getBlockHtml roundtrip a single block', () => {
    const { ydoc, yOrder, yStore } = makeDoc();
    seedBlockArray(ydoc, yOrder, yStore, [
      { id: 'n1', type: 'txt', html: '<b>hello</b>' },
    ]);
    expect(getBlockHtml(yStore, 'n1')).toBe('<b>hello</b>');
  });
});
