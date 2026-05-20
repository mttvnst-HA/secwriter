# Autonomous Browser Testing Prompt: Track Changes Functionality

## Overview

You are an autonomous testing agent. Your job is to test the Track Changes (TC) functionality of **SecWriter** (the web-based editor for UFGS `.SEC` files). The app runs at `http://localhost:5173` in Chrome.

Use the **`mcp__Claude_in_Chrome__*`** tool surface (e.g., `mcp__Claude_in_Chrome__navigate`, `mcp__Claude_in_Chrome__read_page`, `mcp__Claude_in_Chrome__find`, `mcp__Claude_in_Chrome__form_input`, `mcp__Claude_in_Chrome__javascript_tool`, `mcp__Claude_in_Chrome__get_page_text`) to interact with the running application UI. For each test, verify expected behavior visually (screenshots) and programmatically (DOM inspection). If a test fails, investigate the root cause in the source code, fix it, and re-run the test until it passes.

**Project location:** `C:\github\secwriter`
**Dev server:** `npm run dev` at `http://localhost:5173`

**Key source files (PM substrate, post-2026-05):**
- `src/components/PmEditableBlock.jsx` — ProseMirror `EditorView`-backed editable block. Mounts a PM view per block, binds to a Y.XmlFragment via `ySyncPlugin`, owns the `dispatchTransaction` intercept that drives per-keystroke TC.
- `src/lib/pm-tc-mark.js` — `rewriteForTrackChanges` rewriter. Wraps inserted text in `revisionAdd` and deleted text in `revisionDel` on every PM tr while TC is on. Also exports `TC_RESOLVE_META` (the sentinel that opts a resolve transaction out of the rewriter).
- `src/lib/pm-schema.js` — PM schema. `revisionAdd` / `revisionDel` / `revisionChg` marks serialize with per-author attribution: `<ins|del|span class="mark-{add|del|chg}" data-author-id="<id>" style="--author-color:<color>">`.
- `src/lib/pm-del-popup.js` — PM-side del-popup. `dispatchDelAction` accepts/rejects an existing del under the cursor.
- `src/lib/pm-toolbar.js` — Six PM-tr builders plus `dispatchToolbarVerb`, the FloatingToolbar's single dispatch surface.
- `src/lib/track-changes.js` — 70-LOC reducer over `{ enabled, publishSeq }`. The legacy snapshot-baseline approach is retired (sub-PR 1h).
- `src/lib/revisions.js` — `acceptAllRevisions` / `rejectAllRevisions` pure HTML mutators (used by the doc-wide gestures).
- `src/components/FloatingToolbar.jsx` — Selection toolbar with ADD/DEL mark buttons and accept/reject buttons.
- `src/components/RevisionControls.jsx` — TC toggle, Show Revisions, Accept All / Reject All.
- `src/App.jsx` — Editor shell. Owns `tcState`, the three TC handler closures (`handleBlockUpdate`, `handleBlockUpdateWithSync`, `handleBlockUpdatePmSync`), and the blocks reducer dispatcher.
- `src/styles/editor.css` — Revision mark CSS styles.
- `reference/section.ini` — Authoritative formatting rules (ALWAYS check this for colors/fonts).

**Authoritative style rules from `reference/section.ini`:**
- `[COLORS]` ADD=GREEN,WHITE → `#008000`, transparent background (default author color)
- `[COLORS]` DEL=LIGHTRED,WHITE → `#ff4444`, transparent background (default author color)
- `[FONTS]` ADD=Inherit,0,UNDERLINE,PERSIST → underlined text
- `[FONTS]` DEL=Inherit,0,STRIKEOUT,PERSIST → strikethrough text

Per-author attribution adds `style="--author-color:<color>"` to each mark span; the CSS resolves the actual color from that variable. The default unattributed mark resolves to the section.ini ADD/DEL palette.

**TC architecture in one line:** TC marks are applied **per-keystroke** via PM's `dispatchTransaction` intercept (sub-PR 1h, Q33). There is no snapshot baseline. Every PM tr while TC is enabled passes through `rewriteForTrackChanges`, which wraps inserted text in `revisionAdd` and converts plain deletes into `revisionDel`-marked ranges.

