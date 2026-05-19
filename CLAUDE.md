# SecWriter

A modern web-based editor for UFGS (Unified Facilities Guide Specifications) .SEC files, replacing the legacy SpecsIntact desktop application (SIEditor).

**Issue [#47](https://github.com/mttvnst-HA/secwriter/issues/47) closed by sub-PR 1i-b.2 ([#109](https://github.com/mttvnst-HA/secwriter/pull/109), merged 2026-05-19):** the y-prosemirror substrate migration is fully live, the legacy contentEditable path (EditableBlock.jsx, useBlockBinder.js, useUndoableBlocks.js, VITE_PM_EDITOR flag, FloatingToolbar legacy branches) is retired, and SecWriter is a single PM-based editor.

**Terminology:** "SecWriter" = this web app (previously called "SpecsIntact Modern" / "SIM"; renamed to comply with the legacy SpecsIntact EULA). "SpecsIntact" / "SIEditor" = the legacy Windows desktop application — that name refers only to the legacy product, never to this app.

## Project Context

**What this is:** A rich text editor that reads and writes SpecsIntact .SEC files (XML-based SGML, windows-1252 encoding, used by the U.S. military for construction specifications). The editor feels like Google Docs or Notion while preserving the underlying SGML structure.

**Who it's for:** Engineers (especially geotechnical) who currently use MS Word as a workaround because SpecsIntact's tag-based editing is too clunky. The tool eliminates the Word-to-SpecsIntact round-trip workflow.

**Key design principle:** The engineer should never think about tags or SGML. Enter creates a paragraph. `/` opens a block type menu. Tab promotes/demotes headings. The SGML structure is inferred from context, not selected from a toolbar.

## Orientation

- `src/App.jsx` — main editor layout, state, toolbar, sidebar
- `src/components/` — block components (**PmEditableBlock**, TitleBlock, TableBlock, RefBlock), panels (CompliancePanel, CrossRefPanel, CommentPopup), tooltips, wizards, plus `useBlockLinting.js` (per-block lint lifecycle hook). `PmEditableBlock.jsx` mounts a y-prosemirror EditorView per editable block; the substrate is Y.XmlFragment per slot (with a Y.Text legacy fallback for migrationPartial rooms).
- `src/hooks/` — `useCollabSession.js` (Yjs session lifecycle + the four publish effects + coordination refs)
- `src/lib/` — parsers/serializers (sec-parser, sec-serializer, encoding), pure-reducer modules (`track-changes.js`, `comments.js`, `linting.js`, `compliance.js`), domain-side-effect modules (`compliance-ranges.js`), compliance engines (compliance-rules, compliance-checker, compliance-ai, inline-linter, grammar-checker, nlp-rules), revisions, table-ops, numbering, plus `block-html-store.js` (Y.Doc-as-substrate adapter for block html — Y.XmlFragment with Y.Text legacy fallback for migrationPartial rooms), `pm-schema.js` + `pmdoc-html.js` (PM schema + serializer — used by `PmEditableBlock` and by `yMapToBlock`'s Y.XmlFragment branch in collab.js), `ytext-html.js` (legacy Y.Text ↔ HTML conversion, retained for the migration partial path and load-boundary defenses), `block-registry.js` (App-scoped imperative-handle registry replacing `querySelector('[data-block-id="…"]')` in App), and `pm-plugins/` (slash-menu, tag-labels, keymap, relpos-selection — PM plugin set used by `PmEditableBlock`)
- `src/data/` — `ufs-1-300-02-rules.json` (compliance rules), `umrl.json` (reference DB), `umsl.json` (submittal DB), sample spec
- `reference/section.ini` — **authoritative** formatting rules (MARGINS, COLORS, RULES, CODES, FONTS)
- `reference/ufs_1_300_02.pdf` — authoritative source for compliance rules
- `reference/UFGS_M/` — 690 .SEC files for parser validation
- `tests/e2e/` — Playwright suite: `editor.spec.js` (141 tests) + `collab.spec.js` (11 tests)
- `tests/*.node-test.mjs` — UFGS structural + interop tests (Node runner)
- `corpus/` — 4-corpus test suite (calibration/clean/dirty/adversarial)
- `tools/` — CLI utilities (parse-sec, interop-scan, ui-audit/)
- `CONTEXT.md` — domain glossary (block, transparent tag, TC snapshot, publish path, etc.). Use these names; consult before introducing new terms.
- `docs/adr/` — load-bearing architectural decisions. **Read the relevant ADR before proposing a refactor in its area** (CJS server, y-websocket pin, rules-as-data, snapshot-diff publish path, storage atomicity-per-backend).
- `docs/architecture-review-*.md` — open deepening-candidates backlog from architecture reviews.

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
7. **CI-only flakes are timing races.** When a test fails only on a CI runner but passes 10×/10 locally, do NOT keep re-running locally — write a deterministic regression test that forces the race (e.g., manually mutate shared state mid-`await`). See `server/__tests__/collab-server.test.mjs` for the pattern (force-delete the y-websocket docs Map during a slow-storage read to expose the eviction race).
8. **CSP allowlist is a CI gate.** Adding a new remote origin (`connect-src`, `script-src`, etc.) requires updating `ALLOWED_REMOTE_HOSTS` in `src/__tests__/csp.test.js`. Don't delete the test — update it.
9. **PM-aware E2E injection routes through `window.__simEditorTestUtils` (1f.7).** Tests that inject block state via `el.innerHTML = '...'; el.dispatchEvent('input')` work in legacy (DOM is the source of truth) but PM's render cycle overwrites the DOM. Use `injectBlockHtml(page, blockId, html)` / `readBlockHtml(page, blockId)` from `tests/e2e/pm-helpers.js` instead. The DEV-only seam is wired in `src/App.jsx` and routes through `handleBlockUpdateWithSync` so the legacy DOM also stays in sync — its substrate→DOM effect skips writes while a block is focused, so a plain `handleBlockUpdate` injection would update React state + substrate but leave the legacy DOM stale, and the next blur would clobber. **1f.9 additions:** `pmSetSelection(page, blockId, from, to)` / `pmGetSelection(page, blockId)` in `pm-helpers.js` drive a PM `TextSelection` from a Playwright test via `getBlockView`. (The `__overrideFlush` / `__isFlushOverridden` seam was retired with the 2026-05-19 `dispatchToolbarVerb` refactor — `dispatchToolbarVerb` is the unit-test surface for the synchronous-flush invariant, no global seam needed.)
10. **Before claiming "no E2E regressions," run the FULL `editor.spec.js` and `collab.spec.js` under `--project=chromium`.** Single-project gate post-1i-b.2; PmEditableBlock is the only editor. Spot-checking specific tests rather than the full suite is how the legacy-mode `snapshotText` regression in PR #95 reached CI — run the whole spec file. **Baseline under `chromium` is the 9 parallel-load flakes catalogued in [docs/superpowers/notes/1i-a-pm-failures.md](docs/superpowers/notes/1i-a-pm-failures.md) PLUS the 3 persistent PM mount/focus races tracked at [#114](https://github.com/mttvnst-HA/secwriter/issues/114)** (editor.spec.js:404, :918, :1183 — 1183 reproduces 3/3 at W=1 in isolation; 918 leaks the first 5–8 typed chars to the previously-focused block; 404 is load-only). The "zero persistent failures" claim in the 1i-a note was accurate at its snapshot but does not reflect post-1i-b.2 baseline — issue #100's bisect showed 5/5 runs failing on those three. To distinguish regression from flake: `git stash`, re-run the failing tests by `--grep` under `--project=chromium`; if they fail at baseline too, it's a flake (or one of the #114 persistent races). Trust isolated runs over the full-suite diff.

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

Pinned PM versions: `y-prosemirror` is held at 1.x (see [ADR-0006](docs/adr/0006-pm-substrate-migration.md)). Don't bump without re-verifying every empirical claim in this repo's PM tests.

### Tag categories

**TRANSPARENT tags** (inline wrappers, 21): ADD, ATT, BLD, CHG, CTR, DEL, ENG, HL1, HL2, HL3, HL4, HLS, INC, ITA, MET, SBS, SPS, TAI, TST, UND, URL

**Data-driven inline tags:** SUB (submittals→register), SRF (section cross-refs→validate), RID (citations→sync with REFERENCES), TAI (tailoring by branch/region/delivery), ENG/MET (dual unit pairs)

**Block hierarchy:** SEC > PRT > SPT > {TXT, OLG, OLI, LST, ITM, NTE, NPR, NPG, SBM, TAB, TBL (preformatted), TTL, REF}

## Block Focus

Focus routes through `src/lib/block-registry.js`: `focusBlockById(id, { atEnd })` looks up the imperative handle a mounted block registered on mount and either calls into its PM `EditorView` (PmEditableBlock dispatches `Selection.atEnd` / `atStart`) or its DOM `Range` placement (TitleBlock and other contentEditable hosts). Brand-new blocks (`block.isNew=true`) auto-focus from their own mount effect rather than through the registry, so App only falls back to `document.querySelector('[data-block-id="…"]')` when registration hasn't fired yet.

## Blocks Reducer Architecture

Every mutation of the `blocks` React-state array routes through a single dispatcher in `src/lib/blocks.js` (2026-05-19). The reducer extends the pure-verb playbook (track-changes / comments / linting / compliance) to the blocks array itself:

1. **State is the array.** `BlocksState = Block[]`. No wrapper struct — Yjs is the coordination layer, so there's nothing to bundle alongside.
2. **Verbs are pure.** 21 verbs covering create/delete/convert/promote/demote/level-change/reorder/html-update/inline-fix/compliance-group/ref-add/ref-orphan/revision-accept-or-reject (single and all). Each returns a `VerbResult = { state, effects }` descriptor (or `null` for "block not found"). `unchanged(prev)` is the "found but no-op" return.
3. **Effects descriptor.** `effects = { framing, substrateWrites, flush, focus }`. `framing` is a tagged union: `{ kind: 'newFrame' }` (forceFrame BEFORE substrate writes), `{ kind: 'wrappedFrame', writes }` (withUndoFrame wraps N writes so they form ONE Yjs undo frame regardless of captureTimeout), or `null`. `substrateWrites` is empty when framing=wrappedFrame — the writes live inside `framing.writes`. The descriptor models **html-slot writes only**; structural changes (create/delete/reorder) ride the implicit `setBlocks → applyBlocksToYDoc` diff path. Property test P3 pins "every SubstrateWrite.blockId references a block that exists in the verb's resulting state."
4. **Dispatcher protocol.** `dispatchBlocksVerb({blocksRef, setBlocks, yStore, framing, setFocusedBlockId, focusBlock}, compute, opts)` runs: optional `preFlush` (`flushAllPendingUpdates` / `flushPendingUpdateById`) → `compute(blocksRef.current)` → `framing.forceFrame()` if newFrame → substrate writes (or `withUndoFrame` wrap for wrappedFrame) → `setBlocks(state)` AND `blocksRef.current = state` (so a synchronous loop like Replace All / Remove All Orphaned sees the latest state mid-loop instead of the pre-loop snapshot) → flush → focus (`setFocusedBlockId` synchronously, or `focusBlock` via setTimeout(0) for the imperative variant). The sync mutation of `blocksRef.current` is load-bearing — without it, sequential dispatches in the same event-loop tick all read the pre-loop blocks and clobber each other on setBlocks. The next render commit overwrites the ref with the React state value anyway.
5. **App-side thin closure.** `dispatchBlocks(compute, opts)` in `src/App.jsx` wires `framing` from `framingForHandler()` (returns `collab` or `localUndo` per `inRoomRef`) and resolves `yStore` from `activeYStoreRef.current` at call time, so a mid-session room transition doesn't strand stale references. The 14 App.jsx handlers + 7 inline JSX handlers from pre-2026-05-19 collapse into one-line dispatch calls.
6. **Substrate-write origin.** Every write in `substrateWrites` and `framing.writes` defaults to origin `'local-publish'` (Yjs UndoManager-tracked). PM-click paths emit zero substrate writes because ySyncPlugin's PM dispatch already wrote the substrate — only the framing/setBlocks pieces are needed (`updateBlockHtmlPmSync`).
7. **Registry mirror is gone.** The pre-2026-05-19 `getBlockHandle(id).setHtml(html)` calls in `handleBlockUpdateWithSync` and `handleSearchReplace` were no-ops post-1i-b.2 (PmEditableBlock's `setHtml` handle is documented as a no-op; TitleBlock never registered one). The dispatcher does not call them. If a future non-PM editor surface re-introduces imperative html push, add the mirror to the dispatcher then.
8. **TC interaction.** Verbs that branch on TC state (`createBlockAfter`, `deleteBlock`) take `tcState` as an explicit arg — the reducer stays pure, and `tc.revisionFlagForCreate`/`revisionFlagForDelete` selectors handle the "is this a tracked add?" / "should this delete remove or mark?" decisions. The `tc.acceptAll` / `tc.rejectAll` state transition still lives in App because it's a separate reducer; the blocks-side mutation (strip marks, drop deleted blocks) lives in `acceptAllRevisionsVerb` / `rejectAllRevisionsVerb` with `preFlush: 'all'` to drain PM debounces first (#109 M4).

## Slash Menu → Block Conversion

`handleConvertBlock` creates a block with a **new ID**. This forces a React remount, which triggers the ref callback, which handles focus. Do not try to reuse the old block ID — the ref callback won't re-fire on an existing DOM node.

## Windows-1252 Encoding

.SEC files declare windows-1252 in the XML header:
- **Import:** `FileReader.readAsArrayBuffer()` + `TextDecoder('windows-1252')` — NOT `readAsText()` (defaults to UTF-8).
- **Export:** `encodeWindows1252(xml)` from `src/lib/encoding.js` returns `Uint8Array` with byte mapping for characters 0x80–0x9F (curly quotes, em-dash, euro, trademark, bullet).

## Track Changes Architecture

TC marking is **per-keystroke via PM's dispatchTransaction intercept** (Q33, sub-PR 1h). The legacy snapshot-based diff approach is retired (Q35/Q37, sub-PR 1h). The reducer at `src/lib/track-changes.js` is now a 70-LOC shell over `{ enabled, publishSeq }`:

1. **State is opaque.** App reads it via selectors (`isEnabled`, `getPublishableState`, `revisionFlagForCreate`, `revisionFlagForDelete`) and mutates it via verbs (`enable`, `disable`, `acceptAll`, `rejectAll`, `applyRemote`). The retired verbs (`acceptInline`, `rejectInline`, `applyResolveAtBlock`, `markBlockCreated`, `getSnapshot`) are gone — per-keystroke marking lives in `PmEditableBlock.dispatchTransaction` and revision marks are applied directly to the PM doc.
2. **App-side handler trio, two backing verbs.** Three sibling closures in `App.jsx`, picked by call-site substrate ownership: `handleBlockUpdate` (debounced typing path — TitleBlock raw contentEditable) and `handleBlockUpdateWithSync` (MarkSuggestions accept-suggestion) both dispatch `Blocks.updateBlockHtml` (substrate via `setBlockHtml` + setBlocks). `handleBlockUpdatePmSync` (PM click path: FloatingToolbar inline accept/reject, PmEditableBlock del-popup's `onRefreshTcSnapshot`) dispatches `Blocks.updateBlockHtmlPmSync` (setBlocks only — ySyncPlugin's PM dispatch already wrote the substrate, no `setBlockHtml`). The pre-1i-b.2 `getBlockHandle(id).setHtml(html)` registry mirror that `handleBlockUpdateWithSync` carried was retired in #121 — PmEditableBlock's `setHtml` handle was a documented no-op and TitleBlock never registered one (see "Blocks Reducer Architecture" item 7). The 1h-era fourth sibling `handleLegacyRevisionAction` retired in 1i-b.2 with the legacy contentEditable del-popup.
3. **`forceFrame()` before any click-driven `setBlocks` (1h Q36 Commit C).** A click handler (del-popup accept/reject, toolbar revision verb, accept-all, etc.) pairs `(inRoomRef.current ? collab : localUndo).forceFrame()` with its `setBlocks` so the Yjs UndoManager closes its current capture window before the action — without this, the subsequent `applyBlocksToYDoc` `'local-publish'` write (in-room) or `setBlockHtml` write would coalesce with prior typing into a single frame, and one Ctrl+Z would revert typing+click together. The three multi-write gestures — `handleAcceptAll`, `handleRejectAll`, `handleComplianceAcceptGroup` — additionally wrap their N `setBlockHtml` writes in `framing.withUndoFrame(() => { … })` so the loop forms one frame regardless of captureTimeout.
4. **Collab publish.** `publishSeq` is a monotonic counter bumped by every user-driven verb but not by `applyRemote`. The TC publish effect (inside `src/hooks/useCollabSession.js`) compares against `lastPublishedTcSeqRef` to decide "did this change come from us?" — replacing the imperative `tcDirtyRef` flag. App's `onTcReceived` handler calls `collab.markTcSeqApplied(next.publishSeq)` after `tc.applyRemote(...)` so the next render does not echo a remote-applied state back to peers.
5. **Wire payload (Q37).** `publishTcToDoc` writes ONLY `{ enabled }` — the legacy `yTc.snapshots` Y.Map is not touched by post-1h clients. Pre-1h-populated snapshots survive untouched so mixed-version rooms round-trip cleanly. `readTc` still emits `{ enabled, snapshots }` for backward compat with the pre-1h schema; the reducer's `applyRemote` drops the `snapshots` field. No `schemaVersion` bump in 1h or 1i-b — pre-1h clients editing post-1h rooms degrade in edit fidelity (their blur-time annotation has no snapshot baseline; no marks authored on their edits). The `schemaVersion: 3` bump is deferred to 1i-c.
6. **Undo/redo coupling.** `tcState` lives in App-level `useState`; the Yjs UndoManager (in-room via `collab.js`, out-of-room via `useLocalSubstrateUndoManager`) is the sole source of truth for keystroke-grain and structural undo. Accepted regression: Ctrl+Z across a TC enable/disable boundary no longer rolls back the toggle (treated as explicit UI, not a typing frame).
7. **PM del-popup (1f.8).** `PmEditableBlock`'s `handleClick` routes through `applyDelAction` (pure HTML mutator at `src/lib/pm-del-popup.js`) and `onRefreshTcSnapshot` (`handleBlockUpdatePmSync`), since PM dispatch wrote the substrate. The mutator identifies the target del by DOM index, not by PM mark equality, because adjacent del marks with different `authorId` are separate marks in PM's schema.
8. **FloatingToolbar PM path (1f.9; consolidated 2026-05-19 via `dispatchToolbarVerb`).** The six mark-application verbs (format, inline-mark, revision-apply, inline-revision-resolve, change-case, comment-create) live in `src/lib/pm-toolbar.js` as pure tr-builders that return `{ tr, settlement, range }` descriptors. `dispatchToolbarVerb` in the same module owns the post-dispatch protocol: relpos restore -> `compute(state)` -> `onForceFrame?.()` -> `view.dispatch(tr)` -> snapshot `view.state` -> flush-or-cancel per the verb's `settlement`. Settlement is `'self'` for five of the six (dispatcher calls `flushPendingUpdateById` so React state sees the new html synchronously) and `'caller-owned'` for inline-revision-resolve (dispatcher calls `cancelPendingUpdateById`; the FloatingToolbar caller settles React state via `onRefreshTcSnapshot(blockId, extractHtml(state))` — a debounce-driven late `handleBlockUpdate` would clobber the just-settled snapshot, so cancel-not-flush is structural, not cosmetic). The dispatcher returns `{ dispatched, blockId, state, range }` (state is a frozen post-dispatch `EditorState` snapshot — peer ops landing afterwards do not mutate it). Callers read it via `extractHtml(state)` / `extractRangeText(state, range)` (also exported from pm-toolbar.js), keeping `pmFragmentToHtml` out of FloatingToolbar entirely. **PM imports do not leak into the toolbar's call sites.**
9. **Document-wide TC gestures call `flushAllPendingUpdates()` first (#109 M4).** `handleAcceptAll` / `handleRejectAll` (`src/App.jsx`) flush every registered PM block's pending 400ms `onUpdate` debounce via `flushAllPendingUpdates` (`src/lib/block-registry.js`) before reading `blocksRef.current`. Without it, a sub-debounce click runs against pre-debounce html — the PM substrate has the just-typed `revisionAdd`/`revisionDel` marks but React state does not, so `acceptAllRevisions` strips nothing, TC is disabled, and the surviving marks land in React state ~400ms later with no UI to clear them. Single-block toolbar verbs already pair with `flushPendingUpdateById(blockId)` (point 8); doc-wide gestures use the All-variant.
10. **Inline TC mark HTML carries per-author attribution attrs (#87 1h schema split).** `revisionAdd` / `revisionDel` / `revisionChg` serialize as `<ins|del|span class="mark-{add|del|chg}" data-author-id="<id>" style="--author-color:<color>">` via `makeRevisionMarkSpec` in `src/lib/pm-schema.js`. Regexes in `src/lib/revisions.js` parsing these marks must use `[^>]*` between the class attr and `>`. The pre-1h shape `<ins class="mark-add">` is the legacy / no-attribution case only.

## Comments Architecture

Comments use a pure reducer module (`src/lib/comments.js`) that owns a **DOM-based highlight + separate metadata store** — same playbook as Track Changes, Linting, and Compliance (opaque state, pure verbs, pure selectors, property-tested invariants — see also `src/lib/track-changes.js`, `src/lib/linting.js`, `src/lib/compliance.js`):

1. **State is opaque.** App holds it as `commentsState` and reads it via selectors (`size`, `get`, `all`, `isDraft`, `getCreateEntry`, `reconcileBlocks`, `normalizeForLoad`); mutates it via verbs (`createDraft`, `updateCreate`, `reply`, `resolve`, `reopen`, `remove`, `mergeRemote`). Shape: `{ byId: Map<commentId, Comment>, seenRemoteIds: Set<commentId> }`. Verbs return `{ state, publish }`; caller supplies `identity` and `ts`.
2. **Span↔metadata reconciliation is a selector.** App runs `useEffect([blocks, commentsState])` → `setBlocksDirect(prev => cm.reconcileBlocks(prev, commentsState))`. The selector unwraps orphan spans (id missing from state) and reclasses open↔resolved when className disagrees with `state.byId.get(id).status`. Idempotent — returns the original `blocks` ref when nothing changes; React bails out, no loop. Post-1i-b.2 `setBlocksDirect` is an alias for `setBlocks` (the snapshot-stack distinction died with `useUndoableBlocks`); the call site stays for clarity at the comment-reconcile seam. The same effect also mirrors any html change into the substrate via `setBlockHtmlSilent(activeYStoreRef.current, b.id, b.html)` (silent origin, not tracked by either UndoManager) so peers see comment-status reclassifies without polluting the local undo stack.
3. **Single collab dispatcher.** `session.dispatchComment(envelope)` switches on `envelope.kind ∈ {create, reply, status, delete}` and forwards to the underlying `*ToDoc` functions. The legacy four session methods (`publishComment`, `publishCommentReply`, `publishCommentStatus`, `deleteComment`) are gone. Verbs that produce no publish (drafts) return `publish: null`.
4. **`mergeRemote` semantics (M2.5).** For each id in `remote ∪ prev.byId`: if id is in remote, remote wins; else if id is in `seenRemoteIds`, drop (peer deletion); else preserve (local draft). `seenRemoteIds` is monotonically non-shrinking — once an id has been observed from peers, its later absence is authoritative.
5. **Editable blocks** persist comment spans in `block.html`; `reconcileBlocks` reclasses/unwraps them on every state change. **Ref/table blocks** derive spans at render time: `RefBlock` and `TableBlock` accept `commentsState` + `activeCommentId` props, call `cm.getBlockComments(state, block.id)`, and run each text field through `cm.computeCommentSegments(text, blockComments)` to wrap matching substrings with `mark-comment` / `mark-comment-resolved`. No DOM drift possible — spans are recomputed from metadata every render. The popup's click-to-open and active-highlight flow is identical to editable blocks.
6. **Active highlight is mode-conditional.** PM-mounted editable blocks: the `activeCommentPlugin` (`src/lib/pm-plugins/active-comment.js`) holds a singleton `activeCommentId` plugin state; App calls `setActiveComment(view, commentId)` via `block-registry.getBlockView`. The plugin emits an inline `Decoration.inline(from, to, { class: 'mark-comment-active' })` over the matching `comment` mark's range. CSS rule: `.mark-comment.mark-comment-active` and `.mark-comment-resolved.mark-comment-active` (light + dark). DecorationSet is cached in plugin state per the PM guide's Decorations recommendation. — Ref/table blocks have no PM EditorView; `RefBlock` / `TableBlock` render `data-active="true"` directly in JSX from the `activeCommentId` prop (see their `renderWithCommentMarks` / `renderCellContent` helpers), and CSS uses the `[data-active="true"]` attribute selector. Reconcile (item 10) owns the className transitions across `comment.status` flips.
7. **Load-boundary shim.** `normalizeForLoad(rawCommentsObj)` runs in `onRemoteComments` and the auto-save restore path. It promotes legacy `author` → `authorName` and `timestamp` (ISO) → `ts` (number); canonical fields take priority. The module never sees legacy fields.
8. **Export:** serializer strips `mark-comment` spans. A sidecar `.comments.json` is saved alongside the `.SEC` file.
9. **File import clears comments** — `loadSECContent()` calls `setCommentsState(cm.createInitial())` so comments from a prior file don't leak.
10. **Toolbar comment-create path.** PM editable blocks dispatch `applyCommentMarkTr` (`src/lib/pm-toolbar.js`) and reach the substrate via ySyncPlugin — same shape as the other five mark verbs. Ref/table blocks (no PM EditorView registered) keep the `range.surroundContents(<span class="mark-comment">)` DOM-mutation path inside the comment-button onClick; the substrate is updated through the `onCommentCreate` envelope (which carries `null` html for ref blocks since their content lives in `block.ref`, not `block.html`).

**Substrate-side reconcile (1g).** For PM-mounted blocks, a per-block `useEffect([commentsState])` in `PmEditableBlock.jsx` calls `reconcileCommentMarks(view.state, commentsState)` (`src/lib/pm-comments.js`) and dispatches the returned tr. The verb is idempotent — receiving peers (whose substrate is already updated via the originator's ySyncPlugin op) get a null tr and dispatch nothing. The tr is tagged with `COMMENT_RECONCILE_META`; `dispatchTransaction` skips the synthesized `'input'` event and the `onUpdate` debounce for reconcile-tagged trs. The latter is empirically necessary (see `src/lib/__tests__/setblockhtml-echo-behavior.test.js`) — un-gated `onUpdate` would call `setBlockHtml(..., 'local-publish')` and produce an echo Yjs op the UndoManager captures. Ref/table blocks still rely on `cm.reconcileBlocks`'s html walk via the App-level effect (its `shouldSkip` predicate skips any block that has a registered PM EditorView).

## Tag Visibility Toggle

The `</>` button toggles `tags-hidden` (default) vs. `tags-visible` on the editor container:

1. **Inline marks:** widget `DecorationSet` from `src/lib/pm-plugins/tag-labels.js` injects `tag-label` decorations alongside each mark span. PM widgets create proper caret boundaries inside contentEditable — CSS `::before`/`::after` pseudo-elements don't (the browser can't place the cursor between `::before` and the first text character).
2. **Block-level tags:** CSS `::before`/`::after` with `data-tag` attributes on block wrapper `<div>`s (outside contentEditable, no caret issues).
3. **TitleBlock** still uses raw contentEditable (not a PM EditorView), but title spans don't carry inline marks, so the widget plugin isn't needed there.

## Compliance Checker Architecture

Data-driven rule engine with two tiers:

1. **`ufs-1-300-02-rules.json`** — authoritative rule data extracted from `reference/ufs_1_300_02.pdf`. 36 prohibited terms, 13 prohibited symbols, 21 vague terms, 4 required capitalizations, plus colloquial/redundant/required-practice categories. **Rules are NOT hardcoded in source code.** `buildRules()` derives the runtime rule list from these categories.
2. **`compliance-rules.js`** reads the JSON at startup and generates ~81 rule objects via `buildRules()`. Each rule: id, category, severity, regex, message, UFS reference, optional `fix()`. Rules with `fix === null` defer to AI tier. Uses **binary search** for bracket exclusion.
3. **`compliance-checker.js`** runs rules against scoped blocks, groups by rule ID, computes stats. Excludes note blocks, bracket content, hidden ENG/MET. Enforces **violation budget** (`MAX_VIOLATIONS = 2000`); returns `truncated: true` when capped.
4. **`compliance-ai.js`** (Tier 2): builds system prompt dynamically from the JSON, chunks large requests (20 blocks max per API call), estimates token cost, supports abort via AbortController.
5. **`CompliancePanel.jsx`** — UI shell. Progressive UX: summary bar → grouped findings → batch accept/reject → AI batch.
6. **`compliance.js`** — pure reducer over `{ scope, status, result, decisions, activeGroup, ai }` per ADR-0005. State lives in App; the panel reads via selectors and dispatches verbs (`setScope`, `startCheck`, `setResult`, `acceptGroup`/`rejectGroup`/`acceptItem`/`rejectItem`/`markGroupsAccepted`, `setActiveGroup`, AI lifecycle: `aiStart`/`aiProgress`/`aiSuccess`/`aiError`/`aiAbort`/`aiClearError`). Local-only — no `publish` envelopes; the local edits from accepting fixes flow through the existing `setBlocks` path. Five property-tested invariants: `setResult` clears decisions and `activeGroup` (I1); decisions ⊆ result keys (I2/I3); `activeGroup` ∈ result keys ∪ {null} (I4); AI status stays in `{idle, running, error}` and `sessionTokens` is monotone (I5). Pure fix-computation helpers `computeItemFix` / `computeGroupFixes` / `computeFormattingFixes` extracted from the panel's accept handlers — testable without rendering React.
7. **`compliance-ranges.js`** — pure walker that returns text-node + offset tuples for each violation match. Word-boundary aware; skips text inside `<del class="mark-del">`. The App-level `useEffect([complianceOpen, complianceState.activeGroup, complianceState.result, blocks])` builds `Range` objects and pushes them through the CSS Custom Highlight API as `CSS.highlights.set('compliance-active', new Highlight(...))` — same primitive linting uses. Sub-PR 1f (#47) replaced the previous `<span class="compliance-highlight">` injection model so highlights survive PM EditorView re-renders without ad-hoc DOM coordination.
8. **Updating rules:** When USACE publishes a new edition, re-extract the JSON from the PDF. No code changes needed.

**Perf:** lazy fix computation (store `fixFn` reference, don't eagerly compute fix text during scanning); binary search on sorted bracket ranges (O(log m) per match); 2000-violation cap.

## Inline Linting Architecture

Real-time linting uses the **CSS Custom Highlight API** (zero DOM mutation) with three engines, organized as a pure-reducer module + per-block lifecycle hook + App-level highlight effect (the same shape as Track Changes / Comments / Compliance):

- **`src/lib/linting.js`** — pure reducer over `{ enabled, suspended, byBlock: Map<blockId, { compliance, nlp, grammar, grammarText }> }`. Verbs (`createInitial / setEnabled / setSuspended / setBlockFindings / clearBlock / clearAll`), selectors (`isActive / isEnabled / isSuspended / getBlockFindings / getAllFindings / getBlockSeverity / getGrammarText / getRangesByTier`), pure dedup helpers (`dedupNlpAgainstCompliance`, `dedupGrammarAgainstFindings`), and the `DEFERRED_TO_PANEL` set. Range objects are *opaque* to the reducer — DOM-free, plain-Vitest testable.
- **`src/components/useBlockLinting.js`** — per-block hook that owns all DOM-bound and async effects: debounced lint cycle on input, lint on focus, lint on enable/un-suspend, sync static-rule + NLP pass, async Harper dispatch with stale detection, lazy-load triggers, the dedup pipeline against the reducer's helpers, Range creation against the live DOM, and the cursor-based tooltip detection (selectionchange + arrow keys).
- **App-level CSS.highlights effect** — single seam (`useEffect([lintingState])` in `src/App.jsx`) that mutates the global `CSS.highlights` registry by reading `linting.getRangesByTier(state)` and calling `CSS.highlights.set(name, new Highlight(...ranges))` per tier. Suspension flips via a separate `useEffect([complianceOpen])` that dispatches `linting.setSuspended`.

The three engines themselves stay where they were:

1. **Static UFS rules** (`compliance-rules.js`): synchronous, <5ms. Yellow highlights.
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

## Corpus Testing Infrastructure

Three text-analysis engines measured against real UFGS text using a 4-corpus suite:

1. **Calibration** (`corpus/calibration/`) — 2,583 raw UFGS blocks from 5 sections. Validates primary rules (shall, should) produce zero hits on unmodified master text.
2. **Clean** (`corpus/clean/`) — same blocks rewritten by Claude Opus to full UFS 1-300-02 compliance. Every finding is a false positive. Measures precision.
3. **Dirty** (`corpus/dirty/`) — 644 blocks with 1,438 labeled injected violations. Measures recall per rule.
4. **Adversarial** (`corpus/adversarial/`) — 150 edge cases (FP traps, NLP ambiguity, domain jargon). Measures robustness.

**Regenerating results:** `node --import ./tools/json-loader.mjs tools/run-corpus-test.mjs --corpus clean` (or `dirty`, `calibration`, `adversarial`). Adversarial delegates to `tools/score-adversarial.mjs` since its shape is pass/fail per entry, not a findings list. Then `node tools/generate-report.mjs` for REPORT.md + metrics.json.

**Baseline (May 2026, harper.js 2.0):** Static recall 86.9%, NLP recall 67.5%, Grammar recall 65.6%. Static FP rate 0.31%. Adversarial accuracy 92.7%. Full report: `corpus/results/REPORT.md`.

The Grammar drop from the March 2026 baseline (78.4% → 65.6%) tracks the harper.js 1.12 → 2.0 bump in [#57](https://github.com/mttvnst-HA/secwriter/pull/57); 2.0 retired several rule categories and tightened agreement detection (GRAMMAR-Agreement recall: ~56% → 38%). The tradeoff is an 86% reduction in grammar FPs on the calibration corpus (2251 → 279 findings on 2,583 raw UFGS blocks), which is the more impactful axis for spec text where FPs vastly outnumber TPs. New 2.0 lint kinds (`Typo`, `Usage`) are evaluated in `DISABLED_LINT_KINDS` in `src/lib/grammar-checker.js`. Adversarial drop from 97.3% → 92.7% is unrelated to harper — post-March compliance rule tightening (e.g., COLLOQ-head's `head pressure` / `head loss` / `shower head` exclusions) made several `shouldFlag: true` "known FP" expectations in `corpus/adversarial/adversarial.json` stale. The expectations themselves should be refreshed in a future pass.

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
4. `ydoc.on('update')` on the server debounces a flush to R2/local (`server/collab-server.cjs`). Server-side `yMapToBlock` (in `src/lib/collab.js`) branches on duck-type — `pmFragmentToHtml(yXmlFragment)` for v2 slots, `yTextToHtml(yText)` for legacy. Without the branch, .SEC export would coerce `String(yXmlFragment)` and silently corrupt every migrated block (Q24/B3).

**Scalar/structural path (still publishBlocks):**
- `App.handleBlockUpdate` calls `setBlocks(prev.map(...))`. The publish effect inside `useCollabSession` calls `session.publishBlocks(blocks)` after the `sessionReadyRef` and `lastRemoteBlocksRef` echo guards pass.
- `applyBlocksToYDoc` (`src/lib/collab.js`) walks the block array and reconciles structure (yOrder, yStore keys, scalar fields). It **skips html for existing slots** — only seeds html for brand-new blocks. The PM EditorView's ySyncPlugin owns html updates for everything else.

**Coordination lives in the hook, not App.** `useCollabSession` owns the session lifecycle, all four publish effects (blocks, meta, TC, comments dispatch), all coordination refs (`sessionReadyRef`, `metaReadyRef`, `lastRemoteBlocksRef`, `lastPublishedTcSeqRef`, `publishDisabledRef`), the `DocSizeLimitError` toast latch, and the cursor broadcast. App passes a prop bag of remote-event callbacks (`onBlocksReceived`, `onMetaReceived`, `onTcReceived`, `onCommentsReceived`, `onPresenceChange`, `onStatusChange`) and reads back `{ dispatchComment, markTcSeqApplied, tryUndo, tryRedo, canUndo, canRedo, clearStack }`. The TC echo gate is a small protocol seam: App's `setTcState` updater calls `markTcSeqApplied(next.publishSeq)` after `tc.applyRemote(...)` so the publish effect treats the new state as already-seen by peers.

**Non-obvious invariants (load-bearing, easy to break):**
- **`yStore` is null until first sync.** `useCollabSession` only calls `setYStoreState(session.yStore)` from inside `if (meta?.initial)` (`fbc0d0f`). Until then `PmEditableBlock`'s mount-time substrate subscription resolves to null and the view stays unmounted, and every direct `setBlockHtml(activeYStoreRef.current, ...)` caller in App must null-guard. Without this gate, a keystroke landing in the sync window CRDT-merges on top of the server's persisted state — the eee8977 corruption pattern via the new direct-substrate path.
- **The Yjs UndoManager tracks `'local-publish'` AND `ySyncPluginKey`.** `setBlockHtml` writes use `'local-publish'`; y-prosemirror's per-keystroke ops use `ySyncPluginKey`. New code that mutates html outside a PM EditorView must go through `setBlockHtml` (not `applyHtmlToYText` or `prosemirrorToYXmlFragment` directly) or undo coverage is silently lost. App.jsx has many direct call sites (revisions, compliance fixes, search/replace, accept-all, etc.); follow that pattern. The comment-reconcile mirror uses `setBlockHtmlSilent` (a distinct origin, NOT tracked) so peer-driven reconciles stay off the local undo stack. The in-room manager lives in `createCollabSession` (`src/lib/collab.js`); the out-of-room manager lives in `useLocalSubstrateUndoManager` (`src/hooks/useLocalSubstrateUndoManager.js`). Both must stay in trackedOrigins lockstep or Ctrl+Z drifts between modes — the integration test `src/lib/__tests__/word-boundary-undo.test.js` ("hello world. → 3 frames") catches a drop of `ySyncPluginKey`.
- **`'migrate-v2'` is the broker-only origin.** Server-side migration writes (1d) use it. It is deliberately NOT `'local-*'` (so `handleAfterTx` in `collab.js` does NOT filter it — the first v2 client to join sees the migrated state via the normal sync path) and NOT `'local-publish'` (so the client-side UndoManager cannot Ctrl+Z a peer's pre-migration content). Don't reuse this origin for any write that originates on a client.
- **`ySyncPluginKey` is the PM-driven origin.** y-prosemirror's `ySyncPlugin` writes Yjs ops with origin `ySyncPluginKey`. It is distinct from `'local-publish'` — PM-driven keystrokes carry this origin; debounced echo writes via `setBlockHtml` (from `handleBlockUpdate`'s 400ms onUpdate flush) carry `'local-publish'`. Both UndoManagers track BOTH so per-keystroke PM edits enter the stack (gated by the word-boundary-undo plugin's `forceFrame` for word-grain framing, matching Word/Notion). Within the 500ms captureTimeout, the PM op and its echo-back `'local-publish'` op join the same undo frame, so one Ctrl+Z reverts both correctly. App-side routing: Ctrl+Z → `collab.tryUndo` (in-room) → fall through to `localUndo.tryUndo` (out-of-room). No third tier.
- **`COMMENT_RECONCILE_META` is a PM-meta sentinel, NOT a Yjs origin (1g).** Defined in `src/lib/pm-comments.js` as `export const COMMENT_RECONCILE_META = {}` (sentinel object — identity-compared). Set via `tr.setMeta(COMMENT_RECONCILE_META, true)`. `dispatchTransaction` in `PmEditableBlock.jsx` reads it via `tr.getMeta(COMMENT_RECONCILE_META) === true` and skips the synthesized `'input'` event (linter) + `onUpdate` debounce (no `setBlockHtml` echo). The corresponding Yjs op produced by ySyncPlugin still uses origin `ySyncPluginKey` — the meta only governs PM-side filtering, not the substrate write path. Don't conflate this with a Yjs origin like `'local-publish'`.
- **`TC_RESOLVE_META` is the TC-resolution sentinel (#96 fix).** Defined in `src/lib/pm-tc-mark.js` as `export const TC_RESOLVE_META = {}`. Set by producers of accept/reject transactions for existing revision marks — currently `pm-del-popup.js`'s `dispatchDelAction`. `dispatchTransaction` reads `tr.getMeta(TC_RESOLVE_META) === true` and skips ONLY `rewriteForTrackChanges`; the synthesized `'input'` event and `onUpdate` debounce still fire because the doc text genuinely changed (linter and React state must see it). Without this gate, accept-del under TC dispatches `tr.delete(from, to)` over a `revisionDel`-marked range and the rewriter silently no-ops it (`collectDeleteSegments` only treats own-author `revisionAdd` as 'cancel'; everything else is 'mark' which re-applies the already-present `revisionDel`). FloatingToolbar's `applyInlineRevisionResolveTr` callers do NOT yet set this meta — their reject-add path is potentially affected by the same root cause and can adopt the meta when surfaced. Pinned by `src/components/__tests__/PmEditableBlock-tc-resolve.test.jsx`.
- **Nested CRDT slots must be skeleton-then-populate.** The invariant covers BOTH the Y.XmlFragment html slot AND the nested Y.Map table/ref slots — every nested shared type MUST be attached to its parent (`yMap.set('html'|'table'|'ref', yChild)` or `yStore.set(id, yMap)`) BEFORE any operation reads its children. Two distinct trigger paths, same warning string (`"Invalid access: Add Yjs type to a document before reading data"`): (a) Y.XmlFragment via `prosemirrorToYXmlFragment(pmNode, yXml)` — y-prosemirror's diff-and-merge calls `toArray()` internally (issue #77, PR #81); (b) nested Y.Map via `tableToYStructure(yTable, …)` — clears existing keys via `[...yMap.keys()]`, which Yjs's `createMapIterator` gates on `parent.doc` (issue #83, PR #84). Y.Map's `set` / `delete` themselves are SAFE on detached maps (use `_prelimContent`), which is why the ref CRDT path doesn't empirically warn even when constructed bottom-up — it uses only `set`/`delete`, never `keys()`. Default sample × 3 tables = 3 warnings; under PR #51's CI flake conditions the y-prosemirror flood was hundreds, overwhelming Chromium → Playwright IPC and producing browserContext timeouts. `src/lib/collab.js` enforces both via `blockToYMapSkeleton` (creates empty fragment + empty table/ref Y.Maps) + `populateBlockHtml` (html) + `populateBlockTableRef` (table/ref) — all called after `yStore.set`. `updateYMapFromBlock`'s legacy-string-or-new branches likewise `ymap.set(...)` the fresh nested Y.Map BEFORE invoking the structure builder. `src/lib/block-html-store.js`'s `seedHtmlSlot` does `yMap.set('html', yXml)` before populating. `src/lib/ytable-crdt.js` applies the same invariant at every nested level (yRows / each yRow / each yCell / each cell-text Y.Text). CI flake source fixed in `f74cbb8`; table/ref extension landed in PR #84.
- **Block focus goes through `block-registry`, not `querySelector`.** App's `focusBlock(id, atEnd)` calls `focusBlockById(id, { atEnd })` from `src/lib/block-registry.js`. `PmEditableBlock` and `TitleBlock` both register an imperative handle on mount: PmEditableBlock dispatches `Selection.atEnd` / `atStart` against its `EditorView`; TitleBlock places a DOM `Range`. App falls back to `document.querySelector('[data-block-id="…"]')` only when registration hasn't fired yet (e.g. brand-new `block.isNew=true` before its mount effect runs).
- **PmEditableBlock subscribes to the html SLOT reference via `useSyncExternalStore + subscribeBlock` (1f.5 mount race + 1i-b.2 broker-swap fix).** Two distinct races. (1) **Mount race:** Child useEffects fire before parent useEffects in React's commit phase, so PmEditableBlock's mount runs BEFORE App's seed effect (`applyBlocksToYDoc` out-of-room, `useCollabSession`'s publish effect in-room). For new blocks (Enter / slash-convert), `yStore.get(block.id)` returns undefined and the mount bails — yStore identity is unchanged after seeding so deps don't re-trigger. (2) **Broker swap:** The 1d server-side migration broker swaps the slot from Y.Text → Y.XmlFragment via `yMap.set('html', frag)`, which does NOT change the outer yMap identity — if the snapshot returned the yMap, `Object.is` would dedupe and the migration-partial banner would stick forever. The snapshot returns the inner html slot reference so both transitions are observable; `yMapBound = yStore?.get(block.id) || null` is derived inline each render for the EditorView's binding and is referentially stable across PM keystrokes (so the mount effect does not re-fire on every render). Tests: `src/components/__tests__/PmEditableBlock-mount-race.test.jsx`, `src/lib/__tests__/migration-partial-banner.test.jsx` (broker-swap regression).
- **PM `dispatchTransaction` uses `this`, not the outer `view` const (1e regression, fixed #61).** y-prosemirror's `ySyncPlugin` dispatches its initial-sync transaction synchronously from `view(editorView)` during the `EditorView` constructor — before `const view = new EditorView(...)` is assigned. `view.state.apply(tr)` TDZs. PM invokes `dispatchTransaction.call(view, tr)`, so `this` is bound on every call including the in-constructor one. Pinned by `src/lib/__tests__/pm-editor-mount.test.js` (positive + bug-shape counter-test).
- **PmEditableBlock auto-focuses `block.isNew` on first mount (1f.7).** Block-creation flows (handleEnterKey, slash-convert) rely on the editor mount placing the caret — PM dispatches `view.focus()` + `Selection.atEnd`. Gated by `hasAutoFocusedRef` so a later `yMapBound` flip (1d migration broker) doesn't steal focus on a block whose `isNew` was never explicitly cleared. Without this, `createFreshBlock` in Playwright returns the OLD block's locator and every downstream test branches on the wrong block.
- **PM paste is plaintext-only by design (#99).** `PmEditableBlock`'s `handlePaste` EditorProp discards `text/html` and the parsed `slice`, runs `event.clipboardData.getData('text/plain')` through `sanitizePasteText` (`src/lib/paste-sanitize.js`), and dispatches `tr.insertText`. Without it, PM's default `clipboardParser` materializes any DOM matching the schema's `parseDOM` rules — `pm-schema.js` accepts generic `<b>`/`<strong>` for `bold`, so rich text from Word survives as schema marks. Two paste paths must stay in lockstep: `TitleBlock.onPaste`, `PmEditableBlock.handlePaste` — both import from the same `paste-sanitize.js` module. Adding a third `contentEditable` or PM EditorView that accepts spec text must wire one of these handlers. TC mode interaction is automatic — the dispatched `insertText` passes through `dispatchTransaction` and `rewriteForTrackChanges` wraps the inserted text in `revisionAdd`. Pinned by `src/lib/__tests__/pm-editor-paste.test.js`, which invokes the configured prop directly via `view.someProp('handlePaste', f => f(view, mockEvent, null))` — no jsdom event-dispatch ceremony needed; pattern is reusable for any future PM EditorProp test.

**`'migration-partial'` connection state is editable + sticky.** App's `collabReadOnly` formula explicitly excludes `'migration-partial'` (room stays editable per ADR-0006), and `useCollabSession.migrationPartialRef` re-pins the status on every subsequent `'connected'` transition so a trailing handleSync doesn't clobber the banner. Don't add the state to the read-only set; don't drop the sticky pin.

**Playwright WHATWG URL pitfall.** Don't try `baseURL: '.../?pm=1'` for any project-level option toggle — `new URL('/', '.../?<query>')` drops the search component (per WHATWG URL), so `page.goto('/')` resolves with no query. If a future flag flip needs project-level differentiation, use a fixture that calls `context.addInitScript` to set a window property pre-load (the `forcePmEditor` fixture used this pattern before its retirement in 1i-b.2 — `git log -- tests/e2e/fixtures.js` recovers it).

**PM plugin module set.** `src/lib/pm-plugins/` contains: `slash-menu.js` (PM `Plugin` with `{open, filter}` state, popup stays the React `SlashMenu.jsx`); `tag-labels.js` (widget `DecorationSet` for inline mark labels — pseudo-elements don't create caret positions inside contentEditable, but widget decorations do); `keymap.js` (Enter / Shift+Enter / Tab / Shift+Tab / Backspace-on-empty / ArrowUp-at-start / ArrowDown-at-end → callbacks supplied by `PmEditableBlock`); `relpos-selection.js` (Y.RelativePosition save/restore; uses y-prosemirror's binding-aware `getRelativeSelection` (save) and `relativePositionToAbsolutePosition` (restore). A binding is required — without one, `saveSelection` returns `null` and `restoreSelection` returns `false`. The previous `Y.createRelativePositionFromTypeIndex` fallback was removed because it anchored against the fragment's child slots while the restore path read `absPos.index` as if it were a PM offset, producing silent off-by-one selections); `active-comment.js` (singleton `activeCommentId` plugin state, inline `Decoration` applying `mark-comment-active` class to matching `comment` mark range; imperative setter `setActiveComment(view, commentId)` via meta dispatch; same-id meta short-circuit + DecorationSet cache rebuilt only on `tr.docChanged || activeCommentId changed` per PM guide Decorations section). **`Decoration.inline` wraps in a nested `<span>` inside the mark's own `<span>` — it does NOT merge classes onto the parent.** Active-state CSS must use a descendant combinator (`.mark-comment .mark-comment-active`), not a compound selector (`.mark-comment.mark-comment-active`). `editor.css` ships both forms; the compound version is dead but harmless and matches what readers expect. Same pattern applies to any future inline decoration layered over an existing PM mark. The `NO_EXFIL_PM_ATTRS` constant in `PmEditableBlock.jsx` is the lowercase-HTML translation of `NO_EXFIL_PROPS` (`spellCheck` → `spellcheck`, etc.) wired into PM's `EditorProps.attributes`; both sets are pinned by `src/lib/__tests__/no-exfil.test.js`.

`window.__collab` is exposed in DEV (`import.meta.env.DEV`) for browser-side debugging — gives you `{ ydoc, yOrder, yStore, yMeta, yTc, yComments, awareness, provider, undoManager, publishBlocks, publishMeta, publishTc, dispatchComment, setCursor, undo, redo, canUndo, canRedo, destroy }`.

**"Connecting to room…" forever?** `useCollabSession`'s lifecycle effect is gated on `inRoom && identity`. If `localStorage` has no saved identity, the app shows a name prompt and the WebSocketProvider is never instantiated. Banner persists indefinitely; `/health` shows 0 connections. Fill the name prompt to unblock.

**"WebSocket is closed before the connection is established" warning in dev?** Benign React.StrictMode artifact, NOT a bug. `main.jsx` wraps the app in `<React.StrictMode>`, which intentionally double-mounts every effect (mount → cleanup → mount) in development to surface effect bugs. The first `useCollabSession` mount opens a `WebsocketProvider`, the cleanup destroys it (closing the WS before its `open` event fires), and the second mount opens a fresh one that stays open. Chromium's native WebSocket implementation logs the warning for the aborted first attempt. Verify the actual state via `window.__collab.provider.wsconnected` (should be `true`) and `window.__collab.yOrder.length` (should match the persisted room). Does not occur in production builds. Do not "fix" by removing StrictMode.

## Storage Backends

Three storage backends are wired: `local` (default, disk under `server/collab-db/`),
`azure` (Azure Blob, see `server/storage-azure.cjs`), and `s3` (S3-compatible
including Cloudflare R2 and MinIO, see `server/storage-s3.cjs`). Selected via
`SIM_STORAGE_BACKEND`. S3 backend uses the `SIM_S3_*` env vars.

**Local backend dir override.** `SIM_LOCAL_STORAGE_DIR` overrides the default `server/collab-db/` for the local backend (PR #113). Playwright's `webServer.env` sets it to `server/collab-db-e2e/` so E2E and dev storage never share state; `tests/e2e/global-setup.js` wipes that dir before each suite with a hard guard that refuses any path not ending in `-e2e` (so a typo cannot destroy dev rooms). Dev rooms in `server/collab-db/` are never touched by an E2E run.

All three extend `RoomStorageBase` (`server/room-storage.cjs`), which owns the public methodset (`writeRoom / readRoom / deleteRoom / listRooms / statRoom / quarantineRoom / archiveRoom / restoreRoom / listArchivedRooms / deleteArchivedRoom`) by composing seven adapter primitives (`_putBytes / _getBytes / _deleteKey / _listKeys / _statKey / _copyKey / _keyForArtifact`) plus three name-parsing hooks. Shared `sanitize()` and the `ARTIFACT_CATALOG` (`.ydoc` LAST = source of truth) live in `server/storage-shared.cjs`. Adding a fourth artifact is a one-line catalog edit; adapters never decide write order. Local overrides `writeRoom` for stage-rename-rollback atomicity (filesystem rename); Azure overrides it for `.ydoc` blob lease (multi-instance safety); S3 inherits the default sequential `.ydoc`-LAST write (R2 has no transaction primitives). See [ADR-0005](docs/adr/0005-storage-adapter-atomicity-per-backend.md) for why atomicity is per-backend. Cross-backend contract verified by `server/__tests__/storage-contract.test.mjs` (12 assertions × 3 backends = 36 tests). `listArchivedRooms` returns `{ id, archivedAt }` uniformly with ISO-8601 timestamps — both fields are required by the collab-server sweep.

## Collaboration Server

Real-time multi-user editing via Yjs + y-websocket. Server lives in `server/`:

- `server/collab-server.cjs` — y-websocket relay. Exposes `createCollabServer({ storage })` factory; CLI entry-point gated by `if (require.main === module)` so tests can `require()` without binding a port.
- `server/http-handler.cjs` — HTTP endpoints (`/rooms`, `/rooms/:id`, `/rooms/:id/sec`, `/rooms/:id/comments`, `/health`, `/rooms/:id/upload`).
- `server/room-serializer.cjs` — extracts .SEC + .comments.json from a Y.Doc on flush.
- `server/storage-{local,azure,s3}.cjs` — pluggable persistence backends.
- `server/migrate-pm-substrate.cjs` — sub-PR 1d (#47, [ADR-0006](docs/adr/0006-pm-substrate-migration.md)) v1 → v2 substrate broker (Y.Text → Y.XmlFragment). Hooked into `collab-server.cjs`'s upgrade handler after the preload + eviction-guard re-install; the broker awaits `storage.archiveRoom` (Q23/B2) before mutating the doc, runs migration under a per-room async lock (Q22/B1), and stamps either `yMeta.schemaVersion = 2` or `yMeta.migrationPartial = true` (mutually exclusive). The Y.Text-delta → Y.XmlFragment adapter is hand-coded (no `prosemirrorToYXmlFragment` import) to avoid compounding the dual-package "Yjs was already imported" warning.
- `server/auth/auth-provider.cjs` — JWT auth (optional via env).
- `server/__tests__/` — `node --test` integration suite. Run via `npm run test:server`.

**y-websocket v1 is pinned** (Dependabot bump to v3 deliberately deferred). The fix for issue #17 is built around v1 internals — `closeConn` deletes the docs Map entry by NAME (not by instance) when a doc's last conn drops. Upgrading to v3 needs the eviction-guard logic re-validated.

**CJS on purpose:** y-websocket v1 ships its server utils as CJS and `require`s yjs. Mixing ESM and CJS loads two copies of yjs and breaks `instanceof` checks (yjs/yjs#438). The "Yjs was already imported" warning during tests comes from the room-serializer's dynamic `import('../src/lib/sec-serializer.js')` — known and documented; do not "fix" it by switching the server to ESM.

### Four non-obvious patterns

1. **`extractDocName` strips a leading `/ws/`.** `VITE_COLLAB_WS_URL` in production deploys is `wss://host/ws`; WebsocketProvider then connects to `wss://host/ws/<room>`. y-websocket's default extraction (`req.url.slice(1).split('?')[0]`) yields `"ws/<room>"` — sanitized to `ws_<room>.ydoc` in storage. Without `extractDocName`, you get parallel rooms (one HTTP-managed, one WS-managed). See `server/collab-server.cjs:67`.

2. **Stale-close eviction guard.** y-websocket's `closeConn` (`node_modules/y-websocket/bin/utils.js:208`) does `docs.delete(doc.name)` keyed by name when a doc's last conn drops. If a previous WS connection's TCP close drains during a new connection's preload `await`, the stale close evicts our just-loaded doc and `setupWSConnection` creates a fresh empty replacement that bypasses preload — sync step 1 fires with empty state, the client seeds, persisted state CRDT-unions on top, yOrder doubles. Mitigated by re-installing the preloaded doc into `ywsDocs` after the await but before `handleUpgrade`. See `server/collab-server.cjs` (~line 360, the preload re-install block in the upgrade handler) and the deterministic regression test in `server/__tests__/collab-server.test.mjs`. The guard is re-installed a SECOND time after the broker await (1d) for the same reason.

3. **Migration broker invariants (1d).** The broker between preload and `handleUpgrade` adds another await window — same eviction risk, same re-install pattern. Three things are load-bearing: (a) `yMeta.schemaVersion` and `yMeta.migrationPartial` are mutually exclusive — broker code must never write both in the same migration; (b) `archiveRoom` MUST happen before any mutation, archive failure aborts (room stays v1); (c) per-block conversion catches every throw and tracks it as `migrationPartial` rather than rolling back the whole migration — half-converted rooms remain editable for both v1 and v2 clients. See [ADR-0006](docs/adr/0006-pm-substrate-migration.md).

4. **`GET /rooms` iteration yields the event loop (PR #112, issue #100).** The handler iterates every persisted room and calls `Y.applyUpdate` synchronously to extract section metadata from the `.ydoc` bytes. With the OS file cache warm, the surrounding `await storage.readRoom(id)` resolves without releasing the loop, so listing N rooms freezes the event loop for `N * decode_ms` — observed up to 2.7s with 100 rooms, enough to starve WS handshakes and other HTTP handlers for any concurrent client. Mitigated by `await new Promise(resolve => setImmediate(resolve))` at the top of every iteration in `server/http-handler.cjs`. Looks like a no-op but is load-bearing — the regression test (`server/__tests__/http-list-rooms-event-loop.test.mjs`) installs a 25ms ticker, fires `GET /rooms` against 40 seeded rooms, asserts `maxGap < 200ms`, and fails ~500ms without the yield.

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

## Agent skills

### Issue tracker

GitHub issues in `mttvnst-HA/secwriter` via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary — `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context — `CONTEXT.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.
