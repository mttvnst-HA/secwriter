#!/usr/bin/env node
/**
 * Generate Rewrite Prompts (Phase 2 — Manual Opus Workflow)
 *
 * Creates numbered prompt files that Matt can copy-paste into Claude chat.
 * Each file contains the system instructions + a batch of blocks.
 *
 * Usage:
 *   node tools/generate-rewrite-prompts.mjs --section 03_30_00
 *   node tools/generate-rewrite-prompts.mjs --all
 *   node tools/generate-rewrite-prompts.mjs --section 03_30_00 --batch-size 50
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');
const CALIBRATION_DIR = join(PROJECT_ROOT, 'corpus', 'calibration');
const PROMPTS_DIR = join(PROJECT_ROOT, 'corpus', 'prompts', 'rewrite');

const args = process.argv.slice(2);
const processAll = args.includes('--all');
const singleSection = args.includes('--section') ? args[args.indexOf('--section') + 1] : null;
const batchSize = args.includes('--batch-size') ? parseInt(args[args.indexOf('--batch-size') + 1]) : 50;

if (!processAll && !singleSection) {
  console.error('Usage: node tools/generate-rewrite-prompts.mjs --section <name> | --all');
  process.exit(1);
}

const SYSTEM_INSTRUCTIONS = `You are a UFGS specification editor. Rewrite each block of text below to comply with UFS 1-300-02. You must catch ALL violations — a compliance checker will scan your output and flag anything you miss.

## Prohibited Terms (MUST be replaced)
- "shall" -> use imperative mood ("Provide", "Install", "Test")
- "should" -> use imperative mood or remove
- "must" -> use imperative mood ("must be tested" -> "Test")
- "and/or" -> choose "and" or "or" based on meaning, or restructure
- "etc." -> remove or list specific items
- "per" -> "in accordance with" (EXCEPTION: "per" before units like "per hour", "per square foot", "per cubic yard" is acceptable)
- "any" -> use specific language (EXCEPTION: "any of the following", "any one of" are acceptable)
- "conforming to" -> "in accordance with"
- "is to be" / "are to be" -> imperative mood ("is to be tested" -> "Test")
- "furnish" -> "provide"

## Prohibited Vague/Subjective Terms (MUST be replaced with specific criteria or removed)
- "suitable" / "adequate" / "proper" / "properly" -> replace with measurable criteria
- "applicable" -> name the specific standard, code, or requirement; or remove if redundant
- "as necessary" / "as required" / "as needed" -> specify the condition or criteria
- "thoroughly" / "neatly" / "securely" / "carefully" -> replace with specific method or measurable criteria
- "satisfactory" / "acceptable" -> specify the acceptance criteria

## Capitalization (MUST be fixed)
- "Contract" (the construction contract) -> always capitalize (but "contract documents", "subcontract" as compound nouns are lowercase)
- "Contractor" -> always capitalize
- "Contracting Officer" -> always capitalize
- "Government" -> always capitalize

## Voice and Mood
- Convert passive voice to imperative mood ("Materials are placed" -> "Place materials")
- Convert indicative mood to imperative ("The Contractor provides" -> "Provide")
- EXCEPTIONS — keep passive/indicative when:
  (a) Government is the subject ("The Government reserves the right..." — leave as-is)
  (b) Text describes conditions or states, not Contractor actions ("Materials are available in..." — leave as-is)
  (c) Text is example/illustrative (calculations, hypothetical scenarios — leave as-is)

## Other Fixes
- Remove pronouns ("it," "which," "this," "they") - restructure to name the subject explicitly
- Replace em-dashes (—) and en-dashes (–) with hyphens (-)
- Replace smart/curly quotes (" " ' ') with straight quotes (" ')

## Rules
- Do NOT change technical meaning, quantities, tolerances, or reference citations
- Do NOT change content inside [brackets] - these are tailoring choices
- Do NOT add requirements that do not exist in the original
- If a block is already fully compliant, return it unchanged
- Preserve block boundaries (one input block = one output block)
- Do NOT attempt to fix grammar or spelling - only fix UFS 1-300-02 compliance issues
- Engineering terms like "cutting head", "hydrostatic head", "head of pressure" are NOT violations of the "head" rule — leave them unchanged

Return ONLY a valid JSON array with no other text, no markdown fencing:
[{"id":"<id>","original":"<original>","rewritten":"<rewritten>","changes":["description"]}]

If no changes needed, set "rewritten" to same as "original" and "changes" to [].`;

function generateSection(sectionName) {
  const inputFile = join(CALIBRATION_DIR, `${sectionName}.json`);
  if (!existsSync(inputFile)) {
    console.error(`Calibration file not found: ${inputFile}`);
    return;
  }

  const allBlocks = JSON.parse(readFileSync(inputFile, 'utf-8'));
  const nonNoteBlocks = allBlocks.filter(b => !b.isNote);
  const noteBlocks = allBlocks.filter(b => b.isNote);

  console.log(`[${sectionName}] ${nonNoteBlocks.length} non-note blocks, ${noteBlocks.length} note blocks`);

  const sectionDir = join(PROMPTS_DIR, sectionName);
  mkdirSync(sectionDir, { recursive: true });

  const totalBatches = Math.ceil(nonNoteBlocks.length / batchSize);

  for (let i = 0; i < totalBatches; i++) {
    const batch = nonNoteBlocks.slice(i * batchSize, (i + 1) * batchSize);
    const batchInput = batch.map(b => ({ id: b.id, text: b.text }));

    const promptContent = [
      SYSTEM_INSTRUCTIONS,
      '',
      `--- BATCH ${i + 1}/${totalBatches} — Section ${sectionName} (${batch.length} blocks) ---`,
      '',
      JSON.stringify(batchInput, null, 2),
    ].join('\n');

    const filename = `batch-${String(i + 1).padStart(2, '0')}.txt`;
    writeFileSync(join(sectionDir, filename), promptContent);
  }

  // Write a summary/instructions file
  const instructions = [
    `# Rewrite Prompts for Section ${sectionName}`,
    '',
    `Total: ${totalBatches} batch files, ${nonNoteBlocks.length} non-note blocks`,
    `Note blocks: ${noteBlocks.length} (passed through unchanged — do not rewrite)`,
    '',
    '## Instructions',
    '',
    '1. Open each batch-XX.txt file in order',
    '2. Copy the ENTIRE contents and paste into a new Claude chat',
    '3. Claude will return a JSON array',
    '4. Save the JSON response to: corpus/clean/responses/',
    `   Filename: ${sectionName}_batch-XX_response.json`,
    '5. After all batches are done, run:',
    `   node tools/ingest-rewrite-output.mjs --section ${sectionName}`,
    '',
    '## Tips',
    '',
    '- Use Claude Opus for best accuracy',
    '- If Claude wraps the JSON in ```json fencing, the ingest script handles that',
    '- If a batch fails, just re-run that single batch — the ingest script merges all responses',
    '- Review ~20% of rewrites for quality (stratified by change type)',
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
console.log('Next: copy-paste each batch into Claude, save responses, then run ingest script.');
