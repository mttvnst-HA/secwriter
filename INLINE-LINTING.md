# Feature: Real-Time Inline Linting

## Context

This document is an implementation plan for adding real-time inline linting to SpecsIntact Modern (SIM). It was developed through a design discussion in Claude Chat after reviewing the full codebase (as of March 21, 2026), then revised by Claude Code after verifying every code reference against the actual codebase.

**You are the software engineer. The user (Matt) is the project manager. He does not write code. Deliver complete, working, tested code - never pseudocode, skeleton code, or partial snippets.**

## Goal

As the engineer types in SIM, compliance violations, passive voice, and grammar errors appear as colored underlines directly in the text - no panel interaction required. The existing panel-based compliance checker (CompliancePanel.jsx) stays as-is for full-document review. This is an additional real-time feedback layer.

## Architecture Overview

Three detection engines feed into a single orchestrator that renders findings via the CSS Custom Highlight API (zero DOM mutation):

```
User types in EditableBlock
        |
        v  (500ms debounce)
inline-linter.js (orchestrator)
   |          |            |
   v          v            v
Static Rules  compromise.js  Harper.js
(sync, <5ms)  (sync, <1ms)   (Web Worker, <10ms)
   |          |            |
   v          v            v
   merge + deduplicate + prioritize
        |
        v
CSS Custom Highlight API
(Range objects, no DOM mutation)
        |
        v
::highlight(compliance-error)   yellow background
::highlight(passive-voice)      orange background
::highlight(grammar-error)      blue underline/background
```

### Why CSS Custom Highlight API (not span wrapping)

SIM's EditableBlock.jsx uses contentEditable with React. Wrapping error text in `<span>` elements would:
- Destroy cursor position (text nodes get split, Selection anchors invalidate)
- Corrupt the browser's undo stack (script DOM changes interleave with user edits)
- Fight React's reconciliation (React sees unexpected nodes on re-render)

The CSS Custom Highlight API avoids all three problems. It applies styling via Range objects without modifying the DOM tree. The API reached Baseline status across all major browsers in June 2025.

**Known limitation:** Firefox cannot render `text-decoration` on highlights. Use `background-color` as the primary indicator. Progressively enhance with `text-decoration: underline wavy` for Chrome/Edge.

**Known limitation:** No pointer events on highlights. Tooltip interaction requires `document.caretPositionFromPoint()` or `document.caretRangeFromPoint()` hit-testing against tracked error ranges.

### Relationship to Existing Compliance System

The existing compliance panel (`CompliancePanel.jsx`, `compliance-checker.js`, `compliance-rules.js`) is a manual "Run Check" workflow for full-document review with grouped findings, batch accept/reject, and AI (Artificial Intelligence) rewrite. That system is unchanged.

The inline linter is a lightweight real-time layer that:
- Runs on the **focused block only** (not the full document)
- Shows findings as inline highlights (not in a panel)
- Offers quick-fix via tooltip (not batch operations)
- Reuses the same static rules from `compliance-rules.js`
- Adds two new engines: compromise.js (passive voice) and Harper.js (grammar)

**Collision avoidance:** When the compliance panel is open and `applyHighlights()` has wrapped text in `<span class="compliance-highlight">` spans, the inline linter's CSS highlights must be suppressed on those blocks to avoid double-highlighting the same violations. Use a `compliancePanelActive` flag passed from App.jsx. When the panel clears its highlights, the inline linter resumes.

## Dependencies to Install

```bash
npm install compromise harper.js
```

- **compromise** (~210KB minified / ~80KB gzipped): Rule-based NLP (Natural Language Processing) library with built-in POS (Part-of-Speech) tagging and passive voice detection via `#Passive` tag. Runs synchronously in the main thread, ~0.1ms per sentence. **Must be lazy-loaded** via dynamic `import()` to avoid blocking initial page load — SIM currently has only 3 production dependencies.
- **harper.js** (~2-4MB WASM binary + dictionary): Rust-based grammar checker compiled to WebAssembly (WASM). Provides `WorkerLinter` that runs in a Web Worker for non-blocking grammar checks, <10ms per document. **Must be lazy-loaded** — show grammar highlights only after WASM is fully initialized; do not add results after the user has already processed static/NLP findings for a given block.

## New Files

```
src/lib/
  inline-linter.js        # Orchestrator: debounce, run engines, merge, manage highlights
  nlp-rules.js            # compromise.js passive voice + imperative mood detection
  grammar-checker.js       # Harper.js Web Worker wrapper
  __tests__/
    inline-linter.test.js
    nlp-rules.test.js
    grammar-checker.test.js
```

