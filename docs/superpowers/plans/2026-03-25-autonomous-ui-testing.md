# Autonomous UI Testing Tool — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an autonomous UI testing tool that uses Claude in Chrome MCP to systematically exercise every interactive element in the SpecsIntact Modern editor, generate a local Markdown report with screenshots, and support selective promotion of findings to GitHub issues.

**Architecture:** A test procedure prompt (`tools/ui-audit/test-procedure.md`) defines ~15 test areas with step-by-step instructions for Claude to follow using Chrome MCP tools. A findings collector (`tools/ui-audit/collect-findings.mjs`) reads the raw findings JSON and generates a timestamped Markdown report. A GitHub promoter (`tools/ui-audit/promote-to-github.mjs`) reads the report and creates issues for user-selected findings. The audit runner (`tools/ui-audit/run-audit.mjs`) orchestrates: launch dev server, open Chrome, execute test areas, collect screenshots, write findings JSON.

**Tech Stack:** Node.js (ESM), Claude in Chrome MCP tools, `gh` CLI for GitHub issue creation, Vite dev server

---

## File Structure

```
tools/ui-audit/
  run-audit.mjs           # Orchestrator: validates env, launches dev server, delegates to test areas
  test-procedure.md        # Master test procedure prompt — Claude follows this autonomously
  test-areas/
    01-app-load.md         # App load, layout, sidebar rendering
    02-toolbar-buttons.md  # Every toolbar button (Import, Save, Export, toggles, zoom)
    03-slash-menu.md       # All 9 slash menu block types
    04-floating-toolbar.md # Bold/Italic/Underline, marks, case change, comments
    05-keyboard-nav.md     # Arrow keys, Enter, Backspace, Tab, Shift+Tab
    06-track-changes.md    # TC toggle, inline revisions, accept/reject, gutter buttons
    07-revision-controls.md# Show/Hide, Notes, Unit Display, Accept All, Reject All
    08-search-replace.md   # Ctrl+F, Ctrl+H, match nav, replace, replace all
    09-compliance.md       # Compliance panel, scope, groups, fix preview
    10-validation.md       # Document validation panel, severity filters
    11-cross-ref.md        # Cross-ref panel, orphaned refs, remove buttons
    12-bracket-replace.md  # Bracket panel, grouped replacement
    13-ref-wizard.md       # Reference wizard search, org filter, insert
    14-tailoring.md        # Tailoring profile toggles, branch/region/delivery
    15-dark-mode-zoom.md   # Dark mode toggle, zoom in/out/reset, tag visibility
  findings-schema.json     # JSON Schema for findings format
  collect-findings.mjs     # Findings JSON → Markdown report generator
  promote-to-github.mjs    # Interactive: select findings → `gh issue create`
test-results/
  (timestamped reports and screenshots land here)
```

---

## Task 1: Create findings schema and report generator

**Files:**
- Create: `tools/ui-audit/findings-schema.json`
- Create: `tools/ui-audit/collect-findings.mjs`

### Step 1: Write the findings JSON schema

- [ ] **Step 1a: Create directory and schema file**

```bash
mkdir -p tools/ui-audit/test-areas
```

- [ ] **Step 1b: Write findings-schema.json**

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object",
  "required": ["timestamp", "appUrl", "areas"],
  "properties": {
    "timestamp": { "type": "string", "format": "date-time" },
    "appUrl": { "type": "string" },
    "areas": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["id", "name", "status", "findings"],
        "properties": {
          "id": { "type": "string", "description": "e.g. 01-app-load" },
          "name": { "type": "string", "description": "Human-readable area name" },
          "status": { "enum": ["pass", "fail", "partial", "skipped"] },
          "findings": {
            "type": "array",
            "items": {
              "type": "object",
              "required": ["id", "severity", "title", "description", "steps"],
              "properties": {
                "id": { "type": "string", "description": "e.g. 01-app-load-F001" },
                "severity": { "enum": ["critical", "high", "medium", "low", "info"] },
                "title": { "type": "string", "maxLength": 120 },
                "description": { "type": "string" },
                "expected": { "type": "string" },
                "actual": { "type": "string" },
                "steps": { "type": "array", "items": { "type": "string" } },
                "screenshot": { "type": "string", "description": "Relative path to screenshot" },
                "consoleErrors": { "type": "array", "items": { "type": "string" } },
                "component": { "type": "string", "description": "Source file, e.g. App.jsx" },
                "promoted": { "type": "boolean", "default": false },
                "githubIssue": { "type": "string", "description": "Issue URL if promoted" }
              }
            }
          }
        }
      }
    },
    "summary": {
      "type": "object",
      "properties": {
        "totalAreas": { "type": "integer" },
        "totalFindings": { "type": "integer" },
        "bySeverity": {
          "type": "object",
          "properties": {
            "critical": { "type": "integer" },
            "high": { "type": "integer" },
            "medium": { "type": "integer" },
            "low": { "type": "integer" },
            "info": { "type": "integer" }
          }
        }
      }
    }
  }
}
```

- [ ] **Step 1c: Write collect-findings.mjs**

This script reads a `findings.json` file and generates a Markdown report.

```javascript
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
```

- [ ] **Step 1d: Verify the script syntax is valid**

Run: `node --check tools/ui-audit/collect-findings.mjs`

Expected: No output (clean parse). Actual data test deferred to Task 10 where `run-audit.mjs` creates the findings JSON first.

- [ ] **Step 1e: Commit**

```bash
git add tools/ui-audit/findings-schema.json tools/ui-audit/collect-findings.mjs
git commit -m "feat(ui-audit): add findings JSON schema and Markdown report generator"
```

---

## Task 2: Create GitHub issue promoter

**Files:**
- Create: `tools/ui-audit/promote-to-github.mjs`

- [ ] **Step 2a: Write promote-to-github.mjs**

This script reads a findings JSON, displays a numbered list, and creates GitHub issues for user-selected findings using `gh`.

```javascript
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
```

- [ ] **Step 2b: Verify syntax**

Run: `node --check tools/ui-audit/promote-to-github.mjs`

- [ ] **Step 2c: Commit**

```bash
git add tools/ui-audit/promote-to-github.mjs
git commit -m "feat(ui-audit): add GitHub issue promoter with interactive selection"
```

---

## Task 3: Write master test procedure

**Files:**
- Create: `tools/ui-audit/test-procedure.md`

This is the master prompt that Claude follows when executing an audit. It defines the overall flow, how to record findings, and references the individual test area files.

- [ ] **Step 3a: Write test-procedure.md**

```markdown
# SpecsIntact Modern — Autonomous UI Audit Procedure

