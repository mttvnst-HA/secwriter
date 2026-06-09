# SecWriter — domain glossary

Names for the things SecWriter manipulates. This file is the source of truth for **domain** vocabulary used in code, tests, ADRs, and architecture reviews. It does **not** describe the system's architecture (that's `CLAUDE.md` and `docs/adr/`); it just gives the system's nouns and verbs precise names.

When a new concept becomes load-bearing in the codebase, add it here. When an existing term gets sharpened during a grilling/design conversation, update the entry in place. If you find yourself reaching for "component," "service," or "thing," check whether one of the names below already covers it.

For architecture vocabulary (module, interface, depth, seam, adapter, leverage, locality), see the `improve-codebase-architecture` skill's `LANGUAGE.md`.

---

## The document

**.SEC file** — A SpecsIntact section file: SGML-based XML, `windows-1252`-encoded. The on-disk artifact this app reads and writes.

**UFGS** — Unified Facilities Guide Specifications. The U.S. military's construction specification system. SecWriter edits sections from the UFGS catalog.

**SGML / XML** — The .SEC format is XML in shape, but its tag set and conventions descend from SGML. `windows-1252` byte mapping (curly quotes, em-dash, euro, trademark, bullet) is part of the format, not optional.

**UFS 1-300-02** — The USACE specification standard that governs UFGS authoring style: required imperative mood, prohibited terms ("shall," "will," etc.), prohibited symbols, vague terms, capitalization rules. The compliance engine encodes this standard.

**section.ini** — Authoritative formatting reference (`reference/section.ini`). Defines `[MARGINS]`, `[COLORS]`, `[RULES]`, `[CODES]`, `[FONTS]`. Read this before changing any visual styling — it overrides intuition.

**UMRL** — Unified Master Reference List. 302 organizations, 4,973 entries. Source of truth for the Reference Wizard.

**UMSL** — Unified Master Submittal List. 13,203 submittal entries.

---

## Editor model

**Block** — The atomic unit of the document. A flat-array entry with `id`, `type`, `part`, `depth`, `html`, optional `revision`, and type-specific payloads. Blocks are not nested in state — nesting is implied by `part` + `depth` + `section`. Each editable block is rendered by `PmEditableBlock` (one PM `EditorView` per block) bound to its Y.XmlFragment substrate.

**Block type** — One of: `title`, `txt`, `note`, `oli`, `item`, `lst`, `table`, `ref`, `pagebreak`, `tbl`. Determined by SGML tag at parse time, chosen via slash menu at edit time.

**Tag** — An SGML element name (TXT, OLI, RID, SUB, etc.). Tags are categorized by `[CODES]` in section.ini as either block-level or transparent.

**Transparent tag** — An inline SGML wrapper that does not break flow: ADD, ATT, BLD, CHG, CTR, DEL, ENG, HL1–HL4, HLS, INC, ITA, MET, SBS, SPS, TAI, TST, UND, URL. Rendered as a `<span>` with a `mark-*` class in the editor.

**Mark** — The DOM representation of a transparent tag (`<span class="mark-rid">`, `<span class="mark-add">`, etc.). The editor never asks the user about tags — marks are derived from semantics or applied via toolbar.

**Tag label** — The visible `RID`, `SUB`, etc. caret-anchorable indicator that appears when tag visibility is toggled on. Real DOM nodes (`contentEditable="false"`), not CSS pseudo-elements — pseudo-elements don't create caret positions.

**Slash menu** — The block-conversion UI triggered by typing `/`. The primary interface for block-type changes.

**Block hierarchy** — `SEC > PRT > SPT > {TXT, OLG, OLI, LST, ITM, NTE, NPR, NPG, SBM, TAB, TBL, TTL, REF}`. PRT is a numbered top-level part; SPT is a section/subsection wrapper; the leaf types hold visible content.

