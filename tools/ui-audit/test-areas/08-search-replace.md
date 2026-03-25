# 08 — Search & Replace

## What to test

Test the Ctrl+F find bar and Ctrl+H find-and-replace functionality.

## Steps

### 1. Open Find bar
- Press Ctrl+F
- Verify: Search bar appears at top of editor
- Verify: Input field is focused

### 2. Search for a common word
- Type "the" in search input
- Verify: Match count appears (e.g., "1 of 12")
- Verify: First match is highlighted/scrolled to in editor

### 3. Navigate matches
- Click Next (→) button
- Verify: Highlight moves to next match, counter updates (e.g., "2 of 12")
- Click Previous (←) button
- Verify: Returns to previous match

### 4. Close find bar
- Press Escape
- Verify: Search bar closes, highlights removed

### 5. Open Find & Replace
- Press Ctrl+H
- Verify: Search bar appears with BOTH find and replace inputs

### 6. Test Replace
- Type "the" in find input
- Type "THE" in replace input
- Click Replace button
- Verify: Current match is replaced
- Verify: Match counter updates

### 7. Test Replace All
- Type a unique-ish word in find input
- Type replacement in replace input
- Click Replace All
- Verify: All matches replaced at once
- Verify: Counter shows "0 of 0" or equivalent

### 8. Test empty search
- Clear the search input
- Verify: No matches shown, no errors

### 9. Close and verify
- Press Escape
- Verify: Bar closes cleanly

## Pass criteria
- Find bar opens/closes with keyboard shortcuts
- Search finds and highlights matches
- Match navigation works
- Replace and Replace All work correctly
- No console errors
