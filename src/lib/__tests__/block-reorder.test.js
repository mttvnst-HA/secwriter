import { describe, it, expect } from 'vitest';
import { getSectionRange, reorderSection } from '../block-reorder.js';

const makeBlocks = (specs) => specs.map(([id, type, depth]) => ({ id, type, depth: depth || 0 }));

describe('getSectionRange', () => {
  it('finds range for a title with content blocks', () => {
    const blocks = makeBlocks([
      ['t1', 'title', 1], ['b1', 'txt'], ['b2', 'txt'],
      ['t2', 'title', 1], ['b3', 'txt'],
    ]);
    expect(getSectionRange(blocks, 't1')).toEqual({ start: 0, end: 3 });
  });

  it('finds range for title followed immediately by another title', () => {
    const blocks = makeBlocks([
      ['t1', 'title', 1], ['t2', 'title', 1], ['b1', 'txt'],
    ]);
    expect(getSectionRange(blocks, 't1')).toEqual({ start: 0, end: 1 });
  });

  it('finds range for last section in document', () => {
    const blocks = makeBlocks([
      ['t1', 'title', 1], ['b1', 'txt'],
      ['t2', 'title', 1], ['b2', 'txt'], ['b3', 'note'],
    ]);
    expect(getSectionRange(blocks, 't2')).toEqual({ start: 2, end: 5 });
  });

  it('includes nested subsections in range', () => {
    const blocks = makeBlocks([
      ['t1', 'title', 1], ['b1', 'txt'],
      ['t1a', 'title', 2], ['b2', 'txt'],
      ['t2', 'title', 1], ['b3', 'txt'],
    ]);
    // t1 includes its subsection t1a
    expect(getSectionRange(blocks, 't1')).toEqual({ start: 0, end: 4 });
  });

  it('returns null for non-existent ID', () => {
    const blocks = makeBlocks([['t1', 'title', 1]]);
    expect(getSectionRange(blocks, 'missing')).toBeNull();
  });
});

describe('reorderSection', () => {
  it('moves section before another', () => {
    const blocks = makeBlocks([
      ['t1', 'title', 1], ['b1', 'txt'],
      ['t2', 'title', 1], ['b2', 'txt'],
    ]);
    const result = reorderSection(blocks, 't2', 't1', 'before');
    expect(result.map(b => b.id)).toEqual(['t2', 'b2', 't1', 'b1']);
  });

  it('moves section after another', () => {
    const blocks = makeBlocks([
      ['t1', 'title', 1], ['b1', 'txt'],
      ['t2', 'title', 1], ['b2', 'txt'],
      ['t3', 'title', 1], ['b3', 'txt'],
    ]);
    const result = reorderSection(blocks, 't1', 't3', 'after');
    expect(result.map(b => b.id)).toEqual(['t2', 'b2', 't3', 'b3', 't1', 'b1']);
  });

  it('preserves all blocks (no data loss)', () => {
    const blocks = makeBlocks([
      ['t1', 'title', 1], ['b1', 'txt'], ['b2', 'note'],
      ['t2', 'title', 1], ['b3', 'txt'],
    ]);
    const result = reorderSection(blocks, 't1', 't2', 'after');
    expect(result).toHaveLength(blocks.length);
    for (const b of blocks) {
      expect(result.find(r => r.id === b.id)).toBeTruthy();
    }
  });

  it('returns original array if drag === drop', () => {
    const blocks = makeBlocks([['t1', 'title', 1], ['b1', 'txt']]);
    expect(reorderSection(blocks, 't1', 't1', 'before')).toBe(blocks);
  });

  it('moves section with nested subsections as one unit', () => {
    const blocks = makeBlocks([
      ['t1', 'title', 1], ['b1', 'txt'],
      ['t1a', 'title', 2], ['b2', 'txt'],
      ['t2', 'title', 1], ['b3', 'txt'],
    ]);
    const result = reorderSection(blocks, 't1', 't2', 'after');
    // t1 + its content + subsection t1a should all move after t2
    expect(result.map(b => b.id)).toEqual(['t2', 'b3', 't1', 'b1', 't1a', 'b2']);
  });
});
