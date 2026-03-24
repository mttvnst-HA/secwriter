#!/usr/bin/env node
/**
 * Opus Rewrite Script (Phase 2.1-2.2)
 *
 * Sends calibration corpus blocks to Claude Opus for UFS 1-300-02 compliance
 * rewriting. Produces the "known clean" corpus.
 *
 * Requires: ANTHROPIC_API_KEY environment variable
 *
 * Usage:
 *   node tools/opus-rewrite.mjs --section 03_30_00
 *   node tools/opus-rewrite.mjs --all
 *   node tools/opus-rewrite.mjs --section 03_30_00 --batch-size 30
 *   node tools/opus-rewrite.mjs --section 03_30_00 --resume  # Skip already-processed batches
 */

import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');
const CALIBRATION_DIR = join(PROJECT_ROOT, 'corpus', 'calibration');
const CLEAN_DIR = join(PROJECT_ROOT, 'corpus', 'clean');

// --- Config ---
const API_KEY = process.env.ANTHROPIC_API_KEY;
if (!API_KEY) {
  console.error('ERROR: ANTHROPIC_API_KEY environment variable is required.');
  console.error('Ask Matt to provide the API key.');
  process.exit(1);
}

const MODEL = 'claude-opus-4-20250514';
const TEMPERATURE = 0; // Reproducibility
const MAX_TOKENS = 16384; // 50-block batches produce ~15-20K tokens
const BATCH_SIZE = 50; // Match prompt file batch size

const REWRITE_PROMPT = `You are a UFGS specification editor. Rewrite each block of text below to comply with UFS 1-300-02. You must catch ALL violations — a compliance checker will scan your output and flag anything you miss.

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

// --- Parse CLI args ---
const args = process.argv.slice(2);
const processAll = args.includes('--all');
const singleSection = args.includes('--section') ? args[args.indexOf('--section') + 1] : null;
const batchSize = args.includes('--batch-size') ? parseInt(args[args.indexOf('--batch-size') + 1]) : BATCH_SIZE;
const resume = args.includes('--resume');

if (!processAll && !singleSection) {
  console.error('Usage: node tools/opus-rewrite.mjs --section <section_name> | --all');
  console.error('Example: node tools/opus-rewrite.mjs --section 03_30_00');
  process.exit(1);
}

/**
 * Call Anthropic API with retry + exponential backoff
 */
async function callAnthropic(systemPrompt, userMessage, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 300000); // 5 min timeout per batch

      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: MAX_TOKENS,
          temperature: TEMPERATURE,
          system: systemPrompt,
          messages: [{ role: 'user', content: userMessage }],
        }),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!response.ok) {
        const err = await response.text();
        throw new Error(`API error ${response.status}: ${err}`);
      }

      const data = await response.json();
      return {
        text: data.content[0]?.text || '',
        model: data.model,
        usage: data.usage,
      };
    } catch (err) {
      if (attempt < retries) {
        const delay = Math.pow(2, attempt) * 1000; // 2s, 4s, 8s
        console.log(`    Attempt ${attempt} failed (${err.message}), retrying in ${delay / 1000}s...`);
        await new Promise(r => setTimeout(r, delay));
      } else {
        throw err;
      }
    }
  }
}

/**
 * Parse JSON from API response, handling markdown fencing and preamble text
 */
function parseJsonResponse(text) {
  let cleaned = text.trim();
  // Strip markdown code fencing if present
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
  }
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    // Try extracting JSON from between ```json ... ``` fences (Opus sometimes adds preamble)
    const fenceStart = text.indexOf('```json');
    const fenceEnd = text.lastIndexOf('```');
    if (fenceStart >= 0 && fenceEnd > fenceStart) {
      const inner = text.slice(fenceStart + 7, fenceEnd).trim();
      return JSON.parse(inner);
    }
    // Last resort: find balanced [ ... ] array
    const arrStart = text.indexOf('[\n');
    if (arrStart >= 0) {
      let depth = 0, inStr = false, esc = false, end = -1;
      for (let i = arrStart; i < text.length; i++) {
        const ch = text[i];
        if (esc) { esc = false; continue; }
        if (ch === '\\' && inStr) { esc = true; continue; }
        if (ch === '"') { inStr = !inStr; continue; }
        if (inStr) continue;
        if (ch === '[') depth++;
        if (ch === ']') { depth--; if (depth === 0) { end = i; break; } }
      }
      if (end > 0) return JSON.parse(text.slice(arrStart, end + 1));
    }
    throw e;
  }
}

/**
 * Process a single section
 */
