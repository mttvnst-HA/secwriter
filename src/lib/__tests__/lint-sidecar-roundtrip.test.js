/**
 * Integration test for the file-mode `.lint.json` sidecar (#138 phase 1).
 *
 * Mirrors what App.jsx does on Save → Load:
 *   1. Build a linting.byBlock map (the in-memory cache).
 *   2. Encode it through lint-sidecar.encodeSidecar against the current blocks.
 *   3. JSON-stringify + write to a temp file.
 *   4. Read the temp file, JSON.parse, decodeSidecar, projectDecoded against
 *      the same blocks (simulating "user reopens the same .SEC").
 *   5. prefillFromSidecar into a fresh linting.createInitial() and assert
 *      the findings come back.
 *
 * No DOM, no React — just the file boundary.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  encodeSidecar,
  decodeSidecar,
  projectDecoded,
} from '../lint-sidecar.js';
import * as linting from '../linting.js';

function v(ruleId, index, match, severity = 'medium') {
  return { ruleId, index, match, severity };
}
function f(violation) {
  return { range: null, violation };
}

const BLOCKS = [
  { id: 'n1', type: 'note', html: 'NOTE: see drawings.' },
  { id: 'n2', type: 'txt', html: 'Contractor shall provide widgets per spec.' },
  { id: 'n3', type: 'txt', html: 'Furnish materials as required.' },
];

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sim-lint-sidecar-'));
}

describe('lint-sidecar file-mode round-trip', () => {
  it('save → file → load preserves byBlock findings', async () => {
    const dir = tmpdir();
    try {
      // 1. In-memory cache: n1 clean, n2 dirty, n3 absent (not yet linted).
      const byBlock = new Map([
        ['n1', { compliance: [], nlp: [], grammar: [], grammarText: null }],
        ['n2', {
          compliance: [f(v('TERM-shall', 12, 'shall'))],
          nlp: [],
          grammar: [],
          grammarText: null,
        }],
      ]);

      // 2. Encode.
      const payload = await encodeSidecar(byBlock, BLOCKS);
      const json = JSON.stringify(payload);

      // 3. Write to disk.
      const sidecarPath = path.join(dir, '31_00_00.lint.json');
      fs.writeFileSync(sidecarPath, json, 'utf-8');

      // 4. Read back, decode, project against the same blocks.
      const rawOnDisk = fs.readFileSync(sidecarPath, 'utf-8');
      const parsed = JSON.parse(rawOnDisk);
      const decoded = decodeSidecar(parsed);
      const projection = await projectDecoded(decoded, BLOCKS);

      // 5. Prefill the linting reducer.
      const state = linting.prefillFromSidecar(linting.createInitial(), projection);

      expect(state.byBlock.size).toBe(2);             // n3 was never linted; not in cache
      expect(linting.getBlockFindings(state, 'n1')).toHaveLength(0);
      expect(linting.getBlockFindings(state, 'n2')).toHaveLength(1);
      expect(state.byBlock.get('n2').compliance[0].violation.ruleId).toBe('TERM-shall');
      expect(state.byBlock.get('n2').compliance[0].range).toBeNull(); // ranges re-derived on render
      expect(state.byBlock.has('n3')).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('absent sidecar is a no-op — linting starts empty (behavioral invariant)', async () => {
    // Simulate the App-side behavior when .lint.json doesn't accompany the .SEC:
    // the load path simply doesn't invoke decodeSidecar/projectDecoded.
    const state = linting.createInitial();
    expect(state.byBlock.size).toBe(0);
    expect(state.enabled).toBe(true);
    // Engines run normally on the next debounced lint — verified by the
    // existing linting.test.js (this test asserts the precondition).
  });

  it('malformed sidecar falls through to empty prefill', async () => {
    const dir = tmpdir();
    try {
      const sidecarPath = path.join(dir, 'bad.lint.json');
      fs.writeFileSync(sidecarPath, '{not valid json', 'utf-8');
      const raw = fs.readFileSync(sidecarPath, 'utf-8');
      // The App-side handler wraps JSON.parse in try/catch; emulate.
      let parsed = null;
      try { parsed = JSON.parse(raw); } catch { /* swallow */ }
      const decoded = decodeSidecar(parsed);
      const projection = await projectDecoded(decoded, BLOCKS);
      const state = linting.prefillFromSidecar(linting.createInitial(), projection);
      expect(state.byBlock.size).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('sidecar from old file version (v=2) is rejected — engines run normally', async () => {
    const decoded = decodeSidecar({ v: 2, good: '', bad: {} });
    expect(decoded.fingerprints.size).toBe(0);
    const projection = await projectDecoded(decoded, BLOCKS);
    expect(projection.size).toBe(0);
  });

  it('size budget: sample-spec all-clean cache stays well under 50 KB', async () => {
    // Worst-case: all 426 sample-spec blocks are cached as clean. Verify
    // the encoded payload comes in well under the issue's 50 KB target.
    const sample = (await import('../../data/sample-31-00-00.json')).default;
    const byBlock = new Map();
    for (const b of sample) {
      byBlock.set(b.id, { compliance: [], nlp: [], grammar: [], grammarText: null });
    }
    const encoded = await encodeSidecar(byBlock, sample);
    const json = JSON.stringify(encoded);
    const bytes = Buffer.byteLength(json, 'utf-8');
    // 426 unique fingerprints × 24 chars ≈ 10 KB, plus envelope overhead.
    expect(bytes).toBeLessThan(50 * 1024);
  });
});