## Overview

This procedure guides Claude through a systematic test of every interactive UI
element in the SpecsIntact Modern editor. Claude uses Chrome MCP tools to interact
with the running app at `http://localhost:5173`.

## Prerequisites

1. Dev server running: `npm run dev` (port 5173)
2. Chrome open with Claude in Chrome MCP active
3. Navigate to `http://localhost:5173`
4. Wait for app to fully load (status bar shows "X blocks")

## Findings Format

Record every issue as a JSON object matching `findings-schema.json`. Use this
severity guide:

| Severity | Definition |
|----------|-----------|
| critical | Feature completely broken, data loss, crash |
| high     | Feature doesn't work as intended, no workaround |
| medium   | Feature works but with visible defect, workaround exists |
| low      | Cosmetic issue, minor UX friction |
| info     | Observation, enhancement suggestion |

## Screenshot Protocol

For each finding:
1. Use `computer` action with `screenshot` + `save_to_disk: true`
2. Save to `test-results/screenshots/<area-id>-<finding-number>.png`
3. Record relative path in finding's `screenshot` field

## Console Error Protocol

After each action:
1. Check `read_console_messages` with `onlyErrors: true`
2. Record any new errors in the finding's `consoleErrors` array

## Test Execution Order

Execute test areas in order. For each area:
1. Read the area's `.md` file for specific steps
2. Execute each step using Chrome MCP tools
3. Record pass/fail and any findings
4. Take screenshots of failures
5. Move to next area

### Test Areas

1. **01-app-load** — App loads, layout renders, sidebar shows tree, blocks render
2. **02-toolbar-buttons** — Click each toolbar button, verify expected behavior
3. **03-slash-menu** — Create blocks via `/` menu for all 9 types
4. **04-floating-toolbar** — Select text, verify B/I/U, marks, case change, comments
5. **05-keyboard-nav** — Arrow keys, Enter, Backspace, Tab/Shift+Tab
6. **06-track-changes** — Toggle TC, edit text, verify inline marks, accept/reject
7. **07-revision-controls** — Show/Hide revisions, Notes toggle, Unit display, Accept/Reject All
8. **08-search-replace** — Ctrl+F, find matches, navigate, replace, replace all
9. **09-compliance** — Open panel, run check, expand groups, preview fixes
10. **10-validation** — Open panel, check severity filters, click-to-navigate
11. **11-cross-ref** — Open panel, verify counts, test remove buttons
12. **12-bracket-replace** — Open panel, verify bracket detection, test replacement
13. **13-ref-wizard** — Open wizard, search org, search RID, insert reference
14. **14-tailoring** — Toggle profile, select branch/region/delivery, verify content changes
15. **15-dark-mode-zoom** — Toggle dark mode, zoom in/out/reset, toggle tag visibility

## After All Areas

1. Compute summary counts (totalAreas, totalFindings, bySeverity)
2. Write `test-results/findings.json`
3. Run `node tools/ui-audit/collect-findings.mjs test-results/findings.json`
4. Report location of Markdown report to user
5. Ask user which findings (if any) to promote to GitHub issues
```

- [ ] **Step 3b: Commit**

```bash
git add tools/ui-audit/test-procedure.md
git commit -m "feat(ui-audit): add master test procedure prompt"
```

---

## Task 4: Write test area 01 — App Load

**Files:**
- Create: `tools/ui-audit/test-areas/01-app-load.md`

- [ ] **Step 4a: Write 01-app-load.md**

```markdown
# 01 — App Load & Layout

## What to test

Verify the app loads, renders the expected layout, and displays sample data.

## Steps

### 1. Navigate to app
- Action: `navigate` to `http://localhost:5173`
- Wait: 3 seconds for Vite HMR + React render
- Verify: Page title contains "SpecsIntact" or renders the editor

### 2. Check layout structure
- Action: `read_page` with `filter: "all"`, `depth: 3`
- Verify:
  - Sidebar exists (left panel with tree navigation)
  - Editor area exists (main content area with blocks)
  - Toolbar exists (top bar with buttons)
  - Status bar exists (bottom, shows "X blocks")

### 3. Check sidebar content
- Action: `read_page` focusing on sidebar area
- Verify:
  - Section number displayed (e.g., "UFGS 31 00 00")
  - Section title displayed (e.g., "EARTHWORK")
  - Tree nodes rendered (PART 1, PART 2, PART 3 headings)
  - Search input present

