/**
 * Grammar Checker — Harper.js Web Worker wrapper for SecWriter.
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

import { replaceAtOffset } from './fix-utils.js';

// Construction/engineering terms to add to Harper's dictionary.
// Mined from corpus of 2,583 UFGS blocks — includes all terms with 2+ FPs
// plus domain-specific terms likely to appear across sections.
export const ENGINEERING_TERMS = [
  // Standards organizations
  'ASTM', 'AASHTO', 'NAVFAC', 'USACE', 'AFCEC', 'UFGS', 'UFC', 'UFS',
  'ANSI', 'IEEE', 'ASHRAE', 'NFPA', 'OSHA', 'SMACNA', 'SSPC', 'NICET',
  'NEMA', 'UL', 'ASME', 'AWS', 'IEC', 'ICC',
  // Units and abbreviations
  'psi', 'pcf', 'ksf', 'ksi', 'psf', 'plf', 'klf', 'kPa', 'MPa', 'GPa',
  'mm', 'cm', 'kN', 'MN', 'kv', 'kva', 'btu', 'btuh', 'cfm', 'rms',
  'gpm', 'kcmil', 'ka',
  // Plumbing / mechanical
  'cleanout', 'cleanouts', 'backflow', 'waterstops', 'preventer', 'preventers',
  'flushometer', 'showerhead', 'showerheads', 'diverter', 'weepholes',
  'hypochlorite', 'hypochlorites', 'hypochlorinator', 'chlorinator',
  'aftercoolers', 'bedplates', 'bubblers', 'nonclogging', 'prepiped', 'bibb',
  'dampproofing', 'weldments', 'gasketed', 'gasketing', 'upstands',
  'polytetrafluoroethylene', 'acrylonitrile', 'polyolefin', 'polyetherimide',
  'polyethersulfone', 'chloroprene', 'propylene', 'styrene', 'butadiene',
  'butyl', 'phenolic', 'elastomer', 'elastomeric', 'thermoset', 'thermosetting',
  // Electrical
  'panelboard', 'panelboards', 'busbar', 'busbars', 'busway', 'busways',
  'wireways', 'fuseholders', 'coverplates', 'faceplates', 'faceplate',
  'solderless', 'locknuts', 'modbus', 'subfeed', 'milliamperes', 'ampacity',
  'commutated', 'commutates', 'intumescent', 'fillister',
  // Construction / concrete
  'submittal', 'submittals', 'punchlist', 'rebar', 'rebars',
  'geotextile', 'geomembrane', 'geogrid', 'geosynthetic', 'geosynthetics',
  'backfill', 'subgrade', 'subbase', 'embankment', 'riprap', 'rip-rap',
  'borrow', 'grubbing', 'dewatering', 'unwatering', 'shoring', 'sheeting',
  'compaction', 'gradation', 'proctor', 'Proctor',
  'preconstruction', 'jobsite', 'earthwork', 'groundwater',
  'subcontractor', 'subcontractors', 'workmanship',
  'geotechnical', 'geostatic', 'topsoil', 'bedrock', 'overburden',
  'subdrain', 'underdrain', 'wellpoint', 'wellpoints',
  'demobilization', 'mobilization', 'remobilization',
  'cementitious', 'pozzolan', 'pozzolans', 'laitance', 'alkalis',
  'premolded', 'nonprestressed', 'prestressing', 'tensioning',
  'densified', 'densifies', 'flexural', 'trueness', 'permeance',
  'reshoring', 'reshores', 'backshoring', 'backshores',
  'profilograph', 'sublots', 'handholes', 'handhole',
  'dunnage', 'spandrel', 'scabbling', 'sawcut',
  // Paving / asphalt
  'superpave', 'gyratory', 'antistrip', 'footcandles',
  'uncompacted', 'noncrushed', 'smoothwall',
  // Materials / chemistry
  'coliform', 'aramid', 'borides', 'cathodically', 'phosphatizing',
  'inhibitive', 'pervious', 'nonasphaltic', 'biobased',
  // Specification / general
  'UMRL', 'UMSL', 'RID', 'SRF', 'CCR',
  'designator', 'designators',
  'watersense', 'WaterSense', 'paver',
  'firestop', 'aboveground', 'submetering',
  'verminproof', 'nonremovable', 'noncurrent', 'nonoverloading',
  'semirecessed', 'unventilated', 'unplated',
  'belleville', 'Belleville', 'lexan', 'Lexan', 'portland', 'Portland',
  // Additional frequent FPs from corpus mining
  'flanged', 'arresters', 'arrester', 'gage',
  'workability', 'diabase', 'windings',
  'tricalcium', 'aluminate', 'debonded', 'rebending',
  'presoak', 'presaturate', 'topsoiling', 'sprigging',
  'predrilled', 'predrilling', 'sleeving', 'reweld',
  // Fire protection / suppression (from dictionary mining)
  'annunciated', 'annunciate', 'sprinklered', 'firestopping',
  'storz', 'gridded', 'occupancies',
  // HVAC / controls (from dictionary mining)
  'commandable', 'setpoints', 'positioner', 'positioners',
  'psychrometers', 'retransmit', 'retransmitting', 'retransmits',
  'noncondensing', 'overridable', 'multidrop', 'waveforms',
  // Electrical (from dictionary mining)
  'derated', 'multipole', 'polyphase', 'pushbutton',
  'watthour', 'milliohms', 'impedances', 'compartmented',
  'subintervals', 'thermoweld',
  // Communications / low-voltage (from dictionary mining)
  'connectorized', 'intrabuilding', 'interbuilding', 'innerduct',
  'multimode', 'couplers', 'splitters', 'reflectometer',
  'reflectance', 'topologies', 'cutovers',
  // Fire alarm / electronic safety (from dictionary mining)
  'telecommunicator', 'waterflow',
  // Finishes / coatings (from dictionary mining)
  'predecorated', 'soffits', 'soffit', 'bullnose',
  'cornerbeads', 'shaftwall', 'specular', 'unglazed',
  'strippable', 'aluminized', 'batts', 'biocides',
  'delamination', 'viscoelastic',
  // Earthwork / geotechnical (from dictionary mining)
  'cohesionless', 'sheepsfoot', 'surficial', 'piezometers',
  'borings', 'brooming', 'topsoiled', 'siltation', 'rammer',
  'ignitability', 'flowable', 'subgrades', 'recompact',
  'recompacting', 'unburned',
  // Exterior improvements / paving (from dictionary mining)
  'coverages', 'pozzolanic', 'spacings',
  // Special construction (from dictionary mining)
  'purlins', 'purlin', 'cullet', 'flashings',
  'polyisocyanurate', 'polyvinylidene',
  // Utilities (from dictionary mining)
  'blowoff', 'chloramine', 'chloramines', 'electrofusion',
  'helically', 'trenchless', 'submergible', 'nutating',
  'nonreinforced', 'anodic', 'handwheels', 'molecularly', 'wye',
  // Automation / BAS (from dictionary mining)
  'programmability',
  // General / multi-division (from dictionary mining)
  'prestressed', 'loadings', 'resubmittal', 'screwheads',
  'hydrological', 'hydrostatic', 'hydrostatically', 'centerlines',
  'locatable', 'bibbs',
  // Additional FPs from clean corpus measurement (April 2026)
  'gph', 'gpd', 'mgd', 'cfh', 'mph', 'rpm', 'fps',
  'PTFE', 'CPVC', 'EPDM', 'HDPE', 'LLDPE', 'XLPE',
  'THWN', 'THHN', 'XHHW',
  'jobsite', 'jobsites', 'standoff', 'standoffs',
];

// User-editable custom dictionary (persisted in localStorage)
const USER_DICT_KEY = 'sim-user-dictionary';

function loadUserDict() {
  try {
    if (typeof localStorage === 'undefined') return [];
    const raw = localStorage.getItem(USER_DICT_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((w) => typeof w === 'string')
      .map((w) => w.trim())
      .filter((w) => w.length > 0);
  } catch {
    return [];
  }
}

function saveUserDict(words) {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(USER_DICT_KEY, JSON.stringify(words));
  } catch {
    // Quota or privacy mode — ignore
  }
}

/**
 * Get the current user-added dictionary words.
 * @returns {string[]}
 */
