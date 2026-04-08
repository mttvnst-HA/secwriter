# SpecsIntact Modern (SIM)

A modern web-based editor for UFGS (Unified Facilities Guide Specifications) .SEC files, replacing the legacy SpecsIntact desktop application (SIEditor).

**Terminology:** "specsintact-modern" / "SIM" / "SI Modern" = this web app. "SpecsIntact" / "SIEditor" = the legacy Windows desktop application.

## Development Workflow

When fixing bugs, verify the fix doesn't introduce regressions by running the full test suite before reporting completion. Never report a fix as done until tests pass.

## Git Conventions

- Use conventional commits: feat:, fix:, docs:, refactor:
- Keep subject lines under 72 characters
- Always run tests before committing
- Create feature branches for new work
- Branch naming: type/short-description (e.g., feat/slash-commands)
- `test-results/` and `tools/harper-candidates.*` are intentionally untracked — do not commit generated audit output or dictionary candidates

## Project Context

**What this is:** A rich text editor that reads and writes SpecsIntact .SEC files (XML-based SGML format with windows-1252 encoding, used by the U.S. military for construction specifications). The editor makes spec authoring feel like Google Docs or Notion while preserving the underlying SGML structure.

**Who it's for:** Engineers (especially geotechnical) who currently use MS Word as a workaround because SpecsIntact's tag-based editing is too clunky. The tool eliminates the Word-to-SpecsIntact round-trip workflow.

**Key design principle:** The engineer should never think about tags or SGML. Enter creates a paragraph. / opens a block type menu. Tab promotes/demotes headings. The SGML structure is inferred from context, not selected from a toolbar.

## Architecture

