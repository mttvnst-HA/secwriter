# SecWriter

A modern web-based editor for UFGS (Unified Facilities Guide Specifications) .SEC files, replacing the legacy SpecsIntact desktop application (SIEditor).

**Terminology:** "SecWriter" = this web app (previously called "SpecsIntact Modern" / "SIM"; renamed to comply with the legacy SpecsIntact EULA). "SpecsIntact" / "SIEditor" = the legacy Windows desktop application — that name refers only to the legacy product, never to this app.

## Project Context

**What this is:** A rich text editor that reads and writes SpecsIntact .SEC files (XML-based SGML, windows-1252 encoding, used by the U.S. military for construction specifications). The editor feels like Google Docs or Notion while preserving the underlying SGML structure.

**Who it's for:** Engineers (especially geotechnical) who currently use MS Word as a workaround because SpecsIntact's tag-based editing is too clunky. The tool eliminates the Word-to-SpecsIntact round-trip workflow.

**Key design principle:** The engineer should never think about tags or SGML. Enter creates a paragraph. `/` opens a block type menu. Tab promotes/demotes headings. The SGML structure is inferred from context, not selected from a toolbar.

## Orientation

- `src/App.jsx` — main editor layout, state, toolbar, sidebar
- `src/components/` — block components (EditableBlock, **PmEditableBlock** (1e), TitleBlock, TableBlock, RefBlock), panels (CompliancePanel, CrossRefPanel, CommentPopup), tooltips, wizards, plus `useBlockLinting.js` (per-block lint lifecycle hook) and `useBlockBinder.js` (per-block Y.Doc ↔ React binder via `useSyncExternalStore`; substrate is Y.XmlFragment post-1d, with Y.Text legacy fallback for migrationPartial slots). `EditableBlock.jsx` is the legacy contentEditable path; when `VITE_PM_EDITOR=true` (or `?pm=1`) it delegates to `PmEditableBlock.jsx` which mounts a y-prosemirror EditorView per block.
- `src/hooks/` — `useCollabSession.js` (Yjs session lifecycle + the four publish effects + coordination refs)
- `src/lib/` — parsers/serializers (sec-parser, sec-serializer, encoding), pure-reducer modules (`track-changes.js`, `comments.js`, `linting.js`, `compliance.js`), domain-side-effect modules (`compliance-ranges.js`), compliance engines (compliance-rules, compliance-checker, compliance-ai, inline-linter, grammar-checker, nlp-rules), revisions, table-ops, numbering, plus `block-html-store.js` (Y.Doc-as-substrate adapter for block html — Y.XmlFragment as of 1d, with Y.Text legacy fallback for migrationPartial rooms), `pm-schema.js` + `pmdoc-html.js` (PM schema + serializer, 1c — used by the binder write path and by `yMapToBlock`'s Y.XmlFragment branch in collab.js), `ytext-html.js` (legacy Y.Text ↔ HTML conversion, retained for the migration partial path and load-boundary defenses), `feature-flags.js` (1e VITE_PM_EDITOR flag with URL `?pm=` and `window.__SIM_FORCE_PM_EDITOR` overrides), `block-registry.js` (1e App-scoped imperative-handle registry replacing `querySelector('[data-block-id="…"]')` in App), and `pm-plugins/` (slash-menu, tag-labels, keymap, relpos-selection — PM plugin set used by `PmEditableBlock`)
- `src/data/` — `ufs-1-300-02-rules.json` (compliance rules), `umrl.json` (reference DB), `umsl.json` (submittal DB), sample spec
- `reference/section.ini` — **authoritative** formatting rules (MARGINS, COLORS, RULES, CODES, FONTS)
- `reference/ufs_1_300_02.pdf` — authoritative source for compliance rules
- `reference/UFGS_M/` — 690 .SEC files for parser validation
- `tests/e2e/` — Playwright suite: `editor.spec.js` (141 tests) + `collab.spec.js` (10 tests)
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
6. **Source files contain the literal characters `\u200B` (six chars: backslash, u, 2, 0, 0, B) in regex literals** — e.g. EditableBlock.jsx has `replace(/\u200B/g, "")`. When you copy that string through the Edit tool, JSON decodes `\u200B` into the actual zero-width space character (U+200B) and the match fails silently. Anchor your old_string on a different nearby line.
7. **CI-only flakes are timing races.** When a test fails only on a CI runner but passes 10×/10 locally, do NOT keep re-running locally — write a deterministic regression test that forces the race (e.g., manually mutate shared state mid-`await`). See `server/__tests__/collab-server.test.mjs` for the pattern (force-delete the y-websocket docs Map during a slow-storage read to expose the eviction race).
8. **CSP allowlist is a CI gate.** Adding a new remote origin (`connect-src`, `script-src`, etc.) requires updating `ALLOWED_REMOTE_HOSTS` in `src/__tests__/csp.test.js`. Don't delete the test — update it.
9. **PM-aware E2E injection routes through `window.__simEditorTestUtils` (1f.7).** Tests that inject block state via `el.innerHTML = '...'; el.dispatchEvent('input')` work in legacy (DOM is the source of truth) but PM's render cycle overwrites the DOM. Use `injectBlockHtml(page, blockId, html)` / `readBlockHtml(page, blockId)` from `tests/e2e/pm-helpers.js` instead. The DEV-only seam is wired in `src/App.jsx` and routes through `handleBlockUpdateWithSync` so the legacy DOM also stays in sync — its substrate→DOM effect skips writes while a block is focused, so a plain `handleBlockUpdate` injection would update React state + substrate but leave the legacy DOM stale, and the next blur would clobber. **1f.9 additions:** `__overrideFlush(enabled)` / `__isFlushOverridden()` let a test disable the FloatingToolbar's `flushPendingUpdateById` call so the synchronous-flush invariant can be unit-tested in isolation; `pmSetSelection(page, blockId, from, to)` / `pmGetSelection(page, blockId)` in `pm-helpers.js` drive a PM `TextSelection` from a Playwright test via `getBlockView`.
10. **Before claiming "no E2E regressions," run the FULL `editor.spec.js` and `collab.spec.js` under BOTH `--project=chromium-legacy` AND `--project=chromium`.** Per playwright.config.js the merge gate is "both green." Spot-checking specific tests under one project misses cross-project regressions — this is how the legacy-mode `snapshotText` regression in PR #95 reached CI.

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

**TRANSPARENT tags** (inline wrappers, 20): ADD, ATT, BLD, CHG, CTR, DEL, ENG, HL1, HL2, HL3, HL4, HLS, INC, ITA, MET, SBS, SPS, TAI, TST, UND, URL

**Data-driven inline tags:** SUB (submittals→register), SRF (section cross-refs→validate), RID (citations→sync with REFERENCES), TAI (tailoring by branch/region/delivery), ENG/MET (dual unit pairs)

**Block hierarchy:** SEC > PRT > SPT > {TXT, OLG, OLI, LST, ITM, NTE, NPR, NPG, SBM, TAB, TBL (preformatted), TTL, REF}

## contentEditable Focus Management

This is the LEGACY contentEditable path (pre-1e). PM-mounted blocks (`PmEditableBlock` under `VITE_PM_EDITOR=true`) take over focus via `block-registry` — see the "Nine non-obvious invariants" section for the post-1e pattern. The legacy notes below still apply when the flag is off.

The pattern that works for the legacy path:

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

TC marking is **per-keystroke via PM's dispatchTransaction intercept** (Q33, sub-PR 1h). The legacy snapshot-based diff approach is retired (Q35/Q37, sub-PR 1h). The reducer at `src/lib/track-changes.js` is now a 70-LOC shell over `{ enabled, publishSeq }`:

1. **State is opaque.** App reads it via selectors (`isEnabled`, `getPublishableState`, `revisionFlagForCreate`, `revisionFlagForDelete`) and mutates it via verbs (`enable`, `disable`, `acceptAll`, `rejectAll`, `applyRemote`). The retired verbs (`acceptInline`, `rejectInline`, `applyResolveAtBlock`, `markBlockCreated`, `getSnapshot`) are gone — per-keystroke marking lives in `PmEditableBlock.dispatchTransaction` and revision marks are applied directly to the PM doc.
2. **App-side handler collapse (Q35).** Three sibling handlers, picked by call-site substrate ownership: `handleBlockUpdate` (debounced typing path: substrate + setBlocks, NO resumeHistory); `handleLegacyRevisionAction` (legacy click path: substrate + setBlocks + resumeHistory — wired into legacy `EditableBlock`'s del-popup `onRevisionAction` and `FloatingToolbar`'s legacy revision-resolve path); `handleBlockUpdatePmSync` (PM click path: setBlocks + resumeHistory, NO setBlockHtml because ySyncPlugin's PM dispatch already wrote the substrate — wired into PM `FloatingToolbar` inline accept/reject and `PmEditableBlock` del-popup's `onRefreshTcSnapshot`).
3. **`resumeHistory()` + `forceFrame()` before any click-driven `setBlocks` (1h Q36 Commit C).** `useUndoableBlocks` auto-pauses for ~400ms after each input flush. A click handler (del-popup accept/reject, toolbar revision verb, accept-all, etc.) that fires `setBlocks` while paused captures NO snapshot — undo silently breaks. Never wire a click-driven action directly to `handleBlockUpdate` (which has no `resumeHistory()`); use the appropriate sibling from item 2. Commit C pairs each `resumeHistory()` call with a `(inRoomRef.current ? collab : localUndo).forceFrame()` so the Yjs UndoManager closes its current capture window before the click action — without this, the subsequent `applyBlocksToYDoc` `'local-publish'` write (in-room) or `setBlockHtml` write would coalesce with prior typing into a single frame, and one Ctrl+Z would revert typing+click together. The three multi-write gestures — `handleAcceptAll`, `handleRejectAll`, `handleComplianceAcceptGroup` — additionally wrap their N `setBlockHtml` writes in `framing.withUndoFrame(() => { … })` so the loop forms one frame regardless of captureTimeout. The paired `resumeHistory()` side lives until 1i retires `useUndoableBlocks`.
4. **Collab publish.** `publishSeq` is a monotonic counter bumped by every user-driven verb but not by `applyRemote`. The TC publish effect (inside `src/hooks/useCollabSession.js`) compares against `lastPublishedTcSeqRef` to decide "did this change come from us?" — replacing the imperative `tcDirtyRef` flag. App's `onTcReceived` handler calls `collab.markTcSeqApplied(next.publishSeq)` after `tc.applyRemote(...)` so the next render does not echo a remote-applied state back to peers.
5. **Wire payload (Q37).** `publishTcToDoc` writes ONLY `{ enabled }` — the legacy `yTc.snapshots` Y.Map is not touched by post-1h clients. Pre-1h-populated snapshots survive untouched so mixed-version rooms round-trip cleanly. `readTc` still emits `{ enabled, snapshots }` for backward compat with the pre-1h schema; the reducer's `applyRemote` drops the `snapshots` field. No `schemaVersion` bump in 1h — pre-1h clients editing post-1h rooms degrade in edit fidelity (their blur-time annotation has no snapshot baseline; no marks authored on their edits). 1i bumps `schemaVersion` to 3 when legacy goes away.
6. **Undo/redo coupling.** `useUndoableBlocks` snapshots `(blocks, tcState)` together as one frame; the hook is agnostic about tcState's shape. The Yjs UndoManager rewire (Q36) is implemented in later 1h slices.
7. **PM del-popup (1f.8).** `PmEditableBlock`'s `handleClick` routes through `applyDelAction` (pure HTML mutator at `src/lib/pm-del-popup.js`) and `onRefreshTcSnapshot` (`handleBlockUpdatePmSync`), since PM dispatch wrote the substrate. The mutator identifies the target del by DOM index, not by PM mark equality, because adjacent del marks with different `authorId` are separate marks in PM's schema.
8. **FloatingToolbar PM path (1f.9).** The five mark-application verbs (format, inline-mark, revision-apply, inline-revision-resolve, change-case) dispatch PM transactions via `pm-toolbar.js`'s pure verb functions when `block-registry.getBlockView(blockId)` returns a non-null `EditorView`. For four of the five, `flushPendingUpdateById(blockId)` runs after dispatch to close the 400ms debounce window so App's `blocks` array reflects substrate synchronously. **Inline accept/reject is the exception:** it uses `cancelPendingUpdateById(blockId)` (debounce clear without firing onUpdate) plus `handleBlockUpdatePmSync` (`resumeHistory() + setBlocks`, no `setBlockHtml`). `cancelPendingUpdate` is required because `handleBlockUpdate` runs outside any `resumeHistory()` window — a debounce-driven late setBlocks would land while `useUndoableBlocks` is paused. Out-of-room mode gets a proper undoable frame via `useUndoableBlocks`; in-room mode hits the broader PM-mode undo limitation tracked alongside the existing Ctrl+Y redo off-by-one.

## Comments Architecture

Comments use a pure reducer module (`src/lib/comments.js`) that owns a **DOM-based highlight + separate metadata store** — same playbook as Track Changes, Linting, and Compliance (opaque state, pure verbs, pure selectors, property-tested invariants — see also `src/lib/track-changes.js`, `src/lib/linting.js`, `src/lib/compliance.js`):

1. **State is opaque.** App holds it as `commentsState` and reads it via selectors (`size`, `get`, `all`, `isDraft`, `getCreateEntry`, `reconcileBlocks`, `normalizeForLoad`); mutates it via verbs (`createDraft`, `updateCreate`, `reply`, `resolve`, `reopen`, `remove`, `mergeRemote`). Shape: `{ byId: Map<commentId, Comment>, seenRemoteIds: Set<commentId> }`. Verbs return `{ state, publish }`; caller supplies `identity` and `ts`.
2. **Span↔metadata reconciliation is a selector.** App runs `useEffect([blocks, commentsState])` → `setBlocksDirect(prev => cm.reconcileBlocks(prev, commentsState))`. The selector unwraps orphan spans (id missing from state) and reclasses open↔resolved when className disagrees with `state.byId.get(id).status`. Idempotent — returns the original `blocks` ref when nothing changes; React bails out, no loop. Routed through `setBlocksDirect` (the non-undoable setter from `useUndoableBlocks`) so a reconcile after Ctrl+Z cannot wipe the redo stack. Post-1b, the same effect also mirrors any html change into the substrate via `setBlockHtml(activeYStoreRef.current, b.id, b.html)` so peers see comment-status reclassifies.
3. **Single collab dispatcher.** `session.dispatchComment(envelope)` switches on `envelope.kind ∈ {create, reply, status, delete}` and forwards to the underlying `*ToDoc` functions. The legacy four session methods (`publishComment`, `publishCommentReply`, `publishCommentStatus`, `deleteComment`) are gone. Verbs that produce no publish (drafts) return `publish: null`.
4. **`mergeRemote` semantics (M2.5).** For each id in `remote ∪ prev.byId`: if id is in remote, remote wins; else if id is in `seenRemoteIds`, drop (peer deletion); else preserve (local draft). `seenRemoteIds` is monotonically non-shrinking — once an id has been observed from peers, its later absence is authoritative.
5. **Editable blocks** persist comment spans in `block.html`; `reconcileBlocks` reclasses/unwraps them on every state change. **Ref/table blocks** derive spans at render time: `RefBlock` and `TableBlock` accept `commentsState` + `activeCommentId` props, call `cm.getBlockComments(state, block.id)`, and run each text field through `cm.computeCommentSegments(text, blockComments)` to wrap matching substrings with `mark-comment` / `mark-comment-resolved`. No DOM drift possible — spans are recomputed from metadata every render. The popup's click-to-open and active-highlight flow is identical to editable blocks.
6. **Active highlight is mode-conditional (1g).** PM-mounted editable blocks: the `activeCommentPlugin` (`src/lib/pm-plugins/active-comment.js`) holds a singleton `activeCommentId` plugin state; App calls `setActiveComment(view, commentId)` via `block-registry.getBlockView`. The plugin emits an inline `Decoration.inline(from, to, { class: 'mark-comment-active' })` over the matching `comment` mark's range. CSS rule: `.mark-comment.mark-comment-active` and `.mark-comment-resolved.mark-comment-active` (light + dark). DecorationSet is cached in plugin state per the PM guide's Decorations recommendation. — Legacy editable blocks: `CommentPopup`'s `useEffect` falls back to `document.querySelector('[data-comment-id]').setAttribute('data-active', 'true')` (gated on `getBlockView(blockId) == null`). — Ref/table blocks: React renders `data-active="true"` from the `activeCommentId` prop. The popup's `setAttribute` is also gated for those (their `getBlockView` returns null too, so the `setAttribute` runs but is a harmless duplicate of the React-rendered value). Reconcile (item 10) owns the className transitions across `comment.status` flips.
7. **Load-boundary shim.** `normalizeForLoad(rawCommentsObj)` runs in `onRemoteComments` and the auto-save restore path. It promotes legacy `author` → `authorName` and `timestamp` (ISO) → `ts` (number); canonical fields take priority. The module never sees legacy fields.
8. **Export:** serializer strips `mark-comment` spans. A sidecar `.comments.json` is saved alongside the `.SEC` file.
9. **File import clears comments** — `loadSECContent()` calls `setCommentsState(cm.createInitial())` so comments from a prior file don't leak.
10. **Toolbar comment-create path (post-#64 resolution).** In PM mode, the FloatingToolbar comment button dispatches `applyCommentMarkTr` (`src/lib/pm-toolbar.js`) and reaches the substrate via ySyncPlugin — same shape as the other five mark verbs converted in 1f.9. Legacy mode (and ref/table blocks, which have no PM EditorView registered) keeps the `range.surroundContents(<span class="mark-comment">)` DOM-mutation path; the substrate catches up on the next `handleInput` debounce (or stays stale until the user types again — a pre-existing wart in legacy mode, not introduced here). Issue #64's original claim that `prosemirrorToYXmlFragment` dropped the `comment` mark was a misdiagnosis: empirically the mark survives, and the failing Playwright test it cited was actually using legacy `el.innerHTML` injection in PM mode (PM's domObserver doesn't reliably handle wholesale innerHTML replacement). Pinned by `pmdoc-html.test.js`'s `prosemirrorToYXmlFragment integration` describe block.

**Substrate-side reconcile (1g).** For PM-mounted blocks, a per-block `useEffect([commentsState])` in `PmEditableBlock.jsx` calls `reconcileCommentMarks(view.state, commentsState)` (`src/lib/pm-comments.js`) and dispatches the returned tr. The verb is idempotent — receiving peers (whose substrate is already updated via the originator's ySyncPlugin op) get a null tr and dispatch nothing. The tr is tagged with `COMMENT_RECONCILE_META`; `dispatchTransaction` skips the synthesized `'input'` event and the `onUpdate` debounce for reconcile-tagged trs. The latter is empirically necessary (see `src/lib/__tests__/setblockhtml-echo-behavior.test.js`) — un-gated `onUpdate` would call `setBlockHtml(..., 'local-publish')` and produce an echo Yjs op the UndoManager captures. Legacy blocks continue to use `cm.reconcileBlocks` (html walk) — the App-level effect uses a `shouldSkip` predicate so PM-mounted blocks are skipped from the html walk.

## Tag Visibility Toggle

The `</>` button toggles `tags-hidden` (default) vs. `tags-visible` on the editor container:

1. **Inline marks:** real `<span contentEditable="false" class="tag-label">` DOM nodes injected by `syncTagLabels()` in EditableBlock. `MARK_TAG_MAP` maps mark classes to SGML names (`mark-rid`→`RID`). TAI marks include `data-opt`. Tag labels stripped from innerHTML via `stripTagLabels()` before saving to state.
2. **Block-level tags:** CSS `::before`/`::after` with `data-tag` attributes on block wrapper `<div>`s (outside contentEditable, no caret issues).
3. **Why real DOM nodes for inline marks:** CSS pseudo-elements don't create caret positions in contentEditable — the browser can't place the cursor between `::before` and the first text character. `contentEditable="false"` spans provide proper DOM boundaries.
4. **PM path (1e, `VITE_PM_EDITOR=true`):** inline marks come from `src/lib/pm-plugins/tag-labels.js` — a widget `DecorationSet` instead of injected DOM nodes. Same caret-boundary reasoning as item 3, but PM widgets are the equivalent primitive. Block-level pseudo-elements are unchanged.

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

Post-#46 (sub-PR 1b), block **html** and block **scalars** travel separate paths. See [ADR-0004](docs/adr/0004-collab-publish-snapshot-diff.md). Sub-PR 1d (#47, [ADR-0006](docs/adr/0006-pm-substrate-migration.md)) swapped the html slot from Y.Text to Y.XmlFragment with a server-side migration broker; the remaining character-level work (EditorView mount + per-keystroke ops) is tracked at issue #47 sub-PRs 1e+.

**Html path (per debounced keystroke, via the binder):**
1. `EditableBlock` calls `binderWrite(html)` from `handleInput` (debounced `PUBLISH_DEBOUNCE_MS = 400`ms) AND `handleBlur` (which also runs Track Changes annotation). Blur cancels any pending input debounce.
2. `binderWrite` is `useBlockBinder().write` — calls `setBlockHtml(yStore, blockId, html)` from `src/lib/block-html-store.js`. The substrate is now Y.XmlFragment (1d): `setBlockHtml` runs `htmlToPmFragment(html)` then `prosemirrorToYXmlFragment` inside a `'local-publish'` transaction. y-prosemirror's diff-and-merge preserves CRDT identity for unchanged inline runs, so concurrent peer edits to the same paragraph survive a same-debounce-window write. Legacy fallback: if a slot is still Y.Text (migrationPartial leftover), the call routes through `applyHtmlToYText` instead.
3. Read pathway: `useBlockBinder` subscribes via `useSyncExternalStore` to `subscribeBlock(yStore, blockId)`; remote ops flip the per-fragment dirty bit (observeDeep) and the binder re-renders. `getBlockHtml` derives via `pmFragmentToHtml` for Y.XmlFragment slots and falls back to `yTextToHtml` for legacy Y.Text slots.
4. `ydoc.on('update')` on the server debounces a flush to R2/local (`server/collab-server.cjs`). Server-side `yMapToBlock` (in `src/lib/collab.js`) now branches on duck-type — `pmFragmentToHtml(yXmlFragment)` for v2 slots, `yTextToHtml(yText)` for legacy. Without the branch, .SEC export would coerce `String(yXmlFragment)` and silently corrupt every migrated block (Q24/B3).

**Scalar/structural path (still publishBlocks):**
- `App.handleBlockUpdate` calls `setBlocks(prev.map(...))`. The publish effect inside `useCollabSession` calls `session.publishBlocks(blocks)` after the `sessionReadyRef` and `lastRemoteBlocksRef` echo guards pass.
- `applyBlocksToYDoc` (`src/lib/collab.js`) walks the block array and reconciles structure (yOrder, yStore keys, scalar fields). It **skips html for existing yText** (`fb34a0a`) — only seeds html for brand-new blocks. The binder owns html updates for everything else.

**Coordination lives in the hook, not App.** `useCollabSession` owns the session lifecycle, all four publish effects (blocks, meta, TC, comments dispatch), all coordination refs (`sessionReadyRef`, `metaReadyRef`, `lastRemoteBlocksRef`, `lastPublishedTcSeqRef`, `publishDisabledRef`), the `DocSizeLimitError` toast latch, and the cursor broadcast. App passes a prop bag of remote-event callbacks (`onBlocksReceived`, `onMetaReceived`, `onTcReceived`, `onCommentsReceived`, `onPresenceChange`, `onStatusChange`) and reads back `{ dispatchComment, markTcSeqApplied, tryUndo, tryRedo, canUndo, canRedo }`. The TC echo gate is a small protocol seam: App's `setTcState` updater calls `markTcSeqApplied(next.publishSeq)` after `tc.applyRemote(...)` so the publish effect treats the new state as already-seen by peers.

**Implication:** post-1d, the substrate is Y.XmlFragment, but writes still go through a snapshot-shaped seam (`prosemirrorToYXmlFragment` does diff-and-merge against the existing fragment, but each binder write replaces the doc-level snapshot in a single transaction rather than producing one CRDT op per keystroke). Sub-PR 1e (EditorView mount + `ySyncPlugin`) is what flips the keystroke→op-stream relationship. The debounced-input symptom fix landed via #21 / PR #23.

**Nine non-obvious invariants (load-bearing, easy to break):**
- **`yStore` is null until first sync.** `useCollabSession` only calls `setYStoreState(session.yStore)` from inside `if (meta?.initial)` (`fbc0d0f`). Until then `useBlockBinder.write` no-ops, and every direct `setBlockHtml(activeYStoreRef.current, ...)` caller in App must null-guard. Without this gate, a keystroke landing in the sync window CRDT-merges on top of the server's persisted state — the eee8977 corruption pattern via the new direct-substrate path.
- **The Yjs UndoManager tracks `'local-publish'` AND `ySyncPluginKey` (post-1h-Commit-B).** `setBlockHtml` writes use `'local-publish'`; y-prosemirror's per-keystroke ops use `ySyncPluginKey`. New code that mutates html outside the binder must go through `setBlockHtml` (not `applyHtmlToYText` or `prosemirrorToYXmlFragment` directly) or undo coverage is silently lost. App.jsx already has many direct call sites (revisions, compliance fixes, search/replace, accept-all, comments-reconcile, etc.); follow that pattern. The in-room manager lives in `createCollabSession` (`src/lib/collab.js`); the out-of-room manager lives in `useLocalSubstrateUndoManager` (`src/hooks/useLocalSubstrateUndoManager.js`). Both must stay in trackedOrigins lockstep or Ctrl+Z drifts between modes — the integration test `src/lib/__tests__/word-boundary-undo.test.js` ("hello world. → 3 frames") catches a drop of `ySyncPluginKey`.
- **`'migrate-v2'` is the broker-only origin.** Server-side migration writes (1d) use it. It is deliberately NOT `'local-*'` (so `handleAfterTx` in `collab.js` does NOT filter it — the first v2 client to join sees the migrated state via the normal sync path) and NOT `'local-publish'` (so the client-side UndoManager cannot Ctrl+Z a peer's pre-migration content). Don't reuse this origin for any write that originates on a client.
- **`ySyncPluginKey` is the PM-driven origin (1e, expanded 1h-Commit-B).** y-prosemirror's `ySyncPlugin` writes Yjs ops with origin `ySyncPluginKey`. It is distinct from `'local-publish'` — PM-driven keystrokes carry this origin, debounced echo writes via `setBlockHtml` carry `'local-publish'`. The 1h Commit B UndoManager rewire tracks BOTH so per-keystroke PM edits enter the stack (gated by the word-boundary-undo plugin's `forceFrame` for word-grain framing, matching Word/Notion). **Dual-stack-no-coalescing wart (transient, lives until 1i):** every keystroke produces both a `ySyncPluginKey` op (the actual PM write) and ~400ms later a `'local-publish'` echo op via `setBlockHtml` (the React state sync). Within the 500ms captureTimeout, both ops join the same undo frame — one Ctrl+Z reverts both correctly. Structural changes via `publishBlocks` ALSO populate `useUndoableBlocks` snapshots; Ctrl+Z routes to the Yjs manager first, leaving the snapshot stack stale. The 1i sub-PR retires `useUndoableBlocks` and both warts go away. App-side routing: in-room Ctrl+Z → `collab.tryUndo` → fall through to `localUndo.tryUndo` → fall through to `useUndoableBlocks.undo` (the last one is the legacy fallback).
- **`COMMENT_RECONCILE_META` is a PM-meta sentinel, NOT a Yjs origin (1g).** Defined in `src/lib/pm-comments.js` as `export const COMMENT_RECONCILE_META = {}` (sentinel object — identity-compared). Set via `tr.setMeta(COMMENT_RECONCILE_META, true)`. `dispatchTransaction` in `PmEditableBlock.jsx` reads it via `tr.getMeta(COMMENT_RECONCILE_META) === true` and skips the synthesized `'input'` event (linter) + `onUpdate` debounce (no `setBlockHtml` echo). The corresponding Yjs op produced by ySyncPlugin still uses origin `ySyncPluginKey` — the meta only governs PM-side filtering, not the substrate write path. Don't conflate this with a Yjs origin like `'local-publish'`.
- **Nested CRDT slots must be skeleton-then-populate.** The invariant covers BOTH the Y.XmlFragment html slot AND the nested Y.Map table/ref slots — every nested shared type MUST be attached to its parent (`yMap.set('html'|'table'|'ref', yChild)` or `yStore.set(id, yMap)`) BEFORE any operation reads its children. Two distinct trigger paths, same warning string (`"Invalid access: Add Yjs type to a document before reading data"`): (a) Y.XmlFragment via `prosemirrorToYXmlFragment(pmNode, yXml)` — y-prosemirror's diff-and-merge calls `toArray()` internally (issue #77, PR #81); (b) nested Y.Map via `tableToYStructure(yTable, …)` — clears existing keys via `[...yMap.keys()]`, which Yjs's `createMapIterator` gates on `parent.doc` (issue #83, PR #84). Y.Map's `set` / `delete` themselves are SAFE on detached maps (use `_prelimContent`), which is why the ref CRDT path doesn't empirically warn even when constructed bottom-up — it uses only `set`/`delete`, never `keys()`. Default sample × 3 tables = 3 warnings; under PR #51's CI flake conditions the y-prosemirror flood was hundreds, overwhelming Chromium → Playwright IPC and producing browserContext timeouts. `src/lib/collab.js` enforces both via `blockToYMapSkeleton` (creates empty fragment + empty table/ref Y.Maps) + `populateBlockHtml` (html) + `populateBlockTableRef` (table/ref) — all called after `yStore.set`. `updateYMapFromBlock`'s legacy-string-or-new branches likewise `ymap.set(...)` the fresh nested Y.Map BEFORE invoking the structure builder. `src/lib/block-html-store.js`'s `seedHtmlSlot` does `yMap.set('html', yXml)` before populating. `src/lib/ytable-crdt.js` applies the same invariant at every nested level (yRows / each yRow / each yCell / each cell-text Y.Text). CI flake source fixed in `f74cbb8`; table/ref extension landed in PR #84.
- **Block focus goes through `block-registry`, not `querySelector` (1e).** App's `focusBlock(id, atEnd)` calls `focusBlockById(id, { atEnd })` from `src/lib/block-registry.js`; legacy and PM EditableBlock both register an imperative handle on mount. The legacy path's handle still places a DOM `Range`; the PM path dispatches a PM `Selection.atEnd` / `atStart`. App falls back to `document.querySelector('[data-block-id="…"]')` only when registration hasn't fired yet (e.g. brand-new `block.isNew=true` before its mount effect runs). The 1i sub-PR adds a lint rule failing CI on any new `querySelector('[data-block-id=…]')` outside that single seam.
- **PmEditableBlock subscribes to yStore via `useSyncExternalStore + subscribeBlock`, doesn't just read it (1f.5).** Child useEffects fire before parent useEffects in React's commit phase, so PmEditableBlock's mount runs BEFORE App's seed effect (`applyBlocksToYDoc` out-of-room, `useCollabSession`'s publish effect in-room). For new blocks (Enter / slash-convert), `yStore.get(block.id)` returns undefined and the mount bails — yStore identity is unchanged after seeding so deps don't re-trigger. The subscription (snapshot = yMap reference or null) bridges the race. Test: `src/components/__tests__/PmEditableBlock-mount-race.test.jsx`.
- **PM `dispatchTransaction` uses `this`, not the outer `view` const (1e regression, fixed #61).** y-prosemirror's `ySyncPlugin` dispatches its initial-sync transaction synchronously from `view(editorView)` during the `EditorView` constructor — before `const view = new EditorView(...)` is assigned. `view.state.apply(tr)` TDZs. PM invokes `dispatchTransaction.call(view, tr)`, so `this` is bound on every call including the in-constructor one. Pinned by `src/lib/__tests__/pm-editor-mount.test.js` (positive + bug-shape counter-test).
- **PmEditableBlock auto-focuses `block.isNew` on first mount (1f.7).** Mirrors `EditableBlock.jsx:172-210` (`needsFocus`). Block-creation flows (handleEnterKey, slash-convert) rely on the editor mount placing the caret — legacy did it via the ref callback + Range, PM dispatches `view.focus()` + `Selection.atEnd`. Gated by `hasAutoFocusedRef` so a later `yMapBound` flip (1d migration broker) doesn't steal focus on a block whose `isNew` was never explicitly cleared. Without this, `createFreshBlock` in Playwright returns the OLD block's locator and every downstream PM-mode test branches on the wrong block.

**`'migration-partial'` connection state is editable + sticky.** App's `collabReadOnly` formula explicitly excludes `'migration-partial'` (room stays editable per ADR-0006), and `useCollabSession.migrationPartialRef` re-pins the status on every subsequent `'connected'` transition so a trailing handleSync doesn't clobber the banner. Don't add the state to the read-only set; don't drop the sticky pin.

**`VITE_PM_EDITOR` flag (1e).** Default-off through 1e/1f/1g/1h; the 1i sub-PR removes the flag and the legacy code path. Override precedence: `window.__SIM_FORCE_PM_EDITOR` > URL `?pm=1|true|on` > `import.meta.env.VITE_PM_EDITOR`. The Playwright config has a `chromium-pm` project (`baseURL: '…/?pm=1'`) so the editor + collab E2E suites run under both flag values; the 1e merge gate is "both projects green." When the flag is on, every editable block (`txt`, `note`, `oli`, `item`, `lst`) renders via `PmEditableBlock` instead of the legacy contentEditable component. Non-editable blocks (Title, Ref, Table, pagebreak) and the structural state (block.type/part/depth/section/level) are unchanged.

**Playwright PM-mode via fixture, not baseURL query (1f.5).** `tests/e2e/fixtures.js` exposes a project-level `forcePmEditor` option consumed by a `context.addInitScript` setting `window.__SIM_FORCE_PM_EDITOR = true` pre-load. Test files import `test, expect` from `./fixtures.js`, not `@playwright/test`. Don't try `baseURL: '.../?pm=1'` — `new URL('/', '.../?pm=1')` drops the search component (WHATWG URL), so `page.goto('/')` resolves with no query. The fixture is the only working primitive; the previous `?pm=1` baseURL silently ran legacy in both projects, which is how the 1e TDZ regression went undetected.

**PM plugin module set (1e).** `src/lib/pm-plugins/` contains: `slash-menu.js` (PM `Plugin` with `{open, filter}` state, popup stays the React `SlashMenu.jsx`); `tag-labels.js` (widget `DecorationSet` replacing `syncTagLabels` DOM injection — pseudo-elements don't create caret positions inside contentEditable, but widget decorations do); `keymap.js` (Enter / Shift+Enter / Tab / Shift+Tab / Backspace-on-empty / ArrowUp-at-start / ArrowDown-at-end → callbacks supplied by `PmEditableBlock`); `relpos-selection.js` (Y.RelativePosition save/restore; uses y-prosemirror's binding-aware `getRelativeSelection` (save) and `relativePositionToAbsolutePosition` (restore). A binding is required — without one, `saveSelection` returns `null` and `restoreSelection` returns `false`. The previous `Y.createRelativePositionFromTypeIndex` fallback was removed because it anchored against the fragment's child slots while the restore path read `absPos.index` as if it were a PM offset, producing silent off-by-one selections); `active-comment.js` (singleton `activeCommentId` plugin state, inline `Decoration` applying `mark-comment-active` class to matching `comment` mark range; imperative setter `setActiveComment(view, commentId)` via meta dispatch; same-id meta short-circuit + DecorationSet cache rebuilt only on `tr.docChanged || activeCommentId changed` per PM guide Decorations section). **`Decoration.inline` wraps in a nested `<span>` inside the mark's own `<span>` — it does NOT merge classes onto the parent.** Active-state CSS must use a descendant combinator (`.mark-comment .mark-comment-active`), not a compound selector (`.mark-comment.mark-comment-active`). `editor.css` ships both forms; the compound version is dead but harmless and matches what readers expect. Same pattern applies to any future inline decoration layered over an existing PM mark. The `NO_EXFIL_PM_ATTRS` constant in `PmEditableBlock.jsx` is the lowercase-HTML translation of `NO_EXFIL_PROPS` (`spellCheck` → `spellcheck`, etc.) wired into PM's `EditorProps.attributes`; both sets are pinned by `src/lib/__tests__/no-exfil.test.js`.

`window.__collab` is exposed in DEV (`import.meta.env.DEV`) for browser-side debugging — gives you `{ ydoc, yOrder, yStore, yMeta, yTc, yComments, awareness, provider, undoManager, publishBlocks, publishMeta, publishTc, dispatchComment, setCursor, undo, redo, canUndo, canRedo, destroy }`.

**"Connecting to room…" forever?** `useCollabSession`'s lifecycle effect is gated on `inRoom && identity`. If `localStorage` has no saved identity, the app shows a name prompt and the WebSocketProvider is never instantiated. Banner persists indefinitely; `/health` shows 0 connections. Fill the name prompt to unblock.

**"WebSocket is closed before the connection is established" warning in dev?** Benign React.StrictMode artifact, NOT a bug. `main.jsx` wraps the app in `<React.StrictMode>`, which intentionally double-mounts every effect (mount → cleanup → mount) in development to surface effect bugs. The first `useCollabSession` mount opens a `WebsocketProvider`, the cleanup destroys it (closing the WS before its `open` event fires), and the second mount opens a fresh one that stays open. Chromium's native WebSocket implementation logs the warning for the aborted first attempt. Verify the actual state via `window.__collab.provider.wsconnected` (should be `true`) and `window.__collab.yOrder.length` (should match the persisted room). Does not occur in production builds. Do not "fix" by removing StrictMode.

## Storage Backends

Three storage backends are wired: `local` (default, disk under `server/collab-db/`),
`azure` (Azure Blob, see `server/storage-azure.cjs`), and `s3` (S3-compatible
including Cloudflare R2 and MinIO, see `server/storage-s3.cjs`). Selected via
`SIM_STORAGE_BACKEND`. S3 backend uses the `SIM_S3_*` env vars.

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

### Three non-obvious patterns

1. **`extractDocName` strips a leading `/ws/`.** `VITE_COLLAB_WS_URL` in production deploys is `wss://host/ws`; WebsocketProvider then connects to `wss://host/ws/<room>`. y-websocket's default extraction (`req.url.slice(1).split('?')[0]`) yields `"ws/<room>"` — sanitized to `ws_<room>.ydoc` in storage. Without `extractDocName`, you get parallel rooms (one HTTP-managed, one WS-managed). See `server/collab-server.cjs:67`.

2. **Stale-close eviction guard.** y-websocket's `closeConn` (`node_modules/y-websocket/bin/utils.js:208`) does `docs.delete(doc.name)` keyed by name when a doc's last conn drops. If a previous WS connection's TCP close drains during a new connection's preload `await`, the stale close evicts our just-loaded doc and `setupWSConnection` creates a fresh empty replacement that bypasses preload — sync step 1 fires with empty state, the client seeds, persisted state CRDT-unions on top, yOrder doubles. Mitigated by re-installing the preloaded doc into `ywsDocs` after the await but before `handleUpgrade`. See `server/collab-server.cjs` (~line 360, the preload re-install block in the upgrade handler) and the deterministic regression test in `server/__tests__/collab-server.test.mjs`. The guard is re-installed a SECOND time after the broker await (1d) for the same reason.

3. **Migration broker invariants (1d).** The broker between preload and `handleUpgrade` adds another await window — same eviction risk, same re-install pattern. Three things are load-bearing: (a) `yMeta.schemaVersion` and `yMeta.migrationPartial` are mutually exclusive — broker code must never write both in the same migration; (b) `archiveRoom` MUST happen before any mutation, archive failure aborts (room stays v1); (c) per-block conversion catches every throw and tracks it as `migrationPartial` rather than rolling back the whole migration — half-converted rooms remain editable for both v1 and v2 clients. See [ADR-0006](docs/adr/0006-pm-substrate-migration.md).

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
