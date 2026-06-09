#!/usr/bin/env node
/**
 * Corpus Test Harness (Phase 1.3)
 *
 * Runs SecWriter's three text-analysis engines against corpus JSON files in batch.
 * Engines: static UFS rules, NLP (compromise.js), grammar (Harper.js LocalLinter).
 *
 * Harper.js approach: Option A — LocalLinter (no Web Worker). Harper.js exposes
 * LocalLinter + binaryInlined which runs WASM synchronously in-process. Confirmed
 * working in Node.js. Results accessed via to_json() on each lint item.
 *
 * Usage:
 *   node tools/run-corpus-test.mjs                          # Run calibration corpus
 *   node tools/run-corpus-test.mjs --corpus clean           # Run clean corpus
 *   node tools/run-corpus-test.mjs --corpus dirty           # Run dirty corpus
 *   node tools/run-corpus-test.mjs --no-grammar             # Skip Harper (faster)
 *   node tools/run-corpus-test.mjs --section 03_30_00       # Single section only
 *   node tools/run-corpus-test.mjs --with-ignores           # Filter findings via corpus/fixtures/ignored-fixture.json
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');

// --- Parse CLI args ---
const args = process.argv.slice(2);
const corpusType = args.includes('--corpus') ? args[args.indexOf('--corpus') + 1] : 'calibration';
const skipGrammar = args.includes('--no-grammar');
const singleSection = args.includes('--section') ? args[args.indexOf('--section') + 1] : null;
const withIgnores = args.includes('--with-ignores');

// Adversarial corpus has a different shape (entries with expected behavior,
// not blocks to scan). Delegate to the dedicated scorer.
if (corpusType === 'adversarial') {
  await import('./score-adversarial.mjs');
  process.exit(0);
}

// --- Load ignored-findings fixture (--with-ignores) ---
// ignoredKeys: Set<string> of 24-char ignoreKey hex values to suppress.
// mutedRules:  Set<string> of ruleId values to suppress entirely.
// Both are empty when --with-ignores is not passed (no filtering).
//
// NOTE: blockHash values in the fixture are fingerprintBlock(block.text) —
// SHA-256 of the corpus block's plain-text content, truncated to 24 hex chars.
// They are DISTINCT from live-app blockHash values (which fingerprint block.html).
// computeIgnoreKey is identical in both contexts: SHA-256 of JSON.stringify([ruleId, blockHash, match]).
let ignoredKeys = new Set();
let mutedRules = new Set();
if (withIgnores) {
  const fixturePath = join(PROJECT_ROOT, 'corpus', 'fixtures', 'ignored-fixture.json');
  if (existsSync(fixturePath)) {
    const fixture = JSON.parse(readFileSync(fixturePath, 'utf-8'));
    for (const entry of (fixture.ignoredFindings || [])) {
      if (!entry.tombstone && entry.ignoreKey && !entry.ignoreKey.startsWith('placeholder')) {
        ignoredKeys.add(entry.ignoreKey);
      }
    }
    for (const entry of (fixture.mutedNlpRules || [])) {
      if (!entry.tombstone && entry.ruleId) {
        mutedRules.add(entry.ruleId);
      }
    }
    console.log(`--with-ignores: loaded fixture (${ignoredKeys.size} ignored keys, ${mutedRules.size} muted rules)`);
  } else {
    console.warn(`--with-ignores: fixture not found at ${fixturePath} — continuing without filtering`);
  }
}

// Same ignore-key derivation as linting.computeIgnoreKey (linting.js:374).
// Duplicated here so the corpus tool has no browser-API dependency.
async function computeCorpusIgnoreKey(ruleId, blockHash, match) {
  const text = JSON.stringify([ruleId, blockHash, match]);
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const view = new Uint8Array(digest);
  let out = '';
  for (let i = 0; i < view.length && out.length < 24; i++) {
    out += view[i].toString(16).padStart(2, '0');
  }
  return out.slice(0, 24);
}

// Same fingerprint derivation as lint-sidecar.fingerprintBlock (lint-sidecar.js:72).
// In the corpus tool, block.text (plain text) is fingerprinted — not block.html.
// See fixture _comment for details.
async function fingerprintCorpusBlock(text) {
  const str = typeof text === 'string' ? text : '';
  const bytes = new TextEncoder().encode(str);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const view = new Uint8Array(digest);
  let out = '';
  for (let i = 0; i < view.length && out.length < 24; i++) {
    out += view[i].toString(16).padStart(2, '0');
  }
  return out.slice(0, 24);
}

// --- Load engines ---
console.log('Loading engines...');

// Static UFS rules
const { getRules, runStaticRules } = await import('../src/lib/compliance-rules.js');
const rules = getRules();
console.log(`  Static rules: ${rules.length} rules loaded`);

// NLP rules (compromise.js)
const { detectNlpIssues, preloadNlp } = await import('../src/lib/nlp-rules.js');
await preloadNlp();
console.log('  NLP: compromise.js loaded');

// --- Shared production filters (single source of truth) ---
const {
  ENGINEERING_TERMS,
  DISABLED_RULES,
  shouldSuppressGrammarFinding,
} = await import('../src/lib/grammar-checker.js');
const EMPTY_USER_DICT = new Set();

// Harper.js grammar (optional)
let harperLinter = null;
if (!skipGrammar) {
  try {
    // harper.js 2.0 moved binary variants to separate subpath exports.
    const [{ LocalLinter }, { binaryInlined }] = await Promise.all([
      import('harper.js'),
      import('harper.js/binaryInlined'),
    ]);
    harperLinter = new LocalLinter({ binary: binaryInlined });
    // Warm up WASM
    const warmup = await harperLinter.lint('Test sentence.');
    // Mirror production init: import engineering dictionary + disable noisy rules
    await harperLinter.importWords(ENGINEERING_TERMS);
    const cfg = await harperLinter.getLintConfig();
    Object.assign(cfg, DISABLED_RULES);
    await harperLinter.setLintConfig(cfg);
    console.log(`  Grammar: Harper.js LocalLinter ready (warmup: ${warmup.length} findings, dict: ${ENGINEERING_TERMS.length} terms)`);
  } catch (err) {
    console.warn(`  Grammar: Harper.js failed to init: ${err.message}`);
    console.warn('  Continuing without grammar checks (use --no-grammar to suppress)');
  }
}

/**
 * Filter Harper results using the same logic as the production checkGrammar()
 * pipeline. Source of truth lives in src/lib/grammar-checker.js.
 */
