/**
 * nlp-abbrev.test.js — Abbreviation-period heuristic (issue #135).
 *
 * Pure-function tests for isAbbreviationPeriod() and maskAbbreviationPeriods().
 * The heuristic identifies abbreviation-shaped boundaries so compromise.js does
 * not split a sentence mid-stride on tokens like U.S., USACE, ASTM, Dr.
 *
 * Source: KeithCu/writeragent — "dynamic alpha-count heuristic": if the token
 * immediately before a period is alpha-only and length <= 6, the period is an
 * abbreviation. Internal periods (U.S.A.) do not count toward the limit.
 */

import { describe, it, expect } from 'vitest';
import {
  isAbbreviationPeriod,
  maskAbbreviationPeriods,
  ABBREV_PERIOD_MASK,
} from '../nlp-abbrev.js';

describe('isAbbreviationPeriod', () => {
  // [text, periodIdx, expected, reason]
  const cases = [
    // Single-letter abbreviations
    ['U.S. Army', 1, true, 'U. is alpha-only, length 1'],
    ['U.S. Army', 3, true, 'S. is alpha-only, length 1'],
    ['per Dr. Smith', 6, true, 'Dr. is alpha-only, length 2'],

    // Multi-letter agency abbreviations
    ['per USACE.', 9, true, 'USACE is 5 alpha chars'],
    ['per NAVFAC.', 10, true, 'NAVFAC is 6 alpha chars (boundary)'],
    ['per ASTM.', 8, true, 'ASTM is 4 alpha chars'],
    ['per ACI.', 7, true, 'ACI is 3 alpha chars'],
    ['per AISC.', 8, true, 'AISC is 4 alpha chars'],

    // Internal periods (token containing internal dots)
    ['U.S.A. is large', 5, true, 'U.S.A. — stripped USA is 3 chars'],
    ['U.S.S.R. fell', 7, true, 'U.S.S.R. — stripped USSR is 4 chars'],

    // Pure-numeric token (decimal, between digits)
    ['Use 1.5 inches', 5, true, '1.5 — period between two digits is a decimal'],
    ['Approx 12.34 psi', 9, true, '12.34 — period between digits'],

    // Sentence terminators (NOT abbreviations — case shape excludes them)
    ['placed concrete. Provide rebar.', 15, false, 'concrete is lowercase, not abbreviation-shaped'],
    ['The material installed. The test', 22, false, 'installed is lowercase'],
    ['testing complete.', 16, false, 'complete is lowercase'],
    ['This is a sentence. Next one.', 18, false, 'sentence is lowercase'],

    // Lowercase short common words — case-shape filter excludes them.
    // Critical: avoids the +7 calibration-FP regression seen when the pure
    // alpha-count rule fired on "tested.", "placed.", "graded." (all 6 chars).
    ['Use all.', 7, false, 'all is lowercase — not abbreviation-shaped'],
    ['Test it.', 7, false, 'it is lowercase — not abbreviation-shaped'],
    ['is tested. The test', 9, false, '6-char lowercase past-participle is excluded'],
    ['is placed. The test', 9, false, '6-char lowercase past-participle is excluded'],

    // TitleCase boundary — abbreviation shape but starts a sentence
    // ("The." at sentence-start). TitleCase + 1-3 lowercase is the
    // abbreviation pattern; we accept the trap because "The." rarely
    // appears as legitimate sentence-end in spec text.
    ['Per The. Smith reviewed', 7, true, 'TitleCase 1+2 — abbreviation-shaped (accepted trap)'],

    // Edge: period at start
    ['.start of text', 0, false, 'no token to the left of the period'],

    // Edge: not a period
    ['no period here', 5, false, 'index does not point at a period'],

    // Edge: empty string
    ['', 0, false, 'empty input'],

    // Mixed case
    ['per Inc. owner', 7, true, 'Inc. is 3 alpha chars'],
  ];

  it.each(cases)('text=%j idx=%i expects=%s (%s)', (text, idx, expected, _reason) => {
    expect(isAbbreviationPeriod(text, idx)).toBe(expected);
  });
});

describe('maskAbbreviationPeriods', () => {
  it('replaces abbreviation periods with the mask character', () => {
    const masked = maskAbbreviationPeriods('per U.S. Army Corps');
    // Two abbreviation periods (U. and S.)
    expect(masked).not.toContain('U.S.');
    expect(masked).toContain(`U${ABBREV_PERIOD_MASK}S${ABBREV_PERIOD_MASK}`);
  });

  it('preserves sentence terminators after long words', () => {
    // "concrete" + "reinforcement" are both > 6 alpha chars — periods stay.
    const masked = maskAbbreviationPeriods('Place concrete. Install reinforcement.');
    expect(masked).toBe('Place concrete. Install reinforcement.');
  });

  it('preserves character offsets (1:1 substitution)', () => {
    const original = 'per U.S. Army.';
    const masked = maskAbbreviationPeriods(original);
    expect(masked.length).toBe(original.length);
  });

  it('handles mixed abbreviation + sentence-end', () => {
    const original = 'per U.S. requirements. Install rebar.';
    const masked = maskAbbreviationPeriods(original);
    // U. and S. masked; "requirements." and "rebar." preserved
    expect(masked.indexOf('.')).toBe(original.indexOf('requirements.') + 'requirements'.length);
  });

  it('returns input unchanged when no periods', () => {
    expect(maskAbbreviationPeriods('no periods here')).toBe('no periods here');
  });

  it('handles empty input', () => {
    expect(maskAbbreviationPeriods('')).toBe('');
  });

  it('handles non-string input gracefully', () => {
    expect(maskAbbreviationPeriods(null)).toBe(null);
    expect(maskAbbreviationPeriods(undefined)).toBe(undefined);
  });

  it('masks decimals so compromise does not split mid-number', () => {
    const original = 'Use 1.5 inches of subgrade material. Compact to required density.';
    const masked = maskAbbreviationPeriods(original);
    // 1.5 decimal is masked (embedded period — char after . is a digit)
    expect(masked).toContain(`1${ABBREV_PERIOD_MASK}5`);
    // sentence-end after lowercase "material" is preserved
    expect(masked).toContain('material.');
  });
});
