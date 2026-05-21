/**
 * Issue #156 — POS-window inline linting for TERM-suitable / TERM-any /
 * VAGUE-applicable and full-text quote tracking for TERM-should.
 *
 * Kept small (<30 tests) per CLAUDE.md to stay within Vitest's memory budget
 * for the regex-heavy compliance rule engine.
 */
import { describe, it, expect, beforeAll } from 'vitest';

import { computeQuoteRanges, runStaticRules, getRules } from '../compliance-rules.js';
import { preloadNlp, isNlpReady } from '../nlp-rules.js';

beforeAll(async () => {
  preloadNlp();
  await new Promise(resolve => {
    const tick = () => (isNlpReady() ? resolve() : setTimeout(tick, 50));
    tick();
  });
});

describe('computeQuoteRanges', () => {
  it('returns empty for null/empty input', () => {
    expect(computeQuoteRanges('')).toEqual([]);
    expect(computeQuoteRanges(null)).toEqual([]);
  });

  it('pairs alternating straight double quotes', () => {
    const text = 'interpret the word "should" as "must"';
    const ranges = computeQuoteRanges(text);
    expect(ranges.length).toBe(2);
    expect(text.slice(ranges[0][0], ranges[0][1])).toBe('should');
    expect(text.slice(ranges[1][0], ranges[1][1])).toBe('must');
  });

  it('captures longer quoted spans up to the cap', () => {
    const text = 'The word should appear as written: "shall".';
    const ranges = computeQuoteRanges(text);
    expect(ranges.length).toBe(1);
    expect(text.slice(ranges[0][0], ranges[0][1])).toBe('shall');
  });

  it('pairs curly double quotes directionally', () => {
    const text = 'render “should” as “must”';
    const ranges = computeQuoteRanges(text);
    expect(ranges.length).toBe(2);
    expect(text.slice(ranges[0][0], ranges[0][1])).toBe('should');
    expect(text.slice(ranges[1][0], ranges[1][1])).toBe('must');
  });

  it('drops straight pairs whose inside-content exceeds the cap (stray-quote guard)', () => {
    // 90-char span between unmatched-looking quotes — exceeds 80-char cap.
    const filler = 'x'.repeat(90);
    const text = `"${filler}"`;
    expect(computeQuoteRanges(text)).toEqual([]);
  });
});

describe('runStaticRules — TERM-should quote suppression', () => {
  const rules = getRules();
  const run = (text) => runStaticRules(text, 'b', rules);

  it('suppresses "should" inside straight quotes', () => {
    const v = run('Interpret the word "should" as "must" in this spec.');
    expect(v.find(x => x.ruleId === 'TERM-should')).toBeUndefined();
  });

  it('suppresses "should" inside curly quotes', () => {
    const v = run('Interpret “should” as a recommendation.');
    expect(v.find(x => x.ruleId === 'TERM-should')).toBeUndefined();
  });

  it('still flags real "should" (cf. adversarial ADV-045)', () => {
    const v = run('The concrete should reach design strength before form removal.');
    expect(v.find(x => x.ruleId === 'TERM-should')).toBeDefined();
  });
});

describe('runStaticRules — POS-window suppression (compromise required)', () => {
  const rules = getRules();
  const run = (text) => runStaticRules(text, 'b', rules);

  it('suppresses "suitable for ASTM D4263" (three-token adjacent specific reference)', () => {
    const v = run('Choose finish suitable for ASTM D4263.');
    expect(v.find(x => x.ruleId === 'TERM-suitable')).toBeUndefined();
  });

  it('still flags ADV-053 "suitable for exterior exposure"', () => {
    const v = run('Select a finish suitable for exterior exposure.');
    expect(v.find(x => x.ruleId === 'TERM-suitable')).toBeDefined();
  });

  // ADV-065 is a baseline miss (the pre-existing /for\s+(a|the|type|non-|use )/
  // exclusion swallows "suitable for the intended …"). The new POS-window
  // suppression must not WIDEN this miss into adjacent specific-noun phrases.
  it('does not widen ADV-065-style misses into adjacent specific-noun cases', () => {
    const v = run('Choose a finish suitable for exterior exposure per ASTM D4263.');
    expect(v.find(x => x.ruleId === 'TERM-suitable')).toBeDefined();
  });

  it('suppresses VAGUE-applicable in adverbial "as applicable" clause (clean-corpus pattern)', () => {
    const v = run('Place reinforcement in accordance with ASTM A934/A934M as applicable.');
    expect(v.find(x => x.ruleId === 'VAGUE-applicable')).toBeUndefined();
  });

  it('suppresses "when applicable" adverbial clause', () => {
    const v = run('Identify the function and, when applicable, the position.');
    expect(v.find(x => x.ruleId === 'VAGUE-applicable')).toBeUndefined();
  });

  it('still flags ADV-067 "The applicable codes and standards"', () => {
    const v = run('The applicable codes and standards listed in Section 01 42 00 govern.');
    expect(v.find(x => x.ruleId === 'VAGUE-applicable')).toBeDefined();
  });

  it('still flags ADV-022 "Remove any debris" (no exclusion match)', () => {
    const v = run('Remove any debris from the excavation before placing concrete.');
    expect(v.find(x => x.ruleId === 'TERM-any')).toBeDefined();
  });

  // Pinned regression: removing TERM-any POS suppression. The dirty corpus
  // contains "any CPVC Plastic Pipe" / "any LEED projects" — both are
  // legitimate TERM-any violations that compromise tags as #Acronym +
  // #Noun. A POS pattern like "any #Acronym" would over-suppress them and
  // drop TERM-006 recall from 33/36 to 29/36. Keep these flagging.
  it('still flags "any CPVC Plastic Pipe" (#Acronym + noun must not over-suppress)', () => {
    const v = run('Provide solvent cement for any CPVC Plastic Pipe in accordance with ASTM F493.');
    expect(v.find(x => x.ruleId === 'TERM-any')).toBeDefined();
  });
  it('still flags "any LEED projects"', () => {
    const v = run('This requirement applies but is not required for any LEED projects.');
    expect(v.find(x => x.ruleId === 'TERM-any')).toBeDefined();
  });
});
