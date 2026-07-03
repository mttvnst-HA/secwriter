/**
 * Flags dependency-version claims in CLAUDE.md that have drifted from
 * package.json — either a stale pin claim (doc says "exact 4.3.0", repo
 * now on 4.4.0) or a stale empirical-baseline claim (doc says "measured
 * against harper.js 2.0", repo now pins 2.4.0, corpus was never re-run).
 *
 * A mismatch is reported as ACKNOWLEDGED (not a failure) when the same
 * sentence already admits the drift — words like "stale", "post-#",
 * "now pins", "re-run" — so a deliberately-annotated known-gap (like the
 * harper.js 2.0-vs-2.4.0 baseline note added 2026-07-02) doesn't nag on
 * every run. An unacknowledged mismatch is a real DRIFT.
 *
 * Usage:
 *   node tools/check-doc-versions.mjs
 *
 * Exit code 1 if any unacknowledged DRIFT is found, 0 otherwise
 * (ACKNOWLEDGED and OK are both non-failing).
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { sentenceAround } from './doc-lint-utils.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CLAUDE_MD = readFileSync(path.join(ROOT, 'CLAUDE.md'), 'utf8');
const PKG = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

const ACK_WORDS = ['stale', 'post-#', 'now pins', 're-run', 'needs re-baseline', 'not yet re-'];

function depVersion(name) {
  const raw = PKG.dependencies?.[name] || PKG.devDependencies?.[name];
  return raw ? raw.replace(/^[\^~]/, '') : null;
}

function majorMinor(v) {
  return v.split('.').slice(0, 2).join('.');
}

// sentenceAround (tools/doc-lint-utils.mjs) finds the sentence containing a
// given index without breaking on periods inside things like "harper.js".

// Each entry: find every citation of a version in CLAUDE.md via `docRegex`
// (global, capture group 1 = cited version), compare against `actual()`,
// using `compare` to decide what "matches" means for that citation shape.
// docRegex is scoped as tightly as the doc's actual wording allows — a bare
// `harper\.js (\d+\.\d+)` also matches unrelated historical narrative
// ("the harper.js 1.12 → 2.0 bump in #57"), which isn't a currency claim.
const CHECKS = [
  {
    label: 'harper.js corpus baseline',
    docRegex: /Baseline \(June 2026, harper\.js (\d+\.\d+)/g,
    actual: () => majorMinor(depVersion('harper.js')),
    compare: 'exact',
  },
  {
    label: '@hocuspocus/* pinned version',
    docRegex: /pinned at exact `(\d+\.\d+\.\d+)`/g,
    actual: () => depVersion('@hocuspocus/server'),
    compare: 'exact',
  },
  {
    label: 'y-prosemirror major version',
    docRegex: /y-prosemirror`? is held at (\d+)\.x/g,
    actual: () => depVersion('y-prosemirror')?.split('.')[0],
    compare: 'exact',
  },
  {
    label: 'Node engine requirement',
    docRegex: /Node `?(>=\d+)`? required/g,
    actual: () => PKG.engines?.node,
    compare: 'exact',
  },
];

function main() {
  let unacknowledgedDrift = 0;
  let totalCitations = 0;

  for (const check of CHECKS) {
    const actualValue = check.actual();
    if (actualValue == null) {
      console.log(`SKIPPED  ${check.label}: package not found in package.json`);
      continue;
    }

    let match;
    let found = false;
    check.docRegex.lastIndex = 0;
    while ((match = check.docRegex.exec(CLAUDE_MD))) {
      found = true;
      totalCitations++;
      const cited = match[1];
      const context = sentenceAround(CLAUDE_MD, match.index);
      const isMatch = cited === actualValue;

      if (isMatch) {
        console.log(`OK           ${check.label}: cited "${cited}" matches actual "${actualValue}"`);
        continue;
      }
      const acknowledged = ACK_WORDS.some((w) => context.toLowerCase().includes(w));
      if (acknowledged) {
        console.log(`ACKNOWLEDGED ${check.label}: cited "${cited}" vs actual "${actualValue}" — doc already flags this as stale`);
      } else {
        console.log(`DRIFT        ${check.label}: cited "${cited}" vs actual "${actualValue}" — no acknowledgment found`);
        console.log(`  ...${context}...`);
        unacknowledgedDrift++;
      }
    }
    if (!found) {
      console.log(`SKIPPED      ${check.label}: no citation found in CLAUDE.md (wording may have moved)`);
    }
  }

  console.log(`\n${totalCitations} citation(s) checked, ${unacknowledgedDrift} unacknowledged drift(s).`);
  return unacknowledgedDrift > 0 ? 1 : 0;
}

process.exit(main());