export function getUserDict() {
  return loadUserDict();
}

/**
 * Add a word to the user dictionary. Persists to localStorage and imports
 * into Harper immediately if the linter is ready.
 *
 * @param {string} word
 * @returns {string[]} updated dictionary
 */
export async function addUserWord(word) {
  const trimmed = (word || '').trim();
  if (!trimmed) return loadUserDict();

  const current = loadUserDict();
  // De-dupe case-sensitively (Harper treats "PSNS" and "psns" differently)
  if (current.includes(trimmed)) return current;

  const updated = [...current, trimmed];
  saveUserDict(updated);

  if (ready && linter) {
    try {
      await linter.importWords([trimmed]);
    } catch {
      // Import failed — word is still persisted and will load on next init
    }
  }
  return updated;
}

// Harper rules to disable for construction specification text
export const DISABLED_RULES = {
  LongSentences: false,     // Specs routinely have 40+ word sentences
  Spaces: false,            // UFGS uses double spaces after periods
  SpelledNumbers: false,    // "24 inches", "600 mm" are standard
  BoringWords: false,       // "provide", "install" are correct spec verbs
  // Noise rules — produce thousands of trailing-whitespace and long-sentence
  // findings on UFGS text without offering actionable fixes for spec authors.
  Formatting: false,        // "Unnecessary space at end of sentence" — UFGS-tolerated
  Readability: false,       // Long-sentence variant; specs are inherently long
  // NOTE: Repetition stays enabled — disabling it regressed GRAMMAR-Agreement
  // recall from 56% → 38% on the dirty corpus.
};

