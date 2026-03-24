#!/usr/bin/env node
/**
 * FP Rewrite Script (Phase 6)
 *
 * Re-rewrites clean corpus blocks that Opus missed during initial rewriting.
 * Sends blocks with specific violation callouts to Opus for targeted fixes.
 *
 * Requires: ANTHROPIC_API_KEY environment variable
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');
const CLEAN_DIR = join(PROJECT_ROOT, 'corpus', 'clean');

const API_KEY = process.env.ANTHROPIC_API_KEY;
if (!API_KEY) {
  console.error('ERROR: ANTHROPIC_API_KEY environment variable is required.');
  process.exit(1);
}

const REWRITE_PROMPT = `You are a UFGS specification editor. Each block below was previously rewritten
for UFS 1-300-02 compliance but STILL contains a specific violation that was missed.

Fix ONLY the identified violation in each block. Do not change anything else.

Rules:
- TERM-to-be: Replace "is to be" / "are to be" with imperative mood
- TERM-adequate: Remove or replace "adequate" with specific measurable criteria
- CAP-Contract: Capitalize "contract" when referring to the construction Contract
- TERM-as-approved-by-co: Rewrite to remove "as approved by the Contracting Officer"
- TERM-securely: Replace "securely" with specific fastening method or criteria
- TERM-as-necessary: Replace "as necessary" with specific criteria
- TERM-an-approved-type: Replace "an approved type" with specific type
- TERM-suitable: Replace "suitable" with specific criteria
- TERM-furnish: Replace "furnish" with "provide"
- TERM-carefully: Replace "carefully" with specific handling method
- TERM-thoroughly: Replace "thoroughly" with specific cleaning/preparation standard
- TERM-as-directed-by-co: Rewrite to remove "as directed by the Contracting Officer"

Do NOT change technical meaning, quantities, or reference citations.

Return ONLY a JSON array:
[{
  "blockId": "<block ID>",
  "original": "<current text>",
  "rewritten": "<fixed text>",
  "change": "<what was fixed>"
}]`;

async function callAnthropic(systemPrompt, userMessage) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 300000);

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-opus-4-20250514',
      max_tokens: 8192,
      temperature: 0,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
    }),
    signal: controller.signal,
  });

  clearTimeout(timeout);
  if (!response.ok) throw new Error(`API ${response.status}: ${(await response.text()).slice(0, 200)}`);
  const data = await response.json();
  return data.content[0]?.text || '';
}

async function main() {
  const batchFile = join(CLEAN_DIR, 'responses', 'fp-rewrite-batch.json');
  const batch = JSON.parse(readFileSync(batchFile, 'utf-8'));
  console.log(`Re-rewriting ${batch.length} blocks with missed violations...\n`);

  const userInput = batch.map(b => ({
    blockId: b.blockId,
    ruleId: b.ruleId,
    text: b.text,
    violation: b.violation,
  }));

  const responseText = await callAnthropic(REWRITE_PROMPT, JSON.stringify(userInput, null, 2));

  // Parse response
  let cleaned = responseText.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
  }
  const results = JSON.parse(cleaned);
  console.log(`Received ${results.length} rewrites`);

  // Apply to clean corpus
  const sections = ['03_30_00', '22_00_00', '26_20_00', '32_12_16_16', '33_71_02'];
  const rewriteMap = new Map(results.map(r => [r.blockId, r]));

  let totalFixed = 0;
  for (const section of sections) {
    const file = join(CLEAN_DIR, `${section}_clean.json`);
    if (!existsSync(file)) continue;
    const blocks = JSON.parse(readFileSync(file, 'utf-8'));
    let sectionFixed = 0;

    for (const block of blocks) {
      const rewrite = rewriteMap.get(block.id);
      if (rewrite && rewrite.rewritten && rewrite.rewritten !== rewrite.original) {
        block.text = rewrite.rewritten;
        block.changes = [...(block.changes || []), rewrite.change];
        sectionFixed++;
      }
    }

    if (sectionFixed > 0) {
      writeFileSync(file, JSON.stringify(blocks, null, 2));
      console.log(`  ${section}: ${sectionFixed} blocks fixed`);
      totalFixed += sectionFixed;
    }
  }

  // Rebuild combined clean corpus
  const allBlocks = [];
  for (const section of sections) {
    const file = join(CLEAN_DIR, `${section}_clean.json`);
    if (existsSync(file)) {
      allBlocks.push(...JSON.parse(readFileSync(file, 'utf-8')));
    }
  }
  writeFileSync(join(CLEAN_DIR, 'all_clean.json'), JSON.stringify(allBlocks, null, 2));

  console.log(`\nTotal fixed: ${totalFixed} blocks`);
  console.log('Combined clean corpus updated: corpus/clean/all_clean.json');

  // Save rewrite results
  writeFileSync(join(CLEAN_DIR, 'responses', 'fp-rewrite-results.json'), JSON.stringify(results, null, 2));
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