---

## Test Procedure

### Setup

1. Ensure the dev server is running at `http://localhost:5173`.
2. Navigate to the app in Chrome.
3. Fill in the name prompt if it appears (collab session requires an identity).
4. Verify the app loads with sample data (UFGS 31 00 00 EARTHWORK).
5. Take a screenshot to confirm initial state.

---

### TEST 1: Track Changes Toggle

**Steps:**
1. Locate the "Track Changes" button in the revision controls bar.
2. Verify initial state: TC is OFF (button inactive).
3. Click the "Track Changes" button.
4. Verify TC is ON (button active, bar background changes).
5. Click again to toggle OFF.
6. Verify TC is OFF again.

**Expected:** Toggle switches between on/off with visual feedback.

**DOM verification:** Inspect `window.__collab.yTc?.get('enabled')` — should reflect the current toggle state (in collab mode). Or check `tcState.enabled` via the React devtools.

---

### TEST 2: Inline Text Addition Tracking

**Steps:**
1. Enable Track Changes.
2. Click on any text block (PM `EditorView`-backed) in the editor to focus it.
3. Place the cursor at the end of a word.
4. Type some new words: " additional test content".
5. Click on a different block (or press Tab) to blur.
6. Take a screenshot.

**Expected:**
- The newly typed text appears in green with underline.
- The text is wrapped in `<ins class="mark-add" data-author-id="..." style="--author-color:...">` elements in the DOM (the inner HTML, serialized from the PM `revisionAdd` mark).
- The original text remains unchanged.

**DOM verification:**
```js
const adds = document.querySelectorAll('ins.mark-add');
adds.length > 0 && adds[0].hasAttribute('data-author-id')
```

Check computed style: `color` should resolve to a green (default `rgb(0, 128, 0)` for the unattributed/default author, or the configured `--author-color`). `text-decoration-line` should include `underline`.

**Failure investigation:** If new text is not green/underlined:
- Check `src/lib/pm-tc-mark.js` `rewriteForTrackChanges` — is it being invoked from `PmEditableBlock.dispatchTransaction`?
- Check that the PM schema's `revisionAdd` mark serializes to `<ins class="mark-add">` (see `makeRevisionMarkSpec` in `src/lib/pm-schema.js`).
- Check `src/styles/editor.css` — does `ins.mark-add` have correct styles?
- Check that `tcState.enabled === true` in App.

---

### TEST 3: Inline Text Deletion Tracking

**Steps:**
1. Ensure Track Changes is ON.
2. Click on a text block with existing content.
3. Select a word by double-clicking it.
4. Press Delete or Backspace.
5. Blur the block.
6. Take a screenshot.

**Expected:**
- The deleted text reappears in red with strikethrough.
- The text is wrapped in `<del class="mark-del" data-author-id="..." style="--author-color:...">` elements.
- The `<del>` element has `contenteditable="false"` (prevents caret entry in the legacy DOM mirror; in PM the del mark is non-editable by schema, so this is enforced upstream).
- The remaining text is unchanged.

**DOM verification:**
```js
const dels = document.querySelectorAll('del.mark-del');
dels.length > 0
```

Computed: `color` resolves to red, `text-decoration-line` includes `line-through`.

**Failure investigation:** If deleted text doesn't show as red strikethrough:
- Check `rewriteForTrackChanges` in `src/lib/pm-tc-mark.js` — does `collectDeleteSegments` correctly identify the range and emit a `revisionDel`-marked replacement?
- Check the PM schema's `revisionDel` mark serializer in `src/lib/pm-schema.js`.
- Check CSS for `del.mark-del` styles.

---

### TEST 4: Caret Does Not Enter Del Elements

**Steps:**
1. Ensure TC is ON.
2. Create a deletion (as in TEST 3) so red strikethrough text exists.
3. Click directly on the red strikethrough text.
4. Try to place the cursor inside the red text.
5. Type some characters.

