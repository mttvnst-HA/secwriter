import { describe, it, expect } from 'vitest';
import { validateDocument } from '../doc-validation.js';

describe('validateDocument', () => {
  describe('structure checks', () => {
    it('reports missing required PARTs', () => {
      const blocks = [
        { id: 'p1', type: 'title', depth: 0, part: 1, html: 'GENERAL' },
        // Missing PART 2 and 3
      ];
      const issues = validateDocument(blocks);
      const missing = issues.filter(i => i.category === 'Structure' && i.message.includes('Missing PART'));
      expect(missing).toHaveLength(2);
      expect(missing[0].message).toContain('PART 2');
      expect(missing[1].message).toContain('PART 3');
    });

    it('no structure errors when all 3 PARTs present', () => {
      const blocks = [
        { id: 'p1', type: 'title', depth: 0, part: 1, html: 'GENERAL' },
        { id: 's1', type: 'title', depth: 1, part: 1, html: 'REFERENCES' },
        { id: 'p2', type: 'title', depth: 0, part: 2, html: 'PRODUCTS' },
        { id: 's2', type: 'title', depth: 1, part: 2, html: 'MATERIALS' },
        { id: 'p3', type: 'title', depth: 0, part: 3, html: 'EXECUTION' },
        { id: 's3', type: 'title', depth: 1, part: 3, html: 'PREP' },
      ];
      const issues = validateDocument(blocks);
      const missing = issues.filter(i => i.message.includes('Missing PART'));
      expect(missing).toHaveLength(0);
    });

    it('warns about out-of-order PARTs', () => {
      const blocks = [
        { id: 'p2', type: 'title', depth: 0, part: 2, html: 'PRODUCTS' },
        { id: 'p1', type: 'title', depth: 0, part: 1, html: 'GENERAL' },
        { id: 'p3', type: 'title', depth: 0, part: 3, html: 'EXECUTION' },
      ];
      const issues = validateDocument(blocks);
      const order = issues.filter(i => i.message.includes('out of order'));
      expect(order.length).toBeGreaterThan(0);
    });
  });

  describe('title checks', () => {
    it('flags empty titles as errors', () => {
      const blocks = [
        { id: 't1', type: 'title', depth: 1, part: 1, html: '' },
      ];
      const issues = validateDocument(blocks);
      const empty = issues.filter(i => i.category === 'Title' && i.message.includes('Empty title'));
      expect(empty).toHaveLength(1);
      expect(empty[0].severity).toBe('error');
    });

    it('warns about titles exceeding 120 chars', () => {
      const longTitle = 'A'.repeat(130);
      const blocks = [
        { id: 't1', type: 'title', depth: 1, part: 1, html: longTitle },
      ];
      const issues = validateDocument(blocks);
      const long = issues.filter(i => i.category === 'Title' && i.message.includes('exceeds'));
      expect(long).toHaveLength(1);
      expect(long[0].severity).toBe('warning');
    });

    it('does not flag titles under 120 chars', () => {
      const blocks = [
        { id: 't1', type: 'title', depth: 1, part: 1, html: 'Normal Title' },
      ];
      const issues = validateDocument(blocks);
      const long = issues.filter(i => i.category === 'Title' && i.message.includes('exceeds'));
      expect(long).toHaveLength(0);
    });
  });

  describe('empty block checks', () => {
    it('flags empty txt blocks as info', () => {
      const blocks = [
        { id: 'b1', type: 'txt', html: '   ' }, // whitespace only
        { id: 'b2', type: 'txt', html: '<b></b>' }, // tags but no text
      ];
      const issues = validateDocument(blocks);
      const empty = issues.filter(i => i.category === 'Content');
      expect(empty).toHaveLength(2);
      expect(empty[0].severity).toBe('info');
    });

    it('does not flag table or ref blocks as empty', () => {
      const blocks = [
        { id: 'b1', type: 'table', table: { columns: 2, rows: [] } },
        { id: 'b2', type: 'ref', ref: { org: 'ASTM', entries: [] } },
      ];
      const issues = validateDocument(blocks);
      const empty = issues.filter(i => i.category === 'Content');
      expect(empty).toHaveLength(0);
    });
  });

  describe('submittal checks', () => {
    it('warns when SUB marks exist but no SUBMITTALS section', () => {
      const blocks = [
        { id: 'p1', type: 'title', depth: 0, part: 1, html: 'GENERAL' },
        { id: 'b1', type: 'txt', part: 2, html: 'Submit <span class="mark-sub">SD-01</span>' },
      ];
      const issues = validateDocument(blocks);
      const sub = issues.filter(i => i.category === 'Submittals');
      expect(sub.length).toBeGreaterThan(0);
      expect(sub[0].message).toContain('no SUBMITTALS section');
    });

    it('no submittal warning when SUBMITTALS section and SUB marks both exist', () => {
      const blocks = [
        { id: 'p1', type: 'title', depth: 0, part: 1, html: 'GENERAL' },
        { id: 't1', type: 'title', depth: 1, part: 1, html: 'SUBMITTALS' },
        { id: 'b1', type: 'txt', part: 2, html: 'Submit <span class="mark-sub">SD-01</span>' },
      ];
      const issues = validateDocument(blocks);
      const sub = issues.filter(i => i.category === 'Submittals' && i.severity !== 'info');
      expect(sub).toHaveLength(0);
    });
  });

  describe('integration', () => {
    it('returns empty array for a well-formed minimal document', () => {
      const blocks = [
        { id: 'p1', type: 'title', depth: 0, part: 1, html: 'GENERAL' },
        { id: 's11', type: 'title', depth: 1, part: 1, html: 'REFERENCES' },
        { id: 'b1', type: 'txt', part: 1, html: 'Some text content.' },
        { id: 'p2', type: 'title', depth: 0, part: 2, html: 'PRODUCTS' },
        { id: 's21', type: 'title', depth: 1, part: 2, html: 'MATERIALS' },
        { id: 'b2', type: 'txt', part: 2, html: 'Material requirements.' },
        { id: 'p3', type: 'title', depth: 0, part: 3, html: 'EXECUTION' },
        { id: 's31', type: 'title', depth: 1, part: 3, html: 'PREPARATION' },
        { id: 'b3', type: 'txt', part: 3, html: 'Site preparation.' },
      ];
      const issues = validateDocument(blocks);
      expect(issues).toHaveLength(0);
    });
  });
});
