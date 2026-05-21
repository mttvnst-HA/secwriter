#!/usr/bin/env node
/**
 * Lint-block distribution analysis for #139.
 *
 * Walks the calibration + dirty corpora, computes per-block sentence count
 * and char count, and reports the distribution. Answers "is the 50-sentence
 * block premise real?" before we spend time on browser-side LoAF instrumentation.
 *
 * Sentence boundaries: Intl.Segmenter (one consistent definition for this pass;
 * not a recommendation for the production source — see #149).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = join(__dirname, '..');

const CORPORA = {
  calibration: join(ROOT, 'corpus/calibration/all_calibration.json'),
  dirty: join(ROOT, 'corpus/dirty/all_dirty.json'),
};

const segmenter = new Intl.Segmenter('en', { granularity: 'sentence' });

function sentenceCount(text) {
  if (!text) return 0;
  let n = 0;
  for (const _ of segmenter.segment(text)) n++;
  return n;
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

function summarize(arr) {
  const sorted = [...arr].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    n: sorted.length,
    mean: sorted.length ? +(sum / sorted.length).toFixed(1) : 0,
    p50: percentile(sorted, 50),
    p75: percentile(sorted, 75),
    p90: percentile(sorted, 90),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: sorted[sorted.length - 1] ?? 0,
  };
}

function bucketize(arr, buckets) {
  const counts = buckets.map(() => 0);
  for (const v of arr) {
    let placed = false;
    for (let i = 0; i < buckets.length; i++) {
      const [lo, hi] = buckets[i];
      if (v >= lo && v <= hi) { counts[i]++; placed = true; break; }
    }
    if (!placed && v > buckets[buckets.length - 1][1]) counts[counts.length - 1]++;
  }
  return counts;
}

console.log('# Lint-block distribution (#139 measurement gate)\n');

const allBlocks = [];

for (const [name, path] of Object.entries(CORPORA)) {
  const blocks = JSON.parse(readFileSync(path, 'utf8'));
  const stats = blocks.map(b => ({
    corpus: name,
    id: b.id,
    section: b.section,
    blockType: b.blockType,
    charCount: b.charCount ?? (b.text?.length ?? 0),
    sentenceCount: sentenceCount(b.text),
  }));
  allBlocks.push(...stats);

  const chars = stats.map(s => s.charCount);
  const sents = stats.map(s => s.sentenceCount);
  console.log(`## ${name} (${blocks.length} blocks)\n`);
  console.log('charCount:    ', summarize(chars));
  console.log('sentenceCount:', summarize(sents));
  console.log();

  const histBuckets = [
    [0, 0], [1, 1], [2, 2], [3, 3], [4, 5], [6, 10], [11, 20], [21, 50], [51, 100], [101, Infinity],
  ];
  const histCounts = bucketize(sents, histBuckets);
  console.log('  Sentence-count histogram:');
  histBuckets.forEach(([lo, hi], i) => {
    const label = hi === Infinity ? `${lo}+` : (lo === hi ? `${lo}` : `${lo}-${hi}`);
    const pct = ((histCounts[i] / blocks.length) * 100).toFixed(1);
    const bar = '#'.repeat(Math.round(histCounts[i] / blocks.length * 50));
    console.log(`    ${label.padStart(6)}: ${String(histCounts[i]).padStart(6)} (${pct.padStart(5)}%) ${bar}`);
  });
  console.log();
}

// Top-N longest blocks across both corpora
const topByChar = [...allBlocks].sort((a, b) => b.charCount - a.charCount).slice(0, 15);
const topBySent = [...allBlocks].sort((a, b) => b.sentenceCount - a.sentenceCount).slice(0, 15);

console.log('## Top 15 longest blocks by sentence count\n');
console.log('  corpus       sentences  chars  blockType  id');
for (const b of topBySent) {
  console.log(`  ${b.corpus.padEnd(12)} ${String(b.sentenceCount).padStart(9)} ${String(b.charCount).padStart(6)}  ${(b.blockType || '?').padEnd(10)} ${b.id}`);
}
console.log();

console.log('## Top 15 longest blocks by char count\n');
console.log('  corpus       chars  sentences  blockType  id');
for (const b of topByChar) {
  console.log(`  ${b.corpus.padEnd(12)} ${String(b.charCount).padStart(5)} ${String(b.sentenceCount).padStart(9)}  ${(b.blockType || '?').padEnd(10)} ${b.id}`);
}
console.log();

// By-block-type distribution (across both corpora)
const byType = new Map();
for (const b of allBlocks) {
  if (!byType.has(b.blockType)) byType.set(b.blockType, []);
  byType.get(b.blockType).push(b.sentenceCount);
}
console.log('## Per-block-type sentence-count distribution\n');
console.log('  blockType   n      mean  p50  p95  p99  max');
const types = [...byType.entries()].sort((a, b) => b[1].length - a[1].length);
for (const [type, sents] of types) {
  const s = summarize(sents);
  console.log(`  ${(type || '?').padEnd(10)} ${String(s.n).padStart(5)} ${String(s.mean).padStart(7)} ${String(s.p50).padStart(4)} ${String(s.p95).padStart(4)} ${String(s.p99).padStart(4)} ${String(s.max).padStart(4)}`);
}
console.log();

// Bottom-line gate questions
const allSents = allBlocks.map(b => b.sentenceCount);
const overall = summarize(allSents);
const over20 = allSents.filter(s => s > 20).length;
const over50 = allSents.filter(s => s > 50).length;
const over100 = allSents.filter(s => s > 100).length;

console.log('## Gate questions\n');
console.log(`  Total blocks across both corpora: ${allBlocks.length}`);
console.log(`  Overall p95 sentence count:       ${overall.p95}`);
console.log(`  Overall p99 sentence count:       ${overall.p99}`);
console.log(`  Overall max sentence count:       ${overall.max}`);
console.log(`  Blocks with > 20 sentences:       ${over20} (${(over20/allBlocks.length*100).toFixed(2)}%)`);
console.log(`  Blocks with > 50 sentences:       ${over50} (${(over50/allBlocks.length*100).toFixed(2)}%)`);
console.log(`  Blocks with > 100 sentences:      ${over100} (${(over100/allBlocks.length*100).toFixed(2)}%)`);
console.log();
console.log('  If p95 < 10 and max < 30: the "50-sentence-block" premise is fictional.');
console.log('  If p95 >= 10 and there are > 5 blocks with > 50 sentences: real long-tail.');
