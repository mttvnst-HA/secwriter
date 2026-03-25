# 03 — Slash Menu (Block Type Creation)

## What to test

Type `/` in a block to open the slash menu, then create one block of each type.

## Steps

### 1. Focus an existing text block
- Action: Click on any text block in the editor
- Verify: Block receives focus ring

### 2. Create a new empty block
- Action: Press Enter to create a new block
- Verify: New empty block appears below, cursor is in it

### 3. Open slash menu
- Action: Type `/`
- Verify: Dropdown menu appears with 9 options
- Action: Take screenshot of slash menu

### 4. Test each block type creation

For each type, starting from a fresh empty block (Enter to create):

#### 4a. Heading (`title`)
- Type `/`, then click "Heading" or type `h` + Enter
- Verify: Block converts to a title block with section numbering
- Type: "Test Heading"
- Verify: Text appears, section number prefix visible

#### 4b. Paragraph (`txt`)
- Create new block, type `/`, select "Paragraph"
- Verify: Block is a plain text paragraph
- Type: "Test paragraph text"

#### 4c. Designer Note (`note`)
- Create new block, type `/`, select "Designer Note"
- Verify: Block has amber/yellow left border styling
- Type: "Test designer note"

#### 4d. Ordered List (`oli`)
- Create new block, type `/`, select "Ordered List"
- Verify: Block shows letter label (a.)
- Type: "First list item"
- Press Enter — verify next item gets label (b.)

#### 4e. List Item (`item`)
- Create new block, type `/`, select "List Item"
- Verify: Block shows bullet marker
- Type: "Bulleted item"

#### 4f. List Header (`lst`)
- Create new block, type `/`, select "List Header"
- Verify: Block renders as list header style
- Type: "SD-01 Materials"

#### 4g. Reference (`ref`)
- Create new block, type `/`, select "Reference"
- Verify: Structured reference block appears with ORG field
- Verify: Edit controls visible

#### 4h. Table (`table`)
- Create new block, type `/`, select "Table"
- Verify: Table block appears with at least 2x2 grid
- Verify: Cell editing works (double-click a cell)

#### 4i. Page Break (`pagebreak`)
- Create new block, type `/`, select "Page Break"
- Verify: Horizontal line/separator appears
- Verify: Block is not editable (read-only divider)

### 5. Verify slash menu keyboard navigation
- Create new block, type `/`
- Press ArrowDown 3 times
- Press Enter
- Verify: The 4th item in the menu was selected and applied

### 6. Verify slash menu filtering
- Create new block, type `/tab`
- Verify: Menu filters to show "Table" option
- Press Escape to dismiss

### 7. Check console for errors
- Action: `read_console_messages` with `onlyErrors: true`

## Pass criteria
- All 9 block types can be created via slash menu
- Each type renders with correct visual style
- Keyboard navigation works in the menu
- Type filtering narrows results
- No console errors during creation
