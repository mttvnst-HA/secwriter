import { describe, it, expect } from 'vitest';
import { computeNumbering, computeOliLabels } from '../numbering.js';

// ─── Section Numbering ───────────────────────────────────────────────

describe('computeNumbering', () => {
  it('numbers a single part with depth-1 titles', () => {
    const blocks = [
      { id: 'p1', type: 'title', html: 'PART 1 GENERAL', depth: 0 },
      { id: 't1', type: 'title', html: 'REFERENCES', depth: 1 },
      { id: 't2', type: 'title', html: 'DEFINITIONS', depth: 1 },
      { id: 't3', type: 'title', html: 'SUBMITTALS', depth: 1 },
    ];
    const map = computeNumbering(blocks);
    expect(map['p1']).toBeNull(); // PART titles get no number
    expect(map['t1']).toBe('1.1');
    expect(map['t2']).toBe('1.2');
    expect(map['t3']).toBe('1.3');
  });

  it('resets counters at each new PART', () => {
    const blocks = [
      { id: 'p1', type: 'title', html: 'PART 1 GENERAL', depth: 0 },
      { id: 'a', type: 'title', html: 'REFS', depth: 1 },
      { id: 'b', type: 'title', html: 'DEFS', depth: 1 },
      { id: 'p2', type: 'title', html: 'PART 2 PRODUCTS', depth: 0 },
      { id: 'c', type: 'title', html: 'MATERIALS', depth: 1 },
    ];
    const map = computeNumbering(blocks);
    expect(map['a']).toBe('1.1');
    expect(map['b']).toBe('1.2');
    expect(map['c']).toBe('2.1'); // resets to x.1
  });

  it('handles nested depths (1.1, 1.1.1, 1.1.2, 1.2)', () => {
    const blocks = [
      { id: 'p1', type: 'title', html: 'PART 1 GENERAL', depth: 0 },
      { id: 'a', type: 'title', html: 'SECTION A', depth: 1 },
      { id: 'a1', type: 'title', html: 'SUB A1', depth: 2 },
      { id: 'a2', type: 'title', html: 'SUB A2', depth: 2 },
      { id: 'b', type: 'title', html: 'SECTION B', depth: 1 },
    ];
    const map = computeNumbering(blocks);
    expect(map['a']).toBe('1.1');
    expect(map['a1']).toBe('1.1.1');
    expect(map['a2']).toBe('1.1.2');
    expect(map['b']).toBe('1.2'); // depth-2 counter reset when going back to depth-1
  });

  it('handles 3+ parts', () => {
    const blocks = [
      { id: 'p1', type: 'title', html: 'PART 1', depth: 0 },
      { id: 'a', type: 'title', html: 'A', depth: 1 },
      { id: 'p2', type: 'title', html: 'PART 2', depth: 0 },
      { id: 'b', type: 'title', html: 'B', depth: 1 },
      { id: 'p3', type: 'title', html: 'PART 3', depth: 0 },
      { id: 'c', type: 'title', html: 'C', depth: 1 },
    ];
    const map = computeNumbering(blocks);
    expect(map['a']).toBe('1.1');
    expect(map['b']).toBe('2.1');
    expect(map['c']).toBe('3.1');
  });

  it('ignores non-title blocks', () => {
    const blocks = [
      { id: 'p1', type: 'title', html: 'PART 1', depth: 0 },
      { id: 't1', type: 'title', html: 'SECT', depth: 1 },
      { id: 'x', type: 'txt', html: 'some text', depth: 1 },
      { id: 't2', type: 'title', html: 'SECT2', depth: 1 },
    ];
    const map = computeNumbering(blocks);
    expect(map['t1']).toBe('1.1');
    expect(map['t2']).toBe('1.2');
    expect(map['x']).toBeUndefined();
  });

  it('returns empty map for no blocks', () => {
    expect(computeNumbering([])).toEqual({});
  });
});

// ─── OLI Labels ──────────────────────────────────────────────────────

