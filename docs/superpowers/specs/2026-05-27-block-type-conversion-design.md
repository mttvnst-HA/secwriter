# Block-type conversion — design spec

**Status:** Approved via brainstorming + 1 round of agent pushback (refined Approach A → narrowed Family A scope)
**Date:** 2026-05-27
**Related:**
- [blocks.js:416](../../../src/lib/blocks.js) — existing `convertBlock` reducer (slash-menu flow; clears html)
- [App.jsx:2669](../../../src/App.jsx) — wrapper key `${block.id}-${block.type}` (verified vestigial via audit)
- [SlashMenu.jsx](../../../src/components/SlashMenu.jsx) — existing block-type catalog
- [pm-plugins/slash-menu.js](../../../src/lib/pm-plugins/slash-menu.js) — slash trigger plugin
- [ADR-0008](../../adr/0008-blocks-reducer-architecture.md) — blocks reducer protocol
- [ADR-0009](../../adr/0009-track-changes-per-keystroke.md) — TC reducer and revision composition

## 1. Problem statement

Today, the only way to change a block's type is the slash menu, which fires only when the doc text starts with `/`. The reducer behind it (`Blocks.convertBlock`) allocates a new block id and clears the html — correct for the slash-menu flow because the slash itself is the content, but useless for converting a block that already holds content.

Engineers writing UFGS specs need to turn an existing paragraph into a note (or a list item, or a header line) without retyping. Today they have no path: delete-and-recreate loses comments, undo history, and TC state on that block.

## 2. Scope

### In scope (this design)

Convert an existing block between any pair of these five types, preserving html:

- `txt` (paragraph)
- `note` (designer note)
- `oli` (ordered list item)
- `item` (bulleted list item)
- `lst` (submittal list header)

These five all share `html`, all render through `PmEditableBlock`, all use the same PM schema. Call this set **Family A**.

### Deliberately out of scope

- `title`, `table`, `ref`, `pagebreak`, `tbl` — these have per-arm data shapes (depth+sectionNum, columns+rows, org+entries, no content, preformatted). Converting into or out of them is genuinely lossy. User creates these via the slash menu on a fresh block; to "replace" an existing block with one of these, delete + slash-create. Explicit, no surprise data loss. A future spec may add cross-family conversion with a confirm dialog.

## 3. Decisions

1. **UI trigger** — two affordances, both gated to Family A blocks:
   - Gutter handle (left of block on hover) → small popover "Turn into ▾" with the 4 other Family A types.
   - Keyboard shortcut `Ctrl+Shift+M` (mnemonic: "morph") opens a floating palette of Family A types, filterable.
2. **Menu scope** — lossless only. Family A targets only. Title/table/ref/pagebreak/tbl are absent from both affordances by design.
3. **Track Changes** — under TC ON, the converted block gets `revision: 'chg'`, composing with any existing block-level revision (rules in §4.4).
4. **Block identity** — same id across conversion (no remount). PM EditorView persists; comments survive; lint cache reusable. Enabled by dropping the type-suffix from the wrapper key.

## 4. Architecture

### 4.1 Reducer — `src/lib/blocks.js`

Add a new pure verb alongside `convertBlock`:

```js
export function convertBlockType(blocks, blockId, newType, { tcState }) {
  // Preconditions: blockId exists AND block.type ∈ FAMILY_A AND newType ∈ FAMILY_A AND newType !== block.type.
  // Returns null on any violation (caller is responsible for not offering invalid targets).
}
```

Behavior:

- Locate block by id.
- Construct `next[idx] = { ...block, type: newType, ...levelDelta(block.type, newType), revision: composeRevision(block.revision, tcState) }`.
- `html` preserved unchanged.
- `isNew` preserved (typically false; conversion is on an existing block).
- Return `{ state, effects }`:
  - `framing: { kind: 'newFrame' }` — close any open undo capture window.
  - `substrateWrites: []` — type is a scalar, written via the structural publish path (`updateYMapFromBlock` includes type in `SCALAR_KEYS`). No direct substrate mutation.
  - `flush: null`.
  - `focus` — caret preservation handled by the UI components (§4.5), not by the reducer effect. The reducer emits no `focus` effect for this verb; both the gutter handle and the palette restore PM caret/focus themselves after dispatch using the block-registry handle.

**Lint cache invalidation is NOT a blocks-reducer effect.** Per ADR-0008 the dispatcher does not cross into the linting reducer's namespace. The App handler `handleConvertBlockType` (§4.6) calls `setLintingState(s => linting.clearBlock(s, blockId))` immediately after `dispatchBlocks(...)`. `linting.clearBlock` already exists ([linting.js:172](../../../src/lib/linting.js)); no new pure verb needed.

