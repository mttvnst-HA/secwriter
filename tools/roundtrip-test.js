/**
 * Round-trip integrity test for SEC files.
 *
 * For each .SEC file: parse → serialize → re-parse → compare block arrays.
 * This catches structural losses (blocks dropped, types changed, hierarchy broken).
 *
 * Usage:
 *   node tools/roundtrip-test.js                     # test all files in reference/UFGS_M/
 *   node tools/roundtrip-test.js reference/31_00_00.SEC   # test one file
 */

import { parseHTML } from 'linkedom';
// Polyfill DOMParser for Node
const { DOMParser } = parseHTML('');
globalThis.DOMParser = DOMParser;

import { parseSEC, extractMetadata } from '../src/lib/sec-parser.js';
import { serializeSEC } from '../src/lib/sec-serializer.js';
import fs from 'fs';
import path from 'path';

function compareBlocks(original, roundtripped, label) {
  const issues = [];

  if (original.length !== roundtripped.length) {
    issues.push(`Block count: ${original.length} → ${roundtripped.length} (diff: ${roundtripped.length - original.length})`);
  }

  const len = Math.min(original.length, roundtripped.length);
  let typeMismatches = 0;
  let htmlDiffs = 0;
  let depthDiffs = 0;
  let partDiffs = 0;
  let firstTypeMismatch = null;
  let firstHtmlDiff = null;

  for (let i = 0; i < len; i++) {
    const a = original[i];
    const b = roundtripped[i];

    if (a.type !== b.type) {
      typeMismatches++;
      if (!firstTypeMismatch) {
        firstTypeMismatch = `  block[${i}]: type "${a.type}" → "${b.type}" (html: "${(a.html || '').substring(0, 60)}...")`;
      }
    }

    if (a.part !== b.part) partDiffs++;
    if (a.depth !== b.depth) depthDiffs++;

    // Normalize HTML for comparison (whitespace, entity differences)
    const normA = (a.html || '').replace(/\s+/g, ' ').trim();
    const normB = (b.html || '').replace(/\s+/g, ' ').trim();
    if (normA !== normB) {
      htmlDiffs++;
      if (!firstHtmlDiff) {
        firstHtmlDiff = `  block[${i}] (${a.type}):\n    orig: "${normA.substring(0, 100)}"\n    rt:   "${normB.substring(0, 100)}"`;
      }
    }
  }

  if (typeMismatches) issues.push(`Type mismatches: ${typeMismatches}${firstTypeMismatch ? '\n' + firstTypeMismatch : ''}`);
  if (partDiffs) issues.push(`Part mismatches: ${partDiffs}`);
  if (depthDiffs) issues.push(`Depth mismatches: ${depthDiffs}`);
  if (htmlDiffs) issues.push(`HTML diffs: ${htmlDiffs}${firstHtmlDiff ? '\n' + firstHtmlDiff : ''}`);

  return issues;
}

function testFile(filePath) {
  const name = path.basename(filePath);
  let xml;
  try {
    xml = fs.readFileSync(filePath, 'latin1');  // SEC files use windows-1252
  } catch (e) {
    return { name, status: 'READ_ERROR', error: e.message };
  }

  // Step 1: Parse original
  let blocks1;
  try {
    blocks1 = parseSEC(xml);
  } catch (e) {
    return { name, status: 'PARSE_ERROR', error: e.message };
  }

  if (blocks1.length === 0) {
    return { name, status: 'EMPTY', error: 'Parser returned 0 blocks' };
  }

  // Step 2: Serialize
  let serialized;
  try {
    const meta = extractMetadata(xml);
    serialized = serializeSEC(blocks1, meta);
  } catch (e) {
    return { name, status: 'SERIALIZE_ERROR', error: e.message };
  }

  // Step 3: Re-parse the serialized output
  let blocks2;
  try {
    blocks2 = parseSEC(serialized);
  } catch (e) {
    return { name, status: 'REPARSE_ERROR', error: e.message };
  }

  // Step 4: Compare
  const issues = compareBlocks(blocks1, blocks2, name);

  if (issues.length === 0) {
    return { name, status: 'PASS', blockCount: blocks1.length };
  } else {
    return { name, status: 'DIFF', blockCount: blocks1.length, issues };
  }
}

// --- Main ---
const args = process.argv.slice(2);
let files;

if (args.length > 0) {
  files = args;
} else {
  const dir = 'reference/UFGS_M';
  files = fs.readdirSync(dir)
    .filter(f => f.toLowerCase().endsWith('.sec'))
    .map(f => path.join(dir, f));
  // Also include the main sample
  files.unshift('reference/31_00_00.SEC');
}

console.log(`Testing ${files.length} SEC files for round-trip integrity...\n`);

let pass = 0, diff = 0, errors = 0, empty = 0;
const diffResults = [];
const errorResults = [];

for (const f of files) {
  const result = testFile(f);

  if (result.status === 'PASS') {
    pass++;
  } else if (result.status === 'DIFF') {
    diff++;
    diffResults.push(result);
  } else if (result.status === 'EMPTY') {
    empty++;
  } else {
    errors++;
    errorResults.push(result);
  }
}

// Summary
console.log('='.repeat(70));
console.log(`ROUND-TRIP TEST RESULTS`);
console.log('='.repeat(70));
console.log(`  PASS:   ${pass}`);
console.log(`  DIFF:   ${diff}`);
console.log(`  ERROR:  ${errors}`);
console.log(`  EMPTY:  ${empty}`);
console.log(`  TOTAL:  ${files.length}`);
console.log('='.repeat(70));

if (errorResults.length > 0) {
  console.log(`\n--- ERRORS (${errorResults.length}) ---`);
  for (const r of errorResults.slice(0, 10)) {
    console.log(`\n${r.name}: ${r.status}`);
    console.log(`  ${r.error}`);
  }
  if (errorResults.length > 10) console.log(`  ... and ${errorResults.length - 10} more`);
}

if (diffResults.length > 0) {
  console.log(`\n--- DIFFS (${diffResults.length}) ---`);
  for (const r of diffResults.slice(0, 20)) {
    console.log(`\n${r.name} (${r.blockCount} blocks):`);
    for (const issue of r.issues) {
      console.log(`  ${issue}`);
    }
  }
  if (diffResults.length > 20) console.log(`  ... and ${diffResults.length - 20} more`);
}

// Categorize diff types for analysis
if (diffResults.length > 0) {
  console.log(`\n--- DIFF CATEGORY SUMMARY ---`);
  let countOnly = 0, typeOnly = 0, htmlOnly = 0, depthOnly = 0, mixed = 0;
  for (const r of diffResults) {
    const cats = new Set(r.issues.map(i => i.split(':')[0].trim()));
    if (cats.size === 1) {
      const cat = [...cats][0];
      if (cat.startsWith('Block count')) countOnly++;
      else if (cat.startsWith('Type')) typeOnly++;
      else if (cat.startsWith('HTML')) htmlOnly++;
      else if (cat.startsWith('Depth')) depthOnly++;
      else mixed++;
    } else {
      mixed++;
    }
  }
  console.log(`  Block count only: ${countOnly}`);
  console.log(`  Type only: ${typeOnly}`);
  console.log(`  HTML only: ${htmlOnly}`);
  console.log(`  Depth only: ${depthOnly}`);
  console.log(`  Mixed/multiple: ${mixed}`);
}
