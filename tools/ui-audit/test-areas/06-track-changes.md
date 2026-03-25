# 06 — Track Changes

## What to test

Enable Track Changes, make edits, verify revision marks appear, test
accept/reject for both inline and block-level changes.

## Steps

### 1. Enable Track Changes
- Action: Find and click the "Track Changes" toggle button
- Verify: Button shows ON/active state
- Verify: Status or visual indicator shows TC is active

### 2. Type new text (addition)
- Focus a text block
- Type " additional text" at end of existing content
- Click away (blur the block to trigger diff)
- Verify: New text appears with green `<ins>` styling (mark-add)

### 3. Delete existing text (deletion)
- Focus a text block with content
- Select a word
- Press Delete or Backspace
- Click away
- Verify: Deleted text appears with red strikethrough `<del>` styling (mark-del)

### 4. Verify gutter buttons appear
- Look at the left edge of the edited blocks
- Verify: Accept (✓) and Reject (✗) gutter buttons visible

### 5. Test gutter Accept
- Click the ✓ gutter button on a block with additions
- Verify: Addition marks are removed, text becomes permanent
- Verify: Gutter buttons disappear from that block

### 6. Test gutter Reject
- Make another edit (type new text, blur)
- Click the ✗ gutter button
- Verify: Edit is reverted, text returns to original state

### 7. Test inline accept via floating toolbar
- Make an edit (type text, blur)
- Click on the green `<ins>` text
- Verify: Floating toolbar shows Accept (✓) and Reject (✗) buttons
- Click Accept
- Verify: Just that inline change is accepted

### 8. Test inline reject via floating toolbar
- Make another edit, blur
- Click on the revision mark
- Click Reject in floating toolbar
- Verify: That inline change is reverted

### 9. Test del element click popup
- Make an edit that creates a `<del>` element
- Click on the red strikethrough text
- Verify: Popup appears with Accept/Reject options
- Test Accept, verify deletion is finalized

### 10. Create a new block while TC is on
- Press Enter to create a new block
- Verify: New block has block-level revision mark (green left border or "add" indicator)

### 11. Delete a block while TC is on
- Focus an existing block, select all, delete
- Verify: Block is marked as deleted (red styling, not actually removed)

### 12. Disable Track Changes
- Click the TC toggle button
- Verify: Button shows OFF state
- Verify: Existing marks remain visible but no new tracking occurs

## Pass criteria
- TC toggle enables/disables correctly
- Additions get green `<ins>` marks
- Deletions get red `<del>` marks
- Gutter accept/reject works
- Inline accept/reject via floating toolbar works
- Del popup works
- Block-level revisions tracked
- No console errors throughout
