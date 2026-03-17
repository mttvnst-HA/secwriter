/**
 * Diagnose HTML diff issues in SEC round-trip.
 *
 * Parses a SEC file, serializes, re-parses, and shows exact character-level
 * differences in HTML content between original and round-tripped blocks.
 */

import { parseHTML } from 'linkedom';
const { DOMParser } = parseHTML('');
globalThis.DOMParser = DOMParser;

import { parseSEC } from '../src/lib/sec-parser.js';
import { serializeSEC } from '../src/lib/sec-serializer.js';
import fs from 'fs';

const filePath = process.argv[2] || 'reference/UFGS_M/01 30 00.SEC';
console.log(`=== HTML DIAGNOSIS: ${filePath} ===\n`);

const xml = fs.readFileSync(filePath, 'latin1');

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

// Step 1: Parse original
const blocks1 = parseSEC(xml);
console.log(`Original: ${blocks1.length} blocks`);

// Step 2: Serialize
const meta = extractMeta(xml);
const serialized = serializeSEC(blocks1, meta);

// Step 3: Re-parse
const blocks2 = parseSEC(serialized);
console.log(`Round-tripped: ${blocks2.length} blocks`);

// Step 4: Find all HTML diffs
const len = Math.min(blocks1.length, blocks2.length);
let diffCount = 0;

for (let i = 0; i < len; i++) {
  const a = blocks1[i];
  const b = blocks2[i];

  const normA = (a.html || '').replace(/\s+/g, ' ').trim();
  const normB = (b.html || '').replace(/\s+/g, ' ').trim();

  if (normA !== normB) {
    diffCount++;
    console.log(`\n${'='.repeat(70)}`);
    console.log(`DIFF at block[${i}] type="${a.type}" part=${a.part} depth=${a.depth}`);
    console.log(`${'='.repeat(70)}`);
    console.log(`\nORIGINAL HTML (${normA.length} chars):`);
    console.log(normA);
    console.log(`\nROUND-TRIP HTML (${normB.length} chars):`);
    console.log(normB);

    // Character-level diff
    console.log(`\nCHARACTER-LEVEL DIFF:`);
    const maxLen = Math.max(normA.length, normB.length);
    let firstDiffPos = -1;
    for (let j = 0; j < maxLen; j++) {
      if (normA[j] !== normB[j]) {
        firstDiffPos = j;
        break;
      }
    }

    if (firstDiffPos >= 0) {
      const contextStart = Math.max(0, firstDiffPos - 40);
      const contextEnd = Math.min(maxLen, firstDiffPos + 40);
      console.log(`  First difference at position ${firstDiffPos}:`);
      console.log(`  orig: ...${normA.substring(contextStart, contextEnd)}...`);
      console.log(`  rt:   ...${normB.substring(contextStart, contextEnd)}...`);
      console.log(`  orig char: ${normA[firstDiffPos] ? `'${normA[firstDiffPos]}' (U+${normA.charCodeAt(firstDiffPos).toString(16).padStart(4, '0')})` : 'END'}`);
      console.log(`  rt   char: ${normB[firstDiffPos] ? `'${normB[firstDiffPos]}' (U+${normB.charCodeAt(firstDiffPos).toString(16).padStart(4, '0')})` : 'END'}`);

      // Count total differing chars
      let totalDiffs = 0;
      for (let j = 0; j < maxLen; j++) {
        if (normA[j] !== normB[j]) totalDiffs++;
      }
      console.log(`  Total differing positions: ${totalDiffs}`);
    }

    // Also show the raw (non-normalized) versions
    console.log(`\nRAW ORIGINAL (${(a.html || '').length} chars):`);
    console.log(JSON.stringify(a.html));
    console.log(`\nRAW ROUND-TRIP (${(b.html || '').length} chars):`);
    console.log(JSON.stringify(b.html));
  }
}

console.log(`\n\nTotal HTML diffs: ${diffCount}`);

// Also check the serialized SGML around the problematic block
if (diffCount > 0) {
  console.log(`\n--- RELEVANT SERIALIZED SGML ---`);
  // Find the first diff block index
  for (let i = 0; i < len; i++) {
    const normA = (blocks1[i].html || '').replace(/\s+/g, ' ').trim();
    const normB = (blocks2[i].html || '').replace(/\s+/g, ' ').trim();
    if (normA !== normB) {
      // Find corresponding SGML in serialized output
      const htmlSnip = (blocks1[i].html || '').substring(0, 30);
      console.log(`\nSearching serialized output for block[${i}] text starting with: "${htmlSnip}"`);

      // Search for matching line
      const lines = serialized.split('\n');
      for (let j = 0; j < lines.length; j++) {
        if (lines[j].includes(htmlSnip.substring(0, 20).replace(/<[^>]+>/g, ''))) {
          const start = Math.max(0, j - 2);
          const end = Math.min(lines.length, j + 3);
          for (let k = start; k < end; k++) {
            console.log(`  line ${k + 1}: ${lines[k]}`);
          }
        }
      }
      break;  // Only show first diff
    }
  }
}
