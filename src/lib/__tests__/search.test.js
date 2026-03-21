import { describe, it, expect } from 'vitest';
import { searchBlocks, replaceMatchInHtml } from '../../components/SearchBar.jsx';

describe('searchBlocks', () => {
  it('finds matches with correct offsets', () => {
    const blocks = [
      { id: 'b1', type: 'txt', html: 'Hello world' },
    ];
    const results = searchBlocks(blocks, 'world');
    expect(results).toEqual([{ blockId: 'b1', offset: 6, length: 5 }]);
  });

  it('performs case-insensitive matching', () => {
    const blocks = [
      { id: 'b1', type: 'txt', html: 'EARTHWORK specifications' },
    ];
    const results = searchBlocks(blocks, 'earthwork');
    expect(results).toEqual([{ blockId: 'b1', offset: 0, length: 9 }]);
  });

  it('finds multiple matches in same block', () => {
    const blocks = [
      { id: 'b1', type: 'txt', html: 'test one test two test three' },
    ];
    const results = searchBlocks(blocks, 'test');
    expect(results).toHaveLength(3);
    expect(results[0].offset).toBe(0);
    expect(results[1].offset).toBe(9);
    expect(results[2].offset).toBe(18);
  });

  it('returns empty array for no matches', () => {
    const blocks = [
      { id: 'b1', type: 'txt', html: 'Hello world' },
    ];
    expect(searchBlocks(blocks, 'xyz')).toEqual([]);
  });

  it('skips blocks with no HTML', () => {
    const blocks = [
      { id: 'b1', type: 'table', table: {} },
      { id: 'b2', type: 'txt', html: null },
      { id: 'b3', type: 'txt', html: 'found it' },
    ];
    const results = searchBlocks(blocks, 'found');
    expect(results).toEqual([{ blockId: 'b3', offset: 0, length: 5 }]);
  });

  it('searches plain text ignoring HTML tags and inline marks', () => {
    const blocks = [
      { id: 'b1', type: 'txt', html: 'See <span class="mark-rid">ASTM D2487</span> for details' },
    ];
    const results = searchBlocks(blocks, 'astm d2487');
    expect(results).toHaveLength(1);
    expect(results[0].blockId).toBe('b1');
  });

  it('returns empty for empty query', () => {
    const blocks = [{ id: 'b1', type: 'txt', html: 'text' }];
    expect(searchBlocks(blocks, '')).toEqual([]);
  });
});

describe('replaceMatchInHtml', () => {
  it('replaces plain text at correct offset', () => {
    const result = replaceMatchInHtml('Hello world', 6, 5, 'earth');
    expect(result).toBe('Hello earth');
  });

  it('replaces text inside an inline mark span', () => {
    const html = 'See <span class="mark-rid">ASTM D2487</span> for details';
    // "ASTM D2487" starts at offset 4 in visible text ("See ASTM D2487 for details")
    const result = replaceMatchInHtml(html, 4, 10, 'ASTM C150');
    expect(result).toContain('ASTM C150');
    expect(result).toContain('mark-rid');
  });

  it('replaces at the start of the string', () => {
    const result = replaceMatchInHtml('Hello world', 0, 5, 'Goodbye');
    expect(result).toBe('Goodbye world');
  });

  it('replaces at the end of the string', () => {
    const result = replaceMatchInHtml('Hello world', 6, 5, 'universe');
    expect(result).toBe('Hello universe');
  });

  it('replaces with empty string (deletion)', () => {
    const result = replaceMatchInHtml('Hello world', 5, 6, '');
    expect(result).toBe('Hello');
  });

  it('returns original HTML if offset not found', () => {
    const html = 'short';
    const result = replaceMatchInHtml(html, 100, 5, 'nope');
    expect(result).toBe('short');
  });

  it('skips del.mark-del content when finding offset', () => {
    const html = 'Keep <del class="mark-del">deleted</del>text here';
    // Visible text is "Keep text here" (del content excluded)
    // "text" starts at offset 5 in visible text
    const result = replaceMatchInHtml(html, 5, 4, 'more');
    expect(result).toContain('more');
    expect(result).toContain('mark-del'); // del element preserved
    expect(result).not.toContain('text here');
  });
});