// Pre-compute lowercase set for case-insensitive dictionary lookup. Harper's
// importWords is case-sensitive (so "cementitious" doesn't cover "Cementitious"
// at the start of a sentence). We also check this set to suppress spelling
// findings regardless of capitalization.
const ENGINEERING_TERMS_LOWER = new Set(
  ENGINEERING_TERMS.map((w) => w.toLowerCase())
);

/**
 * Pure helper: should this Harper finding be suppressed as a known false
 * positive? Shared between the production checkGrammar() pipeline and the
 * offline corpus runner so both measure identical filter behavior.
 *
 * @param {string} problemText - The token Harper flagged
 * @param {Set<string>} userDictLower - User dictionary in lowercase
 * @returns {boolean} true if the finding should be discarded
 */
export function shouldSuppressGrammarFinding(problemText, userDictLower) {
  if (!problemText) return true;
  // Skip alphanumeric reference designators (ASTM D4829, AASHTO T99, M-43)
  if (/^[A-Z]{0,4}\d[\w-]*$/i.test(problemText)) return true;
  // Skip single-character matches (list labels, ordinal fragments)
  if (problemText.length <= 1) return true;
  // Skip single-letter list labels with trailing period: "A.", "F.", "i."
  if (/^[A-Za-z]\.$/.test(problemText)) return true;
  // Skip engineering formula notation: f'c, t'p, K'a (apostrophe-tagged vars)
  if (/^[A-Za-z]'[A-Za-z]$/.test(problemText)) return true;
  // Skip 2-6 letter all-caps acronyms with optional trailing 's' for plurals
  // (ACI, CSA, AWG, ASSE, AWWA, IAPMO, CFR, SPDs, etc.). Spec text is dense
  // with standards organizations and discipline acronyms — Harper has no
  // hope of recognizing them all.
  if (/^[A-Z]{2,6}s?$/.test(problemText)) return true;
  // Skip lowercase hyphenated compounds with standard English prefixes:
  // "non-conforming", "post-industrial", "pre-cast", "sub-base", "semi-annual"
  if (/^(non|pre|post|sub|semi|multi|anti|re|un|over|under|inter|intra|cross)-[a-z]+$/i.test(problemText)) return true;
  // Skip terms in the production engineering dictionary (case-insensitive)
  if (ENGINEERING_TERMS_LOWER.has(problemText.toLowerCase())) return true;
  // Skip terms in the user's custom dictionary
  if (userDictLower && userDictLower.has(problemText.toLowerCase())) return true;
  return false;
}

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
      // harper.js 2.0 split the binary into a separate subpath export so apps
      // can tree-shake unused binary variants (slim/inlined). The two imports
      // are independent — load them in parallel.
      const [{ WorkerLinter, Dialect }, { binary }] = await Promise.all([
        import('harper.js'),
        import('harper.js/binary'),
      ]);
      linter = new WorkerLinter({ binary, dialect: Dialect.American });
      await linter.setup();
      await linter.importWords(ENGINEERING_TERMS);
      const userWords = loadUserDict();
      if (userWords.length > 0) {
        await linter.importWords(userWords);
      }
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
  const userDictLower = new Set(loadUserDict().map((w) => w.toLowerCase()));

  try {
    const lints = await linter.lint(plainText, { language: 'plaintext' });

    // Stale check: if version changed while awaiting, discard
    if (requestVersion !== version) return [];

    const violations = [];

    for (const lint of lints) {
      const span = lint.span();
      const problemText = lint.get_problem_text();

      // Apply shared FP filter (alphanumeric refs, single chars, formula
      // notation, engineering dict, user dict). Harper's importWords is
      // case-sensitive and only suppresses unknown-word findings, so this
      // catch-all also handles capitalized variants and grammar/style rules
      // firing on words the dictionary already covers.
      if (shouldSuppressGrammarFinding(problemText, userDictLower)) continue;

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

          fixFn = (html, _match, _repl, targetOffset) => {
            return replaceAtOffset(html, problemText, replacement, targetOffset);
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
