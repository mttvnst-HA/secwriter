/**
 * compliance-rules.js
 *
 * Static rule engine for UFS 1-300-02 compliance checking.
 * Rules are auto-generated from src/data/ufs-1-300-02-rules.json at startup.
 * Only the 4 FMT formatting rules are hardcoded (mechanical text transforms).
 */

import rulesData from '../data/ufs-1-300-02-rules.json';
import { getNlp, isNlpReady, preloadNlp } from './nlp-rules.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Compute quote-enclosed character ranges in text. Returns Array<[start, end)>
 * covering content strictly INSIDE matched quote pairs (the inner span — the
 * quote characters themselves are not included). Sorted ascending by start.
 *
 * Pairing rules:
 *   - Straight " " — alternate occurrences (1st=open, 2nd=close, 3rd=open, …).
 *     Pairs with inside-content > MAX_STRAIGHT_PAIR_LEN chars are dropped on
 *     the assumption they reflect a stray unmatched quote, not real meta-text.
 *   - Curly " " (U+201C / U+201D) — directional pairing.
 *
 * Used by the TERM-should suppression in runStaticRules to recognise quoted
 * meta-text (e.g. 'interpret the word "should" as "must"') without relying
 * on the prior ±5-char heuristic, which missed cases like:
 *   The word should appear as written: "shall".
 *
 * Exported for testing and for any future rule that needs quote awareness.
 */
const MAX_STRAIGHT_PAIR_LEN = 80;
export function computeQuoteRanges(text) {
  const ranges = [];
  if (!text) return ranges;

  // Straight double quotes: alternating open/close.
  const straight = [];
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 0x22) straight.push(i);
  }
  for (let i = 0; i + 1 < straight.length; i += 2) {
    const open = straight[i];
    const close = straight[i + 1];
    if (close - open - 1 <= MAX_STRAIGHT_PAIR_LEN) {
      ranges.push([open + 1, close]);
    }
  }

  // Curly double quotes: pair U+201C with the next U+201D.
  let curlyOpen = -1;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 0x201C) {
      if (curlyOpen === -1) curlyOpen = i;
    } else if (c === 0x201D) {
      if (curlyOpen !== -1) {
        ranges.push([curlyOpen + 1, i]);
        curlyOpen = -1;
      }
    }
  }

  ranges.sort((a, b) => a[0] - b[0]);
  return ranges;
}

/** Whether [start, end) is fully contained within any computed quote range. */
function isInsideAnyQuoteRange(ranges, start, end) {
  for (const [qs, qe] of ranges) {
    if (start >= qs && end <= qe) return true;
    if (qs >= end) break; // sorted by start
  }
  return false;
}

/**
 * Compute a per-keyword suppression set using compromise.js POS tags so the
 * four formerly DEFERRED_TO_PANEL rules can run inline with low FP:
 *
 *   TERM-suitable     — suppress "suitable for #Acronym|#ProperNoun|#Value"
 *                       (e.g. "suitable for ASTM D4263" three-token-adjacent;
 *                       longer paraphrases like "suitable for the intended
 *                       application as defined in ASTM D4263" still flag).
 *   VAGUE-applicable  — suppress "(as|when|where|if) applicable" (adverbial
 *                       clause, legitimate spec idiom) and
 *                       "applicable #Acronym|#ProperNoun" (specific named
 *                       reference).
 *
 * TERM-any is intentionally NOT in this set: the rule's regex in buildRules()
 * already excludes "any of the following / one of / portion / point / three /
 * …" and similar — empirically that fully covers the clean corpus (0 FPs at
 * baseline). Layering a POS pattern such as "any #Acronym" over-suppresses
 * dirty-corpus cases like "any CPVC Plastic Pipe" / "any LEED projects" /
 * "Any Floor Flatness" / "Any Handholes", regressing recall by 4 on the dirty
 * corpus (TERM-006 33/36 → 29/36) without a corresponding precision gain.
 *
 * Returns a Map<ruleId, Set<offset>>. When compromise is not yet loaded,
 * returns empty sets and warms the lazy load for the next call. Existing
 * regex heuristics in runStaticRules continue to apply either way.
 */
