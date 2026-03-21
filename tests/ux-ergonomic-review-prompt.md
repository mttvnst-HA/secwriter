# .SEC File Editor — Ergonomic & Usability Review (Claude Code Agent)

## Role

You are a senior UX consultant and accessibility specialist performing an ergonomic review of a web-based WYSIWYG editor for `.sec` files — the native format of SpecsIntact, used to author UFGS (Unified Facilities Guide Specifications).

## Goal

Audit the front-end UX of this application for visual comfort, readability, and accessibility, then deliver a prioritized findings report. Optionally, implement fixes directly in the codebase upon approval.

## Context

- **What this app replaces:** The 1990s-era SpecsIntact desktop application — cramped, low-contrast, difficult to use.
- **Users:** Civil engineers, ages 35–65, many wearing corrective lenses. They edit dense technical specification text for 6–10+ hours daily. They must never need to squint, lean in, or strain.
- **App stage:** Early/prototype ("vibe-coded"). Focus on high-impact improvements, not cosmetic nitpicks.

### Scope

- **Modify:** `src/styles/*`, `src/components/*.jsx` (JSX/className/style props only), `index.html` (font links)
- **Do not modify:** `src/lib/*.js`, `src/App.jsx` state/logic, data model, parsers, serializers
- **OK with care:** Component structure changes (e.g., wrapping elements for layout) are OK if they don't alter behavior or break existing tests

---

## Phase 1: Reconnaissance (run steps in parallel)

You have access to the project source code, a bash shell, Windows MCP, and the Chrome browser extension. Before writing any findings, launch these reconnaissance tasks as **parallel agents** to save time:

### Agent 1 — Project structure (Explore agent, quick)

- List the top-level directory tree
- Identify the framework (React, Vue, Svelte, etc.) and CSS approach (Tailwind, CSS modules, styled-components, plain CSS, etc.)
- Locate the main editor component(s), toolbar, sidebar/navigation, and global stylesheet(s)
- Read `CLAUDE.md` for project conventions, architecture notes, and any mandated formatting constraints

### Agent 2 — Style audit (Explore agent, medium)

- Read the global CSS / theme file(s)
- Read the editor view component(s) and any toolbar/sidebar components
- Extract and tabulate: current font sizes, line-heights, letter-spacing, color values, button dimensions, padding, and contrast-relevant pairings
- Read `reference/section.ini` for mandated UFGS formatting constraints (colors, fonts) that must not be overridden for screen display or must be separated via `@media print`

### Agent 3 — Live app screenshots (general-purpose agent)

- Check if the dev server is already running (check `preview_list` or `lsof -i :5173`). If not running, start it. **Do not start a second instance if one is already running.**
- Open the app in the browser
- Take screenshots of:
  - The main editor view (with sample data loaded)
  - The toolbar / formatting controls
  - The sidebar / navigation / outline panel
  - At least one hover or focus state (if triggerable)
  - The Track Changes UI (enable TC, create a revision, screenshot)
  - The comment thread UI (if comments exist or can be created)
- Save all screenshots to disk for reference

### Agent 4 — Computed style extraction (general-purpose agent)

After the dev server is confirmed running, use `preview_inspect` to extract **actual computed values** from the live DOM (more accurate than reading CSS source):

```
Inspect these selectors with these CSS properties:

Body text block:        '[data-block-id] div[contenteditable]' → fontSize, lineHeight, letterSpacing, color, backgroundColor, fontFamily
Toolbar buttons:        '.toolbar button' or similar → width, height, minWidth, minHeight, padding, fontSize
Sidebar text:           sidebar navigation text → fontSize, color, backgroundColor
Section titles:         title blocks → fontSize, fontWeight, color
Inline marks (RID):     '.mark-rid' → color, backgroundColor, fontSize
Inline marks (ADD):     'ins.mark-add' → color, backgroundColor, textDecorationLine
Inline marks (DEL):     'del.mark-del' → color, backgroundColor, textDecorationLine
Editor background:      editor pane container → backgroundColor
Comment highlight:      '.mark-comment' → backgroundColor
Gutter buttons:         revision gutter ✓/✗ → width, height, fontSize
Search bar:             search input → fontSize, height, padding
```

Calculate WCAG contrast ratios programmatically for each text/background pairing:
```js
// Use preview_eval to compute relative luminance and contrast ratio
function luminance(r, g, b) {
  const [rs, gs, bs] = [r, g, b].map(c => {
    c = c / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs;
}
function contrastRatio(l1, l2) {
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}
```

Report **measured** ratios, not estimates.

---

### After all agents complete: Synthesize

Before writing findings, reason through these questions internally (do not print answers):

- What in this interface causes eye strain, reading fatigue, or unnecessary effort?
- Where are text, spacing, contrast, or controls too small or too subtle?
- Does the editor feel stable and trustworthy for long-form technical editing?
- What makes the app feel cluttered, fragile, or unfinished?
- What single change would most improve daily comfort?
- What's actually working well that should be preserved?

---

## Phase 2: Report

### Accessibility & Ergonomic Standards (non-negotiable baselines)

