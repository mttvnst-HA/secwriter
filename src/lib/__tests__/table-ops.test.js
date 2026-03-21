import { describe, it, expect } from 'vitest';
import { addRow, deleteRow, addColumn, deleteColumn, updateCell, cloneTable, mergeCellRight, splitCell } from '../table-ops.js';

const makeTable = (cols, rows) => ({
  columns: cols,
  rows: rows.map(r => r.map(c => typeof c === 'string' ? { text: c, colspan: 1 } : c)),
});

describe('addRow', () => {
  it('appends a row with correct number of empty cells', () => {
    const t = makeTable(3, [['a', 'b', 'c']]);
    const result = addRow(t);
    expect(result.rows).toHaveLength(2);
    expect(result.rows[1]).toEqual([
      { text: '', colspan: 1 },
      { text: '', colspan: 1 },
      { text: '', colspan: 1 },
    ]);
  });

  it('does not mutate the original table', () => {
    const t = makeTable(2, [['a', 'b']]);
    addRow(t);
    expect(t.rows).toHaveLength(1);
  });
});

describe('deleteRow', () => {
  it('removes the specified row', () => {
    const t = makeTable(2, [['a', 'b'], ['c', 'd'], ['e', 'f']]);
    const result = deleteRow(t, 1);
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0][0].text).toBe('a');
    expect(result.rows[1][0].text).toBe('e');
  });

  it('returns null when only one row remains', () => {
    const t = makeTable(2, [['a', 'b']]);
    expect(deleteRow(t, 0)).toBeNull();
  });
});

describe('addColumn', () => {
  it('increments column count and adds cell to each row', () => {
    const t = makeTable(2, [['a', 'b'], ['c', 'd']]);
    const result = addColumn(t);
    expect(result.columns).toBe(3);
    expect(result.rows[0]).toHaveLength(3);
    expect(result.rows[0][2].text).toBe('');
    expect(result.rows[1][2].text).toBe('');
  });

  it('extends colspan for rows that already span all columns', () => {
    const t = {
      columns: 2,
      rows: [[{ text: 'caption', colspan: 2 }], [{ text: 'a', colspan: 1 }, { text: 'b', colspan: 1 }]],
    };
    const result = addColumn(t);
    expect(result.columns).toBe(3);
    expect(result.rows[0][0].colspan).toBe(3); // caption extended
    expect(result.rows[1]).toHaveLength(3); // data row got new cell
  });
});

describe('deleteColumn', () => {
  it('decrements column count and removes cell from each row', () => {
    const t = makeTable(3, [['a', 'b', 'c'], ['d', 'e', 'f']]);
    const result = deleteColumn(t, 1); // delete middle column
    expect(result.columns).toBe(2);
    expect(result.rows[0].map(c => c.text)).toEqual(['a', 'c']);
    expect(result.rows[1].map(c => c.text)).toEqual(['d', 'f']);
  });

  it('reduces colspan when deleting a column spanned by a colspan cell', () => {
    const t = {
      columns: 3,
      rows: [[{ text: 'spans', colspan: 3 }], [{ text: 'a', colspan: 1 }, { text: 'b', colspan: 1 }, { text: 'c', colspan: 1 }]],
    };
    const result = deleteColumn(t, 0);
    expect(result.columns).toBe(2);
    expect(result.rows[0][0].colspan).toBe(2); // reduced from 3
    expect(result.rows[1].map(c => c.text)).toEqual(['b', 'c']);
  });

  it('returns null when only one column remains', () => {
    const t = makeTable(1, [['a'], ['b']]);
    expect(deleteColumn(t, 0)).toBeNull();
  });
});

describe('updateCell', () => {
  it('updates the correct cell text', () => {
    const t = makeTable(2, [['a', 'b'], ['c', 'd']]);
    const result = updateCell(t, 1, 0, 'updated');
    expect(result.rows[1][0].text).toBe('updated');
    expect(result.rows[0][0].text).toBe('a'); // other cells unchanged
  });

  it('does not mutate the original table', () => {
    const t = makeTable(2, [['a', 'b']]);
    updateCell(t, 0, 0, 'changed');
    expect(t.rows[0][0].text).toBe('a');
  });
});

describe('cloneTable', () => {
  it('creates a deep copy', () => {
    const t = makeTable(2, [['a', 'b']]);
    const clone = cloneTable(t);
    clone.rows[0][0].text = 'changed';
    expect(t.rows[0][0].text).toBe('a');
  });
});

describe('mergeCellRight', () => {
  it('merges a cell with its right neighbor', () => {
    const t = makeTable(3, [
      [{ text: 'A', colspan: 1 }, { text: 'B', colspan: 1 }, { text: 'C', colspan: 1 }],
    ]);
    const result = mergeCellRight(t, 0, 0);
    expect(result.rows[0]).toHaveLength(2);
    expect(result.rows[0][0].text).toBe('A B');
    expect(result.rows[0][0].colspan).toBe(2);
  });

  it('returns null when cell is at right edge', () => {
    const t = makeTable(2, [
      [{ text: 'A', colspan: 1 }, { text: 'B', colspan: 1 }],
    ]);
    expect(mergeCellRight(t, 0, 1)).toBeNull();
  });

  it('combines colspans when merging', () => {
    const t = makeTable(4, [
      [{ text: 'A', colspan: 2 }, { text: 'B', colspan: 2 }],
    ]);
    const result = mergeCellRight(t, 0, 0);
    expect(result.rows[0]).toHaveLength(1);
    expect(result.rows[0][0].colspan).toBe(4);
  });
});

describe('splitCell', () => {
  it('splits a cell with colspan > 1', () => {
    const t = makeTable(3, [
      [{ text: 'AB', colspan: 2 }, { text: 'C', colspan: 1 }],
    ]);
    const result = splitCell(t, 0, 0);
    expect(result.rows[0]).toHaveLength(3);
    expect(result.rows[0][0].colspan).toBe(1);
    expect(result.rows[0][0].text).toBe('AB');
    expect(result.rows[0][1].text).toBe('');
    expect(result.rows[0][1].colspan).toBe(1);
  });

  it('returns null for cell with colspan 1', () => {
    const t = makeTable(2, [
      [{ text: 'A', colspan: 1 }, { text: 'B', colspan: 1 }],
    ]);
    expect(splitCell(t, 0, 0)).toBeNull();
  });
});
