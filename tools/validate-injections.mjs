#!/usr/bin/env node
/**
 * Injection Validator (Phase 3.3)
 *
 * Validates dirty corpus injections: verifies each violation's match text
 * is present, computes character offsets, and checks for collateral damage.
 *
 * Usage:
 *   node tools/validate-injections.mjs --section 03_30_00
 *   node tools/validate-injections.mjs --all
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');
const DIRTY_DIR = join(PROJECT_ROOT, 'corpus', 'dirty');
const RESULTS_DIR = join(PROJECT_ROOT, 'corpus', 'results');

const args = process.argv.slice(2);
const processAll = args.includes('--all');
const singleSection = args.includes('--section') ? args[args.indexOf('--section') + 1] : null;

if (!processAll && !singleSection) {
  console.error('Usage: node tools/validate-injections.mjs --section <name> | --all');
  process.exit(1);
}

/**
 * Simple word-level diff to find changes between clean and dirty text.
 */
function wordDiff(clean, dirty) {
  const cleanWords = clean.split(/(\s+)/);
  const dirtyWords = dirty.split(/(\s+)/);
  const changes = [];

  let ci = 0, di = 0;
  while (ci < cleanWords.length && di < dirtyWords.length) {
    if (cleanWords[ci] === dirtyWords[di]) {
      ci++;
      di++;
    } else {
      changes.push({
        cleanWord: cleanWords[ci],
        dirtyWord: dirtyWords[di],
        position: ci,
      });
      ci++;
      di++;
    }
  }

  // Handle length differences
  while (di < dirtyWords.length) {
    changes.push({ cleanWord: null, dirtyWord: dirtyWords[di++], position: ci });
  }
  while (ci < cleanWords.length) {
    changes.push({ cleanWord: cleanWords[ci++], dirtyWord: null, position: ci });
  }

  return changes;
}

function validateSection(sectionName) {
  const dirtyFile = join(DIRTY_DIR, `${sectionName}_dirty.json`);
  if (!existsSync(dirtyFile)) {
    console.error(`Dirty corpus not found: ${dirtyFile}`);
    return null;
  }

  const dirtyBlocks = JSON.parse(readFileSync(dirtyFile, 'utf-8'));
  console.log(`\n[${sectionName}] Validating ${dirtyBlocks.length} injected blocks...`);

  const validated = [];
  const failures = [];
  let skipped = 0;

  for (const block of dirtyBlocks) {
    const errors = [];

    if (!block.clean || !block.dirty) {
      errors.push('Missing clean or dirty text');
    }

    if (!block.violations || block.violations.length === 0) {
      // If clean === dirty, Opus couldn't inject — skip (not a failure)
      if (block.clean === block.dirty) {
        skipped++;
        continue;
      }
      errors.push('No violations declared but text was changed');
    }

    // Check each violation
    for (const v of (block.violations || [])) {
      // Verify match text exists in dirty text
      const matchIdx = block.dirty?.indexOf(v.match);
      if (matchIdx === -1 || matchIdx === undefined) {
        errors.push(`Match text "${v.match}" not found in dirty text`);
      } else {
        // Compute character offset
        v.charOffset = matchIdx;
      }

      // Verify rule ID consistency — match text should contain the expected violation
      const ruleChecks = {
        'TERM-001': m => /shall/i.test(m),
        'TERM-002': m => /should/i.test(m),
        'TERM-004': m => /\bper\b/i.test(m),
        'TERM-006': m => /\bany\b/i.test(m),
        'TERM-010': m => /and\/or/i.test(m),
        'TERM-013': m => /\bis to be\b|\bare to be\b/i.test(m),
        'TERM-028': m => /etc\./i.test(m),
        'TERM-032': m => /conforming to/i.test(m),
        'TERM-017': m => /as necessary|as required/i.test(m),
        'TERM-023': m => /securely/i.test(m),
        'TERM-024': m => /thoroughly/i.test(m),
        'TERM-025': m => /carefully/i.test(m),
        'VAGUE-001': m => /suitable/i.test(m),
        'VAGUE-002': m => /adequate/i.test(m),
        'VAGUE-003': m => /proper/i.test(m),
        'COLLOQ-furnish': m => /furnish/i.test(m),
        'CAP-Contract': m => /\bcontract\b/.test(m),  // lowercase
        'CAP-Contractor': m => /\bcontractor\b/.test(m),
        'CAP-Government': m => /\bgovernment\b/.test(m),
        'FMT-002': m => /\u2014/.test(m),  // em-dash
        'FMT-003': m => /[\u201c\u201d\u2018\u2019]/.test(m),  // curly quotes
        'SYM-001': m => /%/.test(m),
        'SYM-002': m => /#/.test(m),
        'SYM-013': m => /&/.test(m),
      };
      const check = ruleChecks[v.ruleId];
      if (check && !check(v.match || '')) {
        errors.push(`${v.ruleId} violation match doesn't contain expected pattern: "${v.match}"`);
      }
    }

    // Check for collateral damage (changes outside the violation)
    if (block.clean && block.dirty && block.clean !== block.dirty) {
      const changes = wordDiff(block.clean, block.dirty);
      // Rule-aware thresholds: sentence-restructuring rules need more latitude
      const ruleIds = (block.violations || []).map(v => v.ruleId);
      const isRestructuring = ruleIds.some(r =>
        r.startsWith('NLP-') || r === 'TERM-001' || r === 'TERM-002' ||
        r === 'TERM-013' || r === 'GRAMMAR-Agreement'
      );
      const threshold = isRestructuring ? 40 : 10;
      if (changes.length > threshold) {
        errors.push(`Excessive changes detected: ${changes.length} word differences (expected ≤${threshold} for ${ruleIds.join(',')})`);
      }
    }

    if (errors.length > 0) {
      failures.push({ id: block.id, errors });
      console.log(`  FAIL: ${block.id} — ${errors[0]}`);
    } else {
      validated.push(block);
    }
  }

  console.log(`  Validated: ${validated.length}, Skipped (no injection): ${skipped}, Failed: ${failures.length} / ${dirtyBlocks.length} total`);

  return { validated, failures, skipped };
}

