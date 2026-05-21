/**
 * Integration test for the #137 AI Tier section in generate-report.mjs.
 *
 * Writes a synthetic `corpus/results/ai-results.json` (two models × three
 * runs each), executes `generate-report.mjs` as a child process, verifies
 * the new section appears in REPORT.md with the expected ranking, then
 * restores the working tree.
 *
 * This is a smoke test for the renderer — the math itself is covered by
 * `ai-value-metric.test.js`. The integration test catches breakages in the
 * fixture-load → aggregate → markdown wiring.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, unlinkSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..');
const RESULTS_DIR = join(PROJECT_ROOT, 'corpus', 'results');
const AI_RESULTS_PATH = join(RESULTS_DIR, 'ai-results.json');
const REPORT_PATH = join(RESULTS_DIR, 'REPORT.md');
const REPORT_BACKUP = join(RESULTS_DIR, 'REPORT.md.test-backup');

const AI_RESULTS_PRESENT = existsSync(AI_RESULTS_PATH); // Don't clobber real runs.

const FIXTURE = {
  runs: [
    {
      model: 'claude-sonnet-4-6',
      generatedAt: '2026-05-20T00:00:00.000Z',
      blocks: [
        { blockId: 'n1', correctness: 0.92, inputTokens: 4000, outputTokens: 1200, violationsBefore: 3, violationsAfter: 0 },
        { blockId: 'n2', correctness: 0.88, inputTokens: 5000, outputTokens: 1500, violationsBefore: 2, violationsAfter: 0 },
        { blockId: 'n3', correctness: 0.90, inputTokens: 4500, outputTokens: 1300, violationsBefore: 1, violationsAfter: 0 },
      ],
    },
    {
      model: 'claude-haiku-4-5',
      generatedAt: '2026-05-20T00:01:00.000Z',
      blocks: [
        { blockId: 'n1', correctness: 0.75, inputTokens: 4000, outputTokens: 1200, violationsBefore: 3, violationsAfter: 1 },
        { blockId: 'n2', correctness: 0.80, inputTokens: 5000, outputTokens: 1500, violationsBefore: 2, violationsAfter: 0 },
        { blockId: 'n3', correctness: 0.78, inputTokens: 4500, outputTokens: 1300, violationsBefore: 1, violationsAfter: 0 },
      ],
    },
  ],
};

describe('generate-report.mjs — AI tier section (#137)', () => {
  let reportContents = '';

  beforeAll(() => {
    if (AI_RESULTS_PRESENT) {
      // A real run already exists — skip the test (don't clobber data).
      return;
    }
    // Back up existing REPORT.md so the test can restore the on-disk state.
    if (existsSync(REPORT_PATH)) copyFileSync(REPORT_PATH, REPORT_BACKUP);
    // Write the fixture.
    writeFileSync(AI_RESULTS_PATH, JSON.stringify(FIXTURE, null, 2));
    // Run the report generator.
    const result = spawnSync('node', ['tools/generate-report.mjs'], {
      cwd: PROJECT_ROOT,
      encoding: 'utf-8',
    });
    if (result.status !== 0) {
      throw new Error(`generate-report.mjs exit ${result.status}: ${result.stderr}`);
    }
    reportContents = readFileSync(REPORT_PATH, 'utf-8');
  });

  afterAll(() => {
    if (AI_RESULTS_PRESENT) return;
    // Restore the report and remove the fixture.
    if (existsSync(REPORT_BACKUP)) {
      copyFileSync(REPORT_BACKUP, REPORT_PATH);
      unlinkSync(REPORT_BACKUP);
    }
    if (existsSync(AI_RESULTS_PATH)) unlinkSync(AI_RESULTS_PATH);
    // Regenerate metrics.json to clear `ai` aggregates left by the test.
    spawnSync('node', ['tools/generate-report.mjs'], { cwd: PROJECT_ROOT });
  });

  it.skipIf(AI_RESULTS_PRESENT)('renders the AI Tier Value section with both models', () => {
    expect(reportContents).toMatch(/## 5\. AI Tier Value/);
    expect(reportContents).toMatch(/Claude Sonnet 4\.6/);
    expect(reportContents).toMatch(/Claude Haiku 4\.5/);
    // Both models should have a Value column entry. Format is a 3-decimal
    // number per the renderer; assert the row shape rather than the exact
    // figure to keep the test stable across minor pricing changes.
    const rows = reportContents.match(/\| Claude [^|]+ \| 3 \|/g);
    expect(rows).not.toBeNull();
    expect(rows.length).toBe(2);
  });

  it.skipIf(AI_RESULTS_PRESENT)('preserves existing section numbers (precision/recall/adversarial unchanged)', () => {
    expect(reportContents).toMatch(/## 1\. Calibration Results/);
    expect(reportContents).toMatch(/## 2\. Precision Results/);
    expect(reportContents).toMatch(/## 3\. Recall Results/);
    expect(reportContents).toMatch(/## 4\. Adversarial Results/);
    expect(reportContents).toMatch(/## 6\. Actionable Engine Improvements/);
    expect(reportContents).toMatch(/## 7\. Success Criteria Assessment/);
  });

  it.skipIf(AI_RESULTS_PRESENT)('writes ai aggregates into metrics.json', () => {
    const metrics = JSON.parse(readFileSync(join(RESULTS_DIR, 'metrics.json'), 'utf-8'));
    expect(metrics.ai).toBeDefined();
    expect(Object.keys(metrics.ai).sort()).toEqual(['claude-haiku-4-5', 'claude-sonnet-4-6']);
    expect(metrics.ai['claude-sonnet-4-6'].runs).toBe(3);
    expect(metrics.ai['claude-sonnet-4-6'].avgCorrectness).toBeCloseTo(0.9, 5);
    // Haiku is cheaper per token → lower avg $/run.
    expect(metrics.ai['claude-haiku-4-5'].avgUsdPerRun).toBeLessThan(metrics.ai['claude-sonnet-4-6'].avgUsdPerRun);
  });
});
