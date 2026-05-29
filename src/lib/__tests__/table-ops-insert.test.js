import { describe, it, expect } from 'vitest';
import { insertRowAt, insertColumnAt } from '../table-ops.js';

const t = () => ({
  columns: 2,
  rows: [
    [{ text: 'a', colspan: 1 }, { text: 'b', colspan: 1 }],
    [{ text: 'c', colspan: 1 }, { text: 'd', colspan: 1 }],
  ],
});

describe('insertRowAt', () => {
  it('inserts an empty row at the index, pushing the rest down', () => {
    const r = insertRowAt(t(), 1);
    expect(r.rows.length).toBe(3);
    expect(r.rows[1]).toEqual([{ text: '', colspan: 1 }, { text: '', colspan: 1 }]);
    expect(r.rows[2][0].text).toBe('c');
  });
  it('clamps an out-of-range index to append', () => {
    const r = insertRowAt(t(), 99);
    expect(r.rows.length).toBe(3);
    expect(r.rows[2]).toEqual([{ text: '', colspan: 1 }, { text: '', colspan: 1 }]);
  });
});

describe('insertColumnAt', () => {
  it('inserts an empty visual column at the index', () => {
    const r = insertColumnAt(t(), 1);
    expect(r.columns).toBe(3);
    expect(r.rows[0].map(c => c.text)).toEqual(['a', '', 'b']);
  });
  it('extends a spanning cell when the insert falls inside its span', () => {
    const spanned = { columns: 2, rows: [[{ text: 'wide', colspan: 2 }]] };
    const r = insertColumnAt(spanned, 1);
    expect(r.columns).toBe(3);
    expect(r.rows[0][0].colspan).toBe(3);
  });
  it('prepends at visual column 0', () => {
    const r = insertColumnAt(t(), 0);
    expect(r.columns).toBe(3);
    expect(r.rows[0].map(c => c.text)).toEqual(['', 'a', 'b']);
    expect(r.rows[1].map(c => c.text)).toEqual(['', 'c', 'd']);
  });
  it('appends when the index is at/past the end', () => {
    const r = insertColumnAt(t(), 99);
    expect(r.columns).toBe(3);
    expect(r.rows[0].map(c => c.text)).toEqual(['a', 'b', '']);
  });
});