**OLI level** — Outline list level 1–4 per UFS Figure A-1. Level 1 = `a.`, level 2 = `(1)`, level 3 = `(a)`, level 4 = `1.`. Promotion/demotion via Tab.

---

## Inline data elements

**RID** — Reference citation. Points to an entry in the REFERENCES section (which itself points to UMRL).

**SUB** — Submittal callout. Registers a submittal (drawing, sample, certification) that appears in PART 1 SUBMITTALS.

**SRF** — Section cross-reference. Points to another UFGS section by number; must be validated.

**ENG / MET** — Dual-unit pair. ENG is the U.S.-customary value, MET is metric. The editor renders one based on the user's unit-display preference.

**TAI** — Tailoring marker. Wraps content that applies only to a specific branch (Army/Navy/AF), region, or delivery type. Carries a `data-opt` attribute identifying the variant.

---

## Compliance

**Compliance rule** — One row in `src/data/ufs-1-300-02-rules.json`. Categorized as `prohibitedTerms`, `prohibitedSymbols`, `vagueTerms`, `requiredCapitalizations`, `colloquial`, `redundant`, or `requiredPractice`. Rules are data, not code.

**Finding** — A single match of one rule against one block: rule id, severity, offset, message, optional `fix()`.

**Three-tier linting** — (1) Static UFS rules (synchronous, <5ms). (2) Harper.js grammar (async, Web Worker, WASM). (3) `compromise.js` NLP (synchronous, lazy-loaded). Each tier emits findings with distinct highlight colors.

**Violation budget** — `MAX_VIOLATIONS = 2000` cap on findings per scan. Returns `truncated: true` when capped.

**AI tier** — The Claude-API rewrite path used for fixes the static engine can't compute (`fix === null`). Chunked at 20 blocks per call.

**Compliance scope** — `whole-doc | part | section | block`. Limits which blocks are scanned.

**Rule ID mapping** — `corpus/results/rule-id-mapping.json`. Translates the corpus's semantic injection IDs (`COLLOQ-furnish`) to runtime sequential IDs (`TERM-034`).

**Compliance state** — The bundle owned by the compliance reducer (`src/lib/compliance.js`): `{ scope, status, result, decisions, activeGroup, ai }`. App holds it; the panel reads via selectors and dispatches verbs (`setScope / startCheck / setResult / acceptGroup / rejectGroup / acceptItem / rejectItem / markGroupsAccepted / setActiveGroup` plus the AI lifecycle: `aiStart / aiProgress / aiSuccess / aiError / aiAbort / aiClearError`). Five property-tested invariants — see CLAUDE.md "Compliance Checker Architecture."

**Linting state** — The bundle owned by the linting reducer (`src/lib/linting.js`): `{ enabled, suspended, byBlock: Map<blockId, { compliance, nlp, grammar, grammarText }> }`. App holds it; the per-block hook (`src/components/useBlockLinting.js`) dispatches into it; the App-level `CSS.highlights` effect reads `getRangesByTier(state)` to mutate the global highlight registry. Pure verbs (`setEnabled / setSuspended / setBlockFindings / clearBlock / clearAll`); pure selectors (`isActive / getBlockSeverity / getRangesByTier`, …). Range objects are opaque to the reducer — DOM-free, plain-Vitest testable. Suspension flips when `complianceOpen` toggles.

---

## Track changes

**Revision** — A pending mutation to a block. Block-level: `add`, `del`, or `chg` on `block.revision`. Inline: PM marks `revisionAdd` / `revisionDel` / `revisionChg`, serialized as `<ins|del|span class="mark-{add|del|chg}" data-author-id="…" style="--author-color:…">`.

**Per-keystroke marking** — In PM mode (the only mode post-1i-b.2), revision marks are applied inside `PmEditableBlock`'s `dispatchTransaction` via `rewriteForTrackChanges` (`src/lib/pm-tc-mark.js`). Every typed character lands already wrapped in the right mark; there is no blur-time diff. The legacy snapshot-then-diff pipeline (`TC snapshot`, `diffWords`, `refineWordDiff`) is retired.

