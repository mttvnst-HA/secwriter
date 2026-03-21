import { describe, it, expect } from 'vitest';
import { generateExportHtml } from '../doc-export.js';

describe('generateExportHtml', () => {
  const meta = { sectionNumber: '31 00 00', sectionTitle: 'EARTHWORK', date: '08/23' };

  it('generates complete HTML document with header', () => {
    const blocks = [
      { id: 'p1', type: 'title', depth: 0, part: 1, html: 'GENERAL' },
    ];
    const html = generateExportHtml(blocks, meta);
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('SECTION 31 00 00');
    expect(html).toContain('EARTHWORK');
    expect(html).toContain('USACE / NAVFAC / AFCEC');
  });

  it('renders title blocks with part numbers and section numbers', () => {
    const blocks = [
      { id: 'p1', type: 'title', depth: 0, part: 1, html: 'GENERAL' },
      { id: 's1', type: 'title', depth: 1, part: 1, html: 'REFERENCES' },
    ];
    const html = generateExportHtml(blocks, meta);
    expect(html).toContain('PART 1');
    expect(html).toContain('GENERAL');
    expect(html).toContain('REFERENCES');
  });

  it('renders text blocks', () => {
    const blocks = [
      { id: 'b1', type: 'txt', html: 'Some specification text.' },
    ];
    const html = generateExportHtml(blocks, meta);
    expect(html).toContain('Some specification text.');
    expect(html).toContain('block-txt');
  });

  it('renders note blocks when showNotes is true', () => {
    const blocks = [
      { id: 'b1', type: 'note', html: 'Designer note content' },
    ];
    const html = generateExportHtml(blocks, meta, { showNotes: true });
    expect(html).toContain('Designer note content');
    expect(html).toContain('block-note');
  });

  it('hides note blocks when showNotes is false', () => {
    const blocks = [
      { id: 'b1', type: 'note', html: 'Hidden note' },
      { id: 'b2', type: 'txt', html: 'Visible text' },
    ];
    const html = generateExportHtml(blocks, meta, { showNotes: false });
    expect(html).not.toContain('Hidden note');
    expect(html).toContain('Visible text');
  });

  it('renders page breaks', () => {
    const blocks = [
      { id: 'b1', type: 'txt', html: 'Before' },
      { id: 'pb', type: 'pagebreak' },
      { id: 'b2', type: 'txt', html: 'After' },
    ];
    const html = generateExportHtml(blocks, meta);
    expect(html).toContain('page-break');
  });

  it('renders tables', () => {
    const blocks = [
      { id: 't1', type: 'table', table: {
        columns: 2,
        rows: [[{ text: 'A', colspan: 1 }, { text: 'B', colspan: 1 }]],
      }},
    ];
    const html = generateExportHtml(blocks, meta);
    expect(html).toContain('<table');
    expect(html).toContain('A');
    expect(html).toContain('B');
  });

  it('renders ref blocks', () => {
    const blocks = [
      { id: 'r1', type: 'ref', ref: {
        org: 'ASTM INTERNATIONAL (ASTM)',
        entries: [{ rid: 'ASTM D2487', rtl: '(2024) Soil Classification' }],
      }},
    ];
    const html = generateExportHtml(blocks, meta);
    expect(html).toContain('ASTM INTERNATIONAL');
    expect(html).toContain('ASTM D2487');
    expect(html).toContain('Soil Classification');
  });

  it('hides metric units when unitDisplay is eng', () => {
    const blocks = [
      { id: 'b1', type: 'txt', html: '<span class="mark-eng">3 inches</span> <span class="mark-met">75 mm</span>' },
    ];
    const html = generateExportHtml(blocks, meta, { unitDisplay: 'eng' });
    expect(html).toContain('3 inches');
    expect(html).not.toContain('75 mm');
  });

  it('hides english units when unitDisplay is met', () => {
    const blocks = [
      { id: 'b1', type: 'txt', html: '<span class="mark-eng">3 inches</span> <span class="mark-met">75 mm</span>' },
    ];
    const html = generateExportHtml(blocks, meta, { unitDisplay: 'met' });
    expect(html).not.toContain('3 inches');
    expect(html).toContain('75 mm');
  });

  it('strips comment marks from export', () => {
    const blocks = [
      { id: 'b1', type: 'txt', html: 'Text <span class="mark-comment" data-comment-id="c1">commented</span> here' },
    ];
    const html = generateExportHtml(blocks, meta);
    expect(html).toContain('commented');
    expect(html).not.toContain('mark-comment');
  });

  it('includes print styles', () => {
    const html = generateExportHtml([], meta);
    expect(html).toContain('@media print');
    expect(html).toContain('@page');
  });
});
