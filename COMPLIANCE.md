# Feature: Compliance Checker

## Overview

Two-tier specification language compliance checking: static rules catch mechanical violations instantly (no API), AI catches complex rewrites on demand. The user selects a scope (block, section, part, document), runs the check, and reviews proposed changes as inline diffs. Accepted changes are optionally tracked via Track Changes for audit trail.

## Authoritative Data Source

All compliance rules are derived from `src/data/ufs-1-300-02-rules.json`, which was extracted from the authoritative `reference/ufs_1_300_02.pdf` (UFS 1-300-02, "Unified Facilities Guide Specifications Format Standard", 22 September 2025).

The JSON contains:
- **122 rules** across 9 sections (requirements, prohibitions, recommendations)
- **35 prohibited terms** with replacements and source context (§2-4.4)
- **13 prohibited symbols** with replacements and exceptions (§2-4.4)
- **20 vague terms** to avoid (§2-4.4)
- **4 required capitalizations** (Contractor, Contracting Officer, Government, Contract) (§2-4.7)
- **2 colloquial terms** with correct replacements (§2-4.4)
- **3 redundant wording patterns** (§2-4.4)
- **21 required practices** (imperative mood, active voice, dual units, etc.)
- **11 submittal classifications** (SD-01 through SD-11)

**The rule engine reads this JSON at runtime.** Rules are NOT hardcoded in source code. When USACE publishes a new edition of UFS 1-300-02, re-extract the JSON from the updated PDF and the compliance checker automatically uses the new rules.

## Architecture

```
src/lib/
  compliance-rules.js      # Static rule engine — loads ufs-1-300-02-rules.json, generates regex patterns
  compliance-ai.js         # AI rewrite module (Anthropic API calls, with HTML preservation)
  compliance-checker.js    # Orchestrator: runs static rules first, AI on remainder, groups by type
  compliance.js            # Pure reducer — { scope, status, result, decisions, activeGroup, ai } + verbs/selectors
  compliance-ranges.js     # Pure walker — text-node + offset tuples for each violation match (drives CSS.highlights)

src/data/
  ufs-1-300-02-rules.json # Authoritative rule data extracted from UFS 1-300-02 PDF (65KB)

src/components/
  CompliancePanel.jsx      # Right-side panel: progressive summary, grouped findings, batch controls
  ComplianceSettings.jsx   # API key configuration modal (masked input, test connection)
```

The reducer + ranges walker were extracted in 2026 (see [ADR-0005](docs/adr/0005-storage-adapter-atomicity-per-backend.md) for the pure-reducer playbook this follows — same shape as `track-changes.js`, `comments.js`, `linting.js`). State lives in App; the panel reads via selectors and dispatches verbs.

## UX Design Principles

### Progressive Disclosure

Large compliance checks can return 50-100+ violations. Showing a flat list of 87 items is overwhelming and demoralizing. Instead, the panel uses **progressive disclosure**:

1. **Summary view** (default after check): Shows severity breakdown as a bar chart — "12 high-priority items need attention. 30 medium. 45 low (auto-fixable)."
2. **Default filter: High only.** The engineer sees the 12 items that matter most. Medium and low are accessible but not in their face.
3. **Auto-fix prompt:** "45 low-severity formatting items can be auto-fixed. [Apply all]" — one click clears the trivial stuff.
4. The engineer never sees "87 violations" as a scary number. They see "12 items to review" with a path to clear the rest automatically.

### Grouped Violations with Batch Accept

Violations are **grouped by rule type**, not listed individually by block order. This eliminates accept/reject fatigue:

```
┌─ "shall" (8 instances) ─────────────────┐
│ Example: "The Contractor shall provide   │
│ 24 inches of cover" → "Provide 24       │
│ inches of cover"                         │
│                                          │
│ [View All 8] [Accept All 8] [Reject All] │
└──────────────────────────────────────────┘
```

The engineer reviews **one representative example** per rule type, then applies the decision to all similar cases. Expanding "View All 8" shows individual instances with per-item accept/reject for edge cases.

### Context Preview (No Scroll Needed)

Each finding card shows the **surrounding sentence** directly in the panel, so the engineer can often decide without scrolling the editor:

