#!/usr/bin/env node
/**
 * Opus Injection Script (Phase 3.1-3.2)
 *
 * Sends clean corpus blocks to Claude Opus for targeted violation injection.
 * Produces the "known dirty" corpus with labeled violations.
 *
 * Requires: ANTHROPIC_API_KEY environment variable
 *
 * Usage:
 *   node tools/opus-inject.mjs --section 03_30_00
 *   node tools/opus-inject.mjs --all
 *   node tools/opus-inject.mjs --section 03_30_00 --resume
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');
const CLEAN_DIR = join(PROJECT_ROOT, 'corpus', 'clean');
const DIRTY_DIR = join(PROJECT_ROOT, 'corpus', 'dirty');

const API_KEY = process.env.ANTHROPIC_API_KEY;
if (!API_KEY) {
  console.error('ERROR: ANTHROPIC_API_KEY environment variable is required.');
  process.exit(1);
}

const MODEL = 'claude-opus-4-20250514';
const TEMPERATURE = 0;
const MAX_TOKENS = 16384;
const BATCH_SIZE = 20;

// Violation injection plan — covers all 3 engine tiers
// Counts are per-section; multiply by 5 for total corpus coverage
const INJECTION_PLAN = [
  // === Static rules: prohibited terms ===
  { ruleId: 'TERM-001', count: 30, method: 'Insert "shall" before imperative verbs (e.g., "Provide" -> "shall provide")' },
  { ruleId: 'TERM-002', count: 10, method: 'Insert "should" before verbs (e.g., "Test" -> "should test")' },
  { ruleId: 'TERM-004', count: 15, method: 'Replace "in accordance with" with "per" (but NOT "per hour"/"per square foot" — those are valid)' },
  { ruleId: 'TERM-006', count: 15, method: 'Insert "any" before nouns (but NOT "any of the following" — that is valid)' },
  { ruleId: 'TERM-010', count: 8, method: 'Insert "and/or" between two items in a list' },
  { ruleId: 'TERM-013', count: 10, method: 'Convert imperative to "is to be"/"are to be" form' },
  { ruleId: 'TERM-028', count: 10, method: 'Append "etc." to list items' },
  { ruleId: 'TERM-032', count: 8, method: 'Replace "in accordance with" with "conforming to"' },
  // === Static rules: vague/subjective terms ===
  { ruleId: 'VAGUE-001', count: 10, method: 'Insert "suitable" before nouns (e.g., "materials" -> "suitable materials")' },
  { ruleId: 'VAGUE-002', count: 10, method: 'Insert "adequate" before nouns' },
  { ruleId: 'VAGUE-003', count: 10, method: 'Insert "proper"/"properly" before verbs/nouns' },
  { ruleId: 'TERM-017', count: 8, method: 'Append "as necessary" or "as required" to a clause' },
  { ruleId: 'TERM-023', count: 8, method: 'Insert "securely" before a verb (e.g., "fasten" -> "securely fasten")' },
  { ruleId: 'TERM-024', count: 8, method: 'Insert "thoroughly" before a verb' },
  { ruleId: 'TERM-025', count: 8, method: 'Insert "carefully" before a verb' },
  // === Static rules: colloquialisms ===
  { ruleId: 'COLLOQ-furnish', count: 10, method: 'Replace "provide" with "furnish"' },
  // === Static rules: capitalization ===
  { ruleId: 'CAP-Contract', count: 15, method: 'Lowercase "Contract" to "contract" when referring to the construction contract' },
  { ruleId: 'CAP-Contractor', count: 15, method: 'Lowercase "Contractor" to "contractor"' },
  { ruleId: 'CAP-Government', count: 10, method: 'Lowercase "Government" to "government"' },
  // === Static rules: formatting/symbols ===
  { ruleId: 'FMT-002', count: 10, method: 'Replace hyphens with em-dashes (U+2014 —)' },
  { ruleId: 'FMT-003', count: 10, method: 'Replace straight quotes with curly/smart quotes (" " \u2018 \u2019)' },
  { ruleId: 'SYM-001', count: 10, method: 'Replace "percent" with "%" symbol' },
  { ruleId: 'SYM-002', count: 10, method: 'Replace "number" or "No." with "#" symbol' },
  { ruleId: 'SYM-013', count: 10, method: 'Replace "and" with "&" ampersand' },
  // === NLP rules: voice and mood ===
  { ruleId: 'NLP-PASSIVE-001', count: 30, method: 'Convert imperative to passive voice ("Place materials" -> "Materials shall be placed")' },
  { ruleId: 'NLP-INDICATIVE-001', count: 15, method: 'Convert imperative to indicative mood ("Provide" -> "The Contractor provides")' },
  // === Grammar rules (Harper.js) ===
  { ruleId: 'GRAMMAR-Spelling', count: 15, method: 'Introduce realistic typos: swap adjacent letters, double a letter, or drop a letter (e.g., "materials" -> "materails")' },
  { ruleId: 'GRAMMAR-Agreement', count: 10, method: 'Change subject-verb number agreement (e.g., "materials are" -> "materials is")' },
];

const INJECT_PROMPT = `You are a test data generator for a specification compliance checker. For each
clean block below, introduce EXACTLY the specified violation type. Return the
corrupted block plus a label identifying the violation.

Rules:
- Introduce ONLY the specified violation type - do not add other errors
- The corrupted block must still be syntactically valid English (not gibberish)
- The violation must be detectable by a regex or NLP tool
- Preserve the rest of the block text exactly (character-for-character)
- Do NOT compute character offsets - just return the match text. Offsets
  will be computed programmatically after injection.

Return ONLY a JSON array (no markdown fencing, no commentary):
[{
  "id": "<block id>",
  "clean": "<original clean text>",
  "dirty": "<text with violation injected>",
  "violations": [{
    "ruleId": "<rule ID>",
    "match": "<the violating text in the dirty version>",
    "description": "<what was changed>"
  }]
}]`;

// --- Parse CLI args ---
const args = process.argv.slice(2);
const processAll = args.includes('--all');
const singleSection = args.includes('--section') ? args[args.indexOf('--section') + 1] : null;
const resumeMode = args.includes('--resume');

if (!processAll && !singleSection) {
  console.error('Usage: node tools/opus-inject.mjs --section <section_name> | --all');
  process.exit(1);
}

async function callAnthropic(systemPrompt, userMessage, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 300000); // 5 min

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
        throw new Error(`API error ${response.status}: ${err.slice(0, 200)}`);
      }

      const data = await response.json();
      return {
        text: data.content[0]?.text || '',
        model: data.model,
        usage: data.usage,
      };
    } catch (err) {
      if (attempt < retries) {
        const delay = Math.pow(2, attempt) * 1000;
        console.log(`    Attempt ${attempt} failed (${err.message}), retrying in ${delay / 1000}s...`);
        await new Promise(r => setTimeout(r, delay));
      } else {
        throw err;
      }
    }
  }
}

function sanitizeJsonText(text) {
  // Fix curly/smart quotes that break JSON parsing (from FMT-003 injections)
  // Only replace curly quotes that are INSIDE JSON string values, not structural quotes
  // Strategy: replace all curly quotes with escaped versions inside strings
  return text
    .replace(/\u201c/g, '\\"')   // left double curly quote -> escaped straight
    .replace(/\u201d/g, '\\"')   // right double curly quote -> escaped straight
    .replace(/\u2018/g, "'")     // left single curly quote -> straight
    .replace(/\u2019/g, "'");    // right single curly quote -> straight
}

function parseJsonResponse(text) {
  let cleaned = text.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
  }
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    // Try with curly quote sanitization
    try {
      return JSON.parse(sanitizeJsonText(cleaned));
    } catch (e2) { /* fall through */ }
    // Try extracting from ```json ... ``` fences (with sanitization)
    const sanitized = sanitizeJsonText(text);
    const fenceStart = sanitized.indexOf('```json');
    const fenceEnd = sanitized.lastIndexOf('```');
    if (fenceStart >= 0 && fenceEnd > fenceStart) {
      const inner = sanitized.slice(fenceStart + 7, fenceEnd).trim();
      try { return JSON.parse(inner); } catch (e3) { /* fall through */ }
    }
    // Balanced bracket extraction (with sanitization)
    const arrStart = sanitized.indexOf('[\n');
    if (arrStart >= 0) {
      let depth = 0, inStr = false, esc = false, end = -1;
      for (let i = arrStart; i < sanitized.length; i++) {
        const ch = sanitized[i];
        if (esc) { esc = false; continue; }
        if (ch === '\\' && inStr) { esc = true; continue; }
        if (ch === '"') { inStr = !inStr; continue; }
        if (inStr) continue;
        if (ch === '[') depth++;
        if (ch === ']') { depth--; if (depth === 0) { end = i; break; } }
      }
      if (end > 0) return JSON.parse(sanitized.slice(arrStart, end + 1));
    }
    throw e;
  }
}

