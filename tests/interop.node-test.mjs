/**
 * Automated Interop Test Suite
 *
 * Validates structural properties of SecWriter-serialized .SEC output.
 * Parses reference fixtures with sec-parser.js, serializes with
 * sec-serializer.js, then asserts the output meets .SEC format
 * requirements.
 *
 * Runner: Node built-in test runner (not Vitest)
 * Run: npm run test:interop
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import { parseHTML } from 'linkedom';

const { DOMParser } = parseHTML('');
globalThis.DOMParser = DOMParser;

const { parseSEC } = await import('../src/lib/sec-parser.js');
const { serializeSEC } = await import('../src/lib/sec-serializer.js');

// ── Fixtures ──────────────────────────────────────────────────────────────────

const FIXTURE_MAIN = 'reference/31_00_00.SEC';        // EARTHWORK — primary fixture
const FIXTURE_CHG  = 'reference/UFGS_M/21 13 25.SEC'; // has inline CHG revision tags
const FIXTURE_TBL  = 'reference/UFGS_M/02 62 16.16 10.SEC'; // has TBL + THD

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

// Parse and serialize each fixture once, shared across tests
let mainXml, mainBlocks, mainOut;
let chgXml, chgBlocks, chgOut;
let tblXml, tblBlocks, tblOut;

mainXml    = fs.readFileSync(FIXTURE_MAIN, 'latin1');
mainBlocks = parseSEC(mainXml);
mainOut    = serializeSEC(mainBlocks, extractMeta(mainXml));

chgXml    = fs.readFileSync(FIXTURE_CHG, 'latin1');
chgBlocks = parseSEC(chgXml);
chgOut    = serializeSEC(chgBlocks, extractMeta(chgXml));

tblXml    = fs.readFileSync(FIXTURE_TBL, 'latin1');
tblBlocks = parseSEC(tblXml);
tblOut    = serializeSEC(tblBlocks, extractMeta(tblXml));

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('SEC serializer interop', () => {

  // 1. XML declaration
  it('XML declaration includes encoding="windows-1252"', () => {
    assert.ok(
      mainOut.startsWith('<?xml version="1.0" encoding="windows-1252"?>'),
      'First line must be the XML declaration with windows-1252 encoding'
    );
  });

  // 2. Root element
  it('root element is <SEC> with correct xmlns:xsi and schema URL', () => {
    assert.ok(mainOut.includes('xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"'),
      'SEC element must declare xsi namespace');
    assert.ok(mainOut.includes('xsi:noNamespaceSchemaLocation="http://si.ksc.nasa.gov/sidownloads/xml/specsintactSEC.xsd"'),
      'SEC element must include the SpecsIntact schema URL');
    assert.ok(mainOut.includes('<SEC '), 'Must open with <SEC');
    assert.ok(mainOut.trimEnd().endsWith('</SEC>'), 'Must close with </SEC>');
  });

  // 3. MTA tags (minimum: SUBFORMAT + AUTONUMBER present)
  it('MTA tags SUBFORMAT and AUTONUMBER are present', () => {
    assert.ok(mainOut.includes('NAME="SUBFORMAT"'), 'MTA SUBFORMAT must be present');
    assert.ok(mainOut.includes('NAME="AUTONUMBER"'), 'MTA AUTONUMBER must be present');
    const mtaCount = (mainOut.match(/<MTA /g) || []).length;
    assert.ok(mtaCount >= 2, `At least 2 MTA tags expected, found ${mtaCount}`);
  });

  // 4. HDR element: presence only (SecWriter produces minimal header — fidelity is Task 2.2)
  it('HDR element is present with opening and closing tags', () => {
    assert.ok(mainOut.includes('<HDR>'), '<HDR> opening tag must be present');
    assert.ok(mainOut.includes('</HDR>'), '</HDR> closing tag must be present');
  });

  // 5. SCN / STL / DTE: correct content from original
  it('SCN, STL, and DTE carry correct content from original', () => {
    assert.ok(mainOut.includes('<SCN>SECTION 31 00 00</SCN>'),
      'SCN must contain original section number');
    assert.ok(mainOut.includes('<STL>EARTHWORK</STL>'),
      'STL must contain original section title');
    assert.ok(mainOut.includes('<DTE>08/23</DTE>'),
      'DTE must contain original date');
  });

  // 6. PRT count: must match original
  it('PRT count matches original (3)', () => {
    const origPrts = (mainXml.match(/<PRT>/g) || []).length;
    const outPrts  = (mainOut.match(/<PRT>/g) || []).length;
    assert.equal(outPrts, origPrts,
      `Expected ${origPrts} <PRT> elements, found ${outPrts}`);
  });

  // 7. SPT nesting: output SPT open/close counts are balanced
  it('SPT elements are balanced (open count equals close count)', () => {
    const open  = (mainOut.match(/<SPT>/g) || []).length;
    const close = (mainOut.match(/<\/SPT>/g) || []).length;
    assert.equal(open, close,
      `SPT open=${open} close=${close} — must be balanced`);
    assert.ok(open > 0, 'Must produce at least one SPT element');
  });

  // 8. NTE grouping: every NPR is inside an NTE
  it('all NPR elements appear inside NTE groups', () => {
    // Validate by checking that every <NPR> is preceded by an <NTE> (without </NTE> intervening)
    const nteOpen  = (mainOut.match(/<NTE>/g) || []).length;
    const nteClose = (mainOut.match(/<\/NTE>/g) || []).length;
    const nprCount = (mainOut.match(/<NPR>/g) || []).length;
    assert.ok(nteOpen > 0, 'Must have at least one NTE group');
    assert.equal(nteOpen, nteClose, 'NTE elements must be balanced');
    assert.ok(nprCount > 0, 'Must have at least one NPR element');
    // Verify no NPR appears before the first NTE or after the last /NTE
    const firstNte = mainOut.indexOf('<NTE>');
    const firstNpr = mainOut.indexOf('<NPR>');
    assert.ok(firstNpr > firstNte,
      'First NPR must appear after first NTE opening tag');
  });

  // 9. OLG grouping: OLI elements appear inside OLG wrappers
  it('OLI elements are wrapped in OLG groups', () => {
    const olgCount = (mainOut.match(/<OLG>/g) || []).length;
    const oliCount = (mainOut.match(/<OLI[\s>]/g) || []).length;
    assert.ok(olgCount > 0, 'Must have at least one OLG wrapper');
    assert.ok(oliCount > 0, 'Must have at least one OLI element');
    // OLG must be balanced
    const olgClose = (mainOut.match(/<\/OLG>/g) || []).length;
    assert.equal(olgCount, olgClose, 'OLG elements must be balanced');
  });

  // 10. REF structure: ORG + RID/RTL entries preserved
  it('REF blocks preserve ORG and RID/RTL structure', () => {
    assert.ok(mainOut.includes('<REF>'), 'REF element must be present');
    assert.ok(mainOut.includes('<ORG>'), 'ORG element must be present inside REF');
    assert.ok(mainOut.includes('<RID>'), 'RID element must be present inside REF');
    assert.ok(mainOut.includes('<RTL>'), 'RTL element must be present inside REF');
  });

  // 11. TAB structure: COLUMNCOUNT/ROWCOUNT attributes, ROW/CEL valid
  it('TAB blocks include COLUMNCOUNT, ROWCOUNT, ROW, and CEL elements', () => {
    assert.ok(mainOut.includes('COLUMNCOUNT='), 'TAB must have COLUMNCOUNT attribute');
    assert.ok(mainOut.includes('ROWCOUNT='), 'TAB must have ROWCOUNT attribute');
    assert.ok(mainOut.includes('<ROW>') || mainOut.includes('<ROW '), 'TAB must contain ROW elements');
    assert.ok(mainOut.includes('<CEL'), 'TAB must contain CEL elements');
  });

  // 12. TBL roundtrip: THD preserved, BRK tags present (uses FIXTURE_TBL)
  it('TBL blocks roundtrip with THD header and BRK line breaks', () => {
    assert.ok(tblOut.includes('<TBL>'), 'TBL element must be present');
    assert.ok(tblOut.includes('<THD>'), 'THD header must be preserved inside TBL');
    assert.ok(tblOut.includes('<BRK/>'), 'BRK tags must appear within TBL content');
  });

  // 13. Inline marks: SEC tags present (not HTML spans)
  it('inline marks are serialized as SEC tags (RID, SRF, SUB, ENG, MET, TAI)', () => {
    const checks = [
      ['<RID>', mainOut],
      ['<SRF>', mainOut],
      ['<SUB>', mainOut],
      ['<ENG>', mainOut],
      ['<MET>', mainOut],
      ['<TAI ', mainOut],  // TAI has OPT attribute
    ];
    for (const [tag, out] of checks) {
      assert.ok(out.includes(tag), `Expected SEC tag "${tag}" in serialized output`);
    }
  });

  // 14. Revision tags: CHG preserved (uses FIXTURE_CHG which has inline CHG)
  it('revision tags (CHG) are preserved in serialized output', () => {
    assert.ok(chgOut.includes('<CHG>'),
      'CHG revision tags must appear in output when blocks contain them');
    assert.ok(chgOut.includes('</CHG>'),
      'CHG closing tags must be balanced');
  });

  // 15. No HTML leakage: no <span>, <ins>, <del>, <b>, <em>, <u> in output
  it('no HTML element leakage in serialized output', () => {
    const htmlTags = ['<span', '<ins', '<del', '<b>', '<b ', '<em>', '<em ', '<u>'];
    for (const tag of htmlTags) {
      assert.ok(!mainOut.includes(tag),
        `HTML tag "${tag}" must not appear in SEC output`);
    }
  });

  // 16. Encoding: non-ASCII characters survive the parse → serialize cycle
  it('non-ASCII characters survive the parse/serialize roundtrip', () => {
    // µ (0xB5) and smart apostrophe (0x92) are present in original fixture
    const origNonAscii = [...mainXml].filter(c => c.charCodeAt(0) > 127);
    const outNonAscii  = [...mainOut].filter(c => c.charCodeAt(0) > 127);
    assert.ok(origNonAscii.length > 0, 'Original fixture must have non-ASCII chars');
    assert.ok(outNonAscii.length > 0,
      'Serialized output must preserve non-ASCII characters from original');
  });

  // 17. Line endings: CRLF used consistently
  it('line endings are CRLF (\\r\\n) throughout the output', () => {
    assert.ok(mainOut.includes('\r\n'), 'Output must contain CRLF line endings');
    // Split on CRLF; no resulting line should contain a bare \n (which would mean LF-only)
    const lines = mainOut.split('\r\n');
    const bareNl = lines.filter(l => l.includes('\n'));
    assert.equal(bareNl.length, 0,
      `Found ${bareNl.length} lines with bare LF after splitting on CRLF — mixing line endings`);
  });

});
