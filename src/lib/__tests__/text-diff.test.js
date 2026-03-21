import { describe, it, expect } from 'vitest';
import { diffWords, stripHtml, diffChars, refineWordDiff } from '../text-diff.js';

describe('diffWords', () => {
  it('returns empty for identical text', () => {
    const result = diffWords('hello world', 'hello world');
    expect(result).toEqual([{ type: 'keep', words: ['hello', 'world'] }]);
  });

  it('detects added words at end', () => {
    const result = diffWords('hello', 'hello world');
    expect(result).toEqual([
      { type: 'keep', words: ['hello'] },
      { type: 'add', words: ['world'] },
    ]);
  });

  it('detects added words at beginning', () => {
    const result = diffWords('world', 'hello world');
    expect(result).toEqual([
      { type: 'add', words: ['hello'] },
      { type: 'keep', words: ['world'] },
    ]);
  });

  it('detects deleted words', () => {
    const result = diffWords('hello beautiful world', 'hello world');
    expect(result).toEqual([
      { type: 'keep', words: ['hello'] },
      { type: 'del', words: ['beautiful'] },
      { type: 'keep', words: ['world'] },
    ]);
  });

  it('detects replaced words', () => {
    const result = diffWords('hello old world', 'hello new world');
    expect(result).toEqual([
      { type: 'keep', words: ['hello'] },
      { type: 'del', words: ['old'] },
      { type: 'add', words: ['new'] },
      { type: 'keep', words: ['world'] },
    ]);
  });

  it('handles empty old text', () => {
    const result = diffWords('', 'hello world');
    expect(result).toEqual([
      { type: 'add', words: ['hello', 'world'] },
    ]);
  });

  it('handles empty new text', () => {
    const result = diffWords('hello world', '');
    expect(result).toEqual([
      { type: 'del', words: ['hello', 'world'] },
    ]);
  });

  it('handles both empty', () => {
    const result = diffWords('', '');
    expect(result).toEqual([]);
  });

  it('detects multiple additions', () => {
    const result = diffWords('A C', 'A B C D');
    expect(result).toEqual([
      { type: 'keep', words: ['A'] },
      { type: 'add', words: ['B'] },
      { type: 'keep', words: ['C'] },
      { type: 'add', words: ['D'] },
    ]);
  });

  it('handles complete replacement', () => {
    const result = diffWords('old text here', 'new content now');
    // Complete replacement
    expect(result.some(op => op.type === 'del')).toBe(true);
    expect(result.some(op => op.type === 'add')).toBe(true);
  });
});

describe('diffChars', () => {
  it('detects single character change within a word', () => {
    const result = diffChars('test', 'text');
    expect(result).toEqual([
      { type: 'keep', text: 'te' },
      { type: 'del', text: 's' },
      { type: 'add', text: 'x' },
      { type: 'keep', text: 't' },
    ]);
  });

  it('detects appended character', () => {
    const result = diffChars('specification', 'specifications');
    expect(result).toEqual([
      { type: 'keep', text: 'specification' },
      { type: 'add', text: 's' },
    ]);
  });

  it('handles completely different strings', () => {
    const result = diffChars('cat', 'dog');
    expect(result.some(op => op.type === 'del')).toBe(true);
    expect(result.some(op => op.type === 'add')).toBe(true);
  });

  it('handles identical strings', () => {
    const result = diffChars('hello', 'hello');
    expect(result).toEqual([{ type: 'keep', text: 'hello' }]);
  });
});

describe('refineWordDiff', () => {
  it('refines del→add pairs with high similarity into charDiff', () => {
    const ops = [
      { type: 'keep', words: ['hello'] },
      { type: 'del', words: ['test'] },
      { type: 'add', words: ['text'] },
      { type: 'keep', words: ['world'] },
    ];
    const refined = refineWordDiff(ops);
    expect(refined.length).toBe(3);
    expect(refined[0].type).toBe('keep');
    expect(refined[1].type).toBe('charDiff');
    expect(refined[1].ops.some(o => o.type === 'del' && o.text === 's')).toBe(true);
    expect(refined[1].ops.some(o => o.type === 'add' && o.text === 'x')).toBe(true);
    expect(refined[2].type).toBe('keep');
  });

  it('does not refine completely different word pairs', () => {
    const ops = [
      { type: 'del', words: ['cat'] },
      { type: 'add', words: ['dog'] },
    ];
    const refined = refineWordDiff(ops);
    // "cat" vs "dog" have 0 common chars → no refinement
    expect(refined.length).toBe(2);
    expect(refined[0].type).toBe('del');
    expect(refined[1].type).toBe('add');
  });

  it('passes through keep-only diffs unchanged', () => {
    const ops = [{ type: 'keep', words: ['hello', 'world'] }];
    expect(refineWordDiff(ops)).toEqual(ops);
  });
});

describe('stripHtml', () => {
  it('strips HTML tags', () => {
    expect(stripHtml('<b>hello</b> <span class="mark-rid">world</span>'))
      .toBe('hello world');
  });

  it('strips zero-width spaces', () => {
    expect(stripHtml('hello\u200Bworld')).toBe('helloworld');
  });

  it('handles null/empty', () => {
    expect(stripHtml(null)).toBe('');
    expect(stripHtml('')).toBe('');
  });
});
