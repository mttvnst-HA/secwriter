# 10 — Document Validation Panel

## What to test

Open the validation panel and verify structural checks.

## Steps

### 1. Open Validation Panel
- Click "Validate" toolbar button
- Verify: Panel opens with list of validation findings

### 2. Check severity filters
- Verify: Filter buttons visible (Error, Warning, Info, or All)
- Click each filter
- Verify: Findings list filters correctly

### 3. Test click-to-navigate
- Click on a finding/issue in the list
- Verify: Editor scrolls to the referenced block
- Verify: Block gets visual focus indicator

### 4. Close panel
- Click Validate button again
- Verify: Panel closes

## Pass criteria
- Panel opens with validation results
- Severity filters work
- Click-to-navigate scrolls to correct block
