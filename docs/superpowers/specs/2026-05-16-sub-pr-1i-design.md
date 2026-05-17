# Sub-PR 1i — Legacy editor retirement

**Status:** Design (rev 2 — independent-critique revisions)
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

This spec covers #1–#4 and #6 in 1i. **#5 (schemaVersion bump) is dropped from 1i scope** — see D3.

## Goal

Single PM-based editor implementation. Net delta dominated by deletion — roughly **+400 / −2000 LOC**, primarily from `EditableBlock.jsx` (804 LOC), `useUndoableBlocks.js` (197 LOC), the App handler triad collapse, legacy DOM-walk helpers, the `chromium-legacy` Playwright project, every `test.skip(!forcePmEditor, …)` / `test.skip(forcePmEditor, …)` gate, the `getEditorMode` helper, and CLAUDE.md sections describing retired paths.

## Decisions

### D1 — Four PRs, atomic deletion split from runtime rewire

| PR | Purpose | Code risk |
|---|---|---|
| **1i-a** | CI prerequisite: switch CI from `--project=chromium-legacy` to `--project=chromium`; fix PM-only failures the comment at `.github/workflows/ci.yml:129-134` calls out (~40 known) | None — no production code changes; only Playwright fixtures, test discipline, and CI yml |
| **1i-b.1** | Runtime rewire only. Items that change the behavior of code that survives 1i: structural-undo origin flip (D2), TC state migration (D7), comment-reconcile undo gate (step 9), migrationPartial mount handling (D5), block-registry greptest. No deletion of legacy code. | High — touches collab.js + App.jsx + PmEditableBlock; small surface but easy to land subtle Yjs undo regressions |
| **1i-b.2** | Deletion sweep. Removes flag, `EditableBlock.jsx`, `useUndoableBlocks.js`, every `forcePmEditor` consumer, every `getEditorMode`-gated test, the legacy handler in App's triad, legacy DOM-walk helpers, `chromium-legacy` project, CLAUDE.md sections | Medium — large diff, but pure deletion of dead-after-1i-b.1 code |
| **1i-c** | DEFERRED — schemaVersion bump, force-remigration of `migrationPartial` rooms, Y.Text fallback removal, ESLint toolchain bootstrap | Future PR |

**Why 1i-a first:** the CI safety net today IS the legacy project. Deleting it without first proving chromium-PM is green leaves zero PM coverage. Some of the ~40 known failures may already be closed by 1f–1h; the rest must close in 1i-a.

**Why split 1i-b into 1i-b.1 and 1i-b.2:** runtime rewire and deletion sweep are independently risky for unrelated reasons. The rewire (1i-b.1) is small but easy to land subtle undo regressions in — a one-day soak between PRs catches those before the deletion diff buries them. The deletion (1i-b.2) is mechanical but produces hundreds of test-file diffs that drown rewire signal in review. 1i-b.1's CLAUDE.md edits are limited to wart removal that no longer applies; legacy-describing sections stay until 1i-b.2 deletes the code. No transient "docs describe code that doesn't exist" window.

### D2 — Close the structural-undo origin gap in 1i-b.1

`applyBlocksToYDoc` writes use origin `'local-apply'` ([src/lib/collab.js:682](src/lib/collab.js:682)). Both UndoManagers (`useLocalSubstrateUndoManager` and `createCollabSession`'s in-room manager) track `{'local-publish', ySyncPluginKey}` only. Today the `useUndoableBlocks` snapshot stack covers structural ops (Enter, Delete, slash-convert, reorder) — when 1i deletes the hook, that coverage vanishes.

**Fix:** change `applyBlocksToYDoc` to write under `'local-publish'` origin. One role per origin — `'local-apply'` was the snapshot-publish path; `'local-publish'` is the undoable-mutation path. Both UndoManagers' trackedOrigins remain `{'local-publish', ySyncPluginKey}` (no drift), and structural ops naturally enter the Yjs undo stack with no further wiring.

**Empty-transact concern:** `updateYMapFromBlock` ([collab.js:521-528](src/lib/collab.js:521)) guards with `cur !== block[k]` so unchanged scalars produce no Yjs ops. Yjs's UndoManager only emits `stackItem` for non-empty changes, so empty transacts are silent. Safe — but pin it: regression test asserts that **PM typing in out-of-room mode produces ZERO undo frames from the `applyBlocksToYDoc` useEffect** (only from `ySyncPlugin`'s own per-keystroke ops). Without that test, a future SCALAR_KEY whose initial-undefined trips the guard would silently double-frame undo.