**Track-changes state** — The bundle owned by the track-changes module (`src/lib/track-changes.js`): `{ enabled, publishSeq }`. A 70-LOC shell that holds the on/off bit and the publish sequence number. Verbs: `enable`, `disable`, `acceptAll`, `rejectAll`, `applyRemote`. Selectors: `isEnabled`, `getPublishableState`, `revisionFlagForCreate`, `revisionFlagForDelete`.

**publishSeq** — A monotonically-increasing integer on the TC state, bumped by every user-driven verb but not by `applyRemote`. The collab publish effect compares it against `lastPublishedTcSeqRef` to decide whether the local state has diverged from what peers have seen — replacing the imperative `tcDirtyRef` flag and making round-tripping a structural property rather than something the caller has to remember to set.

**Per-author attribution attrs** — The `data-author-id` and `style="--author-color:…"` carried on every inline revision mark span (the `#87` 1h schema split). Regexes parsing these spans must use `[^>]*` between the class attribute and the closing `>`; the pre-1h `<ins class="mark-add">` shape is the no-attribution case only.

**`TC_RESOLVE_META`** — A PM-meta sentinel (`src/lib/pm-tc-mark.js`) producers attach to accept/reject transactions for existing revision marks; `dispatchTransaction` reads it and skips `rewriteForTrackChanges`. Without it, accept-del under TC dispatches `tr.delete(...)` over a `revisionDel`-marked range and the rewriter silently re-applies the mark. Currently set by `pm-del-popup.js`'s `dispatchDelAction`.

**Accept / Reject** — User actions that resolve a revision. Accept All / Reject All operate on every revision in scope. Inline accept/reject operates on one mark. Document-wide gestures (`handleAcceptAll`, `handleRejectAll`) call `flushAllPendingUpdates()` first so the 400ms `onUpdate` debounce window does not hide just-typed revision marks from React state.

---

## Comments

**Comment** — Metadata in the comments store: id, blockId, status, highlightText, entries (thread). Owned by the `src/lib/comments.js` module; App.jsx holds the state opaquely as `commentsState` and reads it via selectors.

**Comments state** — `{ byId: Map<commentId, Comment>, seenRemoteIds: Set<commentId> }`. Mutated only via the verbs in `comments.js` (`createDraft`, `updateCreate`, `reply`, `resolve`, `reopen`, `remove`, `mergeRemote`).

**Comment span** — `<span class="mark-comment" data-comment-id="...">text</span>` in the DOM. Persisted in `block.html` for editable blocks; **derived at render time** from `commentsState` for ref/table blocks via `cm.computeCommentSegments`. Editable spans are the source of truth (the `reconcileBlocks` selector reclasses them and unwraps orphans against the metadata store); ref/table spans are always recomputed from metadata.

**Comment status** — `open` | `resolved`. Reflected on the comment metadata AND on the span's class (`mark-comment` vs `mark-comment-resolved`). The `reconcileBlocks` selector keeps them in sync — drift is no longer possible by construction for editable blocks.

**`seenRemoteIds`** — Tombstone discriminator used by `mergeRemote` (M2.5): any commentId we have ever observed in a remote payload. On the next merge, an id missing from remote *and* present in seenRemoteIds is dropped (peer deletion); an id missing from remote *and* never seen is preserved (local draft).

**`reconcileBlocks(blocks, state)`** — Pure selector that walks each editable block's `mark-comment` spans: unwraps spans with no metadata entry, reclasses spans whose className disagrees with `state.byId.get(id).status`. Idempotent — returns the original `blocks` reference when nothing changes.

**`computeCommentSegments(text, blockComments)`** — Pure helper used by RefBlock/TableBlock to slice plain text into `[{ text, comment }, ...]` segments. Greedy non-overlapping match per comment, scanning left to right. Drives the render-time highlight derivation that keeps ref/table comments in sync with metadata across remote sync, undo/redo, or any re-render.