```
src/
  App.jsx                  # Main editor layout, state management, toolbar, sidebar ~1920 lines
  main.jsx                 # Entry point + ErrorBoundary wrapper ~50 lines
  components/
    EditableBlock.jsx      # contentEditable block (txt, note, oli, item, lst) + del popup + inline linting ~710 lines
    InlineTooltip.jsx      # Floating tooltip for inline linting findings: severity, fix preview, Why? ~292 lines
    TitleBlock.jsx         # Section heading with inline editing, Tab/Shift+Tab depth ~145 lines
    TableBlock.jsx         # Table editing: cell edit, add/delete rows/columns, merge/split ~260 lines
    RefBlock.jsx           # Structured REF editing (ORG + RID/RTL) + comment support ~320 lines
    RefWizard.jsx          # UMRL-powered reference search + insertion wizard ~280 lines
    TreeNode.jsx           # Sidebar navigation tree node (recursive, draggable) ~115 lines
    SlashMenu.jsx          # / command dropdown menu (incl. /pagebreak) ~96 lines
    FloatingToolbar.jsx    # Selection toolbar: B/I/U + Aa + marks + ADD/DEL + accept/reject + comment ~610 lines
    SearchBar.jsx          # Ctrl+F/Ctrl+H find & replace with debounced search ~365 lines
    BracketReplace.jsx     # [Bracketed text] placeholder replacement panel ~155 lines
    ValidationPanel.jsx    # Document validation panel with severity filters ~100 lines
    CommentPopup.jsx       # Comment thread popup with resolve/reopen/reply/delete ~265 lines
    MarkSuggestions.jsx    # Auto-detect pattern suggestions (RID/SRF pills) ~155 lines
    MarkLegend.jsx         # Data element color key (preserved for user manual, removed from UI) ~20 lines
    TailoringProfile.jsx   # TAI profile selector (branch/region/delivery dropdowns) ~160 lines
    RevisionControls.jsx   # Track Changes, Revisions, Notes, ENG/MET toggles + Accept/Reject All ~200 lines
    CrossRefPanel.jsx      # RID/SRF validation + orphaned reference removal buttons ~120 lines
    CompliancePanel.jsx    # UFS 1-300-02 compliance checker: progressive UX, grouped findings, inline highlighting ~950 lines
    ComplianceSettings.jsx # Anthropic API key management for AI compliance rewrites ~185 lines
  lib/
    numbering.js           # Section numbering (1.1, 1.2.1, etc.) and OLI labels (a. b. c.) ~100 lines
    tree-builder.js        # Builds hierarchical tree from flat block array ~19 lines
    ini-config.js          # Formatting rules from SpecsIntact .ini files (margins, colors, nesting) ~79 lines
    sec-parser.js          # .SEC file parser (XML -> block array, incl. NPG page breaks, TBL/ATT) ~475 lines
    sec-serializer.js      # Block array -> .SEC XML serializer (CRLF, NPG, TBL, comment stripping) ~537 lines
    encoding.js            # Windows-1252 encoder for .SEC export ~65 lines
    mark-patterns.js       # Auto-detect RID/SRF patterns in text ~95 lines
    tailor-profile.js      # TAI OPT matching, resolution, cleanup ~165 lines
    revisions.js           # Accept/reject logic for tracked changes, stats ~190 lines
    text-diff.js           # Word-level LCS diff + character-level sub-diff + DOM annotation ~450 lines
    cross-ref-validation.js # RID + SRF cross-reference extraction + validation ~120 lines
    useUndoableBlocks.js   # Undo/redo hook wrapping blocks + tcSnapshots with history ~150 lines
    table-ops.js           # Table row/column/cell operations + merge/split ~135 lines
    block-reorder.js       # Section reordering: getSectionRange, reorderSection ~80 lines
    comment-report.js      # Printable HTML comment resolution report generator ~70 lines
    doc-export.js          # Word (.docx) and Print/PDF export generation ~245 lines
    auto-save.js           # localStorage auto-save + File System Access API save ~105 lines
    doc-validation.js      # Document structural validation (PARTs, titles, submittals) ~165 lines
    bracket-replace.js     # Find [bracketed text] placeholders, grouped replacement ~45 lines
    submittal-register.js  # SUB mark extraction, SD grouping, register compilation + HTML report ~195 lines
    compliance-rules.js    # UFS 1-300-02 static rule engine — loads rules JSON, generates ~81 regex patterns, binary search bracket exclusion ~505 lines
    compliance-checker.js  # Compliance orchestrator: scope selection, rule execution, grouping, stats, violation budget ~235 lines
    compliance-diff.js     # Word-level diff for compliance fix previews (wraps diffWords) ~25 lines
    compliance-ai.js       # AI rewrite module: Anthropic API, chunking, token estimation, HTML preservation ~280 lines
    inline-linter.js       # Real-time linting orchestrator: CSS Custom Highlight API, 3 engines, per-block findings ~500 lines
    grammar-checker.js     # Harper.js WASM Web Worker wrapper: lazy init, custom dictionary, fix filtering ~280 lines
    nlp-rules.js           # compromise.js passive voice + indicative mood detection, lazy loading ~230 lines
    fix-utils.js           # Offset-aware string replacement in HTML: replaceAtOffset() for disambiguating duplicate violations ~65 lines
    __tests__/             # 466 Vitest + 40 Node tests (see Test Coverage table for per-file breakdown)
  data/
    sample-31-00-00.json   # Pre-parsed sample data (UFGS 31 00 00 EARTHWORK)
    umrl.json              # UMRL reference database (302 orgs, 4,973 references, 587KB)
    umsl.json              # UMSL submittal database (13,203 submittals, 1,097KB)
    ufs-1-300-02-rules.json # UFS 1-300-02 compliance rules (122 rules, 35 prohibited terms, 65KB)
  styles/
    editor.css             # Marks, revisions, comments, dark mode, unit toggles, compliance + inline linting highlights ~580 lines
reference/
  section.ini              # SpecsIntact formatting rules (AUTHORITATIVE - always check this)
  document.ini             # Document-level formatting variant
  other.ini                # Other formatting variant
  UFGS.tpl                 # UFGS section template
  31_00_00.SEC             # Sample spec file (EARTHWORK)
  UFGS_M/                 # Full UFGS master set (690 .SEC files) for parser validation
  ufs_1_300_02.pdf         # UFS 1-300-02 Format Standard (authoritative source for compliance rules)
  ufs_1_300_02_text.txt    # Raw text extraction from UFS PDF (for re-extraction)
  WebHelp/                 # Legacy SpecsIntact help system
tests/
  e2e/
    editor.spec.js         # 140 Playwright E2E tests ~2800 lines
  interop-test-procedure.md # 6 manual round-trip interop test scenarios
  tc-browser-test-prompt.md # 15 autonomous browser test cases for Track Changes
  ux-ergonomic-review-prompt.md # UX review prompt with parallel agents + verification workflow
  ufgs-tag-coverage.node-test.mjs  # Tag coverage regression: all 60 SGML tags accounted for across 690 files ~85 lines
  ufgs-structural.node-test.mjs    # Structural validation: block types, depth, tables, refs across 690 files ~130 lines
  interop.node-test.mjs            # 17 structural interop tests: parse→serialize→validate XML structure ~200 lines
  interop-encoding.node-test.mjs   # 11 reverse import + encoding fidelity tests ~150 lines
tools/
  parse-sec.js             # Node CLI: parse .SEC -> JSON
  roundtrip-test.js        # Test parse -> serialize -> re-parse
  diagnose-depth.js        # Debug SPT nesting
  diagnose-html.js         # Debug HTML extraction
  interop-scan.mjs         # Binary-level diff scanner: SIM-serialized vs legacy .SEC files
  interop-export.mjs       # Generates SIM-exported .SEC files for 10 representative sections
  ui-audit/
    run-audit.mjs          # Audit runner orchestrator — launches 15 test areas sequentially
    collect-findings.mjs   # Generates timestamped Markdown report from findings.json
    promote-to-github.mjs  # Interactive GitHub issue promoter for audit findings
    findings-schema.json   # JSON schema for findings data
    test-procedure.md      # Master test procedure (15 areas)
    test-areas/            # 15 test area definitions (01-app-load.md through 15-dark-mode-zoom.md)
test-results/              # UI audit output: findings.json + timestamped Markdown reports
```

## Running

