# 04 — Floating Toolbar

## What to test

Select text in a block, verify the floating toolbar appears with all expected
buttons, and test each button's behavior.

## Steps

### 1. Select text in a text block
- Action: Click on a text block with content
- Action: Triple-click to select all text in the block (or Shift+click to select a range)
- Verify: Floating toolbar appears above/below the selection

### 2. Document toolbar buttons
- Action: `read_page` focused on the floating toolbar area
- Verify these buttons exist: B, I, U, Aa, RID, SRF, SUB, 💬

### 3. Test Bold (B)
- Select text, click B button
- Verify: Selected text becomes bold (`<b>` or `font-weight`)
- Select bold text, click B again
- Verify: Bold is removed (toggle behavior)

### 4. Test Italic (I)
- Select text, click I button
- Verify: Selected text becomes italic
- Toggle off, verify removal

### 5. Test Underline (U)
- Select text, click U button
- Verify: Selected text becomes underlined
- Toggle off, verify removal

### 6. Test Change Case (Aa)
- Select text "test text"
- Click Aa once — verify: "TEST TEXT" (uppercase)
- Click Aa again — verify: "test text" (lowercase)
- Click Aa again — verify: "Test Text" (title case)

### 7. Test RID mark
- Select a reference-like text (e.g., "ASTM C150")
- Click RID button
- Verify: Text gets magenta highlight (`mark-rid` class)
- Verify: Tag visibility shows `<RID>` wrappers when toggled

### 8. Test SRF mark
- Select section reference text
- Click SRF button
- Verify: Text gets purple highlight (`mark-srf` class)

### 9. Test SUB mark
- Select submittal text
- Click SUB button
- Verify: Text gets blue highlight (`mark-sub` class)

### 10. Test Comment (💬)
- Select text, click 💬 button
- Verify: Comment popup/dialog appears
- Type a comment: "Test comment from UI audit"
- Submit the comment
- Verify: Yellow highlight appears on selected text
- Verify: Comment thread shows in popup
- Verify: Toolbar Comments button (💬) now appears in main toolbar

### 11. Test floating toolbar on ref blocks
- Click on a reference block
- Select text within it
- Verify: Only the 💬 (comment) button appears (not B/I/U/marks)

### 12. Test floating toolbar dismissal
- Select text (toolbar appears)
- Click elsewhere in editor
- Verify: Toolbar disappears
- Select text again
- Press Escape
- Verify: Toolbar disappears

### 13. Check console for errors

## Pass criteria
- Toolbar appears on text selection
- All format buttons toggle correctly
- All mark buttons apply correct CSS classes
- Comment creation works end-to-end
- Toolbar respects block type (ref blocks get comment-only)
- Clean dismissal on blur/escape