## Modified Files

```
src/components/EditableBlock.jsx   # Wire up debounced linting on input + new tooltip
src/styles/editor.css              # Add ::highlight() rules
src/App.jsx                        # Add linting toggle to preferences/toolbar
```

---

## Session 1: CSS Custom Highlight API Proof of Concept

### Objective

Prove that the CSS Custom Highlight API works inside SIM's contentEditable blocks without breaking editing, cursor, undo/redo, or existing tests.

### Task

1. Create `src/lib/inline-linter.js` with a minimal implementation:
   - Export `initInlineLinting(blockEl, blockId, plainText, rules)` that:
     - Runs `runStaticRules()` from `compliance-rules.js` (exported at line 361) against the plainText
     - For each violation, creates a DOM `Range` object targeting the matching text within `blockEl`'s text nodes
     - Registers all ranges as a named highlight: `CSS.highlights.set('compliance-error', new Highlight(...ranges))`
   - Export `clearInlineLinting()` that calls `CSS.highlights.delete('compliance-error')`

2. In `EditableBlock.jsx`:
   - **There is no `commit()` function.** The actual flow: `handleInput` (line 225) handles slash menu detection only; `handleBlur` (line 159) reads `ref.current.innerHTML` and calls `onUpdate(blockId, html)`. HTML is always read fresh from the DOM.
   - Add a `useEffect` that attaches a **native `input` event listener** on `ref.current` (the contentEditable DOM element) with a 500ms debounce timer. On each input event, extract plain text from the DOM via TreeWalker (not from block.html, which may be stale until blur), then call `initInlineLinting()` with the block's DOM element, its ID, the extracted plain text, and the cached rules from `getRules()` (exported at line 449 of `compliance-rules.js`).
   - On blur, call `clearInlineLinting()`
   - On unmount, call `clearInlineLinting()` and clear the debounce timer

3. In `editor.css`, add:
   ```css
   ::highlight(compliance-error) {
     background-color: rgba(234, 179, 8, 0.25);
   }

   /* Progressive enhancement for Chrome/Edge */
   @supports (text-decoration: underline wavy red) {
     ::highlight(compliance-error) {
       background-color: transparent;
       text-decoration: underline wavy #d97706;
       text-decoration-skip-ink: none;
     }
   }
   ```

### Critical Implementation Detail: Range Creation via String Search (not offset mapping)

**Do NOT use violation character offsets to map back to DOM positions.** The `runStaticRules()` function operates on text processed through `stripHtml()` (compliance-checker.js line 53), which removes `<del>` content, strips hidden ENG/MET units, collapses multiple spaces to single spaces, and decodes HTML entities. These transformations change string lengths, so violation offsets from `runStaticRules()` do NOT correspond 1:1 to DOM text node positions.

**Instead, use the TreeWalker string-search approach** that `CompliancePanel.jsx`'s `applyHighlights()` already uses (lines 64-120):

Algorithm:
1. Walk the blockEl's text nodes with `document.createTreeWalker(blockEl, NodeFilter.SHOW_TEXT)`
2. Skip text nodes inside `<del>` elements and `.compliance-highlight` spans
3. For each violation, search for `violation.match` text within the text nodes by comparing text content
4. Perform word-boundary checks to avoid substring matches (e.g., "contract" inside "Contractor")
5. Create a `Range` object with `setStart(node, localOffset)` and `setEnd(node, localOffset + matchLength)`
6. Process nodes in **reverse order** to preserve indices as you work through the list

This approach is proven in the existing codebase and avoids the offset-drift problem entirely.

**Additionally:** For inline linting, create a lighter text extraction function (`extractPlainText(blockEl)`) that walks the DOM directly and preserves whitespace faithfully. Only skip `<del>` element content and hidden ENG/MET spans. Do NOT use `stripHtml()` from compliance-checker.js, which collapses double spaces and was the root cause of the FMT-001 false positive issue (75+ false positives per spec).

### Acceptance Criteria

- [ ] Type "The Contractor shall provide" in any editable block. "shall" appears highlighted within ~500ms.
- [ ] Delete "shall" and retype. Highlight disappears during typing, reappears after 500ms pause.
- [ ] Cursor movement through highlighted text works normally (arrow keys, click, shift+click selection).
- [ ] Ctrl+Z/Ctrl+Y undo/redo work normally - no extra undo steps from highlight operations.
- [ ] Copy/paste within highlighted text works (highlight spans should not appear in clipboard).
- [ ] Opening the CompliancePanel and running a full check still works independently.
- [ ] All 561 existing tests pass with no modifications.