### 4. Check block rendering
- Action: `read_page` focusing on editor area
- Verify:
  - Multiple blocks visible
  - Title blocks show section numbers (1.1, 1.2, etc.)
  - Text blocks are present
  - Block count in status bar matches rendered blocks

### 5. Check for console errors on load
- Action: `read_console_messages` with `onlyErrors: true`
- Verify: No errors (or document any that appear)

### 6. Take baseline screenshot
- Action: `screenshot` with `save_to_disk: true`
- Save as: `test-results/screenshots/01-app-load-baseline.png`

## Pass criteria
- App renders without blank screen
- All three layout regions visible (sidebar, editor, toolbar)
- At least 10 blocks rendered
- No console errors
```

- [ ] **Step 4b: Commit**

```bash
git add tools/ui-audit/test-areas/01-app-load.md
git commit -m "feat(ui-audit): add test area 01 — app load and layout"
```

---

## Task 5: Write test area 02 — Toolbar Buttons

**Files:**
- Create: `tools/ui-audit/test-areas/02-toolbar-buttons.md`

- [ ] **Step 5a: Write 02-toolbar-buttons.md**

```markdown
# 02 — Toolbar Buttons

## What to test

Click every button in the top toolbar and verify the expected behavior.

## Steps

### 1. Identify all toolbar buttons
- Action: `read_page` with `filter: "interactive"` focused on toolbar area
- Document: List every button with its label/title and ref_id

### 2. Test Import button
- Action: Click "Import .SEC file" button
- Verify: File dialog opens (or at minimum, no crash)
- Note: Cannot complete file selection in automated mode — just verify dialog trigger
- Action: Press Escape to dismiss

### 3. Test Save button (Ctrl+S)
- Action: Click "Save" button
- Verify: Status shows "Saved" or save indicator appears
- Check: Console for errors

### 4. Test Save As button
- Action: Click "Save As" button
- Verify: File dialog opens
- Action: Press Escape to dismiss

### 5. Test Word Export button
- Action: Click "Export as Word" button
- Verify: Download triggers or export dialog appears
- Check: Console for errors

### 6. Test Print button
- Action: Click "Print / Save as PDF" button
- Verify: Print dialog opens
- Action: Press Escape to dismiss

### 7. Test Submittals button
- Action: Click "Generate submittal register" button
- Verify: New tab/window opens with HTML report, or report panel appears
- Check: Report contains submittal data

### 8. Test Reference Wizard button (+ Ref)
- Action: Click "Add a reference" button
- Verify: RefWizard modal/panel opens with search inputs
- Action: Close/dismiss the wizard

### 9. Test Brackets button ([ ])
- Action: Click "Find and replace [bracketed]" button
- Verify: BracketReplace panel opens
- Verify: Bracketed placeholders are detected and listed
- Action: Click again to toggle off

### 10. Test Validate button
- Action: Click "Run document validation" button
- Verify: ValidationPanel opens with findings list
- Verify: Severity filter buttons visible
- Action: Click again to toggle off

### 11. Test Compliance button
- Action: Click "Check UFS 1-300-02 compliance" button
- Verify: CompliancePanel opens on right side
- Verify: Scope selector visible (Entire doc / Focused block)
- Action: Click again to toggle off

### 12. Test Lint toggle
- Action: Click "Enable/Disable inline linting" button
- Verify: Button text/icon changes (● ↔ ○)
- Action: Click again to toggle back
- Check: localStorage `sim-inline-linting` value changes

### 13. Test Tag Visibility toggle (</>)
- Action: Click "Show/Hide inline tags" button
- Verify: Tag indicators appear on blocks (cyan monospace text like `<TXT>`)
- Action: Take screenshot
- Action: Click again to hide tags
- Verify: Tags disappear

### 14. Test Dark Mode toggle
- Action: Click dark mode button (☀/☽)
- Verify: Background changes to dark, text to light
- Action: Take screenshot
- Action: Click again to restore light mode

### 15. Test Zoom buttons
- Action: Click zoom out (−)
- Verify: Editor content shrinks, zoom % decreases
- Action: Click zoom reset (100%)
- Verify: Zoom returns to 100%
- Action: Click zoom in (+)
- Verify: Editor content enlarges, zoom % increases
- Action: Click zoom reset again

### 16. Check Comments button visibility
- Verify: Comments button (💬) is hidden when no comments exist
- Note: Will test comment creation in area 04

### 17. Take final screenshot
- Action: `screenshot` with `save_to_disk: true`

## Pass criteria
- All buttons are clickable without crashes
- Toggles visibly change state
- Panels open/close correctly
- No console errors from button clicks
```

- [ ] **Step 5b: Commit**

```bash
git add tools/ui-audit/test-areas/02-toolbar-buttons.md
git commit -m "feat(ui-audit): add test area 02 — toolbar buttons"
```

---

## Task 6: Write test area 03 — Slash Menu

**Files:**
- Create: `tools/ui-audit/test-areas/03-slash-menu.md`

- [ ] **Step 6a: Write 03-slash-menu.md**

```markdown
# 03 — Slash Menu (Block Type Creation)

## What to test

Type `/` in a block to open the slash menu, then create one block of each type.

## Steps

### 1. Focus an existing text block
- Action: Click on any text block in the editor
- Verify: Block receives focus ring

### 2. Create a new empty block
- Action: Press Enter to create a new block
- Verify: New empty block appears below, cursor is in it

### 3. Open slash menu
- Action: Type `/`
- Verify: Dropdown menu appears with 9 options
- Action: Take screenshot of slash menu

### 4. Test each block type creation

For each type, starting from a fresh empty block (Enter to create):