```
┌─ TERM-001 ────────────────────────────────┐
│ "...cover over pipe. The Contractor shall │
│ provide a minimum of [600 mm] [24 inches] │
│ of cover over the top of the pipe..."     │
│                                  ▸ Why?   │
│ [Accept] [Reject]                         │
└───────────────────────────────────────────┘
```

Clicking the block location link scrolls the editor if the engineer wants full context. A **"Return ↩"** button appears to jump back to their previous scroll position.

### Authority Citation ("Why?")

Each finding card has a collapsible **"Why?"** section that shows the exact UFS 1-300-02 quote:

```
▾ Why?
  UFS 1-300-02 §2-4.4: "The use of 'shall' is prohibited.
  'Shall' imposes an obligation to act but may be confused
  with prediction of future action."
```

This surfaces the `context` field from `ufs-1-300-02-rules.json`. Engineers trust suggestions backed by cited authority.

### Batched AI Requests

The AI tier is presented as a **single batch operation**, not individual "AI Fix" buttons:

```
┌─ AI Rewrite Needed ──────────────────────┐
│ 7 violations require AI rewrite           │
│ (vague language, complex restructuring)  │
│                                           │
│ Estimated cost: ~1,200 tokens (~$0.004)  │
│ [Fix All 7 with AI]            [Skip AI] │
└───────────────────────────────────────────┘
```

One confirmation → one wait → review all 7 diffs. Individual "AI Fix" is available by expanding a group, but the default is batch.

### Undo Checkpoint for Batch Operations

Before applying any batch operation (Accept All, Auto-fix FMT, AI Fix All), the system pushes a **single undo checkpoint**. This means:
- "Undo compliance batch" (Ctrl+Z) restores ALL blocks to their pre-check state in one action
- The engineer never has to click Undo 30 times to revert a batch accept
- The undo checkpoint is labeled in the history: "Compliance: accepted 30 fixes"

### First-Run Onboarding

On first use (tracked via `localStorage`), a single tooltip appears:

> "The compliance checker reviews your spec against UFS 1-300-02 writing standards. Items are grouped by type — review one example, then apply to all similar cases. Red = required, amber = recommended, blue = formatting."

Shown once, dismissed on click, never shown again.

## Tier 1: Static Rules (No API)

### Data-Driven Rule Generation

At startup, `compliance-rules.js` reads `ufs-1-300-02-rules.json` and generates rule objects:

