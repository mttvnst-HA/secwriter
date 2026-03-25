# 07 — Revision Controls

## What to test

Test the revision control panel below the toolbar: Show/Hide revisions,
Notes toggle, Unit Display dropdown, Accept All, Reject All.

## Steps

### 1. Setup: Enable TC and create some revisions
- Enable Track Changes
- Edit 3 different blocks (add text, delete text, modify text)
- Blur each block to generate revision marks

### 2. Test Hide Revisions
- Click "Revisions: Show" toggle → should change to "Hide"
- Verify: Revision marks (green/red) become invisible
- Verify: Text still shows current state (additions visible, deletions hidden)

### 3. Test Show Revisions
- Click "Revisions: Hide" toggle → should change to "Show"
- Verify: Revision marks reappear

### 4. Test Notes toggle
- Click "Notes: Show" toggle
- Verify: Designer note blocks become hidden
- Click again to show
- Verify: Notes reappear with amber border

### 5. Test Unit Display dropdown
- Find the unit display dropdown (Both/ENG only/MET only)
- Select "ENG only"
- Verify: MET content is hidden (if dual-unit marks exist in the document)
- Select "MET only"
- Verify: ENG content is hidden
- Select "Both"
- Verify: Both units visible again

### 6. Test Accept All
- Ensure there are pending revisions
- Click "Accept All" button
- Verify: Confirmation dialog or immediate acceptance
- Verify: All revision marks cleared, changes made permanent

### 7. Test Reject All
- Enable TC, create new revisions
- Click "Reject All" button
- Verify: All revisions reverted to original state

### 8. Disable Track Changes

## Pass criteria
- Show/Hide revisions toggles visibility correctly
- Notes toggle hides/shows note blocks
- Unit display filters ENG/MET content
- Accept All finalizes all pending changes
- Reject All reverts all pending changes
