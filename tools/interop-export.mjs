/**
 * Interop Export Script
 *
 * Generates SIM-exported versions of representative .SEC files for SIEditor
 * smoke testing. Each file is parsed through SIM's full pipeline
 * (parseSEC + extractMetadata + serializeSEC) and written to
 * test-results/interop/ with windows-1252 encoding.
 *
 * Usage:
 *   node --import ./tools/json-loader.mjs tools/interop-export.mjs
 *
 * Output: test-results/interop/<filename>_SIM.SEC  (one per input file)
 */

import { parseHTML } from 'linkedom';
// Polyfill DOMParser for Node (required by sec-parser.js and sec-serializer.js)
const { DOMParser } = parseHTML('');
globalThis.DOMParser = DOMParser;

import { parseSEC, extractMetadata } from '../src/lib/sec-parser.js';
import { serializeSEC } from '../src/lib/sec-serializer.js';
import { encodeWindows1252 } from '../src/lib/encoding.js';
import fs from 'fs';
import path from 'path';

// 10 representative .SEC files covering different spec types and edge cases
const TEST_FILES = [
  'reference/31_00_00.SEC',
  'reference/UFGS_M/03 30 00.SEC',
  'reference/UFGS_M/22 00 00.SEC',
  'reference/UFGS_M/26 20 00.SEC',
  'reference/UFGS_M/32 12 16.16.SEC',
  'reference/UFGS_M/32 13 13.43.SEC',
  'reference/UFGS_M/01 33 00.SEC',
  'reference/UFGS_M/33 71 02.SEC',
  'reference/UFGS_M/01 42 00.sec',
  'reference/UFGS_M/40 60 00.SEC',
];

const OUTPUT_DIR = 'test-results/interop';

// Ensure output directory exists
if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  console.log(`Created output directory: ${OUTPUT_DIR}`);
}

console.log(`Exporting ${TEST_FILES.length} .SEC files through SIM pipeline...\n`);

const results = [];

for (const filePath of TEST_FILES) {
  const baseName = path.basename(filePath);
  // Build output filename: "31_00_00.SEC" -> "31_00_00_SIM.SEC"
  const ext = path.extname(baseName);
  const stem = baseName.slice(0, baseName.length - ext.length);
  const outName = `${stem}_SIM${ext.toUpperCase()}`;
  const outPath = path.join(OUTPUT_DIR, outName);

  const entry = { filePath, outPath, outName, status: null, blockCount: 0, error: null };

  // Step 1: Read original as latin1 (windows-1252 superset for reading)
  let xml;
  try {
    xml = fs.readFileSync(filePath, 'latin1');
  } catch (e) {
    entry.status = 'READ_ERROR';
    entry.error = e.message;
    results.push(entry);
    console.error(`  FAIL  ${baseName}: READ_ERROR — ${e.message}`);
    continue;
  }

  // Step 2: Extract metadata (HDR fields: SCN, STL, DTE, etc.)
  let metadata;
  try {
    metadata = extractMetadata(xml);
  } catch (e) {
    entry.status = 'METADATA_ERROR';
    entry.error = e.message;
    results.push(entry);
    console.error(`  FAIL  ${baseName}: METADATA_ERROR — ${e.message}`);
    continue;
  }

  // Step 3: Parse into block array
  let blocks;
  try {
    blocks = parseSEC(xml);
  } catch (e) {
    entry.status = 'PARSE_ERROR';
    entry.error = e.message;
    results.push(entry);
    console.error(`  FAIL  ${baseName}: PARSE_ERROR — ${e.message}`);
    continue;
  }

  entry.blockCount = blocks.length;

  if (blocks.length === 0) {
    entry.status = 'EMPTY';
    entry.error = 'Parser returned 0 blocks';
    results.push(entry);
    console.error(`  FAIL  ${baseName}: EMPTY — parser returned 0 blocks`);
    continue;
  }

  // Step 4: Serialize back to XML string
  let serialized;
  try {
    serialized = serializeSEC(blocks, metadata);
  } catch (e) {
    entry.status = 'SERIALIZE_ERROR';
    entry.error = e.message;
    results.push(entry);
    console.error(`  FAIL  ${baseName}: SERIALIZE_ERROR — ${e.message}`);
    continue;
  }

  // Step 5: Encode as windows-1252 bytes and write to disk
  try {
    const bytes = encodeWindows1252(serialized);
    fs.writeFileSync(outPath, bytes);
  } catch (e) {
    entry.status = 'WRITE_ERROR';
    entry.error = e.message;
    results.push(entry);
    console.error(`  FAIL  ${baseName}: WRITE_ERROR — ${e.message}`);
    continue;
  }

  const outStat = fs.statSync(outPath);
  entry.status = 'OK';
  entry.outputBytes = outStat.size;
  results.push(entry);

  console.log(`  OK    ${baseName}  →  ${outName}  (${blocks.length} blocks, ${outStat.size} bytes)`);
}

// Summary
const ok = results.filter(r => r.status === 'OK').length;
const failed = results.filter(r => r.status !== 'OK').length;

console.log('\n' + '='.repeat(72));
console.log('INTEROP EXPORT SUMMARY');
console.log('='.repeat(72));
console.log(`  Exported: ${ok}/${TEST_FILES.length}`);
if (failed > 0) {
  console.log(`  Failed:   ${failed}`);
  for (const r of results.filter(r => r.status !== 'OK')) {
    console.log(`    ${path.basename(r.filePath)}: ${r.status} — ${r.error}`);
  }
}
console.log(`  Output:   ${path.resolve(OUTPUT_DIR)}`);
console.log('='.repeat(72));

if (ok > 0) {
  console.log('\nExported files:');
  for (const r of results.filter(r => r.status === 'OK')) {
    console.log(`  ${r.outName}`);
  }
}

process.exit(failed > 0 ? 1 : 0);