**Draft sentinel** — A comment is in "draft" form when its single create entry has empty text (`isDraft(comment) === true`). Drafts exist only locally; publishing is deferred until the user commits text via `updateCreate`, so the Y.Doc never holds a pending empty-text entry.

**Ref/table render-time highlights** — Ref/table block text lives outside `b.html` (in `b.ref` / `b.table`), so `reconcileBlocks` is a no-op for them. Instead, `RefBlock` and `TableBlock` derive `mark-comment` / `mark-comment-resolved` wrappings at render time via `cm.getBlockComments(state, blockId)` + `cm.computeCommentSegments`. This is *not* a separate sync mechanism — the spans are recomputed from metadata on every render, so drift is impossible by construction.

**`COMMENT_RECONCILE_META`** — A PM-meta sentinel (`src/lib/pm-comments.js`) attached to reconcile transactions produced by `reconcileCommentMarks`. `dispatchTransaction` in `PmEditableBlock` reads it and skips both the synthesized `'input'` event (linter) and the `onUpdate` debounce (no `setBlockHtml` echo). The Yjs op produced by ySyncPlugin still uses origin `ySyncPluginKey`; the meta governs only PM-side filtering. Distinct from a Yjs origin — don't conflate.

**`reconcileCommentMarks(state, commentsState)`** — Pure verb (`src/lib/pm-comments.js`) that returns a PM transaction reconciling `comment` marks against `commentsState` (status flips, removals). Idempotent — returns null when the doc already matches. Dispatched from a per-block `useEffect([commentsState])` in `PmEditableBlock`.

**Active comment** — The single comment id whose popup is currently open. PM editable blocks: the `activeCommentPlugin` (`src/lib/pm-plugins/active-comment.js`) holds the id in plugin state and emits an inline `Decoration` applying `mark-comment-active` over the matching mark's range. Ref/table blocks: `RefBlock` / `TableBlock` render `data-active="true"` directly from the `activeCommentId` prop.

---

## Collaboration

**Room** — A collaborative editing session, identified by a room id. Backed by one Y.Doc on the server and persisted as three artifacts.

**Identity** — The user's display name + color, stored in localStorage. The collab session is gated on `inRoom && identity` — without an identity, the WebSocketProvider is never instantiated.

**Y.Doc / Y.XmlFragment / Y.Text** — Yjs CRDT primitives. SecWriter uses one Y.Doc per room with shared types `yOrder`, `yStore`, `yMeta`, `yTc`, `yComments`. Per-block html slots are Y.XmlFragment in schemaVersion=2 rooms (the default post-1d) and Y.Text in pre-1d / migrationPartial rooms.

**Substrate** — The Yjs shared type at `yStore.get(blockId).get('html')` — the CRDT-backed source of truth for a block's html. Y.XmlFragment (PM-bound via ySyncPlugin) for v2 rooms; Y.Text for legacy/migrationPartial rooms.

**`useCollabSession`** — The hook (`src/hooks/useCollabSession.js`) that owns the session lifecycle, the four publish effects (blocks, meta, TC, comments dispatch), the coordination refs (`sessionReadyRef`, `metaReadyRef`, `lastRemoteBlocksRef`, `lastPublishedTcSeqRef`, `publishDisabledRef`), the migrationPartial pin, and the cursor broadcast. App passes in remote-event callbacks; reads back `{ dispatchComment, markTcSeqApplied, tryUndo, tryRedo, canUndo, canRedo, clearStack }`.

**Publish path (html)** — Per PM keystroke, via ySyncPlugin: `PmEditableBlock`'s `EditorView` is bound to the block's Y.XmlFragment; each PM transaction translates to a Yjs op on the fragment (origin `ySyncPluginKey`). No debounce on the substrate. A 400ms-debounced `onUpdate` then serializes html back into App's `blocks` array so non-PM consumers (compliance, exports) see latest content. See ADR-0004, ADR-0006.

