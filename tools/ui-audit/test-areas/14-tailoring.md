# 14 — Tailoring Profile

## What to test

Toggle the tailoring profile, select branch/region/delivery, verify content changes.

## Steps

### 1. Find tailoring controls
- Locate the TailoringProfile section (below revision controls)
- Verify: Active toggle, Branch/Region/Delivery dropdowns visible

### 2. Enable tailoring
- Click Active toggle to ON
- Verify: Dropdowns become interactive

### 3. Select a branch
- Select "Navy" from Branch dropdown
- Verify: Selection registers, Region dropdown updates with Navy-specific options

### 4. Select a region
- Select a region from the dropdown
- Verify: Selection registers

### 5. Select delivery method
- Select a delivery method
- Verify: Content in editor may change (TAI-marked blocks show/hide based on OPT matching)

### 6. Toggle Show All
- Click "Show All" toggle
- Verify: All TAI content visible regardless of profile match

### 7. Disable tailoring
- Click Active toggle to OFF
- Verify: All TAI content returns to default visibility

## Pass criteria
- Toggle enables/disables correctly
- Dropdowns populate with correct options
- Content visibility changes based on selections
- Show All overrides filtering
