/**
 * nlp-abbrev.js — Abbreviation-period heuristic for NLP sentence segmentation.
 *
 * compromise.js segments sentences on `.` and tags words from local sentence
 * context. UFGS specs are dense with abbreviations (U.S., USACE, NAVFAC, ASTM,
 * ACI, AISC, Dr.) whose periods split sentences mid-stride — degrading both
 * passive-voice and indicative-mood detection.
 *
 * Approach (issue #135): a "dynamic alpha-count" heuristic borrowed from
 * KeithCu/writeragent. If the token immediately before a period is alpha-only
 * and <= 6 characters (internal periods stripped), the period is an
 * abbreviation. Decimals and comma-separated numbers are also non-terminators.
 *
 * Why dynamic instead of a static abbreviation list: simpler, more
 * maintainable, privacy-preserving, and works across scripts (Unicode-aware).
 *
 * The mask character is U+2024 ONE DOT LEADER — visually similar to a period
 * but in a different Unicode block, so compromise.js does not treat it as a
 * sentence terminator. 1:1 character substitution preserves all offsets.
 */

export const ABBREV_PERIOD_MASK = '․';

const MAX_ABBREV_ALPHA_LEN = 6;

/**
 * Return true if `text[periodIdx]` is a period that ends an abbreviation
 * rather than a sentence.
 *
 * The heuristic blends two signals:
 *
 *   1. Embedded period — char immediately after the period is alphanumeric
 *      (no whitespace). Catches internal dots in `U.S.A.` and decimals like
 *      `1.5`. Safe to mask aggressively: compromise will not segment a
 *      sentence inside a token.
 *
 *   2. Trailing period of an abbreviation-shaped token. The token must be
 *      EITHER all-uppercase alpha ≤ 6 chars (USACE, NAVFAC, ASTM, ACI, AISC,
 *      U, S) OR TitleCase short (1 uppercase + 1-3 lowercase: Dr, Mr, Mrs,
 *      Inc, Co). Internal periods stripped before measuring length so
 *      U.S.A. counts as USA.
 *
 * The case-shape restriction is what keeps common lowercase verbs like
 * "tested", "placed", "graded" (all 6 chars, all lowercase) out of the
 * abbreviation set. The pure-alpha-count rule from the issue source would
 * over-fire on those at sentence-end and merge unrelated sentences.
 *
 * @param {string} text
 * @param {number} periodIdx - index of the `.` character to classify
 * @returns {boolean}
 */
export function isAbbreviationPeriod(text, periodIdx) {
  if (typeof text !== 'string' || text.length === 0) return false;
  if (periodIdx < 0 || periodIdx >= text.length) return false;
  if (text[periodIdx] !== '.') return false;

  // Rule 1: truly embedded period (alphanumeric on BOTH sides). Covers
  // U.S.A. internal dots and decimals (1.5). Requires preceding alphanumeric
  // so a stray leading "." in ".start" is not mis-classified.
  if (periodIdx > 0 && periodIdx + 1 < text.length) {
    const prev = text[periodIdx - 1];
    const next = text[periodIdx + 1];
    if (/[\p{L}\p{N}]/u.test(prev) && /[\p{L}\p{N}]/u.test(next)) return true;
  }

  // Rule 2: trailing period of an abbreviation-shaped token.
  // Walk left to the nearest whitespace (or start of string) to extract the
  // token immediately preceding the period.
  let i = periodIdx - 1;
  while (i >= 0 && !/\s/.test(text[i])) i--;
  const token = text.slice(i + 1, periodIdx);
  if (!token) return false;

  // Strip internal periods (so U.S.A. counts as "USA").
  const stripped = token.replace(/\./g, '');
  if (!stripped) return false;

  // All-uppercase alpha ≤ 6 chars (USACE, NAVFAC, ASTM, ACI, AISC, US).
  if (/^\p{Lu}+$/u.test(stripped) && stripped.length <= MAX_ABBREV_ALPHA_LEN) {
    return true;
  }

  // TitleCase short abbreviation (Dr, Mr, Mrs, Inc, Co, St) — uppercase
  // initial + 1-3 lowercase letters.
  if (/^\p{Lu}\p{Ll}{1,3}$/u.test(stripped)) return true;

  return false;
}

/**
 * Mask abbreviation periods in `text` so compromise.js does not segment a
 * sentence on them. Substitution is 1:1 character-for-character, preserving
 * every offset in the original string.
 *
 * @param {string} text
 * @returns {string} text with abbreviation periods replaced by U+2024
 */
export function maskAbbreviationPeriods(text) {
  if (typeof text !== 'string' || !text) return text;
  if (!text.includes('.')) return text;

  let out = '';
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '.' && isAbbreviationPeriod(text, i)) {
      out += ABBREV_PERIOD_MASK;
    } else {
      out += text[i];
    }
  }
  return out;
}