#### 4a. Heading (`title`)
- Type `/`, then click "Heading" or type `h` + Enter
- Verify: Block converts to a title block with section numbering
- Type: "Test Heading"
- Verify: Text appears, section number prefix visible

#### 4b. Paragraph (`txt`)
- Create new block, type `/`, select "Paragraph"
- Verify: Block is a plain text paragraph
- Type: "Test paragraph text"

#### 4c. Designer Note (`note`)
- Create new block, type `/`, select "Designer Note"
- Verify: Block has amber/yellow left border styling
- Type: "Test designer note"

#### 4d. Ordered List (`oli`)
- Create new block, type `/`, select "Ordered List"
- Verify: Block shows letter label (a.)
- Type: "First list item"
- Press Enter — verify next item gets label (b.)

#### 4e. List Item (`item`)
- Create new block, type `/`, select "List Item"
- Verify: Block shows bullet marker
- Type: "Bulleted item"

#### 4f. List Header (`lst`)
- Create new block, type `/`, select "List Header"
- Verify: Block renders as list header style
- Type: "SD-01 Materials"

#### 4g. Reference (`ref`)
- Create new block, type `/`, select "Reference"
- Verify: Structured reference block appears with ORG field
- Verify: Edit controls visible

#### 4h. Table (`table`)
- Create new block, type `/`, select "Table"
- Verify: Table block appears with at least 2x2 grid
- Verify: Cell editing works (double-click a cell)

#### 4i. Page Break (`pagebreak`)
- Create new block, type `/`, select "Page Break"
- Verify: Horizontal line/separator appears
- Verify: Block is not editable (read-only divider)

### 5. Verify slash menu keyboard navigation
- Create new block, type `/`
- Press ArrowDown 3 times
- Press Enter
- Verify: The 4th item in the menu was selected and applied

### 6. Verify slash menu filtering
- Create new block, type `/tab`
- Verify: Menu filters to show "Table" option
- Press Escape to dismiss

### 7. Check console for errors
- Action: `read_console_messages` with `onlyErrors: true`

## Pass criteria
- All 9 block types can be created via slash menu
- Each type renders with correct visual style
- Keyboard navigation works in the menu
- Type filtering narrows results
- No console errors during creation
```

- [ ] **Step 6b: Commit**

```bash
git add tools/ui-audit/test-areas/03-slash-menu.md
git commit -m "feat(ui-audit): add test area 03 — slash menu"
```

---

## Task 7: Write test areas 04-08

**Files:**
- Create: `tools/ui-audit/test-areas/04-floating-toolbar.md`
- Create: `tools/ui-audit/test-areas/05-keyboard-nav.md`
- Create: `tools/ui-audit/test-areas/06-track-changes.md`
- Create: `tools/ui-audit/test-areas/07-revision-controls.md`
- Create: `tools/ui-audit/test-areas/08-search-replace.md`

- [ ] **Step 7a: Write 04-floating-toolbar.md**

```markdown
# 04 — Floating Toolbar

## What to test

Select text in a block, verify the floating toolbar appears with all expected
buttons, and test each button's behavior.

## Steps

### 1. Select text in a text block
- Action: Click on a text block with content
- Action: Triple-click to select all text in the block (or Shift+click to select a range)
- Verify: Floating toolbar appears above/below the selection

### 2. Document toolbar buttons
- Action: `read_page` focused on the floating toolbar area
- Verify these buttons exist: B, I, U, Aa, RID, SRF, SUB, 💬

### 3. Test Bold (B)
- Select text, click B button
- Verify: Selected text becomes bold (`<b>` or `font-weight`)
- Select bold text, click B again
- Verify: Bold is removed (toggle behavior)

### 4. Test Italic (I)
- Select text, click I button
- Verify: Selected text becomes italic
- Toggle off, verify removal

### 5. Test Underline (U)
- Select text, click U button
- Verify: Selected text becomes underlined
- Toggle off, verify removal

### 6. Test Change Case (Aa)
- Select text "test text"
- Click Aa once — verify: "TEST TEXT" (uppercase)
- Click Aa again — verify: "test text" (lowercase)
- Click Aa again — verify: "Test Text" (title case)

### 7. Test RID mark
- Select a reference-like text (e.g., "ASTM C150")
- Click RID button
- Verify: Text gets magenta highlight (`mark-rid` class)
- Verify: Tag visibility shows `<RID>` wrappers when toggled

### 8. Test SRF mark
- Select section reference text
- Click SRF button
- Verify: Text gets purple highlight (`mark-srf` class)

### 9. Test SUB mark
- Select submittal text
- Click SUB button
- Verify: Text gets blue highlight (`mark-sub` class)

### 10. Test Comment (💬)
- Select text, click 💬 button
- Verify: Comment popup/dialog appears
- Type a comment: "Test comment from UI audit"
- Submit the comment
- Verify: Yellow highlight appears on selected text
- Verify: Comment thread shows in popup
- Verify: Toolbar Comments button (💬) now appears in main toolbar

### 11. Test floating toolbar on ref blocks
- Click on a reference block
- Select text within it
- Verify: Only the 💬 (comment) button appears (not B/I/U/marks)

### 12. Test floating toolbar dismissal
- Select text (toolbar appears)
- Click elsewhere in editor
- Verify: Toolbar disappears
- Select text again
- Press Escape
- Verify: Toolbar disappears

### 13. Check console for errors

## Pass criteria
- Toolbar appears on text selection
- All format buttons toggle correctly
- All mark buttons apply correct CSS classes
- Comment creation works end-to-end
- Toolbar respects block type (ref blocks get comment-only)
- Clean dismissal on blur/escape
```

- [ ] **Step 7b: Write 05-keyboard-nav.md**

```markdown
# 05 — Keyboard Navigation