### What NOT to Do

- Do NOT modify the existing `applyHighlights()` in `CompliancePanel.jsx`. That system and this one are independent.
- Do NOT add new npm dependencies in this session. Only use the existing `compliance-rules.js` engine.
- Do NOT implement the tooltip yet. Just highlights.
- Do NOT lint all visible blocks. Only lint the **focused block** (the one with the cursor). This keeps the scope small and avoids performance questions.
- Do NOT use `stripHtml()` from `compliance-checker.js` for text extraction. It collapses spaces and caused FMT-001 false positives.

---

## Session 2: Inline Tooltip on Hover/Click

### Objective

Add a small floating tooltip that appears when the cursor is inside a highlighted range, showing the violation details and offering a quick fix.

### Task

1. In `inline-linter.js`, maintain an array of active findings alongside their Range objects:
   ```js
   // Conceptual structure - implement as you see fit
   activeFindings = [
     { range: Range, violation: { ruleId, message, severity, ufsRef, fixFn, match, replacement } }
   ]
   ```

2. Create a new component `src/components/InlineTooltip.jsx`:
   - Small floating div positioned near the cursor (similar positioning approach as `FloatingToolbar.jsx`)
   - Shows: severity badge (colored dot), rule message (1 line), "Why?" expandable with UFS (Unified Facilities Supplement) reference
   - If `fixFn` is not null: shows a "Fix" button that applies the fix to the block's HTML and dismisses the tooltip
   - If `fixFn` is null: shows "Needs manual rewrite" or "Use Compliance Panel for AI fix"
   - Dismiss on: cursor moves out of the highlighted range, Escape key, click outside

3. Detection approach for "cursor is in a highlighted range":
   - Listen for `selectionchange` events on the document (debounce 100ms)
   - Get current selection via `document.getSelection()`
   - If selection is collapsed (just a cursor, not a range selection), get the cursor's node and offset
   - Check each entry in `activeFindings` to see if the cursor position falls within that finding's Range
   - Use `range.compareBoundaryPoints()` or manually compare node/offset to determine containment
   - If cursor is in a finding, show tooltip. If not, hide tooltip.

### Critical Implementation Detail: FloatingToolbar Conflict

The inline tooltip and `FloatingToolbar.jsx` will compete for visibility. The FloatingToolbar appears when text is selected; the inline tooltip appears when the cursor is collapsed inside a highlighted range. These are mutually exclusive states, but the transition between them must be clean.

**Rules:**
- When the FloatingToolbar is active (text is selected), the InlineTooltip must be hidden. Check `document.getSelection().isCollapsed` — only show InlineTooltip when `true`.
- When the user clicks to place a collapsed cursor (dismissing the FloatingToolbar), wait for the FloatingToolbar's own dismiss logic to complete before checking for InlineTooltip display. The 100ms `selectionchange` debounce should provide sufficient delay.
- If both somehow appear, InlineTooltip should have a lower z-index than FloatingToolbar.

### Critical Implementation Detail: Fix Application

When the user clicks "Fix" in the tooltip:
1. The fix must go through the same code path as `handleComplianceAcceptFix` in `App.jsx` (line 855, signature: `(blockId, fixedText)`) so that Track Changes integration works
2. The tooltip calls a callback prop (passed down from App.jsx through EditableBlock) with `(blockId, fixedText)`
3. After fix application, clear and re-run the linter on the block (the fixed text may have resolved other violations too, or introduced new content that needs checking)

### Acceptance Criteria

- [ ] Click on a highlighted "shall" - tooltip appears showing the prohibition message and UFS 1-300-02 citation
- [ ] Click "Fix" - the sentence rewrites (e.g., "The Contractor shall provide" becomes "Provide"), tooltip dismisses, highlight clears
- [ ] Move cursor away from highlight - tooltip disappears
- [ ] Press Escape while tooltip is showing - tooltip disappears
- [ ] Tooltip does not appear when selecting text across a highlight (only on collapsed cursor)
- [ ] **FloatingToolbar and InlineTooltip never appear simultaneously**
- [ ] With Track Changes on, clicking "Fix" creates a tracked change (ADD/DEL) just like the compliance panel does
- [ ] Tooltip positioning stays within viewport (does not overflow off-screen on edge-of-viewport blocks)
- [ ] Undo (Ctrl+Z) after a tooltip fix reverts the change

