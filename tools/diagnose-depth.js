/**
 * Diagnose depth mismatch issues in SEC round-trip.
 *
 * Parses a SEC file, serializes it, re-parses, and shows exactly
 * where depth values diverge between original and round-tripped blocks.
 */

import { parseHTML } from 'linkedom';
const { DOMParser } = parseHTML('');
globalThis.DOMParser = DOMParser;

import { parseSEC } from '../src/lib/sec-parser.js';
import { serializeSEC } from '../src/lib/sec-serializer.js';
import fs from 'fs';

const filePath = process.argv[2] || 'reference/UFGS_M/01 14 00.SEC';
console.log(`=== DEPTH DIAGNOSIS: ${filePath} ===\n`);

const xml = fs.readFileSync(filePath, 'latin1');

// Extract metadata (same as roundtrip-test.js)
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

// Write serialized output for inspection
fs.writeFileSync('tools/debug-serialized.sec', serialized);
console.log(`Serialized output written to tools/debug-serialized.sec\n`);

// Step 4: Compare depths
console.log('--- ALL TITLE BLOCKS (original vs round-trip) ---');
console.log(`${'idx'.padStart(4)} ${'type'.padEnd(6)} ${'p'.padStart(2)} ${'d1'.padStart(3)} ${'d2'.padStart(3)} ${'match'.padEnd(5)} html`);
console.log('-'.repeat(100));

const len = Math.min(blocks1.length, blocks2.length);
let depthDiffCount = 0;

for (let i = 0; i < len; i++) {
  const a = blocks1[i];
  const b = blocks2[i];

  const depthMatch = a.depth === b.depth;
  if (!depthMatch) depthDiffCount++;

  // Show all title blocks, and any non-title blocks with depth mismatches
  if (a.type === 'title' || !depthMatch) {
    const marker = depthMatch ? '  OK' : ' <<<';
    const htmlSnip = (a.html || '').substring(0, 70).replace(/<[^>]+>/g, '');
    console.log(`${String(i).padStart(4)} ${a.type.padEnd(6)} ${String(a.part).padStart(2)} ${String(a.depth).padStart(3)} ${String(b.depth).padStart(3)} ${marker}  ${htmlSnip}`);
  }
}

console.log(`\nTotal depth mismatches: ${depthDiffCount}`);

// Now let's look at the serialized XML structure around the problem areas
console.log('\n--- SERIALIZED XML SPT STRUCTURE ---');
const sptLines = serialized.split('\n');
for (let i = 0; i < sptLines.length; i++) {
  const line = sptLines[i].trim();
  if (line.match(/<\/?SPT>|<\/?PRT>|<TTL>/)) {
    console.log(`  line ${String(i + 1).padStart(4)}: ${line}`);
  }
}

// Also check: does the serializer handle depth=0 titles correctly?
// In the parser, PRT children that are not in SPT get depth=0.
// The serializer should NOT wrap depth=0 titles in SPT.
console.log('\n--- DEPTH DISTRIBUTION (original) ---');
const depthCounts = {};
for (const b of blocks1) {
  if (b.type === 'title') {
    depthCounts[b.depth] = (depthCounts[b.depth] || 0) + 1;
  }
}
for (const [d, c] of Object.entries(depthCounts).sort()) {
  console.log(`  depth ${d}: ${c} titles`);
}

// Detailed trace: show what SPT nesting the serializer would produce
console.log('\n--- SERIALIZER SPT TRACE ---');
let openSptDepth = 0;
for (const block of blocks1.filter(b => b.part > 0)) {
  if (block.type === 'title') {
    const targetDepth = block.depth;
    const actions = [];

    // Simulate the serializer logic
    let simDepth = openSptDepth;

    while (simDepth > targetDepth) {
      actions.push(`close SPT (${simDepth} -> ${simDepth - 1})`);
      simDepth--;
    }

    if (targetDepth > 0) {
      if (simDepth === targetDepth) {
        actions.push(`close SPT (${simDepth} -> ${simDepth - 1})`);
        simDepth--;
      }
      actions.push(`open SPT (${simDepth} -> ${simDepth + 1})`);
      simDepth = targetDepth;
    }

    const htmlSnip = (block.html || '').substring(0, 50).replace(/<[^>]+>/g, '');
    console.log(`  title depth=${block.depth} openSpt=${openSptDepth} -> ${simDepth} | ${actions.join(', ') || 'no SPT action'} | "${htmlSnip}"`);
    openSptDepth = simDepth;
  }
}
