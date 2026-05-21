/**
 * nlp-rules.js — Passive voice and indicative mood detection via compromise.js
 *
 * Lazy-loads compromise.js on first use (~210KB) to avoid blocking initial page load.
 * Returns violations in the same shape as runStaticRules() for unified handling.
 */

import { replaceAtOffset } from './fix-utils.js';
import { maskAbbreviationPeriods } from './nlp-abbrev.js';

let nlp = null;
let loadPromise = null;

/**
 * Lazy-load compromise.js. Returns the cached module on subsequent calls.
 */
async function loadCompromise() {
  if (nlp) return nlp;
  if (loadPromise) return loadPromise;
  loadPromise = import('compromise').then(mod => {
    nlp = mod.default || mod;
    return nlp;
  });
  return loadPromise;
}

/**
 * Check if compromise is loaded and ready for synchronous use.
 */
export function isNlpReady() {
  return nlp !== null;
}

/**
 * Pre-load compromise.js without blocking. Call early to warm the cache.
 */
export function preloadNlp() {
  loadCompromise().catch(() => {});
}

// Bracket region detection (reused from compliance-rules.js pattern)
function findBracketRanges(text) {
  const ranges = [];
  let depth = 0, start = -1;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '[') {
      if (depth === 0) start = i;
      depth++;
    } else if (text[i] === ']') {
      depth--;
      if (depth === 0 && start >= 0) {
        ranges.push([start, i + 1]);
        start = -1;
      }
    }
  }
  return ranges;
}

function isInBrackets(index, length, bracketRanges) {
  for (const [bStart, bEnd] of bracketRanges) {
    if (index >= bStart && index + length <= bEnd) return true;
    if (bStart > index + length) break;
  }
  return false;
}

/**
 * Detect passive voice and indicative mood issues in text.
 *
 * @param {string} plainText - The block's plain text content
 * @param {string} blockId - Block identifier
 * @param {boolean} isNoteBlock - If true, skip detection (notes use advisory language)
 * @returns {Array<Object>} Array of violation objects
 */
