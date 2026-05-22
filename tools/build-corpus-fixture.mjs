#!/usr/bin/env node
/**
 * Build real ignored-fixture entries from calibration corpus FPs (#140).
 *
 * Replaces the placeholder entries in corpus/fixtures/ignored-fixture.json
 * with hand-curated suppressions for the highest-volume false-positive
 * rule+match pairs in the calibration corpus.
 *
 * Calibration is unmodified UFGS text — every static finding is, by
 * definition, a false positive. We project the top N rule+match pairs
 * into per-block entries: each finding becomes one ignoredFindings entry
 * with a real blockHash (fingerprintBlock of the corpus block.text) and
 * real ignoreKey (SHA-256-prefix of [ruleId, blockHash, match]).
 *
 * Usage:
 *   node tools/build-corpus-fixture.mjs              # rebuild fixture
 *   node tools/run-corpus-test.mjs --with-ignores    # measure FP reduction
 *
 * The hash derivations mirror tools/run-corpus-test.mjs (fingerprintCorpusBlock
 * + computeCorpusIgnoreKey) which themselves duplicate the browser-side helpers
 * in src/lib/lint-sidecar.js and src/lib/linting.js.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');

// The rule+match pairs we suppress. Hand-picked from calibration FP frequencies
// (run `node tools/build-corpus-fixture.mjs --report` to recompute) — these are
// terms the live app flags but that experienced spec engineers routinely accept
// in context (e.g. "any" in "do not allow any moisture", "per" in citations).
const SUPPRESSED_PAIRS = [
  { ruleId: 'TERM-any', match: 'any' },
  { ruleId: 'TERM-conforming-to', match: 'conforming to' },
  { ruleId: 'TERM-suitable', match: 'suitable' },
  { ruleId: 'TERM-per', match: 'per' },
  { ruleId: 'TERM-adequate', match: 'adequate' },
  { ruleId: 'TERM-securely', match: 'securely' },
  { ruleId: 'VAGUE-applicable', match: 'applicable' },
  { ruleId: 'TERM-properly', match: 'properly' },
  { ruleId: 'TERM-furnish', match: 'Furnish' },
  { ruleId: 'TERM-to-be', match: 'are to be' },
  { ruleId: 'TERM-to-be', match: 'is to be' },
  { ruleId: 'CAP-Contract', match: 'contract' },
  { ruleId: 'TERM-thoroughly', match: 'thoroughly' },
  { ruleId: 'TERM-carefully', match: 'carefully' },
  { ruleId: 'TERM-as-necessary', match: 'as necessary' },
];

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

async function main() {
  const reportOnly = process.argv.includes('--report');
  const calibration = JSON.parse(readFileSync(
    join(PROJECT_ROOT, 'corpus', 'results', 'calibration-results.json'),
    'utf-8',
  ));
  const corpus = JSON.parse(readFileSync(
    join(PROJECT_ROOT, 'corpus', 'calibration', 'all_calibration.json'),
    'utf-8',
  ));
  const blocksById = new Map();
  for (const b of corpus) blocksById.set(b.id, b);

  if (reportOnly) {
    const counter = new Map();
    for (const f of calibration.findings) {
      if (f.engine !== 'static' || f.isNoteBlock) continue;
      const k = `${f.ruleId}|${f.match}`;
      counter.set(k, (counter.get(k) || 0) + 1);
    }
    const top = [...counter.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25);
    console.log('Top static FP rule+match pairs in calibration (non-note):');
    for (const [k, n] of top) console.log(`  ${String(n).padStart(4)} × ${k}`);
    return;
  }

  const matcher = new Set(SUPPRESSED_PAIRS.map(p => `${p.ruleId}|${p.match}`));
  const ignoredFindings = [];
  const ts = 1716326400000; // Fixed timestamp for byte-stable fixture round-trip.

  let skipped = 0;
  for (const f of calibration.findings) {
    if (f.engine !== 'static' || f.isNoteBlock) continue;
    const key = `${f.ruleId}|${f.match}`;
    if (!matcher.has(key)) continue;
    const block = blocksById.get(f.blockId);
    if (!block || typeof block.text !== 'string') { skipped++; continue; }
    const blockHash = await fingerprintCorpusBlock(block.text);
    const ignoreKey = await computeCorpusIgnoreKey(f.ruleId, blockHash, f.match);
    ignoredFindings.push({
      ignoreKey,
      ruleId: f.ruleId,
      blockHash,
      match: f.match,
      ts,
      authorId: 'corpus-fixture',
    });
  }

  // Sort by ignoreKey for deterministic output (matches encodeSidecarV2 ordering).
  ignoredFindings.sort((a, b) => a.ignoreKey.localeCompare(b.ignoreKey));

  const fixture = {
    v: 2,
    _comment: `Real ignored-fixture entries generated from calibration corpus FPs. ` +
      `Suppresses ${SUPPRESSED_PAIRS.length} hand-picked rule+match pairs — top false-positive ` +
      `patterns in unmodified UFGS text where context routinely justifies the flagged term. ` +
      `Regenerate via 'node tools/build-corpus-fixture.mjs'; measure FP reduction via ` +
      `'node tools/run-corpus-test.mjs --corpus calibration --with-ignores'. ` +
      `blockHash = fingerprintBlock(block.text) — SHA-256/24 of the corpus block plain-text content ` +
      `(DISTINCT from live-app blockHash which fingerprints block.html). ` +
      `ignoreKey = computeIgnoreKey(ruleId, blockHash, match) — SHA-256/24 of JSON.stringify([ruleId, blockHash, match]).`,
    ignoredFindings,
    mutedNlpRules: [],
  };

  const outPath = join(PROJECT_ROOT, 'corpus', 'fixtures', 'ignored-fixture.json');
  writeFileSync(outPath, JSON.stringify(fixture, null, 2) + '\n');
  console.log(`Wrote ${ignoredFindings.length} entries to ${outPath} (${SUPPRESSED_PAIRS.length} rule+match pairs, ${skipped} skipped for missing block)`);
}

main().catch(err => { console.error(err); process.exit(1); });
