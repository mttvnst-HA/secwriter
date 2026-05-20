# ADR-0012: Inline linting via CSS Custom Highlight API + three engines

**Status:** Accepted
**Date:** 2026-05-19

## Context

SecWriter surfaces three classes of writing issues inline: (1) static UFS-1-300-02 rule violations (from [ADR-0011](0011-compliance-rule-engine.md)), (2) grammar/spelling via Harper.js, (3) passive-voice and indicative-mood patterns via compromise.js NLP. Pre-1f the highlights were injected as `<span class="lint-...">` elements inside `block.html`; under PM ([ADR-0006](0006-pm-substrate-migration.md), [ADR-0007](0007-single-pm-editor.md)) the EditorView re-renders the DOM on every doc change, so injected spans don't survive without ad-hoc coordination.

The CSS Custom Highlight API solves this: highlights bind to text Range objects, and the browser re-paints them when the DOM mutates. Zero DOM mutation, survives PM re-renders. The 3 engines run against a single block at a time (the focused block) to avoid scanning 300+ blocks on every edit.

## Decision

Real-time linting uses the CSS Custom Highlight API (zero DOM mutation) with three engines, organized as a pure-reducer module + per-block lifecycle hook + App-level highlight effect (same shape as TC ([ADR-0009](0009-track-changes-per-keystroke.md)), comments ([ADR-0010](0010-comments-reducer-dual-reconcile.md)), compliance ([ADR-0011](0011-compliance-rule-engine.md))):

- **`src/lib/linting.js`** — pure reducer over `{ enabled, suspended, byBlock: Map<blockId, { compliance, nlp, grammar, grammarText }> }`. Verbs (`createInitial / setEnabled / setSuspended / setBlockFindings / clearBlock / clearAll`), selectors (`isActive / isEnabled / isSuspended / getBlockFindings / getAllFindings / getBlockSeverity / getGrammarText / getRangesByTier`), pure dedup helpers (`dedupNlpAgainstCompliance`, `dedupGrammarAgainstFindings`), and the `DEFERRED_TO_PANEL` set. Range objects are *opaque* to the reducer — DOM-free, plain-Vitest testable.
- **`src/components/useBlockLinting.js`** — per-block hook that owns all DOM-bound and async effects: debounced lint cycle on input, lint on focus, lint on enable/un-suspend, sync static-rule + NLP pass, async Harper dispatch with stale detection, lazy-load triggers, the dedup pipeline against the reducer's helpers, Range creation against the live DOM, and the cursor-based tooltip detection (selectionchange + arrow keys).
- **App-level CSS.highlights effect** — single seam (`useEffect([lintingState])` in `src/App.jsx`) that mutates the global `CSS.highlights` registry by reading `linting.getRangesByTier(state)` and calling `CSS.highlights.set(name, new Highlight(...ranges))` per tier. Suspension flips via a separate `useEffect([complianceOpen])` that dispatches `linting.setSuspended`.

The three engines themselves:

1. **Static UFS rules** (`compliance-rules.js`): synchronous, <5ms. Yellow highlights. Shared with the compliance panel ([ADR-0011](0011-compliance-rule-engine.md)).
2. **Harper.js grammar** (`grammar-checker.js`): async via Web Worker (WASM). Lazy-loaded (~2-4MB). Blue highlights. Custom dictionary for engineering terms.
3. **compromise.js NLP** (`nlp-rules.js`): synchronous, lazy-loaded (~210KB). Passive voice via `(be + #PastTense)` patterns, indicative mood via regex. Orange highlights.

