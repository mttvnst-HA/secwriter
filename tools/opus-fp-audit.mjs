#!/usr/bin/env node
/**
 * FP Audit Script (Phase 6)
 *
 * Sends clean corpus false positive blocks to Claude Opus for verification.
 * Categorizes each as: true FP (engine error), Opus rewrite failure, or ambiguous.
 *
 * Requires: ANTHROPIC_API_KEY environment variable
 *
 * Usage:
 *   node tools/opus-fp-audit.mjs
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');
const RESULTS_DIR = join(PROJECT_ROOT, 'corpus', 'results');

const API_KEY = process.env.ANTHROPIC_API_KEY;
if (!API_KEY) {
  console.error('ERROR: ANTHROPIC_API_KEY environment variable is required.');
  process.exit(1);
}

const MODEL = 'claude-opus-4-20250514';
const MAX_TOKENS = 8192;
const BATCH_SIZE = 20;

const AUDIT_PROMPT = `You are a UFGS specification compliance expert auditing false positive detections.

For each block below, a compliance engine flagged the indicated text as a UFS 1-300-02 violation.
The block was previously rewritten by an AI to be fully compliant. Your job is to determine whether:

1. **TRUE_FP** — The block IS compliant. The engine's pattern is too broad (false positive).
2. **OPUS_MISS** — The block still violates the rule. The AI rewrite failed to fix this violation.
3. **AMBIGUOUS** — Reasonable people could disagree. The text is borderline.

Rules context:
- COLLOQ-head: "head" is colloquial for "toilet" per UFS 1-300-02 §2-4.4. But "head" in engineering compounds (head pressure, shower head, pile head) is NOT colloquial.
- TERM-to-be: "is to be" / "are to be" is prohibited passive construction. But descriptive "is" + adjective is not the same.
- SYM-and: "&" (ampersand) should be spelled "and". But in standard abbreviations (P & T) it may be acceptable.
- TERM-suitable: "suitable" is vague per UFS §2-4.4. But "suitable" with a specific referent may be OK.
- TERM-any: "any" is indefinite per UFS §2-4.4. But "any" as a determiner in some contexts is standard English.
- TERM-should: "should" is prohibited in specification text (use imperative mood).
- CAP-Contract: "Contract" must be capitalized when referring to the construction contract.
- TERM-per: "per" is prohibited (use "in accordance with"), except in unit expressions.

Return ONLY a JSON array (no commentary):
[{
  "blockId": "<block ID>",
  "ruleId": "<rule that flagged>",
  "verdict": "TRUE_FP" | "OPUS_MISS" | "AMBIGUOUS",
  "reason": "<brief explanation>"
}]`;

async function callAnthropic(systemPrompt, userMessage, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
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
          model: MODEL,
          max_tokens: MAX_TOKENS,
          temperature: 0,
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
      return data.content[0]?.text || '';
    } catch (err) {
      if (attempt < retries) {
        const delay = Math.pow(2, attempt) * 1000;
        console.log(`  Attempt ${attempt} failed (${err.message}), retrying in ${delay / 1000}s...`);
        await new Promise(r => setTimeout(r, delay));
      } else {
        throw err;
      }
    }
  }
}

function parseJsonResponse(text) {
  let cleaned = text.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
  }
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    const fenceStart = text.indexOf('```json');
    const fenceEnd = text.lastIndexOf('```');
    if (fenceStart >= 0 && fenceEnd > fenceStart) {
      return JSON.parse(text.slice(fenceStart + 7, fenceEnd).trim());
    }
    throw e;
  }
}

async function main() {
  const fpFile = join(RESULTS_DIR, 'fp-blocks-for-audit.json');
  if (!existsSync(fpFile)) {
    console.error('FP blocks file not found:', fpFile);
    process.exit(1);
  }

  const fpBlocks = JSON.parse(readFileSync(fpFile, 'utf-8'));
  console.log(`Auditing ${fpBlocks.length} false positive blocks via Opus...\n`);

  const allResults = [];
  const totalBatches = Math.ceil(fpBlocks.length / BATCH_SIZE);

  for (let i = 0; i < totalBatches; i++) {
    const batch = fpBlocks.slice(i * BATCH_SIZE, (i + 1) * BATCH_SIZE);
    const userInput = batch.map(b => ({
      blockId: b.blockId,
      ruleId: b.ruleId,
      flaggedText: b.match,
      blockText: b.text,
    }));

    console.log(`Batch ${i + 1}/${totalBatches} (${batch.length} blocks)...`);

    try {
      const responseText = await callAnthropic(AUDIT_PROMPT, JSON.stringify(userInput, null, 2));
      const batchResults = parseJsonResponse(responseText);
      allResults.push(...batchResults);
      console.log(`  ${batchResults.length} verdicts received`);
    } catch (err) {
      console.error(`  ERROR: ${err.message}`);
      // Continue with remaining batches
    }

    if (i < totalBatches - 1) {
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  // Categorize results
  const verdicts = { TRUE_FP: [], OPUS_MISS: [], AMBIGUOUS: [] };
  for (const r of allResults) {
    if (verdicts[r.verdict]) {
      verdicts[r.verdict].push(r);
    } else {
      verdicts.AMBIGUOUS.push(r); // Unknown verdict → ambiguous
    }
  }

  console.log('\n' + '='.repeat(60));
  console.log('FP AUDIT RESULTS');
  console.log('='.repeat(60));
  console.log(`Total audited: ${allResults.length}`);
  console.log(`  TRUE_FP (engine error):     ${verdicts.TRUE_FP.length}`);
  console.log(`  OPUS_MISS (rewrite failed): ${verdicts.OPUS_MISS.length}`);
  console.log(`  AMBIGUOUS:                  ${verdicts.AMBIGUOUS.length}`);

  // Breakdown by rule
  console.log('\nBy rule:');
  const byRule = {};
  for (const r of allResults) {
    if (!byRule[r.ruleId]) byRule[r.ruleId] = { TRUE_FP: 0, OPUS_MISS: 0, AMBIGUOUS: 0 };
    byRule[r.ruleId][r.verdict] = (byRule[r.ruleId][r.verdict] || 0) + 1;
  }
  console.log('Rule'.padEnd(25) + 'TRUE_FP  OPUS_MISS  AMBIG');
  for (const [rule, counts] of Object.entries(byRule).sort((a, b) => b[1].TRUE_FP - a[1].TRUE_FP)) {
    console.log(`  ${rule.padEnd(23)} ${String(counts.TRUE_FP).padEnd(9)}${String(counts.OPUS_MISS).padEnd(11)}${counts.AMBIGUOUS}`);
  }

  // Save results
  const outFile = join(RESULTS_DIR, 'fp-audit-results.json');
  writeFileSync(outFile, JSON.stringify({
    summary: {
      total: allResults.length,
      trueFP: verdicts.TRUE_FP.length,
      opusMiss: verdicts.OPUS_MISS.length,
      ambiguous: verdicts.AMBIGUOUS.length,
    },
    byRule,
    verdicts: allResults,
  }, null, 2));
  console.log(`\nResults saved: ${outFile}`);
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
