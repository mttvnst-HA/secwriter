/**
 * Grammar Checker — Harper.js Web Worker wrapper for SIM.
 *
 * Lazy-loads Harper's WASM binary on first use. Runs grammar/spelling
 * checks in a Web Worker for non-blocking operation.
 *
 * Exports:
 *   initGrammarChecker() — lazy init, imports custom dictionary
 *   checkGrammar(plainText, blockId) — returns violations in standard shape
 *   destroyGrammarChecker() — terminate worker, free resources
 *   isGrammarReady() — check if WASM is loaded and ready
 *   getVersion() — current request version (for stale result detection)
 */

// Construction/engineering terms to add to Harper's dictionary
const ENGINEERING_TERMS = [
  // Standards organizations
  'ASTM', 'AASHTO', 'NAVFAC', 'USACE', 'AFCEC', 'UFGS', 'UFC', 'UFS',
  'ANSI', 'IEEE', 'ASHRAE', 'NFPA', 'OSHA', 'SMACNA', 'SSPC', 'NICET',
  // Units and abbreviations
  'psi', 'pcf', 'ksf', 'ksi', 'psf', 'plf', 'klf', 'kPa', 'MPa', 'GPa',
  'mm', 'cm', 'kN', 'MN',
  // Construction terms
  'submittal', 'submittals', 'punchlist', 'rebar', 'rebars',
  'geotextile', 'geomembrane', 'geogrid', 'geosynthetic', 'geosynthetics',
  'backfill', 'subgrade', 'subbase', 'embankment', 'riprap', 'rip-rap',
  'borrow', 'grubbing', 'dewatering', 'shoring', 'sheeting',
  'compaction', 'gradation', 'proctor', 'Proctor',
  'preconstruction', 'jobsite', 'punchlist', 'earthwork', 'groundwater',
  'subcontractor', 'subcontractors', 'workmanship',
  'geotechnical', 'topsoil', 'bedrock', 'overburden',
  'subdrain', 'underdrain', 'wellpoint', 'wellpoints',
  'demobilization', 'mobilization', 'remobilization',
  // Specification terms
  'UMRL', 'UMSL', 'RID', 'SRF', 'CCR',
  'designator', 'designators',
];

// Harper rules to disable for construction specification text
const DISABLED_RULES = {
  LongSentences: false,     // Specs routinely have 40+ word sentences
  Spaces: false,            // UFGS uses double spaces after periods
  SpelledNumbers: false,    // "24 inches", "600 mm" are standard
  BoringWords: false,       // "provide", "install" are correct spec verbs
};

let linter = null;
let ready = false;
let version = 0;
let initPromise = null;

/**
 * Initialize the grammar checker (lazy, idempotent).
 * Downloads WASM binary and sets up the Web Worker.
 */
export async function initGrammarChecker() {
  if (ready) return;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    try {
      const { WorkerLinter, binary, Dialect } = await import('harper.js');
      linter = new WorkerLinter({ binary, dialect: Dialect.American });
      await linter.setup();
      await linter.importWords(ENGINEERING_TERMS);
      // Disable rules that conflict with UFGS conventions
      const config = await linter.getLintConfig();
      Object.assign(config, DISABLED_RULES);
      await linter.setLintConfig(config);
      ready = true;
    } catch (e) {
      ready = false;
      linter = null;
      initPromise = null;
      throw e;
    }
  })();

  return initPromise;
}

/**
 * Check if the grammar checker is initialized and ready.
 */
export function isGrammarReady() {
  return ready;
}

/**
 * Get the current version number (for stale result detection).
 */
export function getVersion() {
  return version;
}

/**
 * Run grammar checking on plain text.
 * Returns violations in the same shape as compliance rules.
 *
 * @param {string} plainText - Text to check
 * @param {string} blockId - Block identifier
 * @returns {Promise<Array>} violations
 */
export async function checkGrammar(plainText, blockId) {
  if (!ready || !linter || !plainText) return [];

  version++;
  const requestVersion = version;

  try {
    const lints = await linter.lint(plainText, { language: 'plaintext' });

    // Stale check: if version changed while awaiting, discard
    if (requestVersion !== version) return [];

    const violations = [];

    for (const lint of lints) {
      const span = lint.span();
      const problemText = lint.get_problem_text();

      // Skip alphanumeric reference designators (ASTM D4829, AASHTO T99, etc.)
      // Pattern: optional letters followed by digits (and more alphanumeric/hyphens)
      if (/^[A-Z]{0,4}\d[\w-]*$/i.test(problemText)) continue;

      const suggestions = lint.suggestions();
      const hasSuggestion = suggestions.length > 0;

      let fixFn = null;
      let replacement = null;
      if (hasSuggestion) {
        const candidateReplacement = suggestions[0].get_replacement_text();
        // Filter out bad suggestions: suppress fix but still show the error
        const isBadSuggestion = (
          (!problemText.includes(' ') && candidateReplacement.includes(' ')) ||
          candidateReplacement.length > problemText.length * 2
        );
        if (!isBadSuggestion) {
          // Detect "add punctuation" suggestions: if the replacement is only
          // punctuation and the problem text is a word, append rather than replace.
          // e.g., Oxford comma: problemText="obstructions", replacement="," → "obstructions,"
          const isPunctuationOnly = /^[,;:.!?]+$/.test(candidateReplacement);
          const problemIsWord = /\w/.test(problemText);

          if (isPunctuationOnly && problemIsWord) {
            replacement = problemText + candidateReplacement;
          } else {
            replacement = candidateReplacement;
          }

          fixFn = (html) => {
            return html.replace(problemText, replacement);
          };
        }
        // Bad suggestions: violation is still shown (highlighted) but with no Fix
      }

      violations.push({
        ruleId: `GRAMMAR-${lint.lint_kind()}`,
        blockId,
        match: problemText,
        index: span.start,
        sentence: plainText.slice(
          Math.max(0, span.start - 40),
          Math.min(plainText.length, span.end + 40)
        ),
        fixFn,
        message: lint.message(),
        severity: 'low',
        category: 'grammar',
        ufsRef: null,
        replacement,
      });
    }

    return violations;
  } catch {
    return [];
  }
}

/**
 * Destroy the grammar checker, freeing resources.
 */
export function destroyGrammarChecker() {
  if (linter) {
    try { linter.dispose(); } catch {}
    linter = null;
  }
  ready = false;
  initPromise = null;
}
