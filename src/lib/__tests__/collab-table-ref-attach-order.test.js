/**
 * Regression test for issue #83 — table/ref CRDT construction must
 * skeleton-then-populate. PR #81 fixed the Y.XmlFragment html slot but
 * missed the parallel table (`yref-crdt.js`) and ref (`ytable-crdt.js`)
 * paths in `updateYMapFromBlock` and `blockToYMapSkeleton`.
 *
 * Reproduction shape from #83:
 *   App.jsx out-of-room mount → applyBlocksToYDoc(default sample) →
 *   blockToYMapSkeleton creates `new Y.Map()` for table, passes it to
 *   tableToYStructure (which calls `yMap.keys()` / `yMap.delete()` on a
 *   parent that is not yet attached) → Yjs emits "Invalid access:
 *   Add Yjs type to a document before reading data" once per table.
 *
 * Test asserts ZERO such warnings for every entry path that constructs
 * the table or ref nested CRDT from scratch.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as Y from 'yjs';
import { applyBlocksToYDoc } from '../collab.js';
import { seedBlockArray } from '../block-html-store.js';

const TABLE_BLOCK = {
  id: 'n2',
  type: 'table',
  part: 1,
  depth: 0,
  html: '',
  table: {
    columns: 2,
    rows: [
      [{ text: 'A1', colspan: 1 }, { text: 'B1', colspan: 1 }],
      [{ text: 'A2', colspan: 1 }, { text: 'B2', colspan: 1 }],
    ],
  },
};

const REF_BLOCK = {
  id: 'n3',
  type: 'ref',
  part: 1,
  depth: 0,
  html: '',
  ref: {
    org: 'ASTM INTERNATIONAL (ASTM)',
    entries: [
      { rid: 'ASTM D1557', rtl: 'Standard Test Methods for Laboratory Compaction Characteristics of Soil' },
      { rid: 'ASTM D2487', rtl: 'Standard Practice for Classification of Soils for Engineering Purposes' },
    ],
  },
};

const SAMPLE_BLOCKS_WITH_TABLE = [
  { id: 'n1', type: 'title', html: 'Section Title' },
  TABLE_BLOCK,
];

const SAMPLE_BLOCKS_WITH_REF = [
  { id: 'n1', type: 'title', html: 'Section Title' },
  REF_BLOCK,
];

describe('issue #83 — no Yjs "Invalid access" warnings for table/ref CRDT construction', () => {
  let warnSpy;
  let errorSpy;
  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  const offending = () => {
    const isInvalidAccess = (args) =>
      String(args[0] ?? '').includes('Add Yjs type to a document before reading data');
    return [
      ...warnSpy.mock.calls.filter(isInvalidAccess),
      ...errorSpy.mock.calls.filter(isInvalidAccess),
    ];
  };

  it('applyBlocksToYDoc with a fresh table block emits no Yjs warnings (blockToYMapSkeleton path)', () => {
    const ydoc = new Y.Doc();
    const yOrder = ydoc.getArray('order');
    const yStore = ydoc.getMap('store');
    applyBlocksToYDoc(ydoc, yOrder, yStore, SAMPLE_BLOCKS_WITH_TABLE);
    expect(offending()).toEqual([]);
  });

  it('applyBlocksToYDoc with a fresh ref block emits no Yjs warnings (blockToYMapSkeleton path)', () => {
    const ydoc = new Y.Doc();
    const yOrder = ydoc.getArray('order');
    const yStore = ydoc.getMap('store');
    applyBlocksToYDoc(ydoc, yOrder, yStore, SAMPLE_BLOCKS_WITH_REF);
    expect(offending()).toEqual([]);
  });

  it('seedBlockArray + applyBlocksToYDoc with table + ref blocks emits no Yjs warnings', () => {
    // Mirrors App.jsx's out-of-room mount sequence: html-only seed via
    // block-html-store, then collab.js applyBlocksToYDoc to attach the
    // table / ref / scalar slots.
    const ydoc = new Y.Doc();
    const yOrder = ydoc.getArray('order');
    const yStore = ydoc.getMap('store');
    const blocks = [
      { id: 'n1', type: 'title', html: 'Section Title' },
      TABLE_BLOCK,
      REF_BLOCK,
    ];
    seedBlockArray(ydoc, yOrder, yStore, blocks);
    applyBlocksToYDoc(ydoc, yOrder, yStore, blocks);
    expect(offending()).toEqual([]);
  });

  it('updateYMapFromBlock: table reseeded from legacy JSON string slot emits no Yjs warnings', () => {
    // Forces the `!curTableYMap || typeof curTableYMap === 'string'` branch
    // at collab.js:509-513 — a legacy doc with `table` stored as a JSON
    // string is upgraded to the nested CRDT structure.
    const ydoc = new Y.Doc();
    const yOrder = ydoc.getArray('order');
    const yStore = ydoc.getMap('store');
    ydoc.transact(() => {
      const yMap = new Y.Map();
      yMap.set('id', 'n2');
      yMap.set('type', 'table');
      yMap.set('html', new Y.XmlFragment()); // attached when set
      yMap.set('table', JSON.stringify(TABLE_BLOCK.table)); // legacy string
      yStore.set('n2', yMap);
      yOrder.push(['n2']);
    });

    applyBlocksToYDoc(ydoc, yOrder, yStore, [TABLE_BLOCK]);
    expect(offending()).toEqual([]);
  });

  it('updateYMapFromBlock: ref reseeded from legacy JSON string slot emits no Yjs warnings', () => {
    // Forces the `!curRefYMap || typeof curRefYMap === 'string'` branch
    // at collab.js:529-534 — legacy ref-as-JSON-string upgraded to CRDT.
    const ydoc = new Y.Doc();
    const yOrder = ydoc.getArray('order');
    const yStore = ydoc.getMap('store');
    ydoc.transact(() => {
      const yMap = new Y.Map();
      yMap.set('id', 'n3');
      yMap.set('type', 'ref');
      yMap.set('html', new Y.XmlFragment());
      yMap.set('ref', JSON.stringify(REF_BLOCK.ref));
      yStore.set('n3', yMap);
      yOrder.push(['n3']);
    });

    applyBlocksToYDoc(ydoc, yOrder, yStore, [REF_BLOCK]);
    expect(offending()).toEqual([]);
  });
});
