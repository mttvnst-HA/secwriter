#!/usr/bin/env node
/**
 * Corpus Extraction Script (Phase 1.1-1.2)
 *
 * Parses .SEC files from reference/UFGS_M/ into calibration corpus JSON.
 * Uses the existing sec-parser.js with linkedom DOMParser polyfill.
 *
 * Usage:
 *   node tools/extract-corpus.mjs
 *   node tools/extract-corpus.mjs --sections "03 30 00,22 00 00"
 *   node tools/extract-corpus.mjs --all   # Process all 690 sections
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseHTML } from 'linkedom';

// Polyfill DOMParser for Node.js (sec-parser.js uses browser DOMParser)
const { DOMParser } = parseHTML('');
globalThis.DOMParser = DOMParser;

// Now import the parser (after DOMParser is available)
const { parseSEC } = await import('../src/lib/sec-parser.js');

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');
const SEC_DIR = join(PROJECT_ROOT, 'reference', 'UFGS_M');
const OUTPUT_DIR = join(PROJECT_ROOT, 'corpus', 'calibration');

// Default 5 target sections (per testing plan selection criteria)
const DEFAULT_SECTIONS = [
  '03 30 00',
  '22 00 00',
  '26 20 00',
  '32 12 16.16',
  '33 71 02',
];

// Block types that contain prose (testable text)
const PROSE_BLOCK_TYPES = new Set(['txt', 'note', 'oli', 'item', 'lst', 'npr', 'sbm']);

// Min character count for testable blocks (Step 1.2 filter)
const MIN_CHARS = 20;

/**
 * Strip <span class="mark-met">...</span> content (MET units).
 * Unwrap <span class="mark-eng">...</span> to just inner text (ENG units).
 * This resolves ENG/MET dual-unit display to ENG-only (imperial).
 */
function resolveEngMet(html) {
  // Remove MET spans entirely (including nested content)
  let result = html.replace(/<span class="mark-met"[^>]*>.*?<\/span>/gs, '');
  // Unwrap ENG spans (keep inner content, remove wrapper)
  result = result.replace(/<span class="mark-eng"[^>]*>(.*?)<\/span>/gs, '$1');
  return result;
}

/**
 * Strip all remaining HTML/SGML tags but preserve text content.
 * Preserves bracket content [like this].
 */
function stripTags(html) {
  return html
    .replace(/<[^>]+>/g, '')       // Remove all HTML tags
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')          // Collapse whitespace
    .trim();
}

/**
 * Check if a block's text is entirely bracketed content [...]
 */
function isEntirelyBracketed(text) {
  return /^\s*\[.*\]\s*$/s.test(text);
}

/**
 * Check if text is purely a reference citation (short, mostly org/standard names)
 */
function isPureCitation(text) {
  // Very short text that's just an org abbreviation + standard number
  if (text.length < 40 && /^[A-Z]{2,}[\s-]+[A-Z0-9/.]+$/i.test(text.trim())) return true;
  return false;
}

/**
 * Find the nearest preceding title block to use as heading context
 */
function findHeading(blocks, index) {
  for (let i = index - 1; i >= 0; i--) {
    if (blocks[i].type === 'title') {
      return stripTags(blocks[i].html);
    }
  }
  return '';
}

/**
 * Convert section number to filename-safe format
 * "03 30 00" -> "03_30_00", "32 12 16.16" -> "32_12_16_16"
 */
function sectionToFilebase(section) {
  return section.replace(/\s+/g, '_').replace(/\./g, '_');
}

/**
 * Find the .SEC file for a given section number.
 * Handles variations: "03 30 00.SEC", "03 30 00.sec"
 */
function findSecFile(sectionNum) {
  const files = readdirSync(SEC_DIR);
  const target = sectionNum + '.SEC';
  const targetLower = target.toLowerCase();
  const found = files.find(f => f.toLowerCase() === targetLower);
  if (!found) {
    // Try with different separator patterns
    const altTarget = sectionNum.replace(/\./g, ' ') + '.SEC';
    const altLower = altTarget.toLowerCase();
    const altFound = files.find(f => f.toLowerCase() === altLower);
    return altFound ? join(SEC_DIR, altFound) : null;
  }
  return join(SEC_DIR, found);
}

/**
 * Process a single .SEC file into calibration corpus blocks.
 */
