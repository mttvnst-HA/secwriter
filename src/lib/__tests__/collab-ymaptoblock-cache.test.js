/**
 * #222 regression — yMapToBlock html derivation must hit the shared
 * pm-fragment-cache so an in-room keystroke re-serializes only the ONE
 * mutated block, not all N.
 *
 * Mechanism (issue #222): a PM keystroke writes the block's Y.XmlFragment
 * under origin `ySyncPluginKey`. `handleAfterTx` (collab.js) classifies that
 * as a blocks change and calls `yBlocksToArray(yOrder, yStore)` with NO
 * debounce. Pre-fix, `yMapToBlock` called `pmFragmentToHtml` directly per
 * block — uncached — so every keystroke cost O(N) fragment serializations
 * (18.8 ms at 1200 blocks). The fix routes the derivation through the same
 * WeakMap `block-html-store` already used, so unchanged slots are cache hits.
 *
 * Verification strategy (verbatim from the issue): transact a one-character
 * fragment change with origin `ySyncPluginKey`, instrument `pmFragmentToHtml`
 * call count, assert it is 1 (changed block only), not N.
 */

import { describe, it, expect, vi } from 'vitest';
import * as Y from 'yjs';
import { ySyncPluginKey } from 'y-prosemirror';

vi.mock('../pmdoc-html.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, pmFragmentToHtml: vi.fn(actual.pmFragmentToHtml) };
});

import { seedBlockArray } from '../block-html-store.js';
import { yBlocksToArray } from '../collab.js';
import { pmFragmentToHtml as spiedPmFragmentToHtml } from '../pmdoc-html.js';

function makeDoc() {
  const ydoc = new Y.Doc();
  const yOrder = ydoc.getArray('order');
  const yStore = ydoc.getMap('store');
  return { ydoc, yOrder, yStore };
}

/** Descend to the first Y.XmlText leaf in a fragment and insert a char —
 * the CRDT-level shape of a single PM keystroke. */
function typeOneChar(frag) {
  let node = frag;
  while (node && typeof node.get === 'function' && node.length > 0) {
    if (typeof node.toDelta === 'function' && typeof node.insert === 'function') {
      node.insert(0, 'x'); // Y.XmlText
      return true;
    }
    node = node.get(0);
  }
  if (node && typeof node.toDelta === 'function') { node.insert(0, 'x'); return true; }
  return false;
}

describe('#222 — yMapToBlock shares the fragment cache', () => {
  it('a single keystroke re-derives only the mutated block (not all N)', () => {
    const N = 8;
    const { ydoc, yOrder, yStore } = makeDoc();
    seedBlockArray(
      ydoc, yOrder, yStore,
      Array.from({ length: N }, (_, i) => ({ id: `n${i}`, type: 'txt', html: `block ${i}` })),
    );

    // Prime: first full snapshot registers every slot's observer + derives
    // each once. This is the unavoidable O(N) initial walk.
    const first = yBlocksToArray(yOrder, yStore);
    expect(first).toHaveLength(N);
    expect(first[3].html).toBe('block 3');

    // A second snapshot with no intervening edit must be all cache hits.
    spiedPmFragmentToHtml.mockClear();
    yBlocksToArray(yOrder, yStore);
    expect(spiedPmFragmentToHtml).not.toHaveBeenCalled();

    // One keystroke into block n3 under the PM origin.
    spiedPmFragmentToHtml.mockClear();
    ydoc.transact(() => {
      const frag = yStore.get('n3').get('html');
      expect(typeOneChar(frag)).toBe(true);
    }, ySyncPluginKey);

    const after = yBlocksToArray(yOrder, yStore);
    // Exactly ONE re-derivation — the changed block — not N.
    expect(spiedPmFragmentToHtml).toHaveBeenCalledTimes(1);
    expect(after[3].html).toBe('xblock 3');
    // Untouched blocks still correct (served from cache).
    expect(after[0].html).toBe('block 0');
    expect(after[7].html).toBe('block 7');
  });
});
