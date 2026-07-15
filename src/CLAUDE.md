# SecWriter — src/

Editor-internals architecture notes (ProseMirror/Yjs substrate, blocks, dark mode, track changes, comments, compliance/linting engines). Loads only when working under `src/`. See the root [CLAUDE.md](../CLAUDE.md) for project-wide context. For the Yjs/PM collab-publish substrate specifically, see [.claude/rules/collab-substrate.md](../.claude/rules/collab-substrate.md).

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

**Opting a PM tr out of UndoManager capture:** Set `tr.setMeta('addToHistory', false)` on the PM tr. y-prosemirror's sync-plugin propagates this to the resulting Yjs transaction meta (sync-plugin.js:228 — `tr.meta.set('addToHistory', pluginState.addToHistory)`). Both Y.UndoManagers (`src/lib/collab.js` in-room, `src/hooks/useLocalSubstrateUndoManager.js` out-of-room) are built by the shared `createSubstrateUndoManager` factory in `src/lib/substrate-protocol.js`, which sets `captureTransaction: isUndoableTransaction` (`tr => tr.meta.get('addToHistory') !== false`) to honor it. Mirrors y-prosemirror's own UndoPlugin filter (undo-plugin.js:71). Used by the comment-reconcile path (`src/lib/pm-comments.js`) to keep peer-driven transparent reconciles off the local undo stack.

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
- **`useBlockActions` is the App-side block-action surface** (`src/hooks/useBlockActions.js`). It absorbs every pure `dispatchBlocks(b => Blocks.verb(...))` wrapper into one memoized object of 22 named actions (`reorderSection`, `updateHtml`, `insertAfter`, `deleteBlock`, `acceptAllRevisions`, …). It reads `yStore` and undo-`framing` from refs (`activeYStoreRef`, `framingRef`) at action-call time, so a mid-session room/collab-mode swap can't strand a stale reference and App can declare it early without a TDZ on `framingForHandler`. The old `handleBlockUpdate` + `handleBlockUpdateWithSync` pair is merged into `updateHtml`. Cross-reducer handlers (`handleDelete`, `handleConvertBlock`, `handleConvertBlockType`, `handleAcceptAll`, `handleRejectAll`) stay in App and compose `blockActions.*` for the blocks piece plus their own linting/tc/comments setState. App no longer owns a `dispatchBlocks` closure. The wiring (correct verb + yStore + framing) is pinned by `src/hooks/__tests__/useBlockActions.test.jsx`.

## Slash Menu → Block Conversion

`handleConvertBlock` creates a block with a **new ID**. This forces a React remount, which triggers the ref callback, which handles focus. Do not try to reuse the old block ID — the ref callback won't re-fire on an existing DOM node.

## Dark Mode

See [PR #280](https://github.com/mttvnst-HA/secwriter/pull/280). Theming is CSS custom properties: light defaults in `:root`, dark overrides in `.dark-mode` (`src/styles/editor.css` ~442/~510). Components consume `--sim-*` tokens; `.dark-mode` lives on BOTH `document.documentElement` (set pre-paint by `public/theme-init.js`, re-toggled by App's persist effect — the `sim-dark-mode` `setItem` + `classList.toggle('dark-mode', darkMode)` `useEffect`) AND the React root div (`<div className={darkMode ? 'dark-mode' : ''}>` in App's render). Load-bearing invariants:

- **`public/theme-init.js` is a pre-paint FOUC guard, and its localStorage key is duplicated — not imported.** It's a blocking classic `<script src="/theme-init.js">` in `index.html` `<head>` (CSP-safe: `script-src 'self'` allows same-origin external scripts; an inline script would be BLOCKED). It reads `localStorage.getItem('sim-dark-mode') === 'true'` and adds `.dark-mode` to `<html>` BEFORE first paint. Without it the class is applied post-paint (App useEffect), which (a) flashes light content and (b) triggers a `transition: background` on token-driven surfaces (note blocks `PmEditableBlock.jsx` ~1058/1063, tailoring bar) that never advances past its light start-frame → notes render light-on-light (1.19 contrast). The `'sim-dark-mode'` KEY and `'true'` value are hardcoded in BOTH `theme-init.js` and `App.jsx` (the `getItem` read in the `darkMode` `useState` initializer + the `setItem` write in the persist `useEffect`) with no shared import — rename one and the FOUC silently returns. Pinned by `src/__tests__/theme-init.test.js` (key + class + pre-module ordering). Must run before the `<script type="module">`.
- **`var(--sim-X, <fallback>)` fallbacks are effectively dead** — every `--sim-*` is defined in `:root`, so the fallback only applies if the stylesheet fails to load. When converting a hardcoded color to a token, expect the LIGHT render to shift to the token's `:root` value (e.g. EDITING badge text `#059669`→`--sim-success-text` `#008000`), NOT stay at the old inline value. That's the intended "adopt canonical token" direction; don't assume `var(--x, oldvalue)` preserves the old light color.
- **`::highlight()` tiers need explicit dark rules.** The base `::highlight(compliance-error|grammar-error|passive-voice)` low-alpha fills (`editor.css` ~477) wash out on the dark canvas; `.dark-mode ::highlight(...)` overrides (added #280) raise alpha + lighten the wavy underline. lightningcss preserves them in the bundle. Same for the 3 banners (`.locked-banner`/`.viewer-banner`/`.migration-partial-banner`) which had no dark rule pre-#280 — `.dark-mode .X` (specificity 0,2,0) beats `.X` (0,1,0), no `!important` needed.
- **Absent by design:** no `prefers-color-scheme`/OS-auto mode (manual localStorage toggle only); `index.html` `<meta name="theme-color">` is static light.

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

## Reference Data Sources

- **UMRL** (`src/data/umrl.json`) — Unified Master Reference List. 302 organizations, 4,973 entries. Source: `C:\Program Files (x86)\SpecsIntact 5\UMRL\umrl.ref`. Used by the Reference Wizard.
- **UMSL** (`src/data/umsl.json`) — Unified Master Submittal List. 13,203 submittal entries. Source: same directory, `umsl.lst`. For future submittal wizard.

USACE updates these regularly. To refresh, re-run the parser scripts that generated the JSON.

## Known Parser Edge Cases

Parser validated against all 689 UFGS files (60 tags). Two known roundtrip edge cases: `32 12 36.26.SEC` and `32 13 13.43.SEC` have `<THD><HL3>text</HL3></THD>` where nested bold boundaries shift (content preserved).