function processSection(sectionNum) {
  const filePath = findSecFile(sectionNum);
  if (!filePath) {
    console.error(`  ERROR: .SEC file not found for section "${sectionNum}"`);
    return null;
  }

  console.log(`  Parsing ${basename(filePath)}...`);

  // Read with windows-1252 encoding
  const raw = readFileSync(filePath);
  const decoder = new TextDecoder('windows-1252');
  const xmlString = decoder.decode(raw);

  // Parse with sec-parser
  let blocks;
  try {
    blocks = parseSEC(xmlString);
  } catch (err) {
    console.error(`  ERROR parsing ${basename(filePath)}: ${err.message}`);
    return null;
  }

  console.log(`  Parsed ${blocks.length} total blocks`);

  // Extract prose blocks
  const corpusBlocks = [];
  let blockIndex = 0;

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];

    // Only prose-bearing block types
    if (!PROSE_BLOCK_TYPES.has(block.type)) continue;

    // Skip table blocks
    if (block.table) continue;

    const html = block.html || '';
    if (!html) continue;

    blockIndex++;

    // Resolve ENG/MET to ENG-only
    const resolved = resolveEngMet(html);

    // Strip all remaining tags to plain text
    const text = stripTags(resolved);

    if (!text) continue;

    const isNote = block.type === 'note';
    const heading = findHeading(blocks, i);
    const id = `${sectionToFilebase(sectionNum)}-P${block.part || 0}-B${blockIndex}`;

    corpusBlocks.push({
      id,
      section: sectionNum,
      part: block.part || 0,
      heading,
      blockType: block.type,
      isNote,
      text,
      charCount: text.length,
    });
  }

  console.log(`  Extracted ${corpusBlocks.length} prose blocks`);

  // Apply Step 1.2 filters
  const filtered = corpusBlocks.filter(b => {
    // Keep note blocks regardless (tagged with isNote for engine exemption testing)
    if (b.isNote) return true;
    // Filter out short blocks
    if (b.charCount < MIN_CHARS) return false;
    // Filter out purely bracketed content
    if (isEntirelyBracketed(b.text)) return false;
    // Filter out pure citations
    if (isPureCitation(b.text)) return false;
    return true;
  });

  const removed = corpusBlocks.length - filtered.length;
  console.log(`  After filtering: ${filtered.length} testable blocks (removed ${removed})`);

  return filtered;
}

// --- Main ---

function main() {
  const args = process.argv.slice(2);
  let sections = DEFAULT_SECTIONS;

  if (args.includes('--all')) {
    // Process all .SEC files in the directory
    const files = readdirSync(SEC_DIR).filter(f => f.toUpperCase().endsWith('.SEC'));
    sections = files.map(f => f.replace(/\.SEC$/i, ''));
    console.log(`Processing all ${sections.length} sections...`);
  } else if (args.includes('--sections')) {
    const idx = args.indexOf('--sections');
    if (idx + 1 < args.length) {
      sections = args[idx + 1].split(',').map(s => s.trim());
    }
  }

  mkdirSync(OUTPUT_DIR, { recursive: true });

  const allBlocks = [];
  const stats = { sections: 0, totalBlocks: 0, noteBlocks: 0, errors: [] };

  console.log(`\nExtracting calibration corpus from ${sections.length} sections...\n`);

  for (const section of sections) {
    console.log(`[${section}]`);
    const blocks = processSection(section);
    if (!blocks) {
      stats.errors.push(section);
      continue;
    }

    stats.sections++;
    stats.totalBlocks += blocks.length;
    stats.noteBlocks += blocks.filter(b => b.isNote).length;

    // Write per-section file
    const outFile = join(OUTPUT_DIR, `${sectionToFilebase(section)}.json`);
    writeFileSync(outFile, JSON.stringify(blocks, null, 2));
    console.log(`  -> ${outFile}\n`);

    allBlocks.push(...blocks);
  }

  // Write combined file
  const combinedFile = join(OUTPUT_DIR, 'all_calibration.json');
  writeFileSync(combinedFile, JSON.stringify(allBlocks, null, 2));

  // Summary
  console.log('='.repeat(60));
  console.log('Calibration Corpus Summary');
  console.log('='.repeat(60));
  console.log(`Sections processed: ${stats.sections}`);
  console.log(`Total testable blocks: ${stats.totalBlocks}`);
  console.log(`  Non-note blocks: ${stats.totalBlocks - stats.noteBlocks}`);
  console.log(`  Note blocks: ${stats.noteBlocks}`);
  if (stats.errors.length > 0) {
    console.log(`Errors: ${stats.errors.join(', ')}`);
  }
  console.log(`\nCombined output: ${combinedFile}`);

  // Block type breakdown
  const typeCounts = {};
  for (const b of allBlocks) {
    typeCounts[b.blockType] = (typeCounts[b.blockType] || 0) + 1;
  }
  console.log('\nBlock type breakdown:');
  for (const [type, count] of Object.entries(typeCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${type}: ${count}`);
  }

  // Section breakdown
  console.log('\nPer-section breakdown:');
  const sectionCounts = {};
  for (const b of allBlocks) {
    sectionCounts[b.section] = (sectionCounts[b.section] || 0) + 1;
  }
  for (const [section, count] of Object.entries(sectionCounts)) {
    const notes = allBlocks.filter(b => b.section === section && b.isNote).length;
    console.log(`  ${section}: ${count} blocks (${notes} notes)`);
  }
}

main();