**Expected:**
- The cursor does not enter the red strikethrough text.
- New typed text appears in the normal addition style (green underlined when TC is on), NOT inside the del.

**DOM verification:** No new text nodes inside `del.mark-del` elements after typing.

**Failure investigation:** Check the `revisionDel` mark's PM schema spec — it should be non-spanning across cursor navigation. Check the `del.mark-del` CSS (`user-select: none`, `cursor: default`).

---

### TEST 5: Cumulative Edits in Same Block

**Steps:**
1. Ensure TC is ON.
2. Click on a text block, type some new text, blur. Verify green addition.
3. Click the SAME block again.
4. Type more text in a different location within the same block.
5. Blur again.
6. Take a screenshot.

**Expected:**
- Both addition runs appear as green underlined.
- Previously marked additions remain correctly marked.
- Per-keystroke TC means every typed character is wrapped on insert; cumulative edits compose trivially.

**DOM verification:** Count `ins.mark-add` elements — at least 2 separate runs if text was added in different positions.

**Failure investigation:** If previous annotations are lost, the `revisionAdd` mark's `inclusive: false` or stickiness in `pm-schema.js` may be miscoded. The rewriter should never strip marks it didn't author.

---

### TEST 6: Floating Toolbar ADD/DEL Manual Marks

**Steps:**
1. Enable Track Changes.
2. Click on a text block.
3. Select some text by click-dragging across several words.
4. The FloatingToolbar appears above the selection.
5. Verify the toolbar shows ADD and DEL buttons (green and red) when TC is enabled.
6. Click "ADD". Verify the selected text is wrapped in `<ins class="mark-add">`.
7. Select different text, click "DEL". Verify it is wrapped in `<del class="mark-del">`.

**Expected:**
- FloatingToolbar appears when text is selected inside a PM block.
- ADD/DEL buttons only appear when Track Changes is enabled.
- Clicking ADD or DEL dispatches the `applyRevisionApplyTr` PM tr-builder through `dispatchToolbarVerb` (see `src/lib/pm-toolbar.js`).
- Colors match section.ini (green ADD, red DEL).

**DOM verification:**
```js
const ins = document.querySelector('ins.mark-add');
ins !== null
```

**Failure investigation:** If toolbar doesn't show ADD/DEL:
- Check `FloatingToolbar.jsx` — `trackChanges` prop must be truthy.
- Check that `dispatchToolbarVerb` is invoked with the `revision-apply` verb and the verb's `settlement: 'self'` path runs `flushPendingUpdateById` after the PM dispatch.

---

### TEST 7: Inline Accept/Reject from Floating Toolbar

**Steps:**
1. Have tracked changes visible (green additions and/or red deletions).
2. Place a collapsed cursor inside an `<ins class="mark-add">` element.
3. Select the green text.
4. The FloatingToolbar shows ✓ (accept) and ✗ (reject) buttons.
5. Click ✓ (accept). The green underline disappears; the text remains as normal content.
6. Create another addition, select it, click ✗ (reject). The text is removed entirely.
7. For deletions: select red strikethrough text, click ✓ (accept) — text removed; click ✗ (reject) — text restored to normal.

**Expected:**
- Accept addition: strip the `revisionAdd` mark, keep content as normal text.
- Reject addition: remove the marked text entirely.
- Accept deletion: remove the marked text entirely.
- Reject deletion: strip the `revisionDel` mark, restore content as normal text.

**DOM verification:** After accepting an addition, `document.querySelectorAll('ins.mark-add').length` decreases by one.

**Failure investigation:**
- The accept/reject path goes through `applyInlineRevisionResolveTr` in `src/lib/pm-toolbar.js`.
- Settlement is `'caller-owned'` — `dispatchToolbarVerb` calls `cancelPendingUpdateById` and the caller (FloatingToolbar) settles React state via `onRefreshTcSnapshot(blockId, extractHtml(state))`. A late `handleBlockUpdate` from the 400ms debounce would clobber the just-settled snapshot, so cancel-not-flush is structural.

