/**
 * UFGS Tag Coverage Tests
 *
 * Scans all .SEC files in reference/UFGS_M/ for every SGML tag,
 * cross-references against the parser's handled/skipped sets,
 * and asserts zero unhandled tags.
 *
 * Runner: Node built-in test runner (not Vitest)
 * Run: npm run test:ufgs
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { parseHTML } from 'linkedom';

const { DOMParser } = parseHTML('');
globalThis.DOMParser = DOMParser;

const { parseSEC } = await import('../src/lib/sec-parser.js');

const UFGS_DIR = 'reference/UFGS_M';
const files = fs.readdirSync(UFGS_DIR)
  .filter(f => f.toLowerCase().endsWith('.sec'))
  .map(f => path.join(UFGS_DIR, f));

// All tags the parser is expected to handle
const KNOWN_TAGS = new Set([
  'PRT', 'SPT', 'TTL', 'TXT', 'NPR', 'NPG', 'OLI', 'LST', 'ITM', 'TAB', 'REF', 'TBL',
  'NTE', 'OLG', 'SBM',
  'ADD', 'DEL', 'CHG',
  'RID', 'SRF', 'SUB', 'ENG', 'MET', 'TAI', 'TST', 'URL', 'HLS', 'ATT',
  'BLD', 'ITA', 'UND', 'HL1', 'HL2', 'HL3', 'HL4', 'SBS', 'SPS', 'CTR',
  'BRK', 'BRL', 'AST', 'NED', 'PGE', 'MTA', 'END', 'EOD',
  'SCP', 'PRA',
  'HDR', 'SCN', 'STL', 'DTE', 'SEC',
  'WBK', 'TDA', 'ROW', 'CEL', 'DTA', 'STS', 'STY', 'ALN', 'COL', 'INT',
  'THD',
  'ORG', 'RTL', 'OAD',
]);

// Parse all files once, cache results
const fileContents = new Map();
const parsed = new Map();
for (const file of files) {
  const content = fs.readFileSync(file, 'latin1');
  fileContents.set(file, content);
  try {
    parsed.set(file, parseSEC(content));
  } catch (e) {
    parsed.set(file, null);
  }
}

describe('UFGS tag coverage', () => {
  it('all tags in UFGS master are accounted for', () => {
    const unknownTags = new Map();
    const tagRegex = /<\/?([A-Z][A-Z0-9]*)/g;

    for (const [file, content] of fileContents) {
      let match;
      while ((match = tagRegex.exec(content)) !== null) {
        const tag = match[1];
        if (!KNOWN_TAGS.has(tag)) {
          if (!unknownTags.has(tag)) unknownTags.set(tag, []);
          const fname = path.basename(file);
          if (!unknownTags.get(tag).includes(fname)) {
            unknownTags.get(tag).push(fname);
          }
        }
      }
    }

    if (unknownTags.size > 0) {
      const details = [...unknownTags.entries()]
        .map(([tag, fnames]) => `  ${tag}: ${fnames.slice(0, 3).join(', ')}${fnames.length > 3 ? ` (+${fnames.length - 3} more)` : ''}`)
        .join('\n');
      assert.fail(`Found ${unknownTags.size} unhandled tag(s):\n${details}`);
    }
  });

  it('all files parse without error', () => {
    const errors = [];
    for (const [file, blocks] of parsed) {
      if (blocks === null) {
        errors.push(path.basename(file));
      }
    }
    assert.equal(errors.length, 0, `Parse errors in ${errors.length} file(s):\n${errors.slice(0, 10).join('\n')}`);
  });

  it('files with TBL tags produce tbl blocks', () => {
    const tblFiles = [...fileContents.entries()]
      .filter(([, content]) => content.includes('<TBL>') || content.includes('<TBL '))
      .map(([file]) => file);
    assert.ok(tblFiles.length > 0, 'Expected at least one file with TBL tags');

    const failures = [];
    for (const file of tblFiles) {
      const blocks = parsed.get(file);
      if (!blocks) continue;
      const tblBlocks = blocks.filter(b => b.type === 'tbl');
      if (tblBlocks.length === 0) {
        failures.push(path.basename(file));
      }
    }
    assert.equal(failures.length, 0, `Files with TBL tags but no tbl blocks: ${failures.join(', ')}`);
  });

  it('files with ATT tags produce mark-att spans', () => {
    const attFiles = [...fileContents.entries()]
      .filter(([, content]) => content.includes('<ATT>') || content.includes('<ATT '))
      .map(([file]) => file);
    assert.ok(attFiles.length > 0, 'Expected at least one file with ATT tags');

    // Known exception: 32 13 13.17.SEC uses ATT only as appendix section-heading
    // wrappers inside <HL4> elements at root level (outside PRT structure).
    // The parser correctly skips non-PRT root elements, so no mark-att is produced.
    const KNOWN_EXCEPTIONS = new Set(['32 13 13.17.SEC']);

    const failures = [];
    for (const file of attFiles) {
      const fname = path.basename(file);
      if (KNOWN_EXCEPTIONS.has(fname)) continue;
      const blocks = parsed.get(file);
      if (!blocks) continue;
      const hasAttMark = blocks.some(b => b.html && b.html.includes('mark-att'));
      if (!hasAttMark) {
        failures.push(fname);
      }
    }
    assert.equal(failures.length, 0, `Files with ATT tags but no mark-att spans: ${failures.join(', ')}`);
  });
});
