# Inline Linting

Real-time linting of the focused block. Three detection engines feed a single reducer; the reducer's ranges are rendered through the **CSS Custom Highlight API** with zero DOM mutation, so cursor position, undo/redo, and PM's render cycle are never disturbed.

This document is the deeper reference. `CLAUDE.md` ("Inline Linting Architecture" section) carries the load-bearing invariants and is authoritative for terminology.

## What it does

As the engineer types, three colored highlights surface findings without any panel interaction:

| Color | Tier | Engine | Source rules |
|---|---|---|---|
| Yellow background / wavy underline | Static UFS rules | `compliance-rules.js` (shared with Compliance panel) | UFS 1-300-02 |
| Orange | NLP | `nlp-rules.js` (compromise.js) | Passive voice, indicative mood with "Contractor" as subject |
| Blue | Grammar | `grammar-checker.js` (harper.js in a Web Worker) | Subject-verb agreement, articles, spelling |

Each tier renders as its own named highlight group (`compliance-error`, `passive-voice`, `grammar-error`) so the severity filter can hide entire groups without re-running any engine.

A cursor inside a highlighted range opens `InlineTooltip.jsx` showing the rule message, the UFS citation (when applicable), and a **Fix** button when the rule's `fixFn` is non-null. Static rules and grammar typically have fixes; NLP usually defers to "needs rewrite."

## Architecture

Pure-reducer + per-block hook + single App-level effect. This is the same shape as Track Changes, Comments, and Compliance — see the "Pure-reducer playbook" in `CLAUDE.md`.

```
+----------------------------+         +-------------------------+
|  src/lib/linting.js        |         |  src/components/         |
|  (pure reducer)            |  reads  |  useBlockLinting.js      |
|                            +<--------+  (per-block lifecycle)   |
|  - state: { enabled,       |         |                          |
|    suspended, byBlock }    |  writes |  - debounced lint cycle  |
|  - 8 verbs                 +-------->+    on input              |
|  - selectors:              |         |  - sync static + NLP     |
|    getRangesByTier(state)  |         |  - async Harper dispatch |
|  - dedup helpers           |         |  - stale-result discard  |
|  - DEFERRED_TO_PANEL set   |         |  - tooltip detection     |
+-------------+--------------+         +-------------------------+
              | reads
              v
+----------------------------+
|  src/App.jsx               |
|  useEffect([lintingState]) +--> CSS.highlights.set('compliance-error', ...)
|                            +--> CSS.highlights.set('passive-voice',    ...)
|                            +--> CSS.highlights.set('grammar-error',    ...)
+----------------------------+
```

### `src/lib/linting.js` — the reducer

Opaque state, pure verbs, pure selectors, property-tested invariants. Shape:

```js
{
  enabled: boolean,
  suspended: boolean,             // set true while Compliance panel is open
  byBlock: Map<blockId, {
    compliance: Finding[],
    nlp:        Finding[],
    grammar:    Finding[],
    grammarText: string           // text version Harper was run against
  }>
}
```

Verbs: `createInitial`, `setEnabled`, `setSuspended`, `setBlockFindings`, `clearBlock`, `clearAll`.

Selectors: `isActive`, `isEnabled`, `isSuspended`, `getBlockFindings`, `getAllFindings`, `getBlockSeverity`, `getGrammarText`, `getRangesByTier`.

Pure helpers:
- `dedupNlpAgainstCompliance(nlp, compliance)` — when an NLP finding overlaps a static rule by more than 50%, the static rule wins (it carries a UFS citation).
- `dedupGrammarAgainstFindings(grammar, others, threshold = 0.5)` — grammar suppressed when overlap with static or NLP exceeds the threshold.
- `pickHighestSeverityFinding(findings)` — used by the tooltip when multiple tiers fire on the same range.
- `DEFERRED_TO_PANEL` — Set of rule IDs (`TERM-suitable`, `TERM-any`, `TERM-should`, `VAGUE-applicable`) that need sentence-level context. These run in the Compliance panel's full scan but are hidden from inline linting to avoid false positives.

Range objects are **opaque** to the reducer — it never constructs `Range`, never reads from the DOM. Tests are plain Vitest. The hook is what bridges to the DOM.

