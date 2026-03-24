/**
 * Adversarial corpus tests (Phase 4)
 * Run with: node --import ./tools/json-loader.mjs --test src/lib/__tests__/corpus-adversarial.node-test.mjs
 *
 * Tests edge cases: false-positive traps, borderline compliance, NLP ambiguity,
 * domain jargon, and true positives near exclusion boundaries.
 *
 * Requires: corpus/adversarial/adversarial.json
 *           corpus/results/adversarial-results.json (from Phase 3.5 scoring)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

const adversarialPath = new URL('../../../corpus/adversarial/adversarial.json', import.meta.url);
const resultsPath = new URL('../../../corpus/results/adversarial-results.json', import.meta.url);
const dataExists = existsSync(adversarialPath) && existsSync(resultsPath);

describe('Adversarial: edge case behavior', {
  skip: !dataExists && 'Adversarial corpus or results not generated yet'
}, () => {
  let entries, results;
  if (dataExists) {
    const data = JSON.parse(readFileSync(adversarialPath, 'utf-8'));
    entries = data.entries || data; // Handle both {entries:[]} and [] formats
    results = JSON.parse(readFileSync(resultsPath, 'utf-8'));
  }

  it('overall adversarial accuracy >= 80%', () => {
    const accuracy = results.summary.accuracy;
    console.log(`    Overall: ${results.summary.correct}/${results.summary.total} = ${(accuracy * 100).toFixed(1)}%`);
    assert.ok(accuracy >= 0.80,
      `Adversarial accuracy ${(accuracy * 100).toFixed(1)}% below 80% threshold`);
  });

  it('false-positive traps: >= 80% correctly not flagged', () => {
    const cat = results.byCategory['false-positive-trap'];
    if (!cat) { assert.ok(true, 'No false-positive-trap entries'); return; }
    const accuracy = cat.correct / cat.total;
    console.log(`    FP traps: ${cat.correct}/${cat.total} correct (${(accuracy * 100).toFixed(1)}%)`);
    assert.ok(accuracy >= 0.80,
      `FP trap accuracy ${(accuracy * 100).toFixed(1)}% below 80%`);
  });

  it('true-positive cases: >= 80% correctly flagged', () => {
    const cat = results.byCategory['true-positive'];
    if (!cat) { assert.ok(true, 'No true-positive entries'); return; }
    const accuracy = cat.correct / cat.total;
    console.log(`    True positives: ${cat.correct}/${cat.total} correct (${(accuracy * 100).toFixed(1)}%)`);
    assert.ok(accuracy >= 0.80,
      `True positive accuracy ${(accuracy * 100).toFixed(1)}% below 80%`);
  });

  it('NLP ambiguity cases: >= 60% correct disambiguation', () => {
    const cat = results.byCategory['nlp-ambiguity'];
    if (!cat) { assert.ok(true, 'No nlp-ambiguity entries'); return; }
    const accuracy = cat.correct / cat.total;
    console.log(`    NLP ambiguity: ${cat.correct}/${cat.total} correct (${(accuracy * 100).toFixed(1)}%)`);
    // NLP disambiguation is inherently hard — 60% is realistic
    assert.ok(accuracy >= 0.60,
      `NLP ambiguity accuracy ${(accuracy * 100).toFixed(1)}% below 60%`);
  });

  it('domain jargon traps: >= 80% correctly handled', () => {
    const cat = results.byCategory['domain-jargon-trap'];
    if (!cat) { assert.ok(true, 'No domain-jargon-trap entries'); return; }
    const accuracy = cat.correct / cat.total;
    console.log(`    Domain jargon: ${cat.correct}/${cat.total} correct (${(accuracy * 100).toFixed(1)}%)`);
    assert.ok(accuracy >= 0.80,
      `Domain jargon accuracy ${(accuracy * 100).toFixed(1)}% below 80%`);
  });

  it('documents all incorrect engine behaviors for investigation', () => {
    const failures = results.failures || [];
    console.log(`    Total incorrect behaviors: ${failures.length}`);
    for (const f of failures.slice(0, 5)) {
      const label = f.shouldFlag ? 'MISSED' : 'FALSE POS';
      console.log(`      ${f.id} [${label}] ${f.ruleId}: ${f.text?.slice(0, 60)}`);
    }
    // This test always passes — it's informational
    assert.ok(true);
  });
});