---

## Session 3: Grammar Checking via Harper.js

### Objective

Add in-browser grammar/spelling checking using Harper.js (Rust compiled to WASM), running in a Web Worker for non-blocking operation. Grammar checking provides higher user value than passive voice detection and exercises the async/Worker pattern that the orchestrator needs.

### Task

1. Install Harper: `npm install harper.js`

2. Create `src/lib/grammar-checker.js`:
   ```js
   // Export: initGrammarChecker() => Promise<void>  (initializes Web Worker, lazy)
   // Export: checkGrammar(plainText, blockId) => Promise<Array<violation>>
   // Export: destroyGrammarChecker() => void  (terminates Web Worker)
   // Export: isGrammarReady() => boolean  (check if WASM is loaded)
   ```

   Harper's `WorkerLinter` handles Web Worker creation internally. Initialize it lazily on first use (NOT on app startup — the ~2-4MB WASM download should not block initial page load). The `lint()` method returns an array of lint results with character offsets, severity, and suggestion text.

   Map Harper's output to the standard violation shape:
   - `ruleId`: `GRAMMAR-${harperRuleId}` (Harper has its own rule identifiers)
   - `severity`: Map Harper's severity levels to SIM's `high`/`medium`/`low`
   - `fixFn`: If Harper provides a suggestion, create a fix function that applies it
   - `message`: Use Harper's human-readable message

3. Wire into `inline-linter.js`:
   - Static rules run synchronously and produce highlights immediately
   - Harper runs asynchronously (Web Worker). When results arrive, merge them into the existing findings and update highlights
   - Register grammar findings under: `CSS.highlights.set('grammar-error', new Highlight(...ranges))`
   - Handle the case where the user types again before Harper returns: if the block text has changed since the request was sent, discard the stale results
   - **Do not show grammar highlights if Harper was not initialized before the current lint cycle started.** This prevents delayed "pop-in" highlights appearing after the user has already read the static rule results. If Harper finishes loading mid-session, grammar highlights appear starting with the next focus/edit, not retroactively on the current block.

4. In `editor.css`, add:
   ```css
   ::highlight(grammar-error) {
     background-color: rgba(59, 130, 246, 0.15);
   }

   @supports (text-decoration: underline wavy blue) {
     ::highlight(grammar-error) {
       background-color: transparent;
       text-decoration: underline wavy #3b82f6;
       text-decoration-skip-ink: none;
     }
   }
   ```

### Critical Implementation Detail: Stale Result Handling

The debounce fires, sends text to Harper's Web Worker. The user keeps typing. A new debounce fires 500ms later with updated text. Harper returns results for the first request. Those results are now stale - the character offsets don't match the current text.

Solution: Tag each request with a monotonically increasing version number. When results arrive, compare the version to the current version. If stale, discard. Only apply results that match the latest version.

### Critical Implementation Detail: Domain-Specific False Positives

Harper is a general-purpose grammar checker. Construction specification text will trigger false positives on:
- Technical abbreviations (ASTM, AASHTO, NAVFAC) flagged as spelling errors
- Unit expressions ("600 mm", "24 inches") flagged as formatting issues
- UFGS-specific conventions (double space after period, ALL CAPS section titles)
- Specification jargon ("submittal", "punchlist") flagged as misspellings

