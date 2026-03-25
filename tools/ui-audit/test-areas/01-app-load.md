# 01 — App Load & Layout

## What to test

Verify the app loads, renders the expected layout, and displays sample data.

## Steps

### 1. Navigate to app
- Action: `navigate` to `http://localhost:5173`
- Wait: 3 seconds for Vite HMR + React render
- Verify: Page title contains "SpecsIntact" or renders the editor

### 2. Check layout structure
- Action: `read_page` with `filter: "all"`, `depth: 3`
- Verify:
  - Sidebar exists (left panel with tree navigation)
  - Editor area exists (main content area with blocks)
  - Toolbar exists (top bar with buttons)
  - Status bar exists (bottom, shows "X blocks")

### 3. Check sidebar content
- Action: `read_page` focusing on sidebar area
- Verify:
  - Section number displayed (e.g., "UFGS 31 00 00")
  - Section title displayed (e.g., "EARTHWORK")
  - Tree nodes rendered (PART 1, PART 2, PART 3 headings)
  - Search input present

### 4. Check block rendering
- Action: `read_page` focusing on editor area
- Verify:
  - Multiple blocks visible
  - Title blocks show section numbers (1.1, 1.2, etc.)
  - Text blocks are present
  - Block count in status bar matches rendered blocks

### 5. Check for console errors on load
- Action: `read_console_messages` with `onlyErrors: true`
- Verify: No errors (or document any that appear)

### 6. Take baseline screenshot
- Action: `screenshot` with `save_to_disk: true`
- Save as: `test-results/screenshots/01-app-load-baseline.png`

## Pass criteria
- App renders without blank screen
- All three layout regions visible (sidebar, editor, toolbar)
- At least 10 blocks rendered
- No console errors