```js
import rulesData from '../data/ufs-1-300-02-rules.json';

function buildRules() {
  const rules = [];

  // Generate rules from prohibitedTerms
  rulesData.prohibitedTerms.forEach((entry, i) => {
    rules.push({
      id: `TERM-${String(i + 1).padStart(3, '0')}`,
      category: 'prohibited-term',
      severity: 'high',
      pattern: new RegExp(`\\b${escapeRegex(entry.term)}\\b`, 'gi'),
      message: entry.context,
      replacement: entry.replacement,
      ufsRef: `UFS 1-300-02 §${entry.section}`,
      fix: buildFixFunction(entry)
    });
  });

  // Generate rules from prohibitedSymbols
  rulesData.prohibitedSymbols.forEach((entry, i) => {
    rules.push({
      id: `SYM-${String(i + 1).padStart(3, '0')}`,
      category: 'prohibited-symbol',
      severity: 'medium',
      pattern: buildSymbolPattern(entry),
      message: `Replace "${entry.symbol}" (${entry.meaning}) with "${entry.replacement}"`,
      replacement: entry.replacement,
      exception: entry.exception,
      ufsRef: `UFS 1-300-02 §2-4.4`,
      fix: (text) => text.replace(entry.symbol, entry.replacement)
    });
  });

  // Generate rules from vagueTerms
  rulesData.vagueTerms.forEach((term, i) => {
    rules.push({
      id: `VAGUE-${String(i + 1).padStart(3, '0')}`,
      category: 'vague-language',
      severity: 'medium',
      pattern: new RegExp(`\\b${escapeRegex(term)}\\b`, 'gi'),
      message: `"${term}" is vague per UFS 1-300-02 §2-4.4. Use specific, measurable language.`,
      ufsRef: 'UFS 1-300-02 §2-4.4',
      fix: null  // Always needs AI or manual rewrite
    });
  });

  // Generate rules from requiredCapitalization
  rulesData.requiredCapitalization.forEach((entry) => {
    const lower = entry.term.toLowerCase();
    rules.push({
      id: `CAP-${entry.term.replace(/\s+/g, '')}`,
      category: 'capitalization',
      severity: 'low',
      pattern: new RegExp(`(?<=[.!?]\\s+|^)(?!${entry.term})\\b${escapeRegex(lower)}\\b`, 'g'),
      message: `${entry.rule}: "${entry.term}" per UFS 1-300-02 §${entry.section}`,
      ufsRef: `UFS 1-300-02 §${entry.section}`,
      fix: (text) => text.replace(new RegExp(`\\b${escapeRegex(lower)}\\b`, 'g'), entry.term)
    });
  });

  // Generate rules from colloquialTerms
  rulesData.colloquialTerms.forEach((entry) => {
    rules.push({
      id: `COLLOQ-${entry.term}`,
      category: 'terminology',
      severity: 'medium',
      pattern: new RegExp(`\\b${escapeRegex(entry.term)}\\b`, 'gi'),
      message: `Colloquial: use "${entry.correctTerm}" instead of "${entry.term}" per UFS 1-300-02 §${entry.section}`,
      ufsRef: `UFS 1-300-02 §${entry.section}`,
      fix: (text) => text.replace(new RegExp(`\\b${escapeRegex(entry.term)}\\b`, 'gi'), entry.correctTerm)
    });
  });

  // Generate rules from redundantWording
  rulesData.redundantWording.forEach((entry) => {
    rules.push({
      id: `REDUND-${entry.term.replace(/\s+/g, '-')}`,
      category: 'redundant-wording',
      severity: 'low',
      pattern: new RegExp(`\\b${escapeRegex(entry.term)}\\b`, 'gi'),
      message: `${entry.note} — consider removing "${entry.term}" per UFS 1-300-02 §${entry.section}`,
      ufsRef: `UFS 1-300-02 §${entry.section}`,
      fix: null  // Needs context to determine if removal is appropriate
    });
  });

  // Formatting rules (mechanical text transforms not in JSON)
  rules.push(
    { id: 'FMT-001', category: 'formatting', severity: 'low',
      pattern: /  +/g, message: 'Double spaces', ufsRef: 'UFS 1-300-02 §2-3',
      fix: (text) => text.replace(/  +/g, ' ') },
    { id: 'FMT-002', category: 'formatting', severity: 'low',
      pattern: /[\u2013\u2014]/g, message: 'Em/en-dash → hyphen', ufsRef: 'UFS 1-300-02 §2-3',
      fix: (text) => text.replace(/[\u2013\u2014]/g, '-') },
    { id: 'FMT-003', category: 'formatting', severity: 'low',
      pattern: /[\u201C\u201D\u2018\u2019]/g, message: 'Smart quotes → straight quotes', ufsRef: 'UFS 1-300-02 §2-3',
      fix: (text) => text.replace(/[\u201C\u201D]/g, '"').replace(/[\u2018\u2019]/g, "'") },
    { id: 'FMT-004', category: 'formatting', severity: 'low',
      pattern: /\bper cent\b/gi, message: '"per cent" → "percent"', ufsRef: 'UFS 1-300-02 §2-3',
      fix: (text) => text.replace(/\bper cent\b/gi, 'percent') }
  );

  return rules;
}
```

### Rule Categories (auto-generated from JSON)

| Category | Source in JSON | Count | Severity |
|----------|--------------|-------|----------|
| `prohibited-term` | `prohibitedTerms[]` | 35 | High |
| `prohibited-symbol` | `prohibitedSymbols[]` | 13 | Medium |
| `vague-language` | `vagueTerms[]` | 20 | Medium |
| `capitalization` | `requiredCapitalization[]` | 4 | Low |
| `terminology` | `colloquialTerms[]` | 2 | Medium |
| `redundant-wording` | `redundantWording[]` | 3 | Low |
| `formatting` | Hardcoded (4 rules) | 4 | Low |
| **Total static rules** | | **~81** | |

### Static Rule Behavior

