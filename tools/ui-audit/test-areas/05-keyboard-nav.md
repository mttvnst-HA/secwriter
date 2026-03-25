# 05 — Keyboard Navigation

## What to test

Test all keyboard shortcuts and navigation patterns.

## Steps

### 1. Arrow key navigation between blocks
- Focus a block in the middle of the document
- Press ArrowUp at the start of the block
- Verify: Focus moves to the previous block
- Press ArrowDown at the end of the block
- Verify: Focus moves to the next block

### 2. Enter key — new block creation
- Focus a text block
- Place cursor at end of text
- Press Enter
- Verify: New block of same type created below
- Verify: Cursor is in the new block

### 3. Enter in middle of text — block splitting
- Focus a text block with content "Hello World"
- Place cursor between "Hello" and "World"
- Press Enter
- Verify: Block splits into two blocks: "Hello" and "World"

### 4. Backspace on empty block — deletion
- Create a new empty block (Enter)
- Press Backspace
- Verify: Empty block is deleted
- Verify: Focus moves to the previous block

### 5. Tab on title block — demote
- Click on a title block (e.g., "1.1 REFERENCES")
- Press Tab
- Verify: Title depth increases (e.g., 1.1 → 1.1.1)
- Verify: Section number updates

### 6. Shift+Tab on title block — promote
- With the same title focused
- Press Shift+Tab
- Verify: Title depth decreases back

### 7. Ctrl+Z — Undo
- Type "test undo" in a block
- Press Ctrl+Z
- Verify: Text reverts to previous state

### 8. Ctrl+Y — Redo
- After undo, press Ctrl+Y
- Verify: Text comes back

### 9. Ctrl+S — Save
- Press Ctrl+S
- Verify: Save indicator appears in toolbar

### 10. Ctrl+F — Find
- Press Ctrl+F
- Verify: Search bar appears at top of editor
- Press Escape
- Verify: Search bar closes

### 11. Ctrl+H — Find and Replace
- Press Ctrl+H
- Verify: Search bar appears WITH replace input visible
- Press Escape

## Pass criteria
- Arrow navigation moves between blocks smoothly
- Enter creates/splits blocks correctly
- Backspace deletes empty blocks
- Tab/Shift+Tab adjusts title depth
- Undo/Redo works
- Ctrl shortcuts all trigger correct actions