## What to test

Test all keyboard shortcuts and navigation patterns.

## Steps

### 1. Arrow key navigation between blocks
- Focus a block in the middle of the document
- Press ArrowUp at the start of the block
- Verify: Focus moves to the previous block
- Press ArrowDown at the end of the block
- Verify: Focus moves to the next block

### 2. Enter key — new block creation
- Focus a text block
- Place cursor at end of text
- Press Enter
- Verify: New block of same type created below
- Verify: Cursor is in the new block

### 3. Enter in middle of text — block splitting
- Focus a text block with content "Hello World"
- Place cursor between "Hello" and "World"
- Press Enter
- Verify: Block splits into two blocks: "Hello" and "World"

### 4. Backspace on empty block — deletion
- Create a new empty block (Enter)
- Press Backspace
- Verify: Empty block is deleted
- Verify: Focus moves to the previous block

### 5. Tab on title block — demote
- Click on a title block (e.g., "1.1 REFERENCES")
- Press Tab
- Verify: Title depth increases (e.g., 1.1 → 1.1.1)
- Verify: Section number updates

### 6. Shift+Tab on title block — promote
- With the same title focused
- Press Shift+Tab
- Verify: Title depth decreases back

### 7. Ctrl+Z — Undo
- Type "test undo" in a block
- Press Ctrl+Z
- Verify: Text reverts to previous state

### 8. Ctrl+Y — Redo
- After undo, press Ctrl+Y
- Verify: Text comes back

### 9. Ctrl+S — Save
- Press Ctrl+S
- Verify: Save indicator appears in toolbar

### 10. Ctrl+F — Find
- Press Ctrl+F
- Verify: Search bar appears at top of editor
- Press Escape
- Verify: Search bar closes

### 11. Ctrl+H — Find and Replace
- Press Ctrl+H
- Verify: Search bar appears WITH replace input visible
- Press Escape

## Pass criteria
- Arrow navigation moves between blocks smoothly
- Enter creates/splits blocks correctly
- Backspace deletes empty blocks
- Tab/Shift+Tab adjusts title depth
- Undo/Redo works
- Ctrl shortcuts all trigger correct actions
```

- [ ] **Step 7c: Write 06-track-changes.md**

```markdown
# 06 — Track Changes

## What to test

Enable Track Changes, make edits, verify revision marks appear, test
accept/reject for both inline and block-level changes.

## Steps

### 1. Enable Track Changes
- Action: Find and click the "Track Changes" toggle button
- Verify: Button shows ON/active state
- Verify: Status or visual indicator shows TC is active

### 2. Type new text (addition)
- Focus a text block
- Type " additional text" at end of existing content
- Click away (blur the block to trigger diff)
- Verify: New text appears with green `<ins>` styling (mark-add)

### 3. Delete existing text (deletion)
- Focus a text block with content
- Select a word
- Press Delete or Backspace
- Click away
- Verify: Deleted text appears with red strikethrough `<del>` styling (mark-del)

### 4. Verify gutter buttons appear
- Look at the left edge of the edited blocks
- Verify: Accept (✓) and Reject (✗) gutter buttons visible

### 5. Test gutter Accept
- Click the ✓ gutter button on a block with additions
- Verify: Addition marks are removed, text becomes permanent
- Verify: Gutter buttons disappear from that block

### 6. Test gutter Reject
- Make another edit (type new text, blur)
- Click the ✗ gutter button
- Verify: Edit is reverted, text returns to original state

### 7. Test inline accept via floating toolbar
- Make an edit (type text, blur)
- Click on the green `<ins>` text
- Verify: Floating toolbar shows Accept (✓) and Reject (✗) buttons
- Click Accept
- Verify: Just that inline change is accepted

### 8. Test inline reject via floating toolbar
- Make another edit, blur
- Click on the revision mark
- Click Reject in floating toolbar
- Verify: That inline change is reverted

### 9. Test del element click popup
- Make an edit that creates a `<del>` element
- Click on the red strikethrough text
- Verify: Popup appears with Accept/Reject options
- Test Accept, verify deletion is finalized

### 10. Create a new block while TC is on
- Press Enter to create a new block
- Verify: New block has block-level revision mark (green left border or "add" indicator)

### 11. Delete a block while TC is on
- Focus an existing block, select all, delete
- Verify: Block is marked as deleted (red styling, not actually removed)

### 12. Disable Track Changes
- Click the TC toggle button
- Verify: Button shows OFF state
- Verify: Existing marks remain visible but no new tracking occurs

## Pass criteria
- TC toggle enables/disables correctly
- Additions get green `<ins>` marks
- Deletions get red `<del>` marks
- Gutter accept/reject works
- Inline accept/reject via floating toolbar works
- Del popup works
- Block-level revisions tracked
- No console errors throughout
```

- [ ] **Step 7d: Write 07-revision-controls.md**

```markdown
# 07 — Revision Controls

## What to test

Test the revision control panel below the toolbar: Show/Hide revisions,
Notes toggle, Unit Display dropdown, Accept All, Reject All.

## Steps

### 1. Setup: Enable TC and create some revisions
- Enable Track Changes
- Edit 3 different blocks (add text, delete text, modify text)
- Blur each block to generate revision marks

### 2. Test Hide Revisions
- Click "Revisions: Show" toggle → should change to "Hide"
- Verify: Revision marks (green/red) become invisible
- Verify: Text still shows current state (additions visible, deletions hidden)

