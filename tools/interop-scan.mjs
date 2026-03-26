/**
 * Binary-level interop scanner for SEC files.
 *
 * For each .SEC file: read original → parse → serialize → compare serialized
 * output against original XML at the text level, categorizing differences into:
 *   - whitespace:  Line endings, indentation, blank lines (benign)
 *   - structural:  Missing/added tags, attribute differences, tag ordering
 *   - content:     Text content changes, encoding corruption (data loss)
 *
 * Also checks: HDR presence/fidelity, MTA tag count, PRT count, TAB attribute completeness.
 *
 * Usage:
 *   node --import ./tools/json-loader.mjs tools/interop-scan.mjs                          # all files
 *   node --import ./tools/json-loader.mjs tools/interop-scan.mjs reference/31_00_00.SEC   # one file
 *
 * Output: test-results/interop-scan.json  +  human-readable summary to stdout
 */

import { parseHTML } from 'linkedom';
// Polyfill DOMParser for Node
const { DOMParser } = parseHTML('');
globalThis.DOMParser = DOMParser;

import { parseSEC } from '../src/lib/sec-parser.js';
import { serializeSEC } from '../src/lib/sec-serializer.js';
import fs from 'fs';
import path from 'path';

// ── helpers ──────────────────────────────────────────────────────────────────

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

/**
 * Normalise a line: collapse interior whitespace, trim edges.
 * Used to detect lines that differ only in whitespace amount/type.
 */
function normaliseLine(line) {
  return line.replace(/\r/g, '').trim().replace(/\s+/g, ' ');
}

/**
 * Extract all XML/SGML tag tokens from a string (opening, closing, self-closing).
 * Returns an array of {tag, attrs, closing, selfClosing} objects.
 */
function extractTags(xml) {
  const TAG_RE = /<(\/?)([A-Z][A-Z0-9]*)([^>]*?)(\/?)>/gi;
  const tags = [];
  let m;
  while ((m = TAG_RE.exec(xml)) !== null) {
    tags.push({
      raw: m[0],
      closing: m[1] === '/',
      name: m[2].toUpperCase(),
      attrs: m[3].trim(),
      selfClosing: m[4] === '/',
    });
  }
  return tags;
}

/**
 * Count occurrences of a tag name in the given XML string.
 */
function countTag(xml, tagName) {
  const re = new RegExp(`<${tagName}[\\s>/]`, 'gi');
  return (xml.match(re) || []).length;
}

/**
 * Extract plain text content (strip all tags) from XML string.
 */
