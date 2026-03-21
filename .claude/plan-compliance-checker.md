# Implementation Plan: Compliance Checker

## Summary

Build a two-tier specification compliance checker per COMPLIANCE.md. Static rules (Tier 1) are auto-generated from `src/data/ufs-1-300-02-rules.json` and run instantly. AI rewrites (Tier 2) use the Anthropic API for complex sentence restructuring. Results presented with progressive disclosure, grouped by rule type with batch accept/reject, context previews, and single-action undo for batch operations. Track Changes integration for audit trail.

## Dependencies

- Existing: `text-diff.js` (diffWords), `revisions.js` (accept/reject), `useUndoableBlocks.js` (undo checkpoints), editor.css (dark mode vars)
- Data: `src/data/ufs-1-300-02-rules.json` (extracted from `reference/ufs_1_300_02.pdf`)
- New: Anthropic API (fetch-based, no SDK needed — browser direct access)

## Implementation Steps

### Step 1: Static Rule Engine
**Files:** `src/lib/compliance-rules.js`
**Tests:** `src/lib/__tests__/compliance-rules.test.js`

- Import `ufs-1-300-02-rules.json` and auto-generate ~81 rule objects at startup via `buildRules()`
- Rule categories generated from JSON arrays:
  - `prohibitedTerms[]` → 35 `TERM-xxx` rules (severity: high)
  - `prohibitedSymbols[]` → 13 `SYM-xxx` rules (severity: medium)
  - `vagueTerms[]` → 20 `VAGUE-xxx` rules (severity: medium, fix: null → AI tier)
  - `requiredCapitalization[]` → 4 `CAP-xxx` rules (severity: low)
  - `colloquialTerms[]` → 2 `COLLOQ-xxx` rules (severity: medium)
  - `redundantWording[]` → 3 `REDUND-xxx` rules (severity: low, fix: null → AI tier)
  - 4 hardcoded `FMT-xxx` rules for mechanical text transforms
- Each rule has: `{ id, category, severity, pattern, message, ufsRef, replacement, fix }`
- `fix()` returns corrected text for simple patterns, null for complex cases needing AI
- Export `buildRules()` → rule array, `runStaticRules(plainText, blockId, rules)` → violation array
- **Tests:** Pattern matching for prohibited terms, fix function correctness, null returns for vague terms, no false positives on compliant text, symbol exception handling.

**Run tests after this step.**

### Step 2: Compliance Checker Orchestrator with Grouping
**Files:** `src/lib/compliance-checker.js`
**Tests:** `src/lib/__tests__/compliance-checker.test.js`

- Export `checkCompliance(blocks, scopeType, anchorBlockId)` → `{ violations, groups, stats }`
- `getBlocksInScope(blocks, scopeType, anchorBlockId)` — block/subsection/part/document scope
- Strip HTML from block content before running rules (reuse `getVisibleTextFromHtml`)
- **Group violations by rule ID** → `groups: Map<ruleId, { rule, instances: violation[] }>`
  - Each group has: rule metadata, instance count, representative example (first instance with ±10 words context)
  - Groups sorted: high severity first, then by instance count descending
- Compute stats: `{ total, high, medium, low, autoFixable, needsAI }`
- Skip non-text blocks (tables, refs, pagebreaks, titles)
- Exclude text inside brackets `[...]` from rule matching (tailoring choices are exempt)
- Exclude text inside NOTE blocks from imperative mood rules (notes use advisory language)
- **Extract context snippet** for each violation: ±10 words around the match for panel preview
- **Tests:** Scope selection, violation grouping correctness, stats computation, context extraction, bracket exclusion, note block exclusion.

**Run tests after this step.**

### Step 3: Compliance Diff Module
**Files:** `src/lib/compliance-diff.js`
**Tests:** (covered by existing text-diff.test.js patterns)

- Export `computeComplianceDiff(originalText, proposedText)` → `[{ type: 'keep'|'del'|'add', text }]`
- Wraps existing `diffWords()` from text-diff.js
- Handles edge case: if proposed === original, return empty diff (no change needed)

**Run tests after this step.**

### Step 4: CompliancePanel Component with Progressive UX
**Files:** `src/components/CompliancePanel.jsx`
**CSS:** Add compliance styles to `src/styles/editor.css`

- Right-side panel (reuses the same slot as comment panel — only one active at a time)
- **Progressive summary view** (default after check):
  - Severity bar chart: "12 high · 30 medium · 45 low"
  - "Auto-fix N formatting items" button (one-click for all FMT-category fixes)
  - Default filter: **High only** (medium/low accessible via dropdown)
