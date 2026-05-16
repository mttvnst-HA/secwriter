# Sub-PR 1i — Legacy editor retirement

**Status:** Design
**Date:** 2026-05-16
**Tracking:** Issue [#47](https://github.com/mttvnst-HA/secwriter/issues/47), [ADR-0006](../../adr/0006-pm-substrate-migration.md)

## Background

The y-prosemirror migration (issue #47) has shipped 1a–1h across nine PRs over six weeks. The `VITE_PM_EDITOR` flag has been default-off through every release, with the legacy contentEditable path (`src/components/EditableBlock.jsx`, `src/lib/useUndoableBlocks.js`, and a parallel handler triad in App.jsx) carried as a safety net while PM matured.

Sub-PR 1i is the cleanup: it retires the safety net, collapses SecWriter to a single PM-based editor, and removes the coordination warts the dual-path arrangement imposed.

CLAUDE.md commits to 1i doing six specific things:
1. Remove the `VITE_PM_EDITOR` flag and legacy code path
2. Retire `useUndoableBlocks` (snapshot-based undo)
3. Drop every `resumeHistory()` call site (paired with #2)
4. Add a lint rule banning new `querySelector('[data-block-id=…]')` outside `block-registry.js`
5. Bump `yMeta.schemaVersion` to 3
6. Collapse the "three paste paths in lockstep" wart

This spec covers #1–#4 and #6 in 1i. **#5 (schemaVersion bump) is dropped from 1i scope** — see "Decisions" below.

## Goal

Single PM-based editor implementation. Net delta dominated by deletion — roughly **+300 / −1900 LOC**, primarily from `EditableBlock.jsx` (804 LOC), `useUndoableBlocks.js` (197 LOC), the App handler triad collapse, legacy DOM-walk helpers, the `chromium-legacy` Playwright project, and CLAUDE.md sections describing retired paths.

## Decisions

### D1 — Three PRs, not one

| PR | Purpose | Code risk |
|---|---|---|
| **1i-a** | CI prerequisite: switch CI from `--project=chromium-legacy` to `--project=chromium`; fix PM-only failures the comment at `.github/workflows/ci.yml:129-134` calls out (~40 known) | None — no production code changes; only Playwright fixtures, test discipline, and CI yml |
| **1i-b** | Atomic removal of every legacy artifact (code + CLAUDE.md in same PR) | High — touches App.jsx, deletes major components, rewires undo |
| **1i-c** | DEFERRED — schemaVersion bump, force-remigration of `migrationPartial` rooms, Y.Text fallback removal, ESLint toolchain bootstrap | Future PR |

**Why 1i-a first:** the CI safety net today IS the legacy project. Deleting it without first proving chromium-PM is green leaves zero PM coverage. The comment at `.github/workflows/ci.yml:129-134` is explicit: "currently has ~40 known failures (DOM-depth selectors, slash menu wiring, del popup, paste-strip, comment reconcile) tracked for follow-on sub-PRs." Some of those may already be closed by 1f–1h; the rest must close in 1i-a.

**Why 1i-b atomic, not split into smaller PRs:** once the flag is removed, the legacy path is dead code immediately. Staging deletion across PRs adds review overhead without buying isolation — and a "removal + docs separate" split creates a transient window where CLAUDE.md describes a code path that doesn't exist, which is exactly the kind of in-head invariant the architecture-review backlog calls out.

### D2 — Close the structural-undo origin gap as part of 1i-b

`applyBlocksToYDoc` writes use origin `'local-apply'` (`src/lib/collab.js:682`). Both UndoManagers (`useLocalSubstrateUndoManager` and `createCollabSession`'s in-room manager) track `{'local-publish', ySyncPluginKey}` only. Today the `useUndoableBlocks` snapshot stack covers structural ops (Enter, Delete, slash-convert, reorder) — when 1i deletes the hook, that coverage vanishes.

**Fix:** change `applyBlocksToYDoc` to write under `'local-publish'` origin. One role per origin — `'local-apply'` was the snapshot-publish path; `'local-publish'` is the undoable-mutation path. Both UndoManagers' trackedOrigins remain `{'local-publish', ySyncPluginKey}` (no drift), and structural ops naturally enter the Yjs undo stack with no further wiring.

Risk: are any other consumers of `'local-apply'` (server-side, post-tx handlers) relying on the origin name? Verify in implementation — the only known reader is `handleAfterTx` in collab.js which filters anything starting with `'local-'`, so the rename is transparent to remote-blocks delivery.

### D3 — Skip the schemaVersion bump entirely

CLAUDE.md commits to bumping to v3 "when legacy goes away." Two reasons to drop:

1. **No breaking-change semantic.** Once legacy is gone, both v2 and "post-legacy v2" rooms are 100% Y.XmlFragment. v3 would be cosmetic — a stamp with no behavioral gate.
2. **Adoption-window risk.** `useCollabSession.js`'s version gate refuses rooms with `version > MAX_SUPPORTED`. Bumping 1i clients' MAX_SUPPORTED to 3 and stamping new rooms at v3 means deployed v2 clients refuse v3 rooms on contact — the 1b.1 transitional-release precedent (a v1.5 client that supported {1, 2} shipped before 1d's v2 bump) would have to be replicated, and the operational cost isn't worth a cosmetic stamp.

When a future PR actually needs to drop the Y.Text fallback (forcing migrationPartial rooms to re-migrate or quarantine), THAT PR can bump to v3 with the adoption-window mechanics. Documented as 1i-c.

### D4 — Replace the lint rule with a Vitest greptest

The project has no ESLint config, no `eslint*` dependency in `package.json`, no `lint` script, and no CI lint step. Adding a `no-restricted-syntax` rule is a full toolchain bootstrap (install eslint + react plugin, write flat config, add npm script, wire into ci.yml).

Vitest already runs in CI (`Unit & Compliance Tests` job). A unit test that greps `src/**/*.{js,jsx}` excluding `__tests__/**` and `block-registry.js` for the pattern delivers the same enforcement with zero new toolchain. Test goes at `src/lib/__tests__/block-registry-discipline.test.js`.

Currently exactly one live src violation: `App.jsx:627` inside `focusBlock`'s `fallbackToDom`. The greptest's pre-1i baseline is "1 violation expected; refactor or whitelist with rationale before the test goes green." Existing `EditableBlock.test.jsx` uses the pattern but is deleted in 1i-b. SearchBar.jsx:207 reference is in a comment, not live code.

### D5 — `migrationPartial` rooms remain readable; editability TBD by mount test

Per ADR-0006, `migrationPartial` rooms have a mix of Y.XmlFragment and Y.Text html slots. `block-html-store.js`'s `deriveHtml` and `setBlockHtml` both branch on shape — the Y.Text fallback paths stay in 1i (out of scope; deferred to 1i-c).

Open question that must be answered empirically during 1i-b implementation: **does `PmEditableBlock` mount on a Y.Text slot at all?** y-prosemirror's `ySyncPlugin` expects a Y.XmlFragment to bind to. Three possible outcomes:

- **Best:** PM detects the wrong shape and falls back gracefully → no behavior change for migrationPartial rooms.
- **Acceptable:** PM throws on mount → block must be skipped or rendered read-only with a banner. ADR-0006's operator-recovery promise is preserved through "read-only display + force operator to remigrate."
- **Worst:** PM silently corrupts the Y.Text slot → must be detected pre-mount and skipped.

The 1i-b implementation MUST include a manual or automated test of this scenario and either confirm (best) or add the appropriate skip/banner (acceptable/worst). A failing automated test in `migrationPartial` scenarios is the gating condition.

### D6 — `TitleBlock` paste handler stays

TitleBlock is contentEditable (not PM-managed); its paste handler legitimately calls `sanitizePasteText`. Three-path lockstep collapses to two-path (TitleBlock + PmEditableBlock), but both still want the same sanitizer. CLAUDE.md's "three paths must stay in lockstep" wart simplifies to "two paths must stay in lockstep" — both still import from `src/lib/paste-sanitize.js`.

### D7 — `tcState` / `setTcState` migrate to App-level `useState`

These come from `useUndoableBlocks` today. When the hook dies, App needs them directly. Post-1h Q35+Q37, the TC reducer state is just `{ enabled, publishSeq }` — atomic capture of `(blocks, tcState)` snapshots is no longer load-bearing (the publishSeq counter handles echo gating; there's no per-block snapshot to keep in sync). Plain `const [tcState, setTcState] = useState(() => tc.createInitial())` is sufficient. A Ctrl+Z that crosses a TC enable/disable boundary will no longer undo TC enable in lockstep with the block state — verify whether any test pins this; if so, gate by a separate decision (likely accept the regression — TC toggle is an explicit user gesture, not a typing-grain mutation).

## Scope

### In (PR 1i-a)

1. **Triage and close PM-only test failures** at chromium project HEAD. The CI comment at `.github/workflows/ci.yml:129-134` claims ~40 known failures across DOM-depth selectors, slash menu wiring, del popup, paste-strip, comment reconcile. Audit current state — some may already be closed by 1f–1h. Open issues for any persisting failures the 1i-a author considers out of scope; close them before 1i-b lands.
2. **Update `.github/workflows/ci.yml:136`** from `--project=chromium-legacy` to `--project=chromium`. Update the comment block at lines 129-134 to reflect the new state.
3. **Update CLAUDE.md testing rule #10** to reflect single-project CI gate.

### In (PR 1i-b)

The atomic removal. Implementation order matters because each step assumes the previous succeeded:

1. **Pre-work: structural-undo origin fix.** Change `applyBlocksToYDoc` (`src/lib/collab.js:682`) to write under `'local-publish'` origin. Verify no other reader expects the `'local-apply'` literal. Add a regression test in `src/lib/__tests__/word-boundary-undo.test.js` or sibling: out-of-room slash-convert → Ctrl+Z reverts the conversion in one frame.
2. **Move TC state to App.** `const [tcState, setTcState] = useState(() => tc.createInitial())` at the top of `SpecEditor`. Remove from `useUndoableBlocks` destructure.
3. **Replace branches with PM path inline.** Every `isPmEditorEnabled() ? <PmEditableBlock …> : <EditableBlock …>` site (App.jsx block-render loop) becomes the PM-path JSX inline.
4. **Delete the flag.** Remove `src/lib/feature-flags.js`, `src/lib/__tests__/feature-flags.test.js`, the `forcePmEditor` fixture in `tests/e2e/fixtures.js` (and update every test that consumed it), the `chromium-legacy` project in `playwright.config.js`.
5. **Delete `EditableBlock.jsx` and its test.** `src/components/EditableBlock.jsx`, `src/components/__tests__/EditableBlock.test.jsx`. Verify no remaining imports.
6. **Audit `FloatingToolbar` and `MarkSuggestions` consumers.** `MarkSuggestions.onApply → handleBlockUpdateWithSync` generates fix HTML outside a PM dispatch — that path still needs `setBlockHtml`. `FloatingToolbar.onBlockUpdate` (App.jsx:2480) similarly. Confirm each callsite's actual substrate requirement before collapsing.
7. **Collapse App's handler triad.** `handleBlockUpdate` (debounced typing path), `handleLegacyRevisionAction` (legacy click path), `handleBlockUpdatePmSync` (PM click path) collapse to two handlers: a typing handler and a click handler. The legacy variant goes away; the remaining two preserve setBlockHtml for non-PM-dispatch paths identified in step 6.
8. **Drop every `resumeHistory()` call site.** Keep paired `forceFrame()` calls — those operate on the Yjs UndoManager and remain needed.
9. **Collapse `setBlocksDirect` → `setBlocks`.** For the comment-reconcile effect (App.jsx ~796), the substrate mirror via `setBlockHtml` must NOT enter the Yjs UndoManager. Today the substrate write goes through `setBlockHtml` (`block-html-store.js:164`) which transacts under `'local-publish'` — a tracked origin. Three possible mechanisms, decided in the implementation plan:
   - **(a)** Add a `setBlockHtml` variant or option that uses a non-tracked origin (e.g., `'reconcile-mirror'`).
   - **(b)** Set the meta inside the transact: `ydoc.transact((tr) => { tr.meta.set('addToHistory', false); /* mutate */ }, 'local-publish')` — the UndoManager's `captureTransaction` filter honors this (`useLocalSubstrateUndoManager.js:77` and the matching in-room manager in `collab.js`).
   - **(c)** Refactor reconcile to dispatch a PM `tr` per block with `COMMENT_RECONCILE_META`, which the PM-side `dispatchTransaction` already routes correctly (mirrors `src/lib/pm-comments.js` flow).
   The invariant the implementation must satisfy: Ctrl+Z after a reconcile fires reverts the underlying user action in one stroke, not the reconcile.
10. **Delete `src/lib/useUndoableBlocks.js`.** Remove the import in App.jsx; remove the destructure; collapse 3-tier undo fallback (`collab.tryUndo → localUndo.tryUndo → useUndoableBlocks.undo`) to 2-tier.
11. **Drop legacy DOM-walk helpers** from App.jsx: `getPlainTextOffset`, `resolveOffsetInRoot`, `restorePlainTextOffset`. These supported the pre-1e contentEditable cursor restore across remote updates; PM owns its own selection management now.
12. **Drop `shouldSkip` predicate in comment-reconcile** (App.jsx ~810) per the 1g design spec's 1i deferral. The effect now uniformly applies `cm.reconcileBlocks` to all blocks because all editable blocks are PM-mounted with substrate-side reconcile via `reconcileCommentMarks`.
13. **Collapse `CommentPopup` mode-conditional fallback.** Per CLAUDE.md "Comments Architecture" §6, the popup's `setAttribute` fallback was gated on `getBlockView(blockId) == null`. With every editable block PM-mounted, the legacy DOM `setAttribute` path is dead.
14. **Decide on `commitBeforeAction` stub** in `src/lib/pm-plugins/keymap.js:23-52`. The comment claims "1g/1i may make it not a no-op." Either implement now with a clear use case, or drop the 1i hint and document why it stays a no-op.
15. **Add the Vitest greptest** at `src/lib/__tests__/block-registry-discipline.test.js`. Fails if `querySelector\(['"]\[data-block-id` appears in `src/**/*.{js,jsx}` outside `src/lib/block-registry.js` and `__tests__/**`. Before the test goes green, refactor or explicitly whitelist `App.jsx:627`'s `fallbackToDom` (it's the documented two-stage fallback with QC commentary; an inline `/* allowed: block-registry fallback */` marker that the greptest recognizes is the cleanest path).
16. **CLAUDE.md cleanup.** Drop entire "contentEditable Focus Management" section (now PM-only). Drop "`VITE_PM_EDITOR` flag" subsection. Retire three-path-paste-lockstep wart (collapse to two-path). Retire dual-stack-no-coalescing transient wart. Retire `useUndoableBlocks` legacy fallback wart. Retire "Trust isolated runs over the full-suite diff" note about dual-project flakes. Update "Track Changes Architecture" §2 to remove the `handleLegacyRevisionAction` reference. Mark issue #47 sub-PRs complete with cross-link.

### Out (deferred to 1i-c or later)

- **schemaVersion bump to 3** (per D3).
- **Force-remigration of `migrationPartial` rooms** — needs server-side hook to retry conversion of Y.Text slots on first 1i-c-client connect. Out of scope.
- **Y.Text fallback removal in `block-html-store.js` and `collab.js`'s `yMapToBlock`** — needs migrationPartial rooms drained first. Out of scope.
- **Drop `src/lib/ytext-html.js`** — NOT possible until ref/table CRDTs (`yref-crdt.js`, `ytable-crdt.js`) migrate off Y.Text. Separate work, no migration path defined yet.
- **`TitleBlock` paste handler** stays (D6).
- **ESLint toolchain bootstrap** deferred. Greptest is sufficient (D4).
- **Out-of-room cursor broadcast in PM mode** — the critique flagged `useCollabSession.js:572`'s `plainTextOffset` cursor pathway as potentially broken in PM mode (walks PM widget decorations producing wrong offsets). Out of scope for 1i; capture as follow-on issue.

## Risks

1. **Structural undo regression slips through** — mitigated by D2's origin fix and the regression test in step 1 of 1i-b. If the test passes pre-fix (i.e., snapshot stack already redundant), reconsider whether the fix is needed at all. If it fails pre-fix, the fix is load-bearing.

2. **migrationPartial editability regression** — mitigated by D5's empirical mount test. If PM cannot mount on Y.Text slots, 1i-b adds a per-block shape check + read-only banner before declaring done.

3. **TC undo lockstep regression** — D7 accepts this. Verify by reading the existing TC undo tests; if any pin the (blocks, tcState) atomic capture, decide whether to migrate the test or restructure.

4. **Comment-reconcile substrate writes pollute Yjs undo** — mitigated by step 9 of 1i-b (gate with `addToHistory: false`). If the gate is missed, reconcile fires after every Ctrl+Z and pushes its own frame; one-stroke-undo becomes two-stroke-undo. Pin with a unit test.

5. **MarkSuggestions / FloatingToolbar setBlockHtml dependency missed** — mitigated by step 6 of 1i-b's explicit audit. If missed, those flows silently lose substrate sync and the next collab broadcast clobbers the local change.

6. **CI runs zero PM coverage during 1i-a transition** — between landing 1i-a's CI switch and 1i-a's PM-failure fixes, CI is red. Sequence within 1i-a: fix PM failures first, then switch CI in the same PR. Don't merge a half-finished 1i-a.

7. **`'local-apply'` rename has unexpected downstream consumers** — mitigated by D2's verification step. Most likely safe (`handleAfterTx` only filters `'local-*'` prefix), but verify.

## Test plan

### Pre-merge
- `npm test` (Vitest)
- `npm run test:compliance` (Node runner)
- `npm run test:server` (Node runner)
- `npm run test:corpus`
- `npm run test:e2e` — `--project=chromium` only after 1i-a; both during the transition
- New unit test for structural undo (step 1 of 1i-b)
- New greptest for block-registry discipline (step 15 of 1i-b)

### Manual smoke tests
- Word-grain Ctrl+Z and Ctrl+Y in and out of room (typing, structural ops, accept-all, comment-create)
- New-block focus via Enter and slash-convert
- Plain text paste; rich text paste from Word — both sanitize to plain
- TC toggle, accept/reject inline, accept-all
- Comment create / reply / resolve / reopen
- Open a `migrationPartial` room (fabricate if none exists in test storage) — verify Y.Text slots render and what happens when the user attempts to edit one

### Post-merge
- Render production deploys and verify no v=3 schema-incompatibility banners on existing rooms (sanity that D3's "skip the bump" was respected in implementation)

## Open verification items (for the 1i-b implementation phase)

These need empirical answers before the PR can merge. Document the answers in the implementation plan, not this spec:

1. Does PM mount on a Y.Text html slot? (D5)
2. Are there any `'local-apply'` literal-string consumers beyond `handleAfterTx`? (D2 verification)
3. Are all ~40 chromium-PM CI failures currently present at HEAD, or have some closed in 1f–1h?
4. Does `MarkSuggestions.onApply` or any other non-PM-dispatch path still require `setBlockHtml`? (step 6 of 1i-b)
5. Does any existing test pin the `(blocks, tcState)` atomic capture in `useUndoableBlocks`? (D7)

## Out of scope (won't do in 1i)

- Generalized rewrite of any in-scope file
- Performance optimization
- Schema changes beyond removing the legacy code path
- Test infrastructure rewrites