function filterHarperResults(results, text) {
  const filtered = [];
  for (const item of results) {
    try {
      const json = item.to_json();
      const parsed = typeof json === 'string' ? JSON.parse(json) : json;
      const problemText = parsed.problem_text || text.substring(parsed.span.start, parsed.span.end);
      const lintKind = parsed.inner?.lint_kind;

      if (shouldSuppressGrammarFinding(problemText, EMPTY_USER_DICT, lintKind)) continue;

      // Skip suggestions that introduce spaces into single words
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
        match: problemText,
        index: parsed.span.start,
        message: parsed.inner?.message || parsed.message || '',
        severity: 'info',
        engine: 'grammar',
        category: parsed.inner?.lint_kind || 'Unknown',
      });
    } catch (e) {
      // Skip malformed results
    }
  }
  return filtered;
}

// --- Load corpus ---
const corpusDir = join(PROJECT_ROOT, 'corpus', corpusType);
if (!existsSync(corpusDir)) {
  console.error(`\nCorpus directory not found: ${corpusDir}`);
  console.error(`Run extraction first: node tools/extract-corpus.mjs`);
  process.exit(1);
}

let corpusFile;
if (singleSection) {
  corpusFile = join(corpusDir, `${singleSection}.json`);
} else {
  corpusFile = join(corpusDir, `all_${corpusType}.json`);
}

if (!existsSync(corpusFile)) {
  console.error(`\nCorpus file not found: ${corpusFile}`);
  process.exit(1);
}

console.log(`\nLoading corpus: ${corpusFile}`);
const rawCorpus = JSON.parse(readFileSync(corpusFile, 'utf-8'));

// Normalize field names: dirty corpus uses 'dirty' field, others use 'text'.
// Dirty blocks also carry the section only in the id prefix ("03_30_00-P1-B17").
const corpus = rawCorpus.map(block => {
  const normalized = block.dirty && !block.text ? { ...block, text: block.dirty } : block;
  if (!normalized.section && typeof normalized.id === 'string' && normalized.id.includes('-')) {
    return { ...normalized, section: normalized.id.split('-')[0].replace(/_/g, ' ') };
  }
  return normalized;
});
console.log(`Corpus: ${corpus.length} blocks\n`);

// --- Run engines ---
const allFindings = [];
const stats = {
  blocksProcessed: 0,
  noteBlocksSkipped: { compliance: 0, nlp: 0 },
  findingsByEngine: { static: 0, nlp: 0, grammar: 0 },
  findingsByRule: {},
  findingsBySection: {},
  noteBlockFindings: { static: 0, nlp: 0, grammar: 0 },
};

