import { describe, it, expect } from 'vitest';
import { parseSEC } from '../sec-parser.js';

// Helper: wrap content in minimal SEC structure
function secWrap(inner) {
  return `<?xml version="1.0" encoding="windows-1252"?><SEC>${inner}</SEC>`;
}

function secPart(inner) {
  return secWrap(`<PRT>${inner}</PRT>`);
}

describe('parseSEC', () => {
  // ─── Basic block types ─────────────────────────────────────────

  it('parses TXT blocks', () => {
    const xml = secPart('<TXT>Hello world</TXT>');
    const blocks = parseSEC(xml);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('txt');
    expect(blocks[0].html).toBe('Hello world');
    expect(blocks[0].part).toBe(1);
  });

  it('parses TTL (title) blocks', () => {
    const xml = secPart('<TTL>GENERAL</TTL>');
    const blocks = parseSEC(xml);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('title');
    expect(blocks[0].html).toBe('GENERAL');
  });

  it('parses NPR (note) blocks inside NTE', () => {
    const xml = secPart('<NTE><NPR>This is a note</NPR></NTE>');
    const blocks = parseSEC(xml);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('note');
    expect(blocks[0].html).toBe('This is a note');
  });

  it('parses OLI blocks with level attribute', () => {
    const xml = secPart('<OLG><OLI>First item</OLI><OLI LEVEL="2">Sub item</OLI></OLG>');
    const blocks = parseSEC(xml);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].type).toBe('oli');
    expect(blocks[0].level).toBe(1);
    expect(blocks[1].level).toBe(2);
  });

  it('parses LST blocks', () => {
    const xml = secPart('<LST>SD-01 Submittals</LST>');
    const blocks = parseSEC(xml);
    expect(blocks[0].type).toBe('lst');
  });

  it('parses ITM blocks', () => {
    const xml = secPart('<ITM>A bulleted item</ITM>');
    const blocks = parseSEC(xml);
    expect(blocks[0].type).toBe('item');
  });

  // ─── Inline marks ──────────────────────────────────────────────

  it('converts RID to span.mark-rid', () => {
    const xml = secPart('<TXT>See <RID>ASTM D2487</RID> for details</TXT>');
    const blocks = parseSEC(xml);
    expect(blocks[0].html).toContain('<span class="mark-rid">ASTM D2487</span>');
  });

  it('converts SRF to span.mark-srf', () => {
    const xml = secPart('<TXT>Per <SRF>01 33 00</SRF></TXT>');
    const blocks = parseSEC(xml);
    expect(blocks[0].html).toContain('<span class="mark-srf">01 33 00</span>');
  });

  it('converts SUB to span.mark-sub', () => {
    const xml = secPart('<TXT><SUB>SD-01</SUB></TXT>');
    const blocks = parseSEC(xml);
    expect(blocks[0].html).toContain('<span class="mark-sub">SD-01</span>');
  });

  it('converts ENG and MET to respective mark spans', () => {
    const xml = secPart('<TXT><ENG>3 inches</ENG><MET>75 mm</MET></TXT>');
    const blocks = parseSEC(xml);
    expect(blocks[0].html).toContain('<span class="mark-eng">3 inches</span>');
    expect(blocks[0].html).toContain('<span class="mark-met">75 mm</span>');
  });

  // ─── Formatting tags ───────────────────────────────────────────

  it('converts BLD to <b>', () => {
    const xml = secPart('<TXT><BLD>bold text</BLD></TXT>');
    const blocks = parseSEC(xml);
    expect(blocks[0].html).toContain('<b>bold text</b>');
  });

  it('converts ITA to <em>', () => {
    const xml = secPart('<TXT><ITA>italic text</ITA></TXT>');
    const blocks = parseSEC(xml);
    expect(blocks[0].html).toContain('<em>italic text</em>');
  });

  it('converts UND to <u>', () => {
    const xml = secPart('<TXT><UND>underlined</UND></TXT>');
    const blocks = parseSEC(xml);
    expect(blocks[0].html).toContain('<u>underlined</u>');
  });

  // ─── Structure / depth ─────────────────────────────────────────

  it('tracks part number across PRT elements', () => {
    const xml = secWrap('<PRT><TXT>A</TXT></PRT><PRT><TXT>B</TXT></PRT>');
    const blocks = parseSEC(xml);
    expect(blocks[0].part).toBe(1);
    expect(blocks[1].part).toBe(2);
  });

  it('tracks SPT depth', () => {
    const xml = secPart('<SPT><TTL>Depth 1</TTL><SPT><TTL>Depth 2</TTL></SPT></SPT>');
    const blocks = parseSEC(xml);
    expect(blocks[0].depth).toBe(1);
    expect(blocks[1].depth).toBe(2);
  });

  it('resets depth after SPT closes', () => {
    const xml = secPart('<SPT><TTL>D1</TTL></SPT><TXT>Back to top</TXT>');
    const blocks = parseSEC(xml);
    expect(blocks[0].depth).toBe(1);
    expect(blocks[1].depth).toBe(0); // back at PRT level
  });

  // ─── Tables ────────────────────────────────────────────────────

  it('parses standalone TAB into table block', () => {
    const xml = secPart(`
      <TAB BORDERS="0"><WBK>
        <STS><STY SID="s50"><ALN VERTICAL="BOTTOM"/></STY></STS>
        <TDA COLUMNCOUNT="2" ROWCOUNT="1">
          <COL STYLEID="s50" WIDTH="200"/>
          <COL STYLEID="s50" WIDTH="200"/>
          <ROW>
            <CEL STYLEID="s50"><DTA TYPE="STRING">Cell A</DTA></CEL>
            <CEL STYLEID="s50"><DTA TYPE="STRING">Cell B</DTA></CEL>
          </ROW>
        </TDA>
      </WBK></TAB>
    `);
    const blocks = parseSEC(xml);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('table');
    expect(blocks[0].table.columns).toBe(2);
    expect(blocks[0].table.rows).toHaveLength(1);
    expect(blocks[0].table.rows[0][0].text).toBe('Cell A');
    expect(blocks[0].table.rows[0][1].text).toBe('Cell B');
  });

  it('handles colspan via MERGEACROSS', () => {
    const xml = secPart(`
      <TAB><WBK>
        <STS><STY SID="s50"><ALN VERTICAL="BOTTOM"/></STY></STS>
        <TDA COLUMNCOUNT="3" ROWCOUNT="1">
          <COL STYLEID="s50" WIDTH="100"/>
          <COL STYLEID="s50" WIDTH="100"/>
          <COL STYLEID="s50" WIDTH="100"/>
          <ROW>
            <CEL MERGEACROSS="2" STYLEID="s50"><DTA TYPE="STRING">Spans 3</DTA></CEL>
          </ROW>
        </TDA>
      </WBK></TAB>
    `);
    const blocks = parseSEC(xml);
    expect(blocks[0].table.rows[0][0].colspan).toBe(3);
  });

  // ─── REF blocks ────────────────────────────────────────────────

  it('parses REF blocks as structured ref type with ORG and entries', () => {
    const xml = secPart(`
      <SPT><TTL>REFERENCES</TTL>
        <REF>
          <ORG>ASTM INTERNATIONAL (ASTM)</ORG><BRK/>
          <RID>ASTM D2487</RID><RTL>(2017) Classification of Soils</RTL><BRK/>
          <RID>ASTM D698</RID><RTL>(2012) Compaction Test</RTL><BRK/>
        </REF>
      </SPT>
    `);
    const blocks = parseSEC(xml);
    // Title + 1 ref block
    expect(blocks.length).toBeGreaterThanOrEqual(2);

    const refBlock = blocks.find(b => b.type === 'ref');
    expect(refBlock).toBeDefined();
    expect(refBlock.ref.org).toBe('ASTM INTERNATIONAL (ASTM)');
    expect(refBlock.ref.entries).toHaveLength(2);
    expect(refBlock.ref.entries[0].rid).toBe('ASTM D2487');
    expect(refBlock.ref.entries[0].rtl).toBe('(2017) Classification of Soils');
    expect(refBlock.ref.entries[1].rid).toBe('ASTM D698');
    expect(refBlock.ref.entries[1].rtl).toBe('(2012) Compaction Test');
  });

  it('parses REF with no RTL as empty rtl string', () => {
    const xml = secPart(`
      <SPT><TTL>REFERENCES</TTL>
        <REF>
          <ORG>TEST ORG</ORG>
          <RID>REF-001</RID><BRK/>
        </REF>
      </SPT>
    `);
    const blocks = parseSEC(xml);
    const refBlock = blocks.find(b => b.type === 'ref');
    expect(refBlock).toBeDefined();
    expect(refBlock.ref.entries).toHaveLength(1);
    expect(refBlock.ref.entries[0].rid).toBe('REF-001');
    expect(refBlock.ref.entries[0].rtl).toBe('');
  });

  it('parses REF with NTE child as separate note block', () => {
    const xml = secPart(`
      <SPT><TTL>REFERENCES</TTL>
        <REF>
          <ORG>TEST ORG</ORG>
          <NTE><NPR>A note inside ref</NPR></NTE>
          <RID>REF-001</RID><RTL>Title</RTL>
        </REF>
      </SPT>
    `);
    const blocks = parseSEC(xml);
    const refBlock = blocks.find(b => b.type === 'ref');
    const noteBlock = blocks.find(b => b.type === 'note');
    expect(refBlock).toBeDefined();
    expect(noteBlock).toBeDefined();
    expect(noteBlock.html).toBe('A note inside ref');
  });

  // ─── Skipped tags ──────────────────────────────────────────────

  it('skips BRK, AST, MTA tags', () => {
    const xml = secWrap('<MTA NAME="AUTONUMBER" CONTENT="TRUE"/><PRT><BRK/><AST/><TXT>content</TXT></PRT>');
    const blocks = parseSEC(xml);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].html).toBe('content');
  });

  // ─── Edge cases ────────────────────────────────────────────────

  it('returns empty array for empty document', () => {
    const xml = secWrap('');
    expect(parseSEC(xml)).toEqual([]);
  });

  it('returns empty array for header-only document', () => {
    const xml = secWrap('<HDR><HL4>TITLE</HL4></HDR><SCN>SECTION 00 00 00</SCN><STL>UNTITLED</STL>');
    expect(parseSEC(xml)).toEqual([]);
  });

  // ─── TAI OPT attribute preservation ─────────────────────────────

  it('preserves TAI OPT attribute as data-opt', () => {
    const xml = secPart('<TXT><TAI OPT="ARMY">Army only content</TAI></TXT>');
    const blocks = parseSEC(xml);
    expect(blocks[0].html).toContain('data-opt="ARMY"');
    expect(blocks[0].html).toContain('class="mark-tai"');
    expect(blocks[0].html).toContain('Army only content');
  });

  it('handles TAI without OPT attribute', () => {
    const xml = secPart('<TXT><TAI>Generic tailoring</TAI></TXT>');
    const blocks = parseSEC(xml);
    expect(blocks[0].html).toContain('class="mark-tai"');
    expect(blocks[0].html).not.toContain('data-opt');
    expect(blocks[0].html).toContain('Generic tailoring');
  });

  it('preserves multi-value OPT (comma-separated)', () => {
    const xml = secPart('<TXT><TAI OPT="ARMY,NAVY">Both branches</TAI></TXT>');
    const blocks = parseSEC(xml);
    expect(blocks[0].html).toContain('data-opt="ARMY,NAVY"');
  });

  it('preserves TAI OPT in elemToHtmlNoTab path', () => {
    // TXT with a TAB child triggers elemToHtmlNoTab for non-table content
    const xml = secPart(`<TXT><TAI OPT="NAVY">Navy text</TAI>
      <TAB><WBK><STS><STY SID="s50"><ALN VERTICAL="BOTTOM"/></STY></STS>
      <TDA COLUMNCOUNT="1" ROWCOUNT="1"><COL STYLEID="s50" WIDTH="100"/>
      <ROW><CEL STYLEID="s50"><DTA TYPE="STRING">cell</DTA></CEL></ROW>
      </TDA></WBK></TAB></TXT>`);
    const blocks = parseSEC(xml);
    const txtBlock = blocks.find(b => b.type === 'txt');
    expect(txtBlock.html).toContain('data-opt="NAVY"');
  });

  it('parses pre-part notes (part 0)', () => {
    const xml = secWrap('<NTE><NPR>Pre-part note</NPR></NTE><PRT><TXT>text</TXT></PRT>');
    const blocks = parseSEC(xml);
    expect(blocks[0].type).toBe('note');
    expect(blocks[0].part).toBe(0);
    expect(blocks[1].part).toBe(1);
  });

  // ─── ADD/DEL/CHG revision marks ───────────────────────────────

  it('parses inline ADD as <ins class="mark-add">', () => {
    const xml = secPart('<TXT>Hello <ADD>world</ADD></TXT>');
    const blocks = parseSEC(xml);
    expect(blocks[0].html).toBe('Hello <ins class="mark-add">world</ins>');
  });

  it('parses inline DEL as <del class="mark-del">', () => {
    const xml = secPart('<TXT>Hello <DEL>old</DEL> text</TXT>');
    const blocks = parseSEC(xml);
    expect(blocks[0].html).toBe('Hello <del class="mark-del">old</del> text');
  });

  it('parses inline CHG as <span class="mark-chg">', () => {
    const xml = secPart('<TXT>Hello <CHG>changed</CHG> text</TXT>');
    const blocks = parseSEC(xml);
    expect(blocks[0].html).toBe('Hello <span class="mark-chg">changed</span> text');
  });

  it('parses block-level ADD wrapping TXT', () => {
    const xml = secPart('<ADD><TXT>Added paragraph</TXT></ADD>');
    const blocks = parseSEC(xml);
    expect(blocks[0].type).toBe('txt');
    expect(blocks[0].html).toBe('Added paragraph');
    expect(blocks[0].revision).toBe('add');
  });

  it('parses block-level DEL wrapping TXT', () => {
    const xml = secPart('<DEL><TXT>Deleted paragraph</TXT></DEL>');
    const blocks = parseSEC(xml);
    expect(blocks[0].type).toBe('txt');
    expect(blocks[0].revision).toBe('del');
  });

  it('parses block-level CHG wrapping SPT', () => {
    const xml = secPart('<CHG><SPT><TTL>Changed Section</TTL><TXT>Content</TXT></SPT></CHG>');
    const blocks = parseSEC(xml);
    expect(blocks[0].type).toBe('title');
    expect(blocks[0].revision).toBe('chg');
    expect(blocks[1].type).toBe('txt');
    expect(blocks[1].revision).toBe('chg');
  });

  it('parses mixed inline revisions in one block', () => {
    const xml = secPart('<TXT><ADD>new</ADD> and <DEL>old</DEL> and <CHG>modified</CHG></TXT>');
    const blocks = parseSEC(xml);
    expect(blocks[0].html).toContain('<ins class="mark-add">new</ins>');
    expect(blocks[0].html).toContain('<del class="mark-del">old</del>');
    expect(blocks[0].html).toContain('<span class="mark-chg">modified</span>');
  });
});
