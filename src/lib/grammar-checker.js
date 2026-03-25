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

import { replaceAtOffset } from './fix-utils.js';

// Construction/engineering terms to add to Harper's dictionary.
// Mined from corpus of 2,583 UFGS blocks — includes all terms with 2+ FPs
// plus domain-specific terms likely to appear across sections.
const ENGINEERING_TERMS = [
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
  'borrow', 'grubbing', 'dewatering', 'shoring', 'sheeting',
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

      // Skip single-character matches (list labels like "a.", "s", ordinal fragments)
      if (problemText.length <= 1) continue;

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