const startTime = Date.now();
let lastProgress = 0;

for (let i = 0; i < corpus.length; i++) {
  const block = corpus[i];
  stats.blocksProcessed++;

  // Progress reporting (every 10%)
  const progress = Math.floor((i / corpus.length) * 10) * 10;
  if (progress > lastProgress) {
    lastProgress = progress;
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`  ${progress}% (${i}/${corpus.length} blocks, ${elapsed}s elapsed)`);
  }

  // --- Static rules ---
  const staticViolations = runStaticRules(block.text, block.id, rules, {
    isNoteBlock: block.isNote,
    skipBrackets: true,
  });

  for (const v of staticViolations) {
    const finding = {
      blockId: block.id,
      section: block.section,
      ruleId: v.ruleId || v.id,
      match: v.match || '',
      index: v.index ?? -1,
      severity: v.severity || 'warning',
      engine: 'static',
      category: v.category || '',
      message: v.message || '',
      isNoteBlock: block.isNote,
    };
    allFindings.push(finding);
    stats.findingsByEngine.static++;
    if (block.isNote) stats.noteBlockFindings.static++;
    const ruleKey = finding.ruleId;
    stats.findingsByRule[ruleKey] = (stats.findingsByRule[ruleKey] || 0) + 1;
    stats.findingsBySection[block.section] = (stats.findingsBySection[block.section] || 0) + 1;
  }

  // --- NLP rules ---
  const nlpViolations = detectNlpIssues(block.text, block.id, block.isNote);
  // detectNlpIssues returns [] for note blocks internally, but let's track it
  if (block.isNote && nlpViolations.length > 0) {
    stats.noteBlockFindings.nlp += nlpViolations.length;
  }

  for (const v of nlpViolations) {
    const finding = {
      blockId: block.id,
      section: block.section,
      ruleId: v.ruleId || v.id,
      match: v.match || '',
      index: v.index ?? -1,
      severity: v.severity || 'warning',
      engine: 'nlp',
      category: v.category || '',
      message: v.message || '',
      isNoteBlock: block.isNote,
    };
    allFindings.push(finding);
    stats.findingsByEngine.nlp++;
    const ruleKey = finding.ruleId;
    stats.findingsByRule[ruleKey] = (stats.findingsByRule[ruleKey] || 0) + 1;
    stats.findingsBySection[block.section] = (stats.findingsBySection[block.section] || 0) + 1;
  }

  // --- Grammar (Harper.js) ---
  if (harperLinter) {
    try {
      const grammarResults = await harperLinter.lint(block.text);
      const grammarFindings = filterHarperResults(grammarResults, block.text);

      for (const f of grammarFindings) {
        allFindings.push({
          ...f,
          blockId: block.id,
          section: block.section,
          isNoteBlock: block.isNote,
        });
        stats.findingsByEngine.grammar++;
        if (block.isNote) stats.noteBlockFindings.grammar++;
        stats.findingsByRule[f.ruleId] = (stats.findingsByRule[f.ruleId] || 0) + 1;
        stats.findingsBySection[block.section] = (stats.findingsBySection[block.section] || 0) + 1;
      }
    } catch (e) {
      // Skip blocks that crash Harper
    }
  }
}

const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
console.log(`  100% complete in ${elapsed}s\n`);

