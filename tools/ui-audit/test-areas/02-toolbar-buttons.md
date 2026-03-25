# 02 — Toolbar Buttons

## What to test

Click every button in the top toolbar and verify the expected behavior.

## Steps

### 1. Identify all toolbar buttons
- Action: `read_page` with `filter: "interactive"` focused on toolbar area
- Document: List every button with its label/title and ref_id

### 2. Test Import button
- Action: Click "Import .SEC file" button
- Verify: File dialog opens (or at minimum, no crash)
- Note: Cannot complete file selection in automated mode — just verify dialog trigger
- Action: Press Escape to dismiss

### 3. Test Save button (Ctrl+S)
- Action: Click "Save" button
- Verify: Status shows "Saved" or save indicator appears
- Check: Console for errors

### 4. Test Save As button
- Action: Click "Save As" button
- Verify: File dialog opens
- Action: Press Escape to dismiss

### 5. Test Word Export button
- Action: Click "Export as Word" button
- Verify: Download triggers or export dialog appears
- Check: Console for errors

### 6. Test Print button
- Action: Click "Print / Save as PDF" button
- Verify: Print dialog opens
- Action: Press Escape to dismiss

### 7. Test Submittals button
- Action: Click "Generate submittal register" button
- Verify: New tab/window opens with HTML report, or report panel appears
- Check: Report contains submittal data

### 8. Test Reference Wizard button (+ Ref)
- Action: Click "Add a reference" button
- Verify: RefWizard modal/panel opens with search inputs
- Action: Close/dismiss the wizard

### 9. Test Brackets button ([ ])
- Action: Click "Find and replace [bracketed]" button
- Verify: BracketReplace panel opens
- Verify: Bracketed placeholders are detected and listed
- Action: Click again to toggle off

### 10. Test Validate button
- Action: Click "Run document validation" button
- Verify: ValidationPanel opens with findings list
- Verify: Severity filter buttons visible
- Action: Click again to toggle off

### 11. Test Compliance button
- Action: Click "Check UFS 1-300-02 compliance" button
- Verify: CompliancePanel opens on right side
- Verify: Scope selector visible (Entire doc / Focused block)
- Action: Click again to toggle off

### 12. Test Lint toggle
- Action: Click "Enable/Disable inline linting" button
- Verify: Button text/icon changes (● ↔ ○)
- Action: Click again to toggle back
- Check: localStorage `sim-inline-linting` value changes

### 13. Test Tag Visibility toggle (</>)
- Action: Click "Show/Hide inline tags" button
- Verify: Tag indicators appear on blocks (cyan monospace text like `<TXT>`)
- Action: Take screenshot
- Action: Click again to hide tags
- Verify: Tags disappear

### 14. Test Dark Mode toggle
- Action: Click dark mode button (☀/☽)
- Verify: Background changes to dark, text to light
- Action: Take screenshot
- Action: Click again to restore light mode

### 15. Test Zoom buttons
- Action: Click zoom out (−)
- Verify: Editor content shrinks, zoom % decreases
- Action: Click zoom reset (100%)
- Verify: Zoom returns to 100%
- Action: Click zoom in (+)
- Verify: Editor content enlarges, zoom % increases
- Action: Click zoom reset again

### 16. Check Comments button visibility
- Verify: Comments button (💬) is hidden when no comments exist
- Note: Will test comment creation in area 04

### 17. Take final screenshot
- Action: `screenshot` with `save_to_disk: true`

## Pass criteria
- All buttons are clickable without crashes
- Toggles visibly change state
- Panels open/close correctly
- No console errors from button clicks