- **Grouped findings cards:**
  - Each card: rule ID, instance count, representative context snippet (±10 words), severity badge
  - "Accept All N" / "Reject All" / "View All N ▸" per group
  - Expanding "View All" shows individual instances with per-item accept/reject
- **"Why?" toggle** on each card: collapsible section showing UFS 1-300-02 quote from JSON `context` field
- **Context preview** in card: surrounding sentence so engineer can decide without scrolling
- Click block location link → scrolls editor + shows **"Return ↩"** floating button (auto-dismisses after 10s)
- **AI batch section** at bottom: "N violations need AI rewrite. Est: ~X tokens (~$Y). [Fix All with AI] [Skip AI]"
- Severity filter dropdown: All / High / Medium / Low
- Stats bar and session token counter in footer
- Wire into App.jsx: `complianceOpen` state, toolbar toggle button

**Run tests after this step.**

### Step 5: Inline Diff Rendering
**Files:** `src/components/ComplianceDiff.jsx`, modifications to `EditableBlock.jsx`

- When a block has a pending compliance fix, overlay the diff view on the block content
- Diff spans: `.cdiff-del` (red strikethrough), `.cdiff-add` (green underline)
- Per-block accept (✓) / reject (✗) buttons in the left gutter (same pattern as TC gutter buttons)
- On accept: replace block HTML with the proposed text. If TC is on, apply as tracked revision.
- On reject: dismiss the diff, restore original view.
- CSS custom properties for dark mode compatibility.

**Run tests after this step.**

### Step 6: Accept/Reject Flow + Undo Checkpoints + TC Integration
**Files:** Modifications to `src/App.jsx`, `src/lib/useUndoableBlocks.js`

- `handleComplianceAccept(blockId, proposedHtml)` — updates block content
- If `trackChanges` is on: apply the change through the TC pipeline (diff-on-blur creates revision marks)
- If TC is off: direct content replacement
- **Batch undo checkpoints:**
  - Before any batch operation (Accept All in group, Auto-fix FMT, AI Fix All), push a **single labeled undo checkpoint** (e.g., "Compliance: accepted 8 'shall' fixes")
  - Ctrl+Z after batch reverts ALL changes from that batch in one action
  - Individual accept/reject use normal per-action undo
  - Add `pushCheckpoint(label)` method to `useUndoableBlocks` if not already present
- Update violation/group status in CompliancePanel (mark as accepted/rejected/dimmed)
- Keyboard: Ctrl+Shift+C triggers check on focused block
- **"Return ↩" scroll button:** After scrolling to a finding, show a floating button to return to previous scroll position. Auto-dismiss after 10 seconds or on manual scroll.

**Run tests after this step.**

### Step 7: First-Run Onboarding
**Files:** Modifications to `CompliancePanel.jsx`

- On first panel open (`!localStorage.getItem('sim-compliance-onboarded')`):
  - Show tooltip over the panel explaining severity colors and grouped workflow
  - "The compliance checker reviews your spec against UFS 1-300-02 writing standards. Items are grouped by type — review one example, then apply to all similar cases. Red = required changes, amber = recommended, blue = formatting (auto-fixable)."
  - Dismissed on click → sets localStorage flag → never shown again

**Run tests after this step.**

### Step 8: Unit + E2E Tests for Static Tier
**Files:** `src/lib/__tests__/compliance-rules.test.js`, `src/lib/__tests__/compliance-checker.test.js`, `tests/e2e/editor.spec.js` (new test section)

- **Unit tests:**
  - Rule generation from JSON (verify count matches JSON array lengths)
  - Pattern matching per category (prohibited terms, symbols, vague, caps, colloquial, redundant, formatting)
  - Fix function correctness per category
  - Grouping logic (violations with same ruleId grouped, sorted by severity then count)
  - Context extraction (±10 words around match)
  - Bracket exclusion, note block exclusion
  - Undo checkpoint creation for batch operations
- **E2E tests:**
  - Open app → toggle compliance panel → verify panel opens
  - Run check → verify summary bar shows severity counts
  - Verify default filter is "High" → only high-severity groups visible
  - Click "Auto-fix formatting" → verify formatting violations cleared
  - Accept All in a group → verify all instances updated in editor
  - Reject a group → verify content unchanged
  - Undo batch (Ctrl+Z) → verify all changes from batch reverted
  - Click finding → verify editor scrolls to block + "Return" button appears
  - Expand "Why?" → verify UFS quote appears
  - First-run tooltip appears on first open, not on second open

**Run all tests (unit + E2E) after this step.**

