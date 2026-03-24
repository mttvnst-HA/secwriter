#!/usr/bin/env node
/**
 * Generate Injection Prompts (Phase 3 — Manual Opus Workflow)
 *
 * Creates numbered prompt files for violation injection into clean corpus.
 * Each prompt specifies which violation type to inject into which blocks.
 *
 * Usage:
 *   node tools/generate-inject-prompts.mjs --section 03_30_00
 *   node tools/generate-inject-prompts.mjs --all
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');
const CLEAN_DIR = join(PROJECT_ROOT, 'corpus', 'clean');
const PROMPTS_DIR = join(PROJECT_ROOT, 'corpus', 'prompts', 'inject');

const args = process.argv.slice(2);
const processAll = args.includes('--all');
const singleSection = args.includes('--section') ? args[args.indexOf('--section') + 1] : null;
const batchSize = args.includes('--batch-size') ? parseInt(args[args.indexOf('--batch-size') + 1]) : 20;

if (!processAll && !singleSection) {
  console.error('Usage: node tools/generate-inject-prompts.mjs --section <name> | --all');
  process.exit(1);
}

// Violation types and their injection counts per section
// Counts are per-section (total across all sections will be 5x these)
const INJECTION_PLAN = [
  { ruleId: 'TERM-001', count: 6, method: 'Insert "shall" before imperative verbs: "Provide" -> "shall provide" or "The Contractor shall provide"' },
  { ruleId: 'TERM-004', count: 3, method: 'Replace "in accordance with" with "per"' },
  { ruleId: 'TERM-006', count: 3, method: 'Insert "any" before nouns: "materials" -> "any materials"' },
  { ruleId: 'VAGUE-003', count: 2, method: 'Insert "suitable" or "properly" before nouns/verbs' },
  { ruleId: 'TERM-028', count: 2, method: 'Append "etc." to list items' },
  { ruleId: 'COLLOQ-furnish', count: 2, method: 'Replace "provide" with "furnish"' },
  { ruleId: 'CAP-Contract', count: 3, method: 'Lowercase "Contract" to "contract" mid-sentence' },
  { ruleId: 'CAP-Contractor', count: 3, method: 'Lowercase "Contractor" to "contractor"' },
  { ruleId: 'CAP-Government', count: 2, method: 'Lowercase "Government" to "government"' },
  { ruleId: 'FMT-002', count: 2, method: 'Replace hyphens with em-dashes (—, U+2014)' },
  { ruleId: 'FMT-003', count: 2, method: 'Replace straight quotes with curly quotes (\u201C \u201D)' },
  { ruleId: 'NLP-PASSIVE-001', count: 6, method: 'Convert imperative to passive: "Place materials" -> "Materials are placed" or "Materials shall be placed"' },
  { ruleId: 'NLP-INDICATIVE-001', count: 3, method: 'Convert imperative to indicative: "Provide" -> "The Contractor provides"' },
  { ruleId: 'GRAMMAR-Spelling', count: 4, method: 'Introduce typos: swap adjacent letters, double letters, drop letters' },
  { ruleId: 'GRAMMAR-Agreement', count: 2, method: 'Change verb number: "Materials require" -> "Materials requires"' },
  { ruleId: 'SYM-001', count: 2, method: 'Replace "percent" with "%"' },
  { ruleId: 'SYM-013', count: 2, method: 'Replace "and" with "&"' },
];

const INJECT_SYSTEM = `You are a test data generator for a specification compliance checker. For each clean block below, introduce EXACTLY the specified violation type. Return the corrupted block plus a label identifying the violation.

Rules:
- Introduce ONLY the specified violation type - do not add other errors
- The corrupted block must still be syntactically valid English (not gibberish)
- The violation must be detectable by a regex or NLP tool
- Preserve the rest of the block text exactly (character-for-character)
- Do NOT compute character offsets - just return the match text. Offsets will be computed programmatically.

Return ONLY a valid JSON array with no other text, no markdown fencing:
[{"id":"<id>","clean":"<original>","dirty":"<with violation>","violations":[{"ruleId":"<rule>","match":"<violating text>","description":"<what changed>"}]}]`;

function generateSection(sectionName) {
  const inputFile = join(CLEAN_DIR, `${sectionName}_clean.json`);
  if (!existsSync(inputFile)) {
    console.error(`Clean corpus not found: ${inputFile}`);
    console.error('Run rewrite workflow first (generate-rewrite-prompts.mjs -> Claude -> ingest-rewrite-output.mjs)');
    return;
  }

  const cleanBlocks = JSON.parse(readFileSync(inputFile, 'utf-8'));
  const eligible = cleanBlocks.filter(b => !b.isNote && b.charCount >= 40);

  console.log(`[${sectionName}] ${eligible.length} eligible blocks`);

  // Assign violations to blocks
  const assignments = [];
  let blockIdx = 0;

  for (const rule of INJECTION_PLAN) {
    for (let i = 0; i < rule.count && blockIdx < eligible.length; i++) {
      const block = eligible[blockIdx % eligible.length];
      assignments.push({
        id: block.id,
        text: block.text,
        ruleId: rule.ruleId,
        method: rule.method,
      });
      blockIdx++;
    }
  }

  console.log(`  ${assignments.length} violations assigned`);

  // Generate prompt files in batches
  const sectionDir = join(PROMPTS_DIR, sectionName);
  mkdirSync(sectionDir, { recursive: true });

  const totalBatches = Math.ceil(assignments.length / batchSize);

  for (let i = 0; i < totalBatches; i++) {
    const batch = assignments.slice(i * batchSize, (i + 1) * batchSize);
    const batchInput = batch.map(a => ({
      id: a.id,
      text: a.text,
      violationType: a.ruleId,
      instruction: a.method,
    }));

    const promptContent = [
      INJECT_SYSTEM,
      '',
      `--- BATCH ${i + 1}/${totalBatches} — Section ${sectionName} (${batch.length} injections) ---`,
      '',
      JSON.stringify(batchInput, null, 2),
    ].join('\n');

    const filename = `batch-${String(i + 1).padStart(2, '0')}.txt`;
    writeFileSync(join(sectionDir, filename), promptContent);
  }

  // Instructions
  const instructions = [
    `# Injection Prompts for Section ${sectionName}`,
    '',
    `Total: ${totalBatches} batch files, ${assignments.length} violations to inject`,
    '',
    '## Instructions',
    '',
    '1. Open each batch-XX.txt file in order',
    '2. Copy the ENTIRE contents and paste into a new Claude chat',
    '3. Claude will return a JSON array with clean + dirty text pairs',
    '4. Save the JSON response to: corpus/dirty/responses/',
    `   Filename: ${sectionName}_batch-XX_response.json`,
    '5. After all batches are done, run:',
    `   node tools/ingest-inject-output.mjs --section ${sectionName}`,
    '6. Then validate:',
    `   node tools/validate-injections.mjs --section ${sectionName}`,
  ].join('\n');

  writeFileSync(join(sectionDir, 'README.txt'), instructions);
  console.log(`  Generated ${totalBatches} prompt files in ${sectionDir}`);
}

// Main
const sections = processAll
  ? ['03_30_00', '22_00_00', '26_20_00', '32_12_16_16', '33_71_02']
  : [singleSection];

for (const section of sections) {
  generateSection(section);
}

console.log(`\nPrompt files ready in ${PROMPTS_DIR}`);