### 3. Test Show Revisions
- Click "Revisions: Hide" toggle → should change to "Show"
- Verify: Revision marks reappear

### 4. Test Notes toggle
- Click "Notes: Show" toggle
- Verify: Designer note blocks become hidden
- Click again to show
- Verify: Notes reappear with amber border

### 5. Test Unit Display dropdown
- Find the unit display dropdown (Both/ENG only/MET only)
- Select "ENG only"
- Verify: MET content is hidden (if dual-unit marks exist in the document)
- Select "MET only"
- Verify: ENG content is hidden
- Select "Both"
- Verify: Both units visible again

### 6. Test Accept All
- Ensure there are pending revisions
- Click "Accept All" button
- Verify: Confirmation dialog or immediate acceptance
- Verify: All revision marks cleared, changes made permanent

### 7. Test Reject All
- Enable TC, create new revisions
- Click "Reject All" button
- Verify: All revisions reverted to original state

### 8. Disable Track Changes

## Pass criteria
- Show/Hide revisions toggles visibility correctly
- Notes toggle hides/shows note blocks
- Unit display filters ENG/MET content
- Accept All finalizes all pending changes
- Reject All reverts all pending changes
```

- [ ] **Step 7e: Write 08-search-replace.md**

```markdown
# 08 — Search & Replace

## What to test

Test the Ctrl+F find bar and Ctrl+H find-and-replace functionality.

## Steps

### 1. Open Find bar
- Press Ctrl+F
- Verify: Search bar appears at top of editor
- Verify: Input field is focused

### 2. Search for a common word
- Type "the" in search input
- Verify: Match count appears (e.g., "1 of 12")
- Verify: First match is highlighted/scrolled to in editor

### 3. Navigate matches
- Click Next (→) button
- Verify: Highlight moves to next match, counter updates (e.g., "2 of 12")
- Click Previous (←) button
- Verify: Returns to previous match

### 4. Close find bar
- Press Escape
- Verify: Search bar closes, highlights removed

### 5. Open Find & Replace
- Press Ctrl+H
- Verify: Search bar appears with BOTH find and replace inputs

### 6. Test Replace
- Type "the" in find input
- Type "THE" in replace input
- Click Replace button
- Verify: Current match is replaced
- Verify: Match counter updates

### 7. Test Replace All
- Type a unique-ish word in find input
- Type replacement in replace input
- Click Replace All
- Verify: All matches replaced at once
- Verify: Counter shows "0 of 0" or equivalent

### 8. Test empty search
- Clear the search input
- Verify: No matches shown, no errors

### 9. Close and verify
- Press Escape
- Verify: Bar closes cleanly

## Pass criteria
- Find bar opens/closes with keyboard shortcuts
- Search finds and highlights matches
- Match navigation works
- Replace and Replace All work correctly
- No console errors
```

- [ ] **Step 7f: Commit all 5 area files**

```bash
git add tools/ui-audit/test-areas/04-floating-toolbar.md tools/ui-audit/test-areas/05-keyboard-nav.md tools/ui-audit/test-areas/06-track-changes.md tools/ui-audit/test-areas/07-revision-controls.md tools/ui-audit/test-areas/08-search-replace.md
git commit -m "feat(ui-audit): add test areas 04-08 (toolbar, keyboard, TC, revisions, search)"
```

---

## Task 8: Write test areas 09-15

**Files:**
- Create: `tools/ui-audit/test-areas/09-compliance.md`
- Create: `tools/ui-audit/test-areas/10-validation.md`
- Create: `tools/ui-audit/test-areas/11-cross-ref.md`
- Create: `tools/ui-audit/test-areas/12-bracket-replace.md`
- Create: `tools/ui-audit/test-areas/13-ref-wizard.md`
- Create: `tools/ui-audit/test-areas/14-tailoring.md`
- Create: `tools/ui-audit/test-areas/15-dark-mode-zoom.md`

- [ ] **Step 8a: Write 09-compliance.md**

```markdown
# 09 — Compliance Checker Panel

## What to test

Open the compliance panel, run a check, verify grouped findings render,
test fix preview and batch actions.

## Steps

### 1. Open Compliance Panel
- Click "Compliance" toolbar button
- Verify: Panel opens on right side of editor
- Verify: Scope selector visible ("Entire Document" / "Focused Block")

### 2. Run compliance check (entire document)
- Click "Entire Document" or equivalent scan button
- Verify: Progress indicator shows while scanning
- Verify: Results appear grouped by rule category
- Verify: Summary bar shows counts by severity

### 3. Expand a violation group
- Click on a violation group header
- Verify: Individual violations listed with context text
- Verify: Each violation shows the matching text highlighted

### 4. Click a violation to highlight in editor
- Click on a specific violation entry
- Verify: Editor scrolls to the block containing the violation
- Verify: Matching text gets yellow `.compliance-highlight` styling

### 5. Test fix preview
- Find a violation that has a fix available
- Verify: Before/after text shown in the finding
- Click Accept/Apply fix
- Verify: Text in editor updates to the fixed version

### 6. Test batch reject
- Expand a group with multiple findings
- Click "Dismiss" or batch reject
- Verify: Group is removed from results

### 7. Run focused-block check
- Click on a specific block in the editor
- Switch scope to "Focused Block"
- Run check
- Verify: Only violations from that block appear

### 8. Close panel
- Click Compliance button again (or close button)
- Verify: Panel closes, highlights removed from editor

