# SecWriter — Autonomous UI Audit Procedure

## Overview

This procedure guides Claude through a systematic test of every interactive UI
element in the SecWriter editor. Claude uses Chrome MCP tools to interact
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
