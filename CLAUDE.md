# SecWriter

A modern web-based editor for UFGS (Unified Facilities Guide Specifications) .SEC files, replacing the legacy SpecsIntact desktop application (SIEditor).

**Terminology:** "SecWriter" = this web app (previously called "SpecsIntact Modern" / "SIM"; renamed to comply with the legacy SpecsIntact EULA). "SpecsIntact" / "SIEditor" = the legacy Windows desktop application — that name refers only to the legacy product, never to this app.

## Project Context

**What this is:** A rich text editor that reads and writes SpecsIntact .SEC files (XML-based SGML, windows-1252 encoding, used by the U.S. military for construction specifications). The editor feels like Google Docs or Notion while preserving the underlying SGML structure.

**Who it's for:** Engineers (especially geotechnical) who currently use MS Word as a workaround because SpecsIntact's tag-based editing is too clunky. The tool eliminates the Word-to-SpecsIntact round-trip workflow.

**Key design principle:** The engineer should never think about tags or SGML. Enter creates a paragraph. `/` opens a block type menu. Tab promotes/demotes headings. The SGML structure is inferred from context, not selected from a toolbar.

## Orientation

- `src/App.jsx` — main editor layout, state, toolbar, sidebar
- `src/components/` — block components (EditableBlock, TitleBlock, TableBlock, RefBlock), panels (CompliancePanel, CrossRefPanel, CommentPopup), tooltips, wizards
- `src/lib/` — parsers/serializers (sec-parser, sec-serializer, encoding), compliance engines (compliance-rules, compliance-checker, compliance-ai, inline-linter, grammar-checker, nlp-rules), revisions, table-ops, numbering
- `src/data/` — `ufs-1-300-02-rules.json` (compliance rules), `umrl.json` (reference DB), `umsl.json` (submittal DB), sample spec
- `reference/section.ini` — **authoritative** formatting rules (MARGINS, COLORS, RULES, CODES, FONTS)
- `reference/ufs_1_300_02.pdf` — authoritative source for compliance rules
- `reference/UFGS_M/` — 690 .SEC files for parser validation
- `tests/e2e/editor.spec.js` — 141 Playwright tests
- `tests/*.node-test.mjs` — UFGS structural + interop tests (Node runner)
- `corpus/` — 4-corpus test suite (calibration/clean/dirty/adversarial)
- `tools/` — CLI utilities (parse-sec, interop-scan, ui-audit/)

## Running

```bash
npm run dev                # Vite dev server at localhost:5173
npm test                   # Vitest unit tests
npm run test:compliance    # Compliance rule tests (Node runner — NOT Vitest; Vitest OOMs on the regex-heavy engine)
npm run test:e2e           # Playwright E2E
npm run test:corpus        # Corpus precision/recall/adversarial
npm run test:ufgs          # UFGS tag coverage + structural across 690 files
npm run test:interop       # Structural interop (parse/serialize/roundtrip)
npm run audit:init         # Autonomous UI audit (15 test areas via Claude in Chrome MCP)
npm run audit:report       # Markdown report from findings.json
npm run audit:promote      # Promote findings to GitHub issues
```

**Environment:** Windows (Git Bash). `jq` is not available — use `node -e` for JSON processing in scripts/hooks.

**Common task recipes:**
- **Add a compliance rule:** Edit `src/data/ufs-1-300-02-rules.json` (add to `prohibitedTerms`, `vagueTerms`, or `prohibitedSymbols`). The rule engine auto-generates regex via `buildRules()`. Run `npm run test:compliance` then `npm run test:corpus` to validate.
- **Debug a false positive:** `npm run corpus:test -- --corpus clean`, check `corpus/results/clean-results.json` for the rule ID, then inspect the pattern in `compliance-rules.js`.
- **Measure engine after a change:** `npm run corpus:test -- --corpus clean && npm run corpus:test -- --corpus dirty && npm run corpus:report` — compare metrics.json to previous baseline.
- **Add an adversarial edge case:** Edit `corpus/adversarial/adversarial.json`, add entry with `shouldFlag`/`ruleId`/`reason`, then re-run `npm run test:corpus:adversarial`.

