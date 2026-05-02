import { describe, it, expect } from 'vitest';
import { parseHTML } from 'linkedom';

// Create a linkedom document for DOM operations
const { document, NodeFilter } = parseHTML('<!DOCTYPE html><html><body></body></html>');
globalThis.document = document;
globalThis.NodeFilter = NodeFilter;

// Mock Range (linkedom Range doesn't support setStart/setEnd)
class MockRange {
  constructor() {
    this.startContainer = null;
    this.startOffset = 0;
    this.endContainer = null;
    this.endOffset = 0;
  }
  setStart(node, offset) { this.startContainer = node; this.startOffset = offset; }
  setEnd(node, offset)   { this.endContainer = node;   this.endOffset = offset; }
  collapse() {}
  // Not implemented under linkedom — findFindingAtCursor falls back to the
  // same-text-node fast path, which is what these tests exercise.
}
document.createRange = () => new MockRange();

function createElement(html) {
  const el = document.createElement('div');
  el.innerHTML = html;
  return el;
}

import { extractPlainText, createRangeForMatch, findFindingAtCursor, computeFixedText } from '../inline-linter.js';

// ── extractPlainText ─────────────────────────────────────────────────────────

describe('extractPlainText', () => {
  it('extracts plain text from a DOM element preserving whitespace', () => {
    const el = createElement('The Contractor shall provide materials.');
    expect(extractPlainText(el)).toBe('The Contractor shall provide materials.');
  });

  it('skips content inside <del> elements', () => {
    const el = createElement('Provide <del class="mark-del">deleted text</del>materials on site.');
    expect(extractPlainText(el)).toBe('Provide materials on site.');
  });

  it('skips hidden ENG/MET spans', () => {
    const el = createElement('Use <span class="mark-eng">25 mm</span><span class="mark-met">1 inch</span> bolts.');
    expect(extractPlainText(el)).toBe('Use  bolts.');
  });

  it('preserves double spaces faithfully (no collapsing)', () => {
    const el = createElement('First sentence.  Second sentence.');
    expect(extractPlainText(el)).toBe('First sentence.  Second sentence.');
  });

  it('returns empty string for null input', () => {
    expect(extractPlainText(null)).toBe('');
  });
});

// ── createRangeForMatch ──────────────────────────────────────────────────────

describe('createRangeForMatch', () => {
  it('returns a Range when the match is found at a word boundary', () => {
    const el = createElement('The Contractor shall provide materials.');
    const range = createRangeForMatch(el, 'shall');
    expect(range).not.toBeNull();
    expect(range.startOffset).toBe(15);
    expect(range.endOffset).toBe(20);
  });

  it('returns null when the match is not present', () => {
    const el = createElement('Provide materials on site.');
    expect(createRangeForMatch(el, 'shall')).toBeNull();
  });

  it('respects word boundaries (does not match substrings)', () => {
    // "shall" appears inside "shallow" but is not a whole-word match.
    const el = createElement('A shallow trench.');
    expect(createRangeForMatch(el, 'shall')).toBeNull();
  });

  it('skips text inside <del> elements', () => {
    const el = createElement('Provide <del class="mark-del">shall</del> materials.');
    expect(createRangeForMatch(el, 'shall')).toBeNull();
  });

  it('disambiguates repeated words via targetOffset', () => {
    const el = createElement('the cat ate the food on the table.');
    // Three "the" occurrences at offsets 0, 12, 24 (in a single text node).
    const r1 = createRangeForMatch(el, 'the', 12);
    const r2 = createRangeForMatch(el, 'the', 24);
    expect(r1.startOffset).toBe(12);
    expect(r2.startOffset).toBe(24);
  });

  it('skips text inside .compliance-highlight spans (panel-injected)', () => {
    const el = createElement('Provide <span class="compliance-highlight">shall</span> materials.');
    expect(createRangeForMatch(el, 'shall')).toBeNull();
  });
});

// ── findFindingAtCursor ──────────────────────────────────────────────────────

describe('findFindingAtCursor', () => {
  function rangeAt(node, start, end) {
    return { startContainer: node, startOffset: start, endContainer: node, endOffset: end };
  }

  it('returns the finding when cursor is inside the range (same-text-node path)', () => {
    const el = createElement('shall');
    const node = el.childNodes[0];
    const findings = [{ range: rangeAt(node, 0, 5), violation: { ruleId: 'TERM-shall', severity: 'high' } }];
    const out = findFindingAtCursor(findings, node, 2);
    expect(out).toBe(findings[0]);
  });

  it('returns null when cursor is outside any range', () => {
    const el = createElement('shall');
    const node = el.childNodes[0];
    const findings = [{ range: rangeAt(node, 0, 5), violation: { ruleId: 'X', severity: 'low' } }];
    expect(findFindingAtCursor(findings, node, 10)).toBeNull();
  });

  it('returns null on empty findings', () => {
    const el = createElement('hello');
    expect(findFindingAtCursor([], el.childNodes[0], 1)).toBeNull();
  });

  it('returns null when cursorNode is missing', () => {
    expect(findFindingAtCursor([{ range: {}, violation: {} }], null, 0)).toBeNull();
  });

  it('skips findings with null Range', () => {
    const el = createElement('hello');
    const node = el.childNodes[0];
    expect(findFindingAtCursor([{ range: null, violation: {} }], node, 0)).toBeNull();
  });

  it('picks the highest-severity finding when multiple ranges contain the cursor', () => {
    const el = createElement('shall');
    const node = el.childNodes[0];
    const findings = [
      { range: rangeAt(node, 0, 5), violation: { ruleId: 'low', severity: 'low' } },
      { range: rangeAt(node, 0, 5), violation: { ruleId: 'high', severity: 'high' } },
      { range: rangeAt(node, 0, 5), violation: { ruleId: 'med', severity: 'medium' } },
    ];
    expect(findFindingAtCursor(findings, node, 2).violation.ruleId).toBe('high');
  });
});

// ── computeFixedText ─────────────────────────────────────────────────────────

describe('computeFixedText', () => {
  it('returns null when violation has no fixFn', () => {
    expect(computeFixedText('some text', { fixFn: null, match: 'text' })).toBeNull();
  });

  it('returns null on undefined violation', () => {
    expect(computeFixedText('some text', undefined)).toBeNull();
  });

  it('invokes fixFn with html, match, replacement', () => {
    const violation = {
      match: 'shall',
      replacement: 'must',
      fixFn: (html, match, replacement) => html.replace(match, replacement),
    };
    expect(computeFixedText('Contractor shall provide.', violation))
      .toBe('Contractor must provide.');
  });

  it('returns null if fixFn throws', () => {
    const violation = { match: 'x', fixFn: () => { throw new Error('boom'); } };
    expect(computeFixedText('foo', violation)).toBeNull();
  });
});