### Step 9: API Key Settings
**Files:** `src/components/ComplianceSettings.jsx`, modifications to `src/App.jsx`

- Settings modal: API key input (password-masked), test connection button, model dropdown, clear button
- localStorage storage with warning about shared computers
- "Configure API Key" link in CompliancePanel when AI features are needed but no key is set
- Session token counter (displayed in panel footer)

**Run tests after this step.**

### Step 10: AI Rewrite Module
**Files:** `src/lib/compliance-ai.js`
**Tests:** `src/lib/__tests__/compliance-ai.test.js`

- `requestAIRewrite(blocks, violations, apiKey, options)` → `[{ blockId, original, proposed, changes }]`
- System prompt dynamically built from `ufs-1-300-02-rules.json` (injects all prohibited terms + vague terms)
- Chunking: max 20 blocks per API call
- Token estimation before calling (show user estimated cost)
- AbortController support for cancellation
- HTML preservation: send plain text, receive plain text, map diffs back onto HTML
- Error handling: invalid key, rate limit, timeout, malformed response
- **Tests:** Mock fetch for API responses, system prompt generation, chunking logic, error handling, HTML preservation verification

**Run tests after this step.**

### Step 11: AI Integration in Panel
**Files:** Modifications to `CompliancePanel.jsx`, `ComplianceDiff.jsx`

- **Batch "Fix All N with AI"** button in AI section (not individual per-violation buttons)
- Single cost confirmation dialog before batch API call
- Progress indicator: spinner + "Processing block X of Y..."
- Cancel button during AI processing
- After AI returns: violations are grouped and shown with same grouped UX as static fixes
- Individual "AI Fix" available by expanding a group (for one-off fixes)
- Token usage display in panel footer
- **Undo checkpoint** pushed before applying AI batch results

**Run all tests (unit + E2E) after this step.**

## Test Strategy

| Step | Unit Tests | E2E Tests | Total New |
|------|-----------|-----------|-----------|
| 1 | ~35 (rule generation from JSON + fix functions per category) | — | 35 |
| 2 | ~15 (scope, grouping, stats, context extraction, bracket/note exclusion) | — | 15 |
| 3 | ~5 (diff computation) | — | 5 |
| 4 | — | ~6 (panel open, summary view, filter, grouped cards, context preview) | 6 |
| 5 | — | ~3 (diff rendering, accept/reject buttons) | 3 |
| 6 | ~3 (undo checkpoint creation) | ~5 (batch accept, batch undo, TC integration, return button) | 8 |
| 7 | — | ~2 (first-run tooltip appears then doesn't) | 2 |
| 8 | (consolidation of steps 1–7) | (consolidation) | — |
| 9 | ~3 (storage, key validation) | ~2 (settings modal) | 5 |
| 10 | ~10 (API mock, system prompt generation, chunking, errors) | — | 10 |
| 11 | — | ~4 (AI batch button, progress, cancel, batch undo) | 4 |
| **Total** | **~71** | **~22** | **~93** |

## Estimated Scope

- ~9 new files (4 lib, 4 components, 1 onboarding util)
- ~2,800 lines of new code (increased from 2,200 for UX features)
- ~93 new tests (increased from 82 for UX behavior tests)
- Steps 1–8: Fully functional static compliance checker with polished UX (~81 data-driven rules, grouped findings, batch operations, undo checkpoints, progressive disclosure, context previews, authority citations, onboarding)
- Steps 9–11: AI tier adds complex rewriting with batched workflow

## Risks

| Risk | Mitigation |
|------|-----------|
| AI mangles inline HTML marks | Plain text in/out strategy + mark preservation check |
| Large documents hit API token limits | Chunking (20 blocks max per call) + cost confirmation |
| False positives on compliant text | Bracket exclusion, note block exclusion, extensive unit tests per rule category |
| User confusion between compliance diff and TC diff | Different colors (compliance: green/red backgrounds, TC: green underline / red strikethrough) + clear panel labels |
| JSON data incomplete or inaccurate | Cross-reference against `reference/ufs_1_300_02.pdf` during testing; update JSON extraction if gaps found |
| New UFS edition changes rules | JSON-only update path — re-extract from new PDF, no code changes needed |
| Overwhelming violation count | Progressive disclosure (summary → high-only default → auto-fix low), grouped by type not by block |
| Accept/reject fatigue | Batch accept per rule group — review one example, apply to all. Individual review available but not default. |
| Context loss during review | Context snippet in panel cards (no scroll needed for most decisions) + "Return ↩" button after scrolling |
| No undo for batch operations | Single undo checkpoint pushed before any batch apply. Ctrl+Z reverts entire batch. |