## Development Workflow

When fixing bugs, verify the fix doesn't introduce regressions by running the full test suite before reporting completion. Never report a fix as done until tests pass.

## Git Conventions

- Conventional commits: `feat:`, `fix:`, `docs:`, `refactor:`
- Subject lines under 72 characters
- Always run tests before committing
- Feature branches named `type/short-description` (e.g., `feat/slash-commands`)
- `test-results/` and `tools/harper-candidates.*` are intentionally untracked — do not commit generated audit output or dictionary candidates

## Testing Rules

Vitest for most tests. When tests fail with OOM, web search known Vitest memory solutions (`--pool forks`, `--no-threads`, `NODE_OPTIONS=--max-old-space-size`) before debugging manually.

Test DOM-dependent code in both browser and Node/linkedom environments. linkedom has known limitations — verify parser/serializer code works in the test environment, not just conceptually.

1. **Never use `replace_all` on indented code** — matches across different indentation contexts and corrupts file structure silently (syntactically valid but semantically broken).
2. **If a test/tool fails twice with the same error, web search the cause** before retrying.
3. **Test files should have ≤30 tests.** Use `it.each()` or batch assertions in a single `it()` for data-driven tests.
4. **Always verify existing tests pass BEFORE adding new ones.** Run `npm test` first.
5. **Compliance rule tests use Node's built-in test runner** (`node --test`), not Vitest — the regex-heavy rule engine exhausts Vitest's worker memory. Run via `npm run test:compliance`.

## Always Check the .ini Files for Formatting

`reference/section.ini` is the authoritative source for:
- **[MARGINS]** — left/right indent per block type in inches, ABSOLUTE per type (not cumulative with nesting). TXT=0.16,0→15px | OLI=0.50,0→48px | ITM=0.85,0→82px | LST=0.50,0→48px | NPR=0.89,0.89→85px
- **[COLORS]** — inline data element colors (RID=magenta, SUB=blue, ENG=blue, MET=red, etc.)
- **[RULES]** — what tags can nest inside what (the grammar)
- **[CODES]** — tag names, descriptions, and whether TRANSPARENT (inline) or block-level
- **[FONTS]** — font styling per tag

**Read the .ini file before adding or modifying any formatting.** This applies to revision marks (ADD/DEL/CHG), inline data elements, and block styling. Always cross-reference `[COLORS]`, `[FONTS]`, and `[CODES]` before choosing CSS values.

### Tag categories

**TRANSPARENT tags** (inline wrappers, 20): ADD, ATT, BLD, CHG, CTR, DEL, ENG, HL1, HL2, HL3, HL4, HLS, INC, ITA, MET, SBS, SPS, TAI, TST, UND, URL

**Data-driven inline tags:** SUB (submittals→register), SRF (section cross-refs→validate), RID (citations→sync with REFERENCES), TAI (tailoring by branch/region/delivery), ENG/MET (dual unit pairs)

**Block hierarchy:** SEC > PRT > SPT > {TXT, OLG, OLI, LST, ITM, NTE, NPR, NPG, SBM, TAB, TBL (preformatted), TTL, REF}

## contentEditable Focus Management

This was the hardest part of the prototype. The pattern that works:

1. **New blocks** use a ref callback (`setRef`). When React attaches the DOM node, the callback inserts a zero-width space (`\u200B`) for caret anchoring and calls `node.focus()`.
2. **Existing blocks** (arrow key nav, tree select, delete-focus-prev) use `focusBlock()` in App: `document.querySelector('[data-block-id="..."]').focus()` via `setTimeout(0)`.
3. **Click focus** is browser-native — `handleClickFocus` only updates visual state.
4. **The zero-width space** must be stripped in `handleInput` and `isEmpty()` checks.

