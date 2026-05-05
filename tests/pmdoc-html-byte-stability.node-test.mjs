/**
 * pmdoc-html byte-stability property test (issue #47, sub-PR 1c gate per Q30).
 *
 * For every block html string extracted from every .SEC file in
 * reference/UFGS_M/, the round trip
 *   pass1 = pmFragmentToHtml(htmlToPmFragment(html))
 *   pass2 = pmFragmentToHtml(htmlToPmFragment(pass1))
 * must satisfy pass2 === pass1 (idempotent after one normalization pass).
 *
 * Documented normalization (intentional, byte-stable on second pass):
 *   - <em>      → <i>           (italic mark canonicalization)
 *   - <strong>  → <b>           (bold mark canonicalization)
 *   - tag-label spans removed   (editor-UI artifact, never content)
 *   - adjacent identical marks merged (e.g. <b>a</b><b>b</b> → <b>ab</b>)
 *   - attribute order canonicalized (class then data-* then style, in
 *     buildTags order)
 *
 * Runner: Node built-in test runner (not Vitest) — same pattern as
 * ufgs-structural.node-test.mjs / interop.node-test.mjs. Avoids Vitest
 * worker memory pressure on the 690-file corpus.
 *
 * Run via `npm run test:byte-stability`.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseHTML } from 'linkedom';

const { DOMParser } = parseHTML('');
globalThis.DOMParser = DOMParser;

const { parseSEC } = await import('../src/lib/sec-parser.js');
const { pmFragmentToHtml, htmlToPmFragment } = await import('../src/lib/pmdoc-html.js');

const UFGS_DIR = 'reference/UFGS_M';

const files = fs.readdirSync(UFGS_DIR)
  .filter((f) => f.toLowerCase().endsWith('.sec'))
  .map((f) => path.join(UFGS_DIR, f));

// Pull every html-bearing block from every file. Block types with html: title,
// txt, note, oli, item, lst (single-line inline content). Skip ref/table/tbl —
// their html lives in nested data structures and is exercised by the 1d
// interop test, not 1c's byte-stability gate.
const HTML_BLOCK_TYPES = new Set(['title', 'txt', 'note', 'oli', 'item', 'lst']);

function collectHtmlSamples() {
  const samples = []; // { file, blockId, type, html }
  for (const file of files) {
    let blocks;
    try {
      const raw = fs.readFileSync(file, 'latin1');
      blocks = parseSEC(raw);
    } catch {
      continue; // skip files the parser rejects (none expected — covered by ufgs-structural)
    }
    if (!Array.isArray(blocks)) continue;
    for (const b of blocks) {
      if (!HTML_BLOCK_TYPES.has(b.type)) continue;
      if (typeof b.html !== 'string' || b.html.length === 0) continue;
      samples.push({
        file: path.basename(file),
        blockId: b.id,
        type: b.type,
        html: b.html,
      });
    }
  }
  return samples;
}

const samples = collectHtmlSamples();

describe('pmdoc-html byte-stability across UFGS_M corpus', () => {
  it(`extracts >= 100 html samples from ${files.length} .SEC files`, () => {
    assert.equal(files.length >= 690, true, `expected ≥ 690 .SEC files, got ${files.length}`);
    assert.equal(
      samples.length >= 100,
      true,
      `expected ≥ 100 html samples, got ${samples.length}`,
    );
  });

  it('every sample is idempotent after one normalization pass (pass2 === pass1)', () => {
    const failures = [];
    for (const s of samples) {
      let pass1, pass2;
      try {
        pass1 = pmFragmentToHtml(htmlToPmFragment(s.html));
        pass2 = pmFragmentToHtml(htmlToPmFragment(pass1));
      } catch (err) {
        failures.push({ ...s, error: err.message });
        continue;
      }
      if (pass1 !== pass2) {
        failures.push({
          ...s,
          pass1: pass1.length > 200 ? pass1.slice(0, 200) + '…' : pass1,
          pass2: pass2.length > 200 ? pass2.slice(0, 200) + '…' : pass2,
        });
      }
    }
    if (failures.length > 0) {
      // Only print the first 5 failures to keep stderr readable.
      const preview = failures.slice(0, 5).map((f) => JSON.stringify(f)).join('\n');
      assert.fail(
        `${failures.length}/${samples.length} samples broke byte-stability.\nFirst 5:\n${preview}`,
      );
    }
  });

  it('round-trip never throws across the corpus (Q31/E6 adversarial fallback holds)', () => {
    const throws = [];
    for (const s of samples) {
      try {
        pmFragmentToHtml(htmlToPmFragment(s.html));
      } catch (err) {
        throws.push({ ...s, error: err.message });
      }
    }
    if (throws.length > 0) {
      const preview = throws.slice(0, 3).map((f) => JSON.stringify(f)).join('\n');
      assert.fail(
        `${throws.length}/${samples.length} samples threw during round-trip.\nFirst 3:\n${preview}`,
      );
    }
  });

  // The ratio of samples whose html is unchanged by the round-trip is the
  // useful corpus-pass-rate metric reported in the PR description. This test
  // doesn't assert a threshold — it just records the rate so a regression
  // shows up clearly in CI logs.
  it('records round-trip identity rate (no threshold; informational)', () => {
    let identical = 0;
    for (const s of samples) {
      const out = pmFragmentToHtml(htmlToPmFragment(s.html));
      if (out === s.html) identical++;
    }
    const rate = (identical / samples.length) * 100;
    // Use stdout via console.log so node:test doesn't suppress it.
    // eslint-disable-next-line no-console
    console.log(
      `[corpus] round-trip identity: ${identical}/${samples.length} = ${rate.toFixed(2)}%`,
    );
    // Sanity: rate must be at least 30% (well below typical; this is just a
    // smoke test to catch a bulk regression where everything normalizes).
    assert.equal(rate >= 30, true, `round-trip identity rate ${rate.toFixed(2)}% suspiciously low`);
  });
});