Harper supports custom dictionaries and rule disabling. Create a SIM-specific configuration that:
- Adds a custom word list of common construction/engineering terms
- Disables rules that conflict with UFGS conventions (investigate Harper's rule configuration API)

### Acceptance Criteria

- [ ] Type "The concrete are placed on surface." Two grammar errors highlighted: "are" (subject-verb disagreement) and "on surface" (missing article).
- [ ] Grammar highlights appear within ~100ms of the debounce (Web Worker response time).
- [ ] Rapid typing does not cause stale highlights to flash on screen.
- [ ] Grammar tooltip shows Harper's suggestion. Clicking "Fix" applies it.
- [ ] Common engineering terms (ASTM, AASHTO, NAVFAC, psi, pcf, ksf) are NOT flagged as spelling errors.
- [ ] Both highlight types can coexist on the same block: yellow (compliance) and blue (grammar).
- [ ] Grammar checker initializes without blocking app startup. If WASM loading is slow, the app works normally and grammar checking becomes available when ready.
- [ ] **Grammar highlights do not "pop in" on the currently focused block after a delayed WASM load. They appear starting with the next edit/focus cycle.**
- [ ] All existing tests still pass.

---

## Session 4: Passive Voice Detection via compromise.js

### Objective

Add passive voice and indicative mood detection using compromise.js, displayed as a second highlight color alongside the existing static rule and grammar highlights.

### Task

1. Install compromise: `npm install compromise`

2. Create `src/lib/nlp-rules.js`:
   ```js
   // Export: detectNlpIssues(plainText, blockId) => Array<violation>
   // Returns violations in the same shape as runStaticRules():
   // { ruleId, blockId, match, index, sentence, severity, message, fixFn, category, ufsRef }
   ```

   **Lazy-load compromise.js** via dynamic `import()` to avoid adding ~210KB to the initial bundle. SIM currently has only 3 production dependencies (React, react-dom, lucide-react). The first call to `detectNlpIssues()` triggers the import; subsequent calls use the cached module.

   Detection targets:
   - **Passive voice**: Use compromise's `doc.match('#Passive')` or detect `be + past participle` patterns. Rule ID: `NLP-PASSIVE-001`. Severity: `medium`. Message: "Passive voice - consider rewriting in imperative mood per UFS 1-300-02 Section 2-4.1". fixFn: `null` (passive voice rewrites need sentence restructuring - defer to AI tier).
   - **Indicative mood with "Contractor" as subject**: Detect patterns like "The Contractor provides/installs/places..." (indicative mood, not imperative). Rule ID: `NLP-INDICATIVE-001`. Severity: `high`. Message: "Indicative mood - use imperative: 'Provide' not 'The Contractor provides'". fixFn: attempt simple rewrite (strip "The Contractor" + convert verb to imperative).

3. Wire into `inline-linter.js`:
   - After running static rules, also run `detectNlpIssues()` on the same plain text
   - Register NLP findings under a separate highlight group: `CSS.highlights.set('passive-voice', new Highlight(...ranges))`

4. In `editor.css`, add:
   ```css
   ::highlight(passive-voice) {
     background-color: rgba(249, 115, 22, 0.2);
   }

   @supports (text-decoration: underline wavy orange) {
     ::highlight(passive-voice) {
       background-color: transparent;
       text-decoration: underline wavy #ea580c;
       text-decoration-skip-ink: none;
     }
   }
   ```

5. The `InlineTooltip.jsx` from Session 2 already handles any violation shape - NLP findings just show their message and severity like static rule findings do.

### Critical Implementation Detail: False Positive Mitigation

compromise.js has no published accuracy benchmarks. To manage false positive risk:

- **Exempt note blocks** (`type === 'note'`): Notes use advisory language ("should", passive constructions) by design. This matches the existing exemption in `compliance-rules.js` line 367-368.
- **Exempt bracketed text**: Reuse the bracket exclusion logic from `compliance-rules.js`. Bracketed text is template language that the engineer doesn't control.
- **Exempt text inside `<del>` tags**: Same as existing compliance checker - don't flag deleted content.
- **Lower severity to `medium`**: Passive voice is not always wrong in specifications (descriptions, definitions, notes). Medium severity means it highlights but doesn't appear red/urgent.

### Required: Accuracy Baseline Test

Create `src/lib/__tests__/nlp-rules.test.js` with a test corpus of **at least 30 real sentences** extracted from `src/data/sample-31-00-00.json`. **Use `it.each()` for the corpus tests to keep total `it()` blocks under 30** (per CLAUDE.md rule: "Test files should have ≤30 tests"). For each sentence, manually classify:
- Is it passive voice? (yes/no)
- Is it indicative mood? (yes/no)
- Expected detection result from compromise.js

This gives a measured false-positive and false-negative rate against actual spec language. If the false positive rate exceeds 20%, add a note in the test file documenting the specific failure patterns so they can be addressed with tighter detection logic or exclusion rules.

### Acceptance Criteria

- [ ] Type "Materials are to be placed by the Contractor on the prepared surface." Two highlights appear: "are to be" (yellow, static rule) and the full passive clause (orange, NLP).
- [ ] Type "Place materials on the prepared surface." No highlights appear.
- [ ] Type "The Contractor installs the drainage system." Highlight appears on the full sentence (indicative mood, NLP).
- [ ] Passive voice inside a note block (`type === 'note'`) is NOT highlighted.
- [ ] Passive voice inside brackets `[materials shall be tested]` is NOT highlighted.
- [ ] The accuracy baseline test runs and documents the false positive rate.
- [ ] All existing 561 tests still pass.

---

## Session 5: Orchestrator Polish, De-duplication, and User Toggle

### Objective

Finalize `inline-linter.js` as the single entry point for all real-time linting, with proper de-duplication, priority, and a user-facing on/off toggle.

### Task

1. Complete `inline-linter.js` as the orchestrator:
   - Single exported function: `lintBlock(blockEl, blockId, blockType, plainText)` that runs all three engines and manages all highlights
   - De-duplication: If a static rule and Harper both flag the same text range, keep the static rule finding (it has the UFS citation and purpose-built fix function). Define "same range" as overlapping by more than 50% of characters.
   - Priority ordering for tooltip: When cursor is in an area flagged by multiple engines, show the highest-severity finding first. Static UFS rules > NLP passive voice > grammar suggestions.
   - Cleanup: `clearAllHighlights()` removes all three highlight groups

2. Add a linting toggle:
   - In `App.jsx`, add a state variable `inlineLintingEnabled` (default: `true`)
   - Store preference in localStorage key `sim-inline-linting`
   - Add a small toggle button near the existing toolbar controls (near the Compliance button). Simple text: "Lint" with an on/off indicator.
   - When toggled off: clear all highlights, stop debounced checks
   - When toggled on: immediately lint the focused block

3. Add a severity filter preference:
   - localStorage key `sim-inline-lint-severity` with value `all` | `high-medium` | `high-only`
   - Default: `high-medium` (show compliance violations and passive voice, hide grammar suggestions)
   - Accessible via a small dropdown or the tooltip's settings area
   - This prevents the "everything is underlined" problem that makes linting feel like noise rather than signal

4. Add a visual indicator per block:
   - When a block has active findings, show a small colored dot in the left gutter/margin area
   - Red dot = has high-severity findings, amber = medium only, blue = low only
   - This gives a document-level overview of where issues are without requiring every block to be focused

5. **Compliance panel collision handling:**
   - When `CompliancePanel` is active and has applied span-based highlights via `applyHighlights()`, suppress the inline linter's CSS highlights on the affected blocks
   - Pass a `compliancePanelActive` flag from App.jsx to EditableBlock
   - When the panel clears its highlights, the inline linter resumes on the next focus/edit cycle

### Critical Implementation Detail: Performance Budget

On a 20-page spec (~300-500 blocks), only the focused block runs the linter. But the linter must not cause perceptible lag while typing. Target budget:
- Static rules: <5ms (already measured at ~0.3ms per block)
- compromise.js: <5ms per block (documented at ~0.1ms per sentence, a block might have 3-5 sentences)
- Harper.js: <15ms per block (runs in Web Worker, non-blocking, but results must arrive before the next debounce)
- Highlight API Range creation: <2ms (creating ~5-20 Range objects)
- Total budget: <10ms synchronous on main thread + async Harper results

If any engine exceeds budget on real spec content, log a warning and consider increasing the debounce interval or skipping that engine for very large blocks.

### Acceptance Criteria

- [ ] All three highlight types render correctly with distinct colors
- [ ] When "shall" is flagged by both static rules and Harper, only one highlight appears (static rule wins)
- [ ] Tooltip shows the highest-priority finding when multiple findings overlap
- [ ] Toggle button turns inline linting on and off. Preference persists across page reloads.
- [ ] Severity filter works: setting "high-only" hides passive voice (medium) and grammar (low) highlights
- [ ] Colored dots appear in block gutters for blocks with findings (when focused and linted)
- [ ] Typing speed is not perceptibly affected by linting (test by typing a full sentence rapidly)
- [ ] **When the compliance panel has active highlights, inline linter highlights are suppressed (no double-highlighting)**
- [ ] All existing 561+ tests pass
- [ ] New tests cover: de-duplication logic, priority ordering, toggle behavior, severity filtering, stale result handling

---

## Testing Strategy

Each session adds tests in the corresponding `__tests__/` file. The overall test additions should cover:

### Unit Tests (Vitest)

| Test File | Coverage |
|-----------|----------|
| `inline-linter.test.js` | Orchestration, de-duplication, priority, severity filtering, toggle behavior, text extraction (whitespace preservation) |
| `grammar-checker.test.js` | Harper initialization, lint result mapping, custom dictionary, stale result handling |
| `nlp-rules.test.js` | Passive voice detection, indicative mood detection, bracket/note/del exclusion, false positive baseline corpus (30+ sentences via `it.each()`) |

**Testing constraint:** Per CLAUDE.md, test files must have ≤30 `it()` blocks. Use `it.each()` or batch assertions in a single `it()` for data-driven tests (especially the NLP corpus).

**Testing environment:** The CSS Custom Highlight API and DOM Range creation require a browser environment. Unit tests for `inline-linter.js` should mock `CSS.highlights` and `document.createTreeWalker`. Integration testing of actual highlight rendering must be done via Playwright E2E tests or manual browser verification.

### Manual Test Script (for Matt to verify in browser)

After each session, perform these manual checks:
1. Open a spec file in SIM
2. Navigate to a text block and start typing
3. Intentionally introduce: "shall", passive voice, a grammar error
4. Verify highlights appear after ~500ms
5. Click on a highlight, verify tooltip
6. Click "Fix" if available, verify the fix applies
7. Ctrl+Z to undo the fix
8. Toggle linting off, verify highlights clear
9. Open the Compliance panel and run a full check - verify it works independently
10. **With the compliance panel open and highlights active, verify inline linting highlights are suppressed**

---

## Design Decisions and Rationale

### Why only the focused block?

Linting all visible blocks on every edit would require scanning 20-50 blocks (a screen's worth), potentially with Harper's async latency on each. For a vibe-coded project where debugging performance issues is difficult, limiting to the focused block is the safe choice. If performance proves to be no issue in practice, expanding to visible blocks is a future enhancement.

### Why 500ms debounce?

- 200ms: Too aggressive. Highlights flicker as the user types mid-word.
- 500ms: Standard for "the user has paused." Matches VS Code's diagnostic delay.
- 1000ms: Too slow. The user finishes a sentence and waits noticeably.

Make this configurable via a constant in `inline-linter.js` so it can be tuned without a code change.

### Why not replace the Compliance Panel?

The panel does things inline linting cannot: batch accept/reject, grouped findings across entire document scope, AI rewrites, undo checkpoints for batch operations, session cost tracking. Inline linting is a writing aid; the panel is a review tool. They serve different moments in the workflow.

### Why separate highlight groups per engine?

Using three named highlight groups (`compliance-error`, `passive-voice`, `grammar-error`) instead of one means:
- Each has distinct styling (the user learns the color meanings)
- The severity filter can show/hide entire groups via `CSS.highlights.delete()` without re-running any engine
- Performance: clearing one group doesn't require rebuilding the others

### Why compromise.js over wink-nlp?

Bundle size. compromise.js is ~80KB gzipped vs wink-nlp's ~1MB (with language model). For a browser app where initial load time matters, the smaller library wins. compromise.js's estimated 85-90% POS (Part-of-Speech) accuracy is acceptable for this use case because:
- The passive voice patterns in construction specs are syntactically distinctive ("shall be + past participle") and easier to detect than conversational passive
- False positives are shown at medium severity (not alarming) and dismissible
- The accuracy baseline test (Session 4) will quantify the actual false positive rate against real spec text before shipping

If the false positive rate is unacceptable in practice, swapping to wink-nlp is a contained change in `nlp-rules.js` only.

### Why Harper.js over LanguageTool?

LanguageTool requires Java (a ~100-150MB runtime dependency) and cannot run in the browser. Harper.js runs as WASM in a Web Worker with no external dependencies. For a browser-based app, there is no alternative. If SIM ever becomes a desktop app (Electron/Tauri), LanguageTool as a local sidecar becomes viable, but that is not the current architecture.

### Why Harper.js before compromise.js? (Session order)

The original plan had compromise.js (passive voice) in Session 3 and Harper.js (grammar) in Session 4. This was revised:
- Harper.js provides more immediate user value (grammar/spelling catches real errors vs. passive voice which is stylistic)
- Harper.js exercises the async Web Worker pattern that the orchestrator needs — better to surface any integration issues early
- If Session 1 reveals CSS Highlight API problems with contentEditable, we want to discover them before installing any npm dependencies. Keeping Session 1 dependency-free and pushing both npm installs to Sessions 3-4 reduces wasted work if the PoC fails.

---

## Browser Compatibility

- **CSS Custom Highlight API**: Baseline since June 2025. Supported in Chrome 105+, Edge 105+, Safari 17.2+, Firefox 132+.
- **compromise.js**: Pure JavaScript, no browser requirements.
- **Harper.js (WASM)**: Requires WebAssembly support (all modern browsers since 2017).
- **Web Workers**: Supported in all modern browsers.

SIM's existing codebase already requires a modern browser (React 18, ES modules, contentEditable). The CSS Custom Highlight API does not narrow the browser support matrix.

---

## Risk Register

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| CSS Custom Highlight API disrupts cursor/selection in contentEditable | Low | High (blocks Session 2-5) | Session 1 is specifically a proof-of-concept to surface this risk before any other work begins. If it fails, fall back to the existing span-wrapping approach used by `CompliancePanel.applyHighlights()` |
| compromise.js false positive rate >20% on spec text | Medium | Medium (annoying UX) | Session 4 includes a mandatory accuracy baseline test. If rate is too high, tighten detection patterns or drop severity to `low` |
| Harper.js WASM binary too large for acceptable load time | Low | Low (grammar is the least critical engine) | Lazy-load Harper on first use, not on app startup. Grammar checking becomes available after WASM loads. Show grammar highlights only on the next edit cycle, not retroactively on the current block. |
| Three highlight colors on the same block looks cluttered | Medium | Low (UX, not functional) | Severity filter defaults to `high-medium` (hides grammar/blue). User opts in to full linting. |
| Range objects invalidated by React re-render | Medium | High (stale highlights) | Re-run linting after every React commit that modifies the block DOM. Use `useLayoutEffect` or `MutationObserver` to detect DOM changes and trigger re-linting. |
| InlineTooltip and FloatingToolbar fight for visibility | Medium | Medium (UX confusion) | InlineTooltip only shows when selection is collapsed. FloatingToolbar only shows when text is selected. 100ms selectionchange debounce provides transition buffer. InlineTooltip has lower z-index. |
| Compliance panel span-highlights collide with inline CSS highlights | Medium | Medium (visual noise) | `compliancePanelActive` flag suppresses inline highlights when panel has active span-based highlights. Inline linter resumes when panel clears. |
| `stripHtml()` offset drift causes wrong highlight positions | High | High (wrong text highlighted) | Do NOT use `stripHtml()` for inline linting. Use a custom `extractPlainText(blockEl)` that walks the DOM directly and preserves whitespace. Use string-search matching (not offset mapping) for Range creation. |

---

## Implementation Order Summary

| Session | Adds | Depends On | New Tests |
|---------|------|-----------|-----------|
| 1 | CSS Custom Highlight API + static rules on focused block | Nothing | Highlight creation, string-search range mapping, cleanup, text extraction |
| 2 | InlineTooltip.jsx with fix application | Session 1 | Cursor-in-range detection, fix callback, tooltip positioning, FloatingToolbar mutual exclusion |
| 3 | Harper.js Web Worker grammar checking | Sessions 1-2 | WASM init, stale result handling, custom dictionary, lazy-load behavior |
| 4 | compromise.js passive voice + indicative mood detection | Sessions 1-2 | NLP detection accuracy, 30+ sentence corpus baseline (via `it.each()`), lazy import |
| 5 | Orchestrator, de-duplication, toggle, severity filter, gutter dots, panel collision handling | Sessions 1-4 | De-dup logic, priority, toggle persistence, performance budget, compliancePanelActive flag |

Each session should be completable in a single Claude Code working session (2-4 hours). Each produces a testable increment - run the app, type in a block, verify the new behavior works, run the test suite to confirm no regressions.

---

## Codebase Reference (verified March 21, 2026)

Key functions and their locations for implementers:

| Function | File | Line | Signature |
|----------|------|------|-----------|
| `runStaticRules` | `compliance-rules.js` | 361 | `(plainText, blockId, rules, options)` |
| `getRules` | `compliance-rules.js` | 449 | `() => Array<rule>` |
| `buildRules` | `compliance-rules.js` | 150 | `() => Array<rule>` |
| `stripHtml` | `compliance-checker.js` | 53 | `(html, unitDisplay)` — **DO NOT USE for inline linting** |
| `applyHighlights` | `CompliancePanel.jsx` | 64-120 | `(group, scrollToBlockId)` — reference implementation for TreeWalker approach |
| `handleComplianceAcceptFix` | `App.jsx` | 855 | `(blockId, fixedText)` — fix callback entry point |
| `handleInput` | `EditableBlock.jsx` | 225 | Slash menu detection only, does NOT commit HTML |
| `handleBlur` | `EditableBlock.jsx` | 159 | Reads `ref.current.innerHTML`, calls `onUpdate(blockId, html)` |

**Note:** There is no `commit()` function in EditableBlock.jsx. HTML is always read fresh from `ref.current.innerHTML` on demand.
