// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import {
  HIGHLIGHT_CLASS,
  findHighlightTargetsInBlock,
  injectHighlightSpans,
  clearHighlightSpans,
  applyGroupHighlights,
  findFirstHighlightInBlock,
} from '../compliance-highlight.js';

function html(s) {
  const root = document.createElement('div');
  root.innerHTML = s;
  return root;
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('compliance-highlight / findHighlightTargetsInBlock', () => {
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

  it('skips text already inside .compliance-highlight', () => {
    const block = html('a <span class="compliance-highlight">shall</span> b shall.');
    // First match is inside an existing highlight → skipped.
    const targets = findHighlightTargetsInBlock(block, 'shall');
    expect(targets).toHaveLength(1);
    expect(targets[0].textNode.textContent.trim()).toBe('b shall.');
  });

  it('handles empty / null block / match safely', () => {
    expect(findHighlightTargetsInBlock(null, 'x')).toEqual([]);
    expect(findHighlightTargetsInBlock(html('x'), '')).toEqual([]);
    expect(findHighlightTargetsInBlock(html(''), 'x')).toEqual([]);
  });
});

describe('compliance-highlight / injectHighlightSpans + clearHighlightSpans', () => {
  it('wraps the matched text in a span.compliance-highlight', () => {
    const block = html('shall do it.');
    document.body.appendChild(block);
    const targets = findHighlightTargetsInBlock(block, 'shall');
    injectHighlightSpans(targets);
    const span = block.querySelector(`.${HIGHLIGHT_CLASS}`);
    expect(span).not.toBeNull();
    expect(span.textContent).toBe('shall');
  });

  it('clearHighlightSpans unwraps to original text', () => {
    const block = html('shall do it.');
    document.body.appendChild(block);
    const targets = findHighlightTargetsInBlock(block, 'shall');
    injectHighlightSpans(targets);
    clearHighlightSpans(block);
    expect(block.querySelector(`.${HIGHLIGHT_CLASS}`)).toBeNull();
    expect(block.textContent).toBe('shall do it.');
  });

  it('clearHighlightSpans on a block without highlights is a no-op', () => {
    const block = html('plain text');
    expect(() => clearHighlightSpans(block)).not.toThrow();
    expect(block.textContent).toBe('plain text');
  });

  it('clearHighlightSpans on null/undefined root is safe', () => {
    expect(() => clearHighlightSpans(null)).not.toThrow();
    expect(() => clearHighlightSpans(undefined)).not.toThrow();
  });

  it('inject + clear is round-trip safe across multiple text nodes', () => {
    const block = html('<span>shall</span> and <em>shall</em>.');
    document.body.appendChild(block);
    const targets = findHighlightTargetsInBlock(block, 'shall');
    injectHighlightSpans(targets);
    expect(block.querySelectorAll(`.${HIGHLIGHT_CLASS}`).length).toBe(2);
    clearHighlightSpans(block);
    expect(block.querySelectorAll(`.${HIGHLIGHT_CLASS}`).length).toBe(0);
  });
});

describe('compliance-highlight / applyGroupHighlights', () => {
  function makeEditor() {
    const root = document.createElement('div');
    root.innerHTML = `
      <div data-block-id="b1">The Contractor shall provide.</div>
      <div data-block-id="b2">Materials should be suitable.</div>
      <div data-block-id="b3">No matches here.</div>
    `;
    document.body.appendChild(root);
    return root;
  }

  it('applies highlights for all instances and returns highlighted blocks in document order', () => {
    const editor = makeEditor();
    const group = {
      ruleId: 'TERM-shall',
      instances: [
        { blockId: 'b1', match: 'shall' },
        { blockId: 'b2', match: 'should' },
      ],
    };
    const blocks = applyGroupHighlights(editor, group);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].getAttribute('data-block-id')).toBe('b1');
    expect(blocks[1].getAttribute('data-block-id')).toBe('b2');
    expect(editor.querySelectorAll(`.${HIGHLIGHT_CLASS}`).length).toBe(2);
  });

  it('skips instances whose match is not present in the block', () => {
    const editor = makeEditor();
    const group = {
      ruleId: 'X',
      instances: [
        { blockId: 'b3', match: 'missing' },
      ],
    };
    expect(applyGroupHighlights(editor, group)).toHaveLength(0);
    expect(editor.querySelectorAll(`.${HIGHLIGHT_CLASS}`).length).toBe(0);
  });

  it('handles missing rootEl / group gracefully', () => {
    expect(applyGroupHighlights(null, { instances: [] })).toEqual([]);
    expect(applyGroupHighlights(document.body, null)).toEqual([]);
  });

  it('does not double-highlight when called twice with identical group (skips inside existing highlights)', () => {
    const editor = makeEditor();
    const group = {
      ruleId: 'TERM-shall',
      instances: [{ blockId: 'b1', match: 'shall' }],
    };
    applyGroupHighlights(editor, group);
    applyGroupHighlights(editor, group);
    expect(editor.querySelectorAll(`.${HIGHLIGHT_CLASS}`).length).toBe(1);
  });
});

describe('compliance-highlight / findFirstHighlightInBlock', () => {
  it('returns the first highlight inside the named block', () => {
    const root = document.createElement('div');
    root.innerHTML = `
      <div data-block-id="b1">a <span class="compliance-highlight">x</span> b</div>
      <div data-block-id="b2">no hits</div>
    `;
    document.body.appendChild(root);
    const el = findFirstHighlightInBlock(root, 'b1');
    expect(el).not.toBeNull();
    expect(el.textContent).toBe('x');
  });

  it('returns null when block missing or no highlight present', () => {
    const root = document.createElement('div');
    root.innerHTML = '<div data-block-id="b1">plain</div>';
    document.body.appendChild(root);
    expect(findFirstHighlightInBlock(root, 'gone')).toBeNull();
    expect(findFirstHighlightInBlock(root, 'b1')).toBeNull();
  });

  it('returns null on null inputs', () => {
    expect(findFirstHighlightInBlock(null, 'b1')).toBeNull();
    expect(findFirstHighlightInBlock(document.body, '')).toBeNull();
  });
});
