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
- `reference/UFGS_M/` — 689 .SEC files for parser validation
- `tests/e2e/` — Playwright suite: `editor.spec.js` (141 tests) + `collab.spec.js` (10 tests)
- `tests/*.node-test.mjs` — UFGS structural + interop tests (Node runner)
- `corpus/` — 4-corpus test suite (calibration/clean/dirty/adversarial)
- `tools/` — CLI utilities (parse-sec, interop-scan, ui-audit/)
- `CONTEXT.md` — domain glossary (block, transparent tag, TC snapshot, publish path, etc.). Use these names; consult before introducing new terms.
- `docs/adr/` — load-bearing architectural decisions. **Read the relevant ADR before proposing a refactor in its area** (CJS server, y-websocket pin, rules-as-data, snapshot-diff publish path).
- `docs/architecture-review-*.md` — open deepening-candidates backlog from architecture reviews.

## Running

```bash
npm run dev                # Vite dev server at localhost:5173
npm run collab             # Collab WebSocket+HTTP server at 127.0.0.1:1234 (SIM_STORAGE_BACKEND=local writes to server/collab-db/)
npm test                   # Vitest unit tests
npm run test:compliance    # Compliance rule tests (Node runner — NOT Vitest; Vitest OOMs on the regex-heavy engine)
npm run test:e2e           # Playwright E2E (first run on fresh checkout: npx playwright install)
npm run test:corpus        # Corpus precision/recall/adversarial
npm run test:ufgs          # UFGS tag coverage + structural across 690 files
npm run test:interop       # Structural interop (parse/serialize/roundtrip)
npm run audit:init         # Autonomous UI audit (15 test areas via Claude in Chrome MCP)
npm run audit:report       # Markdown report from findings.json
npm run audit:promote      # Promote findings to GitHub issues
npm run test:server        # Server tests (Node runner — node --test --test-force-exit)
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
6. **Source files contain the literal characters `\u200B` (six chars: backslash, u, 2, 0, 0, B) in regex literals** — e.g. EditableBlock.jsx has `replace(/\u200B/g, "")`. When you copy that string through the Edit tool, JSON decodes `\u200B` into the actual zero-width space character (U+200B) and the match fails silently. Anchor your old_string on a different nearby line.
7. **CI-only flakes are timing races.** When a test fails only on a CI runner but passes 10×/10 locally, do NOT keep re-running locally — write a deterministic regression test that forces the race (e.g., manually mutate shared state mid-`await`). See `server/__tests__/collab-server.test.mjs` for the pattern (force-delete the y-websocket docs Map during a slow-storage read to expose the eviction race).
8. **CSP allowlist is a CI gate.** Adding a new remote origin (`connect-src`, `script-src`, etc.) requires updating `ALLOWED_REMOTE_HOSTS` in `src/__tests__/csp.test.js`. Don't delete the test — update it.

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

TC uses a **snapshot-based diff** approach owned by `src/lib/track-changes.js` — a pure reducer over `{ enabled, snapshots, publishSeq }`:

1. **State is opaque.** App reads it via selectors (`isEnabled`, `getSnapshot`, `getPublishableState`, `revisionFlagForCreate`, `revisionFlagForDelete`) and mutates it via verbs (`enable`, `disable`, `acceptInline`/`rejectInline`, `acceptAll`/`rejectAll`, `markBlockCreated`, `applyResolveAtBlock`, `applyRemote`). Don't reach into `state.snapshots` directly — the verbs maintain the invariant `snapshots[id] === getVisibleTextFromHtml(blocks[id].html)` after every touched id, and a property test in `src/lib/__tests__/track-changes.test.js` asserts it.
2. **`onRevisionAction`** is the prop-layer dispatcher used by FloatingToolbar and EditableBlock's del popup; the App-side handler routes it to `tc.applyResolveAtBlock(...)`.
3. **Collab publish.** `publishSeq` is a monotonic counter bumped by every user-driven verb but not by `applyRemote`. App's publish effect compares against `lastPublishedTcSeqRef` to decide "did this change come from us?" — replacing the imperative `tcDirtyRef` flag.
4. **Undo/redo coupling.** `useUndoableBlocks` snapshots `(blocks, tcState)` together as one frame; the hook is agnostic about tcState's shape.
5. **Diff pipeline:** `diffWords()` → `refineWordDiff()` → `diffChars()`. Refinement applies character-level sub-diff to consecutive del→add pairs sharing ≥50% common characters, producing fine-grained marks instead of replacing whole words.
6. **Del elements** have `contentEditable="false"` to prevent caret entry, and `cursor: pointer` for click-to-show popup. Diff annotation (turning the snapshot diff into `<ins>`/`<del>` DOM marks) stays in EditableBlock — the module remains pure and DOM-free.

## Comments Architecture

Comments use a pure reducer module (`src/lib/comments.js`) that owns a **DOM-based highlight + separate metadata store** — same playbook as Track Changes (`d19d37b`):

1. **State is opaque.** App holds it as `commentsState` and reads it via selectors (`size`, `get`, `all`, `isDraft`, `getCreateEntry`, `reconcileBlocks`, `normalizeForLoad`); mutates it via verbs (`createDraft`, `updateCreate`, `reply`, `resolve`, `reopen`, `remove`, `mergeRemote`). Shape: `{ byId: Map<commentId, Comment>, seenRemoteIds: Set<commentId> }`. Verbs return `{ state, publish }`; caller supplies `identity` and `ts`.
2. **Span↔metadata reconciliation is a selector.** App runs `useEffect([blocks, commentsState])` → `setBlocksDirect(prev => cm.reconcileBlocks(prev, commentsState))`. The selector unwraps orphan spans (id missing from state) and reclasses open↔resolved when className disagrees with `state.byId.get(id).status`. Idempotent — returns the original `blocks` ref when nothing changes; React bails out, no loop. Routed through `setBlocksDirect` (the non-undoable setter from `useUndoableBlocks`) so a reconcile after Ctrl+Z cannot wipe the redo stack.
3. **Single collab dispatcher.** `session.dispatchComment(envelope)` switches on `envelope.kind ∈ {create, reply, status, delete}` and forwards to the underlying `*ToDoc` functions. The legacy four session methods (`publishComment`, `publishCommentReply`, `publishCommentStatus`, `deleteComment`) are gone. Verbs that produce no publish (drafts) return `publish: null`.
4. **`mergeRemote` semantics (M2.5).** For each id in `remote ∪ prev.byId`: if id is in remote, remote wins; else if id is in `seenRemoteIds`, drop (peer deletion); else preserve (local draft). `seenRemoteIds` is monotonically non-shrinking — once an id has been observed from peers, its later absence is authoritative.
5. **Editable blocks** persist comment spans in `block.html`. **Ref/table** spans are visually transient (injected into render-only DOM; data stays in `block.ref` / `block.table`); `reconcileBlocks` skips blocks without `html`. Deriving ref/table highlights from metadata is a follow-up.
6. **Active highlight is an attribute.** `CommentPopup` sets `data-active="true"` on the comment span on mount and removes it on unmount; CSS is `.mark-comment[data-active="true"]` (light + dark). Reconcile owns the className exclusively, so an in-flight popup close cannot leave a stale class out of sync with `comment.status`.
7. **Load-boundary shim.** `normalizeForLoad(rawCommentsObj)` runs in `onRemoteComments` and the auto-save restore path. It promotes legacy `author` → `authorName` and `timestamp` (ISO) → `ts` (number); canonical fields take priority. The module never sees legacy fields.
8. **Export:** serializer strips `mark-comment` spans. A sidecar `.comments.json` is saved alongside the `.SEC` file.
9. **File import clears comments** — `loadSECContent()` calls `setCommentsState(cm.createInitial())` so comments from a prior file don't leak.

## Tag Visibility Toggle

The `</>` button toggles `tags-hidden` (default) vs. `tags-visible` on the editor container:

1. **Inline marks:** real `<span contentEditable="false" class="tag-label">` DOM nodes injected by `syncTagLabels()` in EditableBlock. `MARK_TAG_MAP` maps mark classes to SGML names (`mark-rid`→`RID`). TAI marks include `data-opt`. Tag labels stripped from innerHTML via `stripTagLabels()` before saving to state.
2. **Block-level tags:** CSS `::before`/`::after` with `data-tag` attributes on block wrapper `<div>`s (outside contentEditable, no caret issues).
3. **Why real DOM nodes for inline marks:** CSS pseudo-elements don't create caret positions in contentEditable — the browser can't place the cursor between `::before` and the first text character. `contentEditable="false"` spans provide proper DOM boundaries.

## Compliance Checker Architecture

Data-driven rule engine with two tiers:

1. **`ufs-1-300-02-rules.json`** — authoritative rule data extracted from `reference/ufs_1_300_02.pdf`. 36 prohibited terms, 13 prohibited symbols, 21 vague terms, 4 required capitalizations, plus colloquial/redundant/required-practice categories. **Rules are NOT hardcoded in source code.** `buildRules()` derives the runtime rule list from these categories.
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

## Collab Publish Path

Block content reaches the Y.Doc via **snapshot diff**, not a live `Y.Text` binding:

1. `EditableBlock` fires `onUpdate(blockId, html)` from `handleInput` (debounced `PUBLISH_DEBOUNCE_MS = 400`ms, see `src/components/EditableBlock.jsx`) AND `handleBlur` (which also runs Track Changes annotation). Blur cancels any pending input debounce.
2. `App.handleBlockUpdate` calls `setBlocks(prev.map(...))`.
3. The publish effect (`useEffect([blocks, inRoom])` in `src/App.jsx`) calls `session.publishBlocks(blocks)`.
4. `applyBlocksToYDoc` (`src/lib/collab.js`) walks the block array and calls `applyHtmlToYText(yText, html)` per block — this **diffs the new HTML string against the existing Y.Text** and synthesizes Yjs ops to match.
5. `ydoc.on('update')` on the server debounces a flush to R2/local (`server/collab-server.cjs`).

**Implication:** concurrent typing in the same paragraph by two users relies on the diff at publish time, not character-level CRDT ops. Workable for single-user rooms; the architectural fix to a real `Y.Text` ↔ DOM binding is tracked at issue #22. The debounced-input symptom fix landed via #21 / PR #23.

`window.__collab` is exposed in DEV (`import.meta.env.DEV`) for browser-side debugging — gives you `{ ydoc, yOrder, yStore, yMeta, yTc, yComments, awareness, provider, undoManager }`.

**"Connecting to room…" forever?** The collab session effect in `src/App.jsx` is gated on `inRoom && identity`. If `localStorage` has no saved identity, the app shows a name prompt and the WebSocketProvider is never instantiated. Banner persists indefinitely; `/health` shows 0 connections. Fill the name prompt to unblock.

## Storage Backends

Three storage backends are wired: `local` (default, disk under `server/collab-db/`),
`azure` (Azure Blob, see `server/storage-azure.cjs`), and `s3` (S3-compatible
including Cloudflare R2 and MinIO, see `server/storage-s3.cjs`). Selected via
`SIM_STORAGE_BACKEND`. S3 backend uses the `SIM_S3_*` env vars.

## Collaboration Server

Real-time multi-user editing via Yjs + y-websocket. Server lives in `server/`:

- `server/collab-server.cjs` — y-websocket relay. Exposes `createCollabServer({ storage })` factory; CLI entry-point gated by `if (require.main === module)` so tests can `require()` without binding a port.
- `server/http-handler.cjs` — HTTP endpoints (`/rooms`, `/rooms/:id`, `/rooms/:id/sec`, `/rooms/:id/comments`, `/health`, `/rooms/:id/upload`).
- `server/room-serializer.cjs` — extracts .SEC + .comments.json from a Y.Doc on flush.
- `server/storage-{local,azure,s3}.cjs` — pluggable persistence backends.
- `server/auth/auth-provider.cjs` — JWT auth (optional via env).
- `server/__tests__/` — `node --test` integration suite. Run via `npm run test:server`.

**y-websocket v1 is pinned** (Dependabot bump to v3 deliberately deferred). The fix for issue #17 is built around v1 internals — `closeConn` deletes the docs Map entry by NAME (not by instance) when a doc's last conn drops. Upgrading to v3 needs the eviction-guard logic re-validated.

**CJS on purpose:** y-websocket v1 ships its server utils as CJS and `require`s yjs. Mixing ESM and CJS loads two copies of yjs and breaks `instanceof` checks (yjs/yjs#438). The "Yjs was already imported" warning during tests comes from the room-serializer's dynamic `import('../src/lib/sec-serializer.js')` — known and documented; do not "fix" it by switching the server to ESM.

### Two non-obvious patterns

1. **`extractDocName` strips a leading `/ws/`.** `VITE_COLLAB_WS_URL` in production deploys is `wss://host/ws`; WebsocketProvider then connects to `wss://host/ws/<room>`. y-websocket's default extraction (`req.url.slice(1).split('?')[0]`) yields `"ws/<room>"` — sanitized to `ws_<room>.ydoc` in storage. Without `extractDocName`, you get parallel rooms (one HTTP-managed, one WS-managed). See `server/collab-server.cjs:67`.

