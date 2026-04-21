# Autonomous Browser Testing Prompt: Track Changes Functionality

## Overview

You are an autonomous testing agent. Your job is to test the Track Changes (TC) functionality of SpecsIntact Modern (SIM), a web-based rich text editor for UFGS .SEC specification files. The app runs at `http://localhost:5173` in Chrome.

Use the Chrome browser automation MCP tools (`tabs_context_mcp`, `navigate`, `computer`, `read_page`, `find`, `form_input`, `javascript_tool`, `get_page_text`) to interact with the running application UI. For each test, verify expected behavior visually (screenshots) and programmatically (DOM inspection). If a test fails, investigate the root cause in the source code, fix it, and re-run the test until it passes.

**Project location:** `C:\github\secwriter`
**Dev server:** `npm run dev` at `http://localhost:5173`
**Key source files:**
- `src/lib/text-diff.js` — Word-level LCS diff + DOM annotation
- `src/components/EditableBlock.jsx` — contentEditable block with TC integration
- `src/components/FloatingToolbar.jsx` — Selection toolbar with ADD/DEL mark buttons
- `src/components/RevisionControls.jsx` — TC toggle, Show Revisions, Accept/Reject All
- `src/App.jsx` — Main editor, snapshot state management
- `src/styles/editor.css` — Revision mark CSS styles
- `src/lib/revisions.js` — Accept/reject logic
- `reference/section.ini` — Authoritative formatting rules (ALWAYS check this for colors/fonts)

**Authoritative style rules from `reference/section.ini`:**
- `[COLORS]` ADD=GREEN,WHITE → `#008000`, transparent background
- `[COLORS]` DEL=LIGHTRED,WHITE → `#ff4444`, transparent background
- `[FONTS]` ADD=Inherit,0,UNDERLINE,PERSIST → green underlined text
- `[FONTS]` DEL=Inherit,0,STRIKEOUT,PERSIST → red strikethrough text

---

## Test Procedure

### Setup

1. Ensure the dev server is running at `http://localhost:5173`
2. Navigate to the app in Chrome
3. Verify the app loads with sample data (UFGS 31 00 00 EARTHWORK)
4. Take a screenshot to confirm initial state

---

### TEST 1: Track Changes Toggle