function computePosSuppression(plainText) {
  const empty = { 'TERM-suitable': new Set(), 'VAGUE-applicable': new Set() };
  if (!isNlpReady()) {
    preloadNlp();
    return empty;
  }
  const nlp = getNlp();
  if (!nlp) return empty;

  let doc;
  try { doc = nlp(plainText); }
  catch { return empty; }

  const out = empty;
  const collect = (matchSet, ruleId, keyword) => {
    let json;
    try { json = matchSet.json({ offset: true }); }
    catch { return; }
    for (const m of (json || [])) {
      for (const t of (m.terms || [])) {
        if (t.normal === keyword && typeof t.offset?.start === 'number') {
          out[ruleId].add(t.offset.start);
        }
      }
    }
  };

  try {
    collect(doc.match('suitable for (#Acronym|#ProperNoun|#Value)'), 'TERM-suitable', 'suitable');
  } catch { /* compromise pattern failed — skip */ }
  try {
    collect(doc.match('(as|when|where|if) applicable'), 'VAGUE-applicable', 'applicable');
    collect(doc.match('applicable (#Acronym|#ProperNoun)'), 'VAGUE-applicable', 'applicable');
  } catch { /* skip */ }

  return out;
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Binary search: is match inside or adjacent (±1 char) to any bracket range?
 * Requires bracketRanges sorted by start position.
 */
function isInOrNearBracket(bracketRanges, matchStart, matchEnd) {
  let lo = 0, hi = bracketRanges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const r = bracketRanges[mid];
    if (matchEnd < r.start - 1) {
      hi = mid - 1;
    } else if (matchStart > r.end + 1) {
      lo = mid + 1;
    } else {
      return true; // overlap or adjacent
    }
  }
  return false;
}

/**
 * Build a fix function for a prohibited term entry.
 * Returns null for complex cases that need AI rewriting.
 */
function buildFixFunction(entry) {
  const { term, replacement } = entry;
  if (!replacement) return null;

  // Simple word-for-word replacements
  const simpleReplacements = {
    'per': (text) => text.replace(/\bper\b(?!\s*(cent|annum|capita|diem|se\b|hour|min|second|day|week|month|year|cubic|sq|square|linear|foot|feet|inch|yard|mile|meter|metre|liter|litre|gal|pound|ton|acre|hectare|km|mph|psf|psi|pcf|plf|ksf|ksi|kcf|klf|mil|floor|person|channel|lamp|luminaire|fixture|unit|circuit|phase|zone|room|cell|bay|sack|kit|interval|\d))/gi, 'in accordance with'),
    'etc.': null, // needs manual enumeration — can't auto-fix
    'any': null, // needs context to determine specificity
    'and/or': (text) => text.replace(/\band\/or\b/gi, 'or'),
    'furnish': (text) => text.replace(/\bfurnish\b/gi, 'provide'),
    'Contractor must provide': (text) => text.replace(/\bContractor must provide\b/g, 'Provide'),
    'Officer in Charge of Construction': (text) => text.replace(/\bOfficer in Charge of Construction\b/g, 'Contracting Officer'),
    'Contracting Officer Representative': (text) => text.replace(/\bContracting Officer Representative\b/g, 'Contracting Officer'),
    'Government Representative': (text) => text.replace(/\bGovernment Representative\b/g, 'Contracting Officer'),
    'hereinbefore': null, // needs specific paragraph reference
    'hereinafter': null, // needs specific paragraph reference
    'conforming to': (text) => text.replace(/\bconforming to\b/gi, ''),
    'in this specification': (text) => text.replace(/\bin this specification\b/gi, ''),
    'Brand Name or Equal': null, // needs J&A — can't auto-fix
    'per cent': (text) => text.replace(/\bper cent\b/gi, 'percent'),
  };

  if (simpleReplacements.hasOwnProperty(term)) {
    return simpleReplacements[term];
  }

  // "shall" — the most common violation, with structured fix patterns
  if (term === 'shall') {
    return (text) => {
      // "The Contractor shall [verb]" → "[Verb]"
      let result = text.replace(
        /\bThe Contractor shall\s+(\w)/gi,
        (_, firstChar) => firstChar.toUpperCase()
      );
      // "shall be [verb]ed" → simple cases only
      // More complex restructuring returns null (deferred to AI)
      if (/\bshall\b/i.test(result)) {
        return null; // still has "shall" — too complex for regex
      }
      return result;
    };
  }

  // "should" — flag only, no auto-fix (may be intentional in notes)
  if (term === 'should') return null;

  // "to be" — too ambiguous for auto-fix
  if (term === 'to be') return null;

  // "proposed" — context-dependent
  if (term === 'proposed') return null;

  // "install" — only when "provide" is meant
  if (term === 'install') return null;

  // Vague/subjective terms — all need AI rewriting
  const vagueTerms = [
    'securely', 'thoroughly', 'suitable', 'properly', 'neatly', 'carefully',
    'good working order', 'first class workmanship',
    'installed in a neat and workmanlike manner',
    'as shown on the drawings', 'as may be required', 'as necessary',
    'an approved type', 'as approved by the Contracting Officer',
    'as directed by the Contracting Officer', 'as determined by the Contracting Officer',
  ];
  if (vagueTerms.includes(term)) return null;

  // Default: no auto-fix available
  return null;
}

