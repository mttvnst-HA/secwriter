# SIM ↔ SpecsIntact Legacy Interoperability Test

**Purpose:** Verify that .SEC files can round-trip between specsintact-modern (SIM) and legacy SpecsIntact/SIEditor without data loss or corruption.

**Prerequisites:**
- A Windows machine with legacy SpecsIntact (SIEditor) installed
- A browser running SIM (specsintact-modern) via `npm run dev`
- A reference .SEC file from the UFGS master set (e.g., `31_00_00.SEC` — EARTHWORK)
- A hex editor or diff tool that can compare binary files (e.g., HxD, Beyond Compare, or `fc /b` on Windows)

---

## Test 1: Import Legacy → Export SIM → Reopen in Legacy

**Goal:** A file authored in SpecsIntact can be opened in SIM, exported, and reopened in SIEditor without errors.

### Steps

1. Open `31_00_00.SEC` in **SIEditor**. Note:
   - Total number of PART sections
   - A few specific paragraph texts (copy 3–4 lines for comparison)
   - Any tables, notes, and list items present
   - The section number and title in the header
   - Close SIEditor.

2. Open SIM in a browser. Drag-and-drop `31_00_00.SEC` onto the editor (or use File → Import).

3. Visually verify:
   - [ ] Section number and title match the original
   - [ ] All PART headings appear in the sidebar tree
   - [ ] Inline marks (colored text for RID, SRF, SUB, ENG/MET) are visible
   - [ ] Tables render with correct row/column counts
   - [ ] Notes appear with the note styling

4. Export the file from SIM (File → Export / Save as .SEC). Save as `31_00_00_SIM.SEC`.

5. Open `31_00_00_SIM.SEC` in **SIEditor**.
   - [ ] **PASS:** File opens without errors or warnings
   - [ ] **PASS:** No "invalid tag" or "parse error" dialogs
   - [ ] Section number and title display correctly
   - [ ] PART structure matches original
   - [ ] Paragraph text matches original (spot-check 3–4 paragraphs)
   - [ ] Tables display with correct content
   - [ ] Notes display correctly
   - [ ] List items (OLI) display with correct labels

### Expected Failures (Known Differences)

SIM's serializer currently produces output that differs from legacy SpecsIntact in these ways. These are NOT interoperability failures — they are cosmetic differences that SIEditor should tolerate:

- **Line endings:** SIM outputs LF (`\n`); legacy uses CRLF (`\r\n`). SIEditor should handle both.
- **Header structure:** SIM produces a minimal header; legacy uses a table-based header with page-width columns. Content is preserved but layout may differ in SIEditor's print preview.
- **Whitespace normalization:** SIM collapses multi-line tag content to single lines. This is semantically equivalent.
- **MTA metadata:** SIM hardcodes `STATUS="NEW"` and `EDIT="TRUE"`. Legacy preserves original values.

If SIEditor rejects the file, record the exact error message — it likely points to one of these structural differences that needs fixing in the SIM serializer.

---

## Test 2: Author in SIM → Open in Legacy

**Goal:** A file created from scratch in SIM can be opened in SIEditor.

### Steps

1. In SIM, create a new section:
   - Set section number to `99 99 99`
   - Set title to `TEST INTEROP`
   - Add a PART 1 title: `GENERAL`
   - Add a TXT paragraph: `This is a test paragraph with mixed content.`
   - Add a note: `This note tests NTE grouping.`
   - Add 3 ordered list items (OLI): `First item`, `Second item`, `Third item`
   - Add a second PART 2 title: `PRODUCTS`
   - Add a TXT paragraph under PART 2

2. Export the file as `99_99_99.SEC`.

3. Open `99_99_99.SEC` in a **text editor** (Notepad++, VS Code):
   - [ ] First line is `<?xml version="1.0" encoding="windows-1252"?>`
   - [ ] File contains `<SEC` root element and `</SEC>` closing tag
   - [ ] Contains `<SCN` with `SECTION 99 99 99`
   - [ ] Contains `<STL>TEST INTEROP</STL>`
   - [ ] Contains two `<PRT>` elements
   - [ ] OLI items are wrapped in `<OLG>` group
   - [ ] Notes are wrapped in `<NTE>` with `<NPR>` children

4. Open `99_99_99.SEC` in **SIEditor**:
   - [ ] **PASS:** File opens without errors
   - [ ] Section number and title display correctly
   - [ ] Both PART sections visible
   - [ ] Paragraph text is correct
   - [ ] Note displays correctly
   - [ ] List items display with a. b. c. labels

---

## Test 3: Encoding Round-Trip (Windows-1252 Special Characters)

**Goal:** Characters outside ASCII that are valid in windows-1252 survive the round-trip.

### Steps

1. In **SIEditor**, open or create a section. Add a paragraph containing:
   ```
   Temperature range: 40°F–100°F (4°C–38°C)
   Per manufacturer's recommendations
   "Double quoted" and 'single quoted' text
   Cost: €500 • See note below…
   ™ registered product
   ```
   Save the file as `encoding_test.SEC`.

