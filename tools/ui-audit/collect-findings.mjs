#!/usr/bin/env node
// collect-findings.mjs — Generate Markdown report from UI audit findings JSON
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';

const inputPath = process.argv[2] || 'test-results/findings.json';
const data = JSON.parse(readFileSync(inputPath, 'utf8'));

const ts = data.timestamp.replace(/[:.]/g, '-').slice(0, 19);
const outputDir = 'test-results';
mkdirSync(outputDir, { recursive: true });
const outputPath = join(outputDir, `${ts}-ui-audit.md`);

const severityEmoji = { critical: '🔴', high: '🟠', medium: '🟡', low: '🔵', info: 'ℹ️' };
const statusEmoji = { pass: '✅', fail: '❌', partial: '⚠️', skipped: '⏭️', pending: '⏳' };

let md = `# UI Audit Report — ${data.timestamp}\n\n`;
md += `**App URL:** ${data.appUrl}\n\n`;

// Summary table
if (data.summary) {
  const s = data.summary;
  md += `## Summary\n\n`;
  md += `| Metric | Count |\n|--------|-------|\n`;
  md += `| Areas tested | ${s.totalAreas} |\n`;
  md += `| Total findings | ${s.totalFindings} |\n`;
  if (s.bySeverity) {
    for (const [sev, count] of Object.entries(s.bySeverity)) {
      if (count > 0) md += `| ${severityEmoji[sev]} ${sev} | ${count} |\n`;
    }
  }
  md += `\n`;
}

// Per-area sections
for (const area of data.areas) {
  md += `## ${statusEmoji[area.status]} ${area.id}: ${area.name}\n\n`;
  if (area.findings.length === 0) {
    md += `No issues found.\n\n`;
    continue;
  }
  for (const f of area.findings) {
    md += `### ${severityEmoji[f.severity]} ${f.id}: ${f.title}\n\n`;
    md += `**Severity:** ${f.severity} | **Component:** ${f.component || 'unknown'}\n\n`;
    md += `${f.description}\n\n`;
    if (f.expected) md += `**Expected:** ${f.expected}\n\n`;
    if (f.actual) md += `**Actual:** ${f.actual}\n\n`;
    if (f.steps && f.steps.length > 0) {
      md += `**Steps to reproduce:**\n`;
      f.steps.forEach((s, i) => { md += `${i + 1}. ${s}\n`; });
      md += `\n`;
    }
    if (f.consoleErrors && f.consoleErrors.length > 0) {
      md += `**Console errors:**\n\`\`\`\n${f.consoleErrors.join('\n')}\n\`\`\`\n\n`;
    }
    if (f.screenshot) {
      md += `**Screenshot:** ![${f.id}](${f.screenshot})\n\n`;
    }
    md += `---\n\n`;
  }
}

writeFileSync(outputPath, md, 'utf8');
console.log(`Report written to ${outputPath}`);
console.log(`${data.summary?.totalFindings ?? '?'} findings across ${data.summary?.totalAreas ?? '?'} areas`);
