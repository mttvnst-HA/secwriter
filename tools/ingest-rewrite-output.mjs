#!/usr/bin/env node
/**
 * Ingest Rewrite Output (Phase 2 — Manual Opus Workflow)
 *
 * Reads Opus response JSON files from corpus/clean/responses/,
 * merges with note blocks (passthrough), and produces the clean corpus.
 *
 * Accepts responses as:
 *   - Individual batch files: {section}_batch-01_response.json
 *   - A single combined file: {section}_all_responses.json
 *   - JSON with or without markdown ```json fencing
 *
 * Usage:
 *   node tools/ingest-rewrite-output.mjs --section 03_30_00
 *   node tools/ingest-rewrite-output.mjs --all
 */

import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');
const CALIBRATION_DIR = join(PROJECT_ROOT, 'corpus', 'calibration');
const RESPONSES_DIR = join(PROJECT_ROOT, 'corpus', 'clean', 'responses');
const CLEAN_DIR = join(PROJECT_ROOT, 'corpus', 'clean');

const args = process.argv.slice(2);
const processAll = args.includes('--all');
const singleSection = args.includes('--section') ? args[args.indexOf('--section') + 1] : null;

if (!processAll && !singleSection) {
  console.error('Usage: node tools/ingest-rewrite-output.mjs --section <name> | --all');
  process.exit(1);
}

/**
 * Parse JSON from file, handling markdown fencing and common formatting issues
 */
function parseResponseFile(filePath) {
  let content = readFileSync(filePath, 'utf-8').trim();

  // Strip markdown code fencing
  if (content.startsWith('```')) {
    content = content.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?\s*```$/, '');
  }

  // Handle potential BOM
  if (content.charCodeAt(0) === 0xFEFF) {
    content = content.slice(1);
  }

  try {
    return JSON.parse(content);
  } catch (e) {
    console.error(`  Failed to parse ${filePath}: ${e.message}`);
    // Try to extract JSON array from surrounding text
    const match = content.match(/\[[\s\S]*\]/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch (e2) {
        console.error(`  Also failed to extract JSON array: ${e2.message}`);
      }
    }
    return null;
  }
}

function processSection(sectionName) {
  const calibrationFile = join(CALIBRATION_DIR, `${sectionName}.json`);
  if (!existsSync(calibrationFile)) {
    console.error(`Calibration file not found: ${calibrationFile}`);
    return null;
  }

  const allBlocks = JSON.parse(readFileSync(calibrationFile, 'utf-8'));
  const noteBlocks = allBlocks.filter(b => b.isNote);
  const nonNoteBlocks = allBlocks.filter(b => !b.isNote);

  console.log(`\n[${sectionName}] ${nonNoteBlocks.length} non-note, ${noteBlocks.length} note blocks`);

  // Find response files
  mkdirSync(RESPONSES_DIR, { recursive: true });

  const responseFiles = readdirSync(RESPONSES_DIR)
    .filter(f => f.startsWith(sectionName) && f.endsWith('.json'))
    .sort();

  if (responseFiles.length === 0) {
    console.error(`  No response files found in ${RESPONSES_DIR}`);
    console.error(`  Expected files like: ${sectionName}_batch-01_response.json`);
    return null;
  }

  console.log(`  Found ${responseFiles.length} response files`);

  // Merge all responses
  const allResponses = [];
  for (const file of responseFiles) {
    const parsed = parseResponseFile(join(RESPONSES_DIR, file));
    if (parsed && Array.isArray(parsed)) {
      allResponses.push(...parsed);
      console.log(`  ${file}: ${parsed.length} blocks`);
    }
  }

  console.log(`  Total responses: ${allResponses.length}/${nonNoteBlocks.length} expected`);

  if (allResponses.length < nonNoteBlocks.length) {
    console.warn(`  WARNING: Missing ${nonNoteBlocks.length - allResponses.length} block responses`);
  }

  // Build clean corpus
  const responseMap = new Map(allResponses.map(r => [r.id, r]));
  const cleanBlocks = [];
  let rewritten = 0, unchanged = 0, missing = 0;

  for (const block of allBlocks) {
    if (block.isNote) {
      // Note blocks pass through unchanged
      cleanBlocks.push({
        ...block,
        originalText: block.text,
        changes: [],
      });
      continue;
    }

    const response = responseMap.get(block.id);
    if (!response) {
      // Missing response — keep original
      cleanBlocks.push({
        ...block,
        originalText: block.text,
        changes: [],
        _missing: true,
      });
      missing++;
      continue;
    }

    const hasChanges = response.changes && response.changes.length > 0;
    cleanBlocks.push({
      ...block,
      text: response.rewritten || response.original || block.text,
      originalText: block.text,
      changes: response.changes || [],
    });

    if (hasChanges) rewritten++;
    else unchanged++;
  }

  // Write clean corpus
  const outputFile = join(CLEAN_DIR, `${sectionName}_clean.json`);
  writeFileSync(outputFile, JSON.stringify(cleanBlocks, null, 2));

  console.log(`  Output: ${outputFile}`);
  console.log(`  Rewritten: ${rewritten}, Unchanged: ${unchanged}, Missing: ${missing}`);

  return cleanBlocks;
}

// Main
const sections = processAll
  ? ['03_30_00', '22_00_00', '26_20_00', '32_12_16_16', '33_71_02']
  : [singleSection];

mkdirSync(CLEAN_DIR, { recursive: true });
mkdirSync(RESPONSES_DIR, { recursive: true });

const allClean = [];
for (const section of sections) {
  const result = processSection(section);
  if (result) allClean.push(...result);
}

if (allClean.length > 0) {
  const combinedFile = join(CLEAN_DIR, 'all_clean.json');
  writeFileSync(combinedFile, JSON.stringify(allClean, null, 2));
  console.log(`\nCombined: ${combinedFile} (${allClean.length} blocks)`);

  const changed = allClean.filter(b => b.changes?.length > 0);
  console.log(`Total: ${changed.length} rewritten, ${allClean.length - changed.length} unchanged`);
}
