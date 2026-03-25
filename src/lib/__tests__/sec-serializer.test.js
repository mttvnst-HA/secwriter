import { describe, it, expect } from 'vitest';
import { serializeSEC } from '../sec-serializer.js';

const META = { sectionNumber: '31 00 00', sectionTitle: 'TEST', date: '01/24' };

describe('serializeSEC', () => {
  // ─── Basic structure ───────────────────────────────────────────

  it('produces valid XML with SEC root and header', () => {
    const xml = serializeSEC([], META);
    expect(xml).toContain('<?xml version="1.0" encoding="windows-1252"?>');
    expect(xml).toContain('<SEC');
    expect(xml).toContain('</SEC>');
    expect(xml).toContain('SECTION 31 00 00');
    expect(xml).toContain('TEST');
  });

  it('serializes a TXT block inside PRT', () => {
    const blocks = [
      { id: '1', type: 'txt', part: 1, depth: 0, html: 'Hello world' },
    ];
    const xml = serializeSEC(blocks, META);
    expect(xml).toContain('<PRT>');
    expect(xml).toContain('<TXT>Hello world</TXT>');
    expect(xml).toContain('</PRT>');
  });

  it('serializes title blocks as TTL', () => {
    const blocks = [
      { id: '1', type: 'title', part: 1, depth: 1, html: 'REFERENCES' },
    ];
    const xml = serializeSEC(blocks, META);
    expect(xml).toContain('<SPT>');
    expect(xml).toContain('<TTL>REFERENCES</TTL>');
  });

  // ─── SPT nesting ──────────────────────────────────────────────

  it('wraps depth > 0 titles in SPT', () => {
    const blocks = [
      { id: '1', type: 'title', part: 1, depth: 1, html: 'SECT A' },
      { id: '2', type: 'txt', part: 1, depth: 1, html: 'text' },
    ];
    const xml = serializeSEC(blocks, META);
    expect(xml).toContain('<SPT>');
    expect(xml).toContain('</SPT>');
  });

  it('does NOT wrap depth 0 titles in SPT', () => {
    const blocks = [
      { id: '1', type: 'title', part: 1, depth: 0, html: 'TOP' },
    ];
    const xml = serializeSEC(blocks, META);
    // Should have TTL directly under PRT, no SPT
    const sptCount = (xml.match(/<SPT>/g) || []).length;
    expect(sptCount).toBe(0);
  });

  // ─── NTE grouping ─────────────────────────────────────────────

  it('groups consecutive note blocks inside NTE', () => {
    const blocks = [
      { id: '1', type: 'note', part: 1, depth: 0, html: 'Note 1' },
      { id: '2', type: 'note', part: 1, depth: 0, html: 'Note 2' },
    ];
    const xml = serializeSEC(blocks, META);
    const nteCount = (xml.match(/<NTE>/g) || []).length;
    expect(nteCount).toBe(1); // single NTE wrapping both
    expect(xml).toContain('<NPR>Note 1</NPR>');
    expect(xml).toContain('<NPR>Note 2</NPR>');
  });

  it('closes NTE group when non-note block follows', () => {
    const blocks = [
      { id: '1', type: 'note', part: 1, depth: 0, html: 'Note' },
      { id: '2', type: 'txt', part: 1, depth: 0, html: 'Text' },
    ];
    const xml = serializeSEC(blocks, META);
    // NTE must close before TXT
    const nteClose = xml.indexOf('</NTE>');
    const txtOpen = xml.indexOf('<TXT>Text</TXT>');
    expect(nteClose).toBeLessThan(txtOpen);
  });

  // ─── OLG grouping ─────────────────────────────────────────────

  it('wraps consecutive OLI blocks in OLG', () => {
    const blocks = [
      { id: '1', type: 'oli', part: 1, depth: 0, html: 'First' },
      { id: '2', type: 'oli', part: 1, depth: 0, html: 'Second' },
    ];
    const xml = serializeSEC(blocks, META);
    const olgCount = (xml.match(/<OLG>/g) || []).length;
    expect(olgCount).toBe(1);
    expect(xml).toContain('<OLI>First</OLI>');
    expect(xml).toContain('<OLI>Second</OLI>');
    expect(xml).toContain('</OLG>');
  });

  it('preserves OLI LEVEL attribute', () => {
    const blocks = [
      { id: '1', type: 'oli', part: 1, depth: 0, level: 2, html: 'Sub item' },
    ];
    const xml = serializeSEC(blocks, META);
    expect(xml).toContain('LEVEL="2"');
  });

  // ─── HTML → SGML inline conversion ────────────────────────────

  it('converts span.mark-rid back to RID tags', () => {
    const blocks = [
      { id: '1', type: 'txt', part: 1, depth: 0, html: 'See <span class="mark-rid">ASTM D2487</span> here' },
    ];
    const xml = serializeSEC(blocks, META);
    expect(xml).toContain('<RID>ASTM D2487</RID>');
    expect(xml).not.toContain('mark-rid');
  });

  it('converts <b> to BLD, <em> to ITA, <u> to UND', () => {
    const blocks = [
      { id: '1', type: 'txt', part: 1, depth: 0, html: '<b>bold</b> <em>italic</em> <u>under</u>' },
    ];
    const xml = serializeSEC(blocks, META);
    expect(xml).toContain('<BLD>bold</BLD>');
    expect(xml).toContain('<ITA>italic</ITA>');
    expect(xml).toContain('<UND>under</UND>');
  });

  it('strips zero-width spaces from output', () => {
    const blocks = [
      { id: '1', type: 'txt', part: 1, depth: 0, html: 'text\u200B' },
    ];
    const xml = serializeSEC(blocks, META);
    expect(xml).not.toContain('\u200B');
  });

  // ─── Multiple parts ───────────────────────────────────────────

  it('creates separate PRT elements for different part numbers', () => {
    const blocks = [
      { id: '1', type: 'txt', part: 1, depth: 0, html: 'Part 1 text' },
      { id: '2', type: 'txt', part: 2, depth: 0, html: 'Part 2 text' },
    ];
    const xml = serializeSEC(blocks, META);
    const prtCount = (xml.match(/<PRT>/g) || []).length;
    expect(prtCount).toBe(2);
  });

  // ─── Pre-part content ─────────────────────────────────────────

  it('serializes pre-part notes (part 0) before PRT', () => {
    const blocks = [
      { id: '1', type: 'note', part: 0, depth: 0, html: 'Pre-part note' },
      { id: '2', type: 'txt', part: 1, depth: 0, html: 'In part' },
    ];
    const xml = serializeSEC(blocks, META);
    const notePos = xml.indexOf('<NPR>Pre-part note</NPR>');
    const prtPos = xml.indexOf('<PRT>');
    expect(notePos).toBeGreaterThan(-1);
    expect(notePos).toBeLessThan(prtPos);
  });

  // ─── TAI OPT attribute serialization ─────────────────────────────

  it('serializes mark-tai with data-opt to TAI OPT', () => {
    const blocks = [
      { id: '1', type: 'txt', part: 1, depth: 0, html: 'See <span class="mark-tai" data-opt="ARMY">Army content</span> here' },
    ];
    const xml = serializeSEC(blocks, META);
    expect(xml).toContain('<TAI OPT="ARMY">Army content</TAI>');
    expect(xml).not.toContain('mark-tai');
  });

  it('serializes mark-tai without data-opt to plain TAI', () => {
    const blocks = [
      { id: '1', type: 'txt', part: 1, depth: 0, html: '<span class="mark-tai">Generic tailoring</span>' },
    ];
    const xml = serializeSEC(blocks, META);
    expect(xml).toContain('<TAI>Generic tailoring</TAI>');
    expect(xml).not.toContain('OPT');
  });

  it('handles mark-tai with extra resolution classes', () => {
    const blocks = [
      { id: '1', type: 'txt', part: 1, depth: 0, html: '<span class="mark-tai tai-included" data-opt="NAVY">Navy content</span>' },
    ];
    const xml = serializeSEC(blocks, META);
    expect(xml).toContain('<TAI OPT="NAVY">Navy content</TAI>');
  });

  // ─── CRLF line endings ──────────────────────────────────────────

  it('uses CRLF line endings for legacy SpecsIntact compatibility', () => {
    const xml = serializeSEC([], META);
    expect(xml).toContain('\r\n');
    expect(xml).not.toMatch(/[^\r]\n/); // no bare LF without preceding CR
  });

  it('uses CRLF in table serialization', () => {
    const blocks = [{
      id: '1', type: 'table', part: 1, depth: 0,
      table: { columns: 1, rows: [[{ text: 'A', colspan: 1 }]] },
    }];
    const xml = serializeSEC(blocks, META);
    expect(xml).not.toMatch(/[^\r]\n/);
  });

  it('uses CRLF in ref block serialization', () => {
    const blocks = [{
      id: '1', type: 'ref', part: 1, depth: 1,
      ref: { org: 'TEST', entries: [{ rid: 'R1', rtl: 'T1' }] },
    }];
    const xml = serializeSEC(blocks, META);
    expect(xml).not.toMatch(/[^\r]\n/);
  });

  // ─── Edge cases ────────────────────────────────────────────────

  it('handles empty blocks array', () => {
    const xml = serializeSEC([], META);
    expect(xml).toContain('<SEC');
    expect(xml).toContain('</SEC>');
  });

  it('handles blocks with empty html', () => {
    const blocks = [
      { id: '1', type: 'txt', part: 1, depth: 0, html: '' },
    ];
    const xml = serializeSEC(blocks, META);
    expect(xml).toContain('<TXT></TXT>');
  });

  // ─── Table serialization ──────────────────────────────────────

  it('serializes table blocks back to TAB structure', () => {
    const blocks = [{
      id: '1', type: 'table', part: 1, depth: 0,
      table: {
        columns: 2,
        rows: [
          [{ text: 'A', colspan: 1 }, { text: 'B', colspan: 1 }],
          [{ text: 'C', colspan: 1 }, { text: 'D', colspan: 1 }],
        ],
      },
    }];
    const xml = serializeSEC(blocks, META);
    expect(xml).toContain('<TAB');
    expect(xml).toContain('COLUMNCOUNT="2"');
    expect(xml).toContain('ROWCOUNT="2"');
    expect(xml).toContain('<DTA TYPE="STRING">A</DTA>');
    expect(xml).toContain('<DTA TYPE="STRING">D</DTA>');
  });

  // ─── Revision (ADD/DEL/CHG) serialization ──────────────────────

  it('serializes inline ins as ADD', () => {
    const blocks = [
      { id: '1', type: 'txt', part: 1, depth: 0, html: 'Hello <ins class="mark-add">world</ins>' },
    ];
    const xml = serializeSEC(blocks, META);
    expect(xml).toContain('<TXT>Hello <ADD>world</ADD></TXT>');
  });

  it('serializes inline del as DEL', () => {
    const blocks = [
      { id: '1', type: 'txt', part: 1, depth: 0, html: 'Hello <del class="mark-del">old</del> text' },
    ];
    const xml = serializeSEC(blocks, META);
    expect(xml).toContain('<TXT>Hello <DEL>old</DEL> text</TXT>');
  });

  it('serializes inline span.mark-chg as CHG', () => {
    const blocks = [
      { id: '1', type: 'txt', part: 1, depth: 0, html: 'Hello <span class="mark-chg">changed</span>' },
    ];
    const xml = serializeSEC(blocks, META);
    expect(xml).toContain('<TXT>Hello <CHG>changed</CHG></TXT>');
  });

  it('serializes block-level revision ADD wrapping TXT', () => {
    const blocks = [
      { id: '1', type: 'txt', part: 1, depth: 0, html: 'Added', revision: 'add' },
    ];
    const xml = serializeSEC(blocks, META);
    expect(xml).toContain('<ADD><TXT>Added</TXT></ADD>');
  });

  it('serializes block-level revision DEL wrapping TXT', () => {
    const blocks = [
      { id: '1', type: 'txt', part: 1, depth: 0, html: 'Deleted', revision: 'del' },
    ];
    const xml = serializeSEC(blocks, META);
    expect(xml).toContain('<DEL><TXT>Deleted</TXT></DEL>');
  });

  it('serializes block-level revision CHG wrapping TXT', () => {
    const blocks = [
      { id: '1', type: 'txt', part: 1, depth: 0, html: 'Changed', revision: 'chg' },
    ];
    const xml = serializeSEC(blocks, META);
    expect(xml).toContain('<CHG><TXT>Changed</TXT></CHG>');
  });

  // ─── REF block serialization ──────────────────────────────────

  it('serializes ref block with ORG and RID/RTL pairs', () => {
    const blocks = [
      {
        id: '1', type: 'ref', part: 1, depth: 1,
        ref: {
          org: 'ASTM INTERNATIONAL (ASTM)',
          entries: [
            { rid: 'ASTM D2487', rtl: '(2017) Classification of Soils' },
            { rid: 'ASTM D698', rtl: '(2012) Compaction Test' },
          ],
        },
      },
    ];
    const xml = serializeSEC(blocks, META);
    expect(xml).toContain('<REF>');
    expect(xml).toContain('<ORG>ASTM INTERNATIONAL (ASTM)</ORG>');
    expect(xml).toContain('<RID>ASTM D2487</RID>');
    expect(xml).toContain('<RTL>(2017) Classification of Soils</RTL>');
    expect(xml).toContain('<RID>ASTM D698</RID>');
    expect(xml).toContain('<RTL>(2012) Compaction Test</RTL>');
    expect(xml).toContain('</REF>');
  });

  it('serializes ref block with revision wrapping', () => {
    const blocks = [
      {
        id: '1', type: 'ref', part: 1, depth: 1,
        revision: 'add',
        ref: {
          org: 'TEST ORG',
          entries: [{ rid: 'REF-001', rtl: 'Title' }],
        },
      },
    ];
    const xml = serializeSEC(blocks, META);
    expect(xml).toContain('<ADD><REF>');
    expect(xml).toContain('</REF></ADD>');
  });

  it('serializes ref block with empty entries', () => {
    const blocks = [
      {
        id: '1', type: 'ref', part: 1, depth: 1,
        ref: { org: 'EMPTY ORG', entries: [] },
      },
    ];
    const xml = serializeSEC(blocks, META);
    expect(xml).toContain('<REF>');
    expect(xml).toContain('<ORG>EMPTY ORG</ORG>');
    expect(xml).toContain('</REF>');
  });

  // ─── TBL (unformatted table) serialization ────────────────────

  it('serializes tbl blocks as TBL with BRK line breaks', () => {
    const blocks = [
      { id: '1', type: 'tbl', part: 1, depth: 1, html: '<b>HEADER</b>\nLine 1\nLine 2' },
    ];
    const xml = serializeSEC(blocks, META);
    expect(xml).toContain('<TBL>');
    expect(xml).toContain('<THD>HEADER</THD>');
    expect(xml).toContain('<BRK/>');
    expect(xml).toContain('Line 1');
    expect(xml).toContain('</TBL>');
  });

  // ─── ATT inline mark ──────────────────────────────────────────

  it('serializes ATT inline marks', () => {
    const blocks = [
      { id: '1', type: 'txt', part: 1, depth: 0, html: 'Use the <span class="mark-att">ENG Form 4025-R</span> form.' },
    ];
    const xml = serializeSEC(blocks, META);
    expect(xml).toContain('<ATT>ENG Form 4025-R</ATT>');
  });
});