async function processSection(sectionName) {
  const inputFile = join(CALIBRATION_DIR, `${sectionName}.json`);
  if (!existsSync(inputFile)) {
    console.error(`Calibration file not found: ${inputFile}`);
    return null;
  }

  const allBlocks = JSON.parse(readFileSync(inputFile, 'utf-8'));
  console.log(`\n[${sectionName}] ${allBlocks.length} total blocks`);

  // Skip if all batch response files already exist (manual workflow completed this section)
  const existingResponses = existsSync(join(CLEAN_DIR, 'responses'))
    ? readdirSync(join(CLEAN_DIR, 'responses')).filter(f => f.startsWith(`${sectionName}_batch-`) && f.endsWith('_response.json'))
    : [];
  const nonNoteCount = allBlocks.filter(b => !b.isNote).length;
  const expectedBatches = Math.ceil(nonNoteCount / batchSize);
  if (existingResponses.length >= expectedBatches && !resume) {
    console.log(`  Already has ${existingResponses.length} response files (${expectedBatches} expected). Skipping. Use --resume to force.`);
    return null;
  }

  // Separate note blocks (pass through unchanged) from non-note (rewrite)
  const noteBlocks = allBlocks.filter(b => b.isNote);
  const rewriteBlocks = allBlocks.filter(b => !b.isNote);
  console.log(`  ${rewriteBlocks.length} blocks to rewrite, ${noteBlocks.length} note blocks (passthrough)`);

  const outputFile = join(CLEAN_DIR, `${sectionName}_clean.json`);
  const progressFile = join(CLEAN_DIR, `${sectionName}_progress.json`);
  const responsesDir = join(CLEAN_DIR, 'responses');
  mkdirSync(responsesDir, { recursive: true });

  // Resume support: load previously processed batches
  let results = [];
  let startBatch = 0;
  if (resume && existsSync(progressFile)) {
    results = JSON.parse(readFileSync(progressFile, 'utf-8'));
    startBatch = Math.floor(results.length / batchSize);
    console.log(`  Resuming from batch ${startBatch + 1} (${results.length} blocks already processed)`);
  }

  // Process in batches
  const totalBatches = Math.ceil(rewriteBlocks.length / batchSize);
  let totalTokens = 0;

  for (let i = startBatch; i < totalBatches; i++) {
    const batch = rewriteBlocks.slice(i * batchSize, (i + 1) * batchSize);
    const batchInput = batch.map(b => ({ id: b.id, text: b.text }));

    console.log(`  Batch ${i + 1}/${totalBatches} (${batch.length} blocks)...`);

    try {
      const response = await callAnthropic(
        REWRITE_PROMPT,
        JSON.stringify(batchInput, null, 2)
      );

      const batchResults = parseJsonResponse(response.text);
      results.push(...batchResults);
      totalTokens += (response.usage?.input_tokens || 0) + (response.usage?.output_tokens || 0);

      console.log(`    Model: ${response.model} | Tokens: ${response.usage?.input_tokens}in + ${response.usage?.output_tokens}out`);

      // Save individual batch response file (compatible with ingest pipeline)
      const batchNum = String(i + 1).padStart(2, '0');
      const batchFile = join(responsesDir, `${sectionName}_batch-${batchNum}_response.json`);
      writeFileSync(batchFile, JSON.stringify(batchResults, null, 2));
      console.log(`    Saved: ${batchFile}`);

      // Save progress after each batch
      writeFileSync(progressFile, JSON.stringify(results, null, 2));
    } catch (err) {
      console.error(`    ERROR on batch ${i + 1}: ${err.message}`);
      console.error('    Saving progress and stopping. Use --resume to continue.');
      writeFileSync(progressFile, JSON.stringify(results, null, 2));
      return null;
    }

    // Rate limiting: wait 1s between batches
    if (i < totalBatches - 1) {
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  // Merge note blocks (passthrough) with rewritten blocks
  const cleanBlocks = [];

  // Add rewritten blocks
  for (const result of results) {
    const original = allBlocks.find(b => b.id === result.id);
    if (!original) {
      console.warn(`  Warning: result ID ${result.id} not found in original blocks`);
      continue;
    }
    cleanBlocks.push({
      ...original,
      text: result.rewritten || result.original,
      originalText: result.original,
      changes: result.changes || [],
    });
  }

  // Add note blocks unchanged
  for (const note of noteBlocks) {
    cleanBlocks.push({
      ...note,
      originalText: note.text,
      changes: [],
    });
  }

  // Sort by original block order (by ID index)
  const idOrder = new Map(allBlocks.map((b, i) => [b.id, i]));
  cleanBlocks.sort((a, b) => (idOrder.get(a.id) || 0) - (idOrder.get(b.id) || 0));

  writeFileSync(outputFile, JSON.stringify(cleanBlocks, null, 2));
  console.log(`  Output: ${outputFile} (${cleanBlocks.length} blocks)`);
  console.log(`  Total tokens: ~${totalTokens.toLocaleString()}`);

  return cleanBlocks;
}

// --- Main ---
async function main() {
  mkdirSync(CLEAN_DIR, { recursive: true });

  const ALL_SECTIONS = ['03_30_00', '22_00_00', '26_20_00', '32_12_16_16', '33_71_02'];
  const sections = processAll ? ALL_SECTIONS : [singleSection];

  const allClean = [];

  for (const section of sections) {
    const result = await processSection(section);
    if (result) allClean.push(...result);
  }

  if (allClean.length > 0 && (processAll || sections.length > 1)) {
    const combinedFile = join(CLEAN_DIR, 'all_clean.json');
    writeFileSync(combinedFile, JSON.stringify(allClean, null, 2));
    console.log(`\nCombined clean corpus: ${combinedFile} (${allClean.length} blocks)`);
  }

  // Summary
  const changed = allClean.filter(b => b.changes && b.changes.length > 0);
  const unchanged = allClean.filter(b => !b.changes || b.changes.length === 0);
  console.log(`\nSummary:`);
  console.log(`  Blocks rewritten: ${changed.length}`);
  console.log(`  Blocks unchanged: ${unchanged.length}`);
  console.log(`  Note blocks (passthrough): ${allClean.filter(b => b.isNote).length}`);
}

main().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