- Rules run instantly when check is triggered (no API call needed)
- Violations are **grouped by rule type** in the panel (not listed individually by block order)
- Each group shows one representative example with "Accept All N / Reject All / View All" controls
- Simple fixes (all FMT rules, capitalization, colloquial terms, some prohibited terms) can be accepted per-group or in bulk
- Complex fixes where `fix` is null are collected into the "AI Rewrite Needed" batch at the bottom
- Auto-fixable formatting violations (FMT category) are offered as a one-click "Auto-fix formatting" action in the summary

## Tier 2: AI Rewrite (Anthropic API)

### When AI Is Used

- Static rule finds a violation but `fix` is null (sentence restructuring needed)
- User clicks "Fix All N with AI" in the AI batch section
- User expands a group and clicks "AI Fix" on an individual violation
- AI tier is **never called automatically** — always requires user action (cost control)

### HTML Preservation Strategy

**Critical:** AI models frequently mangle HTML. To prevent corruption of inline marks:

1. **Before sending to API:** Extract plain text from block HTML using `getVisibleText()`. Send only plain text to the API.
2. **API returns:** Plain text rewrites (no HTML).
3. **After receiving:** Use word-level diff between original plain text and proposed plain text. Map the diff operations back onto the original HTML, preserving all `<span class="mark-*">` tags that surround unchanged text. Only the changed text regions lose their marks (which the user can re-apply).
4. **Safety check:** Before applying any AI rewrite, verify that all inline mark spans from the original are present in the result. If marks were lost, warn the user: "This change will remove X inline marks. Accept anyway?"

### API Call Structure

```js
async function requestAIRewrite(blocks, violations, apiKey) {
  const chunks = chunkViolations(violations, MAX_TOKENS_PER_CHUNK);

  const results = [];
  for (const chunk of chunks) {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4096,
        system: COMPLIANCE_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: buildPrompt(chunk.blocks, chunk.violations) }]
      })
    });

    if (!response.ok) {
      throw new ComplianceAPIError(response.status, await response.text());
    }

    const data = await response.json();
    results.push(...parseAIResponse(data));
  }
  return results;
}
```

### AI System Prompt

The system prompt is dynamically built from `ufs-1-300-02-rules.json`, injecting the actual prohibited terms and required practices:

```js
function buildSystemPrompt() {
  const prohibited = rulesData.prohibitedTerms.map(t => `- "${t.term}": ${t.replacement}`).join('\n');
  const vague = rulesData.vagueTerms.map(t => `- "${t}"`).join('\n');

  return `You are a UFGS specification language compliance editor. Your job is to rewrite
construction specification text to comply with UFS 1-300-02.

PROHIBITED TERMS (replace or restructure):
${prohibited}

VAGUE TERMS (replace with specific, measurable language):
${vague}

Rules:
1. Convert all requirements to imperative mood (direct commands)
2. Remove prohibited terms — restructure sentences as needed
3. Remove "The Contractor" as sentence subject — use direct imperative verb
4. Convert passive voice to active: "Materials shall be placed" -> "Place materials"
5. Do NOT change technical meaning, quantities, tolerances, or standards references
6. Do NOT change bracketed items [like this] — they are tailoring choices
7. Preserve all paragraph structure and sentence boundaries
8. Do NOT add new requirements or remove existing ones
9. If a sentence is already compliant, return it unchanged

Respond as JSON:
{
  "rewrites": [
    { "blockId": "n42", "original": "...", "proposed": "...", "changes": ["description"] }
  ]
}`;
}
```

### Rate Limiting & Cost Control

- **Chunk size:** Max 20 blocks per API call (prevents timeout and token overflow)
- **Sequential calls:** Chunks processed sequentially to avoid rate limits
- **Token estimation:** Before calling API, estimate input tokens (~4 chars/token) and show user: "This will use approximately X tokens (~$Y). Proceed?"
- **Session counter:** Track total tokens used in the session, display in CompliancePanel footer
- **Abort:** User can cancel in-progress AI checks (AbortController on fetch)

### Fallback When No API Key

If the user has no API key configured:
- Static rules (Tier 1) work fully — all pattern-based violations are found and fixable
- AI-needing violations show: "This violation requires AI rewrite. Configure your Anthropic API key in Settings to enable AI-powered fixes."
- A "Configure API Key" link opens the ComplianceSettings modal
- The checker is still highly useful without API — ~60 of ~81 rules have static fixes

