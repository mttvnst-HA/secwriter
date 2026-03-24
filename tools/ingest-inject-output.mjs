#!/usr/bin/env node
/**
 * Ingest Injection Output (Phase 3 — Manual Opus Workflow)
 *
 * Reads Opus injection response files from corpus/dirty/responses/
 * and assembles the dirty corpus.
 *
 * Usage:
 *   node tools/ingest-inject-output.mjs --section 03_30_00
 *   node tools/ingest-inject-output.mjs --all
 */

import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');
const RESPONSES_DIR = join(PROJECT_ROOT, 'corpus', 'dirty', 'responses');
const DIRTY_DIR = join(PROJECT_ROOT, 'corpus', 'dirty');

const args = process.argv.slice(2);
const processAll = args.includes('--all');
const singleSection = args.includes('--section') ? args[args.indexOf('--section') + 1] : null;

if (!processAll && !singleSection) {
  console.error('Usage: node tools/ingest-inject-output.mjs --section <name> | --all');
  process.exit(1);
}

function parseResponseFile(filePath) {
  let content = readFileSync(filePath, 'utf-8').trim();
  if (content.startsWith('```')) {
    content = content.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?\s*```$/, '');
  }
  if (content.charCodeAt(0) === 0xFEFF) content = content.slice(1);

  try {
    return JSON.parse(content);
  } catch (e) {
    const match = content.match(/\[[\s\S]*\]/);
    if (match) {
      try { return JSON.parse(match[0]); } catch (e2) {}
    }
    console.error(`  Failed to parse ${filePath}: ${e.message}`);
    return null;
  }
}

function processSection(sectionName) {
  mkdirSync(RESPONSES_DIR, { recursive: true });

  const responseFiles = readdirSync(RESPONSES_DIR)
    .filter(f => f.startsWith(sectionName) && f.endsWith('.json'))
    .sort();

  if (responseFiles.length === 0) {
    console.error(`[${sectionName}] No response files found in ${RESPONSES_DIR}`);
    console.error(`  Expected: ${sectionName}_batch-01_response.json`);
    return null;
  }

  console.log(`[${sectionName}] Found ${responseFiles.length} response files`);

  const allResults = [];
  for (const file of responseFiles) {
    const parsed = parseResponseFile(join(RESPONSES_DIR, file));
    if (parsed && Array.isArray(parsed)) {
      allResults.push(...parsed);
      console.log(`  ${file}: ${parsed.length} blocks`);
    }
  }

  console.log(`  Total: ${allResults.length} injected blocks`);

  const outputFile = join(DIRTY_DIR, `${sectionName}_dirty.json`);
  writeFileSync(outputFile, JSON.stringify(allResults, null, 2));
  console.log(`  Output: ${outputFile}`);

  return allResults;
}

// Main
const sections = processAll
  ? ['03_30_00', '22_00_00', '26_20_00', '32_12_16_16', '33_71_02']
  : [singleSection];

mkdirSync(DIRTY_DIR, { recursive: true });

const allDirty = [];
for (const section of sections) {
  const result = processSection(section);
  if (result) allDirty.push(...result);
}

if (allDirty.length > 0) {
  const combinedFile = join(DIRTY_DIR, 'all_dirty.json');
  writeFileSync(combinedFile, JSON.stringify(allDirty, null, 2));
  console.log(`\nCombined: ${combinedFile} (${allDirty.length} blocks)`);
}

console.log('\nNext: run validation');
console.log('  node tools/validate-injections.mjs --all');