Do NOT add additional focus effects or competing focus mechanisms. The current pattern was arrived at through extensive debugging.

## Slash Menu → Block Conversion

`handleConvertBlock` creates a block with a **new ID**. This forces a React remount, which triggers the ref callback, which handles focus. Do not try to reuse the old block ID — the ref callback won't re-fire on an existing DOM node.

## Windows-1252 Encoding

.SEC files declare windows-1252 in the XML header:
- **Import:** `FileReader.readAsArrayBuffer()` + `TextDecoder('windows-1252')` — NOT `readAsText()` (defaults to UTF-8).
- **Export:** `encodeWindows1252(xml)` from `src/lib/encoding.js` returns `Uint8Array` with byte mapping for characters 0x80–0x9F (curly quotes, em-dash, euro, trademark, bullet).

## Track Changes Architecture

TC uses a **snapshot-based diff** approach:

1. **`tcSnapshots`** (`Map<blockId, plainText>`) stores the baseline text of every block at the moment TC was enabled. On blur, current text is diffed against the snapshot.
2. **Snapshot syncing is critical.** Every mutation that changes block content must also update `tcSnapshots` to prevent stale baselines from re-creating phantom revisions. This includes: inline accept/reject (FloatingToolbar), gutter accept/reject, Accept All, Reject All, and del popup accept/reject.
3. **`onRevisionAction`** is a dedicated callback (separate from `onUpdate`) that updates block HTML and tcSnapshots in one pass. Used by FloatingToolbar and EditableBlock's del popup.
4. **Diff pipeline:** `diffWords()` → `refineWordDiff()` → `diffChars()`. Refinement applies character-level sub-diff to consecutive del→add pairs sharing ≥50% common characters, producing fine-grained marks instead of replacing whole words.
5. **Del elements** have `contentEditable="false"` to prevent caret entry, and `cursor: pointer` for click-to-show popup.

## Comments Architecture

Comments use a **DOM-based highlight + separate metadata store**:

1. **In the DOM:** `<span class="mark-comment" data-comment-id="comment-123">text</span>` wraps the commented text.
2. **In state:** `comments` Map stores metadata (id, blockId, status, highlightText, entries thread). Comment data is NOT in `block.html` — parallel store.
3. **Editable blocks:** comment spans are persisted in `block.html`. **Ref blocks and table cells:** spans are injected into the rendered DOM only (data stays in `block.ref`/`block.table`).
4. **Export:** serializer strips `mark-comment` spans. A sidecar `.comments.json` is saved alongside the `.SEC` file.
5. **File import clears comments** — `loadSECContent()` calls `setComments(new Map())` so comments from a prior file don't leak.

## Tag Visibility Toggle

The `</>` button toggles `tags-hidden` (default) vs. `tags-visible` on the editor container:

1. **Inline marks:** real `<span contentEditable="false" class="tag-label">` DOM nodes injected by `syncTagLabels()` in EditableBlock. `MARK_TAG_MAP` maps mark classes to SGML names (`mark-rid`→`RID`). TAI marks include `data-opt`. Tag labels stripped from innerHTML via `stripTagLabels()` before saving to state.
2. **Block-level tags:** CSS `::before`/`::after` with `data-tag` attributes on block wrapper `<div>`s (outside contentEditable, no caret issues).
3. **Why real DOM nodes for inline marks:** CSS pseudo-elements don't create caret positions in contentEditable — the browser can't place the cursor between `::before` and the first text character. `contentEditable="false"` spans provide proper DOM boundaries.

## Compliance Checker Architecture

Data-driven rule engine with two tiers:

