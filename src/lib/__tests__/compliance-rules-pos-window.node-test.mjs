/**
 * Issue #156 — POS-window inline linting for TERM-suitable / TERM-any /
 * VAGUE-applicable and full-text quote tracking for TERM-should.
 *
 * Uses Node's built-in test runner (node:test) per CLAUDE.md Testing Rules
 * §5 — the regex-heavy compliance rule engine exhausts Vitest's worker
 * memory. Run via `npm run test:compliance` (uses `--import
 * ./tools/json-loader.mjs` so the module's bare JSON import resolves).
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

import { computeQuoteRanges, runStaticRules, getRules } from '../compliance-rules.js';
import { preloadNlp, isNlpReady } from '../nlp-rules.js';

before(async () => {
  preloadNlp();
  await new Promise(resolve => {
    const tick = () => (isNlpReady() ? resolve() : setTimeout(tick, 50));
    tick();
  });
});

describe('computeQuoteRanges', () => {
  it('returns empty for null/empty input', () => {
    assert.deepEqual(computeQuoteRanges(''), []);
    assert.deepEqual(computeQuoteRanges(null), []);
  });

  it('pairs alternating straight double quotes', () => {
    const text = 'interpret the word "should" as "must"';
    const ranges = computeQuoteRanges(text);
    assert.strictEqual(ranges.length, 2);
    assert.strictEqual(text.slice(ranges[0][0], ranges[0][1]), 'should');
    assert.strictEqual(text.slice(ranges[1][0], ranges[1][1]), 'must');
  });

  it('captures longer quoted spans up to the cap', () => {
    const text = 'The word should appear as written: "shall".';
    const ranges = computeQuoteRanges(text);
    assert.strictEqual(ranges.length, 1);
    assert.strictEqual(text.slice(ranges[0][0], ranges[0][1]), 'shall');
  });

  it('pairs curly double quotes directionally', () => {
    const text = 'render “should” as “must”';
    const ranges = computeQuoteRanges(text);
    assert.strictEqual(ranges.length, 2);
    assert.strictEqual(text.slice(ranges[0][0], ranges[0][1]), 'should');
    assert.strictEqual(text.slice(ranges[1][0], ranges[1][1]), 'must');
  });

  it('drops straight pairs whose inside-content exceeds the cap (stray-quote guard)', () => {
    // 90-char span between unmatched-looking quotes — exceeds 80-char cap.
    const filler = 'x'.repeat(90);
    const text = `"${filler}"`;
    assert.deepEqual(computeQuoteRanges(text), []);
  });
});

describe('runStaticRules — TERM-should quote suppression', () => {
  const rules = getRules();
  const run = (text) => runStaticRules(text, 'b', rules);

  it('suppresses "should" inside straight quotes', () => {
    const v = run('Interpret the word "should" as "must" in this spec.');
    assert.strictEqual(v.find(x => x.ruleId === 'TERM-should'), undefined);
  });

  it('suppresses "should" inside curly quotes', () => {
    const v = run('Interpret “should” as a recommendation.');
    assert.strictEqual(v.find(x => x.ruleId === 'TERM-should'), undefined);
  });

  it('still flags real "should" (cf. adversarial ADV-045)', () => {
    const v = run('The concrete should reach design strength before form removal.');
    assert.notStrictEqual(v.find(x => x.ruleId === 'TERM-should'), undefined);
  });
});

describe('runStaticRules — TERM-properly (ADV-066 regression)', () => {
  const rules = getRules();
  const run = (text) => runStaticRules(text, 'b', rules);

  // `properly` appears in BOTH prohibitedTerms (TERM-properly) and vagueTerms
  // (VAGUE-properly) in ufs-1-300-02-rules.json. buildRules() dedups by term
  // so only TERM-properly is built — VAGUE-properly never registers. This
  // pin protects against silent regressions of either side of that dedup.
  it('flags ADV-066 "Properly aligned as verified by transit survey..." as TERM-properly', () => {
    const v = run('Properly aligned as verified by transit survey to within 3 mm tolerance.');
    const properly = v.find(x => x.ruleId === 'TERM-properly');
    assert.notStrictEqual(properly, undefined);
    assert.strictEqual(properly.match, 'Properly');
  });

  it('does NOT register VAGUE-properly (deduped by buildRules)', () => {
    const ids = new Set(rules.map(r => r.id));
    assert.ok(ids.has('TERM-properly'), 'TERM-properly must be present');
    assert.ok(!ids.has('VAGUE-properly'), 'VAGUE-properly must be deduped');
  });
});

describe('runStaticRules — POS-window suppression (compromise required)', () => {
  const rules = getRules();
  const run = (text) => runStaticRules(text, 'b', rules);

  it('suppresses "suitable for ASTM D4263" (three-token adjacent specific reference)', () => {
    const v = run('Choose finish suitable for ASTM D4263.');
    assert.strictEqual(v.find(x => x.ruleId === 'TERM-suitable'), undefined);
  });

  it('still flags ADV-053 "suitable for exterior exposure"', () => {
    const v = run('Select a finish suitable for exterior exposure.');
    assert.notStrictEqual(v.find(x => x.ruleId === 'TERM-suitable'), undefined);
  });

  // Adjacent specific-noun phrase must still flag (POS-window doesn't widen
  // beyond the three-token adjacency rule).
  it('flags "suitable for exterior exposure per ASTM D4263" (per ASTM is far)', () => {
    const v = run('Choose a finish suitable for exterior exposure per ASTM D4263.');
    assert.notStrictEqual(v.find(x => x.ruleId === 'TERM-suitable'), undefined);
  });

  // ADV-065 regression — the pre-existing exclusion regex used a bare "the "
  // alternative that swallowed paraphrases like "suitable for the intended
  // application as defined in ASTM D4263." The exclusion now tightens "the"
  // to require a numeric/value token (digit or `#`) following, so vague
  // paraphrases flag while precise-dimension phrases continue to be skipped.
  it('flags ADV-065 "Suitable for the intended application as defined in ASTM D4263"', () => {
    const v = run('Suitable for the intended application as defined in ASTM D4263.');
    assert.notStrictEqual(v.find(x => x.ruleId === 'TERM-suitable'), undefined);
  });

  it('still suppresses "suitable for the 1-inch pipe" (digit after "the" — precise dimension)', () => {
    const v = run('Choose a valve suitable for the 1-inch pipe rated at 150 psi.');
    assert.strictEqual(v.find(x => x.ruleId === 'TERM-suitable'), undefined);
  });

  it('still suppresses "suitable for the #2 grade aggregate" (# after "the")', () => {
    const v = run('Use cement suitable for the #2 grade aggregate.');
    assert.strictEqual(v.find(x => x.ruleId === 'TERM-suitable'), undefined);
  });

  it('flags "suitable for the project" (vague paraphrase, no value after "the")', () => {
    const v = run('Select a finish suitable for the project conditions.');
    assert.notStrictEqual(v.find(x => x.ruleId === 'TERM-suitable'), undefined);
  });

  // Inline-definition suppression — "suitable" is cured when the same sentence
  // defines it concretely via "is defined as: …".
  it('suppresses "suitable ... is defined as: <criteria>" (inline definition)', () => {
    const v = run('Material suitable for topsoil is defined as: Natural, friable loam, free of subsoil, stumps, and rocks larger than 25 mm.');
    assert.strictEqual(v.find(x => x.ruleId === 'TERM-suitable'), undefined);
  });

  it('suppresses "suitable ... means: <criteria>"', () => {
    const v = run('Suitable backfill means: granular material with less than 5 percent passing the No. 200 sieve.');
    assert.strictEqual(v.find(x => x.ruleId === 'TERM-suitable'), undefined);
  });

  // ADV-065 must still flag — "defined in ASTM" is a pointer, not an inline
  // definition (no "defined as", no colon), so the marker must not match.
  it('still flags ADV-065 "as defined in ASTM D4263" (pointer, not inline definition)', () => {
    const v = run('Suitable for the intended application as defined in ASTM D4263.');
    assert.notStrictEqual(v.find(x => x.ruleId === 'TERM-suitable'), undefined);
  });

  // A definition in a LATER sentence must not suppress an earlier "suitable".
  it('flags "suitable" when the definition is in a different sentence', () => {
    const v = run('Use a suitable finish. The required grade is defined as: ASTM A36.');
    assert.notStrictEqual(v.find(x => x.ruleId === 'TERM-suitable'), undefined);
  });

  it('suppresses VAGUE-applicable in adverbial "as applicable" clause (clean-corpus pattern)', () => {
    const v = run('Place reinforcement in accordance with ASTM A934/A934M as applicable.');
    assert.strictEqual(v.find(x => x.ruleId === 'VAGUE-applicable'), undefined);
  });

  it('suppresses "when applicable" adverbial clause', () => {
    const v = run('Identify the function and, when applicable, the position.');
    assert.strictEqual(v.find(x => x.ruleId === 'VAGUE-applicable'), undefined);
  });

  it('still flags ADV-067 "The applicable codes and standards"', () => {
    const v = run('The applicable codes and standards listed in Section 01 42 00 govern.');
    assert.notStrictEqual(v.find(x => x.ruleId === 'VAGUE-applicable'), undefined);
  });

  it('still flags ADV-022 "Remove any debris" (no exclusion match)', () => {
    const v = run('Remove any debris from the excavation before placing concrete.');
    assert.notStrictEqual(v.find(x => x.ruleId === 'TERM-any'), undefined);
  });

  // Pinned regression: removing TERM-any POS suppression. The dirty corpus
  // contains "any CPVC Plastic Pipe" / "any LEED projects" — both are
  // legitimate TERM-any violations that compromise tags as #Acronym +
  // #Noun. A POS pattern like "any #Acronym" would over-suppress them and
  // drop TERM-006 recall from 33/36 to 29/36. Keep these flagging.
  it('still flags "any CPVC Plastic Pipe" (#Acronym + noun must not over-suppress)', () => {
    const v = run('Provide solvent cement for any CPVC Plastic Pipe in accordance with ASTM F493.');
    assert.notStrictEqual(v.find(x => x.ruleId === 'TERM-any'), undefined);
  });
  it('still flags "any LEED projects"', () => {
    const v = run('This requirement applies but is not required for any LEED projects.');
    assert.notStrictEqual(v.find(x => x.ruleId === 'TERM-any'), undefined);
  });
});