---

### TEST 8: Show/Hide Revisions Toggle

**Steps:**
1. Have tracked changes visible.
2. Locate the "Revisions" button.
3. Click "Revisions" to toggle the visibility OFF.
4. Take a screenshot.

**Expected when hidden:**
- `ins.mark-add` content displays as normal text (no underline, inherits color).
- `del.mark-del` content is completely hidden (`display: none`).
- Block-level revision indicators (colored left borders) are hidden.
- The "Revisions" button shows inactive state.

5. Click "Revisions" again. Verify all marks reappear.

**DOM verification:**
```js
document.querySelector('.revisions-hidden') !== null;
const del = document.querySelector('del.mark-del');
if (del) getComputedStyle(del).display === 'none';
```

**Failure investigation:** Check `editor.css` `.revisions-hidden` rules. Check `App.jsx` for the `revisions-hidden` class toggle on the editor container.

---

### TEST 9: Accept All / Reject All

**Steps:**
1. Create multiple tracked changes across several blocks (additions and deletions).
2. Verify "Accept All" (green) and "Reject All" (red) buttons appear in the revision controls bar.
3. Verify the stats display shows counts (e.g., "3 additions, 2 deletions").
4. Click "Accept All".
5. Take a screenshot.

**Expected after Accept All:**
- All `<ins>` are unwrapped (content kept as normal text).
- All `<del>` are removed entirely (content gone).
- All block-level `revision` properties are cleared.
- The Accept All / Reject All buttons disappear.

6. Reload the page (or use Ctrl+Z if undo is available across the boundary), recreate tracked changes, and repeat with "Reject All".

**Expected after Reject All:**
- All `<ins>` are removed with their content.
- All `<del>` are unwrapped (content restored).
- All block-level `revision` properties are cleared.

**DOM verification:**
```js
document.querySelectorAll('ins.mark-add').length === 0 &&
  document.querySelectorAll('del.mark-del').length === 0
```

**Failure investigation:**
- `handleAcceptAll` / `handleRejectAll` in `App.jsx` MUST call `flushAllPendingUpdates()` from `src/lib/block-registry.js` BEFORE reading `blocksRef.current`. Without it, a sub-debounce click runs against pre-debounce HTML — the PM substrate has the just-typed `revisionAdd`/`revisionDel` marks but React state does not, so `acceptAllRevisions` strips nothing.
- The N `setBlockHtml` writes are wrapped in `framing.withUndoFrame(() => { … })` so they form one Yjs undo frame.
- See `acceptAllRevisions` / `rejectAllRevisions` in `src/lib/revisions.js`.

---

### TEST 10: Block-Level Revision Gutter Buttons

**Steps:**
1. Load the sample data which includes block-level revision marks (blocks with `revision: "add"`, `revision: "del"`, `revision: "chg"`).
2. Look for blocks with colored left borders.
3. Hover over a block with a revision mark.
4. Look for small ✓ (accept) and ✗ (reject) buttons in the left gutter.
5. Click ✓ on an ADD block.

**Expected:**
- ADD block: Accept clears the `revision` property; block stays. Reject removes the block entirely.
- DEL block: Accept removes the block entirely. Reject clears the `revision` property; block stays.
- CHG block: Accept clears the property; block stays.

**DOM verification:** The PM block wrapper carries a `data-revision` attribute or class corresponding to the block-level revision. After accepting an ADD, that attribute/class disappears.

**Failure investigation:** Check `PmEditableBlock.jsx`'s block-level revision rendering. Check App.jsx `handleAcceptRevision` and `handleRejectRevision` — these dispatch through the blocks reducer (`revisionAcceptBlock` / `revisionRejectBlock` verbs in `src/lib/blocks.js`).

---

### TEST 11: TC Toggle Off Then On — Per-Keystroke Semantics

