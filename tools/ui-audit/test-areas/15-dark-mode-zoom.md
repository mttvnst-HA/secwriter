# 15 — Dark Mode, Zoom & Tag Visibility

## What to test

Test visual toggles that affect the entire editor appearance.

## Steps

### 1. Test Dark Mode
- Click dark mode toggle (☀ → ☽)
- Verify: Background changes to dark color scheme
- Verify: Text is light-colored and readable
- Verify: Sidebar, toolbar, and editor all switch
- Take screenshot
- Click again to restore light mode
- Verify: Returns to light theme

### 2. Test Zoom In
- Note current zoom level (should be 100%)
- Click zoom in (+) button 3 times
- Verify: Content visibly larger
- Verify: Zoom percentage shows ~130%

### 3. Test Zoom Out
- Click zoom out (−) button 6 times
- Verify: Content visibly smaller
- Verify: Zoom percentage shows ~70%

### 4. Test Zoom Reset
- Click zoom reset (100%) button
- Verify: Returns to 100%

### 5. Test Keyboard Zoom
- Press Ctrl++ (zoom in)
- Verify: Zoom increases
- Press Ctrl+0 (reset)
- Verify: Returns to 100%
- Press Ctrl+- (zoom out)
- Verify: Zoom decreases
- Press Ctrl+0 again

### 6. Test Tag Visibility
- Click </> button
- Verify: Tags become visible on blocks (e.g., `<TXT>...</TXT>`, `<NTE>...`)
- Verify: Tags shown in cyan monospace (font-family: Consolas/SF Mono)
- Verify: Inline marks show their tags (e.g., `<RID>ASTM C150</RID>`)
- Take screenshot
- Click </> again
- Verify: Tags hidden

### 7. Test Dark Mode + Tags combination
- Enable dark mode
- Enable tag visibility
- Verify: Tags readable against dark background
- Take screenshot
- Disable both

## Pass criteria
- Dark mode fully themes all components
- Zoom scales content, displays correct percentage
- Keyboard zoom shortcuts work
- Tag visibility toggles cleanly
- Combinations work without visual glitches
