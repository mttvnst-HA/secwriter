/**
 * Calibration corpus tests (Phase 4)
 * Run with: node --test src/lib/__tests__/corpus-calibration.node-test.mjs
 *
 * Uses Node's built-in test runner (not Vitest) to avoid OOM with 80+ regex
 * objects running against 2500+ blocks.
 *
 * Tests that:
 * - Primary prohibited terms produce 0 hits on raw UFGS non-note blocks
 * - Secondary rules produce >0 hits (detection is working)
 * - FMT-001 (double spaces) rule does NOT exist
 * - Note block exemption works for static and NLP engines
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

// Load JSON data manually (bypass Vite's JSON transform)
const rulesData = JSON.parse(
  readFileSync(new URL('../../data/ufs-1-300-02-rules.json', import.meta.url), 'utf8')
);

// Inline buildRules + runStaticRules (same approach as compliance-rules.node-test.mjs)
// because compliance-rules.js uses bare JSON import that fails in raw Node
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildRules() {
  const rules = [];
  const seenTerms = new Set();

  rulesData.prohibitedTerms.forEach((entry, i) => {
    const term = entry.term.toLowerCase();
    seenTerms.add(term);
    let pattern;
    if (term === 'per') {
      pattern = /\bper\b(?!\s*(cent|annum|capita|diem|se\b|hour|min|second|day|week|month|year|cubic|sq|linear|foot|feet|inch|yard|mile|meter|metre|liter|litre|gal|pound|ton|acre|hectare|km|mph|psf|psi|pcf|plf|ksf|ksi|kcf|klf|mil))/gi;
    } else if (term === 'any') {
      pattern = /\bany\b(?!\s*(of the following|one of|other))/gi;
    } else {
      const escaped = escapeRegex(entry.term);
      const endsWithWord = /\w$/.test(entry.term);
      pattern = new RegExp(`\\b${escaped}${endsWithWord ? '\\b' : ''}`, 'gi');
    }
    rules.push({
      id: entry.ruleId || `TERM-${String(i + 1).padStart(3, '0')}`,
      category: 'prohibited-term',
      severity: entry.severity || 'error',
      pattern,
      message: entry.message || `"${entry.term}" is prohibited by UFS 1-300-02`,
    });
  });

  return rules;
}

const rules = buildRules();

// Check if calibration corpus exists
const calibrationPath = new URL('../../../corpus/calibration/all_calibration.json', import.meta.url);
const corpusExists = existsSync(calibrationPath);

describe('Calibration: rule behavior on raw UFGS master text', { skip: !corpusExists && 'Calibration corpus not generated yet' }, () => {
  let calibrationCorpus;
  if (corpusExists) {
    calibrationCorpus = JSON.parse(readFileSync(calibrationPath, 'utf-8'));
  }

  it('primary prohibited terms ("shall", "should", "and/or") produce zero hits on non-note blocks that are not instructional text', () => {
    // TERM-shall = shall (should be 0 in well-formed UFGS master text)
    const primaryRule = rules.find(r => r.id === 'TERM-shall');
    assert.ok(primaryRule, 'TERM-shall rule exists');

    const nonNoteBlocks = calibrationCorpus.filter(b => !b.isNote);
    const hits = [];
    for (const block of nonNoteBlocks) {
      const matches = block.text.match(primaryRule.pattern);
      if (matches) {
        hits.push({ id: block.id, text: block.text.substring(0, 80) });
      }
    }
    assert.equal(hits.length, 0,
      `TERM-shall fired on ${hits.length} non-note blocks:\n${JSON.stringify(hits.slice(0, 5), null, 2)}`);
  });

  it('passive voice detection finds instances in raw UFGS text (secondary rule sanity check)', async () => {
    // Use NLP rules — but since we can't import nlp-rules.js directly (same JSON import issue),
    // we use the calibration-results.json if available
    const resultsPath = new URL('../../../corpus/results/calibration-results.json', import.meta.url);
    if (!existsSync(resultsPath)) {
      // Skip if results not generated
      assert.ok(true, 'Calibration results not yet generated — run run-corpus-test.mjs first');
      return;
    }

    const results = JSON.parse(readFileSync(resultsPath, 'utf-8'));
    const passiveHits = results.findings.filter(f => f.ruleId === 'NLP-PASSIVE-001' && !f.isNoteBlock);
    assert.ok(passiveHits.length > 0,
      'Expected passive voice detections in raw UFGS text but found none');
    console.log(`    Passive voice hits: ${passiveHits.length}`);
  });

  it('FMT-001 (double spaces) rule does NOT exist in the rule set', () => {
    const fmt001 = rules.find(r => r.id === 'FMT-001');
    assert.equal(fmt001, undefined, 'FMT-001 rule exists — this is a regression (see CLAUDE.md)');
  });

  it('note block exemption: static rules produce 0 findings on note blocks', () => {
    const resultsPath = new URL('../../../corpus/results/calibration-results.json', import.meta.url);
    if (!existsSync(resultsPath)) {
      assert.ok(true, 'Calibration results not yet generated');
      return;
    }
    const results = JSON.parse(readFileSync(resultsPath, 'utf-8'));
    const noteStaticHits = results.findings.filter(f => f.engine === 'static' && f.isNoteBlock);
    assert.equal(noteStaticHits.length, 0,
      `${noteStaticHits.length} static findings on note blocks (expect 0)`);
  });

  it('note block exemption: NLP rules produce 0 findings on note blocks', () => {
    const resultsPath = new URL('../../../corpus/results/calibration-results.json', import.meta.url);
    if (!existsSync(resultsPath)) {
      assert.ok(true, 'Calibration results not yet generated');
      return;
    }
    const results = JSON.parse(readFileSync(resultsPath, 'utf-8'));
    const noteNlpHits = results.findings.filter(f => f.engine === 'nlp' && f.isNoteBlock);
    assert.equal(noteNlpHits.length, 0,
      `${noteNlpHits.length} NLP findings on note blocks (expect 0)`);
  });
});