// --- Apply --with-ignores filter ---
// Runs as a post-pass so the main loop stays synchronous and easy to read.
// Findings are matched by: (1) ruleId in mutedRules set, or (2) ignoreKey match.
// Stats are rebuilt from the filtered set so reported numbers stay consistent.
if (withIgnores && (ignoredKeys.size > 0 || mutedRules.size > 0)) {
  console.log(`Applying ignore filter (${ignoredKeys.size} keys, ${mutedRules.size} muted rules)...`);
  const blockHashCache = new Map(); // block.id → 24-char hash

  const filtered = [];
  let suppressedCount = 0;
  for (const f of allFindings) {
    // Rule-level mute (mutedNlpRules)
    if (mutedRules.has(f.ruleId)) {
      suppressedCount++;
      continue;
    }
    // Per-finding ignore key — compute blockHash lazily, cache per block
    if (ignoredKeys.size > 0) {
      if (!blockHashCache.has(f.blockId)) {
        const blockText = corpus.find(b => b.id === f.blockId)?.text || '';
        blockHashCache.set(f.blockId, await fingerprintCorpusBlock(blockText));
      }
      const blockHash = blockHashCache.get(f.blockId);
      const key = await computeCorpusIgnoreKey(f.ruleId, blockHash, f.match);
      if (ignoredKeys.has(key)) {
        suppressedCount++;
        continue;
      }
    }
    filtered.push(f);
  }

  console.log(`Suppressed ${suppressedCount} findings (${allFindings.length} → ${filtered.length})\n`);

  // Replace allFindings and rebuild stats from filtered set
  allFindings.length = 0;
  allFindings.push(...filtered);

  // Rebuild per-engine / per-rule / per-section counters
  stats.findingsByEngine = { static: 0, nlp: 0, grammar: 0 };
  stats.findingsByRule = {};
  stats.findingsBySection = {};
  stats.noteBlockFindings = { static: 0, nlp: 0, grammar: 0 };
  for (const f of allFindings) {
    const eng = f.engine;
    if (eng === 'static') stats.findingsByEngine.static++;
    else if (eng === 'nlp') stats.findingsByEngine.nlp++;
    else if (eng === 'grammar') stats.findingsByEngine.grammar++;
    if (f.isNoteBlock) {
      if (eng === 'static') stats.noteBlockFindings.static++;
      else if (eng === 'nlp') stats.noteBlockFindings.nlp++;
      else if (eng === 'grammar') stats.noteBlockFindings.grammar++;
    }
    stats.findingsByRule[f.ruleId] = (stats.findingsByRule[f.ruleId] || 0) + 1;
    stats.findingsBySection[f.section] = (stats.findingsBySection[f.section] || 0) + 1;
  }
}

// --- Output results ---
const resultsDir = join(PROJECT_ROOT, 'corpus', 'results');
mkdirSync(resultsDir, { recursive: true });

const outputFile = join(resultsDir, `${corpusType}-results.json`);
writeFileSync(outputFile, JSON.stringify({
  metadata: {
    corpusType,
    corpusFile,
    blocksProcessed: stats.blocksProcessed,
    timestamp: new Date().toISOString(),
    elapsedSeconds: parseFloat(elapsed),
    grammarEnabled: !!harperLinter,
    withIgnores,
    ignoredKeysApplied: ignoredKeys.size,
    mutedRulesApplied: mutedRules.size,
  },
  stats,
  findings: allFindings,
}, null, 2));

console.log(`Results saved: ${outputFile}`);

// --- Print summary ---
console.log('\n' + '='.repeat(70));
console.log(`${corpusType.toUpperCase()} CORPUS RESULTS`);
console.log('='.repeat(70));
console.log(`Blocks processed: ${stats.blocksProcessed}`);
console.log(`Total findings: ${allFindings.length}`);
console.log(`  Static rules: ${stats.findingsByEngine.static}`);
console.log(`  NLP rules: ${stats.findingsByEngine.nlp}`);
console.log(`  Grammar: ${stats.findingsByEngine.grammar}`);

// Note block findings (should be zero for static/NLP — engine exemption test)
console.log(`\nNote block findings (exemption test):`);
console.log(`  Static on note blocks: ${stats.noteBlockFindings.static} (expect 0)`);
console.log(`  NLP on note blocks: ${stats.noteBlockFindings.nlp} (expect 0)`);
console.log(`  Grammar on note blocks: ${stats.noteBlockFindings.grammar} (acceptable)`);

// Per-rule breakdown
console.log('\nFindings by rule:');
const ruleEntries = Object.entries(stats.findingsByRule).sort((a, b) => b[1] - a[1]);
for (const [rule, count] of ruleEntries) {
  // Separate note-block findings from non-note
  const noteCount = allFindings.filter(f => f.ruleId === rule && f.isNoteBlock).length;
  const nonNoteCount = count - noteCount;
  const noteStr = noteCount > 0 ? ` (${noteCount} on notes)` : '';
  console.log(`  ${rule}: ${count}${noteStr}`);
}

// Per-section breakdown
console.log('\nFindings by section:');
for (const [section, count] of Object.entries(stats.findingsBySection)) {
  console.log(`  ${section}: ${count}`);
}

// FMT-001 regression check
const fmt001 = rules.find(r => r.id === 'FMT-001');
console.log(`\nFMT-001 regression check: ${fmt001 ? 'FAIL (rule exists!)' : 'PASS (rule absent)'}`);

// Cleanup
if (harperLinter?.dispose) {
  try { harperLinter.dispose(); } catch(e) {}
}

console.log(`\nDone in ${elapsed}s`);