function stripTags(xml) {
  return xml.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * Count occurrences of an attribute name in a string of tag markup.
 * Works on a full XML string by extracting only the relevant tags first.
 */
function countAttrInTag(xml, tagName, attrName) {
  const tagRe = new RegExp(`<${tagName}([^>]*)>`, 'gi');
  const attrRe = new RegExp(`\\b${attrName}\\b`, 'i');
  let count = 0;
  let m;
  while ((m = tagRe.exec(xml)) !== null) {
    if (attrRe.test(m[1])) count++;
  }
  return count;
}

/**
 * Check whether all TAB elements in the original have BORDERS attribute in
 * the serialized output, and whether COL/ROW elements preserve WIDTH/AUTOWIDTH
 * and HEIGHT/AUTOHEIGHT attributes. Returns issues array and attribute counts.
 */
function checkTabAttributes(orig, serialized) {
  const issues = [];

  // Count TAB elements in each
  const origTabCount = countTag(orig, 'TAB');
  const serTabCount = countTag(serialized, 'TAB');
  if (origTabCount !== serTabCount) {
    issues.push(`TAB count: ${origTabCount} → ${serTabCount}`);
  }

  // Check BORDERS attribute on TAB elements
  const origTabBorders = countAttrInTag(orig, 'TAB', 'BORDERS');
  const serTabBorders  = countAttrInTag(serialized, 'TAB', 'BORDERS');
  const missingBorders = origTabBorders - serTabBorders;

  // Check WIDTH / AUTOWIDTH on COL elements
  const origColWidth     = countAttrInTag(orig, 'COL', 'WIDTH') + countAttrInTag(orig, 'COL', 'AUTOWIDTH');
  const serColWidth      = countAttrInTag(serialized, 'COL', 'WIDTH') + countAttrInTag(serialized, 'COL', 'AUTOWIDTH');
  const missingColWidth  = origColWidth - serColWidth;

  // Check HEIGHT / AUTOHEIGHT on ROW elements
  const origRowHeight    = countAttrInTag(orig, 'ROW', 'HEIGHT') + countAttrInTag(orig, 'ROW', 'AUTOHEIGHT');
  const serRowHeight     = countAttrInTag(serialized, 'ROW', 'HEIGHT') + countAttrInTag(serialized, 'ROW', 'AUTOHEIGHT');
  const missingRowHeight = origRowHeight - serRowHeight;

  if (missingBorders > 0) {
    issues.push(`TAB BORDERS attribute missing: ${missingBorders} occurrence(s) lost`);
  }
  if (missingColWidth > 0) {
    issues.push(`COL WIDTH/AUTOWIDTH attribute missing: ${missingColWidth} occurrence(s) lost`);
  }
  if (missingRowHeight > 0) {
    issues.push(`ROW HEIGHT/AUTOHEIGHT attribute missing: ${missingRowHeight} occurrence(s) lost`);
  }

  return {
    issues,
    origTabBorders,
    serTabBorders,
    missingBorders,
    origColWidth,
    serColWidth,
    missingColWidth,
    origRowHeight,
    serRowHeight,
    missingRowHeight,
  };
}

// ── diff categorisation ───────────────────────────────────────────────────────

/**
 * Compare original and serialized XML, returning categorised diffs.
 *
 * Categories:
 *   whitespace  – lines differ only in whitespace/line-endings
 *   structural  – tag name/attribute/ordering differences
 *   content     – plain-text content differences
 */
function categoriseDiffs(orig, serialized) {
  const result = {
    whitespace: [],   // { line, orig, serialized }
    structural: [],   // { description }
    content: [],      // { description }
    checks: {},       // named checks (HDR, MTA, PRT, TAB)
  };

  // ── 1. Line-level diff (normalise CRLF vs LF first) ──────────────────────
  const origLines    = orig.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const serLines     = serialized.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');

  const origNorm  = origLines.map(normaliseLine);
  const serNorm   = serLines.map(normaliseLine);

  // Build a multiset from each to compare content regardless of order/whitespace
  const origSet = Object.create(null);
  for (const l of origNorm.filter(Boolean)) origSet[l] = (origSet[l] || 0) + 1;

  const serSet  = Object.create(null);
  for (const l of serNorm.filter(Boolean)) serSet[l] = (serSet[l] || 0) + 1;

  // Lines in orig but not in serialized (potential structural/content losses)
  const onlyInOrig = [];
  for (const [l, cnt] of Object.entries(origSet)) {
    const diff = cnt - (serSet[l] || 0);
    if (diff > 0) onlyInOrig.push({ line: l, count: diff });
  }

  // Lines in serialized but not in orig (additions/rewrites)
  const onlyInSer = [];
  for (const [l, cnt] of Object.entries(serSet)) {
    const diff = cnt - (origSet[l] || 0);
    if (diff > 0) onlyInSer.push({ line: l, count: diff });
  }

  // ── 2. Whitespace-only differences ────────────────────────────────────────
  // Count non-empty lines in each that differ
  const origNonEmpty = origLines.filter(l => l.trim() !== '');
  const serNonEmpty  = serLines.filter(l => l.trim() !== '');

  const origNormNonEmpty = origNonEmpty.map(normaliseLine);
  const serNormNonEmpty  = serNonEmpty.map(normaliseLine);

  // Quick check: if normalised non-empty counts differ, that's structural
  if (origNormNonEmpty.length !== serNormNonEmpty.length) {
    result.structural.push(
      `Non-empty line count: ${origNormNonEmpty.length} → ${serNormNonEmpty.length} (diff: ${serNormNonEmpty.length - origNormNonEmpty.length})`
    );
  } else {
    // Same count — check if any differ after normalisation
    let wsDiffs = 0;
    for (let i = 0; i < origNormNonEmpty.length; i++) {
      if (origNormNonEmpty[i] !== serNormNonEmpty[i]) wsDiffs++;
    }
    if (wsDiffs > 0) {
      result.whitespace.push(`${wsDiffs} lines differ in normalised content`);
    }
  }

  // ── 3. Tag-level structural comparison ───────────────────────────────────
  const STRUCTURAL_TAGS = ['SEC', 'PRT', 'SPT', 'TTL', 'TXT', 'OLG', 'OLI', 'LST',
    'ITM', 'NTE', 'NPR', 'NPG', 'SBM', 'REF', 'RID', 'SUB', 'SRF', 'TAB', 'TBL',
    'HDR', 'SCN', 'STL', 'DTE', 'MTA', 'BRK', 'AST', 'ADD', 'DEL', 'CHG',
    'ENG', 'MET', 'TAI', 'BLD', 'ITA', 'UND', 'CTR', 'ATT'];

  for (const tag of STRUCTURAL_TAGS) {
    const origCnt = countTag(orig, tag);
    const serCnt  = countTag(serialized, tag);
    if (origCnt !== serCnt) {
      const delta = serCnt - origCnt;
      const category = ['TXT', 'OLI', 'ITM', 'LST', 'NPR', 'TTL', 'REF', 'OLG', 'SPT', 'PRT'].includes(tag)
        ? result.structural : result.structural;
      result.structural.push(`<${tag}> count: ${origCnt} → ${serCnt} (${delta > 0 ? '+' : ''}${delta})`);
    }
  }

  // ── 4. Content comparison ─────────────────────────────────────────────────
  const origText = stripTags(orig);
  const serText  = stripTags(serialized);

  if (origText !== serText) {
    // Find approximate character of first difference
    let firstDiff = -1;
    const minLen = Math.min(origText.length, serText.length);
    for (let i = 0; i < minLen; i++) {
      if (origText[i] !== serText[i]) { firstDiff = i; break; }
    }
    if (firstDiff === -1 && origText.length !== serText.length) {
      firstDiff = minLen; // one is longer
    }

    const origLen = origText.length;
    const serLen  = serText.length;
    const snippet = firstDiff >= 0
      ? `first diff at char ${firstDiff}: orig="${origText.substring(firstDiff, firstDiff + 40)}" ser="${serText.substring(firstDiff, firstDiff + 40)}"`
      : '';

    result.content.push(`Plain-text differs: ${origLen} → ${serLen} chars${snippet ? '; ' + snippet : ''}`);
  }

  // ── 5. Named checks ───────────────────────────────────────────────────────
  // HDR check
  const origHdr = /<HDR[\s>]/.test(orig);
  const serHdr  = /<HDR[\s>]/.test(serialized);
  result.checks.hdr = { present: serHdr, origPresent: origHdr };

  // MTA tag count
  result.checks.mta = {
    orig: countTag(orig, 'MTA'),
    serialized: countTag(serialized, 'MTA'),
  };

  // PRT count
  result.checks.prt = {
    orig: countTag(orig, 'PRT'),
    serialized: countTag(serialized, 'PRT'),
  };

  // TAB attribute check
  const tabResult = checkTabAttributes(orig, serialized);
  result.checks.tab = tabResult;

  // SCN/STL/DTE presence
  result.checks.scn = { present: /<SCN[\s>]/.test(serialized) };
  result.checks.stl = { present: /<STL[\s>]/.test(serialized) };

  return result;
}

// ── per-file scan ─────────────────────────────────────────────────────────────

function scanFile(filePath) {
  const name = path.basename(filePath);

  let orig;
  try {
    orig = fs.readFileSync(filePath, 'latin1');
  } catch (e) {
    return { name, filePath, status: 'READ_ERROR', error: e.message };
  }

  let blocks;
  try {
    blocks = parseSEC(orig);
  } catch (e) {
    return { name, filePath, status: 'PARSE_ERROR', error: e.message };
  }

  if (blocks.length === 0) {
    return { name, filePath, status: 'EMPTY', error: 'Parser returned 0 blocks' };
  }

  let serialized;
  try {
    const meta = extractMeta(orig);
    serialized = serializeSEC(blocks, meta);
  } catch (e) {
    return { name, filePath, status: 'SERIALIZE_ERROR', error: e.message };
  }

  const diffs = categoriseDiffs(orig, serialized);

  const hasContent    = diffs.content.length > 0;
  const hasStructural = diffs.structural.length > 0;
  const hasWhitespace = diffs.whitespace.length > 0;

  let status;
  if (hasContent) status = 'CONTENT_DIFF';
  else if (hasStructural) status = 'STRUCTURAL_DIFF';
  else if (hasWhitespace) status = 'WHITESPACE_DIFF';
  else status = 'CLEAN';

  return {
    name,
    filePath,
    status,
    blockCount: blocks.length,
    origBytes: orig.length,
    serializedBytes: serialized.length,
    diffs,
  };
}

// ── main ──────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
let files;

if (args.length > 0) {
  files = args;
} else {
  const dir = 'reference/UFGS_M';
  files = fs.readdirSync(dir)
    .filter(f => f.toLowerCase().endsWith('.sec'))
    .map(f => path.join(dir, f));
  // Also include the sample file
  files.unshift('reference/31_00_00.SEC');
}

console.log(`Scanning ${files.length} SEC file(s) for interop differences...\n`);

const results = [];
let clean = 0, whitespaceOnly = 0, structuralDiff = 0, contentDiff = 0, errors = 0, empty = 0;

for (let i = 0; i < files.length; i++) {
  const f = files[i];
  if (files.length > 1 && i % 50 === 0 && i > 0) {
    process.stdout.write(`  ${i}/${files.length}...\n`);
  }
  const result = scanFile(f);
  results.push(result);

  switch (result.status) {
    case 'CLEAN':          clean++;         break;
    case 'WHITESPACE_DIFF': whitespaceOnly++; break;
    case 'STRUCTURAL_DIFF': structuralDiff++; break;
    case 'CONTENT_DIFF':    contentDiff++;    break;
    case 'EMPTY':           empty++;          break;
    default:                errors++;         break;
  }
}

// ── stdout summary ────────────────────────────────────────────────────────────

console.log('='.repeat(72));
console.log('INTEROP SCAN RESULTS');
console.log('='.repeat(72));
console.log(`  CLEAN          : ${clean}`);
console.log(`  WHITESPACE ONLY: ${whitespaceOnly}`);
console.log(`  STRUCTURAL DIFF: ${structuralDiff}`);
console.log(`  CONTENT DIFF   : ${contentDiff}`);
console.log(`  EMPTY          : ${empty}`);
console.log(`  ERROR          : ${errors}`);
console.log(`  TOTAL          : ${files.length}`);
console.log('='.repeat(72));

// Show first few of each category
const showResults = (label, statuses, limit = 10) => {
  const subset = results.filter(r => statuses.includes(r.status));
  if (subset.length === 0) return;
  console.log(`\n--- ${label} (${subset.length}) ---`);
  for (const r of subset.slice(0, limit)) {
    console.log(`\n${r.name} [${r.blockCount || 0} blocks, ${r.origBytes || 0}→${r.serializedBytes || 0} bytes]:`);
    if (r.error) {
      console.log(`  ERROR: ${r.error}`);
      continue;
    }
    if (r.diffs) {
      if (r.diffs.content.length) {
        for (const d of r.diffs.content.slice(0, 3)) console.log(`  CONTENT:    ${d}`);
      }
      if (r.diffs.structural.length) {
        for (const d of r.diffs.structural.slice(0, 5)) console.log(`  STRUCTURAL: ${d}`);
        if (r.diffs.structural.length > 5) console.log(`  STRUCTURAL: ... +${r.diffs.structural.length - 5} more`);
      }
      if (r.diffs.whitespace.length) {
        for (const d of r.diffs.whitespace.slice(0, 2)) console.log(`  WHITESPACE: ${d}`);
      }
    }
  }
  if (subset.length > limit) console.log(`\n  ... and ${subset.length - limit} more`);
};

showResults('ERRORS', ['READ_ERROR', 'PARSE_ERROR', 'SERIALIZE_ERROR', 'REPARSE_ERROR']);
showResults('CONTENT DIFFS', ['CONTENT_DIFF']);
showResults('STRUCTURAL DIFFS', ['STRUCTURAL_DIFF'], 20);
showResults('WHITESPACE DIFFS', ['WHITESPACE_DIFF'], 5);

// Aggregate structural diff breakdown
const allStructural = results
  .filter(r => r.diffs && r.diffs.structural.length > 0)
  .flatMap(r => r.diffs.structural);

if (allStructural.length > 0) {
  // Group by tag name
  const tagCounts = Object.create(null);
  for (const msg of allStructural) {
    const m = msg.match(/^<([A-Z]+)>/);
    if (m) tagCounts[m[1]] = (tagCounts[m[1]] || 0) + 1;
  }
  const sorted = Object.entries(tagCounts).sort((a, b) => b[1] - a[1]);
  if (sorted.length > 0) {
    console.log('\n--- STRUCTURAL DIFF: TOP TAGS ---');
    for (const [tag, cnt] of sorted.slice(0, 15)) {
      console.log(`  <${tag}> : ${cnt} file(s)`);
    }
  }
}

// ── write JSON output ─────────────────────────────────────────────────────────

const outputDir = 'test-results';
if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

const outputPath = path.join(outputDir, 'interop-scan.json');

const summary = {
  timestamp: new Date().toISOString(),
  totalFiles: files.length,
  clean,
  whitespaceOnly,
  structuralDiff,
  contentDiff,
  empty,
  errors,
};

fs.writeFileSync(outputPath, JSON.stringify({ summary, results }, null, 2), 'utf8');
console.log(`\nJSON results written to: ${outputPath}`);