### `src/components/useBlockLinting.js` — per-block hook

Owns every DOM-bound and async effect for one block:

- Debounced lint cycle on input (400ms default).
- Lint on focus, lint on enable, lint on un-suspend.
- Synchronous static + NLP pass.
- Async Harper dispatch with stale-result detection (results discarded if the text changed while the Worker was processing).
- Lazy-load triggers for compromise.js (~210KB) and harper.js (~2-4MB WASM) — both fire on first need.
- Dedup pipeline against `linting.dedupNlpAgainstCompliance` / `linting.dedupGrammarAgainstFindings`.
- `Range` creation against the live DOM using the TreeWalker / string-search approach (offset-aware to disambiguate repeated matches via the `targetOffset` hint in `createRangeForMatch`).
- Cursor-based tooltip detection: `selectionchange` + arrow keys.

### App-level CSS.highlights effect

One `useEffect([lintingState])` in `src/App.jsx` reads `linting.getRangesByTier(state)` and calls `CSS.highlights.set(name, new Highlight(...ranges))` per tier. Suspension flips via a separate `useEffect([complianceOpen])` that dispatches `linting.setSuspended` — when the Compliance panel is open, `isActive(state)` returns false and the next render empties every highlight group.

## Tooltip flow

`InlineTooltip.jsx` is the single tooltip surface for all three tiers. When the cursor lands inside a highlighted range, the hook calls a callback that App passes down; App renders the tooltip positioned near the cursor (same approach as `FloatingToolbar`).