/**
 * Build regex pattern for a prohibited symbol.
 * Some symbols need special handling to avoid false positives.
 */
function buildSymbolPattern(entry) {
  const { symbol } = entry;

  // These symbols are too common as normal characters — need context patterns
  const contextPatterns = {
    // Match % when preceded by a number ("50%") OR used as a standalone word-adjacent symbol ("% of")
    '%': /(\d)\s*%|%\s*(?=\w)/g,
    // Match # when adjacent to digits ("#10", "10#") OR used as abbreviation ("model #", "item #", "# of")
    '#': /(?:\b(\d+)\s*#|#\s*(\d+)\b|\b\w+\s+#(?:\s|,|$)|#\s*(?=\w))/g,
    // Match ° only when preceded by a number: "90°" → "90 degrees"
    '°': /(\d)\s*°/g,
    // Match & only between words: "sand & gravel"
    '&': /\b(\w+)\s*&\s*(\w+)\b/g,
    // Match @ only between number and unit: "3 @ $10"
    '@': /(\d+)\s*@\s*/g,
  };

  if (contextPatterns[symbol]) {
    return contextPatterns[symbol];
  }

  // Skip these — too many false positives with simple regex:
  // ' (foot), " (inch), + (plus), - (minus), +/- (plus or minus),
  // • (by), x (by), / (per)
  // These are flagged only via the JSON data for reference, not as active patterns
  return null; // disabled — will be filtered out in buildRules()
}

// ── Rule Builder ─────────────────────────────────────────────────────────────

/**
 * Build all compliance rules from the JSON data source.
 * Returns an array of rule objects ready for matching.
 */
export function buildRules() {
  const rules = [];
  const seenTerms = new Set(); // dedup: some terms appear in both prohibitedTerms and vagueTerms

  // ── Prohibited Terms (high severity) ──
  rulesData.prohibitedTerms.forEach((entry, i) => {
    const term = entry.term;
    seenTerms.add(term.toLowerCase());

    // Skip terms that would produce too many false positives without AI context
    const skipTerms = ['to be', 'proposed', 'install'];
    if (skipTerms.includes(term)) {
      // Still add as a rule but with very specific patterns
      if (term === 'to be') {
        rules.push({
          id: entry.ruleId || `TERM-${String(i + 1).padStart(3, '0')}`,
          category: 'prohibited-term',
          severity: 'medium', // downgrade — too many legitimate uses
          pattern: /\bis to be\b|\bare to be\b/gi,
          message: entry.context,
          replacement: entry.replacement,
          ufsRef: `UFS 1-300-02 §${entry.section}`,
          fix: null,
        });
        return;
      }
      // Skip "proposed" and "install" entirely — too many false positives
      return;
    }

    // "per" needs special handling to avoid matching "per cent", "per annum", etc.
    let pattern;
    if (term === 'per') {
      // Exclude "per" in unit expressions (per hour, per cubic foot, per square meter, etc.)
      // and standard phrases (per cent, per annum, per capita, per diem, per se)
      pattern = /\bper\b(?!\s*(cent|annum|capita|diem|se\b|hour|min|second|day|week|month|year|cubic|sq|square|linear|foot|feet|inch|yard|mile|meter|metre|liter|litre|gal|pound|ton|acre|hectare|km|mph|psf|psi|pcf|plf|ksf|ksi|kcf|klf|mil|floor|person|channel|lamp|luminaire|fixture|unit|circuit|phase|zone|room|cell|bay|sack|kit|interval|\d))/gi;
    } else if (term === 'any') {
      // "any" as indefinite — not as standard determiner (any portion, any point, any three, any control)
      pattern = /\bany\b(?!\s*(of the following|of these|one of|other|portion|point|time|three|four|two|\d|control|additional|remaining|existing|adjacent|individual|particular|single|given))/gi;
    } else {
      // For terms ending with non-word chars (e.g., "etc."), don't use trailing \b
      const escaped = escapeRegex(term);
      const endsWithWord = /\w$/.test(term);
      pattern = new RegExp(`\\b${escaped}${endsWithWord ? '\\b' : ''}`, 'gi');
    }

    rules.push({
      id: entry.ruleId || `TERM-${String(i + 1).padStart(3, '0')}`,
      category: 'prohibited-term',
      severity: 'high',
      pattern,
      message: entry.context,
      replacement: entry.replacement,
      ufsRef: `UFS 1-300-02 §${entry.section}`,
      fix: buildFixFunction(entry),
    });
  });

  // ── Prohibited Symbols (medium severity) ──
  rulesData.prohibitedSymbols.forEach((entry, i) => {
    const pattern = buildSymbolPattern(entry);
    if (!pattern) return; // skip symbols that can't be reliably detected

    rules.push({
      id: entry.ruleId || `SYM-${String(i + 1).padStart(3, '0')}`,
      category: 'prohibited-symbol',
      severity: 'medium',
      pattern,
      message: `Replace "${entry.symbol}" (${entry.meaning}) with "${entry.replacement}"`,
      replacement: entry.replacement,
      exception: entry.exception,
      ufsRef: 'UFS 1-300-02 §2-4.4',
      fix: buildSymbolFix(entry),
    });
  });

  // ── Vague Terms (medium severity, fix: null → AI) ──
  // Only add if not already covered by prohibitedTerms
  // Supports both string format ("term") and object format ({term, ruleId})
  rulesData.vagueTerms.forEach((entry, i) => {
    const term = typeof entry === 'string' ? entry : entry.term;
    const ruleId = (typeof entry === 'object' && entry.ruleId) || `VAGUE-${String(i + 1).padStart(3, '0')}`;
    if (seenTerms.has(term.toLowerCase())) return; // dedup

    rules.push({
      id: ruleId,
      category: 'vague-language',
      severity: 'medium',
      pattern: new RegExp(`\\b${escapeRegex(term)}\\b`, 'gi'),
      message: `"${term}" is vague per UFS 1-300-02 §2-4.4. Use specific, measurable language.`,
      ufsRef: 'UFS 1-300-02 §2-4.4',
      fix: null,
    });
  });

  // ── Required Capitalization (low severity) ──
  rulesData.requiredCapitalization.forEach((entry) => {
    const lower = entry.term.toLowerCase();
    // Only match when NOT already capitalized correctly
    // Use negative lookahead to avoid matching the correct form
    rules.push({
      id: `CAP-${entry.term.replace(/\s+/g, '')}`,
      category: 'capitalization',
      severity: 'low',
      // Match lowercase "contractor" but not "Contractor", "subcontractor", etc.
      pattern: new RegExp(
        `(?<![A-Za-z])${escapeRegex(lower)}(?![A-Za-z])`,
        'g'
      ),
      message: `${entry.rule}: "${entry.term}" per UFS 1-300-02 §${entry.section}`,
      ufsRef: `UFS 1-300-02 §${entry.section}`,
      fix: (text) => {
        // Replace only standalone lowercase occurrences
        return text.replace(
          new RegExp(`(?<![A-Za-z])${escapeRegex(lower)}(?![A-Za-z])`, 'g'),
          entry.term
        );
      },
    });
  });

  // ── Colloquial Terms (medium severity) ──
  rulesData.colloquialTerms.forEach((entry) => {
    const pattern = new RegExp(`\\b${escapeRegex(entry.term)}\\b`, 'gi');
    rules.push({
      id: `COLLOQ-${entry.term}`,
      category: 'terminology',
      severity: 'medium',
      pattern,
      message: `Colloquial: use "${entry.correctTerm}" instead of "${entry.term}" per UFS 1-300-02 §${entry.section}`,
      ufsRef: `UFS 1-300-02 §${entry.section}`,
      fix: (text) => text.replace(pattern, entry.correctTerm),
    });
  });

  // ── Redundant Wording (low severity, fix: null) ──
  rulesData.redundantWording.forEach((entry) => {
    // Skip "conforming to" — already in prohibitedTerms
    if (seenTerms.has(entry.term.toLowerCase())) return;

    // "all" and "type" are too common for word-boundary matching
    if (entry.term === 'all' || entry.term === 'type') return;

    rules.push({
      id: `REDUND-${entry.term.replace(/\s+/g, '-')}`,
      category: 'redundant-wording',
      severity: 'low',
      pattern: new RegExp(`\\b${escapeRegex(entry.term)}\\b`, 'gi'),
      message: `${entry.note} — consider removing "${entry.term}" per UFS 1-300-02 §${entry.section}`,
      ufsRef: `UFS 1-300-02 §${entry.section}`,
      fix: null,
    });
  });

  // ── Formatting Rules (low severity, hardcoded) ──
  // NOTE: FMT-001 (double spaces) was removed — UFS 1-300-02 does NOT prohibit
  // double spaces, and USACE .SEC files conventionally use them after periods.
  rules.push(
    {
      id: 'FMT-002', category: 'formatting', severity: 'low',
      pattern: /[\u2013\u2014]/g,
      message: 'Em-dash or en-dash should be hyphen',
      ufsRef: 'UFS 1-300-02 §2-3',
      fix: (text) => text.replace(/[\u2013\u2014]/g, '-'),
    },
    {
      id: 'FMT-003', category: 'formatting', severity: 'low',
      pattern: /[\u201C\u201D\u2018\u2019]/g,
      message: 'Smart quotes should be straight quotes',
      ufsRef: 'UFS 1-300-02 §2-3',
      fix: (text) => text.replace(/[\u201C\u201D]/g, '"').replace(/[\u2018\u2019]/g, "'"),
    },
    {
      id: 'FMT-004', category: 'formatting', severity: 'low',
      pattern: /\bper cent\b/gi,
      message: '"per cent" should be "percent"',
      ufsRef: 'UFS 1-300-02 §2-3',
      fix: (text) => text.replace(/\bper cent\b/gi, 'percent'),
    }
  );

  return rules;
}

/**
 * Build a fix function for a prohibited symbol.
 */
function buildSymbolFix(entry) {
  const { symbol, replacement } = entry;

  const fixes = {
    '%': (text) => text.replace(/(\d)\s*%/g, `$1 ${replacement}`),
    '#': (text) => text.replace(/(?:\b(\d+)\s*#|#\s*(\d+)\b)/g, (m, pre, post) => {
      return pre ? `${pre} ${replacement}` : `${replacement} ${post}`;
    }),
    '°': (text) => text.replace(/(\d)\s*°/g, `$1 ${replacement}`),
    '&': (text) => text.replace(/\b(\w+)\s*&\s*(\w+)\b/g, `$1 ${replacement} $2`),
    '@': (text) => text.replace(/(\d+)\s*@\s*/g, `$1 ${replacement} `),
  };

  return fixes[symbol] || null;
}

// ── Rule Runner ──────────────────────────────────────────────────────────────

/**
 * Run all static rules against plain text content.
 *
 * @param {string} plainText - Block text with HTML stripped
 * @param {string} blockId - Block identifier
 * @param {Array} rules - Array of rule objects from buildRules()
 * @param {Object} options - { skipBrackets: true, isNoteBlock: false }
 * @returns {Array} violations - [{ ruleId, blockId, match, index, sentence, fix, message, severity, category, ufsRef, replacement }]
 */
export function runStaticRules(plainText, blockId, rules, options = {}) {
  const { skipBrackets = true, isNoteBlock = false } = options;
  const violations = [];

  if (!plainText || !plainText.trim()) return violations;

  // Notes are completely exempt from UFS 1-300-02 compliance checking
  if (isNoteBlock) return violations;

  // Pre-process: identify bracket ranges to exclude (sorted by start for binary search)
  let bracketRanges = [];
  if (skipBrackets) {
    const bracketPattern = /\[[^\]]*\]/g;
    let m;
    while ((m = bracketPattern.exec(plainText)) !== null) {
      bracketRanges.push({ start: m.index, end: m.index + m[0].length });
    }
    // Already sorted by start from left-to-right exec, but enforce for safety
    bracketRanges.sort((a, b) => a.start - b.start);
  }

  // Pre-process once per call: quote ranges for TERM-should and POS-window
  // suppression sets for the three context-dependent term/vague rules.
  // Both fall back to no-op when their input signal is unavailable.
  const quoteRanges = computeQuoteRanges(plainText);
  const posSuppress = computePosSuppression(plainText);

  for (const rule of rules) {
    if (!rule.pattern) continue;

    // Skip imperative mood rules for note blocks (notes use advisory language)
    if (isNoteBlock && rule.category === 'prohibited-term') {
      const imperativeTerms = ['shall', 'should', 'to be'];
      if (imperativeTerms.some(t => rule.message?.toLowerCase().includes(t))) {
        continue;
      }
    }

    // Reset regex lastIndex for global patterns
    rule.pattern.lastIndex = 0;

    let match;
    while ((match = rule.pattern.exec(plainText)) !== null) {
      const matchStart = match.index;
      const matchEnd = matchStart + match[0].length;

      // Skip matches inside or immediately adjacent to brackets (binary search)
      if (skipBrackets && isInOrNearBracket(bracketRanges, matchStart, matchEnd)) {
        continue;
      }

      // Skip "bridge deck", "deck plate", "concrete deck", "roof deck" etc. — legitimate civil engineering terms
      if (rule.id === 'COLLOQ-deck') {
        const before = plainText.slice(Math.max(0, matchStart - 15), matchStart).toLowerCase();
        const after = plainText.slice(matchEnd, matchEnd + 10).toLowerCase();
        if (before.match(/bridge|concrete|roof|steel/) || after.match(/^\s*(plate|drain|coating|slab)/)) continue;
      }

      // Skip engineering uses of "head": bolt head, shower head, cutting head, etc.
      // Only flag standalone "head" meaning "toilet" (naval colloquial)
      if (rule.id === 'COLLOQ-head') {
        const before = plainText.slice(Math.max(0, matchStart - 20), matchStart).toLowerCase();
        const after = plainText.slice(matchEnd, matchEnd + 15).toLowerCase();
        if (before.match(/bolt|shower|screw|cutting|spanner|washer|square|finished-?|cast-?brass|static|pile|dead|pressure|pump|suction|discharge|net positive|total|friction|large/) ||
            after.match(/^\s*(screw|bolt|nut|cap|face|plate|anchor|mount|room|loss|pressure|wall|space|pin|rail)/)) continue;
        // Also skip "head in feet" (hydraulic head measurement)
        if (after.match(/^\s*in\s*(feet|meters|metres|inches|mm|m\b)/)) continue;
      }

      // Skip "should" when it appears inside quotes (meta-text discussing the
      // word itself, e.g. 'interpret the word "should" as "must"').
      // Replaced the prior ±5-char heuristic with full-text quote tracking
      // so cases like `The word should appear as written: "shall"` work too.
      if (rule.id === 'TERM-should') {
        if (isInsideAnyQuoteRange(quoteRanges, matchStart, matchEnd)) continue;
      }


      // Skip "suitable for [specific criteria]" and ALL CAPS "SUITABLE" (nameplate markings).
      // POS-window check additionally suppresses "suitable for #Acronym|#ProperNoun|#Value"
      // (e.g. "suitable for ASTM D4263") with three-token adjacency. The "the"
      // sub-alternative is gated on a following digit or `#` so precise-
      // dimension phrases ("suitable for the 1-inch pipe", "for the #2
      // aggregate") still skip while vague paraphrases ("suitable for the
      // intended application as defined in ASTM D4263") flag (ADV-065).
      if (rule.id === 'TERM-suitable') {
        if (posSuppress['TERM-suitable'].has(matchStart)) continue;
        const after = plainText.slice(matchEnd, matchEnd + 30).toLowerCase();
        // "suitable for a 3/4 inch", "suitable for type of", "suitable for the 1-inch pipe"
        if (after.match(/^\s*for\s+(a |type |non-|use |the\s+[#\d])/)) continue;
        // "UL listed as suitable for" — specific listing context
        const before = plainText.slice(Math.max(0, matchStart - 20), matchStart).toLowerCase();
        if (before.match(/listed as\s*$/)) continue;
        // ALL CAPS context (nameplate marking: "SUITABLE FOR NON-LINEAR LOADS")
        if (match[0] === match[0].toUpperCase()) continue;
      }

      // POS-window suppression for VAGUE-applicable: "(as|when|where|if)
      // applicable" adverbial clauses and "applicable #Acronym|#ProperNoun"
      // are legitimate spec idioms that the regex-only path treated as FPs
      // (3 of 8 baseline clean-corpus FPs were of this shape).
      // TERM-any deliberately omitted — see computePosSuppression docs.
      if (rule.id === 'VAGUE-applicable' && posSuppress['VAGUE-applicable'].has(matchStart)) continue;

      // Skip "&" in standard abbreviations (P & T, NEMA TC 6 & 8) and organization names
      // The match includes surrounding words (e.g., "P & T"), so check the match itself
      if (rule.id === 'SYM-and') {
        const m = match[0];
        const parts = m.split(/\s*&\s*/);
        // Skip if both sides of & start with uppercase/digit: "P & T", "6 & 8", "Control & Hydraulic"
        if (parts.length === 2 && /^[A-Z0-9]/.test(parts[0]) && /^[A-Z0-9]/.test(parts[1])) continue;
      }

      // Skip "contract documents", "contract price", "subcontract" etc. — lowercase "contract" as common noun/adjective
      if (rule.id === 'CAP-Contract') {
        const before = plainText.slice(Math.max(0, matchStart - 15), matchStart).toLowerCase();
        const after = plainText.slice(matchEnd, matchEnd + 20).toLowerCase();
        if (before.match(/sub/) || after.match(/^\s*(document|price|specification|amount|sum|period|time|item|clause|requirement|completion|award|work|administration|file|number|drawing|plan)/)) continue;
      }

      // Extract surrounding sentence context (±60 chars)
      const contextStart = Math.max(0, matchStart - 60);
      const contextEnd = Math.min(plainText.length, matchEnd + 60);
      const sentence = (contextStart > 0 ? '...' : '') +
        plainText.slice(contextStart, contextEnd) +
        (contextEnd < plainText.length ? '...' : '');

      violations.push({
        ruleId: rule.id,
        blockId,
        match: match[0],
        index: matchStart,
        sentence,
        fixFn: rule.fix || null, // Fix computed lazily on demand, not eagerly during scan
        message: rule.message,
        severity: rule.severity,
        category: rule.category,
        ufsRef: rule.ufsRef,
        replacement: rule.replacement || null,
      });

      // For non-global patterns, break after first match
      if (!rule.pattern.global) break;
    }
  }

  return violations;
}

// ── Cached Rules Instance ────────────────────────────────────────────────────

let _cachedRules = null;

/**
 * Get the cached rules array (built once on first call).
 */
export function getRules() {
  if (!_cachedRules) {
    _cachedRules = buildRules();
  }
  return _cachedRules;
}