describe('computeOliLabels', () => {
  it('generates a. b. c. for level-1 items', () => {
    const blocks = [
      { id: 'a', type: 'oli', level: 1 },
      { id: 'b', type: 'oli', level: 1 },
      { id: 'c', type: 'oli', level: 1 },
    ];
    const labels = computeOliLabels(blocks);
    expect(labels['a']).toBe('a.');
    expect(labels['b']).toBe('b.');
    expect(labels['c']).toBe('c.');
  });

  it('overflows past z to aa. ab. ac.', () => {
    const blocks = [];
    for (let i = 0; i < 28; i++) {
      blocks.push({ id: `o${i}`, type: 'oli', level: 1 });
    }
    const labels = computeOliLabels(blocks);
    expect(labels['o0']).toBe('a.');
    expect(labels['o25']).toBe('z.');
    expect(labels['o26']).toBe('aa.');
    expect(labels['o27']).toBe('ab.');
  });

  it('generates 1. 2. 3. for level-2 items', () => {
    const blocks = [
      { id: 'a', type: 'oli', level: 2 },
      { id: 'b', type: 'oli', level: 2 },
    ];
    const labels = computeOliLabels(blocks);
    expect(labels['a']).toBe('1.');
    expect(labels['b']).toBe('2.');
  });

  it('uses independent counters per level', () => {
    const blocks = [
      { id: 'a', type: 'oli', level: 1 },  // a.
      { id: 'b', type: 'oli', level: 1 },  // b.
      { id: 'c', type: 'oli', level: 2 },  // 1.
      { id: 'd', type: 'oli', level: 2 },  // 2.
      { id: 'e', type: 'oli', level: 1 },  // c. (continues, not e.)
    ];
    const labels = computeOliLabels(blocks);
    expect(labels['a']).toBe('a.');
    expect(labels['b']).toBe('b.');
    expect(labels['c']).toBe('1.');
    expect(labels['d']).toBe('2.');
    expect(labels['e']).toBe('c.');
  });

  it('resets all counters at LST block', () => {
    const blocks = [
      { id: 'a', type: 'oli', level: 1 },
      { id: 'b', type: 'oli', level: 1 },
      { id: 'l', type: 'lst' },
      { id: 'c', type: 'oli', level: 1 },
    ];
    const labels = computeOliLabels(blocks);
    expect(labels['a']).toBe('a.');
    expect(labels['b']).toBe('b.');
    expect(labels['c']).toBe('a.'); // reset
  });

  it('resets at non-list block (e.g. txt)', () => {
    const blocks = [
      { id: 'a', type: 'oli', level: 1 },
      { id: 'b', type: 'oli', level: 1 },
      { id: 't', type: 'txt', html: 'paragraph' },
      { id: 'c', type: 'oli', level: 1 },
    ];
    const labels = computeOliLabels(blocks);
    expect(labels['b']).toBe('b.');
    expect(labels['c']).toBe('a.'); // reset
  });

  it('notes between OLIs do NOT reset counter', () => {
    const blocks = [
      { id: 'a', type: 'oli', level: 1 },
      { id: 'n', type: 'note', html: 'a note' },
      { id: 'b', type: 'oli', level: 1 },
    ];
    const labels = computeOliLabels(blocks);
    expect(labels['a']).toBe('a.');
    expect(labels['b']).toBe('b.'); // note didn't reset
  });

  it('resets deeper counters when returning to shallower level', () => {
    const blocks = [
      { id: 'a', type: 'oli', level: 1 },
      { id: 'x', type: 'oli', level: 2 },
      { id: 'y', type: 'oli', level: 2 },
      { id: 'b', type: 'oli', level: 1 },
      { id: 'z', type: 'oli', level: 2 },  // should restart at 1.
    ];
    const labels = computeOliLabels(blocks);
    expect(labels['x']).toBe('1.');
    expect(labels['y']).toBe('2.');
    expect(labels['z']).toBe('1.'); // reset when went back to level 1 then back to 2
  });

  it('returns empty map for no blocks', () => {
    expect(computeOliLabels([])).toEqual({});
  });

  it('handles default level (undefined treated as 1)', () => {
    const blocks = [
      { id: 'a', type: 'oli' }, // no level property
      { id: 'b', type: 'oli' },
    ];
    const labels = computeOliLabels(blocks);
    expect(labels['a']).toBe('a.');
    expect(labels['b']).toBe('b.');
  });
});
