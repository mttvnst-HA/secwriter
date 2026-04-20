// src/lib/__tests__/ytable-crdt.test.js
import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import { tableToYStructure, yStructureToTable, diffTableForPublish, applyTableCellEdits } from '../ytable-crdt.js';

function makeTableYMap() {
  const ydoc = new Y.Doc();
  const yMap = ydoc.getMap('table');
  return { ydoc, yMap };
}

const sampleTable = {
  columns: 2,
  rows: [
    [{ text: 'A1', colspan: 1 }, { text: 'B1', colspan: 1 }],
    [{ text: 'A2', colspan: 1 }, { text: 'B2', colspan: 1 }],
  ],
};

describe('tableToYStructure + yStructureToTable roundtrip', () => {
  it('roundtrips a simple table', () => {
    const { ydoc, yMap } = makeTableYMap();
    ydoc.transact(() => tableToYStructure(yMap, sampleTable));
    const result = yStructureToTable(yMap);
    expect(result.columns).toBe(2);
    expect(result.rows.length).toBe(2);
    expect(result.rows[0][0].text).toBe('A1');
    expect(result.rows[0][1].text).toBe('B1');
    expect(result.rows[1][0].text).toBe('A2');
    expect(result.rows[1][1].colspan).toBe(1);
  });

  it('preserves colspan values', () => {
    const table = {
      columns: 3,
      rows: [[{ text: 'merged', colspan: 2 }, { text: 'C1', colspan: 1 }]],
    };
    const { ydoc, yMap } = makeTableYMap();
    ydoc.transact(() => tableToYStructure(yMap, table));
    const result = yStructureToTable(yMap);
    expect(result.rows[0][0].colspan).toBe(2);
  });

  it('preserves optional colWidths and rowHeights', () => {
    const table = { ...sampleTable, colWidths: [100, 200], rowHeights: [24, 30] };
    const { ydoc, yMap } = makeTableYMap();
    ydoc.transact(() => tableToYStructure(yMap, table));
    const result = yStructureToTable(yMap);
    expect(result.colWidths).toEqual([100, 200]);
    expect(result.rowHeights).toEqual([24, 30]);
  });

  it('preserves cell HTML with marks via Y.Text', () => {
    const table = {
      columns: 1,
      rows: [[{ text: '<b>bold cell</b>', colspan: 1 }]],
    };
    const { ydoc, yMap } = makeTableYMap();
    ydoc.transact(() => tableToYStructure(yMap, table));
    const result = yStructureToTable(yMap);
    expect(result.rows[0][0].text).toBe('<b>bold cell</b>');
  });
});

describe('diffTableForPublish', () => {
  it('detects cell-text-only changes', () => {
    const next = {
      columns: 2,
      rows: [
        [{ text: 'A1 modified', colspan: 1 }, { text: 'B1', colspan: 1 }],
        [{ text: 'A2', colspan: 1 }, { text: 'B2', colspan: 1 }],
      ],
    };
    const result = diffTableForPublish(sampleTable, next);
    expect(result.type).toBe('cells');
    expect(result.changes).toEqual([{ row: 0, cell: 0, html: 'A1 modified' }]);
  });

  it('detects structural change (column count)', () => {
    const next = { columns: 3, rows: sampleTable.rows };
    const result = diffTableForPublish(sampleTable, next);
    expect(result.type).toBe('structural');
  });

  it('detects structural change (row count)', () => {
    const next = { columns: 2, rows: [sampleTable.rows[0]] };
    const result = diffTableForPublish(sampleTable, next);
    expect(result.type).toBe('structural');
  });

  it('detects structural change (colspan changed)', () => {
    const next = {
      columns: 2,
      rows: [
        [{ text: 'merged', colspan: 2 }],
        sampleTable.rows[1],
      ],
    };
    const result = diffTableForPublish(sampleTable, next);
    expect(result.type).toBe('structural');
  });

  it('returns no changes when tables are identical', () => {
    const result = diffTableForPublish(sampleTable, sampleTable);
    expect(result.type).toBe('cells');
    expect(result.changes).toEqual([]);
  });
});

describe('applyTableCellEdits', () => {
  it('updates a single cell Y.Text without touching other cells', () => {
    const { ydoc, yMap } = makeTableYMap();
    ydoc.transact(() => tableToYStructure(yMap, sampleTable));

    const rowsArr = yMap.get('rows');
    const row1 = rowsArr.get(1);
    const cellB2Map = row1.get(1);
    const b2YText = cellB2Map.get('text');

    applyTableCellEdits(yMap, [{ row: 0, cell: 0, html: 'A1 edited' }]);

    const b2YTextAfter = row1.get(1).get('text');
    expect(b2YTextAfter).toBe(b2YText);

    const result = yStructureToTable(yMap);
    expect(result.rows[0][0].text).toBe('A1 edited');
    expect(result.rows[1][1].text).toBe('B2');
  });
});

describe('two-doc table cell merge', () => {
  it('concurrent cell edits on different cells merge', () => {
    const doc1 = new Y.Doc(); const doc2 = new Y.Doc();
    const m1 = doc1.getMap('t'); const m2 = doc2.getMap('t');

    doc1.transact(() => tableToYStructure(m1, sampleTable));
    Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1, Y.encodeStateVector(doc2)));

    applyTableCellEdits(m1, [{ row: 0, cell: 0, html: 'Doc1 A1' }]);
    applyTableCellEdits(m2, [{ row: 1, cell: 1, html: 'Doc2 B2' }]);

    const u1 = Y.encodeStateAsUpdate(doc1, Y.encodeStateVector(doc2));
    const u2 = Y.encodeStateAsUpdate(doc2, Y.encodeStateVector(doc1));
    Y.applyUpdate(doc1, u2);
    Y.applyUpdate(doc2, u1);

    const r1 = yStructureToTable(m1);
    const r2 = yStructureToTable(m2);
    expect(r1.rows[0][0].text).toBe('Doc1 A1');
    expect(r1.rows[1][1].text).toBe('Doc2 B2');
    expect(r1.rows[0][0].text).toBe(r2.rows[0][0].text);
    expect(r1.rows[1][1].text).toBe(r2.rows[1][1].text);
  });
});
