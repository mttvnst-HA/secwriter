import { describe, it, expect } from 'vitest';
import { replaceAtOffset } from '../fix-utils.js';

describe('replaceAtOffset', () => {
  it('replaces the second occurrence when targetOffset points to it', () => {
    const html = 'The Contractor shall provide materials. All items shall be tested.';
    // "shall" first at offset 20, second at offset 49
    const result = replaceAtOffset(html, 'shall', 'must', 49);
    expect(result).toBe('The Contractor shall provide materials. All items must be tested.');
  });

  it('replaces the first occurrence when targetOffset points to it', () => {
    const html = 'The Contractor shall provide materials. All items shall be tested.';
    const result = replaceAtOffset(html, 'shall', 'must', 20);
    expect(result).toBe('The Contractor must provide materials. All items shall be tested.');
  });

  it('skips matches inside HTML tag syntax and replaces the correct text-content match', () => {
    const html = 'Materials <span class="mark-rid">shall</span> be provided. The Contractor shall deliver.';
    // Plain text: "Materials shall be provided. The Contractor shall deliver."
    // First "shall" plain-text offset ~10, second ~45
    const result = replaceAtOffset(html, 'shall', 'must', 45);
    expect(result).toBe('Materials <span class="mark-rid">shall</span> be provided. The Contractor must deliver.');
  });

  it('replaces match inside an element when targetOffset points there', () => {
    // Text inside element content is valid for replacement
    const html = '<b>shall</b> and shall';
    const result = replaceAtOffset(html, 'shall', 'must', 0);
    expect(result).toBe('<b>must</b> and shall');
  });

  it('handles single occurrence (regression)', () => {
    const html = 'The Contractor shall provide materials.';
    const result = replaceAtOffset(html, 'shall', 'must', 20);
    expect(result).toBe('The Contractor must provide materials.');
  });

  it('falls back to first match when targetOffset is undefined', () => {
    const html = 'shall and shall';
    const result = replaceAtOffset(html, 'shall', 'must', undefined);
    expect(result).toBe('must and shall');
  });

  it('falls back to first match when targetOffset is -1', () => {
    const html = 'shall and shall';
    const result = replaceAtOffset(html, 'shall', 'must', -1);
    expect(result).toBe('must and shall');
  });

  it('returns original HTML when match is not found', () => {
    const html = 'No violations here.';
    const result = replaceAtOffset(html, 'shall', 'must', 0);
    expect(result).toBe('No violations here.');
  });

  it('handles duplicate misspelling — fixes only the targeted one', () => {
    const html = 'The materail was tested. Another materail arrived.';
    // Second "materail" starts around offset 33
    const result = replaceAtOffset(html, 'materail', 'material', 33);
    expect(result).toBe('The materail was tested. Another material arrived.');
  });

  it('does not corrupt self-closing tags', () => {
    const html = 'shall <br/> shall';
    // Plain text offsets: first "shall" at 0, second at 6 (after space, <br/>, space)
    const result = replaceAtOffset(html, 'shall', 'must', 6);
    expect(result).toBe('shall <br/> must');
  });

  it('handles empty/null inputs gracefully', () => {
    expect(replaceAtOffset('', 'shall', 'must', 0)).toBe('');
    expect(replaceAtOffset(null, 'shall', 'must', 0)).toBe(null);
    expect(replaceAtOffset('shall', '', 'must', 0)).toBe('shall');
  });
});
