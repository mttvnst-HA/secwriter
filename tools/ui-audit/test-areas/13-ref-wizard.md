# 13 — Reference Wizard

## What to test

Open the reference wizard, search for organizations and references, insert a reference.

## Steps

### 1. Open Reference Wizard
- Click "+ Ref" toolbar button
- Verify: Wizard modal/panel opens with search interface

### 2. Search for an organization
- Type "ASTM" in the organization search field
- Verify: Autocomplete shows matching orgs
- Select "ASTM" from results

### 3. Search for a reference ID
- Type "C150" in the RID search field
- Verify: Matching references shown
- Verify: Full title (RTL) visible in results

### 4. Insert a reference
- Select a reference from results
- Click Insert button
- Verify: Reference is added to the nearest REF block (or creates one)
- Verify: RID and RTL appear correctly formatted

### 5. Search for a different org
- Clear and search for "AASHTO"
- Verify: Results update to AASHTO references

### 6. Close wizard
- Click close/cancel
- Verify: Wizard dismisses cleanly

## Pass criteria
- Wizard opens with functional search
- Organization search filters correctly
- RID search shows matching references
- Insert adds the reference to the document
- No console errors