**Key design decisions:**
- **Browser exfiltration prevention:** All typing surfaces (contentEditable blocks + every spec/comment input/textarea) spread `{...NO_EXFIL_PROPS}` from `src/lib/no-exfil.js`. This disables `spellCheck`, `writingsuggestions` (Chrome "Help me write" / Edge Copilot), `autoComplete`, `autoCorrect`, `autoCapitalize`, and Grammarly's `data-gramm*`. CSP + `referrer="no-referrer"` + `notranslate` in `index.html` provide a second layer. Regression test at `src/lib/__tests__/no-exfil.test.js`. **Do not add a new contentEditable, input, or textarea that accepts spec text without spreading these props and updating the test surface list.**
- **Only the focused block is linted** — avoids scanning 300+ blocks on every edit. Findings persist across blur/focus inside `lintingState.byBlock`.
- **Offset-aware range creation:** `createRangeForMatch()` accepts a `targetOffset` hint to disambiguate repeated words.
- **De-duplication is in the reducer:** `dedupNlpAgainstCompliance` (compliance wins on overlap) and `dedupGrammarAgainstFindings` (grammar suppressed when >50% overlap with static or NLP — static rules win because they have UFS citations) are pure helpers, table-testable in `linting.test.js`.
- **Compliance panel collision:** When `CompliancePanel` is open, App dispatches `linting.setSuspended(state, true)`; `isActive(state)` returns false and `getRangesByTier` empties the highlights groups on the next render — no callback wiring through props.
- **Context-dependent deferral:** Rules producing false positives requiring sentence-level context (TERM-suitable, TERM-any, TERM-should, VAGUE-applicable) live in `linting.DEFERRED_TO_PANEL` and are filtered via `isDeferredRule` in the hook. They still run in the Compliance Panel on explicit full scan.
- **Stale result handling:** Grammar results tagged with text version; discarded if text changed while Worker was processing.
- **Bad suggestion filtering:** Harper suggestions that introduce spaces into single words (e.g., "taht" → "ta ht") are suppressed. Oxford comma fixes append punctuation.
- **Note block exemption:** Note blocks skip compliance and NLP (notes use advisory language). Grammar/spelling still runs.
- **Offset-aware fixes:** `replaceAtOffset()` in `fix-utils.js` disambiguates duplicate violations. Walks HTML tracking plain-text offsets (skipping `<...>`), collects candidates, picks closest to violation's `index`. `InlineTooltip.jsx` passes `violation.index` as the fourth arg to `fixFn()`. Falls back to first-match when offset is undefined.
- **Toggle persistence:** `secwriter-inline-linting` in localStorage. When re-enabled, the focused block is linted immediately.

## Consequences

- **Positive:**
  - **Zero DOM mutation.** Highlights survive PM EditorView re-renders without ad-hoc coordination.
  - **Per-block focused linting** — 300-block specs don't scan every block on every edit.
  - **Browser-exfiltration prevention** at the props layer — every typing surface that spreads `NO_EXFIL_PROPS` is automatically protected from Chrome "Help me write," Edge Copilot, Grammarly, etc.
  - **Tier de-dup in the reducer** — compliance wins over NLP, static wins over grammar. Pure helpers, table-testable.
- **Negative / cost:**
  - **Three engines = three highlight tiers in CSS** (`lint-static`, `lint-grammar`, `lint-nlp`). Adding a fourth tier means updating the dedup helpers + CSS + reducer's `getRangesByTier`.
  - **`DEFERRED_TO_PANEL` set** is a behavioral split — same rule, different surface (panel vs inline). Easy to forget when adding a new rule.
  - **Harper.js is ~2-4MB lazy-loaded** — first-use cold-start cost. Worth it for the recall, but the lazy-load trigger logic is non-trivial.
  - **Adversarial/calibration regression risk** — engine updates (e.g. harper.js 1.12 → 2.0) shift the precision/recall curves materially. See `corpus/results/REPORT.md` baseline.
- **Re-litigation risk:**
  - **"Why CSS Custom Highlight API instead of injected spans?"** PM re-render coordination became unmanageable. The highlight API binds to ranges that survive re-renders.
  - **"Why three engines instead of one?"** Different strengths: static rules have UFS citations and zero FP, grammar covers spelling and agreement, NLP covers passive/indicative. Trying to unify (e.g. all in LLM) would lose the citations + sub-5ms latency.
  - **"Why dedup in the reducer instead of in the engines?"** Dedup needs to see all three engines' findings together. The reducer is the natural seam.

## Alternatives considered

- **Single LLM-based linter.** Rejected — slow, no UFS citations, non-deterministic, and would still need browser-exfiltration safeguards. The three-engine approach gets sub-5ms static + offline grammar/NLP.
- **Inject highlight spans (pre-1f shape).** Rejected — PM re-render coordination was unmaintainable.
- **Lint all blocks continuously.** Rejected — 300-block specs would make every keystroke quadratic. Focused-block linting is the perf cap.
- **Dedup in each engine.** Rejected — would require each engine to see the others' findings. Reducer-level dedup is the natural seam.
