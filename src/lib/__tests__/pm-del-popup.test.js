import { describe, it, expect } from 'vitest';
import { applyDelAction } from '../pm-del-popup.js';

describe('applyDelAction', () => {
  it('accept removes the del element and its content', () => {
    const html = 'before <del class="mark-del">deleted</del> after';
    expect(applyDelAction(html, 0, 'accept')).toBe('before  after');
  });

  it('reject replaces the del element with its text content', () => {
    const html = 'before <del class="mark-del">restored</del> after';
    expect(applyDelAction(html, 0, 'reject')).toBe('before restored after');
  });

  it('disambiguates between multiple del elements by index', () => {
    const html = '<del class="mark-del">first</del> mid <del class="mark-del">second</del>';
    expect(applyDelAction(html, 0, 'accept')).toBe(' mid <del class="mark-del">second</del>');
    expect(applyDelAction(html, 1, 'accept')).toBe('<del class="mark-del">first</del> mid ');
    expect(applyDelAction(html, 1, 'reject')).toBe('<del class="mark-del">first</del> mid second');
  });

  it('preserves surrounding markup', () => {
    const html = '<b>bold</b> <del class="mark-del">x</del> <ins class="mark-add">y</ins>';
    expect(applyDelAction(html, 0, 'accept')).toBe('<b>bold</b>  <ins class="mark-add">y</ins>');
  });

  it('returns input unchanged when delIndex is out of range', () => {
    const html = '<del class="mark-del">only</del>';
    expect(applyDelAction(html, 5, 'accept')).toBe(html);
    expect(applyDelAction(html, -1, 'accept')).toBe(html);
  });

  it('returns input unchanged for unknown action', () => {
    const html = '<del class="mark-del">x</del>';
    expect(applyDelAction(html, 0, 'bogus')).toBe(html);
  });

  it('preserves author attributes on adjacent del elements (does not conflate)', () => {
    const html = '<del class="mark-del" data-author-id="A">a</del><del class="mark-del" data-author-id="B">b</del>';
    expect(applyDelAction(html, 0, 'accept')).toBe('<del class="mark-del" data-author-id="B">b</del>');
    expect(applyDelAction(html, 1, 'accept')).toBe('<del class="mark-del" data-author-id="A">a</del>');
  });

  it('handles empty input', () => {
    expect(applyDelAction('', 0, 'accept')).toBe('');
  });
});
