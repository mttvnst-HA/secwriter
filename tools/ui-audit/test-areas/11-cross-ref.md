# 11 — Cross-Reference Validation Panel

## What to test

Open the cross-reference panel, verify RID/SRF validation, test orphan removal.

## Steps

### 1. Open Cross-Ref Panel
- Find and click cross-reference validation button (may be in toolbar or submenu)
- Verify: Panel opens showing unlinked citations, self-references, orphaned references

### 2. Check unlinked citations
- Verify: Any RID marks in body without matching REF entries are listed
- Verify: Count is shown

### 3. Check orphaned references
- Verify: Any REF entries not cited in the body are listed
- If orphaned refs exist:
  - Click "Remove" on one entry
  - Verify: Entry is removed from the REF block
  - Verify: Orphan count decreases

### 4. Test Remove All Orphaned
- If multiple orphaned refs exist:
  - Click "Remove All Orphaned"
  - Verify: All orphaned entries removed

### 5. Close panel

## Pass criteria
- Panel shows correct categorization of reference issues
- Remove individual orphan works
- Remove All works
- Counts update after removal