2. **Stale-close eviction guard.** y-websocket's `closeConn` (`node_modules/y-websocket/bin/utils.js:208`) does `docs.delete(doc.name)` keyed by name when a doc's last conn drops. If a previous WS connection's TCP close drains during a new connection's preload `await`, the stale close evicts our just-loaded doc and `setupWSConnection` creates a fresh empty replacement that bypasses preload — sync step 1 fires with empty state, the client seeds, persisted state CRDT-unions on top, yOrder doubles. Mitigated by re-installing the preloaded doc into `ywsDocs` after the await but before `handleUpgrade`. See `server/collab-server.cjs:350` and the deterministic regression test in `server/__tests__/collab-server.test.mjs`.

### Inspecting / cleaning up production rooms

```bash
curl https://secwriter-collab.onrender.com/health
curl https://secwriter-collab.onrender.com/rooms
curl https://secwriter-collab.onrender.com/rooms/<id>/sec       # SEC export
curl -X DELETE https://secwriter-collab.onrender.com/rooms/<id> # delete corrupted room
```

Frontend at https://secwriter-frontend.onrender.com (Render auto-deploys on push to main).

## Reference Data Sources

- **UMRL** (`src/data/umrl.json`) — Unified Master Reference List. 302 organizations, 4,973 entries. Source: `C:\Program Files (x86)\SpecsIntact 5\UMRL\umrl.ref`. Used by the Reference Wizard.
- **UMSL** (`src/data/umsl.json`) — Unified Master Submittal List. 13,203 submittal entries. Source: same directory, `umsl.lst`. For future submittal wizard.

USACE updates these regularly. To refresh, re-run the parser scripts that generated the JSON.

## Known Parser Edge Cases

Parser validated against all 690 UFGS files (60 tags). Two known roundtrip edge cases: `32 12 36.26.SEC` and `32 13 13.43.SEC` have `<THD><HL3>text</HL3></THD>` where nested bold boundaries shift (content preserved).