**Other-consumer risk:** `handleAfterTx` filters `'local-*'` prefix, so the rename is transparent to remote-blocks delivery. Verify in implementation that no other code reads the origin literal.

### D3 — Skip the schemaVersion bump entirely

CLAUDE.md commits to bumping to v3 "when legacy goes away." Two reasons to drop:

1. **No breaking-change semantic.** Once legacy is gone, both v2 and "post-legacy v2" rooms are 100% Y.XmlFragment. v3 would be cosmetic — a stamp with no behavioral gate.
2. **Adoption-window risk.** `useCollabSession.js`'s version gate refuses rooms with `version > MAX_SUPPORTED`. Bumping 1i clients' MAX_SUPPORTED to 3 and stamping new rooms at v3 means deployed v2 clients refuse v3 rooms on contact — the 1b.1 transitional-release precedent (a v1.5 client that supported {1, 2} shipped before 1d's v2 bump) would have to be replicated, and the operational cost isn't worth a cosmetic stamp.

When a future PR actually needs to drop the Y.Text fallback (forcing migrationPartial rooms to re-migrate or quarantine), THAT PR can bump to v3 with the adoption-window mechanics. Documented as 1i-c.

### D4 — Replace the lint rule with a Vitest greptest

The project has no ESLint config, no `eslint*` dependency in `package.json`, no `lint` script, and no CI lint step. Adding a `no-restricted-syntax` rule is a full toolchain bootstrap (install eslint + react plugin, write flat config, add npm script, wire into ci.yml).

Vitest already runs in CI (`Unit & Compliance Tests` job). A unit test that greps `src/**/*.{js,jsx}` excluding `__tests__/**` and `block-registry.js` for the pattern delivers the same enforcement with zero new toolchain. Test goes at `src/lib/__tests__/block-registry-discipline.test.js`.

**Regex must catch template-literal forms too.** `App.jsx:627` uses `` `[data-block-id="${id}"]` `` — a regex of `querySelector\(['"`]\[data-block-id` (note the backtick added to the character class) covers all three quote forms. Currently exactly one live src violation: `App.jsx:627` inside `focusBlock`'s `fallbackToDom`. The greptest's pre-go-green steps: either refactor `fallbackToDom` to route through `block-registry.focusBlockById`'s legacy-handle fallback, or whitelist with an inline `/* allowed: block-registry fallback */` marker the greptest recognizes. Existing `EditableBlock.test.jsx` uses the pattern but is deleted in 1i-b.2. `SearchBar.jsx:207` reference is in a comment, not live code.

### D5 — `migrationPartial` blocks get a read-only banner; required for 1i-b.1

Per ADR-0006, `migrationPartial` rooms have a mix of Y.XmlFragment and Y.Text html slots. `block-html-store.js`'s `deriveHtml` and `setBlockHtml` both branch on shape — the Y.Text fallback paths stay in 1i (out of scope; deferred to 1i-c).

**Empirically known from code review:** `PmEditableBlock.jsx:230` already bails silently when `yXml` is a Y.Text slot (`typeof yXml.toArray !== 'function' || typeof yXml.nodeName === 'string'`). Today this is invisible because the rendering branch picks `EditableBlock` for those blocks based on the flag (not block shape). After 1i-b.2 deletes `EditableBlock` and removes the branch, that bail produces an empty contentEditable `<div>` with no PM mount, no DOM content, no banner — the block becomes invisible and uneditable. ADR-0006's "Half-migrated rooms remain editable" promise silently breaks.

**Required in 1i-b.1** (BEFORE deletion in 1i-b.2):

1. **Detect** the Y.Text shape in `PmEditableBlock` (or in App's render-branching site) explicitly — duck-type the html slot using the same predicate as `block-html-store.js`'s branch.
2. **Render** a read-only stub with a banner: "This block needs re-migration. The room is partially migrated; contact your operator to re-run conversion." Use the existing `migration-partial` status styling.
3. **Skip** the PM mount entirely for these blocks — no EditorView instance, no `ySyncPlugin` binding attempt, no risk of corrupting the slot.

This is a hard requirement, not "TBD." The bail path at `PmEditableBlock.jsx:230` is the answer to the previous "open question" about PM mounting on Y.Text — empirically it bails, and after legacy removal the bail must be visible.

### D6 — `TitleBlock` paste handler stays

TitleBlock is contentEditable (not PM-managed); its paste handler legitimately calls `sanitizePasteText`. Three-path lockstep collapses to two-path (TitleBlock + PmEditableBlock), but both still want the same sanitizer. CLAUDE.md's "three paths must stay in lockstep" wart simplifies to "two paths must stay in lockstep" — both still import from `src/lib/paste-sanitize.js`.

### D7 — `tcState` moves to App `useState`; TC-toggle-undo regression accepted

`tcState` / `setTcState` come from `useUndoableBlocks` today. When the hook dies, App needs them directly. Post-1h Q35+Q37, the TC reducer state is just `{ enabled, publishSeq }` — atomic capture of `(blocks, tcState)` was incidental to the snapshot stack's design, not load-bearing for TC correctness (the publishSeq counter handles echo gating; there's no per-block snapshot to keep in sync).

**Accepted behavioral regression:** a Ctrl+Z that crosses a TC enable/disable boundary will no longer undo the TC enable in lockstep with the block state. TC toggle is an explicit user gesture (button click in the toolbar), not a typing-grain mutation; rolling it back implicitly with the next typing-frame undo was never user-facing documented behavior, and there's no test that pins it (verified by `grep -rn "tcState" src/__tests__ src/components/__tests__ src/lib/__tests__` showing only reducer-shape tests, no atomic-capture tests). The replacement: `const [tcState, setTcState] = useState(() => tc.createInitial())` at the top of `SpecEditor`.

## Scope

### In (PR 1i-a)

1. **Triage and close PM-only test failures** at chromium project HEAD. The CI comment at `.github/workflows/ci.yml:129-134` claims ~40 known failures across DOM-depth selectors, slash menu wiring, del popup, paste-strip, comment reconcile. Audit current state — some may already be closed by 1f–1h. Open issues for any persisting failures the 1i-a author considers out of scope; close them before 1i-b.1 lands. **Triage result is a pre-merge gate for 1i-b.1.**
2. **Audit `MarkSuggestions.onApply`, `FloatingToolbar.onBlockUpdate`, and every non-PM-dispatch substrate-writing path** for whether they still require `setBlockHtml` after legacy removal. Document findings in the 1i-b.1 implementation plan — answers are prerequisites to the App handler-triad collapse in 1i-b.2 step 4.
3. **Update `.github/workflows/ci.yml:136`** from `--project=chromium-legacy` to `--project=chromium`. Update the comment block at lines 129-134 to reflect the new state.
4. **Update CLAUDE.md testing rule #10** to reflect single-project CI gate.

### In (PR 1i-b.1) — runtime rewire only, no legacy deletion

Implementation order matters. Each step assumes the previous succeeded.

1. **Structural-undo origin flip.** Change `applyBlocksToYDoc` ([src/lib/collab.js:682](src/lib/collab.js:682)) to write under `'local-publish'` origin. Verify no other reader expects the `'local-apply'` literal. Add two regression tests in `src/lib/__tests__/`:
   - **Positive:** out-of-room slash-convert from `txt`→`note` → Ctrl+Z reverts the `block.type` change in one frame without disturbing any prior typed text in unrelated blocks.
   - **Negative (anti-spurious-frame):** PM typing in out-of-room mode produces zero additional undo frames from the `applyBlocksToYDoc` useEffect — count UndoManager stack depth before/after a typing burst that triggers no scalar mutation.
2. **Move TC state to App.** `const [tcState, setTcState] = useState(() => tc.createInitial())` at the top of `SpecEditor`. Remove `tcState`/`setTcState` from `useUndoableBlocks`'s return; the hook keeps returning `setBlocks` / `setBlocksDirect` / `undo` / `redo` / `canUndo` / `canRedo` / `resumeHistory` / `clearHistory` until 1i-b.2 deletes it.
3. **Migration-partial detection and banner.** Implement D5: duck-type Y.Text html slots in `PmEditableBlock`'s mount logic (or the App-side render branch); render read-only stub with banner; skip PM mount. Test with a fabricated migrationPartial room fixture in `tests/e2e/` or a Vitest substrate-mount test.
4. **Comment-reconcile undo gate.** Add a `setBlockHtml` variant (`setBlockHtmlSilent` or `setBlockHtml(yStore, id, html, { trackable: false })`) that transacts under a non-tracked origin (e.g., `'local-reconcile'`). Wire the App-level comment-reconcile effect (App.jsx ~796) and any `cm.reconcileBlocks`-driven substrate writes through the silent variant. Invariant: Ctrl+Z after a reconcile fires reverts the underlying user action in one stroke, not the reconcile. Pin with a Vitest test that runs reconcile mid-typing and asserts undo stack depth unchanged. **This step must land before step 5** because step 5's `shouldSkip` drop expands the reconcile surface to PM-mounted blocks.
5. **Drop `shouldSkip` predicate** in App's comment-reconcile useEffect (App.jsx ~810). All editable blocks PM-mounted means uniform `cm.reconcileBlocks` walk is safe — and step 4's gate prevents any html-mirror echo from entering undo. Add a Vitest test for the PM-mounted-block reconcile path.
6. **Greptest** at `src/lib/__tests__/block-registry-discipline.test.js`. Regex: `querySelector\(['"\`]\[data-block-id`. Excludes `src/lib/block-registry.js` and `**/__tests__/**`. Before merge: refactor `App.jsx:627`'s `fallbackToDom` to route through `block-registry`'s own legacy-handle fallback, OR whitelist with `/* allowed: block-registry fallback */` marker.
7. **CLAUDE.md wart removal (limited).** Update the "Non-obvious invariants" `'local-apply'` description to `'local-publish'`. No other CLAUDE.md edits in 1i-b.1 — legacy-describing sections stay until 1i-b.2.

### In (PR 1i-b.2) — atomic deletion sweep, lands after 1i-b.1 bakes one day

1. **Inline-replace flag branches.** Every `isPmEditorEnabled() ? <PmEditableBlock …> : <EditableBlock …>` site (App.jsx block-render loop) becomes the PM-path JSX inline. Removal of `getEditorMode` (`App.jsx:912`) and friends happens in step 2.
2. **Delete the flag and its consumers.** Remove `src/lib/feature-flags.js`, `src/lib/__tests__/feature-flags.test.js`, the `forcePmEditor` fixture in `tests/e2e/fixtures.js`, the `chromium-legacy` project in `playwright.config.js`, the `getEditorMode` export in `tests/e2e/pm-helpers.js:68-76`. Update every test file that consumed `forcePmEditor` (project param) or `getEditorMode` (test.skip gate):
   - `tests/e2e/editor.spec.js` — multiple `test.skip(!forcePmEditor, 'PM-only')` become unconditional; multiple `test.skip(forcePmEditor, 'Legacy-only')` blocks DELETE entirely.
   - `tests/e2e/collab.spec.js` — same pattern; audit and convert.
   - Run a full grep for `forcePmEditor`, `getEditorMode`, `PM_EDITOR_ENABLED`, `__SIM_FORCE_PM_EDITOR`, `VITE_PM_EDITOR`, `?pm=` in `src/**` and `tests/**`; every hit is touched in this PR.
3. **Delete `EditableBlock.jsx` and its test.** `src/components/EditableBlock.jsx`, `src/components/__tests__/EditableBlock.test.jsx`. Verify no remaining imports anywhere.
4. **Collapse App's handler triad.** `handleBlockUpdate` (debounced typing), `handleLegacyRevisionAction` (legacy click path — DELETE), `handleBlockUpdatePmSync` (PM click path) collapse to two handlers: a typing handler and a click handler. The legacy variant goes away; the remaining two preserve `setBlockHtml` for the non-PM-dispatch paths identified in 1i-a step 2.
5. **Drop every `resumeHistory()` call site.** Keep paired `forceFrame()` calls — those operate on the Yjs UndoManager and remain needed.
6. **Delete `src/lib/useUndoableBlocks.js`.** Remove the import in App.jsx; remove the destructure; collapse 3-tier undo fallback (`collab.tryUndo → localUndo.tryUndo → useUndoableBlocks.undo`) to 2-tier. TC state is already detached (1i-b.1 step 2) so the hook's death changes nothing structurally; this is mechanical.
7. **Drop legacy DOM-walk helpers** from App.jsx: `getPlainTextOffset`, `resolveOffsetInRoot`, `restorePlainTextOffset`. These supported the pre-1e contentEditable cursor restore across remote updates; PM owns its own selection management now.
8. **Collapse `CommentPopup` mode-conditional fallback.** Per CLAUDE.md "Comments Architecture" §6, the popup's `setAttribute` fallback was gated on `getBlockView(blockId) == null`. With every editable block PM-mounted, the legacy DOM `setAttribute` path is dead.
9. **CLAUDE.md cleanup.** Drop entire "contentEditable Focus Management" section. Drop "`VITE_PM_EDITOR` flag" subsection. Drop the "PM path (1e, `VITE_PM_EDITOR=true`)" parenthetical in "Tag Visibility Toggle." Retire three-path-paste-lockstep wart (collapse to two-path). Retire dual-stack-no-coalescing transient wart. Retire `useUndoableBlocks` legacy fallback wart. Retire "Trust isolated runs over the full-suite diff" note about dual-project flakes. Update "Track Changes Architecture" §2 to remove the `handleLegacyRevisionAction` reference. Update Comments Architecture §6 to remove the mode-conditional fallback note. Mark issue #47 sub-PRs complete with cross-link.

### Out (deferred to 1i-c, separate issue, or later)

- **schemaVersion bump to 3** (per D3).
- **Force-remigration of `migrationPartial` rooms** — needs server-side hook to retry conversion of Y.Text slots on first 1i-c-client connect. Out of scope.
- **Y.Text fallback removal in `block-html-store.js` and `collab.js`'s `yMapToBlock`** — needs migrationPartial rooms drained first. Out of scope.
- **Drop `src/lib/ytext-html.js`** — NOT possible until ref/table CRDTs (`yref-crdt.js`, `ytable-crdt.js`) migrate off Y.Text. Separate work, no migration path defined yet.
- **`TitleBlock` paste handler** stays (D6).
- **ESLint toolchain bootstrap** deferred. Greptest is sufficient (D4).
- **`commitBeforeAction` stub** at `src/lib/pm-plugins/keymap.js:23-52`. Comment claims "1g/1i may make it not a no-op" — no concrete use case has surfaced. Capture as a follow-on issue rather than bundling an interactive design decision into a deletion PR.
- **Out-of-room cursor broadcast in PM mode** — `useCollabSession.js:572`'s `plainTextOffset` cursor pathway walks PM widget decorations producing wrong offsets. Out of scope; capture as follow-on issue.

## Risks

1. **Structural undo regression slips through** — mitigated by D2's origin fix and the positive + negative regression tests in 1i-b.1 step 1.

2. **migrationPartial editability regression** — mitigated by D5's required banner work in 1i-b.1 step 3. Without this, ADR-0006 promise breaks silently after 1i-b.2 lands.

3. **TC undo lockstep regression** — D7 accepts and documents.

4. **Comment-reconcile substrate writes pollute Yjs undo** — mitigated by 1i-b.1 step 4 (silent `setBlockHtml` variant) landing before step 5 (shouldSkip drop). Step 4 has its own pin test.

5. **MarkSuggestions / FloatingToolbar setBlockHtml dependency missed** — mitigated by 1i-a step 2's pre-1i-b audit. Findings document is a pre-merge gate for 1i-b.1.

6. **CI runs zero PM coverage during 1i-a transition** — sequence within 1i-a: fix PM failures first, then switch CI in the same PR. Don't merge a half-finished 1i-a.

7. **`'local-apply'` rename has unexpected downstream consumers** — mitigated by D2's verification step. Most likely safe (`handleAfterTx` only filters `'local-*'` prefix), but verify.

8. **1i-b.2 deletion sweep misses a `getEditorMode` or `forcePmEditor` consumer** — mitigated by the "full grep for every flag-related symbol" requirement in 1i-b.2 step 2. Pre-merge check.

## Test plan

### Pre-merge (every PR in the chain)
- `npm test` (Vitest)
- `npm run test:compliance` (Node runner)
- `npm run test:server` (Node runner)
- `npm run test:corpus`
- `npm run test:e2e` — both `chromium-legacy` and `chromium` projects through 1i-a; `chromium` only from 1i-b.1 onward

### 1i-b.1-specific new tests
- Structural undo positive: out-of-room slash-convert → Ctrl+Z reverts type change in one frame, no disturbance to unrelated typed text
- Structural undo anti-spurious-frame: PM typing in out-of-room mode adds zero undo frames from `applyBlocksToYDoc` useEffect
- migrationPartial mount: fabricated Y.Text slot renders read-only banner, does not attempt PM mount
- Comment-reconcile undo gate: reconcile mid-typing does not increment UndoManager stack depth
- Block-registry greptest

### Manual smoke tests (1i-b.2, post-deletion)
- Word-grain Ctrl+Z and Ctrl+Y in and out of room (typing, structural ops, accept-all, comment-create)
- New-block focus via Enter and slash-convert
- Plain text paste; rich text paste from Word — both sanitize to plain
- TC toggle, accept/reject inline, accept-all (verify documented D7 regression: TC enable not undone by typing-frame Ctrl+Z)
- Comment create / reply / resolve / reopen
- Open a `migrationPartial` room (fabricate if none exists in test storage) — verify Y.Text slots render banner and remain non-editable; verify Y.XmlFragment slots in the same room remain editable

### Post-merge
- Render production deploys and verify no v=3 schema-incompatibility banners on existing rooms (sanity that D3's "skip the bump" was respected in implementation)

## Open verification items (for the 1i-a triage phase, BEFORE 1i-b.1 opens)

These need empirical answers before 1i-b.1's PR opens. Document in the 1i-a PR description, not deferred:

1. **Are there any `'local-apply'` literal-string consumers beyond `handleAfterTx`?** (D2 verification)
2. **Are all ~40 chromium-PM CI failures currently present at HEAD, or have some closed in 1f–1h?** (1i-a step 1)
3. **Does `MarkSuggestions.onApply` or any other non-PM-dispatch path still require `setBlockHtml`?** (1i-a step 2)

Items previously open are now resolved:
- ~~Does PM mount on a Y.Text html slot?~~ → Resolved by code reading. PmEditableBlock.jsx:230 already bails. D5 makes the bail visible.
- ~~Does any existing test pin the (blocks, tcState) atomic capture?~~ → Resolved by grep. No such test exists. D7 accepts the regression.

## Out of scope (won't do in 1i)

- Generalized rewrite of any in-scope file
- Performance optimization
- Schema changes beyond removing the legacy code path
- Test infrastructure rewrites
- `commitBeforeAction` implementation decision (separate issue)
- Out-of-room PM-mode cursor broadcast fix (separate issue)