/**
 * Assign violations to blocks across sections.
 * Distributes violations evenly, avoiding note blocks.
 */
function assignViolations(blocks, plan) {
  const nonNoteBlocks = blocks.filter(b => !b.isNote && b.charCount >= 40);
  const assignments = [];

  for (const rule of plan) {
    const count = Math.min(rule.count, nonNoteBlocks.length);
    // Distribute across the block array evenly
    const step = Math.max(1, Math.floor(nonNoteBlocks.length / count));

    for (let i = 0; i < count; i++) {
      const blockIdx = (i * step) % nonNoteBlocks.length;
      const block = nonNoteBlocks[blockIdx];

      assignments.push({
        id: block.id,
        text: block.text,
        ruleId: rule.ruleId,
        method: rule.method,
      });
    }
  }

  return assignments;
}

async function processSection(sectionName) {
  const inputFile = join(CLEAN_DIR, `${sectionName}_clean.json`);
  if (!existsSync(inputFile)) {
    console.error(`Clean corpus not found: ${inputFile}`);
    console.error('Run opus-rewrite.mjs first.');
    return null;
  }

  const cleanBlocks = JSON.parse(readFileSync(inputFile, 'utf-8'));
  console.log(`\n[${sectionName}] ${cleanBlocks.length} clean blocks`);

  // Assign violations to blocks
  const assignments = assignViolations(cleanBlocks, INJECTION_PLAN);
  console.log(`  ${assignments.length} violations to inject`);

  const outputFile = join(DIRTY_DIR, `${sectionName}_dirty.json`);
  const progressFile = join(DIRTY_DIR, `${sectionName}_inject_progress.json`);

  let results = [];
  let startBatch = 0;
  if (resumeMode && existsSync(progressFile)) {
    results = JSON.parse(readFileSync(progressFile, 'utf-8'));
    startBatch = Math.floor(results.length / BATCH_SIZE);
    console.log(`  Resuming from batch ${startBatch + 1}`);
  }

  const totalBatches = Math.ceil(assignments.length / BATCH_SIZE);

  for (let i = startBatch; i < totalBatches; i++) {
    const batch = assignments.slice(i * BATCH_SIZE, (i + 1) * BATCH_SIZE);

    const userInput = batch.map(a => ({
      id: a.id,
      text: a.text,
      violationType: a.ruleId,
      instruction: a.method,
    }));

    console.log(`  Batch ${i + 1}/${totalBatches} (${batch.length} injections)...`);

    let retryCount = 0;
    const MAX_BATCH_RETRIES = 2;
    let batchDone = false;

    while (!batchDone && retryCount <= MAX_BATCH_RETRIES) {
      try {
        const response = await callAnthropic(INJECT_PROMPT, JSON.stringify(userInput, null, 2));
        const batchResults = parseJsonResponse(response.text);
        results.push(...batchResults);
        console.log(`    Model: ${response.model} | Tokens: ${response.usage?.input_tokens}in + ${response.usage?.output_tokens}out`);
        writeFileSync(progressFile, JSON.stringify(results, null, 2));
        batchDone = true;
      } catch (err) {
        retryCount++;
        if (retryCount <= MAX_BATCH_RETRIES) {
          console.log(`    JSON parse failed, retrying batch ${i + 1} (attempt ${retryCount + 1})...`);
          await new Promise(r => setTimeout(r, 2000));
        } else {
          // Save raw response for diagnosis, then SKIP this batch
          const debugFile = join(DIRTY_DIR, `${sectionName}_batch${i + 1}_debug.txt`);
          try {
            const response = await callAnthropic(INJECT_PROMPT, JSON.stringify(userInput, null, 2));
            writeFileSync(debugFile, response.text);
          } catch (_) { /* ignore */ }
          console.error(`    SKIPPING batch ${i + 1} after ${MAX_BATCH_RETRIES + 1} attempts: ${err.message}`);
          console.error(`    Debug saved to: ${debugFile}`);
          writeFileSync(progressFile, JSON.stringify(results, null, 2));
          batchDone = true; // skip and continue
        }
      }
    }

    if (i < totalBatches - 1) {
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  writeFileSync(outputFile, JSON.stringify(results, null, 2));
  console.log(`  Output: ${outputFile} (${results.length} dirty blocks)`);

  return results;
}

async function main() {
  mkdirSync(DIRTY_DIR, { recursive: true });

  const sections = processAll
    ? ['03_30_00', '22_00_00', '26_20_00', '32_12_16_16', '33_71_02']
    : [singleSection];

  const allDirty = [];

  for (const section of sections) {
    const result = await processSection(section);
    if (result) allDirty.push(...result);
  }

  if (allDirty.length > 0) {
    const combinedFile = join(DIRTY_DIR, 'all_dirty.json');
    writeFileSync(combinedFile, JSON.stringify(allDirty, null, 2));
    console.log(`\nCombined dirty corpus: ${combinedFile} (${allDirty.length} blocks)`);
  }

  // Violation type breakdown
  const typeCounts = {};
  for (const d of allDirty) {
    for (const v of (d.violations || [])) {
      typeCounts[v.ruleId] = (typeCounts[v.ruleId] || 0) + 1;
    }
  }
  console.log('\nInjected violations by rule:');
  for (const [rule, count] of Object.entries(typeCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${rule}: ${count}`);
  }
}

main().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