export function detectNlpIssues(plainText, blockId, isNoteBlock = false) {
  if (!nlp || !plainText || isNoteBlock) return [];

  const violations = [];
  const bracketRanges = findBracketRanges(plainText);

  // --- Passive Voice Detection ---
  // Use explicit pattern matching for "be + past participle" constructions.
  // compromise's #Passive tag is unreliable for spec language.
  //
  // Mask abbreviation periods (U.S., USACE, ASTM, etc.) before tokenizing so
  // compromise does not split a sentence mid-stride and mis-tag #PastTense
  // tokens (issue #135). Substitution is 1:1 char, preserving offsets.
  try {
    const maskedForNlp = maskAbbreviationPeriods(plainText);
    const doc = nlp(maskedForNlp);

    // Match: (is|are|was|were|be|been|being) + #PastTense
    // This catches: "are placed", "is tested", "was removed", "were installed",
    // "be performed", "been completed", "being constructed"
    const patterns = [
      '(is|are|was|were|be|been|being) #PastTense',
    ];

    // Engineering past participles commonly used as adjectives (not passive voice).
    // "The beam is galvanized" describes a state, not an action being done to the beam.
    // Only exclude when preceded by is/are (present tense = state description).
    const ENGINEERING_ADJECTIVES = new Set([
      'galvanized', 'reinforced', 'precast', 'prestressed', 'corrugated',
      'laminated', 'insulated', 'coated', 'bonded', 'welded', 'grouted',
      'perforated', 'compacted', 'graded', 'treated', 'cured', 'tempered',
      'annealed', 'extruded', 'fabricated', 'molded', 'threaded',
      'recessed', 'beveled', 'tapered', 'fluted', 'notched',
      'embedded', 'anchored', 'braced', 'stiffened', 'sealed',
      'primed', 'finished', 'polished', 'textured', 'exposed',
      'concealed', 'enclosed', 'suspended', 'cantilevered', 'reclaimed',
      'recycled', 'certified', 'approved', 'specified', 'required',
      'assembled', 'connected', 'coupled', 'rated', 'listed',
      'labeled', 'marked', 'identified', 'designated', 'indicated',
      'equipped', 'furnished', 'painted', 'coated', 'plated',
      'hardened', 'anodized', 'galvanised', 'plasticized',
    ]);

    for (const pattern of patterns) {
      const matches = doc.match(pattern);
      matches.forEach(m => {
        const matchText = m.text().trim();
        if (!matchText || matchText.length < 4) return;

        // Get offset from compromise
        const json = m.json({ offset: true });
        if (!json || !json[0] || !json[0].terms || !json[0].terms[0]) return;
        const startIdx = json[0].terms[0].offset?.start;
        if (typeof startIdx !== 'number' || startIdx < 0) return;

        // Skip if inside brackets
        if (isInBrackets(startIdx, matchText.length, bracketRanges)) return;

        // Skip engineering adjectives with is/are (state description, not passive action)
        const words = matchText.toLowerCase().split(/\s+/);
        if (words.length >= 2 && (words[0] === 'is' || words[0] === 'are')) {
          const participle = words[words.length - 1];
          if (ENGINEERING_ADJECTIVES.has(participle)) return;
        }

        // De-duplicate: skip if we already have a passive finding overlapping this range
        const endIdx = startIdx + matchText.length;
        const isDupe = violations.some(v =>
          v.ruleId === 'NLP-PASSIVE-001' &&
          v.index < endIdx && (v.index + v.match.length) > startIdx
        );
        if (isDupe) return;

        violations.push({
          ruleId: 'NLP-PASSIVE-001',
          blockId,
          match: matchText,
          index: startIdx,
          sentence: plainText.slice(Math.max(0, startIdx - 20), startIdx + matchText.length + 20),
          severity: 'low',
          message: 'Passive voice — consider rewriting in imperative mood per UFS 1-300-02 Section 2-4.1',
          fixFn: null, // Passive voice rewrites need sentence restructuring — defer to AI
          category: 'NLP',
          ufsRef: 'UFS 1-300-02 Section 2-4.1: Use imperative mood for contractor actions',
        });
      });
    }
  } catch {
    // compromise.js parsing failure — skip passive voice detection
  }

  // --- Indicative Mood Detection ---
  // Detect "The Contractor provides/installs/places..." patterns
  try {
    const indicativePattern = /\bThe\s+Contractor\s+(provides?|installs?|places?|performs?|completes?|removes?|applies?|maintains?|submits?|delivers?|constructs?|erects?|furnish(?:es)?|repairs?|tests?|inspects?|monitors?|prepares?|ensures?|verifies?|establishes?|conducts?|coordinates?|secures?|transports?|operates?|stores?|protects?|cleans?|grades?|compacts?|excavates?|backfills?)\b/gi;

    let match;
    while ((match = indicativePattern.exec(plainText)) !== null) {
      const startIdx = match.index;
      const matchText = match[0];

      if (isInBrackets(startIdx, matchText.length, bracketRanges)) continue;

      // Extract the verb for the fix suggestion
      const verbMatch = matchText.match(/Contractor\s+(\w+)/i);
      const verb = verbMatch ? verbMatch[1] : '';
      const imperative = toImperative(verb);

      violations.push({
        ruleId: 'NLP-INDICATIVE-001',
        blockId,
        match: matchText,
        index: startIdx,
        sentence: plainText.slice(Math.max(0, startIdx - 10), startIdx + matchText.length + 30),
        severity: 'high',
        message: `Indicative mood — use imperative: "${imperative}" not "${matchText}"`,
        fixFn: imperative ? createIndicativeFix(matchText, imperative) : null,
        replacement: imperative || null,
        category: 'NLP',
        ufsRef: 'UFS 1-300-02 Section 2-4.1: Specifications are written in imperative mood',
      });
    }
  } catch {
    // Regex failure — skip indicative mood detection
  }

  return violations;
}

/**
 * Convert a third-person verb to imperative form.
 */
function toImperative(verb) {
  if (!verb) return '';
  const v = verb.toLowerCase();
  // Handle -es endings
  if (v.endsWith('ies')) return v.slice(0, -3) + 'y'; // applies -> apply
  if (v.endsWith('shes') || v.endsWith('ches') || v.endsWith('xes') || v.endsWith('zes') || v.endsWith('sses')) {
    return v.slice(0, -2); // furnishes -> furnish
  }
  if (v.endsWith('es')) return v.slice(0, -1); // provides -> provide (but keep the 'e')
  if (v.endsWith('s')) return v.slice(0, -1); // installs -> install
  return v;
}

/**
 * Create a fix function for indicative mood -> imperative.
 * Replaces "The Contractor provides" with "Provide" (capitalized imperative).
 */
function createIndicativeFix(matchText, imperative) {
  const capitalizedImperative = imperative.charAt(0).toUpperCase() + imperative.slice(1);
  return (html, _match, _replacement, targetOffset) => {
    return replaceAtOffset(html, matchText, capitalizedImperative, targetOffset);
  };
}

/**
 * Synchronous version for when compromise is already loaded.
 * Use detectNlpIssues() directly — it checks `nlp` availability internally.
 */
export function detectNlpIssuesSync(plainText, blockId, isNoteBlock = false) {
  return detectNlpIssues(plainText, blockId, isNoteBlock);
}