### 4.2 `levelDelta` — oli-boundary handling

Only `oli` carries a `level` field (1..4). On conversion:

- Entering oli (any → oli): if block has a stashed `level` from a prior oli stint (see below), restore it; else set `level: 1`.
- Leaving oli (oli → any): **preserve `level` on the block** (do not omit). Non-oli render paths ignore it ([PmEditableBlock.jsx](../../../src/components/PmEditableBlock.jsx) only reads `level` when `block.type === 'oli'`), so this is a cheap stash that survives `oli → txt → oli` round-trips without resetting the user's level choice.
- Non-oli pairs: no change.

Pure helper, table-testable. Edge case: a block that has NEVER been oli (e.g. created fresh as txt) has no `level` field; converting it to oli sets `level: 1`. A block that WAS oli at level 3 then went to txt retains `level: 3`; converting back to oli restores level 3.

**Scope of the stash:** in-session only. The .SEC serializer ([sec-serializer.js:496](../../../src/lib/sec-serializer.js)) only emits LEVEL for `oli` — confirmed safe (a non-oli block carrying a stale `level: 3` doesn't pollute disk output). But the parser does not populate `block.level` for non-oli blocks on import, so an import → convert oli(L=3)→txt → export → re-import cycle loses the stash. This is acceptable: the within-session UX is the primary concern; cross-session level memory across non-oli intermediate states is not.

### 4.3 Wrapper key change — `src/App.jsx:2669`

```diff
-              <div key={`${block.id}-${block.type}`}>
+              <div key={block.id}>
```

Verified safe by audit:
- No existing path mutates `type` without also changing `id` ([blocks.js:292](../../../src/lib/blocks.js), [:309](../../../src/lib/blocks.js), [:423](../../../src/lib/blocks.js) all allocate new ids).
- The suffix has been inert since the initial commit; dropping it is a no-op for every existing flow.
- Enables PM EditorView persistence under the new same-id flow.

If the full E2E suite turns up a regression, revert to the suffix on the regressing branch only — do NOT pre-emptively keep it.

### 4.4 TC composition — `composeRevision(prev, tcState)`

Block-level revision composition under TC ON:

| Prev revision | New revision after convert |
| --- | --- |
| `undefined`   | `'chg'` |
| `'add'`       | `'add'` (preserved) |
| `'del'`       | `'del'` (preserved) |
| `'chg'`       | `'chg'` (idempotent) |

Under TC OFF: leave `revision` unchanged.

**Audit-trail limitation (explicit):** Block-level `revision` is a flag, not a record. Accepting a `'chg'` block via `acceptBlockRevision` ([blocks.js](../../../src/lib/blocks.js)) clears the flag and accepts inline marks via `acceptAllInline(block.html)` — it does NOT roll back the type. Symmetrically, `rejectBlockRevision` clears the flag and rejects inline marks but leaves the type as-converted. **Implication:** type changes survive accept/reject. If a user needs to undo a type conversion, the path is Ctrl+Z (UndoManager covers the `type` scalar write — see §5 #7), not Reject. The spec accepts this limitation rather than building a parallel `previousType` audit field, because:
1. Type conversion is a coarse intent ("turn this into a note"); fine-grained rollback is the wrong UX.
2. Adding `previousType` would require parallel logic in accept/reject paths, doubling the surface area.
3. The Reject button on a `'chg'` block already has loose semantics for inline marks composition — the spec does not regress that.

**UX surfacing of the limitation:** The accept/reject buttons in [PmEditableBlock.jsx:856-869](../../../src/components/PmEditableBlock.jsx) get an extended `title` attribute when the block's `revision` is `'chg'` AND the block has a non-null `__convertedFrom` field. This field is set in `convertBlockType` (lossless add: `{ ...block, __convertedFrom: block.type, type: newType, ... }`) and cleared in both `acceptBlockRevision` and `rejectBlockRevision`. The field is local-only (not persisted to .SEC, not synced to peers — purely a transient UX hint). Tooltip text: "Accept — note: this block was converted from <type>; the type change is preserved" / "Reject — note: this rejects inline edits but does NOT undo the type conversion (use Ctrl+Z to undo type changes)".

Implementation: small pure helper in `track-changes.js` (or inline in `convertBlockType` if it stays tiny). Symmetric with `revisionFlagForCreate` already in tc.

### 4.5 UI components

**`BlockGutterMenu.jsx`** (new):
- Renders inside `PmEditableBlock`'s render tree (NOT inside the App.jsx wrapper at line 2669). The PmEditableBlock root already has `position: relative` and already absolutely positions accept/reject buttons at `left: -4, top: 4` and the lint-severity dot at `left: 2, top: 8`. The gutter handle anchors at `left: -22, top: 4` (one slot further left of the revision buttons).
- **Viewport-clip mitigation:** `left: -22` extends 22px outside the PmEditableBlock wrapper's left edge. The editor surface (`#editor-area` in App.jsx) has padding-left ≥ 32px in all current layouts, so the handle stays inside the editor surface. If a future narrow-viewport layout reduces editor padding, the gutter handle's position becomes `left: max(-22, -editorPaddingLeft + 4)` via a CSS env variable. Writing-plans will verify the current padding values during the implementation grep.
- 14×14 button, visible only on `:hover` of the PmEditableBlock root.
- **Collision rule:** when the block has block-level `revision` set (revision buttons are visible), the gutter handle hides — the user can still trigger conversion via the keyboard palette. Avoids the "three gutter affordances stacked" visual mess.
- Click opens a popover anchored to the button with the 4 other Family A types as buttons.
- All button `onMouseDown` handlers call `e.preventDefault()` (the FloatingToolbar pattern at PmEditableBlock.jsx:922) so the EditorView keeps DOM focus across the click.
- On selection: dispatch the convert verb, then call the PM view's `.focus()` via the block-registry handle to guarantee caret returns to the editor body.
- Each button label/icon matches the existing `SLASH_ITEMS` entries for parity.
- ARIA: `aria-label="Convert block"` on the button, `role="menu"` on the popover, `role="menuitem"` per type.

**`ConvertBlockPalette.jsx`** (new):
- Floating (non-modal) palette opened by `Ctrl+Shift+M` when focus is in a Family A block.
- Positioned near the active block's gutter handle anchor (reuses the gutter handle's bounding rect if mounted; falls back to block top-left).
- **Caret preservation:** on open, the palette captures the current PM selection via the block-registry handle (PM `state.selection`) and stashes it. On selection or Escape, the palette dispatches (if a type was chosen) and then calls `view.focus()` + restores the stashed selection via a `TextSelection` dispatch. Matches the pattern used by the FloatingToolbar for inline mark insertion.
- Same Family A entries as the gutter menu, filterable by typed prefix (mirrors SlashMenu's filter behavior).
- Closes on Escape, on click outside, or on selection.
- While open, keystrokes (other than Esc / arrows / Enter / typing for filter) are captured by the palette, not the underlying PM EditorView.

Both components dispatch into a single App handler (§4.6).

### 4.6 App handler — `src/App.jsx`

```js
const handleConvertBlockType = useCallback((blockId, newType) => {
  dispatchBlocks((b) => Blocks.convertBlockType(b, blockId, newType, { tcState: tcStateRef.current }));
  setLintingState((s) => linting.clearBlock(s, blockId));
  setOpenCommentId((id) => (id && commentsState.byId.get(id)?.blockId === blockId ? null : id));
}, [dispatchBlocks, commentsState]);
```

Three calls in order:
1. `dispatchBlocks` — runs the pure verb, writes `type` scalar via the publish path.
2. `setLintingState(clearBlock)` — drops stale findings (§5 #3).
3. `setOpenCommentId(...)` — closes any comment popup anchored to the converted block; the popup's cached `commentRect` becomes stale on the type flip because note vs txt styling shifts content position by 2-4px (border + padding delta in [PmEditableBlock.jsx:808-817](../../../src/components/PmEditableBlock.jsx)).

Wire as new prop `onConvertBlockType` on `PmEditableBlock`, alongside the existing `onConvertBlock` (the slash-menu flow stays untouched — Family B targets still create new ids via `Blocks.convertBlock`). The PmEditableBlock receives both and exposes the gutter handle + listens for the keyboard shortcut.

### 4.7 Collab path

`type` is in `SCALAR_KEYS` ([collab.js:675-682](../../../src/lib/collab.js)). The structural publish effect in `useCollabSession` calls `applyBlocksToYDoc`, which calls `updateYMapFromBlock`, which writes the new `type` scalar with origin `'local-publish'`. Peers reconcile via the existing remote-blocks path. No new collab seam needed.

The Y.XmlFragment in `yMap.get('html')` is untouched (single-block conversion preserves html). No broker swap, no substrate churn. The `convertBlockType` reducer's `substrateWrites: []` is correct precisely because the type scalar publish rides `applyBlocksToYDoc` automatically — we are NOT skipping a write, the publish path handles it.

**Why the PM EditorView survives a peer-driven type change (Family A only):** PmEditableBlock's mount effect deps are `[block.id, yStore, editable, yMapBound, isMigrationPartial]` — `type` is NOT in the deps directly, but `editable` is a `useMemo` of `block.type` ([PmEditableBlock.jsx:209-213](../../../src/components/PmEditableBlock.jsx)). Within Family A, all five types are editable, so `editable` does not flip and the mount effect does not re-fire. Plugins built once at mount (slash-menu, keymap, tag-labels) read the current block type via a ref (`blockTypeRef.current`), not via closure capture, so they always see the latest type. A peer flipping txt→note is observable to plugins on the next read with no remount.

**Important scope guard:** This survival depends on staying inside Family A. A future cross-family conversion path (e.g. Family A → table/ref/title) WILL trigger a remount via the `editable` flip (or via the App-level render-switch routing to a different component). Any such future verb must not assume the PM view persists.

## 5. Edge cases

1. **Conversion in the middle of an IME composition** — PM view persists (same id), composition continues across the type flip. Verified by manual test; no special handling required.
2. **Conversion of a block with active comments** — comments anchor on commentIds inside the html. Html unchanged → comments survive. `comments.byId` keyed on commentId, not blockId, so no comment-state surgery needed.
3. **Conversion of a block with lint findings** — STALE FINDINGS HAZARD, partial self-heal.
   - `lintingState.byBlock` is a `Map<blockId, finding>` (note: `.get(blockId)`, not `[blockId]`).
   - `useBlockLinting`'s `lint()` callback recomputes when `isNoteBlock` changes (deps include `block.type`), and the input-binding effect re-binds; for **focused** blocks where the conversion crosses the note boundary (txt↔note), the next render frame re-lints automatically.
   - **Does NOT self-heal:** txt↔oli/item/lst (no `isNoteBlock` flip), or any conversion of an **unfocused** block via a future "convert selected blocks" gesture.
   - **Fix:** App handler `handleConvertBlockType` (§4.6) calls `setLintingState(s => linting.clearBlock(s, blockId))` after dispatch. `linting.clearBlock` already exists ([linting.js:172](../../../src/lib/linting.js)). Force-clear is cheap and correct in every case (the focused-block re-lint will repopulate within one frame; unfocused blocks stay clear until next focus, which matches existing "only focused block is linted" behavior).
   Verify with E2E scenario "convert txt with compliance flag → note, flag disappears within one render frame".
4. **Conversion to/from oli** — `oliLabels` recomputes from `blocks` ([App.jsx](../../../src/App.jsx) — search `oliLabels`). Same-id mutation: the recompute fires on the next `blocks` change. No special handling.
5. **Conversion under read-only mode (`collabReadOnly`)** — gutter handle and palette both check the same flag the rest of the editor checks; both hidden / disabled when read-only.
6. **Conversion when block is part of a multi-select** — out of scope. Multi-select doesn't exist in SecWriter today.
7. **Undo after conversion** — scalar `type` change written with `'local-publish'` origin enters both UndoManagers (in-room via `createCollabSession`, out-of-room via `useLocalSubstrateUndoManager`). Ctrl+Z reverts the type. Pair with the wrapper-key drop: undo across conversion should NOT remount, so the caret stays put.
8. **Two peers converting the same block concurrently** — Y.Map scalar LWW is per-key. Peer A flips txt→note (writes `type='note'`, no level write because both are non-oli); peer B flips txt→oli concurrently (writes `type='oli'`, `level=1`). If A wins type and B wins level, end state is `{type:'note', level:1}` — type-inconsistent but harmless: PmEditableBlock only reads `level` when `type==='oli'`, falling back to `level || 1` (PmEditableBlock.jsx:795). Acceptable, but not strictly "benign" — flagged here so future debugging knows the inconsistency is by design.

## 6. Testing

### 6.1 Unit tests — `src/lib/__tests__/blocks-convert-type.test.js` (new)

Table-driven:
- All 20 ordered pairs of Family A types (5 × 4): preserves html, flips type, correct level delta.
- Rejects newType ∉ Family A (returns null).
- Rejects newType === block.type (returns null).
- Rejects non-Family-A source block (returns null).
- TC composition table from §4.4 (4 cases × TC on/off).

### 6.2 PmEditableBlock test — `src/components/__tests__/PmEditableBlock-convert-persist.test.jsx` (new)

Verify PM view persistence across same-id conversion:
- Mount PmEditableBlock with `block.type='txt'`, capture the registered imperative handle via `block-registry.getBlockHandle(blockId)` (verify exact export name in [block-registry.js](../../../src/lib/block-registry.js)).
- Re-render with the same block id and `block.type='note'`.
- Assert `getBlockHandle(blockId)` returns the SAME handle identity (`Object.is`). A remount would unregister + re-register, producing a fresh handle.
- Belt-and-suspenders: assert the EditorView's `dom` element identity is unchanged across the re-render (captured via the handle).

This is the regression test for the wrapper-key drop. If a future change re-introduces a remount on type change, both assertions fire.

### 6.3 E2E — `tests/e2e/editor.spec.js` (extend)

Four scenarios:
1. **Gutter handle preserves comments.** TC OFF for this scenario (so the block-level wrapper class is unchanged across conversion). Create a txt block with content, add a comment on a word range, capture the rendered comment id from the DOM. Open the gutter handle menu, click "Note". Assert (a) the block now has `data-block-type="note"`, (b) the inner html (excluding the block-level wrapper class) is byte-identical, (c) the locator `[data-block-id="${id}"] .mark-comment[data-comment-id="${commentId}"]` is still visible. Note: the comment popup should be closed by `handleConvertBlockType`'s `setOpenCommentId` call — assert popup absence too.
2. **Keyboard shortcut preserves caret.** Focus a txt block with content, place the caret at offset 5. Press `Ctrl+Shift+M`, type "o" to filter, Enter to select oli. Assert html preserved, caret position still at offset 5 (read via `pmGetSelection(page, blockId)` from `pm-helpers.js`).
3. **Stale-lint clears.** Type "shall" into a txt block (triggers TERM-shall compliance flag). Convert via shortcut to note. Assert the flag disappears within one render frame (no input/focus event required).
4. **TC mode on.** Convert a txt to note under TC. Assert the block carries the change marker (visible per existing TC block-level styling). Then accept — assert the block stays as note (audit-trail limitation per §4.4 is the intended behavior).

**Level-loss regression test (oli ↔ txt ↔ oli round-trip):** Create an oli block, change its level to 3 (Tab three times). Convert to txt via shortcut. Convert back to oli. Assert level is still 3 (NOT reset to 1).

### 6.4 Full suite gate

Per CLAUDE.md rule 10, before claiming "no regressions": run the full `editor.spec.js` and `collab.spec.js` under `--project=chromium`. Baseline the parallel-load flake set (issue [#126](https://github.com/mttvnst-HA/secwriter/issues/126), [#145](https://github.com/mttvnst-HA/secwriter/issues/145)) before and after. Any new failure surfaced by isolated re-run is a real regression; flakes are not.

## 7. Implementation order (preview — full plan via writing-plans skill)

1. Reducer + `levelDelta` + `composeRevision` + unit tests.
2. Wrapper-key drop + PmEditableBlock-convert-persist regression test.
3. App handler + plumbing (`onConvertBlockType` prop).
4. `BlockGutterMenu.jsx` + E2E scenario 1.
5. `ConvertBlockPalette.jsx` + keyboard shortcut wiring + E2E scenario 2.
6. TC-mode E2E scenario 3.
7. Full chromium suite verification.

## 8. Open questions

None blocking. Two minor decisions deferred to implementation:

- Exact icon set for the gutter handle (use existing SLASH_ITEMS icons or simpler dots-handle).
- Keyboard shortcut binding (`Ctrl+Shift+M` — verified no collision with `keymap.js`, the FloatingToolbar, or App.jsx's 8 existing Ctrl+shortcuts; macOS `Cmd+Shift+M` is not a system shortcut).

## 9. Pre-implementation greps

Cheap audits writing-plans should run before coding starts:

1. `grep -rn "block.type === 'lst'"` across `src/lib/` and `src/App.jsx` — verify no structural dependency on `lst` blocks for submittal grouping in the render path. Submittal extraction happens in `src/lib/submittal-register.js`; confirm it's robust to a same-id `lst → txt` flip (which would remove the block from the submittal register, intended behavior).
2. `grep -rn "block.type ===" tests/` — find any test fixture that asserts the wrapper-key shape; update if found. None expected, but the audit is cheap.
3. `grep -rn "block\.section\b" src/` — verify no Family A consumer treats `section` differently per block type. (Family A blocks all carry `section` = parent title id; spread-preserve is correct, but cheap audit confirms.)
4. Inspect `#editor-area` (or whatever the editor surface element id is) padding-left value in `App.jsx` and any CSS. Confirm ≥ 32px to keep the gutter handle at `left: -22` on-screen.
