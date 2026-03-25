/**
 * Harper Dictionary Miner
 *
 * Mines UFGS .SEC files across diverse CSI divisions to identify words that
 * Harper.js flags as misspelled but are legitimate engineering/specification
 * terms. These are candidates for adding to the ENGINEERING_TERMS dictionary
 * in src/lib/grammar-checker.js.
 *
 * Usage:
 *   node tools/harper-dictionary-miner.mjs
 *
 * Output:
 *   tools/harper-candidates.txt  — words flagged by Harper, grouped by letter
 *   tools/harper-candidates.json — structured data (word -> count, sections)
 */

import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { LocalLinter, binaryInlined } from '../node_modules/harper.js/dist/harper.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const UFGS_DIR = join(ROOT, 'reference', 'UFGS_M');

// ---------------------------------------------------------------------------
// Target .SEC files — one per CSI division, chosen for breadth of disciplines
// ---------------------------------------------------------------------------
const TARGET_FILES = [
  // Division 09 — Finishes / coatings
  '09 29 00.SEC',          // Gypsum board drywall
  // Division 13 — Special construction
  '13 34 19.SEC',          // Metal building systems
  // Division 21 — Fire suppression
  '21 13 13.SEC',          // Wet-pipe sprinkler systems
  // Division 23 — HVAC
  '23 09 00.SEC',          // HVAC instrumentation & controls
  // Division 25 — Integrated automation
  '25 10 10.SEC',          // Integrated automation network equipment
  // Division 26 — Electrical
  '26 20 00.SEC',          // Interior distribution system
  // Division 27 — Communications
  '27 10 00.SEC',          // Structured cabling
  // Division 28 — Electronic safety & security
  '28 31 32.SEC',          // Digital fire detection
  // Division 31 — Earthwork
  '31 00 00.SEC',          // Earthwork
  // Division 32 — Exterior improvements
  '32 11 23.SEC',          // Aggregate base courses
  // Division 33 — Utilities
  '33 11 00.SEC',          // Water distribution
];

// ---------------------------------------------------------------------------
// Existing ENGINEERING_TERMS — words already in the dictionary (skip these)
// Copied from src/lib/grammar-checker.js lines 20-80
// ---------------------------------------------------------------------------
const EXISTING_TERMS = new Set([
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
]);

// Case-insensitive set for deduplication
const EXISTING_LOWER = new Set([...EXISTING_TERMS].map(t => t.toLowerCase()));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Strip XML/SGML tags and decode basic entities from .SEC content.
 * Returns plain text suitable for linting.
 */
function extractPlainText(raw) {
  return raw
    // Remove XML processing instructions and DOCTYPE
    .replace(/<\?[^>]*\?>/g, ' ')
    .replace(/<!DOCTYPE[^>]*>/g, ' ')
    // Remove CDATA
    .replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, ' ')
    // Remove all tags
    .replace(/<[^>]+>/g, ' ')
    // Decode common XML/HTML entities
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#\d+;/g, ' ')
    .replace(/&[a-zA-Z]+;/g, ' ')
    // Collapse whitespace
    .replace(/[ \t]+/g, ' ')
    .replace(/\r\n/g, '\n')
    .trim();
}

/**
 * Split text into chunks of at most MAX_CHARS characters,
 * breaking on paragraph/sentence boundaries where possible.
 */