**Publish path (scalars/structure)** — `App.handleBlockUpdate` calls `setBlocks`; the publish effect in `useCollabSession` calls `applyBlocksToYDoc`, which reconciles structure (yOrder, yStore keys, scalar fields) and **skips html for existing slots** — only seeds html for brand-new blocks. PM EditorView ownership over html is exclusive once a slot exists.

**Origin model** — Every Yjs write carries an origin. `'local-publish'`: explicit `setBlockHtml` writes (TitleBlock, MarkSuggestions, debounced PM echo, accept-all, compliance fixes). `ySyncPluginKey`: per-keystroke PM ops. `'silent'`: peer-driven comment reconcile mirrors (not undo-tracked). `'migrate-v2'`: server-side broker writes during substrate migration (deliberately distinct so clients cannot Ctrl+Z a peer's pre-migration content). Both UndoManagers (`'local-publish'` + `ySyncPluginKey`) track local edits but skip `'silent'` and `'migrate-v2'`.

**schemaVersion** — Integer in `yMeta` marking the substrate version. v1 = html slot is Y.Text. v2 = html slot is Y.XmlFragment. Clients enforce `MAX_SUPPORTED_SCHEMA_VERSION` (currently 2); a remote `schemaVersion > MAX_SUPPORTED_SCHEMA_VERSION` surfaces an `'incompatible'` connection status and gates editing.

**Migration broker** — Server-side handler (`server/migrate-pm-substrate.cjs`) that converts v1 rooms to v2 on first WS upgrade. Archives the room (via `storage.archiveRoom`) before mutating, runs under a per-room async lock, and stamps either `schemaVersion=2` or `migrationPartial=true` (mutually exclusive). Per-block conversion failures don't roll back — affected slots stay Y.Text and the room flips to migrationPartial. See ADR-0006.

**migrationPartial** — A `yMeta` boolean flag set by the broker when any block failed to convert. The connection status `'migration-partial'` is editable (not read-only) and sticky (re-pinned by `useCollabSession` on every `'connected'` transition).

**Snapshot diff (collab, legacy)** — String-diff strategy inside `applyHtmlToYText`. Only applies to v1 / migrationPartial slots. v2 slots use `prosemirrorToYXmlFragment` via ySyncPlugin.

**Awareness** — Yjs cursor/presence broadcast. Carries identity, color, and selection range.

**Eviction guard** — The `server/collab-server.cjs` patch around `setupWSConnection` that re-installs the preloaded Y.Doc into y-websocket's `docs` Map after the preload `await`. Prevents y-websocket v1's `closeConn` from evicting our doc by name during a stale-close race. Re-installed a second time after the migration broker `await` for the same reason. See ADR-0002.

---

## PM substrate

**PM (ProseMirror)** — The editor framework SecWriter uses for every editable block. Post-1i-b.2, the only editor — the legacy contentEditable path (`EditableBlock`, `useBlockBinder`, `useUndoableBlocks`, `VITE_PM_EDITOR` flag) is retired.

**`PmEditableBlock`** — The block component (`src/components/PmEditableBlock.jsx`) that mounts a PM `EditorView` per block and binds it to the block's Y.XmlFragment substrate via ySyncPlugin. The single editor mode.

**`EditorView`** — PM's view object. Bound to a Y.XmlFragment via ySyncPlugin so per-keystroke transactions translate directly to Yjs ops.

**`ySyncPlugin`** — y-prosemirror's plugin that binds a PM doc to a Y.XmlFragment. Translates PM transactions → Yjs ops (origin `ySyncPluginKey`) and Yjs updates → PM transactions. Source-of-truth API: `node_modules/y-prosemirror/src/sync-plugin.js` (pinned at v1; do not bump without re-verifying every PM empirical claim in this repo's tests).