## Pass criteria
- Panel opens/closes correctly
- Scan completes without errors
- Violations are grouped and expandable
- Click-to-navigate works
- Fix preview and apply work
- Scope selection (entire vs focused) works
```

- [ ] **Step 8b: Write 10-validation.md**

```markdown
# 10 — Document Validation Panel

## What to test

Open the validation panel and verify structural checks.

## Steps

### 1. Open Validation Panel
- Click "Validate" toolbar button
- Verify: Panel opens with list of validation findings

### 2. Check severity filters
- Verify: Filter buttons visible (Error, Warning, Info, or All)
- Click each filter
- Verify: Findings list filters correctly

### 3. Test click-to-navigate
- Click on a finding/issue in the list
- Verify: Editor scrolls to the referenced block
- Verify: Block gets visual focus indicator

### 4. Close panel
- Click Validate button again
- Verify: Panel closes

## Pass criteria
- Panel opens with validation results
- Severity filters work
- Click-to-navigate scrolls to correct block
```

- [ ] **Step 8c: Write 11-cross-ref.md**

```markdown
# 11 — Cross-Reference Validation Panel

## What to test

Open the cross-reference panel, verify RID/SRF validation, test orphan removal.

## Steps

### 1. Open Cross-Ref Panel
- Find and click cross-reference validation button (may be in toolbar or submenu)
- Verify: Panel opens showing unlinked citations, self-references, orphaned references

### 2. Check unlinked citations
- Verify: Any RID marks in body without matching REF entries are listed
- Verify: Count is shown

### 3. Check orphaned references
- Verify: Any REF entries not cited in the body are listed
- If orphaned refs exist:
  - Click "Remove" on one entry
  - Verify: Entry is removed from the REF block
  - Verify: Orphan count decreases

### 4. Test Remove All Orphaned
- If multiple orphaned refs exist:
  - Click "Remove All Orphaned"
  - Verify: All orphaned entries removed

### 5. Close panel

## Pass criteria
- Panel shows correct categorization of reference issues
- Remove individual orphan works
- Remove All works
- Counts update after removal
```

- [ ] **Step 8d: Write 12-bracket-replace.md**

```markdown
# 12 — Bracket Replacement Panel

## What to test

Open bracket replacement, verify detection, test replacement.

## Steps

### 1. Open Bracket Panel
- Click "[ ] Brackets" toolbar button
- Verify: Panel opens showing grouped bracketed placeholders

### 2. Check bracket detection
- Verify: All `[bracketed text]` patterns found in the document are listed
- Verify: Grouped by unique bracket text

### 3. Test replacement
- Enter replacement text for one group
- Click Replace or Apply
- Verify: All instances of that bracket text are replaced in the editor

### 4. Close panel

## Pass criteria
- Brackets are correctly detected and grouped
- Replacement applies to all instances
- Editor text updates in real time
```

- [ ] **Step 8e: Write 13-ref-wizard.md**

```markdown
# 13 — Reference Wizard

## What to test

Open the reference wizard, search for organizations and references, insert a reference.

## Steps

### 1. Open Reference Wizard
- Click "+ Ref" toolbar button
- Verify: Wizard modal/panel opens with search interface

### 2. Search for an organization
- Type "ASTM" in the organization search field
- Verify: Autocomplete shows matching orgs
- Select "ASTM" from results

### 3. Search for a reference ID
- Type "C150" in the RID search field
- Verify: Matching references shown
- Verify: Full title (RTL) visible in results

### 4. Insert a reference
- Select a reference from results
- Click Insert button
- Verify: Reference is added to the nearest REF block (or creates one)
- Verify: RID and RTL appear correctly formatted

### 5. Search for a different org
- Clear and search for "AASHTO"
- Verify: Results update to AASHTO references

### 6. Close wizard
- Click close/cancel
- Verify: Wizard dismisses cleanly

## Pass criteria
- Wizard opens with functional search
- Organization search filters correctly
- RID search shows matching references
- Insert adds the reference to the document
- No console errors
```

- [ ] **Step 8f: Write 14-tailoring.md**

```markdown
# 14 — Tailoring Profile

## What to test

Toggle the tailoring profile, select branch/region/delivery, verify content changes.

## Steps

### 1. Find tailoring controls
- Locate the TailoringProfile section (below revision controls)
- Verify: Active toggle, Branch/Region/Delivery dropdowns visible

### 2. Enable tailoring
- Click Active toggle to ON
- Verify: Dropdowns become interactive

### 3. Select a branch
- Select "Navy" from Branch dropdown
- Verify: Selection registers, Region dropdown updates with Navy-specific options

### 4. Select a region
- Select a region from the dropdown
- Verify: Selection registers

### 5. Select delivery method
- Select a delivery method
- Verify: Content in editor may change (TAI-marked blocks show/hide based on OPT matching)

### 6. Toggle Show All
- Click "Show All" toggle
- Verify: All TAI content visible regardless of profile match

### 7. Disable tailoring
- Click Active toggle to OFF
- Verify: All TAI content returns to default visibility

## Pass criteria
- Toggle enables/disables correctly
- Dropdowns populate with correct options
- Content visibility changes based on selections
- Show All overrides filtering
```

- [ ] **Step 8g: Write 15-dark-mode-zoom.md**

```markdown
# 15 — Dark Mode, Zoom & Tag Visibility

## What to test

Test visual toggles that affect the entire editor appearance.

## Steps

### 1. Test Dark Mode
- Click dark mode toggle (☀ → ☽)
- Verify: Background changes to dark color scheme
- Verify: Text is light-colored and readable
- Verify: Sidebar, toolbar, and editor all switch
- Take screenshot
- Click again to restore light mode
- Verify: Returns to light theme

