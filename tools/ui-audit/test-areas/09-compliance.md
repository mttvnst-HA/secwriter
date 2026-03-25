# 09 — Compliance Checker Panel

## What to test

Open the compliance panel, run a check, verify grouped findings render,
test fix preview and batch actions.

## Steps

### 1. Open Compliance Panel
- Click "Compliance" toolbar button
- Verify: Panel opens on right side of editor
- Verify: Scope selector visible ("Entire Document" / "Focused Block")

### 2. Run compliance check (entire document)
- Click "Entire Document" or equivalent scan button
- Verify: Progress indicator shows while scanning
- Verify: Results appear grouped by rule category
- Verify: Summary bar shows counts by severity

### 3. Expand a violation group
- Click on a violation group header
- Verify: Individual violations listed with context text
- Verify: Each violation shows the matching text highlighted

### 4. Click a violation to highlight in editor
- Click on a specific violation entry
- Verify: Editor scrolls to the block containing the violation
- Verify: Matching text gets yellow `.compliance-highlight` styling

### 5. Test fix preview
- Find a violation that has a fix available
- Verify: Before/after text shown in the finding
- Click Accept/Apply fix
- Verify: Text in editor updates to the fixed version

### 6. Test batch reject
- Expand a group with multiple findings
- Click "Dismiss" or batch reject
- Verify: Group is removed from results

### 7. Run focused-block check
- Click on a specific block in the editor
- Switch scope to "Focused Block"
- Run check
- Verify: Only violations from that block appear

### 8. Close panel
- Click Compliance button again (or close button)
- Verify: Panel closes, highlights removed from editor

## Pass criteria
- Panel opens/closes correctly
- Scan completes without errors
- Violations are grouped and expandable
- Click-to-navigate works
- Fix preview and apply work
- Scope selection (entire vs focused) works