**PM schema** — Defined in `src/lib/pm-schema.js`. Nodes: `doc`, `paragraph`, `text`, plus block-specific. Marks include the standard inline marks (`bold`, `italic`, etc.), the SGML transparent-tag marks, the comment mark, and the revision marks (`revisionAdd`, `revisionDel`, `revisionChg`) carrying per-author attribution attrs. `pmdoc-html.js` serializes PM docs to/from html.

**PM plugin set** — `src/lib/pm-plugins/`: `slash-menu.js` (state: `{open, filter, fromPos}`; popup portal-mounted at `document.body`, anchored via `view.coordsAtPos(fromPos)`; combobox ARIA pattern — contentEditable gets `role=combobox`, menu gets `role=listbox`), `tag-labels.js` (widget decorations for inline mark labels — pseudo-elements don't create caret positions, widgets do), `keymap.js` (Enter / Tab / Backspace-on-empty / arrow-at-boundary callbacks), `relpos-selection.js` (Y.RelativePosition save/restore), `active-comment.js` (active-comment decoration). Plus the word-grain undo plugin and the linter-input synth.

**`block-registry`** — Module (`src/lib/block-registry.js`) holding an App-scoped Map of `blockId → imperative handle`. Each block component (`PmEditableBlock`, `TitleBlock`) registers a handle on mount; App uses `focusBlockById(id, { atEnd })` instead of `document.querySelector('[data-block-id="…"]')`. The registry also exposes flush helpers.

**`flushPendingUpdateById(blockId)`** — Fires the 400ms `onUpdate` debounce immediately for one block, so React state reflects the just-typed html synchronously. Paired with single-block toolbar verbs (format, mark, revision-apply, etc.).

**`flushAllPendingUpdates()`** — Same, for every registered PM block. Document-wide TC gestures (`handleAcceptAll`, `handleRejectAll`) call this before reading `blocksRef.current` so sub-debounce clicks don't run against pre-debounce html.

**`cancelPendingUpdateById(blockId)`** — Clears the debounce without firing the callback. Used by inline accept/reject in the FloatingToolbar where the action's own setBlocks has already settled the substrate snapshot.

**`dispatchToolbarVerb`** — Dispatcher in `src/lib/pm-toolbar.js` (2026-05-19) that owns the post-PM-dispatch protocol shared by every FloatingToolbar verb: relpos restore -> `compute(state)` -> `onForceFrame?.()` -> `view.dispatch(tr)` -> snapshot `view.state` -> flush-or-cancel per the verb's `settlement`. Caller passes `{view, saved, compute, onForceFrame}` and receives `{dispatched, blockId, state, range}`. Replaced 7 ad-hoc dispatch+flush sites with a single seam; PM imports (`pmFragmentToHtml`) no longer leak into FloatingToolbar — callers use the colocated `extractHtml(state)` / `extractRangeText(state, range)` helpers.

**`VerbResult` (PM toolbar)** — `{ tr: Transaction, settlement: 'self' | 'caller-owned', range: {from, to} }` returned by every pm-toolbar verb (`applyFormatTr`, `applyInlineMarkTr`, `applyRevisionTr`, `applyInlineRevisionResolveTr`, `applyChangeCaseTr`, `applyCommentMarkTr`). Verbs that own the React-state mirror via the dispatcher's flush use `settlement: 'self'`; the single accept/reject verb whose caller settles state itself uses `settlement: 'caller-owned'` so the dispatcher cancels (not flushes) the per-block debounce.

**Blocks reducer** — Pure-reducer module (`src/lib/blocks.js`, 2026-05-19) that consolidates every `blocks`-array mutation through a single verb + dispatcher protocol. Verbs (`updateBlockHtml`, `updateBlockHtmlPmSync`, `searchReplaceAt`, `applyInlineFix`, `complianceAcceptGroup`, `removeOrphanedRid`, `addReference`, `createBlockAfter`, `deleteBlock`, `changeOliLevel`, `convertToTitle`, `convertBlock`, `promoteTitle`, `demoteTitle`, `reorderSectionVerb`, `acceptBlockRevision`, `rejectBlockRevision`, `acceptAllRevisionsVerb`, `rejectAllRevisionsVerb`, `mergeBlockData`, `updateRefScalar`) are pure transformations over `Block[]`. State has no wrapper — the array IS the state.

**`VerbResult` (blocks)** — `{ state: Block[], effects: { framing, substrateWrites, flush, focus } }`. Returned by every blocks verb. `framing` is a tagged union: `{ kind: 'newFrame' }` (dispatcher calls `forceFrame()` then writes substrate afterwards), `{ kind: 'wrappedFrame', writes: SubstrateWrite[] }` (dispatcher calls `withUndoFrame(() => writes.forEach(...))` so N writes form ONE Yjs frame), or `null`. `substrateWrites` is empty for the wrappedFrame case (writes live inside `framing.writes`). Structural changes (create/delete/reorder) are NOT in the descriptor — they ride the implicit `setBlocks → applyBlocksToYDoc` path that diffs and emits yOrder/yStore ops.

**`dispatchBlocksVerb`** — Dispatcher in `src/lib/blocks.js` that owns the post-compute protocol: optional preFlush → `compute(blocksRef.current)` → `forceFrame` (if newFrame) → substrate writes (or `withUndoFrame` wrap for wrappedFrame) → `setBlocks(state)` → sync `blocksRef.current = state` (so sequential dispatches like Replace All / Remove All Orphaned see the latest state mid-loop) → flush → focus. Reads `yStore` and `framing` at call time so collab session swaps don't strand stale references. App.jsx exposes a thin `dispatchBlocks(compute, opts)` closure that wires the deps.

**`__simEditorTestUtils`** — DEV-only test seam (`window.__simEditorTestUtils`, wired in `src/App.jsx`) routing through `handleBlockUpdateWithSync`. Playwright E2E injects block html via `injectBlockHtml(page, blockId, html)` / reads via `readBlockHtml(page, blockId)` (`tests/e2e/pm-helpers.js`). Necessary because PM's render cycle overwrites direct DOM mutation.

**Skeleton-then-populate** — Yjs invariant: every nested shared type must be attached to its parent (`yMap.set('html', yChild)`, `yStore.set(id, yMap)`) BEFORE any operation reads its children. Violations surface as `"Invalid access: Add Yjs type to a document before reading data"`. Enforced in `src/lib/collab.js` (`blockToYMapSkeleton` + `populateBlockHtml` + `populateBlockTableRef`), `block-html-store.js` (`seedHtmlSlot`), and `ytable-crdt.js` (every nested level).

**UndoManager pair** — Two Y.UndoManagers track local edits. In-room: created inside `createCollabSession` (`src/lib/collab.js`). Out-of-room: `useLocalSubstrateUndoManager` (`src/hooks/useLocalSubstrateUndoManager.js`). Both have `trackedOrigins = { 'local-publish', ySyncPluginKey }` and both honor `tr.meta.get('addToHistory') === false`. App's Ctrl+Z routes through `collab.tryUndo` (in-room) then `localUndo.tryUndo` (out-of-room).

**Word-grain framing** — PM's word-grain undo plugin calls `forceFrame()` on the active UndoManager at word boundaries (and before click-driven `setBlocks` calls) so Ctrl+Z reverts a word at a time rather than per keystroke. Matches Word/Notion. Mass gestures (`handleAcceptAll`, `handleRejectAll`, `handleComplianceAcceptGroup`) wrap their N writes in `framing.withUndoFrame(...)` so the loop forms one frame.

---

## Local file

**Current-file record** — The client-side identity of the file the user is editing on disk. Shape: `{ sec: { handle: FileSystemFileHandle | null, fallbackName: string }, sidecar: { handle: FileSystemFileHandle | null } }`. Cross-file load swaps the whole record atomically so a stale `sec.handle` cannot survive into a save against the next file (the silent-data-loss path: Ctrl+S writing to the previously-loaded file). Per-field update is reserved for handle acquisition within the SAME file (first Ctrl+S resolves an FSA prompt and fills `sec.handle`); cross-file transitions always swap the whole record.

**`sec.fallbackName`** — Display name used when `sec.handle` is null (drag-drop import, file-input picker, autosave-restore, brand-new doc). Once `sec.handle` exists, `handle.name` is authoritative — `fallbackName` becomes inert. The render-time selector `getDisplayName(currentFile)` returns `sec.handle?.name ?? sec.fallbackName ?? 'output.SEC'`, pinning the priority rule in one place.

**Sidecar pairing** — The .comments.json sidecar's name is always derived from `getDisplayName(currentFile)` (`<secName>.replace(/\.sec$/i, '.comments.json')`), never stored. `sidecar.handle` is the only sidecar-specific mutable field; if it's non-null it was acquired against the current sec name and survives until cross-file load wipes both handles in the record swap.

---

## Storage

**Backend** — One of `local`, `azure`, `s3`. Selected via `SIM_STORAGE_BACKEND`. Each backend extends `RoomStorageBase` (`server/room-storage.cjs`) and implements seven adapter primitives (`_putBytes / _getBytes / _deleteKey / _listKeys / _statKey / _copyKey / _keyForArtifact`) plus three name-parsing hooks. The base class owns the public methodset (`writeRoom / readRoom / deleteRoom / listRooms / statRoom / quarantineRoom / archiveRoom / restoreRoom / listArchivedRooms / deleteArchivedRoom`).

**Room artifacts** — The three files persisted per room: `.ydoc` (CRDT state — source of truth), `.SEC` (serialized section), `.comments.json` (sidecar metadata). The `ARTIFACT_CATALOG` in `server/storage-shared.cjs` defines the write order; `.ydoc` is always written LAST so a partial failure leaves `.ydoc` consistent with older sidecars rather than ahead of stale ones.

**Atomicity is per-backend.** Local writes via stage-rename-rollback (filesystem rename is atomic per file). Azure acquires a `.ydoc` blob lease for multi-instance safety. S3 (Cloudflare R2 in production) has no transaction primitives — `.ydoc`-LAST sequential write is the strongest available guarantee. See ADR-0005.

---

## Reference data and corpora

**Calibration corpus** — 2,583 raw UFGS blocks from 5 sections. Validates that primary rules produce zero false positives on unmodified master text.

**Clean corpus** — Same blocks, rewritten to full UFS 1-300-02 compliance by Claude Opus. Every finding here is a false positive. Measures precision.

**Dirty corpus** — 644 blocks with 1,438 labeled injected violations. Measures recall.

**Adversarial corpus** — 156 hand-crafted edge cases: false-positive traps, NLP ambiguity, domain jargon. Measures robustness.

---

## Anti-glossary (don't say)

- "Component" — too vague. Say "block," "block component" if it's a React render-layer thing, or "module" for an architectural unit.
- "Boundary" — overloaded. Use "seam" (architecture) or name the actual transition (publish path, parser, serializer).
- "Service" — not a SecWriter concept. Say "module" or name the verb.
- "Element" — ambiguous between SGML element and DOM element. Say "tag" or "DOM node."
- "Annotation" — too vague. Say "mark," "comment span," "revision mark," or "tag label" depending on which is meant.
- "EditableBlock" — retired in 1i-b.2. Say "`PmEditableBlock`" for the current block component, or "legacy contentEditable path" for the pre-1i-b.2 system if referring to history.
- "Binder" / "snapshot stack" / "useUndoableBlocks" / "VITE_PM_EDITOR" — all retired in 1i-b.2. The current substrate-bound model uses ySyncPlugin and the dual UndoManager pair.
- "TC snapshot" — retired in 1h Q35/Q37. Revision marks are applied per-keystroke; there is no plain-text baseline. Say "per-keystroke marking" or "TC mode is on."