- Body text: >= 16px (target 17–18px), line-height >= 1.5
- Contrast: WCAG AAA (7:1 body text, 4.5:1 large text) targeted; AA (4.5:1 / 3:1) is the floor
- Click/touch targets: >= 44x44px (WCAG 2.5.8)
- No pure white (#FFFFFF) editor backgrounds — use soft off-white to reduce glare
- Fonts: clean, high-x-height, professional (e.g., Inter, Source Sans 3, Atkinson Hyperlegible)
- All hover, focus, and active states must be visually obvious and high-contrast

### Output Structure

#### 1. Executive Summary

3–5 sentences: current UX quality, detected tech stack, and overall ergonomic posture. Note any areas you could not assess and why.

#### 2. Strengths to Preserve

1–3 bullets identifying things the current design does well. If nothing stands out, say so honestly.

#### 3. Findings Table

Up to **15 findings**, sorted by severity (all Critical first, then Moderate, then Minor).

| # | Area | Problem | Severity | Measured Value | Fix (file path + specific values) |
|---|------|---------|----------|----------------|-----------------------------------|
| 1 | Text Readability | [User-perspective description] | Critical | `font-size: 14px`, contrast 3.2:1 | In `src/styles/editor.css:42`, change `font-size` from `14px` to `17px`; in `:root`, set `--color-text` to `#1a1a1a` for 12.6:1 contrast |

**Severity definitions:**
- **Critical** — Causes eye strain, reading errors, or accessibility failures (WCAG AA violations)
- **Moderate** — Causes friction, slows workflows, or feels unprofessional
- **Minor** — Polish items that improve perceived quality

**Review priority areas (assess in this order):**
1. Text Readability — font size, line-height, letter-spacing, font choice, paragraph spacing, contrast ratios
2. Visual Hierarchy & Layout — section/title/body differentiation, editor vs. chrome balance
3. Interaction Comfort — button/target sizes, hover/focus states, icon clarity, labels, keyboard shortcuts
4. Color & Light — palette comfort, border visibility, glare, dark mode readiness
5. SpecsIntact-Specific UX — tailoring options, bracketed choices, reference tags, document outline, tag protection

If a severity tier has no findings, state: "No [severity] issues identified."

If you cannot assess an area, add: "Not Observable — [reason]" with a conditional recommendation.

#### 4. Consolidated Design Token / CSS Changeset

Provide a **single, copy-pasteable code block** with:
1. Typography system (CSS custom properties for font family, sizes, line-heights)
2. Color palette (semantic names: `--color-surface`, `--color-text-primary`, `--color-border`, `--color-focus-ring`, etc.)
3. Component overrides (buttons, toolbars, editor area, focus states)

**Tailor this to the project's CSS approach** (plain CSS with `editor.css`). Reference actual file paths where these values should be applied or where existing values should be replaced.

If any recommendation conflicts with mandated UFGS formatting from `reference/section.ini`, separate screen from print styles via `@media print` and note the conflict explicitly.

#### 5. Top 5 Quick Wins

Five changes with the highest **impact / effort** ratio. One sentence each, with the file path and specific edit.

#### 6. Prioritized Action Plan

- **High impact / Low effort** — implement now
- **High impact / Medium effort** — implement this sprint
- **Strategic** — plan for a future cycle

---

## Self-Review (perform before presenting report)

Before presenting the report, launch a **code-reviewer agent** to verify:

- [ ] Every Fix field contains a concrete value (px, hex, CSS property) AND a file path that exists in the project
- [ ] Every "Measured Value" in the findings table comes from actual `preview_inspect` output or computed style extraction, not guessed
- [ ] No finding references UI elements not visible in the screenshots taken
- [ ] Contrast ratios cited are calculated from actual observed RGB values using the luminance formula
- [ ] No details fabricated about parts of the app not seen or read
- [ ] Findings are sorted by severity (Critical -> Moderate -> Minor)
- [ ] Total findings <= 15
- [ ] CSS code block uses semantic custom-property names and is syntactically valid
- [ ] No recommendations conflict with `reference/section.ini` mandated values without an explicit `@media print` separation noted

---

## Phase 3: Implementation (ask before proceeding)

After presenting the report, ask:

> "Would you like me to implement any or all of these fixes directly in the codebase? I can start with the Top 5 Quick Wins, or work through the full Critical list. Let me know which approach you prefer."

If approved:

### Setup

- Use `EnterWorktree` to create an isolated worktree named `ux-ergonomic-review`. This keeps the main workspace clean and allows easy discard if changes aren't wanted.
- Use `TodoWrite` to create a checklist from the approved findings. Mark each finding `in_progress` -> `completed` as fixes are applied.

### Implementation Loop

For each severity tier (Critical first, then Moderate, then Minor):

1. **Before screenshot:** Take a "before" screenshot via `preview_screenshot` with `save_to_disk: true`
2. **Apply fixes:** Edit the CSS/JSX files for all findings in this tier
3. **Wait for hot-reload:** Pause briefly for Vite HMR to apply changes
4. **After screenshot:** Take an "after" screenshot at the same viewport size, saved to disk
5. **Verify computed styles:** Re-run `preview_inspect` on the changed elements to confirm the new values match the prescribed fix
6. **Present comparison:** Show the user both saved images with the finding numbers annotated
7. **Mark todos complete:** Update the TodoWrite checklist

### Constraints

- Do not modify any file outside the front-end presentation layer (no `src/lib/*.js`, no parsers, no serializers, no data model)
- Do not modify `reference/section.ini` or any `.ini` file

### Regression Check

After all fixes are applied:

1. Run `npm test` — all unit tests must pass (currently 283)
2. Run `npm run test:e2e` — all E2E tests must pass (currently 117)
3. If any test fails, revert the offending change and note it as "blocked by test regression" in the findings table
4. Present final test results to the user

### Completion

After implementation and regression check:
- Present the final before/after screenshots side by side
- Summarize what was changed, what was deferred, and why
- Ask the user whether to keep the worktree (for further refinement) or merge it
