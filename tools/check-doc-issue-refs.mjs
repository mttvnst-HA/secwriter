/**
 * Flags stale issue/PR status citations in project docs.
 *
 * Scans given files (default: CLAUDE.md) for #NNN references. For each
 * reference sitting near "pending" / "quarantined" / "blocked on" / etc.
 * language, checks the actual GitHub issue/PR state via `gh` — if it's
 * already closed or merged, the doc's framing is stale.
 *
 * Motivated by the 2026-07-02 case: CLAUDE.md's Testing Rules #10 said
 * `collab.spec.js` was `test.fixme` "pending #248" for over a week after
 * #248 closed and the fix (PR #251) landed — a different section of the
 * same doc had already been updated, but this citation wasn't caught
 * because nothing grepped for the issue number itself.
 *
 * Usage:
 *   node tools/check-doc-issue-refs.mjs                # checks CLAUDE.md
 *   node tools/check-doc-issue-refs.mjs CLAUDE.md README.md docs/adr/*.md
 *
 * Requires: `gh` CLI authenticated against this repo (relies on
 * `git remote -v` auto-detection, same as docs/agents/issue-tracker.md).
 * Exit code 1 if any suspect citation is found, 0 otherwise.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const STALE_KEYWORDS = [
  'pending',
  'quarantined',
  'quarantine',
  'blocked on',
  'blocked by',
  'waiting on',
  'unquarantine when',
  'not yet',
  'until #',
  'when #',
  'still open',
  'currently broken',
  'currently failing',
];

// A sentence that trips a STALE_KEYWORDS hit but also uses one of these
// words is almost always describing a resolution retrospectively (e.g. "the
// old quarantine root cause... FIXED and live") rather than making a live
// stale-status claim. Suppress rather than flag — false negatives here just
// mean a human catches it in review; false positives train reviewers to
// ignore the tool.
const RESOLUTION_OVERRIDE_KEYWORDS = ['fixed', 'resolved', 'landed', 'merged', 'no longer', ' live '];

// Split into rough "sentences" so a keyword three bullet points away from a
// ref doesn't count as co-occurrence (fixed-radius matching false-positived
// on this in testing — e.g. "quarantine" in one Testing Rule bleeding into
// an unrelated #NNN two sentences later). Lookbehind allows trailing "**"
// (markdown bold close) so a bolded sentence-ending doesn't suppress the
// split; lookahead requires an uppercase letter, digit, or markdown marker
// after the break so "e.g." abbreviations don't get split mid-sentence.
function splitSentences(text) {
  const pieces = text.split(/(?<=[.!?]\*{0,2})\s+(?=[A-Z0-9`*[])/);
  const sentences = [];
  let cursor = 0;
  for (const piece of pieces) {
    const start = text.indexOf(piece, cursor);
    sentences.push({ text: piece, start });
    cursor = start + piece.length;
  }
  return sentences;
}

function keywordRegex(keyword) {
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\b`, 'i');
}

function fetchStateMap() {
  const map = new Map();
  const queries = [
    [['issue', 'list', '--state', 'all', '--limit', '1000', '--json', 'number,state'], 'issue'],
    [['pr', 'list', '--state', 'all', '--limit', '1000', '--json', 'number,state'], 'pr'],
  ];
  for (const [args, kind] of queries) {
    const out = execFileSync('gh', args, { encoding: 'utf8' });
    for (const { number, state } of JSON.parse(out)) {
      map.set(number, { state, kind });
    }
  }
  return map;
}

function lineNumberAt(text, index) {
  return text.slice(0, index).split('\n').length;
}

function findSuspects(file, text, stateMap) {
  const suspects = [];
  const sentences = splitSentences(text);
  const refRe = /#(\d+)/g;

  for (const sentence of sentences) {
    refRe.lastIndex = 0;
    let match;
    while ((match = refRe.exec(sentence.text))) {
      const num = Number(match[1]);
      const entry = stateMap.get(num);
      if (!entry) continue;
      const isClosed = entry.state === 'CLOSED' || entry.state === 'MERGED';
      if (!isClosed) continue;

      const hitKeyword = STALE_KEYWORDS.find((kw) => keywordRegex(kw).test(sentence.text));
      if (!hitKeyword) continue;
      const lowerSentence = sentence.text.toLowerCase();
      if (RESOLUTION_OVERRIDE_KEYWORDS.some((kw) => lowerSentence.includes(kw))) continue;

      suspects.push({
        file,
        line: lineNumberAt(text, sentence.start + match.index),
        number: num,
        kind: entry.kind,
        state: entry.state,
        keyword: hitKeyword,
        snippet: sentence.text.replace(/\s+/g, ' ').trim(),
      });
    }
  }
  return suspects;
}

function main() {
  const files = process.argv.slice(2);
  const targets = files.length ? files : ['CLAUDE.md'];

  const stateMap = fetchStateMap();
  const allSuspects = targets.flatMap((file) => {
    const text = fs.readFileSync(file, 'utf8');
    return findSuspects(file, text, stateMap);
  });

  if (allSuspects.length === 0) {
    console.log(`No stale issue/PR citations found in: ${targets.join(', ')}`);
    return 0;
  }

  console.log(`Found ${allSuspects.length} possibly stale citation(s):\n`);
  for (const s of allSuspects) {
    console.log(`${s.file}:${s.line} — #${s.number} is ${s.state} (${s.kind}), but nearby text says "${s.keyword}"`);
    console.log(`  ...${s.snippet}...\n`);
  }
  return 1;
}

process.exit(main());
