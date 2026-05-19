#!/usr/bin/env node
/**
 * Adversarial Corpus Scorer
 *
 * Runs SecWriter's three text-analysis engines against
 * corpus/adversarial/adversarial.json and scores each entry against its
 * `expected.shouldFlag` / `expected.ruleId` annotation.
 *
 * Writes corpus/results/adversarial-results.json in the schema consumed by
 * src/lib/__tests__/corpus-adversarial.node-test.mjs and tools/generate-report.mjs:
 *   { summary: { correct, total, accuracy },
 *     byCategory: { <category>: { correct, total } },
 *     failures: [ { id, shouldFlag, ruleId, text } ] }
 *
 * Usage:
 *   node --import ./tools/json-loader.mjs tools/score-adversarial.mjs
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');

// --- Load engines (same shape as run-corpus-test.mjs) ---
console.log('Loading engines...');

const { getRules, runStaticRules } = await import('../src/lib/compliance-rules.js');
const rules = getRules();
console.log(`  Static rules: ${rules.length} rules loaded`);

const { detectNlpIssues, preloadNlp } = await import('../src/lib/nlp-rules.js');
await preloadNlp();
console.log('  NLP: compromise.js loaded');

const {
  ENGINEERING_TERMS,
  DISABLED_RULES,
  shouldSuppressGrammarFinding,
} = await import('../src/lib/grammar-checker.js');
const EMPTY_USER_DICT = new Set();

const [{ LocalLinter }, { binaryInlined }] = await Promise.all([
  import('harper.js'),
  import('harper.js/binaryInlined'),
]);
const harperLinter = new LocalLinter({ binary: binaryInlined });
await harperLinter.lint('Test sentence.');
await harperLinter.importWords(ENGINEERING_TERMS);
const cfg = await harperLinter.getLintConfig();
Object.assign(cfg, DISABLED_RULES);
await harperLinter.setLintConfig(cfg);
console.log(`  Grammar: Harper.js LocalLinter ready (dict: ${ENGINEERING_TERMS.length} terms)`);

function filterHarperResults(results, text) {
  const filtered = [];
  for (const item of results) {
    try {
      const json = item.to_json();
      const parsed = typeof json === 'string' ? JSON.parse(json) : json;
      const problemText = parsed.problem_text || text.substring(parsed.span.start, parsed.span.end);
      const lintKind = parsed.inner?.lint_kind;
      if (shouldSuppressGrammarFinding(problemText, EMPTY_USER_DICT, lintKind)) continue;
      const suggestions = parsed.inner?.suggestions || [];
      const hasBadSuggestion = suggestions.some(s => {
        if (s.ReplaceWith) {
          const replacement = s.ReplaceWith.join('');
          return replacement.includes(' ') && !problemText.includes(' ');
        }
        return false;
      });
      if (hasBadSuggestion && suggestions.length === 1) continue;
      filtered.push({
        ruleId: `GRAMMAR-${parsed.inner?.lint_kind || 'Unknown'}`,
      });
    } catch {
      // skip malformed
    }
  }
  return filtered;
}

// --- Load adversarial corpus ---
const corpusFile = join(PROJECT_ROOT, 'corpus', 'adversarial', 'adversarial.json');
const data = JSON.parse(readFileSync(corpusFile, 'utf-8'));
const entries = data.entries || data;
console.log(`\nAdversarial: ${entries.length} entries\n`);

const failures = [];
const byCategory = {};
let correct = 0;

const startTime = Date.now();

for (const entry of entries) {
  const text = entry.text;
  const expected = entry.expected;
  const category = entry.category || 'uncategorized';

  // Run engines and collect ruleIds.
  const flaggedRuleIds = new Set();

  const staticViolations = runStaticRules(text, entry.id, rules, {
    isNoteBlock: false,
    skipBrackets: true,
  });
  for (const v of staticViolations) flaggedRuleIds.add(v.ruleId || v.id);

  const nlpViolations = detectNlpIssues(text, entry.id, false);
  for (const v of nlpViolations) flaggedRuleIds.add(v.ruleId || v.id);

  // Grammar findings are not part of adversarial expectations, but include
  // them for completeness — if an adversarial entry ever asserts on
  // GRAMMAR-* the schema still matches.
  const grammarFindings = filterHarperResults(await harperLinter.lint(text), text);
  for (const f of grammarFindings) flaggedRuleIds.add(f.ruleId);

  // Score: shouldFlag means the expected ruleId must appear; !shouldFlag
  // means it must NOT appear.
  const actuallyFlagged = flaggedRuleIds.has(expected.ruleId);
  const isCorrect = expected.shouldFlag ? actuallyFlagged : !actuallyFlagged;

  if (!byCategory[category]) byCategory[category] = { correct: 0, total: 0 };
  byCategory[category].total++;
  if (isCorrect) {
    byCategory[category].correct++;
    correct++;
  } else {
    failures.push({
      id: entry.id,
      shouldFlag: expected.shouldFlag,
      ruleId: expected.ruleId,
      text,
      category,
      reason: expected.reason,
    });
  }
}

const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
console.log(`Scored ${entries.length} entries in ${elapsed}s\n`);

const total = entries.length;
const accuracy = correct / total;

const output = {
  metadata: {
    corpusFile,
    timestamp: new Date().toISOString(),
    elapsedSeconds: parseFloat(elapsed),
  },
  summary: { correct, total, accuracy },
  byCategory,
  failures,
};

const resultsDir = join(PROJECT_ROOT, 'corpus', 'results');
mkdirSync(resultsDir, { recursive: true });
const outputFile = join(resultsDir, 'adversarial-results.json');
writeFileSync(outputFile, JSON.stringify(output, null, 2));

console.log('======================================================================');
console.log('ADVERSARIAL CORPUS RESULTS');
console.log('======================================================================');
console.log(`Total: ${correct}/${total} = ${(accuracy * 100).toFixed(1)}%`);
console.log('\nBy category:');
for (const [cat, stats] of Object.entries(byCategory)) {
  const pct = (stats.correct / stats.total * 100).toFixed(1);
  console.log(`  ${cat}: ${stats.correct}/${stats.total} (${pct}%)`);
}
console.log(`\nFailures: ${failures.length}`);
for (const f of failures.slice(0, 10)) {
  const label = f.shouldFlag ? 'MISSED' : 'FALSE POS';
  console.log(`  ${f.id} [${label}] ${f.ruleId}: ${f.text.slice(0, 70)}`);
}
console.log(`\nResults saved: ${outputFile}`);