## Scope Selection

### How Scope Works

The scope determines which blocks are checked. The user selects scope via the CompliancePanel toolbar:

```js
function getBlocksInScope(blocks, scopeType, anchorBlockId) {
  switch (scopeType) {
    case 'block':
      return blocks.filter(b => b.id === anchorBlockId);

    case 'subsection':
      const headingIdx = blocks.findIndex(b => b.id === anchorBlockId);
      const heading = blocks[headingIdx];
      const result = [heading];
      for (let i = headingIdx + 1; i < blocks.length; i++) {
        if (blocks[i].type === 'title' && blocks[i].depth <= heading.depth) break;
        result.push(blocks[i]);
      }
      return result;

    case 'part':
      const partBlock = blocks.find(b => b.id === anchorBlockId);
      return blocks.filter(b => b.part === partBlock.part);

    case 'document':
      return blocks.filter(b => b.type !== 'pagebreak');
  }
}
```

### Scope Selection UI

- **CompliancePanel toolbar** has a dropdown: "Current Block" | "This Section" | "This Part" | "Entire Document"
- Scope auto-selects based on context: if a heading is focused, default is "This Section"
- "Run Check" button with scope label: "Check This Section" / "Check Entire Document"

### Keyboard Shortcuts

- `Ctrl+Shift+C` — Run compliance check on current block (quick single-block check)
- No document-wide shortcut (too easy to trigger accidentally with API costs)

## Applying Fixes

### How fixes reach the block

When the engineer clicks **Accept** (single item, group, or auto-fix all formatting), the panel computes the new HTML via the pure helpers in `compliance.js`:

- `computeItemFix(violation, blocks)` — single violation
- `computeGroupFixes(group, blocks)` — every instance of one rule
- `computeFormattingFixes(result, blocks)` — every FMT-* rule across the document

Each returns `[{ blockId, html }, ...]`. The panel then dispatches `Blocks.updateBlockHtml` (or the corresponding doc-wide verb) through the blocks reducer, which writes the new HTML through `setBlockHtml(yStore, blockId, html, origin)`. There is no diff-preview modal — the edit lands directly in the block and the engineer sees the result inline in the editor.

Decisions (accept/reject) are stored on the reducer state, not on block HTML, so reopening the panel after a check shows which groups have been actioned.

### Highlighting the active group

While a group card is selected in the panel, the editor highlights every instance of that rule's violations using the **CSS Custom Highlight API** — the same primitive that powers inline linting:

1. App's `useEffect([complianceOpen, complianceState.activeGroup, complianceState.result, blocks])` reads the active group's violations.
2. `compliance-ranges.js` walks the block text nodes and returns `(textNode, startOffset, endOffset)` tuples for each match. The walker is word-boundary aware and skips text inside `<del class="mark-del">`.
3. App builds `Range` objects from the tuples and registers them via `CSS.highlights.set('compliance-active', new Highlight(...ranges))`.