**Steps:**
1. Enable TC.
2. Edit a block — type some text, blur. Verify green marks appear on the just-typed text.
3. Turn TC OFF.
4. Verify: existing green marks remain visible (they live in the HTML; toggling off doesn't strip them), but NEW edits are not tracked.
5. Edit the same block — type more text, blur. Verify NO new green marks appear on the just-typed text. Previous marks remain.
6. Turn TC back ON.
7. Edit the block again — type more text, blur.
8. Verify: only the text typed in step 7 is marked green. Text from step 5 (typed while TC was off) is normal. Text from step 2 (typed while TC was on, then off, then back on) is still marked green.

**Expected:**
- Marks are produced or not produced per keystroke based on the current TC state at the moment of the keystroke.
- There is no snapshot baseline. The rewriter in `dispatchTransaction` reads `tcState.enabled` per tr; when false, the tr passes through untouched.

**DOM verification:** After step 7, count `ins.mark-add` elements in the block — should equal (step 2 runs) + (step 7 run), with no marks on step 5 text.

**Failure investigation:**
- Check that `PmEditableBlock.dispatchTransaction` gates the `rewriteForTrackChanges` call on `tcState.enabled`.
- Check that the `track-changes.js` reducer's `enable` / `disable` verbs only flip `state.enabled` and do not touch HTML.

---

### TEST 12: Export with Track Changes

**Steps:**
1. Enable TC, make some edits (additions and deletions).
2. Click the "Export" button in the toolbar.
3. The browser downloads a `.SEC` file.
4. Read the downloaded file content.

**Expected:**
- `<ins class="mark-add">` → serialized as `<ADD>text</ADD>` in the SEC SGML.
- `<del class="mark-del">` → serialized as `<DEL>text</DEL>`.
- Block-level revisions (`revision: "add"` etc.) → wrapped in `<ADD>...</ADD>` / `<DEL>...</DEL>` / `<CHG>...</CHG>`.
- Per-author attribution (`data-author-id`, `--author-color`) is stripped from the SGML output.

**Verification:** Read the exported file and check for `<ADD>` and `<DEL>` tags.

**Failure investigation:** Check `sec-serializer.js` `htmlToSgml()` — it maps `<ins>` → `<ADD>` and `<del>` → `<DEL>`. Check `revWrap()` for block-level wrapping.

---

### TEST 13: Color Compliance with section.ini

**Steps:**
1. Create tracked changes (both additions and deletions).
2. Inspect computed styles to verify colors.

**Expected colors:**
- ADD text: green (default `rgb(0, 128, 0)` per `[COLORS] ADD=GREEN` in section.ini, OR the configured per-author color via `--author-color`).
- DEL text: red (default `rgb(255, 68, 68)` per `[COLORS] DEL=LIGHTRED`, OR per-author).
- Both: transparent background.
- Accept buttons: green. Reject buttons: red.

**DOM verification:**
```js
const ins = document.querySelector('ins.mark-add');
const insStyle = getComputedStyle(ins);
console.log('ADD color:', insStyle.color);
console.log('ADD text-decoration:', insStyle.textDecorationLine); // includes "underline"
console.log('ADD background:', insStyle.backgroundColor); // transparent
console.log('ADD --author-color:', insStyle.getPropertyValue('--author-color'));

const del = document.querySelector('del.mark-del');
const delStyle = getComputedStyle(del);
console.log('DEL color:', delStyle.color);
console.log('DEL text-decoration:', delStyle.textDecorationLine); // includes "line-through"
```

**Failure investigation:** Cross-reference `src/styles/editor.css` with `reference/section.ini [COLORS]` and `[FONTS]`. If `--author-color` is defined, the CSS should resolve `color: var(--author-color, <default>)`. Fix any palette mismatches.

---

### TEST 14: Mixed Edits — Add and Delete in Same Block

**Steps:**
1. Enable TC.
2. Click on a text block with several words.
3. Delete one word (select + backspace).
4. Type a new word elsewhere in the same block.
5. Blur.
6. Take a screenshot.

**Expected:**
- Deleted word: red strikethrough (`del.mark-del`).
- Added word: green underlined (`ins.mark-add`).
- Unchanged text: normal.
- All three states coexist correctly in the same block.

**DOM verification:**
```js
const block = document.querySelector('[data-block-id] .ProseMirror');
const hasIns = block.querySelector('ins.mark-add') !== null;
const hasDel = block.querySelector('del.mark-del') !== null;
hasIns && hasDel
```

---

### TEST 15: Track Changes on New Blocks

**Steps:**
1. Enable TC.
2. Click on a text block and press Enter to create a new block.
3. Type content in the new block: "This is a new paragraph".
4. Blur.
5. Take a screenshot.

**Expected:**
- The entire text of the new block is marked as an addition (green underlined).
- The block-level `revision: "add"` may also be set (depending on TC verb in `src/lib/blocks.js`'s `createBlockAfter` selector — the reducer takes `tcState` explicitly to decide this).

**Failure investigation:** Check `createBlockAfter` in `src/lib/blocks.js` and `tc.revisionFlagForCreate` selector in `src/lib/track-changes.js`. Per-keystroke marking handles the typed content; the block-level flag is set by the verb at creation.

---

### TEST 16: Del-Popup (PM-Owned) Accept/Reject

**Steps:**
1. With existing deletions visible, click on a `<del class="mark-del">` element.
2. A popup appears with Accept and Reject options.
3. Click Accept. The del is removed from the document (the deletion is finalized).
4. Repeat with another del, click Reject. The del mark is stripped; original text is restored.

**Expected:**
- The popup is rendered by `PmEditableBlock`'s `handleClick` and dispatches through `applyDelAction` in `src/lib/pm-del-popup.js`.
- The dispatched tr carries `TC_RESOLVE_META` so the `rewriteForTrackChanges` rewriter does NOT re-apply revisionDel to the just-resolved range (see `src/lib/pm-tc-mark.js` and the regression test `src/components/__tests__/PmEditableBlock-tc-resolve.test.jsx`).
- Settlement: the PM substrate has already been updated by `ySyncPlugin`; the React `blocks` array is settled via `onRefreshTcSnapshot(blockId, html)` calling `handleBlockUpdatePmSync`.

**DOM verification:** After accepting one del, `document.querySelectorAll('del.mark-del').length` decreases by one and the deleted text is gone.

**Failure investigation:** If accept-del under TC re-marks the just-resolved range as a deletion (the symptom that motivated TC_RESOLVE_META), check that `dispatchDelAction` is setting `tr.setMeta(TC_RESOLVE_META, true)` and that `dispatchTransaction` reads it and skips `rewriteForTrackChanges`.

---

## General Test Execution Strategy

1. **Start each test fresh** — if previous state may interfere, reload the page.
2. **Take screenshots** at key verification points.
3. **Use `mcp__Claude_in_Chrome__javascript_tool`** to inspect DOM state programmatically when visual verification is insufficient.
4. **Log results** — for each test, report PASS or FAIL with details.
5. **On failure:**
   1. Take a screenshot.
   2. Inspect DOM state via `read_page` or `javascript_tool`.
   3. Read the relevant source file(s).
   4. Fix the code using the Edit tool.
   5. Wait for Vite hot-reload.
   6. Re-run the failed test.
   7. Repeat until it passes.
6. **After all tests pass**, run the full test suite to ensure no regressions:
   - `npm test` (Vitest)
   - `npm run test:compliance` (Node runner — compliance rules)
   - `npm run test:e2e` (Playwright — `editor.spec.js` 141 tests + `collab.spec.js` 11 tests under `--project=chromium`)
   - Note baseline failures documented in [`docs/superpowers/notes/1i-a-pm-failures.md`](../docs/superpowers/notes/1i-a-pm-failures.md) and [issue #114](https://github.com/mttvnst-HA/secwriter/issues/114) — distinguish regressions from known flakes via isolated re-run.
7. **Report final summary** with pass/fail counts and any fixes applied.

## Success Criteria

All 16 tests must PASS. Code fixes must not break existing tests. Colors must match `reference/section.ini` authoritative values (default palette OR the per-author `--author-color` when set).