```bash
npm install
npm run dev          # Vite dev server at localhost:5173
npm run build        # Production build to dist/
npm test             # Run 480 Vitest unit tests
npm run test:watch   # Watch mode
npm run test:compliance  # Run 42 compliance rule tests (Node built-in runner — NOT Vitest)
npm run test:e2e     # Run 141 Playwright E2E tests
npm run test:corpus  # Run 17 corpus precision/recall/adversarial tests (Node runner)
npm run test:ufgs    # Run 12 UFGS tag coverage + structural tests across 690 files (Node runner)
npm run test:interop # Run 17 interop structural tests (Node runner — parse/serialize/roundtrip)
npm run test:interop:encoding  # Run 11 reverse import + encoding fidelity tests (Node runner)
# Full suite: 480 + 99 + 141 = 720 automated tests
npm run parse -- input.sec output.json       # CLI: parse SEC to JSON
npm run corpus:extract                       # Extract .SEC files to calibration JSON
npm run corpus:test -- --corpus clean        # Run engines against clean/dirty/calibration corpus
npm run corpus:report                        # Generate REPORT.md + metrics.json
npm run audit:init                           # Run autonomous UI audit (15 test areas, uses Claude in Chrome MCP)
npm run audit:list                           # List available test areas
npm run audit:report                         # Generate Markdown report from findings.json
npm run audit:promote                        # Promote findings to GitHub issues (interactive)
```

**Environment:** Windows (Git Bash). `jq` is not available — use `node -e` for JSON processing in scripts/hooks. File paths use `/c/working_claude/` format in Git Bash.

**Quick Reference — Common Tasks:**
- **Add a compliance rule:** Edit `src/data/ufs-1-300-02-rules.json` (add to `prohibitedTerms`, `vagueTerms`, or `prohibitedSymbols`). The rule engine auto-generates regex via `buildRules()`. Run `npm run test:compliance` then `npm run test:corpus` to validate.
- **Debug a false positive:** Run `npm run corpus:test -- --corpus clean`, check `corpus/results/clean-results.json` for the rule ID, then inspect the pattern in `compliance-rules.js`.
- **Measure engine after a change:** `npm run corpus:test -- --corpus clean && npm run corpus:test -- --corpus dirty && npm run corpus:report` — compare metrics.json to previous baseline.
- **Run a UI audit:** `npm run audit:init` launches all 15 test areas via Claude in Chrome MCP. Results go to `test-results/findings.json`. Generate a report with `npm run audit:report`, then optionally promote findings to GitHub issues with `npm run audit:promote`.
- **Add an adversarial edge case:** Edit `corpus/adversarial/adversarial.json`, add entry with `shouldFlag`/`ruleId`/`reason`, then re-run adversarial scoring and `npm run test:corpus:adversarial`.

## Critical Rules

### Thinking mode

**Always use extended thinking before:**
- Making architectural decisions or choosing between approaches
- Debugging failures (reason through root causes before attempting fixes)
- Writing regex patterns or complex logic (trace through edge cases mentally first)
- Deciding whether to retry a failing approach vs. switch tools
- Answering "why" questions about past behavior

Do not rush to action. Think first, act second. If you catch yourself in a retry loop, stop and think about whether the tool or approach is wrong.

### Testing rules

This project uses Vitest for testing. When tests fail with OOM errors, search online for known Vitest memory solutions (e.g., --pool forks, --no-threads, NODE_OPTIONS=--max-old-space-size) before debugging manually.

Test DOM-dependent code in both browser and Node/linkedom environments. linkedom has known limitations compared to browser DOM — always verify parser/serializer code works in the test environment, not just conceptually.

1. **Never use `replace_all` on indented code** — it matches across different indentation contexts and corrupts file structure silently (syntactically valid but semantically broken).
2. **If a test/tool fails twice with the same error, web search the cause** before retrying. Known issues (like Vitest OOM) have known fixes.
3. **Test files should have ≤30 tests.** Use `it.each()` or batch assertions in a single `it()` for data-driven tests, not individual `it()` blocks.
4. **Always verify existing tests pass BEFORE adding new ones.** Run `npm test` first, then add.
5. **Compliance rule tests use Node's built-in test runner** (`node --test`), not Vitest. The regex-heavy rule engine exhausts Vitest's worker memory. Run via `npm run test:compliance`.
6. **Proactive testing:** Use data-driven assertions or simple scripts, not massive test files. 19 false positive checks in a single `it()` is better than 19 separate tests.

### Always check the .ini files for formatting

The `reference/section.ini` file is the authoritative source for:
- **[MARGINS]** - Left/right indent per block type (in inches). These are ABSOLUTE per type, not cumulative with nesting depth.
  - TXT=0.16,0 → 15px | OLI=0.50,0 → 48px | ITM=0.85,0 → 82px | LST=0.50,0 → 48px | NPR=0.89,0.89 → 85px
- **[COLORS]** - Color coding for inline data elements (RID=magenta, SUB=blue, ENG=blue, MET=red, etc.)
- **[RULES]** - What tags can nest inside what. This is the grammar.
- **[CODES]** - Tag names, descriptions, and whether they're TRANSPARENT (inline) or block-level.
- **[FONTS]** - Font styling per tag.

**When adding or modifying any formatting, read the .ini file first.** Do not guess at margins, colors, or font styles. This applies to ALL changes — including revision marks (ADD/DEL/CHG), inline data elements, and block styling. Always cross-reference `[COLORS]`, `[FONTS]`, and `[CODES]` sections before choosing CSS values.

### Tag categories (from .ini analysis)