function main() {
  mkdirSync(RESULTS_DIR, { recursive: true });

  const sections = processAll
    ? ['03_30_00', '22_00_00', '26_20_00', '32_12_16_16', '33_71_02']
    : [singleSection];

  const allValidated = [];
  const allFailures = [];
  let totalSkipped = 0;

  for (const section of sections) {
    const result = validateSection(section);
    if (!result) continue;

    allValidated.push(...result.validated);
    allFailures.push(...result.failures);
    totalSkipped += result.skipped;

    // Write validated dirty corpus (with computed offsets)
    const outFile = join(DIRTY_DIR, `${section}_dirty_validated.json`);
    writeFileSync(outFile, JSON.stringify(result.validated, null, 2));
  }

  // Write failures log
  if (allFailures.length > 0) {
    const failFile = join(RESULTS_DIR, 'injection-failures.json');
    writeFileSync(failFile, JSON.stringify(allFailures, null, 2));
    console.log(`\nFailures log: ${failFile}`);
  }

  // Write combined validated dirty corpus
  if (allValidated.length > 0) {
    const combinedFile = join(DIRTY_DIR, 'all_dirty.json');
    writeFileSync(combinedFile, JSON.stringify(allValidated, null, 2));
    console.log(`Combined validated dirty corpus: ${combinedFile} (${allValidated.length} blocks)`);
  }

  console.log(`\nSummary: ${allValidated.length} valid, ${totalSkipped} skipped (no injection), ${allFailures.length} failed`);

  // Violation type breakdown for validated blocks
  const typeCounts = {};
  for (const b of allValidated) {
    for (const v of (b.violations || [])) {
      typeCounts[v.ruleId] = (typeCounts[v.ruleId] || 0) + 1;
    }
  }
  console.log('\nValidated violations by rule:');
  for (const [r, c] of Object.entries(typeCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${r}: ${c}`);
  }
}

main();
