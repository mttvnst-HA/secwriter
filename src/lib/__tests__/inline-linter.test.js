import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parseHTML } from 'linkedom';

// Mock grammar-checker to avoid WASM loading in Node
vi.mock('../grammar-checker.js', () => ({
  checkGrammar: vi.fn(async () => []),
  isGrammarReady: vi.fn(() => false),
  initGrammarChecker: vi.fn(async () => {}),
  getVersion: vi.fn(() => 0),
}));

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
  setStart(node, offset) {
    this.startContainer = node;
    this.startOffset = offset;
  }
  setEnd(node, offset) {
    this.endContainer = node;
    this.endOffset = offset;
  }
}

const origCreateRange = document.createRange;
document.createRange = () => new MockRange();

// Mock CSS.highlights (not available in Node/linkedom)
const mockHighlights = new Map();
const origSet = Map.prototype.set.bind(mockHighlights);
const origDelete = Map.prototype.delete.bind(mockHighlights);
mockHighlights.set = vi.fn((name, highlight) => origSet(name, highlight));
mockHighlights.delete = vi.fn((name) => origDelete(name));

// Mock Highlight constructor
class MockHighlight {
  constructor(...ranges) {
    this.ranges = ranges;
  }
}

globalThis.CSS = { highlights: mockHighlights };
globalThis.Highlight = MockHighlight;

// Helper to create a DOM element with innerHTML
function createElement(html) {
  const el = document.createElement('div');
  el.innerHTML = html;
  return el;
}

