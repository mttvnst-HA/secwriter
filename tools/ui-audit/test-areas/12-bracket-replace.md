# 12 — Bracket Replacement Panel

## What to test

Open bracket replacement, verify detection, test replacement.

## Steps

### 1. Open Bracket Panel
- Click "[ ] Brackets" toolbar button
- Verify: Panel opens showing grouped bracketed placeholders

### 2. Check bracket detection
- Verify: All `[bracketed text]` patterns found in the document are listed
- Verify: Grouped by unique bracket text

### 3. Test replacement
- Enter replacement text for one group
- Click Replace or Apply
- Verify: All instances of that bracket text are replaced in the editor

### 4. Close panel

## Pass criteria
- Brackets are correctly detected and grouped
- Replacement applies to all instances
- Editor text updates in real time