**TRANSPARENT tags** (inline wrappers - 20 tags): ADD, ATT, BLD, CHG, CTR, DEL, ENG, HL1, HL2, HL3, HL4, HLS, INC, ITA, MET, SBS, SPS, TAI, TST, UND, URL

**Data-driven inline tags** (need structured treatment):
- SUB (323 occurrences) - Submittal items -> compiled into submittal register
- SRF (164) - Section cross-references -> validate against project package
- RID (529 inline) - Standard citations (ASTM, AASHTO) -> sync with REFERENCES section
- TAI (302) - Tailoring options by service branch/region/delivery method
- ENG/MET (~500 each) - Dual unit display pairs

**Block elements hierarchy:** SEC > PRT > SPT > {TXT, OLG, OLI, LST, ITM, NTE, NPR, NPG, SBM, TAB, TBL (preformatted), TTL, REF}

### contentEditable focus management

This was the hardest part of the prototype. The pattern that works:

1. **New blocks** use a ref callback (`setRef`). When React attaches the DOM node, the callback inserts a zero-width space (`\u200B`) for caret anchoring and calls `node.focus()`.
2. **Existing blocks** (arrow key navigation, tree select, delete-focus-prev) use `focusBlock()` in the main App, which does `document.querySelector('[data-block-id="..."]').focus()` via setTimeout(0).
3. **Click focus** is browser-native - the `handleClickFocus` just updates visual state, doesn't programmatically focus.
4. **The zero-width space** must be stripped in `handleInput` and `isEmpty()` checks.

Do NOT add additional focus effects or competing focus mechanisms. The current pattern was arrived at through extensive debugging.

### Slash menu -> block conversion

When the slash menu converts a block type, `handleConvertBlock` creates a block with a **new ID**. This forces a React remount, which triggers the ref callback, which handles focus. Do not try to reuse the old block ID - the ref callback won't re-fire on an existing DOM node.

### Windows-1252 encoding

.SEC files use windows-1252 encoding (declared in the XML header). SIM handles this:
- **Import:** `FileReader.readAsArrayBuffer()` + `TextDecoder('windows-1252')` — NOT `readAsText()` (which defaults to UTF-8)
- **Export:** `encodeWindows1252(xml)` from `src/lib/encoding.js` returns `Uint8Array` with proper byte mapping for characters 0x80–0x9F (curly quotes, em-dash, euro, trademark, bullet, etc.)

### Track Changes architecture

TC uses a **snapshot-based diff** approach. Key design decisions:

1. **`tcSnapshots`** (`Map<blockId, plainText>`) stores the "baseline" text of every block at the moment TC was enabled. When a block is blurred, its current visible text is diffed against the snapshot.
2. **Snapshot syncing is critical.** Every mutation path that changes block content must also update `tcSnapshots` to prevent stale baselines from re-creating phantom revisions. This includes: inline accept/reject (FloatingToolbar), gutter accept/reject, Accept All, Reject All, and del popup accept/reject.
3. **`onRevisionAction`** is a dedicated callback (separate from `onUpdate`) that updates both block HTML and tcSnapshots in one pass. Used by FloatingToolbar and EditableBlock's del popup.
4. **Diff pipeline:** `diffWords()` → `refineWordDiff()` → `diffChars()`. The refinement step applies character-level sub-diff to consecutive del→add pairs that share >=50% common characters, producing fine-grained `<del>`/`<ins>` marks instead of replacing entire words.
5. **Del elements** have `contentEditable="false"` to prevent caret entry, and `cursor: pointer` to support click-to-show popup for accept/reject.
6. **Gutter buttons** appear for blocks with either block-level revision (`block.revision`) OR inline-only revisions (detected via regex on `block.html`).

### Comments architecture

Comments use a **DOM-based highlight + separate metadata store** approach:

1. **In the DOM:** `<span class="mark-comment" data-comment-id="comment-123">text</span>` wraps the commented text with yellow highlight.
2. **In state:** `comments` Map stores metadata (id, blockId, status, highlightText, entries thread). Comment data is NOT in `block.html` — it's a parallel store.
3. **For editable blocks:** comment spans are persisted in `block.html`. For **ref blocks and table cells:** spans are injected into the rendered DOM only (data stays in `block.ref`/`block.table`).
4. **FloatingToolbar** detects ref/table block selections via fallback `[id^="block-"]` selector and shows only the comment button.
5. **Export:** serializer strips `mark-comment` spans. A sidecar `.comments.json` file is saved alongside the `.SEC` file.
6. **File import clears comments.** `loadSECContent()` calls `setComments(new Map())` so comments from a previous file don't leak into the new document.

### Tag visibility toggle architecture

The `</>` toolbar button toggles between `tags-hidden` (default) and `tags-visible` CSS classes on the editor container:

1. **Inline marks** use real `<span contentEditable="false" class="tag-label">` DOM nodes injected by `syncTagLabels()` in EditableBlock. The `MARK_TAG_MAP` maps mark classes to SGML tag names (e.g., `mark-rid`→`RID`). TAI marks include `data-opt` attribute in the open tag. Tag text is styled in cyan monospace (`.tag-label` class in editor.css). Tag labels are stripped from innerHTML via `stripTagLabels()` before saving to state.
2. **Block-level tags** use CSS `::before`/`::after` pseudo-elements with `data-tag` attributes on block wrapper `<div>` elements (outside contentEditable, so no caret issues). EditableBlock maps block types to SGML names (`txt→TXT`, `note→NTE`, `oli→OLI`, `item→ITM`, `lst→LST`). TitleBlock uses `data-tag="TTL"`.
3. **Why real DOM nodes for inline marks:** CSS pseudo-elements don't create caret positions in contentEditable — the browser can't place the cursor between a `::before` and the first text character. `contentEditable="false"` spans provide proper DOM boundaries for caret positioning.

