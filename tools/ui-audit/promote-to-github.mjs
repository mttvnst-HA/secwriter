#!/usr/bin/env node
// promote-to-github.mjs — Promote selected UI audit findings to GitHub issues
import { readFileSync, writeFileSync } from 'fs';
import { execSync, spawnSync } from 'child_process';
import { createInterface } from 'readline';

// Check gh CLI is available and authenticated
try {
  execSync('gh auth status', { stdio: 'pipe' });
} catch {
  console.error('Error: gh CLI not found or not authenticated.\nRun: gh auth login');
  process.exit(1);
}

const inputPath = process.argv[2] || 'test-results/findings.json';
const data = JSON.parse(readFileSync(inputPath, 'utf8'));

// Flatten all findings with area context
const allFindings = [];
for (const area of data.areas) {
  for (const f of area.findings) {
    if (!f.promoted) {
      allFindings.push({ ...f, areaName: area.name, areaId: area.id });
    }
  }
}

if (allFindings.length === 0) {
  console.log('No unpromoted findings to create issues for.');
  process.exit(0);
}

// Display findings
console.log(`\n=== Unpromoted findings (${allFindings.length}) ===\n`);
allFindings.forEach((f, i) => {
  const sev = { critical: '!!', high: '! ', medium: '- ', low: '. ', info: '  ' };
  console.log(`  ${String(i + 1).padStart(3)}. ${sev[f.severity] || '  '} [${f.severity.toUpperCase()}] ${f.title}`);
  console.log(`       Area: ${f.areaName} | Component: ${f.component || 'unknown'}`);
});

const rl = createInterface({ input: process.stdin, output: process.stdout });

function ask(q) {
  return new Promise(resolve => rl.question(q, resolve));
}

async function main() {
  console.log('\nEnter finding numbers to promote (comma-separated), "all-high" for critical+high, or "q" to quit:');
  const answer = await ask('> ');

  let indices;
  if (answer.trim() === 'q') { rl.close(); return; }
  if (answer.trim() === 'all-high') {
    indices = allFindings
      .map((f, i) => ['critical', 'high'].includes(f.severity) ? i : -1)
      .filter(i => i >= 0);
  } else {
    indices = answer.split(',').map(s => parseInt(s.trim(), 10) - 1).filter(i => i >= 0 && i < allFindings.length);
  }

  if (indices.length === 0) {
    console.log('No valid selections.');
    rl.close();
    return;
  }

  console.log(`\nWill create ${indices.length} GitHub issue(s). Continue? (y/n)`);
  const confirm = await ask('> ');
  if (confirm.trim().toLowerCase() !== 'y') { rl.close(); return; }

  const severityLabels = { critical: 'priority: critical', high: 'priority: high', medium: 'priority: medium', low: 'priority: low' };

  for (const idx of indices) {
    const f = allFindings[idx];
    const title = `[UI Audit] ${f.title}`;
    const body = [
      `## Description`,
      ``,
      f.description,
      ``,
      `**Severity:** ${f.severity}`,
      `**Area:** ${f.areaName}`,
      `**Component:** \`${f.component || 'unknown'}\``,
      ``,
      f.expected ? `**Expected:** ${f.expected}\n` : '',
      f.actual ? `**Actual:** ${f.actual}\n` : '',
      f.steps && f.steps.length > 0 ? `## Steps to Reproduce\n${f.steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}\n` : '',
      f.consoleErrors && f.consoleErrors.length > 0 ? `## Console Errors\n\`\`\`\n${f.consoleErrors.join('\n')}\n\`\`\`\n` : '',
      `---`,
      `*Found by autonomous UI audit on ${data.timestamp}*`
    ].filter(Boolean).join('\n');

    const labels = ['ui-audit', 'bug'];
    if (severityLabels[f.severity]) labels.push(severityLabels[f.severity]);

    try {
      const res = spawnSync('gh', [
        'issue', 'create',
        '--title', title,
        '--body', body,
        '--label', labels.join(',')
      ], { encoding: 'utf8', timeout: 30000 });
      if (res.status !== 0) throw new Error(res.stderr || 'gh exited with non-zero');
      const result = res.stdout.trim();
      console.log(`  ✓ ${f.id}: ${result}`);
      f.promoted = true;
      f.githubIssue = result;
    } catch (err) {
      console.error(`  ✗ ${f.id}: Failed — ${err.message}`);
    }
  }

  // Write back promoted flags
  writeFileSync(inputPath, JSON.stringify(data, null, 2), 'utf8');
  console.log(`\nUpdated ${inputPath} with promoted flags.`);
  rl.close();
}

main();