This replaced the earlier `<span class="compliance-highlight">` injection model (sub-PR 1f, #47) so highlights survive PM `EditorView` re-renders without ad-hoc DOM coordination. Selecting a different group rebuilds the highlight set; closing the panel clears it.

### Track Changes integration is automatic

Track Changes is now applied **per-keystroke via PM's `dispatchTransaction` intercept** (sub-PR 1h). When a compliance accept lands new HTML in a block via `setBlockHtml`, PM's `ySyncPlugin` writes the Yjs op and the next PM render shows the result. If TC is on, the `rewriteForTrackChanges` pass in `dispatchTransaction` wraps the diff with `revisionAdd` / `revisionDel` marks automatically — the compliance code itself never has to know whether TC is on or off.

The pre-1h snapshot-baseline model that compliance had to coordinate with is retired. See the "Track Changes Architecture" section of `CLAUDE.md` for the current semantics.

### Single undo frame for batch operations

The three multi-write gestures — `handleAcceptAll` equivalents for groups, formatting auto-fix, AI-rewrite-all — wrap their N `setBlockHtml` writes in `framing.withUndoFrame(() => { … })`. The Yjs UndoManager then captures all N writes as one frame regardless of `captureTimeout`, so one Ctrl+Z reverts the entire batch. Individual accept operations rely on the normal word-grain undo behavior. See the "Blocks Reducer Architecture" section of `CLAUDE.md` for `withUndoFrame` semantics.

## Compliance Panel (Right Side)

The CompliancePanel replaces the comment panel when active (same right-side slot):

### Panel Layout

```
┌─────────────────────────────────────────┐
│  Compliance Check                       │
│  ───────────────────────────────────── │
│  Scope: [This Section ▼]  [Run Check]  │
│                                          │
│  ┌─ Summary ────────────────────────┐   │
│  │ ██████████░░░░░░░░░░░░░░░░░░░░   │   │
│  │ 12 high  ·  30 medium  ·  45 low │   │
│  │                                   │   │
│  │ [Auto-fix 45 formatting items]   │   │
│  └───────────────────────────────────┘   │
│                                          │
│  Showing: High ▼                         │
│                                          │
│  ┌─ "shall" (8 instances) ───────────┐  │
│  │ "...pipe. The Contractor shall    │  │
│  │ provide a minimum of [600 mm]     │  │
│  │ [24 inches] of cover..."          │  │
│  │                         ▸ Why?    │  │
│  │ [Accept All 8] [Reject All]       │  │
│  │ [View All 8 ▸]                    │  │
│  └───────────────────────────────────┘  │
│  ┌─ "is required to" (2 instances) ──┐  │
│  │ "...The Contractor is required to │  │
│  │ submit test reports..."           │  │
│  │                         ▸ Why?    │  │
│  │ [Accept All 2] [Reject All]       │  │
│  └───────────────────────────────────┘  │
│  ┌─ "etc." (1 instance) ─────────────┐  │
│  │ "...gravel, sand, etc."           │  │
│  │                         ▸ Why?    │  │
│  │ [Accept] [Reject]                 │  │
│  └───────────────────────────────────┘  │
│                                          │
│  ┌─ AI Rewrite Needed ──────────────┐   │
│  │ 7 violations need AI rewrite      │   │
│  │ (vague language, complex cases)   │   │
│  │ Est: ~1,200 tokens (~$0.004)     │   │
│  │ [Fix All 7 with AI]    [Skip AI] │   │
│  └───────────────────────────────────┘   │
│                                          │
│  ─────────────────────────────────────  │
│  Session: ~2,400 tokens ($0.007)        │
│  [Settings ⚙]                           │
└─────────────────────────────────────────┘
```

### Panel Behavior

- **Default view after check:** Summary bar + "High" filter active. Low-severity items are hidden until the engineer expands the filter.
- **Grouped findings:** Violations with the same rule ID are collapsed into one card with instance count, representative example, and batch accept/reject.
- **Context in card:** Each card shows the surrounding sentence (±10 words around the violation) so the engineer can decide without scrolling.
- **"Why?" toggle:** Collapsible section showing the exact UFS 1-300-02 quote from the JSON `context` field.
- **"View All N":** Expands the group to show individual instances with per-item accept/reject for edge cases.
- Clicking a finding's block location scrolls the editor (with "Return ↩" button for getting back).
- Accepted groups show with a green checkmark and are dimmed.
- Rejected groups show with a red X and are dimmed.
- **AI batch:** All AI-needing violations are collected into one section at the bottom with a single "Fix All with AI" button and cost estimate.

### First-Run Onboarding

On first use (tracked via `localStorage.getItem('sim-compliance-onboarded')`):

A tooltip appears over the panel:

> "The compliance checker reviews your spec against UFS 1-300-02 writing standards. Items are grouped by type — review one example, then apply to all similar cases. Red = required changes, amber = recommended, blue = formatting (auto-fixable)."

Dismissed on click. Never shown again.

## API Key Management

### Storage

```js
const STORAGE_KEY = 'sim-anthropic-api-key';

function getApiKey() {
  return localStorage.getItem(STORAGE_KEY);
}

function setApiKey(key) {
  localStorage.setItem(STORAGE_KEY, key);
}

function clearApiKey() {
  localStorage.removeItem(STORAGE_KEY);
}
```

### Settings Modal (ComplianceSettings.jsx)

- **API Key** — password-masked input field
- **Test Connection** — sends a minimal API call to verify the key works
- **Clear Key** — removes from localStorage
- **Warning text:** "Your API key is stored in your browser's local storage. Do not use this on a shared or public computer."
- **Model selection** — dropdown: claude-sonnet-4-20250514 (default), claude-haiku (faster/cheaper)
- **Session usage** — tokens used, estimated cost

## Implementation Order

1. **Static rule engine** (`compliance-rules.js`) — loads `ufs-1-300-02-rules.json`, generates ~81 rule objects with patterns and fix functions
2. **Compliance checker orchestrator** (`compliance-checker.js`) — runs rules against block scope, collects violations, **groups by rule type**, computes severity stats
3. **CompliancePanel** — right-side panel with **progressive summary view**, severity filter (default: High), **grouped findings with batch accept/reject**, context preview, "Why?" toggle, "Return ↩" scroll button
4. **CSS Custom Highlight integration** — `compliance-ranges.js` walks block text nodes for the active group; App registers `CSS.highlights.set('compliance-active', ...)`
5. **Accept/reject flow** — apply fixes directly to block HTML via `setBlockHtml` + the blocks reducer. **Batch operations wrap N writes in a single `withUndoFrame` so one Ctrl+Z reverts the batch.** TC integration is automatic through PM's per-keystroke `dispatchTransaction` intercept.
6. **First-run onboarding** — tooltip on first panel open, localStorage flag
7. **Unit tests** — rule engine tests (pattern matching, fix functions, grouping), checker tests, diff tests, undo checkpoint tests
8. **E2E tests** — run check on sample data, verify grouped findings, batch accept, individual accept/reject, undo batch, first-run tooltip
9. **API key settings** (`ComplianceSettings.jsx`) — storage, test connection, model selection
10. **AI rewrite module** (`compliance-ai.js`) — API calls with chunking, HTML preservation, abort
11. **AI integration in panel** — **batch "Fix All with AI"** button, progress indicator, token counter, cost confirmation

Steps 1–8 deliver a fully functional static-only compliance checker with polished UX. Steps 9–11 add the AI tier.

## Updating Rules

When USACE publishes a new edition of UFS 1-300-02:

1. Place the new PDF in `reference/ufs_1_300_02.pdf` (replace the old one)
2. Re-run the extraction script to regenerate `src/data/ufs-1-300-02-rules.json`
3. The compliance checker automatically picks up the new rules — no code changes needed
4. Review the extraction output for any new rule categories that may need new fix functions

The raw text extraction is preserved at `reference/ufs_1_300_02_text.txt` for reference.

## Example Walkthrough

1. Engineer opens UFGS 31 00 00, navigates to Part 3 EXECUTION
2. Opens the Compliance panel (toolbar button), selects scope "This Part"
3. **First time only:** tooltip explains severity colors and grouped workflow
4. Clicks "Run Check"
5. Static rules run instantly (~50ms): finds 87 violations total
6. **Summary bar shows:** "12 high · 30 medium · 45 low" with progress bar
7. **Auto-fix prompt:** "45 formatting items can be auto-fixed. [Apply all]" → engineer clicks → 45 items cleared in one action, **single undo checkpoint pushed**
8. **Default filter: High.** Engineer sees 12 items grouped into 4 cards:
   - "shall" (8 instances) — reviews the example, clicks "Accept All 8"
   - "is required to" (2 instances) — reviews, clicks "Accept All 2"
   - "etc." (1 instance) — clicks "Reject" (the "etc." is intentional here)
   - "per" (1 instance) — clicks "Accept"
9. Switches filter to "Medium": sees 7 vague language items, all needing AI
10. **AI batch section:** "7 violations need AI rewrite. ~1,200 tokens (~$0.004). [Fix All 7 with AI]"
11. Clicks "Fix All 7" → progress spinner → 3 seconds → all 7 diffs appear
12. Reviews grouped AI results: accepts 5, rejects 2
13. With Track Changes on, accepted changes appear as green additions / red deletions
14. **Final summary:** "87 violations found: 56 accepted, 3 rejected, 45 auto-fixed, 7 AI-rewritten (5 accepted, 2 rejected)"
15. Engineer realizes the "shall" batch was too aggressive → **Ctrl+Z** → all 8 reverted in one action