function chunkText(text, maxChars = 4000) {
  const chunks = [];
  // Split on double newline (paragraph) first
  const paragraphs = text.split(/\n\s*\n/);
  let current = '';
  for (const para of paragraphs) {
    if (current.length + para.length + 2 > maxChars) {
      if (current.length > 0) {
        chunks.push(current.trim());
        current = '';
      }
      // If a single paragraph exceeds maxChars, split it further
      if (para.length > maxChars) {
        const sentences = para.split(/(?<=[.!?])\s+/);
        for (const sent of sentences) {
          if (current.length + sent.length + 1 > maxChars) {
            if (current.length > 0) chunks.push(current.trim());
            current = sent;
          } else {
            current += (current ? ' ' : '') + sent;
          }
        }
      } else {
        current = para;
      }
    } else {
      current += (current ? '\n\n' : '') + para;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('Initializing Harper.js LocalLinter...');
  const linter = new LocalLinter({ binary: binaryInlined });
  await linter.setup();

  // Disable rules that don't apply to spec text (mirrors grammar-checker.js)
  try {
    const configJson = linter.getLintConfigAsJSON();
    const config = JSON.parse(configJson);
    for (const rule of ['LongSentences', 'Spaces', 'SpelledNumbers', 'BoringWords']) {
      if (Object.prototype.hasOwnProperty.call(config, rule)) config[rule] = false;
    }
    linter.setLintConfigWithJSON(JSON.stringify(config));
  } catch (_) {
    // Proceed without config — not critical for spelling detection
  }
  console.log('Harper.js ready.\n');

  // Map: lowercase word -> { count, sections: Set<string>, original: string }
  const candidates = new Map();

  for (const filename of TARGET_FILES) {
    const filePath = join(UFGS_DIR, filename);
    let raw;
    try {
      // latin1 is close enough to windows-1252 for word/text extraction
      raw = readFileSync(filePath, 'latin1');
    } catch (e) {
      console.warn(`  SKIP (not found): ${filename}`);
      continue;
    }

    const division = filename.split(' ')[0];
    console.log(`Processing ${filename} (Div ${division})...`);

    const plainText = extractPlainText(raw);
    const chunks = chunkText(plainText);
    console.log(`  ${chunks.length} text chunks to lint`);

    let totalLints = 0;
    let newCandidates = 0;

    for (const chunk of chunks) {
      let lints;
      try {
        lints = await linter.lint(chunk);
      } catch (e) {
        console.warn(`  Lint error: ${e.message}`);
        continue;
      }

      for (const lint of lints) {
        if (lint.lint_kind() !== 'Spelling') continue;
        totalLints++;

        const flaggedWord = lint.get_problem_text();
        if (!flaggedWord || flaggedWord.length < 3) continue;
        // Skip all-uppercase tokens (abbreviations like ASTM, RID, etc.)
        if (/^[A-Z0-9]+$/.test(flaggedWord)) continue;
        // Skip pure numbers or tokens with digits
        if (/\d/.test(flaggedWord)) continue;

        const key = flaggedWord.toLowerCase();

        // Skip if already in the dictionary
        if (EXISTING_LOWER.has(key)) continue;

        if (!candidates.has(key)) {
          candidates.set(key, { count: 0, sections: new Set(), original: flaggedWord });
          newCandidates++;
        }
        const entry = candidates.get(key);
        entry.count += 1;
        entry.sections.add(division);
      }
    }

    console.log(`  Spelling lints: ${totalLints}, new candidates added: ${newCandidates}\n`);
  }

  console.log(`\nTotal unique candidate words: ${candidates.size}`);

  // ---------------------------------------------------------------------------
  // Write JSON output
  // ---------------------------------------------------------------------------
  const sortedEntries = [...candidates.entries()]
    .sort(([a], [b]) => a.localeCompare(b));

  const jsonOut = {};
  for (const [key, data] of sortedEntries) {
    jsonOut[key] = {
      word: data.original,
      count: data.count,
      sections: [...data.sections].sort(),
    };
  }

  const jsonPath = join(__dirname, 'harper-candidates.json');
  writeFileSync(jsonPath, JSON.stringify(jsonOut, null, 2), 'utf8');
  console.log(`Wrote ${jsonPath}`);

  // ---------------------------------------------------------------------------
  // Write human-readable text output, grouped by first letter
  // ---------------------------------------------------------------------------
  const byLetter = {};
  for (const [key, data] of sortedEntries) {
    const letter = key[0].toUpperCase();
    if (!byLetter[letter]) byLetter[letter] = [];
    byLetter[letter].push({ key, word: data.word, count: data.count, sections: data.sections });
  }

  const lines = [
    '# Harper Dictionary Candidates',
    `# Generated: ${new Date().toISOString()}`,
    `# Source: ${TARGET_FILES.length} UFGS .SEC files across CSI Divisions 09-33`,
    `# Total candidates: ${candidates.size}`,
    '#',
    '# Format: word  [count occurrences, divisions: XX,YY,ZZ]',
    '# These words were flagged as misspelled by Harper but appear in UFGS specs.',
    '# Review each word — add to ENGINEERING_TERMS if it is a real domain term.',
    '',
  ];

  for (const letter of Object.keys(byLetter).sort()) {
    lines.push(`## ${letter}`);
    const entries = byLetter[letter].sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
    for (const entry of entries) {
      const word = entry.word || entry.key;
      const divStr = [...entry.sections].sort().join(', ');
      lines.push(`${word.padEnd(30)} [${entry.count}x, div: ${divStr}]`);
    }
    lines.push('');
  }

  const txtPath = join(__dirname, 'harper-candidates.txt');
  writeFileSync(txtPath, lines.join('\n'), 'utf8');
  console.log(`Wrote ${txtPath}`);

  // Print a preview of the top candidates
  console.log('\nTop 30 candidates by frequency:');
  const topCandidates = [...candidates.entries()]
    .sort(([keyA, a], [keyB, b]) => b.count - a.count || keyA.localeCompare(keyB))
    .slice(0, 30);
  for (const [key, data] of topCandidates) {
    const word = data.original || key;
    const divStr = [...data.sections].sort().join(',');
    console.log(`  ${word.padEnd(25)} ${String(data.count).padStart(3)}x  [div ${divStr}]`);
  }
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