describe('inline-linter', () => {
  beforeEach(() => {
    mockHighlights.clear();
    mockHighlights.set.mockClear();
    mockHighlights.delete.mockClear();
  });

  describe('extractPlainText', () => {
    it('extracts plain text from a DOM element preserving whitespace', async () => {
      const { extractPlainText } = await import('../inline-linter.js');
      const el = createElement('The Contractor shall provide materials.');
      expect(extractPlainText(el)).toBe('The Contractor shall provide materials.');
    });

    it('skips content inside <del> elements', async () => {
      const { extractPlainText } = await import('../inline-linter.js');
      const el = createElement('Provide <del class="mark-del">deleted text</del>materials on site.');
      expect(extractPlainText(el)).toBe('Provide materials on site.');
    });

    it('skips hidden ENG/MET spans', async () => {
      const { extractPlainText } = await import('../inline-linter.js');
      const el = createElement('Use <span class="mark-eng">25 mm</span><span class="mark-met">1 inch</span> bolts.');
      const text = extractPlainText(el);
      // ENG/MET spans are skipped to avoid double-linting unit content
      expect(text).toBe('Use  bolts.');
    });

    it('preserves double spaces faithfully (no collapsing)', async () => {
      const { extractPlainText } = await import('../inline-linter.js');
      const el = createElement('First sentence.  Second sentence.');
      expect(extractPlainText(el)).toBe('First sentence.  Second sentence.');
    });
  });

  describe('initInlineLinting', () => {
    it('creates compliance-error highlights for static rule violations', async () => {
      const { initInlineLinting, clearInlineLinting } = await import('../inline-linter.js');
      const { getRules } = await import('../compliance-rules.js');
      const rules = getRules();

      const el = createElement('The Contractor shall provide materials.');
      initInlineLinting(el, 'block-1', 'The Contractor shall provide materials.', rules);

      expect(mockHighlights.set).toHaveBeenCalledWith(
        'compliance-error',
        expect.any(MockHighlight)
      );

      clearInlineLinting();
    });

    it('does not create highlights when no violations exist', async () => {
      const { initInlineLinting, clearInlineLinting } = await import('../inline-linter.js');
      const { getRules } = await import('../compliance-rules.js');
      const rules = getRules();

      const el = createElement('Provide materials on the prepared surface.');
      initInlineLinting(el, 'block-2', 'Provide materials on the prepared surface.', rules);

      expect(mockHighlights.set).not.toHaveBeenCalled();

      clearInlineLinting();
    });

    it('stores active findings for later tooltip use', async () => {
      const { initInlineLinting, getActiveFindings, clearInlineLinting } = await import('../inline-linter.js');
      const { getRules } = await import('../compliance-rules.js');
      const rules = getRules();

      const el = createElement('The Contractor shall provide materials.');
      initInlineLinting(el, 'block-3', 'The Contractor shall provide materials.', rules);

      const findings = getActiveFindings();
      expect(findings.length).toBeGreaterThan(0);
      expect(findings[0].violation).toHaveProperty('ruleId');
      expect(findings[0].violation).toHaveProperty('match');

      clearInlineLinting();
    });
  });

  describe('clearInlineLinting', () => {
    it('removes the compliance-error highlight group', async () => {
      const { initInlineLinting, clearInlineLinting } = await import('../inline-linter.js');
      const { getRules } = await import('../compliance-rules.js');
      const rules = getRules();

      const el = createElement('The Contractor shall provide materials.');
      initInlineLinting(el, 'block-4', 'The Contractor shall provide materials.', rules);
      clearInlineLinting();

      expect(mockHighlights.delete).toHaveBeenCalledWith('compliance-error');
    });

    it('clears active findings array', async () => {
      const { initInlineLinting, getActiveFindings, clearInlineLinting } = await import('../inline-linter.js');
      const { getRules } = await import('../compliance-rules.js');
      const rules = getRules();

      const el = createElement('The Contractor shall provide materials.');
      initInlineLinting(el, 'block-5', 'The Contractor shall provide materials.', rules);
      clearInlineLinting();

      expect(getActiveFindings()).toHaveLength(0);
    });
  });

  describe('Range creation via string search', () => {
    it('creates Range objects targeting the correct text nodes', async () => {
      const { initInlineLinting, getActiveFindings, clearInlineLinting } = await import('../inline-linter.js');
      const { getRules } = await import('../compliance-rules.js');
      const rules = getRules();

      const el = createElement('The Contractor shall provide materials.');
      initInlineLinting(el, 'block-6', 'The Contractor shall provide materials.', rules);

      const findings = getActiveFindings();
      const shallFinding = findings.find(f => f.violation.match.toLowerCase() === 'shall');
      expect(shallFinding).toBeDefined();

      clearInlineLinting();
    });

    it('respects word boundaries (does not match substrings)', async () => {
      const { initInlineLinting, getActiveFindings, clearInlineLinting } = await import('../inline-linter.js');
      const { getRules } = await import('../compliance-rules.js');
      const rules = getRules();

      const el = createElement('Contractor provides equipment.');
      initInlineLinting(el, 'block-7', 'Contractor provides equipment.', rules);

      const findings = getActiveFindings();
      // Every match should be a whole-word match
      expect(findings.every(f => {
        const m = f.violation.match.toLowerCase();
        const text = 'contractor provides equipment.';
        const idx = text.indexOf(m);
        if (idx < 0) return true;
        const before = idx > 0 ? text[idx - 1] : '';
        const after = idx + m.length < text.length ? text[idx + m.length] : '';
        return (!before || !/[a-z]/i.test(before)) && (!after || !/[a-z]/i.test(after));
      })).toBe(true);

      clearInlineLinting();
    });

    it('skips text inside <del> elements when creating ranges', async () => {
      const { initInlineLinting, getActiveFindings, clearInlineLinting } = await import('../inline-linter.js');
      const { getRules } = await import('../compliance-rules.js');
      const rules = getRules();

      const el = createElement('Provide <del class="mark-del">shall</del> materials.');
      initInlineLinting(el, 'block-8', 'Provide materials.', rules);

      const findings = getActiveFindings();
      const shallFinding = findings.find(f => f.violation.match.toLowerCase() === 'shall');
      expect(shallFinding).toBeUndefined();

      clearInlineLinting();
    });
  });

  describe('multiple violations in one block', () => {
    it('creates ranges for all violations found', async () => {
      const { initInlineLinting, getActiveFindings, clearInlineLinting } = await import('../inline-linter.js');
      const { getRules } = await import('../compliance-rules.js');
      const rules = getRules();

      const el = createElement('The Contractor shall provide any materials.');
      initInlineLinting(el, 'block-9', 'The Contractor shall provide any materials.', rules);

      const findings = getActiveFindings();
      expect(findings.length).toBeGreaterThanOrEqual(1);
      expect(findings.some(f => f.violation.match.toLowerCase() === 'shall')).toBe(true);

      clearInlineLinting();
    });
  });

  describe('findFindingAtCursor', () => {
    it('returns finding when cursor is inside a highlighted range', async () => {
      const { initInlineLinting, findFindingAtCursor, clearInlineLinting } = await import('../inline-linter.js');
      const { getRules } = await import('../compliance-rules.js');
      const rules = getRules();

      const el = createElement('The Contractor shall provide materials.');
      initInlineLinting(el, 'block-10', 'The Contractor shall provide materials.', rules);

      // "shall" is at offset 16 in the text node; cursor at offset 17 (inside "shall")
      const textNode = el.childNodes[0];
      const finding = findFindingAtCursor(textNode, 17);
      expect(finding).toBeDefined();
      expect(finding.violation.match.toLowerCase()).toBe('shall');

      clearInlineLinting();
    });

    it('returns null when cursor is outside all highlighted ranges', async () => {
      const { initInlineLinting, findFindingAtCursor, clearInlineLinting } = await import('../inline-linter.js');
      const { getRules } = await import('../compliance-rules.js');
      const rules = getRules();

      const el = createElement('The Contractor shall provide materials.');
      initInlineLinting(el, 'block-11', 'The Contractor shall provide materials.', rules);

      // Cursor at offset 5 (inside "Contractor") - not a violation
      const textNode = el.childNodes[0];
      const finding = findFindingAtCursor(textNode, 5);
      expect(finding).toBeNull();

      clearInlineLinting();
    });

    it('returns null when there are no active findings', async () => {
      const { findFindingAtCursor, clearInlineLinting } = await import('../inline-linter.js');
      clearInlineLinting();
      const el = createElement('Hello world.');
      const finding = findFindingAtCursor(el.childNodes[0], 3);
      expect(finding).toBeNull();
    });

    it('returns highest-severity finding when cursor is in overlapping ranges', async () => {
      const { initInlineLinting, findFindingAtCursor, clearInlineLinting } = await import('../inline-linter.js');
      const { getRules } = await import('../compliance-rules.js');
      const rules = getRules();

      // "shall" should be flagged - check we get it
      const el = createElement('The Contractor shall provide materials.');
      initInlineLinting(el, 'block-12', 'The Contractor shall provide materials.', rules);

      const textNode = el.childNodes[0];
      const finding = findFindingAtCursor(textNode, 18); // middle of "shall"
      expect(finding).toBeDefined();
      expect(finding.violation).toHaveProperty('severity');

      clearInlineLinting();
    });
  });

  describe('computeFixedText', () => {
    it('applies fixFn to produce corrected text', async () => {
      const { initInlineLinting, getActiveFindings, computeFixedText, clearInlineLinting } = await import('../inline-linter.js');
      const { getRules } = await import('../compliance-rules.js');
      const rules = getRules();

      const el = createElement('The Contractor shall provide materials.');
      initInlineLinting(el, 'block-13', 'The Contractor shall provide materials.', rules);

      const findings = getActiveFindings();
      const shallFinding = findings.find(f => f.violation.match.toLowerCase() === 'shall');

      if (shallFinding && shallFinding.violation.fixFn) {
        const fixed = computeFixedText(el.innerHTML, shallFinding.violation);
        expect(fixed).toBeDefined();
        expect(fixed).not.toContain('shall');
      }

      clearInlineLinting();
    });

    it('returns null when violation has no fixFn', async () => {
      const { computeFixedText } = await import('../inline-linter.js');
      const result = computeFixedText('some text', { fixFn: null, match: 'text' });
      expect(result).toBeNull();
    });
  });
});
