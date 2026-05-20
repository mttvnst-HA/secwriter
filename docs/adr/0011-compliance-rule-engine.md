# ADR-0011: Compliance checker — data-driven rule engine with two-tier (regex + AI) evaluation

**Status:** Accepted
**Date:** 2026-05-19

## Context

UFS 1-300-02 defines the writing standards for UFGS specifications: prohibited terms (e.g. "shall be subject to"), vague terms (e.g. "as required"), prohibited symbols, required capitalizations, and so on. USACE publishes updates to this standard; SecWriter must surface violations without requiring a code change every time the standard evolves.

ADR-0003 established "compliance rules live in JSON, not source code." This ADR documents the two-tier engine that consumes that JSON, the reducer that owns the panel's state, and the highlight pipeline that surfaces violations in the editor.

## Decision

Data-driven rule engine with two tiers:

1. **`ufs-1-300-02-rules.json`** — authoritative rule data extracted from `reference/ufs_1_300_02.pdf`. 36 prohibited terms, 13 prohibited symbols, 21 vague terms, 4 required capitalizations, plus colloquial/redundant/required-practice categories. **Rules are NOT hardcoded in source code.** `buildRules()` derives the runtime rule list from these categories. See [ADR-0003](0003-compliance-rules-as-data.md).
2. **`compliance-rules.js`** reads the JSON at startup and generates ~81 rule objects via `buildRules()`. Each rule: id, category, severity, regex, message, UFS reference, optional `fix()`. Rules with `fix === null` defer to AI tier. Uses **binary search** for bracket exclusion.
3. **`compliance-checker.js`** runs rules against scoped blocks, groups by rule ID, computes stats. Excludes note blocks, bracket content, hidden ENG/MET. Enforces **violation budget** (`MAX_VIOLATIONS = 2000`); returns `truncated: true` when capped.
4. **`compliance-ai.js`** (Tier 2): builds system prompt dynamically from the JSON, chunks large requests (20 blocks max per API call), estimates token cost, supports abort via AbortController.
5. **`CompliancePanel.jsx`** — UI shell. Progressive UX: summary bar → grouped findings → batch accept/reject → AI batch.
6. **`compliance.js`** — pure reducer over `{ scope, status, result, decisions, activeGroup, ai }` per the opaque-state-plus-selectors playbook (see also [ADR-0009](0009-track-changes-per-keystroke.md), [ADR-0010](0010-comments-reducer-dual-reconcile.md), [ADR-0012](0012-inline-linting-css-highlights.md)). State lives in App; the panel reads via selectors and dispatches verbs (`setScope`, `startCheck`, `setResult`, `acceptGroup`/`rejectGroup`/`acceptItem`/`rejectItem`/`markGroupsAccepted`, `setActiveGroup`, AI lifecycle: `aiStart`/`aiProgress`/`aiSuccess`/`aiError`/`aiAbort`/`aiClearError`). Local-only — no `publish` envelopes; the local edits from accepting fixes flow through the existing `setBlocks` path. Five property-tested invariants: `setResult` clears decisions and `activeGroup` (I1); decisions ⊆ result keys (I2/I3); `activeGroup` ∈ result keys ∪ {null} (I4); AI status stays in `{idle, running, error}` and `sessionTokens` is monotone (I5). Pure fix-computation helpers `computeItemFix` / `computeGroupFixes` / `computeFormattingFixes` extracted from the panel's accept handlers — testable without rendering React.
7. **`compliance-ranges.js`** — pure walker that returns text-node + offset tuples for each violation match. Word-boundary aware; skips text inside `<del class="mark-del">`. The App-level `useEffect([complianceOpen, complianceState.activeGroup, complianceState.result, blocks])` builds `Range` objects and pushes them through the CSS Custom Highlight API as `CSS.highlights.set('compliance-active', new Highlight(...))` — same primitive linting uses ([ADR-0012](0012-inline-linting-css-highlights.md)). Sub-PR 1f ([#47](https://github.com/mttvnst-HA/secwriter/issues/47)) replaced the previous `<span class="compliance-highlight">` injection model so highlights survive PM EditorView re-renders without ad-hoc DOM coordination.
8. **Updating rules:** When USACE publishes a new edition, re-extract the JSON from the PDF. No code changes needed.

**Perf:** lazy fix computation (store `fixFn` reference, don't eagerly compute fix text during scanning); binary search on sorted bracket ranges (O(log m) per match); 2000-violation cap.

## Consequences

- **Positive:**
  - **JSON-driven rules** ([ADR-0003](0003-compliance-rules-as-data.md)) — UFS updates require no code changes.
  - **CSS Custom Highlight API** for highlights ([ADR-0012](0012-inline-linting-css-highlights.md)) — survives PM re-renders without DOM mutation.
  - **AI tier is opt-in** — Tier 1 (regex) covers most rules deterministically; Tier 2 (AI) handles rules where `fix === null`.
  - **Reducer + property tests** — five invariants codify the panel's state machine; refactors can't silently break the transitions.
- **Negative / cost:**
  - **Two-tier engine** = two places to look for "why is this violation flagged / unflagged" — Tier 1's regex or Tier 2's prompt.
  - **`MAX_VIOLATIONS = 2000`** is a hard cap; very dirty specs return `truncated: true` and the user has to fix-and-rescan in batches.
  - **Binary search on bracket ranges** requires the range list be sorted; the rule-engine maintainer must keep that invariant.
- **Re-litigation risk:**
  - **"Why not hardcode rules in source?"** USACE updates the standard. Hardcoding means a code change + deploy per edition; JSON means an update + re-extract. See [ADR-0003](0003-compliance-rules-as-data.md).
  - **"Why a separate AI tier instead of LLM-only?"** Tier 1 is deterministic, free, sub-5ms. Tier 2 is for the long tail. Most violations resolve at Tier 1; routing them through an LLM would be slower and unnecessarily expensive.
  - **"Why CSS Custom Highlight API instead of injected spans?"** PM EditorView re-renders the DOM on every doc change. Injected spans would have to be re-applied after every render; the highlight API binds to text ranges that survive re-renders.

## Alternatives considered

- **Hardcoded rules in JS.** Rejected per [ADR-0003](0003-compliance-rules-as-data.md).
- **Single-tier (LLM-only).** Rejected — Tier 1 covers ~80% of violations deterministically. LLM-only would be slower and have non-deterministic results for cases the regex already handles correctly.
- **Eager fix computation.** Rejected — most violations are dismissed without accepting the fix; computing fix text up front wastes work proportional to violation count.
- **Inject `<span class="compliance-highlight">` (pre-1f shape).** Rejected — PM re-render coordination became unmanageable; CSS Custom Highlight API replaced it.
