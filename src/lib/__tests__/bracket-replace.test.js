import { describe, it, expect } from 'vitest';
import { findBrackets, groupBrackets } from '../bracket-replace.js';

describe('findBrackets', () => {
  it('finds [bracketed] text in blocks', () => {
    const blocks = [
      { id: 'b1', type: 'txt', html: 'Use [concrete type] for the foundation.' },
    ];
    const results = findBrackets(blocks);
    expect(results).toHaveLength(1);
    expect(results[0].blockId).toBe('b1');
    expect(results[0].text).toBe('[concrete type]');
    expect(results[0].innerText).toBe('concrete type');
    expect(results[0].offset).toBe(4);
    expect(results[0].length).toBe(15);
  });

  it('finds multiple brackets in same block', () => {
    const blocks = [
      { id: 'b1', type: 'txt', html: '[Item A] and [Item B] are required.' },
    ];
    const results = findBrackets(blocks);
    expect(results).toHaveLength(2);
    expect(results[0].innerText).toBe('Item A');
    expect(results[1].innerText).toBe('Item B');
  });

  it('finds brackets across multiple blocks', () => {
    const blocks = [
      { id: 'b1', type: 'txt', html: 'Use [Type A] concrete.' },
      { id: 'b2', type: 'txt', html: 'Apply [Type B] coating.' },
    ];
    const results = findBrackets(blocks);
    expect(results).toHaveLength(2);
    expect(results[0].blockId).toBe('b1');
    expect(results[1].blockId).toBe('b2');
  });

  it('skips blocks with no HTML', () => {
    const blocks = [
      { id: 'b1', type: 'table', table: {} },
      { id: 'b2', type: 'txt', html: 'Has [bracket] here' },
    ];
    const results = findBrackets(blocks);
    expect(results).toHaveLength(1);
    expect(results[0].blockId).toBe('b2');
  });

  it('returns empty array when no brackets found', () => {
    const blocks = [
      { id: 'b1', type: 'txt', html: 'No brackets here' },
    ];
    expect(findBrackets(blocks)).toEqual([]);
  });

  it('does not match nested brackets', () => {
    const blocks = [
      { id: 'b1', type: 'txt', html: 'Text [[nested]] here' },
    ];
    const results = findBrackets(blocks);
    // Should find [nested] (inner brackets), not [[nested]]
    expect(results).toHaveLength(1);
    expect(results[0].text).toBe('[nested]');
  });

  it('finds brackets inside inline mark spans', () => {
    const blocks = [
      { id: 'b1', type: 'txt', html: 'See <span class="mark-eng">[3 inches]</span> requirement' },
    ];
    const results = findBrackets(blocks);
    expect(results).toHaveLength(1);
    expect(results[0].innerText).toBe('3 inches');
  });
});

describe('groupBrackets', () => {
  it('groups identical bracket text together', () => {
    const brackets = [
      { blockId: 'b1', text: '[Type A]', innerText: 'Type A', offset: 0, length: 8 },
      { blockId: 'b2', text: '[Type A]', innerText: 'Type A', offset: 5, length: 8 },
      { blockId: 'b3', text: '[Type B]', innerText: 'Type B', offset: 0, length: 8 },
    ];
    const groups = groupBrackets(brackets);
    expect(groups.size).toBe(2);
    expect(groups.get('Type A').count).toBe(2);
    expect(groups.get('Type B').count).toBe(1);
  });

  it('returns empty map for empty input', () => {
    const groups = groupBrackets([]);
    expect(groups.size).toBe(0);
  });
});
