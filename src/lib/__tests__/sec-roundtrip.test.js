import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { parseSEC } from '../sec-parser.js';
import { serializeSEC } from '../sec-serializer.js';

function extractMeta(xml) {
  const meta = { sectionNumber: '00 00 00', sectionTitle: 'UNTITLED', date: '' };
  const scn = xml.match(/<SCN[^>]*>SECTION\s+([\d\s.]+)<\/SCN>/i);
  if (scn) meta.sectionNumber = scn[1].trim();
  const stl = xml.match(/<STL[^>]*>(.*?)<\/STL>/i);
  if (stl) meta.sectionTitle = stl[1].trim();
  const dte = xml.match(/<DTE[^>]*>(.*?)<\/DTE>/i);
  if (dte) meta.date = dte[1].trim();
  return meta;
}

describe('SEC roundtrip (parse → serialize → re-parse)', () => {
  it('31_00_00.SEC: block count preserved', () => {
    const xml = readFileSync('reference/31_00_00.SEC', 'latin1');
    const blocks1 = parseSEC(xml);
    const meta = extractMeta(xml);
    const serialized = serializeSEC(blocks1, meta);
    const blocks2 = parseSEC(serialized);

    expect(blocks2.length).toBe(blocks1.length);
  });

  it('31_00_00.SEC: block types preserved', () => {
    const xml = readFileSync('reference/31_00_00.SEC', 'latin1');
    const blocks1 = parseSEC(xml);
    const meta = extractMeta(xml);
    const serialized = serializeSEC(blocks1, meta);
    const blocks2 = parseSEC(serialized);

    const len = Math.min(blocks1.length, blocks2.length);
    let mismatches = 0;
    for (let i = 0; i < len; i++) {
      if (blocks1[i].type !== blocks2[i].type) mismatches++;
    }
    expect(mismatches).toBe(0);
  });

  it('31_00_00.SEC: part numbers preserved', () => {
    const xml = readFileSync('reference/31_00_00.SEC', 'latin1');
    const blocks1 = parseSEC(xml);
    const meta = extractMeta(xml);
    const serialized = serializeSEC(blocks1, meta);
    const blocks2 = parseSEC(serialized);

    const len = Math.min(blocks1.length, blocks2.length);
    let mismatches = 0;
    for (let i = 0; i < len; i++) {
      if (blocks1[i].part !== blocks2[i].part) mismatches++;
    }
    expect(mismatches).toBe(0);
  });

  it('31_00_00.SEC: depth values preserved', () => {
    const xml = readFileSync('reference/31_00_00.SEC', 'latin1');
    const blocks1 = parseSEC(xml);
    const meta = extractMeta(xml);
    const serialized = serializeSEC(blocks1, meta);
    const blocks2 = parseSEC(serialized);

    const len = Math.min(blocks1.length, blocks2.length);
    let mismatches = 0;
    for (let i = 0; i < len; i++) {
      if (blocks1[i].depth !== blocks2[i].depth) mismatches++;
    }
    expect(mismatches).toBe(0);
  });

  it('31_00_00.SEC: html content preserved (normalized whitespace)', () => {
    const xml = readFileSync('reference/31_00_00.SEC', 'latin1');
    const blocks1 = parseSEC(xml);
    const meta = extractMeta(xml);
    const serialized = serializeSEC(blocks1, meta);
    const blocks2 = parseSEC(serialized);

    const len = Math.min(blocks1.length, blocks2.length);
    let mismatches = 0;
    for (let i = 0; i < len; i++) {
      const a = (blocks1[i].html || '').replace(/\s+/g, ' ').trim();
      const b = (blocks2[i].html || '').replace(/\s+/g, ' ').trim();
      if (a !== b) mismatches++;
    }
    expect(mismatches).toBe(0);
  });

  it('synthetic roundtrip: mixed block types', () => {
    const blocks = [
      { id: '1', type: 'title', part: 1, depth: 1, html: 'GENERAL' },
      { id: '2', type: 'txt', part: 1, depth: 1, html: 'Some text with <span class="mark-rid">ASTM D2487</span>' },
      { id: '3', type: 'note', part: 1, depth: 1, html: 'Designer note here' },
      { id: '4', type: 'oli', part: 1, depth: 1, level: 1, html: 'First item' },
      { id: '5', type: 'oli', part: 1, depth: 1, level: 1, html: 'Second item' },
      { id: '6', type: 'lst', part: 1, depth: 1, html: 'SD-01 Submittals' },
      { id: '7', type: 'item', part: 1, depth: 1, html: 'A bullet item' },
    ];
    const meta = { sectionNumber: '99 99 99', sectionTitle: 'TEST ROUNDTRIP' };
    const serialized = serializeSEC(blocks, meta);
    const reparsed = parseSEC(serialized);

    expect(reparsed.length).toBe(blocks.length);
    for (let i = 0; i < blocks.length; i++) {
      expect(reparsed[i].type).toBe(blocks[i].type);
    }
  });

  it('TAI OPT survives parse → serialize → re-parse', () => {
    const xml = `<?xml version="1.0" encoding="windows-1252"?><SEC>
      <PRT>
        <TXT><TAI OPT="ARMY">Army only</TAI> and <TAI OPT="NAVY,NAVFAC NW">Navy NW</TAI></TXT>
        <TXT><TAI>No opt</TAI></TXT>
      </PRT>
    </SEC>`;
    const blocks1 = parseSEC(xml);
    const serialized = serializeSEC(blocks1, { sectionNumber: '00 00 00', sectionTitle: 'TAI TEST' });
    const blocks2 = parseSEC(serialized);

    expect(blocks2.length).toBe(blocks1.length);
    // Check first block: ARMY opt and NAVY,NAVFAC NW opt
    expect(blocks2[0].html).toContain('data-opt="ARMY"');
    expect(blocks2[0].html).toContain('data-opt="NAVY,NAVFAC NW"');
    // Check second block: no opt
    expect(blocks2[1].html).toContain('class="mark-tai"');
    expect(blocks2[1].html).not.toContain('data-opt');
  });

  it('ADD/DEL/CHG survive parse → serialize → re-parse (inline + block-level)', () => {
    const xml = `<?xml version="1.0" encoding="windows-1252"?><SEC>
      <PRT>
        <TXT>Text with <ADD>addition</ADD> and <DEL>deletion</DEL> and <CHG>change</CHG></TXT>
        <ADD><TXT>Block-level add</TXT></ADD>
        <DEL><TXT>Block-level del</TXT></DEL>
        <CHG><TXT>Block-level chg</TXT></CHG>
      </PRT>
    </SEC>`;
    const blocks1 = parseSEC(xml);
    const serialized = serializeSEC(blocks1, { sectionNumber: '00 00 00', sectionTitle: 'REV TEST' });
    const blocks2 = parseSEC(serialized);

    expect(blocks2.length).toBe(blocks1.length);

    // Inline revisions in first block
    expect(blocks2[0].html).toContain('<ins class="mark-add">addition</ins>');
    expect(blocks2[0].html).toContain('<del class="mark-del">deletion</del>');
    expect(blocks2[0].html).toContain('<span class="mark-chg">change</span>');

    // Block-level revisions
    expect(blocks2[1].revision).toBe('add');
    expect(blocks2[2].revision).toBe('del');
    expect(blocks2[3].revision).toBe('chg');
  });

  it('REF blocks survive roundtrip', () => {
    const xml = `<?xml version="1.0" encoding="windows-1252"?>
<SEC xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<MTA NAME="SUBFORMAT" CONTENT="NEW"/>
<SCN>SECTION 00 00 00</SCN>
<STL>REF ROUNDTRIP TEST</STL>
<PRT>
<SPT><TTL>REFERENCES</TTL>
<REF>
<ORG>ASTM INTERNATIONAL (ASTM)</ORG><BRK/><BRK/>
<RID>ASTM D2487</RID><RTL>(2017) Classification of Soils</RTL><BRK/><BRK/>
<RID>ASTM D698</RID><RTL>(2012) Compaction Test</RTL><BRK/><BRK/>
</REF>
</SPT>
</PRT>
</SEC>`;

    const blocks1 = parseSEC(xml);
    const refBlock1 = blocks1.find(b => b.type === 'ref');
    expect(refBlock1).toBeDefined();
    expect(refBlock1.ref.org).toBe('ASTM INTERNATIONAL (ASTM)');
    expect(refBlock1.ref.entries).toHaveLength(2);

    const serialized = serializeSEC(blocks1, { sectionNumber: '00 00 00', sectionTitle: 'REF ROUNDTRIP TEST' });
    expect(serialized).toContain('<REF>');
    expect(serialized).toContain('<ORG>ASTM INTERNATIONAL (ASTM)</ORG>');
    expect(serialized).toContain('<RID>ASTM D2487</RID>');

    const blocks2 = parseSEC(serialized);
    const refBlock2 = blocks2.find(b => b.type === 'ref');
    expect(refBlock2).toBeDefined();
    expect(refBlock2.ref.org).toBe(refBlock1.ref.org);
    expect(refBlock2.ref.entries).toHaveLength(refBlock1.ref.entries.length);
    expect(refBlock2.ref.entries[0].rid).toBe(refBlock1.ref.entries[0].rid);
    expect(refBlock2.ref.entries[0].rtl).toBe(refBlock1.ref.entries[0].rtl);
    expect(refBlock2.ref.entries[1].rid).toBe(refBlock1.ref.entries[1].rid);
    expect(refBlock2.ref.entries[1].rtl).toBe(refBlock1.ref.entries[1].rtl);
  });
});