### 2. Test Zoom In
- Note current zoom level (should be 100%)
- Click zoom in (+) button 3 times
- Verify: Content visibly larger
- Verify: Zoom percentage shows ~130%

### 3. Test Zoom Out
- Click zoom out (−) button 6 times
- Verify: Content visibly smaller
- Verify: Zoom percentage shows ~70%

### 4. Test Zoom Reset
- Click zoom reset (100%) button
- Verify: Returns to 100%

### 5. Test Keyboard Zoom
- Press Ctrl++ (zoom in)
- Verify: Zoom increases
- Press Ctrl+0 (reset)
- Verify: Returns to 100%
- Press Ctrl+- (zoom out)
- Verify: Zoom decreases
- Press Ctrl+0 again

### 6. Test Tag Visibility
- Click </> button
- Verify: Tags become visible on blocks (e.g., `<TXT>...</TXT>`, `<NTE>...`)
- Verify: Tags shown in cyan monospace (font-family: Consolas/SF Mono)
- Verify: Inline marks show their tags (e.g., `<RID>ASTM C150</RID>`)
- Take screenshot
- Click </> again
- Verify: Tags hidden

### 7. Test Dark Mode + Tags combination
- Enable dark mode
- Enable tag visibility
- Verify: Tags readable against dark background
- Take screenshot
- Disable both

## Pass criteria
- Dark mode fully themes all components
- Zoom scales content, displays correct percentage
- Keyboard zoom shortcuts work
- Tag visibility toggles cleanly
- Combinations work without visual glitches
```

- [ ] **Step 8h: Commit all 7 area files**

```bash
git add tools/ui-audit/test-areas/09-compliance.md tools/ui-audit/test-areas/10-validation.md tools/ui-audit/test-areas/11-cross-ref.md tools/ui-audit/test-areas/12-bracket-replace.md tools/ui-audit/test-areas/13-ref-wizard.md tools/ui-audit/test-areas/14-tailoring.md tools/ui-audit/test-areas/15-dark-mode-zoom.md
git commit -m "feat(ui-audit): add test areas 09-15 (compliance, validation, cross-ref, brackets, ref wizard, tailoring, dark mode)"
```

---

## Task 9: Write the audit runner orchestrator

**Files:**
- Create: `tools/ui-audit/run-audit.mjs`

- [ ] **Step 9a: Write run-audit.mjs**

This is a lightweight orchestrator that validates prerequisites and provides instructions.

```javascript
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
```

- [ ] **Step 9b: Verify script runs**

Run: `node tools/ui-audit/run-audit.mjs --list`

Expected: List of 15 test areas printed.

- [ ] **Step 9c: Add npm scripts to package.json**

Add to `package.json` scripts:

```json
"audit:init": "node tools/ui-audit/run-audit.mjs",
"audit:list": "node tools/ui-audit/run-audit.mjs --list",
"audit:report": "node tools/ui-audit/collect-findings.mjs test-results/findings.json",
"audit:promote": "node tools/ui-audit/promote-to-github.mjs test-results/findings.json"
```

- [ ] **Step 9d: Run the init script to verify end-to-end**

Run: `node tools/ui-audit/run-audit.mjs`

Expected: Banner prints, `test-results/findings.json` created with 15 empty areas.

- [ ] **Step 9e: Run the report generator on the empty findings**

Run: `node tools/ui-audit/collect-findings.mjs test-results/findings.json`

Expected: Markdown report generated (all areas show "No issues found").

- [ ] **Step 9f: Commit**

```bash
git add tools/ui-audit/run-audit.mjs package.json
git commit -m "feat(ui-audit): add audit runner orchestrator and npm scripts"
```

---

## Task 10: Verify everything works end-to-end

- [ ] **Step 10a: Run full init + report pipeline**

```bash
node tools/ui-audit/run-audit.mjs
node tools/ui-audit/collect-findings.mjs test-results/findings.json
```

Verify: Both scripts complete without errors, Markdown report exists.

- [ ] **Step 10b: Verify syntax of all test area files**

```bash
ls tools/ui-audit/test-areas/*.md | wc -l
```

Expected: 15 files.

- [ ] **Step 10c: Run existing tests to ensure no regressions**

```bash
npm test
```

Expected: All 466 Vitest tests pass.

- [ ] **Step 10d: Final commit with any fixes**

```bash
git add tools/ui-audit/ package.json
git commit -m "feat(ui-audit): complete autonomous UI testing tool (15 test areas, report generator, GitHub promoter)"
```

---

## Execution Notes

**How Claude runs an audit:**

1. Human runs `npm run audit:init` to create the empty findings JSON
2. Human starts `npm run dev` if not already running
3. Human tells Claude: "Run the UI audit following `tools/ui-audit/test-procedure.md`"
4. Claude reads `test-procedure.md`, then each test area file in order
5. For each area, Claude uses Chrome MCP tools (`navigate`, `read_page`, `computer`, `read_console_messages`, etc.) to execute steps
6. Claude records findings directly into `test-results/findings.json` using the Write tool
7. After all areas, Claude runs `node tools/ui-audit/collect-findings.mjs` to generate the Markdown report
8. Claude presents a summary and asks which findings to promote to GitHub
9. Human selects findings, Claude runs `promote-to-github.mjs` or creates issues directly

**Incremental runs:** Use `--area 03` to re-test just area 03 (slash menu). The findings JSON is overwritten each run per area.

**Adding new test areas:** Create a new `XX-name.md` file in `test-areas/`, following the existing format. The runner auto-discovers new files.