1. **`ufs-1-300-02-rules.json`** — authoritative rule data extracted from `reference/ufs_1_300_02.pdf`. 122 rules, 35 prohibited terms, 13 symbols, 20 vague terms, 4 required capitalizations. **Rules are NOT hardcoded in source code.**
2. **`compliance-rules.js`** reads the JSON at startup and generates ~81 rule objects via `buildRules()`. Each rule: id, category, severity, regex, message, UFS reference, optional `fix()`. Rules with `fix === null` defer to AI tier. Uses **binary search** for bracket exclusion.
3. **`compliance-checker.js`** runs rules against scoped blocks, groups by rule ID, computes stats. Excludes note blocks, bracket content, hidden ENG/MET. Enforces **violation budget** (`MAX_VIOLATIONS = 2000`); returns `truncated: true` when capped.
4. **`compliance-ai.js`** (Tier 2): builds system prompt dynamically from the JSON, chunks large requests (20 blocks max per API call), estimates token cost, supports abort via AbortController.
5. **`CompliancePanel.jsx`** — progressive UX: summary bar → grouped findings → batch accept/reject → AI batch. Clicking a group highlights matching text with `.compliance-highlight` spans.
6. **Updating rules:** When USACE publishes a new edition, re-extract the JSON from the PDF. No code changes needed.

