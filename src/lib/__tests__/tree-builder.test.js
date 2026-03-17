import { describe, it, expect } from 'vitest';
import { buildTree } from '../tree-builder.js';

describe('buildTree', () => {
  it('returns empty array for no blocks', () => {
    expect(buildTree([])).toEqual([]);
  });

  it('returns empty array when no title blocks', () => {
    const blocks = [
      { id: 'a', type: 'txt', html: 'hello' },
      { id: 'b', type: 'note', html: 'note' },
    ];
    expect(buildTree(blocks)).toEqual([]);
  });

  it('creates flat list for same-depth titles', () => {
    const blocks = [
      { id: 'a', type: 'title', html: 'PART 1', depth: 0 },
      { id: 'b', type: 'title', html: 'PART 2', depth: 0 },
    ];
    const tree = buildTree(blocks);
    expect(tree).toHaveLength(2);
    expect(tree[0].id).toBe('a');
    expect(tree[1].id).toBe('b');
    expect(tree[0].children).toEqual([]);
    expect(tree[1].children).toEqual([]);
  });

  it('nests depth-1 under depth-0 (PART)', () => {
    const blocks = [
      { id: 'p', type: 'title', html: 'PART 1', depth: 0 },
      { id: 'a', type: 'title', html: 'REFS', depth: 1 },
      { id: 'b', type: 'title', html: 'DEFS', depth: 1 },
    ];
    const tree = buildTree(blocks);
    expect(tree).toHaveLength(1);
    expect(tree[0].children).toHaveLength(2);
    expect(tree[0].children[0].id).toBe('a');
    expect(tree[0].children[1].id).toBe('b');
  });

  it('nests 3 levels deep', () => {
    const blocks = [
      { id: 'p', type: 'title', html: 'PART 1', depth: 0 },
      { id: 'a', type: 'title', html: 'SEC A', depth: 1 },
      { id: 'a1', type: 'title', html: 'SUB A1', depth: 2 },
      { id: 'a1a', type: 'title', html: 'SUB-SUB', depth: 3 },
    ];
    const tree = buildTree(blocks);
    expect(tree[0].children[0].children[0].children[0].id).toBe('a1a');
  });

  it('sibling sections at same depth go under same parent', () => {
    const blocks = [
      { id: 'p', type: 'title', html: 'PART 1', depth: 0 },
      { id: 'a', type: 'title', html: 'SEC A', depth: 1 },
      { id: 'a1', type: 'title', html: 'SUB A1', depth: 2 },
      { id: 'b', type: 'title', html: 'SEC B', depth: 1 }, // pops back up
      { id: 'b1', type: 'title', html: 'SUB B1', depth: 2 },
    ];
    const tree = buildTree(blocks);
    const part = tree[0];
    expect(part.children).toHaveLength(2); // SEC A and SEC B
    expect(part.children[0].children).toHaveLength(1); // SUB A1
    expect(part.children[1].children).toHaveLength(1); // SUB B1
  });

  it('handles multiple parts with separate children', () => {
    const blocks = [
      { id: 'p1', type: 'title', html: 'PART 1', depth: 0 },
      { id: 'a', type: 'title', html: 'A', depth: 1 },
      { id: 'p2', type: 'title', html: 'PART 2', depth: 0 },
      { id: 'b', type: 'title', html: 'B', depth: 1 },
    ];
    const tree = buildTree(blocks);
    expect(tree).toHaveLength(2);
    expect(tree[0].children).toHaveLength(1);
    expect(tree[1].children).toHaveLength(1);
    expect(tree[0].children[0].id).toBe('a');
    expect(tree[1].children[0].id).toBe('b');
  });

  it('preserves text from html property', () => {
    const blocks = [
      { id: 'a', type: 'title', html: 'GENERAL', depth: 0 },
    ];
    const tree = buildTree(blocks);
    expect(tree[0].text).toBe('GENERAL');
  });
});
