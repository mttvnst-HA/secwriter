#!/usr/bin/env node
/**
 * AI tier corpus runner (#137).
 *
 * Plumbing only. Runs `requestAIRewrite` over blocks from `corpus/dirty/` and
 * captures per-run token counts so `generate-report.mjs` can emit the
 * Value (C²/$) metric. No model-selection policy.
 *
 * Cost-of-run is computed from `tools/model-pricing.json`. Correctness is
 * defined as the fraction of injected violations that no longer trigger
 * the static engine on the rewritten text:
 *
 *   correctness_block = 1 - (violations_after / violations_before)
 *
 * This is a proxy — a rewrite that strips violations but also breaks the
 * semantics scores high. Sentence-level human evaluation is a future
 * follow-up; the current proxy is enough to drive a non-trivial column.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-... node tools/run-ai-corpus.mjs --model claude-haiku-4-5 --limit 5
 *
 * Flags:
 *   --model <id>    Model id (default: claude-sonnet-4-6)
 *   --limit  <n>    Stop after N blocks (default: all blocks with violations)
 *   --out <path>    Output file (default: corpus/results/ai-results.json)
 *
 * Output:
 *   Appends a new run object to the file's `runs` array (or creates the file).
 *   Each run object:
 *     { model, generatedAt, blocks: [{ blockId, correctness, inputTokens, outputTokens, violationsBefore, violationsAfter, error? }] }
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');

// ── CLI parsing ──
const args = process.argv.slice(2);
function flag(name, fallback) {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return fallback;
  return args[i + 1];
}
const MODEL = flag('model', 'claude-sonnet-4-6');
const LIMIT = Number(flag('limit', 0)) || 0;
const OUT = flag('out', join(PROJECT_ROOT, 'corpus', 'results', 'ai-results.json'));

// ── Env / pre-flight ──
const API_KEY = process.env.ANTHROPIC_API_KEY;
if (!API_KEY) {
  console.error('ANTHROPIC_API_KEY not set — skipping AI corpus run.');
  console.error('Plumbing for the Value (C²/$) metric is unit-tested in tools/__tests__/ai-value-metric.test.js;');
  console.error('this runner just captures real-world data when the user provides a key.');
  process.exit(0);
}

const dirtyPath = join(PROJECT_ROOT, 'corpus', 'dirty', 'all_dirty.json');
if (!existsSync(dirtyPath)) {
  console.error(`corpus/dirty/all_dirty.json not found at ${dirtyPath}`);
  process.exit(1);
}

// ── Load static engine for correctness measurement ──
console.log('Loading static engine for correctness scoring…');
const { getRules, runStaticRules } = await import('../src/lib/compliance-rules.js');
const rules = getRules();

// ── Load AI module ──
const { requestAIRewrite } = await import('../src/lib/compliance-ai.js');

// ── Run ──
const dirty = JSON.parse(readFileSync(dirtyPath, 'utf-8'));
const violatedBlocks = dirty.filter(b => Array.isArray(b.violations) && b.violations.length > 0);
const targetBlocks = LIMIT > 0 ? violatedBlocks.slice(0, LIMIT) : violatedBlocks;
console.log(`Running AI tier on ${targetBlocks.length} block(s) with model ${MODEL}…`);

const perBlock = [];
for (let i = 0; i < targetBlocks.length; i++) {
  const block = targetBlocks[i];
  // Measure violations BEFORE the rewrite. Dirty corpus blocks expose the
  // text with injected violations as `block.dirty` (see
  // `corpus/dirty/all_dirty.json`, keys: { id, clean, dirty, violations }).
  const beforeText = block.dirty || block.text || block.html || '';
  const before = runStaticRules(beforeText, block.id, rules) || [];
  const violationsBefore = before.length;

  if (violationsBefore === 0) {
    perBlock.push({
      blockId: block.id,
      correctness: 1.0,
      inputTokens: 0,
      outputTokens: 0,
      violationsBefore: 0,
      violationsAfter: 0,
      skipped: 'no static violations to fix',
    });
    continue;
  }

  process.stdout.write(`  [${i + 1}/${targetBlocks.length}] ${block.id} (violations: ${violationsBefore})… `);
  try {
    const result = await requestAIRewrite(
      [{ id: block.id, html: beforeText }],
      before.map(v => ({ blockId: block.id, ruleId: v.ruleId, index: v.index, match: v.match, severity: v.severity })),
      API_KEY,
      { model: MODEL },
    );
    const rewrite = result.rewrites.find(r => r.blockId === block.id);
    const afterText = rewrite?.proposed || beforeText;
    const after = runStaticRules(afterText, block.id, rules) || [];
    const violationsAfter = after.length;
    const correctness = 1 - (violationsAfter / violationsBefore);
    perBlock.push({
      blockId: block.id,
      correctness: Math.max(0, Math.min(1, correctness)),
      inputTokens: result.inputTokens || 0,
      outputTokens: result.outputTokens || 0,
      violationsBefore,
      violationsAfter,
    });
    console.log(`correctness=${correctness.toFixed(2)} in=${result.inputTokens} out=${result.outputTokens}`);
  } catch (err) {
    perBlock.push({
      blockId: block.id,
      correctness: 0,
      inputTokens: 0,
      outputTokens: 0,
      violationsBefore,
      violationsAfter: violationsBefore,
      error: err.message,
    });
    console.log(`error: ${err.message}`);
  }
}

// ── Write results ──
mkdirSync(dirname(OUT), { recursive: true });
let existing = { runs: [] };
if (existsSync(OUT)) {
  try { existing = JSON.parse(readFileSync(OUT, 'utf-8')); }
  catch { existing = { runs: [] }; }
  if (!Array.isArray(existing.runs)) existing.runs = [];
}
existing.runs.push({
  model: MODEL,
  generatedAt: new Date().toISOString(),
  blocks: perBlock,
});
writeFileSync(OUT, JSON.stringify(existing, null, 2));

const totalInput = perBlock.reduce((s, b) => s + b.inputTokens, 0);
const totalOutput = perBlock.reduce((s, b) => s + b.outputTokens, 0);
const avgCorrectness = perBlock.reduce((s, b) => s + b.correctness, 0) / perBlock.length;
console.log(`\nAppended run to ${OUT}`);
console.log(`  blocks=${perBlock.length} avgCorrectness=${avgCorrectness.toFixed(3)} inputTokens=${totalInput} outputTokens=${totalOutput}`);
