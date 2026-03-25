#!/usr/bin/env node
// run-audit.mjs — Orchestrate a UI audit session
//
// Usage: node tools/ui-audit/run-audit.mjs [--area <id>] [--list]
//
// This script does NOT automate Chrome directly — it prepares the environment
// and generates the findings JSON structure. Claude follows test-procedure.md
// using Chrome MCP tools interactively.

import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

const AUDIT_DIR = 'tools/ui-audit';
const TEST_AREAS_DIR = join(AUDIT_DIR, 'test-areas');
const RESULTS_DIR = 'test-results';
const SCREENSHOTS_DIR = join(RESULTS_DIR, 'screenshots');

const args = process.argv.slice(2);

// --list: show all test areas
if (args.includes('--list')) {
  const areas = readdirSync(TEST_AREAS_DIR).filter(f => f.endsWith('.md')).sort();
  console.log('\nAvailable test areas:\n');
  for (const a of areas) {
    const id = a.replace('.md', '');
    const content = readFileSync(join(TEST_AREAS_DIR, a), 'utf8');
    const title = content.match(/^# .+ — (.+)$/m)?.[1] || id;
    console.log(`  ${id}  ${title}`);
  }
  console.log(`\nTotal: ${areas.length} areas`);
  process.exit(0);
}

// Ensure directories exist
mkdirSync(SCREENSHOTS_DIR, { recursive: true });

// Check dev server (Node 18+ fetch, no curl dependency)
let devServerRunning = false;
try {
  const resp = await fetch('http://localhost:5173', { signal: AbortSignal.timeout(3000) });
  devServerRunning = resp.ok;
} catch {
  devServerRunning = false;
}

// Initialize findings structure
const areaFilter = args.includes('--area') ? args[args.indexOf('--area') + 1] : null;
const areas = readdirSync(TEST_AREAS_DIR).filter(f => f.endsWith('.md')).sort();
const filteredAreas = areaFilter
  ? areas.filter(a => a.startsWith(areaFilter))
  : areas;

const findings = {
  timestamp: new Date().toISOString(),
  appUrl: 'http://localhost:5173',
  areas: filteredAreas.map(a => ({
    id: a.replace('.md', ''),
    name: (() => {
      const content = readFileSync(join(TEST_AREAS_DIR, a), 'utf8');
      return content.match(/^# .+ — (.+)$/m)?.[1] || a.replace('.md', '');
    })(),
    status: 'pending',
    findings: []
  })),
  summary: {
    totalAreas: filteredAreas.length,
    totalFindings: 0,
    bySeverity: { critical: 0, high: 0, medium: 0, low: 0, info: 0 }
  }
};

const findingsPath = join(RESULTS_DIR, 'findings.json');
writeFileSync(findingsPath, JSON.stringify(findings, null, 2), 'utf8');

console.log(`
  SpecsIntact Modern — UI Audit
  ─────────────────────────────
  Dev server:  ${devServerRunning ? '✅ Running at http://localhost:5173' : '❌ NOT RUNNING — run: npm run dev'}
  Areas:       ${filteredAreas.length} test areas queued
  Findings:    ${findingsPath}
  Screenshots: ${SCREENSHOTS_DIR}

  To run the audit:
  1. Ensure dev server is running (npm run dev)
  2. Open Chrome with Claude in Chrome MCP
  3. Follow tools/ui-audit/test-procedure.md
  4. Record findings in ${findingsPath}
  5. Run: node tools/ui-audit/collect-findings.mjs
  6. Run: node tools/ui-audit/promote-to-github.mjs
`);
