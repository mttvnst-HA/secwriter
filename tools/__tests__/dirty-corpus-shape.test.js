/**
 * Regression: dirty-corpus shape contract (#137 follow-up).
 *
 * `tools/run-ai-corpus.mjs` reads `block.dirty` as the source text for the
 * AI tier. An earlier draft read `block.text || block.html`, both of which
 * are absent from `corpus/dirty/all_dirty.json` — the runner silently
 * short-circuited every block with `correctness: 1.0` and never invoked the
 * API. If the corpus is ever regenerated and the key renamed, this test
 * tells us before the runner is shipped into a paid run.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getRules, runStaticRules } from '../../src/lib/compliance-rules.js';

const rules = getRules();

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const DIRTY_PATH = join(__dirname, '..', '..', 'corpus', 'dirty', 'all_dirty.json');

describe('dirty corpus — shape contract for run-ai-corpus.mjs', () => {
  const dirty = JSON.parse(readFileSync(DIRTY_PATH, 'utf-8'));
  const violated = dirty.filter(b => Array.isArray(b.violations) && b.violations.length > 0);

  it('has blocks with violations', () => {
    expect(violated.length).toBeGreaterThan(0);
  });

  it('every violated block has `dirty` as a non-empty string', () => {
    for (const block of violated.slice(0, 50)) {
      expect(typeof block.dirty).toBe('string');
      expect(block.dirty.length).toBeGreaterThan(0);
    }
  });

  it('runStaticRules(block.dirty, id, rules) actually triggers violations', () => {
    const sample = violated[0];
    const findings = runStaticRules(sample.dirty, sample.id, rules);
    expect(Array.isArray(findings)).toBe(true);
    expect(findings.length).toBeGreaterThan(0);
  });
});