### Compliance checker architecture

The compliance checker uses a **data-driven rule engine** with two tiers:

1. **`ufs-1-300-02-rules.json`** (65KB) — authoritative rule data extracted from `reference/ufs_1_300_02.pdf`. Contains 122 rules, 35 prohibited terms, 13 symbols, 20 vague terms, 4 required capitalizations, and more. **Rules are NOT hardcoded in source code.**
2. **`compliance-rules.js`** reads the JSON at startup and generates ~81 rule objects via `buildRules()`. Each rule has: id, category, severity, regex pattern, message, UFS reference, and an optional `fix()` function. Rules where `fix` is null are deferred to AI tier. Uses **binary search** for bracket exclusion (O(log n) per match instead of O(n)).
3. **`compliance-checker.js`** runs rules against a scoped set of blocks, groups violations by rule ID, and computes severity stats. Excludes note blocks, bracket content, and hidden ENG/MET content. Enforces a **violation budget** (`MAX_VIOLATIONS = 2000`) to prevent OOM on large documents; returns `truncated: true` when capped.
4. **`compliance-ai.js`** handles Tier 2: builds a system prompt dynamically from the JSON (injects all prohibited + vague terms), chunks large requests (20 blocks max per API call), estimates token cost, and supports abort via AbortController.
5. **`CompliancePanel.jsx`** renders the right-side panel with progressive UX: summary bar → grouped findings → batch accept/reject → AI batch section → settings. Clicking a group highlights all matching text in the editor with yellow `.compliance-highlight` spans. Shows truncation warning when violation cap is reached.
6. **Updating rules:** When USACE publishes a new edition of UFS 1-300-02, re-extract the JSON from the PDF. No code changes needed — the rule engine automatically picks up new data.

**Performance design decisions:**
- **Lazy fix computation:** Violations store `fixFn` (function reference) but do NOT eagerly compute fix text during scanning. Fix text is computed on-demand when the user accepts a fix. This prevents thousands of redundant string allocations.
- **Binary search bracket exclusion:** `isInOrNearBracket()` uses sorted bracket ranges with binary search instead of `.some()` linear scan, reducing O(n×m) to O(n×log m).
- **Violation budget:** `MAX_VIOLATIONS = 2000` caps the violations array. Panel shows "Narrow the scope" warning when truncated.

### Inline linting architecture

Real-time linting uses the **CSS Custom Highlight API** (zero DOM mutation) with three detection engines:

1. **Static UFS rules** (`compliance-rules.js`): Synchronous, <5ms. Reuses the same rules as the compliance panel. Yellow highlights (`::highlight(compliance-error)`).
2. **Harper.js grammar** (`grammar-checker.js`): Async via Web Worker (WASM). Lazy-loaded (~2-4MB). Blue highlights (`::highlight(grammar-error)`). Custom dictionary for engineering terms.
3. **compromise.js NLP** (`nlp-rules.js`): Synchronous, lazy-loaded (~210KB). Passive voice via `(be + #PastTense)` patterns, indicative mood via regex. Orange highlights (`::highlight(passive-voice)`).

