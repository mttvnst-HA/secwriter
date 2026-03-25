/**
 * UFGS Structural Validation Tests
 *
 * Parses all .SEC files and validates structural properties:
 * block counts, types, depths, table/ref integrity.
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

const VALID_TYPES = new Set([
  'title', 'txt', 'note', 'oli', 'item', 'lst', 'table', 'ref', 'pagebreak', 'tbl'
]);

// Parse all files once (shared across tests)
const parsed = new Map();
for (const file of files) {
  const content = fs.readFileSync(file, 'latin1');
  try {
    parsed.set(file, parseSEC(content));
  } catch (e) {
    parsed.set(file, null);
  }
}

describe('UFGS structural validation', () => {
  it('every file produces at least 1 block', () => {
    const empties = [];
    for (const [file, blocks] of parsed) {
      if (!blocks || blocks.length === 0) {
        empties.push(path.basename(file));
      }
    }
    assert.equal(empties.length, 0, `Empty parse results: ${empties.join(', ')}`);
  });

  it('every file has at least one title block', () => {
    const noTitle = [];
    for (const [file, blocks] of parsed) {
      if (!blocks) continue;
      if (!blocks.some(b => b.type === 'title')) {
        noTitle.push(path.basename(file));
      }
    }
    assert.equal(noTitle.length, 0, `Files without title blocks: ${noTitle.join(', ')}`);
  });

  it('all block types are in the known set', () => {
    const unknownTypes = new Map();
    for (const [file, blocks] of parsed) {
      if (!blocks) continue;
      for (const b of blocks) {
        if (!VALID_TYPES.has(b.type)) {
          if (!unknownTypes.has(b.type)) unknownTypes.set(b.type, []);
          unknownTypes.get(b.type).push(path.basename(file));
        }
      }
    }
    if (unknownTypes.size > 0) {
      const details = [...unknownTypes.entries()]
        .map(([type, fnames]) => `  "${type}": ${fnames.slice(0, 3).join(', ')}`)
        .join('\n');
      assert.fail(`Unknown block types:\n${details}`);
    }
  });

  it('no file has blocks with depth > 10', () => {
    const deep = [];
    for (const [file, blocks] of parsed) {
      if (!blocks) continue;
      const maxDepth = Math.max(...blocks.map(b => b.depth || 0));
      if (maxDepth > 10) {
        deep.push(`${path.basename(file)}: depth=${maxDepth}`);
      }
    }
    assert.equal(deep.length, 0, `Files with excessive depth:\n${deep.join('\n')}`);
  });

  it('table blocks have valid structure (rows array)', () => {
    const invalid = [];
    for (const [file, blocks] of parsed) {
      if (!blocks) continue;
      for (const b of blocks) {
        if (b.type === 'table') {
          if (!b.table || !Array.isArray(b.table.rows) || b.table.rows.length === 0) {
            invalid.push(path.basename(file));
            break;
          }
        }
      }
    }
    assert.equal(invalid.length, 0, `Files with invalid table structure: ${invalid.join(', ')}`);
  });

  it('ref blocks have org field', () => {
    const invalid = [];
    for (const [file, blocks] of parsed) {
      if (!blocks) continue;
      for (const b of blocks) {
        if (b.type === 'ref') {
          if (!b.ref || typeof b.ref.org === 'undefined') {
            invalid.push(path.basename(file));
            break;
          }
        }
      }
    }
    assert.equal(invalid.length, 0, `Files with ref blocks missing org: ${invalid.join(', ')}`);
  });

  it('part numbers are monotonically increasing', () => {
    const violations = [];
    for (const [file, blocks] of parsed) {
      if (!blocks) continue;
      let lastPart = 0;
      for (const b of blocks) {
        if (b.part !== undefined && b.part > 0) {
          if (b.part < lastPart) {
            violations.push(`${path.basename(file)}: part ${b.part} after part ${lastPart}`);
            break;
          }
          lastPart = b.part;
        }
      }
    }
    assert.equal(violations.length, 0, `Part number violations:\n${violations.join('\n')}`);
  });

  it('block count distribution is reasonable', () => {
    const extreme = [];
    for (const [file, blocks] of parsed) {
      if (!blocks) continue;
      if (blocks.length < 3) {
        extreme.push(`${path.basename(file)}: ${blocks.length} blocks`);
      }
    }
    assert.equal(extreme.length, 0, `Files with fewer than 3 blocks:\n${extreme.join('\n')}`);
  });
});
