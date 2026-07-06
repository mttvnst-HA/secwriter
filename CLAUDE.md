# SecWriter

A modern web-based editor for UFGS (Unified Facilities Guide Specifications) .SEC files, replacing the legacy SpecsIntact desktop application (SIEditor).

**Issue [#47](https://github.com/mttvnst-HA/secwriter/issues/47) closed by sub-PR 1i-b.2 ([#109](https://github.com/mttvnst-HA/secwriter/pull/109), merged 2026-05-19):** the y-prosemirror substrate migration is fully live, the legacy contentEditable path (EditableBlock.jsx, useBlockBinder.js, useUndoableBlocks.js, VITE_PM_EDITOR flag, FloatingToolbar legacy branches) is retired, and SecWriter is a single PM-based editor.

**Terminology:** "SecWriter" = this web app (previously called "SpecsIntact Modern" / "SIM"; renamed to comply with the legacy SpecsIntact EULA). "SpecsIntact" / "SIEditor" = the legacy Windows desktop application — that name refers only to the legacy product, never to this app.

**Independence:** SecWriter is an independent project. It is not affiliated with, endorsed by, or sponsored by the U.S. Department of Defense, USACE, NAVFAC, NASA, or any other agency or vendor associated with UFGS or SpecsIntact. UFGS and SpecsIntact are referenced by name solely to identify the file format and editing workflow this project addresses.

## Project Context

**What this is:** A rich text editor that reads and writes SpecsIntact .SEC files (XML-based SGML, windows-1252 encoding, used by the U.S. military for construction specifications). The editor feels like Google Docs or Notion while preserving the underlying SGML structure.

**Who it's for:** Engineers (especially geotechnical) who currently use MS Word as a workaround because SpecsIntact's tag-based editing is too clunky. The tool eliminates the Word-to-SpecsIntact round-trip workflow.

**Key design principle:** The engineer should never think about tags or SGML. Enter creates a paragraph. `/` opens a block type menu. Tab promotes/demotes headings. The SGML structure is inferred from context, not selected from a toolbar.

## Orientation

- `src/App.jsx` — main editor layout, state, toolbar, sidebar
- `src/components/` — block components (**PmEditableBlock**, TitleBlock, TableBlock, RefBlock), panels (CompliancePanel, CrossRefPanel, CommentPopup), tooltips, wizards, plus `useBlockLinting.js` (per-block lint lifecycle hook). `PmEditableBlock.jsx` mounts a y-prosemirror EditorView per editable block; the substrate is Y.XmlFragment per slot (with a Y.Text legacy fallback for migrationPartial rooms).
- `src/hooks/` — `useCollabSession.js` (Yjs session lifecycle + the four publish effects + coordination refs)
- `src/lib/` — parsers/serializers (sec-parser, sec-serializer, encoding), pure-reducer modules (`track-changes.js`, `comments.js`, `linting.js`, `compliance.js`), domain-side-effect modules (`compliance-ranges.js`), compliance engines (compliance-rules, compliance-checker, compliance-ai, inline-linter, grammar-checker, nlp-rules), revisions, table-ops, numbering, plus `block-html-store.js` (Y.Doc-as-substrate adapter for block html — Y.XmlFragment with Y.Text legacy fallback for migrationPartial rooms), `pm-schema.js` + `pmdoc-html.js` (PM schema + serializer — used by `PmEditableBlock` and by `yMapToBlock`'s Y.XmlFragment branch in collab.js), `ytext-html.js` (legacy Y.Text ↔ HTML conversion, retained for the migration partial path and load-boundary defenses), `block-registry.js` (App-scoped imperative-handle registry replacing `querySelector('[data-block-id="…"]')` in App), `pm-slash-dismiss.js` (Vitest-friendly slash-menu dismiss helpers — `closeSlashMenuPlugin` forceClose dispatcher + `isBlockJustSlashTrigger` heuristic), and `pm-plugins/` (slash-menu, tag-labels, keymap, relpos-selection — PM plugin set used by `PmEditableBlock`)
- `src/data/` — `ufs-1-300-02-rules.json` (compliance rules), `umrl.json` (reference DB), `umsl.json` (submittal DB), sample spec
- `reference/section.ini` — **authoritative** formatting rules (MARGINS, COLORS, RULES, CODES, FONTS)
- `reference/ufs_1_300_02.pdf` — authoritative source for compliance rules
- `reference/UFGS_M/` — 689 .SEC files for parser validation
- `tests/e2e/` — Playwright suite: `editor.spec.js` + `collab.spec.js`
- `tests/*.node-test.mjs` — UFGS structural + interop tests (Node runner)
- `corpus/` — 4-corpus test suite (calibration/clean/dirty/adversarial)
- `tools/` — CLI utilities (interop-scan, corpus tooling, ui-audit/)
- `CONTEXT.md` — domain glossary (block, transparent tag, TC snapshot, publish path, etc.). Use these names; consult before introducing new terms.
- `docs/adr/` — load-bearing architectural decisions. **Read the relevant ADR before proposing a refactor in its area** (CJS server, Hocuspocus relay, rules-as-data, snapshot-diff publish path, storage atomicity-per-backend).
- `docs/architecture-review.md` — open deepening-candidates backlog from architecture reviews.

## Running

**First-time setup on a fresh checkout:** `npm install` then `npx playwright install` (E2E browsers) before running `npm run test:e2e`.

```bash
npm run dev                # Vite dev server at localhost:5173
npm run collab             # Collab WebSocket+HTTP server at 127.0.0.1:1234 (SIM_STORAGE_BACKEND=local writes to server/collab-db/)
npm test                   # Vitest unit tests
npm run test:compliance    # Compliance rule tests (Node runner — NOT Vitest; Vitest OOMs on the regex-heavy engine)
npm run test:e2e           # Playwright E2E (first run on fresh checkout: npx playwright install)
npm run test:corpus        # Corpus precision/recall/adversarial
npm run test:ufgs          # UFGS tag coverage + structural across 690 files
npm run test:interop       # Structural interop (parse/serialize/roundtrip)
npm run audit:init         # Autonomous UI audit (15 test areas; requires "Claude in Chrome" MCP server attached to Claude Code)
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
6. **Source files contain the literal characters `\u200B` (six chars: backslash, u, 2, 0, 0, B) in regex literals** — e.g. PreformattedBlock.jsx and the sec-serializer / text-diff modules. When you copy that string through the Edit tool, JSON decodes `\u200B` into the actual zero-width space character (U+200B) and the match fails silently. Anchor your old_string on a different nearby line.
7. **CI-only flakes are timing races.** When a test fails only on a CI runner but passes 10×/10 locally, do NOT keep re-running locally — write a deterministic regression test that forces the race (e.g., manually mutate shared state mid-`await`). See `server/__tests__/hocuspocus-server.test.mjs` for the pattern (the prior `collab-server.test.mjs` was deleted with y-websocket in #128; its eviction-race test forced-deletion of the y-websocket docs Map during a slow-storage read). The Hocuspocus equivalents use a two-provider loopback and a slow-storage read that forces `onLoadDocument` to race against a concurrent connect.
8. **CSP allowlist is a CI gate.** Adding a new remote origin (`connect-src`, `script-src`, etc.) requires updating `ALLOWED_REMOTE_HOSTS` in `src/__tests__/csp.test.js`. Don't delete the test — update it.
9. **PM-aware E2E injection routes through `window.__simEditorTestUtils` (1f.7).** Tests that inject block state via `el.innerHTML = '...'; el.dispatchEvent('input')` work in legacy (DOM is the source of truth) but PM's render cycle overwrites the DOM. Use `injectBlockHtml(page, blockId, html)` / `readBlockHtml(page, blockId)` from `tests/e2e/pm-helpers.js` instead. The DEV-only seam is wired in `src/App.jsx` and routes through `handleBlockUpdateWithSync` so the legacy DOM also stays in sync — its substrate→DOM effect skips writes while a block is focused, so a plain `handleBlockUpdate` injection would update React state + substrate but leave the legacy DOM stale, and the next blur would clobber. **1f.9 additions:** `pmSetSelection(page, blockId, from, to)` / `pmGetSelection(page, blockId)` in `pm-helpers.js` drive a PM `TextSelection` from a Playwright test via `getBlockView`. **Task 7 addition:** `getLintingFindings(blockId)` returns the `lintingState.byBlock[blockId]` entry (or `null`) — used by block-type conversion E2E tests to assert stale lint is cleared after a type flip without querying the CSS Custom Highlight API (which produces no queryable DOM nodes). (The `__overrideFlush` / `__isFlushOverridden` seam was retired with the 2026-05-19 `dispatchToolbarVerb` refactor — `dispatchToolbarVerb` is the unit-test surface for the synchronous-flush invariant, no global seam needed.)
10. **Before claiming "no E2E regressions," run the FULL `editor.spec.js` and `collab.spec.js` under `--project=chromium`.** Single-project gate post-1i-b.2; PmEditableBlock is the only editor. Spot-checking specific tests rather than the full suite is how the legacy-mode `snapshotText` regression in PR #95 reached CI — run the whole spec file. **Baseline under `chromium`** is the parallel-load flake set tracked at [#194](https://github.com/mttvnst-HA/secwriter/issues/194) (prior registries [#126](https://github.com/mttvnst-HA/secwriter/issues/126) and [#145](https://github.com/mttvnst-HA/secwriter/issues/145) are both closed; #145's residual inventory carried into #194 after #193 landed). Issue [#114](https://github.com/mttvnst-HA/secwriter/issues/114) (originally `:404` / `:918` / `:1183`, now `:462` / `:1058` / `:1323`) is FULLY resolved — PR #115's `createFreshBlock` + PM-aware waits (`pmSetSelection`, `getBlockCount`) eliminated the create-race. Verified 9/9 isolated (2026-05-20, W=1 repeat=3) AND 9/9 under full-suite parallel load (2026-05-29 per [#145](https://github.com/mttvnst-HA/secwriter/issues/145): 3× full `editor.spec.js` at default 6 workers, all 3 passed every run while 1–13 UNRELATED tests flaked). These 3 are no longer baseline flakes — do not cite them as persistent races. The flake buckets #126 tracked were resolved by: PR #142 (revision-stats addition-count) and PR #143 (`:1209` TC-commit race). To distinguish regression from flake: `git stash`, re-run the failing tests by `--grep` under `--project=chromium`; if they fail at baseline too, it's a flake. Trust isolated runs over the full-suite diff. The "zero persistent failures" claim in `docs/superpowers/notes/1i-a-pm-failures.md` is its 2026-05-16 snapshot — see that file's header for current scope. **`collab.spec.js:176` ("two-tab text sync") is FIXED and live (no longer `test.fixme`) — [#248](https://github.com/mttvnst-HA/secwriter/issues/248) closed, fix in [PR #251](https://github.com/mttvnst-HA/secwriter/pull/251) (2026-06-22).** The old quarantine root cause: `POST /rooms/:id/upload` injects legacy Y.Text html slots into an already-loaded doc, but the v1→v2 substrate broker only ran in `onLoadDocument` (at connect, on the then-empty room), so those slots never migrated to the Y.XmlFragment that PmEditableBlock's ySyncPlugin binds → live edits to upload-seeded blocks didn't sync to peers. Fix: `server/http-handler.cjs`'s upload route now calls `migrateRoom(ydoc, { log })` inline after `seedRoomFromBlocks`, before `flushRoom` (see the "Collab Publish Path" migration-broker invariant above). Don't re-quarantine this test without checking git blame first.
11. **Writing robust PM E2E tests (hardening lessons from [#192](https://github.com/mttvnst-HA/secwriter/issues/192)).** The recurring full-suite flakes are resource-affected (RAFT): they pass in isolation and fail only under parallel pressure.
    - **Reproduce/verify flakes at DEFAULT workers, never oversubscribed.** `--workers=8 --repeat-each=N` (above the ~half-core default) starves the shared Vite+browser and yields 30s timeouts everywhere — *including* `beforeEach` `page.goto` timeouts — that are artifacts, not races. The real gate is the full suite at default workers (Rule #10).
    - **The FloatingToolbar arms off `window.getSelection()`** (on `mouseup` / shift-arrow `keyup`), NOT PM `view.state.selection`. `pmSetSelection`/`pmSetCaret` (programmatic `view.dispatch`) will NOT surface it — a test needing the toolbar must build its selection with real keyboard `Shift+Arrow` presses.
    - **Re-focusing a PM block with `locator(blockSel(id)).click()` stalls on click actionability under load** (the contentEditable div is never "stable" while the page churns → 30s hang). Use `pmSetCaret(page, id, 'end')` — it calls `view.focus()` and places the caret, no actionability wait.
    - **Assert block content via `readBlockHtml(page, id)` (App state), not `locator(...).evaluate(el => el.innerHTML)`** — the DOM read hangs when the PM block element can't be resolved/stabilized under load. Wrap in `expect.poll(...)` to ride the publish debounce.
    - **`injectBlockHtml` can seed inline revision marks directly** — `<del class="mark-del">` round-trips into a PM `revisionDel` mark via the schema `parseDOM` rule (`ins.mark-add` → `revisionAdd` likewise), so a del-popup test can skip the type→blur→AcceptAll→toolbar-mark setup and just inject the mark.
    - Replace fixed `waitForTimeout` + non-retrying `page.evaluate` reducer reads with `expect.poll` (async SHA-256 + React commit isn't guaranteed within a fixed window under load).
12. **React.StrictMode double-invokes effects in dev AND the full E2E suite — it masks production-only effect-ordering bugs.** `main.jsx` wraps the app in `<React.StrictMode>`, so every effect runs mount→cleanup→mount in dev and under Playwright. This hides bugs that depend on single-invoke production ordering — e.g. an UndoManager constructed in an earlier-declared effect capturing a later-declared effect's first write as a phantom undo frame ([#219](https://github.com/mttvnst-HA/secwriter/issues/219)). Verify undo-stack / effect-declaration-order invariants against a **production build** (`npm run build` + preview), not dev or E2E. A passing E2E run is NOT evidence these invariants hold.
13. **`server/__tests__/migrate-pm-substrate.test.mjs` is AT the 30-test cap.** Batch new broker assertions into an existing `it()` (or `it.each`) rather than adding test #31.

## Always Check the .ini Files for Formatting

`reference/section.ini` is the authoritative source for:
- **[MARGINS]** — left/right indent per block type in inches, ABSOLUTE per type (not cumulative with nesting). TXT=0.16,0→15px | OLI=0.50,0→48px | ITM=0.85,0→82px | LST=0.50,0→48px | NPR=0.89,0.89→85px
- **[COLORS]** — inline data element colors (RID=magenta, SUB=blue, ENG=blue, MET=red, etc.)
- **[RULES]** — what tags can nest inside what (the grammar)
- **[CODES]** — tag names, descriptions, and whether TRANSPARENT (inline) or block-level
- **[FONTS]** — font styling per tag

**Read the .ini file before adding or modifying any formatting.** This applies to revision marks (ADD/DEL/CHG), inline data elements, and block styling. Always cross-reference `[COLORS]`, `[FONTS]`, and `[CODES]` before choosing CSS values.

## ProseMirror / y-prosemirror / Yjs — Authoritative Sources

These are the single source of truth for any PM-related design or implementation question (schema, plugins, decorations, commands, transactions, ySyncPlugin behavior, UndoManager semantics). When evaluating a design proposal or writing/reviewing PM code, **check these before relying on intuition, training-data memory, or web blog posts** — PM has subtle behaviors that vary across releases.

| Source | What to look up there |
|---|---|
| [prosemirror.net/docs/ref/](https://prosemirror.net/docs/ref/) | API reference. `state.Plugin`, `state.Transaction`, `state.Transaction.setMeta`, `view.Decoration`, `view.DecorationSet`, `view.EditorView`, `view.EditorProps`, `model.Schema`, `model.Mark`. |
| [prosemirror.net/docs/guide/](https://prosemirror.net/docs/guide/) | Narrative guide. "State" + "Plugins" + "Decorations" + "Commands" sections. The Decorations section is the source for "cache the DecorationSet in plugin state when it's expensive to rebuild." |
| [discuss.prosemirror.net](https://discuss.prosemirror.net) | Marijn Haverbeke (PM author) actively answers. Best for "is this idiomatic?" and edge cases not covered in the docs. |
| [github.com/ProseMirror/prosemirror-{view,state,model}](https://github.com/ProseMirror) | Source. Short and readable. Consult when the docs are ambiguous (e.g. the WebFetch fallback when "does PM memoize X" isn't in the reference). |
| [github.com/yjs/y-prosemirror/blob/master/src/sync-plugin.js](https://github.com/yjs/y-prosemirror/blob/master/src/sync-plugin.js) | ySyncPlugin source. Authoritative for: tr-to-Yjs-op translation, `ySyncPluginKey` origin semantics, `tr.docChanged` handling. The README is incomplete; the source is the truth. |
| [github.com/yjs/y-prosemirror/blob/master/src/keys.js](https://github.com/yjs/y-prosemirror/blob/master/src/keys.js) | `ySyncPluginKey` definition. Use as the transaction-meta key when filtering remote ops in `dispatchTransaction`. |
| [docs.yjs.dev](https://docs.yjs.dev) | Yjs core. UndoManager `trackedOrigins`, transaction origin semantics, `ydoc.transact(fn, origin)` rules, `Y.XmlFragment` API. |

Empirical claims about PM behavior should be pinned by a regression test (e.g. [setblockhtml-echo-behavior.test.js](src/lib/__tests__/setblockhtml-echo-behavior.test.js) pins the "`prosemirrorToYXmlFragment` is NOT a no-op for byte-stable inputs" finding that determined 1g's `onUpdate` gating). If a future PM / y-prosemirror upgrade changes the behavior, the test signals which design assumption to revisit.

**Opting a PM tr out of UndoManager capture:** Set `tr.setMeta('addToHistory', false)` on the PM tr. y-prosemirror's sync-plugin propagates this to the resulting Yjs transaction meta (sync-plugin.js:228 — `tr.meta.set('addToHistory', pluginState.addToHistory)`). Both Y.UndoManagers (`src/lib/collab.js` in-room, `src/hooks/useLocalSubstrateUndoManager.js` out-of-room) are configured with `captureTransaction: tr => tr.meta.get('addToHistory') !== false` to honor it. Mirrors y-prosemirror's own UndoPlugin filter (undo-plugin.js:71). Used by the comment-reconcile path (`src/lib/pm-comments.js`) to keep peer-driven transparent reconciles off the local undo stack.

Pinned PM versions: `y-prosemirror` is held at 1.x (see [ADR-0006](docs/adr/0006-pm-substrate-migration.md)). Don't bump without re-verifying every empirical claim in this repo's PM tests. Hocuspocus packages (`@hocuspocus/server`, `@hocuspocus/provider`, `@hocuspocus/extension-database`) are pinned at exact `4.3.0` — they declare `yjs`/`y-protocols` as peer deps, so the package manager hoists a single copy of `yjs` (single-hoisted-yjs guarantee, see [ADR-0001](docs/adr/0001-server-uses-commonjs.md)). A CI step ("Assert single Yjs instance") fails if a second non-deduped yjs appears. `ws` is now a direct runtime dependency (removed from Hocuspocus in 4.x). `y-websocket` is removed entirely (see [ADR-0018](docs/adr/0018-collab-relay-hocuspocus.md)).

### Tag categories

**TRANSPARENT tags** (inline wrappers, 21): ADD, ATT, BLD, CHG, CTR, DEL, ENG, HL1, HL2, HL3, HL4, HLS, INC, ITA, MET, SBS, SPS, TAI, TST, UND, URL

**Data-driven inline tags:** SUB (submittals→register), SRF (section cross-refs→validate), RID (citations→sync with REFERENCES), TAI (tailoring by branch/region/delivery), ENG/MET (dual unit pairs)

**Block hierarchy:** SEC > PRT > SPT > {TXT, OLG, OLI, LST, ITM, NTE, NPR, NPG, SBM, TAB, TBL (preformatted), TTL, REF}

## Block Focus

Focus routes through `src/lib/block-registry.js`: `focusBlockById(id, { atEnd })` looks up the imperative handle a mounted block registered on mount and either calls into its PM `EditorView` (PmEditableBlock dispatches `Selection.atEnd` / `atStart`) or its DOM `Range` placement (TitleBlock and other contentEditable hosts). Brand-new blocks (`block.isNew=true`) auto-focus from their own mount effect rather than through the registry, so App only falls back to `document.querySelector('[data-block-id="…"]')` when registration hasn't fired yet.

## Blocks Reducer Architecture

See [ADR-0008](docs/adr/0008-blocks-reducer-architecture.md). Every `blocks` mutation routes through `dispatchBlocksVerb` in `src/lib/blocks.js`. Pure verbs return `{ state, effects }` descriptors; the dispatcher owns the preFlush → forceFrame → substrate writes → setBlocks → flush → focus protocol. Two load-bearing details to know cold:

- **`blocksRef.current` is mutated synchronously** alongside `setBlocks` so sequential dispatches in the same event-loop tick (Replace All, Remove All Orphaned) see the latest state mid-loop.
- **Substrate-write origin defaults to `'local-publish'`** (UndoManager-tracked). PM-click paths use `updateBlockHtmlPmSync` (setBlocks only — ySyncPlugin already wrote the substrate).

## Slash Menu → Block Conversion

`handleConvertBlock` creates a block with a **new ID**. This forces a React remount, which triggers the ref callback, which handles focus. Do not try to reuse the old block ID — the ref callback won't re-fire on an existing DOM node.

## Windows-1252 Encoding

.SEC files declare windows-1252 in the XML header:
- **Import:** `FileReader.readAsArrayBuffer()` + `TextDecoder('windows-1252')` — NOT `readAsText()` (defaults to UTF-8).
- **Export:** `encodeWindows1252(xml)` from `src/lib/encoding.js` returns `Uint8Array` with byte mapping for characters 0x80–0x9F (curly quotes, em-dash, euro, trademark, bullet).
- **Server upload:** `server/http-handler.cjs`'s `POST /rooms/:id/upload` decodes the body with `new TextDecoder('windows-1252')` — NOT `body.toString('latin1')`. latin1 is not a superset: bytes 0x80–0x9F are C1 controls in latin1 but printable punctuation in windows-1252, so latin1 silently corrupts smart punctuation to `?` on re-export ([#212](https://github.com/mttvnst-HA/secwriter/issues/212)).

## Track Changes Architecture

See [ADR-0009](docs/adr/0009-track-changes-per-keystroke.md). TC marks are applied per-keystroke via PM's `dispatchTransaction` intercept (1h). The reducer at `src/lib/track-changes.js` is a 70-LOC shell over `{ enabled, publishSeq }`; per-keystroke marking lives in `PmEditableBlock.dispatchTransaction`. Key surfaces to know cold:

- **App-side handler trio.** `handleBlockUpdate` (debounced typing — TitleBlock raw contentEditable) and `handleBlockUpdateWithSync` (MarkSuggestions accept) dispatch `Blocks.updateBlockHtml`. `handleBlockUpdatePmSync` (PM click path: FloatingToolbar inline accept/reject, PmEditableBlock del-popup) dispatches `Blocks.updateBlockHtmlPmSync` (setBlocks only — ySyncPlugin already wrote the substrate).
- **`forceFrame()` pairs with every click-driven `setBlocks`** so the UndoManager closes its capture window before the action. Multi-write gestures (`handleAcceptAll` / `handleRejectAll` / `handleComplianceAcceptGroup`) additionally wrap their N writes in `framing.withUndoFrame(() => { … })`.
- **`publishSeq`** is the monotonic counter that gates the TC publish effect against echoes (replaces the pre-1h `tcDirtyRef` flag).
- **Document-wide TC gestures call `flushAllPendingUpdates()` first** ([#109](https://github.com/mttvnst-HA/secwriter/pull/109) M4) to drain PM's 400ms `onUpdate` debounce before reading `blocksRef.current`.
- **Inline TC mark HTML carries per-author attribution attrs** ([#87](https://github.com/mttvnst-HA/secwriter/issues/87)): `<ins|del|span class="mark-{add|del|chg}" data-author-id="<id>" style="--author-color:<color>">`. Regexes in `src/lib/revisions.js` must use `[^>]*` between the class attr and `>`. The pre-1h shape `<ins class="mark-add">` is the legacy / no-attribution case only.
- **FloatingToolbar PM path** uses `dispatchToolbarVerb` (`src/lib/pm-toolbar.js`) — 6 pure tr-builders with `settlement: 'self' | 'caller-owned'`. PM imports do not leak into the toolbar's call sites.

## Comments Architecture

See [ADR-0010](docs/adr/0010-comments-reducer-dual-reconcile.md). Comments are an opaque reducer (`src/lib/comments.js`) backed by a `{ byId, seenRemoteIds }` shape — DOM-based highlight + separate metadata store. Key surfaces to know cold:

- **`session.dispatchComment(envelope)`** is the single collab seam, switching on `envelope.kind ∈ {create, reply, status, delete}`.
- **Dual reconcile path.** Editable PM blocks: substrate-side `reconcileCommentMarks(view.state, commentsState)` per-block effect, tagged with `COMMENT_RECONCILE_META` so `dispatchTransaction` skips the synthesized input event + `onUpdate` debounce (un-gated would echo via `setBlockHtml('local-publish')` into the UndoManager). Ref/table blocks: derived at render time via `cm.computeCommentSegments(text, blockComments)`. The App-level `useEffect([blocks, commentsState])` html-walk runs `cm.reconcileBlocks` for ref/table. (The skip-PM-blocks `shouldSkip` predicate was removed in 1202e15/#107; the walk now covers all blocks and relies on the reconcile mirror being a redundant write while React html is fresh — a defense that holds today but is incidental, see the [#219](https://github.com/mttvnst-HA/secwriter/issues/219)-adjacent watch item.)
- **`setBlockHtmlSilent`** is the substrate write used by the reconcile mirror — silent origin, NOT tracked by either UndoManager. Keeps peer-driven status flips off the local undo stack.
- **`mergeRemote` semantics (M2.5).** For each id in `remote ∪ prev.byId`: remote wins; if absent but in `seenRemoteIds`, drop (peer deletion); else preserve (local draft). `seenRemoteIds` is monotonically non-shrinking.
- **Active highlight is mode-conditional.** PM blocks: `activeCommentPlugin` emits `Decoration.inline(..., { class: 'mark-comment-active' })`. Ref/table: JSX `data-active="true"` + CSS `[data-active="true"]` selector. `Decoration.inline` wraps a nested `<span>` inside the mark's own `<span>` — active-state CSS must use a descendant combinator (`.mark-comment .mark-comment-active`), not a compound selector.

## Tag Visibility Toggle

The `</>` button toggles `tags-hidden` (default) vs. `tags-visible` on the editor container:

1. **Inline marks:** widget `DecorationSet` from `src/lib/pm-plugins/tag-labels.js` injects `tag-label` decorations alongside each mark span. PM widgets create proper caret boundaries inside contentEditable — CSS `::before`/`::after` pseudo-elements don't (the browser can't place the cursor between `::before` and the first text character).
2. **Block-level tags:** CSS `::before`/`::after` with `data-tag` attributes on block wrapper `<div>`s (outside contentEditable, no caret issues).
3. **TitleBlock** still uses raw contentEditable (not a PM EditorView), but title spans don't carry inline marks, so the widget plugin isn't needed there.

## Compliance Checker Architecture

See [ADR-0011](docs/adr/0011-compliance-rule-engine.md) (and [ADR-0003](docs/adr/0003-compliance-rules-as-data.md) for the rules-as-data decision). Two-tier engine: Tier 1 = `compliance-rules.js` builds ~51 regex rules from `src/data/ufs-1-300-02-rules.json` via `buildRules()` (binary search for bracket exclusion); Tier 2 = `compliance-ai.js` for rules with `fix === null`. State is the `compliance.js` opaque reducer; highlights use the CSS Custom Highlight API via `compliance-ranges.js` (same primitive as linting). Key constraints:

- **`MAX_VIOLATIONS = 2000`** budget; returns `truncated: true` when capped.
- **Lazy fix computation** (`computeItemFix` / `computeGroupFixes` / `computeFormattingFixes`) — pure helpers, React-free testable.
- **Updating rules:** re-extract `ufs-1-300-02-rules.json` from `reference/ufs_1_300_02.pdf`. No code changes needed.

## Inline Linting Architecture

See [ADR-0012](docs/adr/0012-inline-linting-css-highlights.md). Real-time linting via the CSS Custom Highlight API (zero DOM mutation, survives PM re-renders) over three engines: static UFS rules (`compliance-rules.js`, sync, yellow), Harper.js grammar (Web Worker WASM, lazy-loaded ~2-4MB, blue), compromise.js NLP (passive voice + indicative mood, lazy ~210KB, orange). Pure reducer at `src/lib/linting.js` + per-block hook `useBlockLinting.js` + App-level `useEffect([lintingState])` that pushes ranges into `CSS.highlights`. Key surfaces to know cold:

- **Only the focused block is linted** — `lintingState.byBlock` persists findings across blur/focus.
- **Browser exfiltration prevention.** All typing surfaces (contentEditable blocks + every spec/comment input/textarea) spread `{...NO_EXFIL_PROPS}` from `src/lib/no-exfil.js`, disabling `spellCheck`, `writingsuggestions` (Chrome "Help me write" / Edge Copilot), `autoComplete`, `autoCorrect`, `autoCapitalize`, and Grammarly's `data-gramm*`. CSP + `referrer="no-referrer"` + `notranslate` in `index.html` are the second layer. Regression test at `src/lib/__tests__/no-exfil.test.js`. **Do not add a new contentEditable, input, or textarea that accepts spec text without spreading these props and updating the test surface list.**
- **Dedup in the reducer.** `dedupNlpAgainstCompliance` (compliance wins on overlap) and `dedupGrammarAgainstFindings` (grammar suppressed when >50% overlap; static wins because it has UFS citations) are pure helpers, table-testable.
- **`linting.DEFERRED_TO_PANEL`** — empty as of [#160](https://github.com/mttvnst-HA/secwriter/pull/160). TERM-suitable / TERM-any / TERM-should / VAGUE-applicable used to be deferred for sentence-level context; they now run inline via `computeQuoteRanges` (TERM-should) + `computePosSuppression` (TERM-suitable, VAGUE-applicable) in `compliance-rules.js`. `isDeferredRule` is retained as a hook for future deferrals.
- **Compliance panel collision.** When `CompliancePanel` is open, App dispatches `linting.setSuspended(state, true)` — `getRangesByTier` empties; no prop wiring.
- **Note block exemption:** notes skip compliance + NLP (advisory language). Grammar/spelling still runs.
- **Toggle persistence:** `secwriter-inline-linting` in localStorage.

## Corpus Testing Infrastructure

Three text-analysis engines measured against real UFGS text using a 4-corpus suite:

1. **Calibration** (`corpus/calibration/`) — 2,583 raw UFGS blocks from 5 sections. Validates primary rules (shall, should) produce zero hits on unmodified master text.
2. **Clean** (`corpus/clean/`) — same blocks rewritten by Claude Opus to full UFS 1-300-02 compliance. Every finding is a false positive. Measures precision.
3. **Dirty** (`corpus/dirty/`) — 644 blocks with 653 labeled injected violations. Measures recall per rule.
4. **Adversarial** (`corpus/adversarial/`) — 156 edge cases (FP traps, NLP ambiguity, domain jargon). Measures robustness.

**Regenerating results:** `node --import ./tools/json-loader.mjs tools/run-corpus-test.mjs --corpus clean` (or `dirty`, `calibration`, `adversarial`). Adversarial delegates to `tools/score-adversarial.mjs` since its shape is pass/fail per entry, not a findings list. Then `node tools/generate-report.mjs` for REPORT.md + metrics.json.

**Baseline (June 2026, harper.js 2.0 — stale, package.json now pins 2.4.0 post-#226, corpus not re-run):** Static recall 92.1%, NLP recall 67.5%, Grammar recall 65.6%. Static FP rate 0.35%. Adversarial accuracy 100% (adversarial.json v2.2.1). Full report: `corpus/results/REPORT.md`. Re-run `npm run test:corpus` against 2.4.0 before trusting these numbers.

The Grammar drop from the March 2026 baseline (78.4% → 65.6%) tracks the harper.js 1.12 → 2.0 bump in [#57](https://github.com/mttvnst-HA/secwriter/pull/57); 2.0 retired several rule categories and tightened agreement detection (GRAMMAR-Agreement recall: ~56% → 38%). The tradeoff is an 86% reduction in grammar FPs on the calibration corpus (2251 → 279 findings on 2,583 raw UFGS blocks), which is the more impactful axis for spec text where FPs vastly outnumber TPs. New 2.0 lint kinds (`Typo`, `Usage`) are evaluated in `DISABLED_LINT_KINDS` in `src/lib/grammar-checker.js`. Adversarial accuracy dropped 97.3% → 92.7% after harper 2.0 because post-March compliance rule tightening (COLLOQ-head's `head pressure` / `head loss` / `shower head` exclusions, SYM-and's uppercase/digit skip) made eight `shouldFlag` expectations in `corpus/adversarial/adversarial.json` stale; refreshed 2026-05-22 (v2.2.0) → 98.1%. The last 3 engine recall misses (ADV-038 passive `manufactured`, ADV-065 `Suitable for the…`, ADV-066 `Properly aligned…`) were fixed in [#165](https://github.com/mttvnst-HA/secwriter/pull/165), [#166](https://github.com/mttvnst-HA/secwriter/pull/166), and [#167](https://github.com/mttvnst-HA/secwriter/pull/167) → 100%. Static recall 86.9% → 89.6% came from broadening TERM-properly to the adjective form (`proper`); 89.6% → 92.1% came from matching bare clause-final `as required` in TERM-as-necessary (source-anchored uses like "as required by ASTM…" stay unflagged; cost: 2 clean-corpus FPs).

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

Post-#46 (sub-PR 1b), block **html** and block **scalars** travel separate paths. See [ADR-0004](docs/adr/0004-collab-publish-snapshot-diff.md). Sub-PR 1d (#47, [ADR-0006](docs/adr/0006-pm-substrate-migration.md)) swapped the html slot from Y.Text to Y.XmlFragment with a server-side migration broker; the remaining character-level work (EditorView mount + per-keystroke ops) is tracked at issue #47 sub-PRs 1e+.

**Html path (per PM keystroke, via ySyncPlugin):**
1. `PmEditableBlock` mounts an `EditorView` per editable block. y-prosemirror's `ySyncPlugin` binds the view to the block's Y.XmlFragment in `yStore.get(blockId).get('html')`; each PM transaction translates directly into Yjs ops on the fragment (origin `ySyncPluginKey`). No debounce on the substrate path — keystrokes hit Yjs synchronously.
2. A debounced `onUpdate` (400ms `setTimeout` in `PmEditableBlock.jsx`) syncs the serialized html back to App's `blocks` array via `handleBlockUpdate` so non-PM consumers (compliance scanner, exports) see the latest content. The substrate write inside `handleBlockUpdate` (`setBlockHtml`, origin `'local-publish'`) is still needed because TitleBlock + MarkSuggestions author HTML outside any PM view; PM-side it produces a byte-stable echo op the UndoManager merges into the same frame.
3. Read pathway: `getBlockHtml(yStore, blockId)` derives html via `pmFragmentToHtml` for Y.XmlFragment slots and falls back to `yTextToHtml` for legacy Y.Text slots (migrationPartial rooms).
4. Server persistence is now `SecWriterDatabase.store` (debounced `onStoreDocument`, 500ms / 10s max) — not a y-websocket `ydoc.on('update')` timer. Server-side `yMapToBlock` (in `src/lib/collab.js`) branches on duck-type — `pmFragmentToHtml(yXmlFragment)` for v2 slots, `yTextToHtml(yText)` for legacy. Without the branch, .SEC export would coerce `String(yXmlFragment)` and silently corrupt every migrated block (Q24/B3).

**Scalar/structural path (still publishBlocks):**
- `App.handleBlockUpdate` calls `setBlocks(prev.map(...))`. The publish effect inside `useCollabSession` calls `session.publishBlocks(blocks)` after the `sessionReadyRef` and `lastRemoteBlocksRef` echo guards pass.
- `applyBlocksToYDoc` (`src/lib/collab.js`) walks the block array and reconciles structure (yOrder, yStore keys, scalar fields). It **skips html for existing slots** — only seeds html for brand-new blocks. The PM EditorView's ySyncPlugin owns html updates for everything else.

**Coordination lives in the hook, not App.** `useCollabSession` owns the session lifecycle, all four publish effects (blocks, meta, TC, comments dispatch), all coordination refs (`sessionReadyRef`, `metaReadyRef`, `lastRemoteBlocksRef`, `lastPublishedTcSeqRef`, `publishDisabledRef`), the `DocSizeLimitError` toast latch, and the cursor broadcast. App passes a prop bag of remote-event callbacks (`onBlocksReceived`, `onMetaReceived`, `onTcReceived`, `onCommentsReceived`, `onPresenceChange`, `onStatusChange`) and reads back `{ dispatchComment, markTcSeqApplied, tryUndo, tryRedo, canUndo, canRedo, clearStack }`. The TC echo gate is a small protocol seam: App's `setTcState` updater calls `markTcSeqApplied(next.publishSeq)` after `tc.applyRemote(...)` so the publish effect treats the new state as already-seen by peers.

**Non-obvious invariants (load-bearing, easy to break):**
- **`yStore` is null until first sync.** `useCollabSession` only calls `setYStoreState(session.yStore)` from inside `if (meta?.initial)` (`fbc0d0f`). Until then `PmEditableBlock`'s mount-time substrate subscription resolves to null and the view stays unmounted, and every direct `setBlockHtml(activeYStoreRef.current, ...)` caller in App must null-guard. Without this gate, a keystroke landing in the sync window CRDT-merges on top of the server's persisted state — the eee8977 corruption pattern via the new direct-substrate path. (The `onSynced` → `connected` status transition is the Hocuspocus equivalent of the old y-websocket `handleSync` signal; the null-guard timing is unchanged.)
- **The Yjs UndoManager tracks `'local-publish'` AND `ySyncPluginKey`.** `setBlockHtml` writes use `'local-publish'`; y-prosemirror's per-keystroke ops use `ySyncPluginKey`. New code that mutates html outside a PM EditorView must go through `setBlockHtml` (not `applyHtmlToYText` or `prosemirrorToYXmlFragment` directly) or undo coverage is silently lost. App.jsx has many direct call sites (revisions, compliance fixes, search/replace, accept-all, etc.); follow that pattern. The comment-reconcile mirror uses `setBlockHtmlSilent` (a distinct origin, NOT tracked) so peer-driven reconciles stay off the local undo stack. The in-room manager lives in `createCollabSession` (`src/lib/collab.js`); the out-of-room manager lives in `useLocalSubstrateUndoManager` (`src/hooks/useLocalSubstrateUndoManager.js`). Both must stay in trackedOrigins lockstep or Ctrl+Z drifts between modes — the integration test `src/lib/__tests__/word-boundary-undo.test.js` ("hello world. → 3 frames") catches a drop of `ySyncPluginKey`.
- **`'migrate-v2'` is the broker-only origin.** Server-side migration writes (1d) use it. It is deliberately NOT `'local-*'` (so `handleAfterTx` in `collab.js` does NOT filter it — the first v2 client to join sees the migrated state via the normal sync path) and NOT `'local-publish'` (so the client-side UndoManager cannot Ctrl+Z a peer's pre-migration content). Don't reuse this origin for any write that originates on a client.
- **The migration broker only runs in `onLoadDocument` (once per room load, warm doc) — any path that mutates a LIVE in-memory doc must migrate seeded slots itself (#248).** `seedRoomFromBlocks` (upload route) writes legacy Y.Text html slots and clears the migration sentinels; pre-#128 the y-websocket relay re-ran the broker "on the next WS upgrade," but Hocuspocus never re-fires `onLoadDocument` after an in-memory upload, so the Y.Text slots stay unbound by `PmEditableBlock`'s ySyncPlugin (binds Y.XmlFragment) and live edits never sync. `POST /rooms/:id/upload` (`server/http-handler.cjs`) calls the pure `migrateRoom(ydoc, { log })` inline after `seedRoomFromBlocks`, before `flushRoom`. Use `migrateRoom` directly, NOT `migrationCoordinator.ensureMigrated` — the coordinator's per-docName cache short-circuits as `alreadyV2` after the empty first load. Pinned by `tests/e2e/collab.spec.js` "two-tab text sync" + the `http-endpoints.test.mjs` upload-migration assertion.
- **`ySyncPluginKey` is the PM-driven origin.** y-prosemirror's `ySyncPlugin` writes Yjs ops with origin `ySyncPluginKey`. It is distinct from `'local-publish'` — PM-driven keystrokes carry this origin; debounced echo writes via `setBlockHtml` (from `handleBlockUpdate`'s 400ms onUpdate flush) carry `'local-publish'`. Both UndoManagers track BOTH so per-keystroke PM edits enter the stack (gated by the word-boundary-undo plugin's `forceFrame` for word-grain framing, matching Word/Notion). Within the 500ms captureTimeout, the PM op and its echo-back `'local-publish'` op join the same undo frame, so one Ctrl+Z reverts both correctly. App-side routing: Ctrl+Z → `collab.tryUndo` (in-room) → fall through to `localUndo.tryUndo` (out-of-room). No third tier.
- **`COMMENT_RECONCILE_META` is a PM-meta sentinel, NOT a Yjs origin (1g).** Defined in `src/lib/pm-comments.js` as `export const COMMENT_RECONCILE_META = {}` (sentinel object — identity-compared). Set via `tr.setMeta(COMMENT_RECONCILE_META, true)`. `dispatchTransaction` in `PmEditableBlock.jsx` reads it via `tr.getMeta(COMMENT_RECONCILE_META) === true` and skips the synthesized `'input'` event (linter) + `onUpdate` debounce (no `setBlockHtml` echo). The corresponding Yjs op produced by ySyncPlugin still uses origin `ySyncPluginKey` — the meta only governs PM-side filtering, not the substrate write path. Don't conflate this with a Yjs origin like `'local-publish'`.
- **`TC_RESOLVE_META` is the TC-resolution sentinel (#96 fix).** Defined in `src/lib/pm-tc-mark.js` as `export const TC_RESOLVE_META = {}`. Set centrally by `applyInlineRevisionResolveTr` (`src/lib/pm-toolbar.js`) on every resolution tr it builds, so all three resolution callers (FloatingToolbar inline accept/reject, App context-menu accept/reject-change, `pm-del-popup.js`'s `dispatchDelAction`) carry it without per-caller tagging. `dispatchTransaction` reads `tr.getMeta(TC_RESOLVE_META) === true` and skips ONLY `rewriteForTrackChanges`; the synthesized `'input'` event and `onUpdate` debounce still fire because the doc text genuinely changed (linter and React state must see it). Without this gate, the delete-range branches misbehave under TC: accept-del dispatches `tr.delete(from, to)` over a `revisionDel`-marked range and the rewriter silently no-ops it, and reject-add over a PEER's `revisionAdd` gets wrapped in `revisionDel` instead of deleted (`collectDeleteSegments` only treats own-author `revisionAdd` as 'cancel'; everything else is 'mark'). Pinned by `src/components/__tests__/PmEditableBlock-tc-resolve.test.jsx` (del-popup accept + toolbar-shaped peer reject-add).
- **Nested CRDT slots must be skeleton-then-populate.** Every nested shared type MUST be attached to its parent (`yMap.set('html'|'table'|'ref', yChild)` or `yStore.set(id, yMap)`) BEFORE any operation reads its children. Covers BOTH the Y.XmlFragment html slot AND the nested Y.Map table/ref slots. Same warning string for two trigger paths (`"Invalid access: Add Yjs type to a document before reading data"`):
  - (a) Y.XmlFragment via `prosemirrorToYXmlFragment(pmNode, yXml)` — y-prosemirror's diff-and-merge calls `toArray()` internally (issue #77, PR #81).
  - (b) nested Y.Map via `tableToYStructure(yTable, …)` — clears existing keys via `[...yMap.keys()]`, which Yjs's `createMapIterator` gates on `parent.doc` (issue #83, PR #84).

  Y.Map's `set` / `delete` are SAFE on detached maps (use `_prelimContent`) — that's why the ref CRDT path doesn't empirically warn even when constructed bottom-up (uses only `set`/`delete`, never `keys()`). Default sample × 3 tables = 3 warnings; under PR #51's CI flake conditions the y-prosemirror flood was hundreds, overwhelming Chromium → Playwright IPC and producing browserContext timeouts. Enforcement sites:
  - `src/lib/collab.js` — `blockToYMapSkeleton` (creates empty fragment + empty table/ref Y.Maps) + `populateBlockHtml` (html) + `populateBlockTableRef` (table/ref), all called after `yStore.set`. `updateYMapFromBlock`'s legacy-string-or-new branches likewise `ymap.set(...)` the fresh nested Y.Map BEFORE invoking the structure builder.
  - `src/lib/block-html-store.js` — `seedHtmlSlot` does `yMap.set('html', yXml)` before populating.
  - `src/lib/ytable-crdt.js` — same invariant at every nested level (yRows / yRow / yCell / cell-text Y.Text).

  Origin commits: CI flake fix `f74cbb8`; table/ref extension landed in PR #84.
- **Block focus goes through `block-registry`, not `querySelector`.** App's `focusBlock(id, atEnd)` calls `focusBlockById(id, { atEnd })` from `src/lib/block-registry.js`. `PmEditableBlock` and `TitleBlock` both register an imperative handle on mount: PmEditableBlock dispatches `Selection.atEnd` / `atStart` against its `EditorView`; TitleBlock places a DOM `Range`. App falls back to `document.querySelector('[data-block-id="…"]')` only when registration hasn't fired yet (e.g. brand-new `block.isNew=true` before its mount effect runs).
- **PmEditableBlock subscribes to the html SLOT reference via `useSyncExternalStore + subscribeBlock` (1f.5 mount race + 1i-b.2 broker-swap fix).** Two distinct races. (1) **Mount race:** Child useEffects fire before parent useEffects in React's commit phase, so PmEditableBlock's mount runs BEFORE App's seed effect (`applyBlocksToYDoc` out-of-room, `useCollabSession`'s publish effect in-room). For new blocks (Enter / slash-convert), `yStore.get(block.id)` returns undefined and the mount bails — yStore identity is unchanged after seeding so deps don't re-trigger. (2) **Broker swap:** The 1d server-side migration broker swaps the slot from Y.Text → Y.XmlFragment via `yMap.set('html', frag)`, which does NOT change the outer yMap identity — if the snapshot returned the yMap, `Object.is` would dedupe and the migration-partial banner would stick forever. The snapshot returns the inner html slot reference so both transitions are observable; `yMapBound = yStore?.get(block.id) || null` is derived inline each render for the EditorView's binding and is referentially stable across PM keystrokes (so the mount effect does not re-fire on every render). Tests: `src/components/__tests__/PmEditableBlock-mount-race.test.jsx`, `src/lib/__tests__/migration-partial-banner.test.jsx` (broker-swap regression).
- **PM `dispatchTransaction` uses `this`, not the outer `view` const (1e regression, fixed #61).** y-prosemirror's `ySyncPlugin` dispatches its initial-sync transaction synchronously from `view(editorView)` during the `EditorView` constructor — before `const view = new EditorView(...)` is assigned. `view.state.apply(tr)` TDZs. PM invokes `dispatchTransaction.call(view, tr)`, so `this` is bound on every call including the in-constructor one. Pinned by `src/lib/__tests__/pm-editor-mount.test.js` (positive + bug-shape counter-test).
- **PmEditableBlock auto-focuses `block.isNew` on first mount (1f.7).** Block-creation flows (handleEnterKey, slash-convert) rely on the editor mount placing the caret — PM dispatches `view.focus()` + `Selection.atEnd`. Gated by `hasAutoFocusedRef` so a later `yMapBound` flip (1d migration broker) doesn't steal focus on a block whose `isNew` was never explicitly cleared. Without this, `createFreshBlock` in Playwright returns the OLD block's locator and every downstream test branches on the wrong block.
- **Slash-menu dismiss is two-layer (forceClose meta + React state).** Closing the menu via React state alone leaves the plugin's `slashMenuPluginKey` state at `{open: true}`; the next doc-changing transaction re-projects open=true back into React via `dispatchTransaction`'s state-mirror block, so the popup bounces back on the next keystroke. Dismiss paths (Escape, outside-click, inside-click, window scroll) must `view.dispatch(view.state.tr.setMeta(slashMenuPluginKey, 'forceClose'))` so the plugin state resets too. `pm-slash-dismiss.js` exports `closeSlashMenuPlugin(view)` as the canonical seam; new dismiss paths should call it (not `setSlashState` alone). Outside-click and Escape additionally delete the block when `isBlockJustSlashTrigger(view)` is true (block contents are only the `/<filter>` trigger); inside-click converts to a fresh empty paragraph via `onConvertBlock(id, 'txt')`. Pinned by `src/lib/__tests__/slash-menu-plugin.test.js` ("forceClose meta resets state to closed without mutating doc") and `src/lib/__tests__/pm-slash-dismiss.test.js`.
- **PM paste is plaintext-only by design (#99).** `PmEditableBlock`'s `handlePaste` EditorProp discards `text/html` and the parsed `slice`, runs `event.clipboardData.getData('text/plain')` through `sanitizePasteText` (`src/lib/paste-sanitize.js`), and dispatches `tr.insertText`. Without it, PM's default `clipboardParser` materializes any DOM matching the schema's `parseDOM` rules — `pm-schema.js` accepts generic `<b>`/`<strong>` for `bold`, so rich text from Word survives as schema marks. Two paste paths must stay in lockstep: `TitleBlock.onPaste`, `PmEditableBlock.handlePaste` — both import from the same `paste-sanitize.js` module. Adding a third `contentEditable` or PM EditorView that accepts spec text must wire one of these handlers. TC mode interaction is automatic — the dispatched `insertText` passes through `dispatchTransaction` and `rewriteForTrackChanges` wraps the inserted text in `revisionAdd`. Pinned by `src/lib/__tests__/pm-editor-paste.test.js`, which invokes the configured prop directly via `view.someProp('handlePaste', f => f(view, mockEvent, null))` — no jsdom event-dispatch ceremony needed; pattern is reusable for any future PM EditorProp test.

**`'migration-partial'` connection state is editable + sticky.** App's `collabReadOnly` formula explicitly excludes `'migration-partial'` (room stays editable per ADR-0006), and `useCollabSession.migrationPartialRef` re-pins the status on every subsequent `'connected'` transition so a trailing `onSynced` doesn't clobber the banner. Don't add the state to the read-only set; don't drop the sticky pin.

**Playwright WHATWG URL pitfall.** Don't try `baseURL: '.../?pm=1'` for any project-level option toggle — `new URL('/', '.../?<query>')` drops the search component (per WHATWG URL), so `page.goto('/')` resolves with no query. If a future flag flip needs project-level differentiation, use a fixture that calls `context.addInitScript` to set a window property pre-load (the `forcePmEditor` fixture used this pattern before its retirement in 1i-b.2 — `git log -- tests/e2e/fixtures.js` recovers it).

**PM plugin module set.** `src/lib/pm-plugins/` contains:
- `slash-menu.js` — PM `Plugin` with `{open, filter, fromPos}` state; popup is the React `SlashMenu.jsx`, portal-mounted at `document.body` with `position: fixed`, anchored via `view.coordsAtPos(fromPos)`. The PM editor's contentEditable carries combobox ARIA (`role=combobox`, `aria-activedescendant`); the menu carries `role=listbox` (combobox-with-listbox-popup pattern). Hover is parent-routed via `onHoverChange` → `selectedIdx` so arrow keys advance from the hovered row (single source of truth for highlight). Three dismiss paths route through `pm-slash-dismiss.js`: Escape (PM keymap), document-level mousedown listener (capture-phase, gated on `slashState.open`), and click-inside-block. Plugin accepts a `forceClose` meta so dismiss paths can close the plugin without mutating the doc — see the two-layer dismiss invariant below.
- `tag-labels.js` — widget `DecorationSet` for inline mark labels. Pseudo-elements don't create caret positions inside contentEditable, but widget decorations do.
- `keymap.js` — Enter / Shift+Enter / Tab / Shift+Tab / Backspace-on-empty / ArrowUp-at-start / ArrowDown-at-end → callbacks supplied by `PmEditableBlock`.
- `relpos-selection.js` — Y.RelativePosition save/restore via y-prosemirror's binding-aware `getRelativeSelection` (save) and `relativePositionToAbsolutePosition` (restore). A binding is required — without one, `saveSelection` returns `null` and `restoreSelection` returns `false`. The previous `Y.createRelativePositionFromTypeIndex` fallback was removed because it anchored against the fragment's child slots while the restore path read `absPos.index` as if it were a PM offset, producing silent off-by-one selections.
- `active-comment.js` — singleton `activeCommentId` plugin state; inline `Decoration` applies `mark-comment-active` class to the matching `comment` mark range. Imperative setter `setActiveComment(view, commentId)` via meta dispatch. Same-id meta short-circuit + DecorationSet cache rebuilt only on `tr.docChanged || activeCommentId changed` per PM guide Decorations section.

**`Decoration.inline` wraps in a nested `<span>` inside the mark's own `<span>` — it does NOT merge classes onto the parent.** Active-state CSS must use a descendant combinator (`.mark-comment .mark-comment-active`), not a compound selector (`.mark-comment.mark-comment-active`). `editor.css` ships both forms; the compound version is dead but harmless and matches what readers expect. Same pattern applies to any future inline decoration layered over an existing PM mark.

The `NO_EXFIL_PM_ATTRS` constant in `PmEditableBlock.jsx` is the lowercase-HTML translation of `NO_EXFIL_PROPS` (`spellCheck` → `spellcheck`, etc.) wired into PM's `EditorProps.attributes`; both sets are pinned by `src/lib/__tests__/no-exfil.test.js`.

`window.__collab` is exposed in DEV (`import.meta.env.DEV`) for browser-side debugging — gives you `{ ydoc, yOrder, yStore, yMeta, yTc, yComments, awareness, provider, undoManager, publishBlocks, publishMeta, publishTc, dispatchComment, setCursor, undo, redo, canUndo, canRedo, destroy }`.

**"Connecting to room…" forever?** `useCollabSession`'s lifecycle effect is gated on `inRoom && identity`. If `localStorage` has no saved identity, the app shows a name prompt and the `HocuspocusProvider` is never instantiated. Banner persists indefinitely; `/health` shows 0 connections. Fill the name prompt to unblock.

**"WebSocket is closed before the connection is established" warning in dev?** Benign React.StrictMode artifact, NOT a bug. `main.jsx` wraps the app in `<React.StrictMode>`, which intentionally double-mounts every effect (mount → cleanup → mount) in development to surface effect bugs. The first `useCollabSession` mount opens a `HocuspocusProvider`, the cleanup calls `provider.destroy()` (closing the WS before the connection completes), and the second mount opens a fresh one that stays open. Chromium's native WebSocket implementation logs the warning for the aborted first attempt. Verify the actual state via `window.__collab.provider.status === 'connected'` (or `.isSynced === true`) and `window.__collab.yOrder.length` (should match the persisted room). Does not occur in production builds. Do not "fix" by removing StrictMode.

## Storage Backends

See [ADR-0013](docs/adr/0013-storage-backends.md) (and [ADR-0005](docs/adr/0005-storage-adapter-atomicity-per-backend.md) for the per-backend atomicity decision). Three backends are wired and selected via `SIM_STORAGE_BACKEND`: `local` (default, disk under `server/collab-db/`), `azure` (Azure Blob, multi-instance safe via `.ydoc` blob lease), `s3` (S3-compatible including Cloudflare R2 + MinIO, configured via `SIM_S3_*` env vars). All extend `RoomStorageBase` (`server/room-storage.cjs`) — the base owns the public methodset by composing seven adapter primitives + three name-parsing hooks; shared `sanitize()` and `ARTIFACT_CATALOG` (`.ydoc` LAST = source of truth) live in `server/storage-shared.cjs`. Key constraints:

- **Adding a fourth artifact is a one-line catalog edit;** adapters never decide write order.
- **`SIM_LOCAL_STORAGE_DIR`** (PR [#113](https://github.com/mttvnst-HA/secwriter/pull/113)) overrides the default `server/collab-db/`. Playwright's `webServer.env` points it at `server/collab-db-e2e/`; `tests/e2e/global-setup.js` wipes that dir with a hard guard that refuses any path not ending in `-e2e` — dev rooms in `server/collab-db/` are never touched by an E2E run.
- **Cross-backend contract** verified by `server/__tests__/storage-contract.test.mjs` (one shared assertion set × 3 backends, 20 tests each). `listArchivedRooms` returns `{ id, archivedAt }` uniformly — both fields required by the collab-server sweep.
- **Composite key + ACL sidecar (#211 + graded roles #239, [ADR-0017](docs/adr/0017-room-authorization-model.md)).** Adapters key on `(tenant, roomId)`, not a bare id; under auth=none everything lives under the reserved `_public` tenant. A fourth artifact `.acl.json` = `{ ownerId, roles: { "<sub>": "viewer"|"editor" } }` (#239 shape; #211's `{ ownerId, sharedWith[] }` is still read via `roleOf()`, each `sharedWith` entry → `editor`, so no data-migration script) is catalogued BEFORE `.ydoc` (crash mid-create/delete leaves a reclaimable orphan ACL → 404, never an ownerless ydoc); read via `readAcl(tenant, roomId)` before any doc load, written via `writeAcl` (share route) / `writeAclIfAbsent` (POST /rooms — an atomic conditional-put claim so concurrent creates of one id resolve to exactly one 201, never a silent ownership transfer). Legacy flat rooms — ACTIVE and ARCHIVED (pre-tenant archive keys are invisible to the tenant-scoped parsers: unrestorable, never swept) — relocate automatically at boot under auth=none (into `_public`); under auth, run `server/migrate-tenant-namespace.cjs` (`SIM_DEFAULT_TENANT` + `SIM_DEFAULT_OWNER`; all three backends via `storage-factory.cjs` + `RoomStorageBase.migrateLegacyFlatRooms`).

## Collaboration Server

See [ADR-0018](docs/adr/0018-collab-relay-hocuspocus.md) (Hocuspocus relay), [ADR-0014](docs/adr/0014-collab-server-yjs-relay.md) (amended historical patterns), [ADR-0001](docs/adr/0001-server-uses-commonjs.md) for CJS, [ADR-0017](docs/adr/0017-room-authorization-model.md) for auth. Real-time multi-user editing via Yjs + Hocuspocus v4. Server lives in `server/`:

- `server/collab-server.cjs` — Hocuspocus relay. `buildHocuspocus({ storage })` factory mounts a bare `Hocuspocus` class on `http.createServer` (NOT the `Server` HTTP wrapper). The upgrade handler pumps: `conn.on('message', d => clientConnection.handleMessage(...))` + `conn.on('close', ...)`. CLI entry gated by `if (require.main === module)` so tests can `require()` without binding a port.
- `server/secwriter-database.cjs` — `SecWriterDatabase`: a `@hocuspocus/extension-database` subclass. `store()` runs the full `room-serializer.serializeRoom` (.ydoc + .SEC + .comments + .lint), enforces the 8 MB pre-serialize cap, tracks `roomHealth.persistFailures`, and guards per-key re-entrancy via `_storeChains` (no two overlapping stores race the same key into S3/Azure). `fetch()` splits the composite `documentName` and returns stored bytes or null. `drain()` loops with a `setImmediate` yield at the top of every iteration to close the lost-write window at SIGTERM.
- `server/hocuspocus-auth.cjs` — `onAuthenticate` handler. Validates `documentName` (client-supplied, in-band via the provider `name`), derives tenant from the JWT, rejects any `documentName` whose tenant-half ≠ token tenant, runs `checkPrincipal` + `sanitize`, and gates on the `.acl.json` sidecar. Runs under BOTH auth modes (under auth=none everything is `_public`). A rejection throws a plain `Error('Unauthorized')` so revocation produces ZERO storage fetch and happens BEFORE `onLoadDocument`. **#239 viewer gate:** it resolves the caller's role and returns `readOnly: role === 'viewer'`; the `collab-server.cjs` wrapper sets `data.connectionConfig.readOnly = true` for viewers — the onAuthenticate-payload key Hocuspocus's `Connection` ctor + the Authenticated-scope message actually read (there is NO `data.connection` on the payload; mutating it is a silent no-op — the shipped-then-fixed bug, pinned by `hocuspocus-server.test.mjs` Test 3b through the production wrapper) — after which Hocuspocus rejects (does not sync) that connection's doc ops — the WS-layer write denial. The provider surfaces the scope to the client via its `authenticated` event.
- `server/http-handler.cjs` — HTTP endpoints (`/rooms`, `/rooms/:id`, `/rooms/:id/sec`, `/rooms/:id/comments`, `/rooms/:id/acl` (owner-only, #239), `/rooms/:id/share` (owner-only), `/health`, `/rooms/:id/upload`). `boundDocs` parameter is a `boundDocsView` read-through proxy onto `hocuspocusInstance.documents`; `flushRoom` routes through `database.store`.
- `server/room-serializer.cjs` — extracts .SEC + .comments.json from a Y.Doc on flush.
- `server/storage-{local,azure,s3}.cjs` — pluggable persistence ([ADR-0013](docs/adr/0013-storage-backends.md)).
- `server/migrate-pm-substrate.cjs` — sub-PR 1d v1 → v2 substrate broker ([ADR-0006](docs/adr/0006-pm-substrate-migration.md)). Now runs inside `onLoadDocument` (catch-and-return + explicit `database.store` persist on migration; backup-before-mutate ordering preserved).
- `server/auth/auth-provider.cjs` — JWT auth (optional via env).
- `server/auth/authorize.cjs` — `authorize(user, tenant, roomId, action)` decision module (#211 + graded roles #239, [ADR-0017](docs/adr/0017-room-authorization-model.md)). `roleOf(acl, userId)` resolves `owner|editor|viewer|null` (read-compat's both sidecar shapes); `ROLE_ACTIONS` is the role→action table (`READ` = all roles, `WRITE` = editor+owner, `DELETE|SHARE|LOCK_ADMIN` = owner). `authorize` returns `{ ok, role }` on success.
- `server/__tests__/` — `node --test` integration suite. Run via `npm run test:server`.

**Persistence cadence.** `SecWriterDatabase` is wired with `debounce: 500ms`, `maxDebounce: 10000ms` (starvation ceiling), `yDocOptions.gc: true`, `unloadImmediately: false` (warm-doc — keeps a room in memory across provider remounts so reconnect re-syncs from memory instead of reloading an empty doc before the seed flushed). Shutdown: SIGTERM/SIGINT runs `closeConnections()` → `flushPendingStores()` → `await database.drain()` (wrapped in try/catch/finally). The bare `Hocuspocus` class has no awaitable `destroy()`.

**Pinned deps:** `@hocuspocus/server`, `@hocuspocus/provider`, `@hocuspocus/extension-database` at exact `4.3.0`. They declare `yjs`/`y-protocols` as peer deps → single hoisted yjs copy → `instanceof` holds (see [ADR-0001](docs/adr/0001-server-uses-commonjs.md)). A CI step (`unit-tests` job, "Assert single Yjs instance") fails if `npm ls yjs` shows a second non-deduped copy. `y-websocket` is removed; `ws` is now a direct runtime dep. Node `>=22` required (Hocuspocus engines).

**Single-instance assumption (hard precondition).** Hocuspocus holds each room's authoritative Y.Doc in ONE instance's memory. The load-once-from-memory + warm-doc seed safety AND the `_storeChains` re-entrancy guard are correct ONLY on a single instance. Moving to >1 instance requires `@hocuspocus/extension-redis` for cross-instance sync AND a distributed lock on the `.ydoc` write. Revisit before any autoscale.

**Authorization (#211 + graded roles #239, [ADR-0017](docs/adr/0017-room-authorization-model.md)).** Under `SIM_AUTH_PROVIDER=jwt`, `onAuthenticate` validates and rejects non-canonical connections before `onLoadDocument` (zero storage fetch on reject). `authorize()` also runs on every `/rooms*` HTTP route. Rules (graded #239): `READ` (open WS, `GET /sec`, `GET /comments`) = viewer/editor/owner; `WRITE` (`POST /upload`, non-lock `PATCH`) = editor+owner (viewer denied); delete/share/lock-admin = owner-only; missing tenant/stable-subject or a reserved tenant (`_public` sentinel, `archive` namespace prefix) → 403; not-owner/not-shared/missing-ACL AND any capability denial → 404 (uniform, no existence leak); `GET /rooms` is member-filtered via `aclAllowsRead` and each entry carries the caller's `role`. **Viewer writes are also blocked at the WS layer** via `data.connectionConfig.readOnly` (a viewer's connect succeeds READ but its ops are rejected server-side). Share route `PATCH /:id/share` takes an optional graded `role` (`add` upserts, defaulting `editor`; owner-only `GET /:id/acl` backs the client `ShareDialog`). Required JWT claims: a tenant (`tenant|org|tid`) and a stable subject (`sub|oid`). Under auth=none `onAuthenticate` early-returns allow (role=editor) and every room is `_public`.

**Live-session revocation (#268).** Hocuspocus has no built-in mid-session re-auth ([#752](https://github.com/ueberdosis/hocuspocus/issues/752)) — `onAuthenticate` only runs on a fresh connect. To make an ACL role change take effect on ALREADY-OPEN sessions, `revokeLiveSessions(tenant, roomId, { subjects })` (in `collab-server.cjs`, threaded into `http-handler.cjs` like `flushRoom`) **hard-closes each target's raw WS socket with `ResetConnection` (4205)**. That is the ONLY primitive that makes `HocuspocusProvider` auto-reconnect and re-run `onAuthenticate` with the fresh role — `Connection.close()` / `hocuspocus.closeConnections()` are a SOFT in-band detach (socket stays open, client goes dormant, never re-auths). The share route kicks a removed or downgraded (editor→viewer) subject; the delete route kicks ALL (`subjects` omitted). Downgrade → reconnect as viewer (client `authorizedScope` flips `readonly` → `collabReadOnly`); removal → reconnect → `onAuthenticate` throws → exactly one `authenticationFailed`, no storm (provider reconnect is NOT close-code-gated — `hocuspocus-provider.cjs:441` retries on any close while `shouldConnect`; only the auth failure stops it, so 4205 is correct for both cases). A periodic **revoke sweep** (`SIM_REVOKE_SWEEP_MS`, default 60s, `unref`, skipped under auth=none) backstops out-of-band ACL edits and applies upgrades the event path skips. **Reach pinned to Hocuspocus 4.3.0:** `doc.connections` keys are Connection instances; `conn.context.user.id` (same namespace as ACL key / share `body.userId` — pinned by `hocuspocus-server.test.mjs` T4) and `conn.webSocket` (raw socket) are undocumented — the T1–T4 revoke tests are the tripwire for a version bump that reshapes them. **Single-instance only:** the event kick and sweep read the local `documents` map; cross-instance immediate revoke needs a fanned-out signal (Redis pub/sub) — see the single-instance precondition above. **Delete-route resurrection race (pre-existing, adjacent):** a debounced `onStoreDocument` pending from prior edits can re-persist a room after `deleteRoom`; not worsened by the kick (no new edits) but tracked as a follow-up (see [ADR-0017](docs/adr/0017-room-authorization-model.md)).

**Four non-obvious patterns** are pinned in [ADR-0014](docs/adr/0014-collab-server-yjs-relay.md) with deterministic regression tests. Patterns #1 and #2 are superseded by #128 (see ADR-0018); Patterns #3 and #4 apply unchanged:

1. `extractDocName` / `/ws/` URL parsing — **N/A post-#128.** `documentName` is client-supplied in-band; `extractDocName` is deleted. See ADR-0014 amendment.
2. Stale-close eviction guard — **Superseded.** Replaced by single-authoritative-load + `unloadImmediately: false` + `seededRooms` guard. See ADR-0014 amendment.
3. **Migration broker invariants** — Broker now runs in `onLoadDocument` (catch-and-return + explicit persist). Core invariants unchanged: `backupRoom` before mutation; `schemaVersion` and `migrationPartial` mutually exclusive; per-block try/catch tracks partial failures as editable. **Broker output attr keys MUST match the reader's keys** (`mapYTextAttrsToYpmMarks` in `migrate-pm-substrate.cjs` ↔ `yDeltaAttrsToAttrs`/`pmMarksToAttrs` in `pmdoc-html.js`) — a mismatch is SILENT (unknown keys dropped, NO `migrationPartial` banner; "successful" migration drops the mark). Revision marks use per-kind keys `revisionAdd|revisionDel|revisionChg: { authorId, authorColor }`, NOT a base `revision` key ([#220](https://github.com/mttvnst-HA/secwriter/issues/220), drift from PR #92). Any broker-shape change must add a broker→`pmFragmentToHtml` end-to-end test — the per-side unit pins can stay green while the pipe is broken.
4. **`GET /rooms` `setImmediate` yield** (PR [#112](https://github.com/mttvnst-HA/secwriter/pull/112)) — looks like a no-op but prevents `N * decode_ms` event-loop starvation when listing many rooms. Regression test asserts `maxGap < 200ms`. Unchanged.

Frontend at https://secwriter-frontend.onrender.com (Render auto-deploys on push to main). Production cleanup commands in [ADR-0014](docs/adr/0014-collab-server-yjs-relay.md).

## Reference Data Sources

- **UMRL** (`src/data/umrl.json`) — Unified Master Reference List. 302 organizations, 4,973 entries. Source: `C:\Program Files (x86)\SpecsIntact 5\UMRL\umrl.ref`. Used by the Reference Wizard.
- **UMSL** (`src/data/umsl.json`) — Unified Master Submittal List. 13,203 submittal entries. Source: same directory, `umsl.lst`. For future submittal wizard.

USACE updates these regularly. To refresh, re-run the parser scripts that generated the JSON.

## Known Parser Edge Cases

Parser validated against all 689 UFGS files (60 tags). Two known roundtrip edge cases: `32 12 36.26.SEC` and `32 13 13.43.SEC` have `<THD><HL3>text</HL3></THD>` where nested bold boundaries shift (content preserved).

## Agent skills

### Issue tracker

GitHub issues in `mttvnst-HA/secwriter` via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary — `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context — `CONTEXT.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.