**Key design decisions:**
- **Browser spellcheck disabled:** All contentEditable blocks set `spellCheck={false}` (EditableBlock.jsx, TitleBlock.jsx). Native red squiggles would duplicate Harper findings and risk leaking spec text to browser-integrated services (Chrome/Edge Copilot). SIM owns all grammar/spelling feedback — do not re-enable.
- **Only the focused block is linted** — avoids scanning 300+ blocks on every edit. Findings persist across blur/focus.
- **Offset-aware range creation:** `createRangeForMatch()` accepts a `targetOffset` hint from violation engines to disambiguate repeated words (e.g., "the" appearing 5 times — highlights the correct one).
- **De-duplication:** Grammar findings overlapping >50% with compliance/NLP findings are suppressed (static rules win — they have UFS citations).
- **Compliance panel collision:** When `CompliancePanel` is open, inline linting is suppressed entirely to avoid double-highlighting.
- **Context-dependent rule deferral:** Rules that produce false positives requiring sentence-level context (TERM-suitable, TERM-any, TERM-should, VAGUE-applicable) are filtered out of inline linting via `DEFERRED_TO_PANEL` set. They still run in the Compliance Panel where users explicitly request a full scan.
- **Stale result handling:** Grammar results tagged with text version; discarded if text changed while Worker was processing.
- **Bad suggestion filtering:** Harper suggestions that introduce spaces into single words (e.g., "taht" → "ta ht") are suppressed. Oxford comma fixes append punctuation instead of replacing the word.
- **Note block exemption:** Note blocks skip compliance and NLP rules (notes use advisory language). Grammar/spelling from Harper still runs.
- **Tooltip:** `InlineTooltip.jsx` shows on collapsed cursor via `selectionchange` + `keyup` listeners. Dismisses on Escape, click outside, or any input keystroke (so it doesn't block editing). Computes fix preview text dynamically for rules without explicit `replacement`.
- **Toggle:** "Lint ●/○" toolbar button with localStorage persistence (`sim-inline-linting`). When re-enabled, the currently focused block is linted immediately (not deferred to next focus event).
- **Offset-aware fixes:** `replaceAtOffset()` in `fix-utils.js` disambiguates duplicate violations when applying fixes. It walks the HTML tracking plain-text offsets (skipping `<...>` tag syntax), collects all candidate matches, and picks the one closest to the violation's `index`. Called by grammar-checker.js, nlp-rules.js fix functions, and InlineTooltip.jsx passes `violation.index` as the fourth argument to `fixFn()`. Falls back to first-match replacement when offset is undefined (backward compat).

### Corpus testing infrastructure

SIM's three text-analysis engines are measured against real UFGS specification text using a 4-corpus test suite:

1. **Calibration corpus** (`corpus/calibration/`) — 2,583 raw UFGS blocks from 5 sections (03 30 00, 22 00 00, 26 20 00, 32 12 16.16, 33 71 02). Validates that primary rules (shall, should) produce zero hits on unmodified master text.
2. **Clean corpus** (`corpus/clean/`) — same blocks rewritten by Claude Opus to full UFS 1-300-02 compliance. Every finding is a false positive. Measures precision.
3. **Dirty corpus** (`corpus/dirty/`) — 644 validated blocks with 1,438 labeled violations injected. Measures recall per rule.
4. **Adversarial corpus** (`corpus/adversarial/`) — 150 edge cases (FP traps, NLP ambiguity, domain jargon). Measures robustness.

**Running:** `npm run test:corpus` (17 tests, <300ms). Individual suites: `npm run test:corpus:calibration`, `:precision`, `:recall`, `:adversarial`.

**Regenerating results:** `node --import ./tools/json-loader.mjs tools/run-corpus-test.mjs --corpus clean` (or `--corpus dirty`, `--corpus calibration`). Then `node tools/generate-report.mjs` for REPORT.md + metrics.json.

**Key baseline metrics (March 2026):** Static recall 86.9%, NLP recall 67.5%, Grammar recall 78.4%. Static FP rate 0.31%. Adversarial accuracy 97.3%. Full report at `corpus/results/REPORT.md`.

**Rule ID mapping:** The injection plan used semantic IDs (e.g., COLLOQ-furnish) that don't match sequential IDs from `buildRules()` (e.g., TERM-034). The mapping at `corpus/results/rule-id-mapping.json` corrects this. Any future recall analysis must use this mapping.

### Known inline linting limitations

These are known issues identified during QA testing that have not yet been fixed:

- **`shall` fix returns null on partial success** (`compliance-rules.js:78`): If "The Contractor shall [verb]" is successfully rewritten but a separate bare "shall" remains in the block, the fix returns `null` (discards the partial fix). This is by design (defer complex cases to AI), but the user sees no change despite a valid partial fix being possible.
- **Gutter dot lags grammar results** (`EditableBlock.jsx:312`): `setLintSeverity` fires 200ms after lint, but Harper WASM may take longer on first load. The gutter dot won't reflect grammar findings until the next lint cycle.

### Reference data sources

SIM uses two USACE-maintained databases parsed from the legacy SpecsIntact installation:

1. **UMRL** (`src/data/umrl.json`) — Unified Master Reference List. 302 standards organizations, 4,973 reference entries (RID + RTL). Source: `C:\Program Files (x86)\SpecsIntact 5\UMRL\umrl.ref`. Used by the Reference Wizard for searchable reference insertion.
2. **UMSL** (`src/data/umsl.json`) — Unified Master Submittal List. 13,203 submittal entries with section, SD number, classification, and item name. Source: `C:\Program Files (x86)\SpecsIntact 5\UMRL\umsl.lst`. Available for future submittal wizard.

These files are regularly updated by USACE. To refresh: re-run the parser scripts that generated the JSON files.

### Compliance rule development

When implementing compliance checks or validation logic, always reference the actual specification document (`reference/ufs_1_300_02.pdf`) rather than relying on learned/general knowledge. Ask the user to provide the spec if not already available.

**Key lesson (FMT-001 removal):** A "multiple spaces should be single space" rule was fabricated without UFS basis and generated 75+ false positives per spec — USACE .SEC files conventionally use double spaces after periods. Every rule must trace to a specific UFS 1-300-02 section. The raw text extraction is at `reference/ufs_1_300_02_text.txt`.

## Data Model

Each document is a flat array of blocks:

```json
{
  "id": "n42",
  "type": "txt",        // title | txt | note | oli | item | lst | table | ref | pagebreak | tbl
  "part": 1,            // PART number (1, 2, 3)
  "depth": 2,           // SPT nesting depth (0 = PART level, 1 = first subpart, etc.)
  "section": "n41",     // ID of the parent title block
  "level": 1,           // OLI only: list level 1..4 per UFS Figure A-1 (a. / (1) / (a) / 1.)
  "html": "...",         // Rich text content with <span class="mark-rid"> etc.
  "table": { ... },     // table blocks only: { columns, rows: [[{text, colspan}]] }
  "ref": { ... },        // ref blocks only: { org: string, entries: [{ rid, rtl }] }
  "revision": "add",    // Block-level revision: "add" | "del" | "chg" | undefined
  "isNew": true          // Transient flag for newly created blocks (controls editability + focus)
}
```

## Development Status

Core editing features are implemented: rich text editing (contentEditable blocks), track changes (snapshot-based diff), comments (Google Docs-style threads), SEC import/export with Windows-1252 encoding, Word/PDF export, compliance checking (static + AI tiers), real-time inline linting (3 engines: UFS, Harper.js grammar, compromise.js NLP), reference wizard (UMRL), submittal register, cross-ref validation, tailoring profiles, find & replace, bracket replacement, tag visibility toggle, dark mode, undo/redo, and auto-save.

### Known Limitations

- **Serializer differences from legacy SpecsIntact:** Minimal header (not table-based), whitespace normalization, hardcoded MTA metadata. These are cosmetic — SIEditor should tolerate them, but interop testing will confirm.
- **Parser validated against full UFGS master set** (690 files, 60 tags). Two known roundtrip edge cases: `32 12 36.26.SEC` and `32 13 13.43.SEC` have `<THD><HL3>text</HL3></THD>` where nested bold boundaries shift (content preserved).
- **TBL blocks are read-only.** Preformatted table editing (contentEditable for whitespace-significant blocks) is a future feature.

### Development Roadmap

**Compliance Engine Tuning — Completed (March 2026):** All 22 items implemented and verified. Static FP rate 3.68% → 0.31%, adversarial accuracy 89.5% → 97.3%, 9/9 success criteria met. Full details in `corpus/results/REPORT.md`.

**Harper.js Grammar FP Reduction — Completed (April 2026):** Unified the corpus runner with the production grammar pipeline (`shouldSuppressGrammarFinding`, shared `ENGINEERING_TERMS`, shared `DISABLED_RULES`). Added filters for all-caps acronyms (2–6 letters), single-letter list labels (`A.`, `F.`), engineering formula notation (`f'c`), prefixed compounds (`non-conforming`, `post-industrial`), and case-insensitive dictionary matching. Disabled the noisy `Formatting` and `Readability` Harper rules (whitespace + long-sentence noise on UFGS text). Result on the clean corpus: spelling FPs 1,466 → 103 (-93%), total grammar findings 2,040 → 297 (-85%), per-block grammar FP rate 56.8% → 6.93%. Spelling recall on the dirty corpus held at 88% (66/75).

**Validation & Deployment:**
16. ~~**Real-world .SEC file testing**~~ — ✅ Done. Parser validated against all 690 UFGS .SEC files. Added TBL (preformatted tables), ATT (attachment marks), THD (table headers), INT (cell fill styles). 12-test UFGS regression suite (`npm run test:ufgs`).
17. ~~**Interop testing**~~ — ✅ Done. SIM-exported .SEC files open in legacy SIEditor (10/10 pass). 17 structural interop tests + 11 reverse import/encoding tests. Serializer enhanced: MTA preservation, verbatim HDR passthrough, table COL WIDTH/ROW HEIGHT fidelity. Binary diff scanner at `tools/interop-scan.mjs`.
18. **User acceptance testing** — have an engineer use SIM for an actual spec editing task to find workflow gaps
19. **Performance profiling** — test with a large spec (1000+ blocks) to identify rendering bottlenecks
20. **Production deployment** — `npm run build` and host (static site, no server needed)
21. **Browser data exfiltration prevention** — prevent spec text from being sent to Google or Microsoft via browser features like Chrome's "Help me write," Edge's Copilot, or enhanced spellcheck. These features transmit selected/typed text to external servers for processing, which is unacceptable for controlled unclassified military construction specifications. Investigate: disabling via `contentEditable` attributes, CSP headers, enterprise browser policies, and `writingsuggestions="false"` / `spellcheck="false"` HTML attributes.

**Future Features:**
- TBL preformatted table editing — contentEditable for whitespace-significant blocks (currently read-only)
- Attachment wizard — ATT mark insertion/validation, similar to Reference Wizard for RID marks
- INT cell background rendering — data extracted but not yet applied to TableBlock.jsx cells
- Multi-file project management — SIM is currently a single-section editor by design
- Monospace preview mode
- User manual / help system — incorporate MarkLegend color key, keyboard shortcuts, feature docs (MarkLegend component preserved in src/components/ for this purpose)

### Test Coverage

| Test File | Tests | Runner | Coverage |
|-----------|-------|--------|----------|
| sec-parser.test.js | 43 | Vitest | Tag extraction, inline marks (incl. ATT), tables, TBL/THD, SPT depth, TAI OPT, ADD/DEL/CHG, NPG, REF blocks, INT styles |
| tailor-profile.test.js | 36 | Vitest | Branch/region/delivery matching, resolution, cleanup |
| sec-serializer.test.js | 39 | Vitest | XML output, SPT wrapping, NTE/OLG grouping, TAI OPT, ADD/DEL/CHG, REF blocks, TBL/ATT roundtrip, CRLF, MTA preservation, HDR passthrough, table widths/heights |
| revisions.test.js | 29 | Vitest | Accept/reject inline + block revisions, batch operations, stats, whitespace collapse |
| cross-ref-validation.test.js | 21 | Vitest | RID extraction from body/ref blocks, unlinked/orphaned detection, SRF extraction |
| compliance-checker.test.js | 23 | Vitest | Scope selection, violation grouping, stats, context extraction, bracket/note exclusion, violation budget/truncation |
| text-diff.test.js | 20 | Vitest | Word-level LCS diff, character-level sub-diff, refinement, HTML stripping |
| mark-patterns.test.js | 18 | Vitest | RID/SRF detection, already-marked skip, overlap handling |
| table-ops.test.js | 17 | Vitest | Add/delete rows/columns, cell update, colspan, merge/split, immutability |
| numbering.test.js | 16 | Vitest | Section numbering, OLI labels, counter resets, overflow |
| search.test.js | 14 | Vitest | Block text search, case-insensitive, multi-match, HTML tag handling, replaceMatchInHtml |
| compliance-ai.test.js | 13 | Vitest | System prompt generation, chunking logic, token estimation, cost calculation |
| undo-redo.test.js | 12 | Vitest | History push/pop, undo/redo, max cap, pause/resume, tcSnapshot capture |
| doc-export.test.js | 12 | Vitest | Word/PDF export generation, UFGS formatting, section structure |
| submittal-register.test.js | 11 | Vitest | SUB mark extraction, SD grouping, classification parsing, paragraph numbers |
| encoding.test.js | 11 | Vitest | Windows-1252 byte mapping, special characters |
| doc-validation.test.js | 11 | Vitest | Structure checks (missing PARTs, ordering), title length, empty blocks |
| block-reorder.test.js | 10 | Vitest | getSectionRange, reorderSection, nested subsection moves |
| bracket-replace.test.js | 9 | Vitest | Bracket detection, grouping, nested brackets, inline marks |
| sec-roundtrip.test.js | 9 | Vitest | Parse -> serialize -> re-parse cycle, TAI OPT/ADD/DEL/CHG/REF roundtrip |
| tree-builder.test.js | 8 | Vitest | Flat->tree conversion, multi-level nesting |
| auto-save.test.js | 7 | Vitest | localStorage save/load/clear, timestamp, comments serialization |
| comments.test.js | 6 | Vitest | Comment report generation, HTML escaping, block ordering |
| compliance-rules.node-test.mjs | 42 | Node | Rule generation, pattern matching, fix functions, false positive regression (19 cases), bracket/note/unit exclusion, FMT-001 removal regression |
| inline-linter.test.js | 19 | Vitest | Text extraction, range creation, highlight management, cursor hit-testing, fix computation, per-block findings |
| grammar-checker.test.js | 10 | Vitest | Harper initialization, violation mapping, dictionary filtering, stale detection |
| nlp-rules.test.js | 37 | Vitest | Passive voice corpus (21 sentences via it.each), FP rate assertion, indicative mood detection, verb conjugation, bracket/note exclusion |
| fix-utils.test.js | 11 | Vitest | Offset-aware replacement: second occurrence targeting, HTML tag skipping, backward compat (undefined offset), edge cases |
| corpus-calibration.node-test.mjs | 5 | Node | Primary rules zero on UFGS, secondary rules >0, FMT-001 absent, note block exemption |
| corpus-precision.node-test.mjs | 3 | Node | Static FP rate <5%, NLP FP rate <20%, note block exemption on clean corpus |
| corpus-recall.node-test.mjs | 3 | Node | Static recall ≥80%, NLP recall ≥60%, grammar recall ≥70% with ID mapping |
| corpus-adversarial.node-test.mjs | 6 | Node | Overall ≥80%, FP traps, true positives, NLP ambiguity, domain jargon, failure documentation |
| ufgs-tag-coverage.node-test.mjs | 4 | Node | All 60 SGML tags accounted for, no parse errors, TBL→tbl blocks, ATT→mark-att spans |
| ufgs-structural.node-test.mjs | 8 | Node | Block count, title presence, valid types, depth ≤10, table structure, ref org, monotonic parts |
| interop.node-test.mjs | 17 | Node | XML declaration, root element, MTA, HDR, SCN/STL/DTE, PRT count, SPT nesting, NTE/OLG grouping, REF structure, TAB structure, TBL roundtrip, inline marks, revisions, encoding, CRLF |
| interop-encoding.node-test.mjs | 11 | Node | Reverse import roundtrip (block count, types), encoding fidelity (windows-1252, CRLF, no BOM), special character preservation |
| editor.spec.js (E2E) | 141 | Playwright | Full UI: keyboard, navigation, slash menu, toolbar, marks, layout, table editing, track changes, cross-ref panel, undo/redo, find & replace, bracket replacement, change case, copy without tags, doc validation, orphaned refs, auto-save, notes toggle, drag-and-drop, comments, sidebar search, Word/PDF export, compliance checker |

**Total: 480 Vitest + 99 Node + 141 Playwright = 720 automated tests**

## Dependencies

**Production:** React 18.3, react-dom 18.3, lucide-react 0.383, harper.js (WASM grammar checker), compromise (NLP)
**Dev:** Vite 8.0, @vitejs/plugin-react 6.0.1, Vitest 4.1, linkedom 0.18 (test DOM polyfill), Playwright (E2E)
