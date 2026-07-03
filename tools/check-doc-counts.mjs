/**
 * Flags stale generated/countable facts cited in CLAUDE.md — file counts,
 * data-file entry counts, corpus block/violation counts, test-file test
 * counts — against the actual current values.
 *
 * Motivated by the 2026-07-02 doc audit: CLAUDE.md's "Orientation" section
 * said "690 .SEC files" (fixed to 689), but a SECOND citation of the same
 * fact at the bottom of the file ("Parser validated against all 690 UFGS
 * files") was missed in that pass — same root cause as issue-ref citation
 * drift (tools/check-doc-issue-refs.mjs): one fact, cited twice, only one
 * copy gets updated. This script checks every known citation of a fact
 * against its current source of truth in one pass.
 *
 * Also caught a real (non-cosmetic) drift on first run: CLAUDE.md's corpus
 * section claimed "1,438 labeled injected violations" in the dirty corpus;
 * the actual committed `corpus/dirty/all_dirty.json` sums to 653. The 1,438
 * figure was likely the injection *plan's* target count, never reconciled
 * against what was actually generated/committed.
 *
 * Usage:
 *   node tools/check-doc-counts.mjs
 *
 * Exit code 1 if any check's actual value disagrees with the doc's cited
 * value, 0 otherwise.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CLAUDE_MD = readFileSync(path.join(ROOT, 'CLAUDE.md'), 'utf8');

function parseCount(str) {
  return Number(str.replace(/,/g, ''));
}

function readJson(relPath) {
  return JSON.parse(readFileSync(path.join(ROOT, relPath), 'utf8'));
}

function countUfgsMFiles() {
  return readdirSync(path.join(ROOT, 'reference/UFGS_M')).filter((f) => f.endsWith('.SEC')).length;
}

function countItBlocks(relPath) {
  const text = readFileSync(path.join(ROOT, relPath), 'utf8');
  return (text.match(/\bit(?:\.\w+)?\(/g) || []).length;
}

// Each check: a doc regex (capture group 1 = the cited number, comma-format
// allowed) matched against CLAUDE.md, and an `actual()` fn computing today's
// real value. A single fact can have multiple `docRegex` entries when it's
// cited more than once in the file — every citation is checked independently.
const CHECKS = [
  {
    label: 'UFGS_M .SEC file count (Orientation)',
    docRegex: /reference\/UFGS_M\/`\s*—\s*(\d+(?:,\d{3})*)\s*\.SEC files/,
    actual: countUfgsMFiles,
  },
  {
    label: 'UFGS_M .SEC file count (Known Parser Edge Cases)',
    docRegex: /validated against all (\d+(?:,\d{3})*) UFGS files/,
    actual: countUfgsMFiles,
  },
  {
    label: 'UMRL organization count',
    docRegex: /Unified Master Reference List\. (\d+(?:,\d{3})*) organizations/,
    actual: () => readJson('src/data/umrl.json').length,
  },
  {
    label: 'UMRL entry count',
    docRegex: /Unified Master Reference List\. \d+(?:,\d{3})* organizations, (\d+(?:,\d{3})*) entries/,
    actual: () => readJson('src/data/umrl.json').reduce((n, org) => n + (org.entries?.length || 0), 0),
  },
  {
    label: 'UMSL submittal entry count',
    docRegex: /Unified Master Submittal List\. (\d+(?:,\d{3})*) submittal entries/,
    actual: () => readJson('src/data/umsl.json').length,
  },
  {
    label: 'Calibration corpus block count',
    docRegex: /\*\*Calibration\*\*[^—]*—\s*(\d+(?:,\d{3})*) raw UFGS blocks/,
    actual: () => readJson('corpus/calibration/all_calibration.json').length,
  },
  {
    label: 'Dirty corpus block count',
    docRegex: /\*\*Dirty\*\*[^—]*—\s*(\d+(?:,\d{3})*) blocks with/,
    actual: () => readJson('corpus/dirty/all_dirty.json').length,
  },
  {
    label: 'Dirty corpus labeled-violation count',
    docRegex: /\d+(?:,\d{3})* blocks with (\d+(?:,\d{3})*) labeled injected violations/,
    actual: () => readJson('corpus/dirty/all_dirty.json').reduce((n, b) => n + (b.violations?.length || 0), 0),
  },
  {
    label: 'Adversarial corpus edge-case count',
    docRegex: /\*\*Adversarial\*\*[^—]*—\s*(\d+(?:,\d{3})*) edge cases/,
    actual: () => readJson('corpus/adversarial/adversarial.json').entries.length,
  },
  {
    label: 'migrate-pm-substrate.test.mjs test count (AT the 30-test cap)',
    docRegex: /migrate-pm-substrate\.test\.mjs.*AT the (\d+)-test cap/,
    actual: () => countItBlocks('server/__tests__/migrate-pm-substrate.test.mjs'),
  },
];

function main() {
  const results = [];
  for (const check of CHECKS) {
    const match = CLAUDE_MD.match(check.docRegex);
    if (!match) {
      results.push({ ...check, status: 'NOT FOUND', cited: null, actualValue: null });
      continue;
    }
    const cited = parseCount(match[1]);
    const actualValue = check.actual();
    results.push({
      ...check,
      status: cited === actualValue ? 'OK' : 'DRIFT',
      cited,
      actualValue,
    });
  }

  const drifted = results.filter((r) => r.status === 'DRIFT');
  const notFound = results.filter((r) => r.status === 'NOT FOUND');

  for (const r of results) {
    if (r.status === 'OK') console.log(`OK       ${r.label}: ${r.actualValue}`);
    else if (r.status === 'DRIFT') console.log(`DRIFT    ${r.label}: doc says ${r.cited}, actual is ${r.actualValue}`);
    else console.log(`SKIPPED  ${r.label}: citation pattern not found in CLAUDE.md (may have been reworded)`);
  }

  if (notFound.length) {
    console.log(`\n${notFound.length} check(s) skipped — the doc wording moved; update this script's regex.`);
  }
  if (drifted.length) {
    console.log(`\n${drifted.length} stale count(s) found — update CLAUDE.md.`);
    return 1;
  }
  console.log('\nAll countable facts match.');
  return 0;
}

process.exit(main());