**Perf:** lazy fix computation (store `fixFn` reference, don't eagerly compute fix text during scanning); binary search on sorted bracket ranges (O(log m) per match); 2000-violation cap.

## Inline Linting Architecture

Real-time linting uses the **CSS Custom Highlight API** (zero DOM mutation) with three engines:

1. **Static UFS rules** (`compliance-rules.js`): synchronous, <5ms. Yellow highlights.
2. **Harper.js grammar** (`grammar-checker.js`): async via Web Worker (WASM). Lazy-loaded (~2-4MB). Blue highlights. Custom dictionary for engineering terms.
3. **compromise.js NLP** (`nlp-rules.js`): synchronous, lazy-loaded (~210KB). Passive voice via `(be + #PastTense)` patterns, indicative mood via regex. Orange highlights.

**Key design decisions:**
- **Browser exfiltration prevention:** All typing surfaces (contentEditable blocks + every spec/comment input/textarea) spread `{...NO_EXFIL_PROPS}` from `src/lib/no-exfil.js`. This disables `spellCheck`, `writingsuggestions` (Chrome "Help me write" / Edge Copilot), `autoComplete`, `autoCorrect`, `autoCapitalize`, and Grammarly's `data-gramm*`. CSP + `referrer="no-referrer"` + `notranslate` in `index.html` provide a second layer. Regression test at `src/lib/__tests__/no-exfil.test.js`. **Do not add a new contentEditable, input, or textarea that accepts spec text without spreading these props and updating the test surface list.**
- **Only the focused block is linted** — avoids scanning 300+ blocks on every edit. Findings persist across blur/focus.
- **Offset-aware range creation:** `createRangeForMatch()` accepts a `targetOffset` hint to disambiguate repeated words.
- **De-duplication:** Grammar findings overlapping >50% with compliance/NLP findings are suppressed (static rules win — they have UFS citations).
- **Compliance panel collision:** When `CompliancePanel` is open, inline linting is suppressed to avoid double-highlighting.
- **Context-dependent deferral:** Rules producing false positives requiring sentence-level context (TERM-suitable, TERM-any, TERM-should, VAGUE-applicable) are filtered via `DEFERRED_TO_PANEL`. They still run in the Compliance Panel on explicit full scan.
- **Stale result handling:** Grammar results tagged with text version; discarded if text changed while Worker was processing.
- **Bad suggestion filtering:** Harper suggestions that introduce spaces into single words (e.g., "taht" → "ta ht") are suppressed. Oxford comma fixes append punctuation.
- **Note block exemption:** Note blocks skip compliance and NLP (notes use advisory language). Grammar/spelling still runs.
- **Offset-aware fixes:** `replaceAtOffset()` in `fix-utils.js` disambiguates duplicate violations. Walks HTML tracking plain-text offsets (skipping `<...>`), collects candidates, picks closest to violation's `index`. `InlineTooltip.jsx` passes `violation.index` as the fourth arg to `fixFn()`. Falls back to first-match when offset is undefined.
- **Toggle persistence:** `secwriter-inline-linting` in localStorage. When re-enabled, the focused block is linted immediately.

## Corpus Testing Infrastructure

Three text-analysis engines measured against real UFGS text using a 4-corpus suite:

1. **Calibration** (`corpus/calibration/`) — 2,583 raw UFGS blocks from 5 sections. Validates primary rules (shall, should) produce zero hits on unmodified master text.
2. **Clean** (`corpus/clean/`) — same blocks rewritten by Claude Opus to full UFS 1-300-02 compliance. Every finding is a false positive. Measures precision.
3. **Dirty** (`corpus/dirty/`) — 644 blocks with 1,438 labeled injected violations. Measures recall per rule.
4. **Adversarial** (`corpus/adversarial/`) — 150 edge cases (FP traps, NLP ambiguity, domain jargon). Measures robustness.

**Regenerating results:** `node --import ./tools/json-loader.mjs tools/run-corpus-test.mjs --corpus clean` (or `dirty`, `calibration`). Then `node tools/generate-report.mjs` for REPORT.md + metrics.json.

**Baseline (March 2026):** Static recall 86.9%, NLP recall 67.5%, Grammar recall 78.4%. Static FP rate 0.31%. Adversarial accuracy 97.3%. Full report: `corpus/results/REPORT.md`.

**Rule ID mapping:** The injection plan used semantic IDs (e.g., `COLLOQ-furnish`) that don't match sequential IDs from `buildRules()` (e.g., `TERM-034`). Mapping at `corpus/results/rule-id-mapping.json`. Any future recall analysis must use this mapping.

## Compliance Rule Development

When implementing compliance checks, always reference `reference/ufs_1_300_02.pdf` (raw text at `reference/ufs_1_300_02_text.txt`) rather than relying on general knowledge. Ask the user to provide the spec if not already available.

**Lesson (FMT-001 removal):** A "multiple spaces should be single space" rule was fabricated without UFS basis and generated 75+ false positives per spec — USACE .SEC files conventionally use double spaces after periods. **Every rule must trace to a specific UFS 1-300-02 section.**

## Thinking

Use extended thinking before architectural decisions, debugging failures, writing regex, choosing whether to retry vs. switch tools, and answering "why" questions. If you catch yourself in a retry loop, stop and reconsider the approach.

## Data Model

Each document is a flat array of blocks:

```json
{
  "id": "n42",
  "type": "txt",        // title | txt | note | oli | item | lst | table | ref | pagebreak | tbl
  "part": 1,            // PART number (1, 2, 3)
  "depth": 2,           // SPT nesting depth (0 = PART level)
  "section": "n41",     // ID of parent title block
  "level": 1,           // OLI only: list level 1..4 per UFS Figure A-1 (a. / (1) / (a) / 1.)
  "html": "...",         // Rich text with <span class="mark-rid"> etc.
  "table": { ... },     // table blocks: { columns, rows: [[{text, colspan}]] }
  "ref": { ... },        // ref blocks: { org: string, entries: [{ rid, rtl }] }
  "revision": "add",    // Block-level: "add" | "del" | "chg" | undefined
  "isNew": true          // Transient: newly created blocks (controls editability + focus)
}
```

## Reference Data Sources

- **UMRL** (`src/data/umrl.json`) — Unified Master Reference List. 302 organizations, 4,973 entries. Source: `C:\Program Files (x86)\SpecsIntact 5\UMRL\umrl.ref`. Used by the Reference Wizard.
- **UMSL** (`src/data/umsl.json`) — Unified Master Submittal List. 13,203 submittal entries. Source: same directory, `umsl.lst`. For future submittal wizard.

USACE updates these regularly. To refresh, re-run the parser scripts that generated the JSON.

## Known Parser Edge Cases

Parser validated against all 690 UFGS files (60 tags). Two known roundtrip edge cases: `32 12 36.26.SEC` and `32 13 13.43.SEC` have `<THD><HL3>text</HL3></THD>` where nested bold boundaries shift (content preserved).