2. Open `encoding_test.SEC` in SIM via drag-and-drop.
   - [ ] Degree signs (°) display correctly
   - [ ] En-dash (–) displays correctly
   - [ ] Curly quotes (" " ' ') display correctly
   - [ ] Euro sign (€) displays correctly
   - [ ] Bullet (•) displays correctly
   - [ ] Ellipsis (…) displays correctly
   - [ ] Trademark (™) displays correctly
   - [ ] Straight apostrophe in "manufacturer's" displays correctly

3. Export from SIM as `encoding_test_SIM.SEC`.

4. Binary-compare the two files:
   ```cmd
   fc /b encoding_test.SEC encoding_test_SIM.SEC
   ```
   - [ ] The bytes for special characters (0x80–0x9F range and 0xA0–0xFF range) match between files
   - [ ] No UTF-8 multi-byte sequences (0xC2, 0xC3 lead bytes) appear in the SIM export

5. Open `encoding_test_SIM.SEC` in **SIEditor**:
   - [ ] **PASS:** All special characters display identically to the original
   - [ ] No replacement characters (?) or garbled text

---

## Test 4: Inline Marks Preservation

**Goal:** Data-driven inline marks (RID, SRF, SUB, ENG/MET) survive the round-trip.

### Steps

1. Open a reference file that contains inline marks (e.g., `31_00_00.SEC`) in SIM.

2. Locate and note at least one instance of each mark type:
   - [ ] RID (magenta) — e.g., `ASTM D2487`
   - [ ] SRF (if present) — section cross-reference
   - [ ] SUB (blue) — submittal item
   - [ ] ENG/MET pair (blue/red) — dual unit values

3. Export from SIM.

4. Open the exported file in a text editor and verify:
   - [ ] RID marks are wrapped in `<RID>...</RID>` tags
   - [ ] SRF marks are wrapped in `<SRF>...</SRF>` tags
   - [ ] SUB marks are wrapped in `<SUB>...</SUB>` tags
   - [ ] ENG/MET pairs are properly tagged
   - [ ] No leftover HTML (`<span class="mark-...">`) in the output

5. Open the exported file in **SIEditor**:
   - [ ] Inline marks render with correct styling
   - [ ] Mark text content is unchanged

---

## Test 5: Table Preservation

**Goal:** Tables in .SEC files survive the round-trip with correct structure.

### Steps

1. Open a .SEC file containing at least one table in SIM (e.g., the EARTHWORK spec has material classification tables).

2. Note the table dimensions (rows × columns) and a few cell values.

3. Export from SIM.

4. Open the exported file in a text editor:
   - [ ] `<TAB` element present with correct `COLUMNCOUNT` and `ROWCOUNT`
   - [ ] Cell data wrapped in `<DTA TYPE="STRING">` tags
   - [ ] Colspan cells have correct `CELLSPAN` attribute

5. Open in **SIEditor**:
   - [ ] **PASS:** Table renders without errors
   - [ ] Row and column counts match original
   - [ ] Cell content is correct
   - [ ] Column widths are reasonable (note: SIM uses equal widths; legacy may differ)

---

## Test 6: Multi-Part Structure

**Goal:** Files with 3+ PART sections maintain their structure.

### Steps

1. Open a multi-part .SEC file in SIM (most UFGS specs have PART 1 GENERAL, PART 2 PRODUCTS, PART 3 EXECUTION).

2. Verify all PARTs appear in the sidebar tree.

3. Export from SIM.

4. In a text editor, count `<PRT>` tags:
   - [ ] Count matches the original file
   - [ ] Each PRT contains its correct content

5. Open in **SIEditor**:
   - [ ] **PASS:** All PART sections display
   - [ ] Content under each PART is correct
   - [ ] Navigation between PARTs works

---

## Recording Results

For each test, record:

| Field | Value |
|-------|-------|
| Date | |
| Tester | |
| SIM version | (git commit hash or version) |
| SIEditor version | |
| .SEC file used | |
| Test # | |
| PASS / FAIL | |
| Notes / error messages | |

## Interpreting Failures

**If SIEditor rejects a SIM-exported file:**
1. Note the exact error message
2. Open both files (original and SIM export) in a hex editor
3. Search for the first byte difference
4. File a bug against the SIM serializer with the byte offset and expected vs. actual values

**If content is garbled:**
1. Check encoding — open the SIM export in a hex editor and look for UTF-8 multi-byte sequences (bytes 0xC0–0xFD). Their presence means the windows-1252 encoder is not being invoked.
2. Check the XML declaration — it must say `encoding="windows-1252"`, not `encoding="UTF-8"`.

**If structure is wrong (missing PARTs, wrong nesting):**
1. Compare the XML tree structure between original and SIM export
2. Check that SPT nesting depths match
3. Verify that NTE and OLG grouping is correct
