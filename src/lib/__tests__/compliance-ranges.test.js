// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { findHighlightTargetsInBlock } from '../compliance-ranges.js';

function html(s) {
  const root = document.createElement('div');
  root.innerHTML = s;
  return root;
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('compliance-ranges / findHighlightTargetsInBlock', () => {
  it('finds a single match in plain text', () => {
    const block = html('The Contractor shall provide it.');
    const targets = findHighlightTargetsInBlock(block, 'shall');
    expect(targets).toHaveLength(1);
    expect(targets[0].length).toBe(5);
  });

  it('case-insensitive: matches Match against "match"', () => {
    const block = html('Shall do.');
    expect(findHighlightTargetsInBlock(block, 'shall')).toHaveLength(1);
  });

  it('respects word boundaries — "contract" does not match inside "Contractor"', () => {
    const block = html('Contractor responsibilities.');
    expect(findHighlightTargetsInBlock(block, 'contract')).toHaveLength(0);
  });

  it('one highlight per text node per match (first occurrence wins)', () => {
    const block = html('shall and shall again.');
    // Single text node with two matches → first one only.
    const targets = findHighlightTargetsInBlock(block, 'shall');
    expect(targets).toHaveLength(1);
    expect(targets[0].startOffset).toBe(0);
  });

  it('one highlight per text node when multiple text nodes contain match', () => {
    const block = html('<span>shall</span> and <em>shall</em> again.');
    const targets = findHighlightTargetsInBlock(block, 'shall');
    expect(targets).toHaveLength(2);
  });

  it('skips text inside <del class="mark-del"> (TC deletions)', () => {
    const block = html('Active <del class="mark-del">shall</del> here shall stay.');
    const targets = findHighlightTargetsInBlock(block, 'shall');
    expect(targets).toHaveLength(1);
    expect(targets[0].textNode.textContent).toContain('here shall stay');
  });

  it('handles empty / null block / match safely', () => {
    expect(findHighlightTargetsInBlock(null, 'x')).toEqual([]);
    expect(findHighlightTargetsInBlock(html('x'), '')).toEqual([]);
    expect(findHighlightTargetsInBlock(html(''), 'x')).toEqual([]);
  });

  it('returned offsets build valid Range objects (CSS.highlights consumer contract)', () => {
    const block = html('The Contractor shall do it.');
    document.body.appendChild(block);
    const targets = findHighlightTargetsInBlock(block, 'shall');
    expect(targets).toHaveLength(1);
    const t = targets[0];
    const range = document.createRange();
    range.setStart(t.textNode, t.startOffset);
    range.setEnd(t.textNode, t.startOffset + t.length);
    expect(range.toString()).toBe('shall');
  });
});