- **Severity badge** + rule message (one line) + collapsible **Why?** with UFS citation.
- **Fix** button when `fixFn` is non-null. Fix application goes through `handleComplianceAcceptFix` in `App.jsx` so Track Changes integration is automatic (the per-keystroke TC intercept in PM's `dispatchTransaction` wraps the diff with `revisionAdd` / `revisionDel` marks when TC is on).
- **Offset-aware fixes:** `replaceAtOffset()` in `fix-utils.js` disambiguates duplicate violations. The tooltip passes `violation.index` as the fourth arg to `fixFn()` and the fix lands at the right occurrence even when the same word appears multiple times.
- Dismiss on: cursor moves out of the range, Escape, click outside.
- `FloatingToolbar` and `InlineTooltip` are mutually exclusive — tooltip only shows when the selection is collapsed.

## CSS

All three tiers use a yellow/orange/blue palette with background fallback for browsers that cannot render `text-decoration` on highlights:

```css
::highlight(compliance-error) { background-color: rgba(234, 179, 8, 0.25); }
::highlight(passive-voice)    { background-color: rgba(249, 115, 22, 0.2); }
::highlight(grammar-error)    { background-color: rgba(59, 130, 246, 0.15); }

@supports (text-decoration: underline wavy red) {
  ::highlight(compliance-error) { background: transparent; text-decoration: underline wavy #d97706; text-decoration-skip-ink: none; }
  ::highlight(passive-voice)    { background: transparent; text-decoration: underline wavy #ea580c; text-decoration-skip-ink: none; }
  ::highlight(grammar-error)    { background: transparent; text-decoration: underline wavy #3b82f6; text-decoration-skip-ink: none; }
}
```

Live styles are in `src/styles/editor.css`.

## Cross-cutting concerns

### Browser exfiltration prevention

All typing surfaces spread `{...NO_EXFIL_PROPS}` from `src/lib/no-exfil.js`. This disables `spellCheck`, `writingsuggestions` (Chrome "Help me write" / Edge Copilot), `autoComplete`, `autoCorrect`, `autoCapitalize`, and Grammarly's `data-gramm*`. CSP + `referrer="no-referrer"` + `notranslate` in `index.html` provide a second layer. Regression test at `src/lib/__tests__/no-exfil.test.js`.

PM blocks pass these as lowercase HTML attrs (`NO_EXFIL_PM_ATTRS` in `PmEditableBlock.jsx`) through `EditorProps.attributes`.

**Do not add a new contentEditable, input, or textarea that accepts spec text without spreading these props and updating the test surface list.**

### Compliance panel collision

When `CompliancePanel` is open, App dispatches `linting.setSuspended(state, true)`. `isActive(state)` returns false; `getRangesByTier(state)` returns empty groups; the next CSS.highlights effect run clears every named highlight. The panel's own active-group highlighting takes over via `CSS.highlights.set('compliance-active', ...)`.

### Note block exemption

Note blocks (`block.type === 'note'`) skip compliance and NLP because notes use advisory language by design. Grammar/spelling still runs.

### Focused-block scope

Only the focused block runs the linter. Findings persist across blur/focus inside `lintingState.byBlock`, so highlights survive switching between blocks without re-scanning. Linting all visible blocks on every edit was deliberately rejected to keep the perf budget tight.

### Toggle persistence

`secwriter-inline-linting` in `localStorage`. When the engineer re-enables linting, the focused block is linted immediately.

### Deferred rules

The four context-dependent rule IDs in `linting.DEFERRED_TO_PANEL` are filtered out by the hook before findings reach the reducer:

- `TERM-suitable`
- `TERM-any`
- `TERM-should`
- `VAGUE-applicable`

They still run in the Compliance panel's full scan (where the engineer is reviewing one example per group with batch accept).

### Bad-suggestion filtering

Harper suggestions that introduce spaces into single words (e.g., "taht" → "ta ht") are suppressed in `grammar-checker.js`. Oxford comma fixes append punctuation correctly.

## Performance characteristics

| Engine | Mode | Target |
|---|---|---|
| Static rules | sync, main thread | <5ms (measured ~0.3ms per block on real spec text) |
| compromise.js | sync, main thread (lazy-loaded) | <5ms per block |
| harper.js | async, Web Worker (lazy-loaded) | <10ms per document |

Total synchronous budget: <10ms on the main thread. Harper's async path adds latency but does not block typing.

Lazy-load triggers: first focus into a block actually fetches the modules. WASM init for harper takes a few seconds on first use; results appear from the next debounce onwards (no retroactive "pop-in" on the currently focused block).

## Corpus baseline (May 2026, harper.js 2.0)

| Engine | Recall | Notes |
|---|---|---|
| Static | 86.9% | FP rate 0.31% |
| NLP | 67.5% | |
| Grammar | 65.6% | Down from 78.4% under harper.js 1.12; 86% reduction in FPs on calibration corpus is the tradeoff |
| Adversarial accuracy | 92.7% | |

Full report: `corpus/results/REPORT.md`. New harper.js 2.0 lint kinds (`Typo`, `Usage`) are listed in `DISABLED_LINT_KINDS` in `grammar-checker.js`.

## Where to look in the code

| Concern | File |
|---|---|
| Reducer (state, verbs, selectors, dedup helpers, DEFERRED_TO_PANEL) | `src/lib/linting.js` |
| Per-block hook (debounce, async, DOM ranges, tooltip detection) | `src/components/useBlockLinting.js` |
| App.jsx `useEffect` that writes to `CSS.highlights` | `src/App.jsx` |
| Static rule engine | `src/lib/compliance-rules.js` |
| NLP engine | `src/lib/nlp-rules.js` |
| Grammar engine (Harper Worker wrapper) | `src/lib/grammar-checker.js` |
| Tooltip component | `src/components/InlineTooltip.jsx` |
| Browser exfiltration props | `src/lib/no-exfil.js` |
| Offset-aware fix utility | `src/lib/fix-utils.js` |
| CSS for highlight tiers | `src/styles/editor.css` |
| Tests | `src/lib/__tests__/linting.test.js`, `nlp-rules.test.js`, `grammar-checker.test.js` |

## Browser compatibility

CSS Custom Highlight API: Baseline since June 2025 (Chrome 105+, Edge 105+, Safari 17.2+, Firefox 132+).

**Firefox limitation:** Firefox cannot render `text-decoration` on highlights. The `background-color` fallback inside `::highlight()` blocks ensures highlights are still visible there.

**No pointer events on highlights** — tooltip interaction uses `selectionchange` events and `document.caretPositionFromPoint()` hit-testing against tracked ranges, not pointer events on the highlight itself.