**Steps:**
1. Locate the "Track Changes" button in the toolbar bar (below the main toolbar, above the editor). It should be a small button with text "Track Changes".
2. Verify initial state: TC is OFF (button should be gray/inactive, background bar should be neutral).
3. Click the "Track Changes" button.
4. Verify TC is ON: button turns blue (#2563eb), bar background changes to light blue (#eff6ff).
5. Click again to toggle OFF.
6. Verify TC is OFF again.

**Expected:** Toggle switches between on/off states with visual feedback.

**DOM verification:** After enabling TC, check that the button's background color changes. Use `javascript_tool` to inspect:
```js
document.querySelector('button').style.backgroundColor
```
Or use `find` to locate the Track Changes button and inspect its state.

---

### TEST 2: Inline Text Addition Tracking

**Steps:**
1. Enable Track Changes (click the TC button).
2. Click on any text block in the editor to focus it (e.g., click on a paragraph of text in Part 1).
3. Place the cursor at the end of the text by clicking at the end of a word.
4. Type some new words: " additional test content"
5. Click on a different block (or click elsewhere) to trigger blur/save.
6. Take a screenshot.

**Expected:**
- The newly typed text should appear in **green with underline** (`color: #008000; text-decoration: underline`).
- The text should be wrapped in `<ins class="mark-add">` elements in the DOM.
- The original text should remain unchanged (black, no decoration).

**DOM verification:**
```js
document.querySelectorAll('ins.mark-add').length > 0
```
Check that ins.mark-add elements exist and their computed style has `color: rgb(0, 128, 0)` and `text-decoration: underline`.

**Failure investigation:** If new text is not green/underlined:
- Check `src/lib/text-diff.js` `annotateDomWithDiff()` — is it being called on blur?
- Check `src/components/EditableBlock.jsx` `handleBlur` — does it call `annotateDomWithDiff` when `trackChanges && snapshotText != null`?
- Check `src/App.jsx` — are `tcSnapshots` being created when TC is enabled?
- Check `src/styles/editor.css` — does `ins.mark-add` have correct styles?

---

### TEST 3: Inline Text Deletion Tracking

**Steps:**
1. Ensure Track Changes is ON.
2. Click on a text block that has existing content.
3. Select a word or phrase by double-clicking it (or click-drag to select).
4. Press Delete or Backspace to remove the selected text.
5. Click elsewhere to blur.
6. Take a screenshot.

**Expected:**
- The deleted text should reappear in **red with strikethrough** (`color: #ff4444; text-decoration: line-through`).
- The deleted text should be wrapped in `<del class="mark-del">` elements.
- The `<del>` elements should have `contentEditable="false"` (prevents caret entry).
- The remaining text should be unchanged.

**DOM verification:**
```js
const dels = document.querySelectorAll('del.mark-del');
dels.length > 0 && dels[0].contentEditable === 'false'
```
Check computed styles: `color: rgb(255, 68, 68)`, `text-decoration: line-through`.

**Failure investigation:** If deleted text doesn't show as red strikethrough:
- Check `annotateDomWithDiff` — does it create `<del>` elements with `contentEditable = 'false'`?
- Check that `getVisibleText()` excludes `<del>` content correctly.
- Check CSS for `del.mark-del` styles.

---

### TEST 4: Caret Does Not Enter Del Elements

**Steps:**
1. Ensure TC is ON.
2. Create a deletion (as in TEST 3) so there's red strikethrough text.
3. Click directly on the red strikethrough text.
4. Try to place the cursor inside the red text by clicking on it.
5. Type some characters.

**Expected:**
- The cursor should NOT enter the red strikethrough text.
- New typed text should appear in the normal text color (or green if TC is on), NOT in red.
- The `<del>` element has `contentEditable="false"`, so the browser should not allow caret placement inside it.

**DOM verification:**
```js
// After typing near a del element, check that no new text nodes are inside del.mark-del
const dels = document.querySelectorAll('del.mark-del');
for (const d of dels) { if (d.contentEditable !== 'false') console.error('del missing contentEditable=false'); }
```

**Failure investigation:** If typed text inherits red styling:
- Check `annotateDomWithDiff` line where `delNode.contentEditable = 'false'` is set.
- Check CSS: `del.mark-del { cursor: default; user-select: none; }`.

---

### TEST 5: Cumulative Edits in Same Block

**Steps:**
1. Ensure TC is ON.
2. Click on a text block, add some text, blur to save (should show green additions).
3. Click the SAME block again.
4. Add more text in a different location within the same block.
5. Blur again.
6. Take a screenshot.

**Expected:**
- Both sets of added text should be green/underlined.
- Previously annotated additions should still be correctly marked.
- The diff algorithm should correctly handle re-diffing with existing annotations.

**DOM verification:** Count `ins.mark-add` elements — there should be at least 2 separate ones if text was added in different positions.

**Failure investigation:** If previous annotations are lost:
- Check `annotateDomWithDiff` steps: it should (1) get visible text BEFORE modifying DOM, (2) strip existing annotations, (3) re-diff from scratch.
- Check `getVisibleText()` — it should include `<ins>` text but exclude `<del>` text.

---

### TEST 6: Floating Toolbar ADD/DEL Manual Marks

**Steps:**
1. Enable Track Changes.
2. Click on a text block.
3. Select some text by click-dragging across several words.
4. The floating toolbar should appear above the selection (dark background popup).
5. Verify the toolbar shows ADD and DEL buttons (green and red pills) on the right side.
6. Click the "ADD" button.
7. Verify the selected text is now wrapped in `<ins class="mark-add">` with green underline.
8. Select different text, click "DEL" button.
9. Verify it's wrapped in `<del class="mark-del">` with red strikethrough.

**Expected:**
- Floating toolbar appears when text is selected inside an editable block.
- ADD/DEL buttons only appear when Track Changes is enabled.
- Clicking ADD wraps selection in `<ins class="mark-add">`.
- Clicking DEL wraps selection in `<del class="mark-del">`.
- Colors match .ini spec: ADD=#008000, DEL=#ff4444.

**DOM verification:**
```js
// After applying ADD mark
const ins = document.querySelector('ins.mark-add');
ins !== null && getComputedStyle(ins).color === 'rgb(0, 128, 0)'
```

**Failure investigation:** If toolbar doesn't show ADD/DEL:
- Check `FloatingToolbar.jsx` — `trackChanges` prop must be passed and truthy.
- Check that `REVISION_TYPES` array has correct entries.

---

### TEST 7: Inline Accept/Reject from Floating Toolbar

**Steps:**
1. Have some tracked changes visible (green additions and/or red deletions).
2. Click inside an `<ins class="mark-add">` element (green underlined text) to place cursor there.
3. Select the green text.
4. The floating toolbar should show ✓ (accept) and ✗ (reject) buttons.
5. Click ✓ (accept): the green underline should disappear, text becomes normal.
6. Create another addition, select it, click ✗ (reject): the text should be removed entirely.
7. For deletions: select red strikethrough text, click ✓ (accept): text is removed. Click ✗ (reject): text is restored to normal.

**Expected:**
- Accept addition: strip `<ins>` tag, keep content as normal text.
- Reject addition: remove `<ins>` and its content entirely.
- Accept deletion: remove `<del>` and its content entirely.
- Reject deletion: strip `<del>` tag, restore content as normal text.

**DOM verification:** After accepting an addition, there should be fewer `ins.mark-add` elements than before.

**Failure investigation:** Check `FloatingToolbar.jsx` `handleInlineRevisionAction()` method.

---

### TEST 8: Show/Hide Revisions Toggle

**Steps:**
1. Have some tracked changes visible (green additions, red deletions).
2. Locate the "Revisions" button (purple toggle next to Track Changes button).
3. Verify revisions are currently visible (green/red marks showing).
4. Click "Revisions" to toggle OFF.
5. Take a screenshot.

**Expected when hidden:**
- Added text (`ins.mark-add`): should display as normal text (inherit color, no underline).
- Deleted text (`del.mark-del`): should be completely hidden (`display: none`).
- Block-level revision indicators (colored left borders) should be hidden.
- The "Revisions" button should change to inactive state (gray).

6. Click "Revisions" again to toggle ON.
7. Verify all marks reappear.

**DOM verification:**
```js
// When hidden, check if the editor pane has 'revisions-hidden' class
document.querySelector('.revisions-hidden') !== null
// Check del is hidden
const del = document.querySelector('del.mark-del');
if (del) getComputedStyle(del).display === 'none'
```

**Failure investigation:** Check `editor.css` `.revisions-hidden` rules. Check `App.jsx` for the `revisions-hidden` class toggle on the editor container.

---

### TEST 9: Accept All / Reject All

**Steps:**
1. Create multiple tracked changes (add text in several blocks, delete text in others).
2. Verify the "Accept All" (green) and "Reject All" (red) buttons appear in the revision controls bar.
3. Verify the stats display shows counts (e.g., "3 additions, 2 deletions").
4. Click "Accept All".
5. Take a screenshot.

**Expected after Accept All:**
- All `<ins>` elements are unwrapped (content kept as normal text).
- All `<del>` elements are removed entirely.
- All block-level `revision` properties are cleared.
- The Accept All and Reject All buttons disappear (no remaining revisions).
- Stats display is gone.

6. Undo by reloading (Ctrl+R or navigate again) and repeat with "Reject All".

**Expected after Reject All:**
- All `<ins>` elements are removed with their content.
- All `<del>` elements are unwrapped (content restored).
- All block-level `revision` properties are cleared.

**DOM verification:**
```js
document.querySelectorAll('ins.mark-add').length === 0 && document.querySelectorAll('del.mark-del').length === 0
```

**Failure investigation:** Check `src/lib/revisions.js` `acceptAllRevisions()` and `rejectAllRevisions()`. Check App.jsx handlers `handleAcceptAll` and `handleRejectAll`.

---

### TEST 10: Block-Level Revision Gutter Buttons

**Steps:**
1. Load the sample data which has block-level revision marks (blocks with `revision: "add"`, `revision: "del"`, etc.).
2. Look for blocks with colored left borders:
   - Green border = ADD block
   - Red border = DEL block
   - Yellow border = CHG block
3. Hover over a block with a revision mark.
4. Look for small ✓ (accept) and ✗ (reject) buttons in the left gutter.
5. Click ✓ on an ADD block.

**Expected:**
- ADD block: Accept removes the `revision` property, block becomes normal. Reject removes the entire block.
- DEL block: Accept removes the entire block. Reject removes the `revision` property, block becomes normal.
- The gutter buttons have correct colors: ✓ is green (#008000), ✗ is red (#ff4444).

**DOM verification:**
```js
// Check for block-level revision classes
document.querySelectorAll('.block-revision-add').length
document.querySelectorAll('.block-revision-del').length
```

**Failure investigation:** Check `EditableBlock.jsx` gutter button rendering (lines ~290-338). Check App.jsx `handleAcceptRevision` and `handleRejectRevision`.

---

### TEST 11: TC Toggle Off and Back On — Snapshot Accuracy

**Steps:**
1. Enable TC.
2. Edit a block — add some text, blur. Verify green marks appear.
3. Turn TC OFF.
4. Verify: marks remain visible but no NEW changes are tracked.
5. Edit the same block — add more text, blur. Verify NO new marks appear.
6. Turn TC back ON.
7. The snapshot should be taken from the current visible state (including previously accepted additions but excluding deleted text).
8. Edit the block again — add more text, blur.
9. Verify: only the NEW additions (from step 8) are marked green. Previous accepted text is treated as baseline.

**Expected:**
- When TC is turned off then on again, new snapshots are created from `getVisibleTextFromHtml(block.html)`.
- `getVisibleTextFromHtml` strips `<del>` content and includes `<ins>` content — representing the "current accepted state."
- Only changes made AFTER re-enabling TC are tracked.

**DOM verification:** After step 9, count `ins.mark-add` elements — should only reflect step 8 additions, not step 2 additions (which are now part of baseline).

**Failure investigation:**
- Check App.jsx TC toggle handler — does it call `getVisibleTextFromHtml(b.html)` for snapshot creation?
- Check `text-diff.js` `getVisibleTextFromHtml()` — does it correctly strip `<del>` blocks?

---

### TEST 12: Export with Track Changes

**Steps:**
1. Enable TC, make some edits (additions and deletions).
2. Click the "Export" button in the toolbar.
3. The browser should download a .SEC file.
4. Read the downloaded file content.

**Expected:**
- `<ins class="mark-add">` → serialized as `<ADD>text</ADD>` in the SEC XML.
- `<del class="mark-del">` → serialized as `<DEL>text</DEL>` in the SEC XML.
- Block-level revisions: blocks with `revision: "add"` → wrapped in `<ADD>...</ADD>`.

**Verification:** Use the file system to read the exported file and check for `<ADD>` and `<DEL>` tags.

**Failure investigation:** Check `sec-serializer.js` `htmlToSgml()` function — it maps `<ins>` to `<ADD>` and `<del>` to `<DEL>`. Check `revWrap()` for block-level wrapping.

---

### TEST 13: Color Compliance with section.ini

**Steps:**
1. Create tracked changes (both additions and deletions).
2. Use DOM inspection to verify exact colors.

**Expected colors (from section.ini):**
- ADD text: `rgb(0, 128, 0)` (#008000 = GREEN) with underline
- DEL text: `rgb(255, 68, 68)` (#ff4444 = LIGHTRED) with line-through
- Both: transparent background (not tinted)
- Accept buttons: `rgb(0, 128, 0)`
- Reject buttons: `rgb(255, 68, 68)`

**DOM verification:**
```js
const ins = document.querySelector('ins.mark-add');
const insStyle = getComputedStyle(ins);
console.log('ADD color:', insStyle.color); // Should be rgb(0, 128, 0)
console.log('ADD text-decoration:', insStyle.textDecorationLine); // Should include underline
console.log('ADD background:', insStyle.backgroundColor); // Should be transparent/rgba(0,0,0,0)

const del = document.querySelector('del.mark-del');
const delStyle = getComputedStyle(del);
console.log('DEL color:', delStyle.color); // Should be rgb(255, 68, 68)
console.log('DEL text-decoration:', delStyle.textDecorationLine); // Should include line-through
console.log('DEL background:', delStyle.backgroundColor); // Should be transparent
```

**Failure investigation:** Cross-reference `src/styles/editor.css` with `reference/section.ini [COLORS]` and `[FONTS]` sections. Fix any mismatches.

---

### TEST 14: Mixed Edits — Add and Delete in Same Block

**Steps:**
1. Enable TC.
2. Click on a text block with several words.
3. Delete one word (select + backspace).
4. Add a new word somewhere else in the same block.
5. Blur.
6. Take a screenshot.

**Expected:**
- Deleted word appears as red strikethrough (`del.mark-del`).
- Added word appears as green underlined (`ins.mark-add`).
- Unchanged text remains normal.
- All three states coexist correctly in the same block.

**DOM verification:**
```js
const block = document.querySelector('[data-block-id][contenteditable="true"]');
const hasIns = block.querySelector('ins.mark-add') !== null;
const hasDel = block.querySelector('del.mark-del') !== null;
hasIns && hasDel // Both should be true
```

---

### TEST 15: Track Changes on New Blocks

**Steps:**
1. Enable TC.
2. Click on a text block and press Enter to create a new block.
3. Type content in the new block: "This is a new paragraph"
4. Blur.
5. Take a screenshot.

**Expected:**
- The entire text of the new block should be marked as an addition (green underlined).
- The new block's snapshot was empty string (since it was created after TC was enabled), so all text is "added."

**Failure investigation:** Check App.jsx — when a new block is created while TC is on, does it get a snapshot entry in `tcSnapshots`? An empty snapshot (`""`) should cause all typed text to be marked as additions.

---

## General Test Execution Strategy

1. **Start each test fresh** — if previous test state might interfere, reload the page.
2. **Take screenshots** at key verification points.
3. **Use `javascript_tool`** to inspect DOM state programmatically when visual verification is insufficient.
4. **Log results** — for each test, report PASS or FAIL with details.
5. **On failure:**
   a. Take a screenshot showing the failure.
   b. Use `read_page` or `javascript_tool` to inspect DOM state.
   c. Read the relevant source file(s) to identify the bug.
   d. Fix the code using the Edit tool.
   e. Wait for Vite hot-reload (a few seconds).
   f. Re-run the failed test.
   g. Repeat until the test passes.
6. **After all tests pass**, run `npm test` to ensure no unit test regressions.
7. **Report final summary** with pass/fail counts and any fixes applied.

## Success Criteria

All 15 tests must PASS. Any code fixes must not break existing tests (378 Vitest + 41 Node + 135 E2E = 554 total). Colors must match `reference/section.ini` authoritative values.
