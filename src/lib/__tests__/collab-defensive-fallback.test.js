/**
 * Regression test for issue #77 — Y.XmlFragment defensive-recovery branch
 * in updateYMapFromBlock must skeleton-then-populate, not detached-then-attach.
 *
 * Also asserts that a healthy seed + applyBlocksToYDoc sequence (the shape
 * App.jsx runs on every fresh out-of-room mount) emits ZERO
 * "Invalid access: Add Yjs type to a document before reading data" warnings.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as Y from 'yjs';
import { applyBlocksToYDoc } from '../collab.js';
import { seedBlockArray } from '../block-html-store.js';

const SAMPLE_BLOCKS = [
  { id: 'n1', type: 'title', html: 'Section Title' },
  { id: 'n2', type: 'txt', part: 1, depth: 0, html: 'Para one.' },
  { id: 'n3', type: 'txt', part: 1, depth: 0, html: 'Para two.' },
];

describe('issue #77 — no Y.XmlFragment "Invalid access" warnings on healthy load', () => {
  let warnSpy;
  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('seedBlockArray + applyBlocksToYDoc on default sample emits no Yjs warnings', () => {
    const ydoc = new Y.Doc();
    const yOrder = ydoc.getArray('order');
    const yStore = ydoc.getMap('store');
    seedBlockArray(ydoc, yOrder, yStore, SAMPLE_BLOCKS);
    applyBlocksToYDoc(ydoc, yOrder, yStore, SAMPLE_BLOCKS);

    const offending = warnSpy.mock.calls.filter((args) =>
      String(args[0] ?? '').includes('Add Yjs type to a document before reading data'),
    );
    expect(offending).toEqual([]);
  });

  it('updateYMapFromBlock defensive recovery does not emit warnings on malformed slot', () => {
    const ydoc = new Y.Doc();
    const yOrder = ydoc.getArray('order');
    const yStore = ydoc.getMap('store');

    // Stand up a Y.Map whose html slot is missing — forces the defensive
    // branch at collab.js:561-568.
    ydoc.transact(() => {
      const yMap = new Y.Map();
      yMap.set('id', 'n1');
      yMap.set('type', 'txt');
      // intentionally no html slot
      yStore.set('n1', yMap);
      yOrder.push(['n1']);
    });

    applyBlocksToYDoc(ydoc, yOrder, yStore, [{ id: 'n1', type: 'txt', html: 'hello' }]);

    const offending = warnSpy.mock.calls.filter((args) =>
      String(args[0] ?? '').includes('Add Yjs type to a document before reading data'),
    );
    expect(offending).toEqual([]);
  });
});
