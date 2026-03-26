# SEC Interop Testing — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Validate that .SEC files round-trip between SIM and legacy SpecsIntact/SIEditor without data loss, fix the gaps found, and lock in the fixes with automated tests.

**Architecture:** Five-phase approach ordered by risk:
1. **Expand automated roundtrip tests** — binary-level diff tool + batch regression across 690 .SEC files
2. **Fix header fidelity** (#1 risk) + MTA preservation + table attribute fidelity
3. **SIEditor validation via Windows MCP** — launch SIEditor, open files, detect errors, screenshot results
4. **Reverse import validation** — encoding edge cases for SIEditor → SIM direction
5. **CI integration** — `npm run test:interop` triggers on parser/serializer changes

**Tech Stack:** Node.js (`node --test` runner), linkedom (DOM in Node), Windows MCP (App, Snapshot, Click, Type, Shortcut for SIEditor automation), existing `sec-parser.js` + `sec-serializer.js`, 690-file UFGS corpus at `reference/UFGS_M/`

**Branch:** `interop-testing` (already created from `main`)

**Prerequisites:**
- SIEditor installed at `C:\Program Files (x86)\SpecsIntact 5\SIEditor.exe` (confirmed)
- UFGS master set at `reference/UFGS_M/` (707 total files; 690 are `.SEC` — scanner must filter with `*.sec` case-insensitive glob)

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `tools/interop-scan.mjs` | Create | Corpus-wide binary-level diff scanner: categorizes whitespace vs structural vs content divergences |
| `tests/interop.node-test.mjs` | Create | Automated interop test suite (17 structural checks, Node runner) |
| `tests/sieditor-smoke.md` | Create | SIEditor smoke test results log (auto-populated by Windows MCP runs) |
| `src/lib/sec-parser.js` | Modify | Add `extractMetadata()` named export for MTA, HDR, and section metadata extraction |
| `src/lib/sec-serializer.js` | Modify | Fix header passthrough, MTA preservation, table attribute fidelity |
| `src/lib/__tests__/sec-serializer.test.js` | Modify | Interop regression tests |
| `package.json` | Modify | Add `test:interop` script |

---

## Known Divergences (from codebase analysis)

| # | Divergence | Impact | Legacy Format | SIM Format |
|---|-----------|--------|---------------|------------|
| 1 | **Header structure** | HIGH | Table-based HDR with 2-col x 4-row TAB: agency, UFGS number+date, change info, preparing activity, superseding sections, dashed separator, UMRL date | Minimal: `<HDR><AST/><HL4>UNIFIED FACILITIES GUIDE SPECIFICATIONS</HL4><BRK/><AST/><BRK/></HDR>` |
| 2 | **MTA tags** | MEDIUM | Preserves original MTA values (STATUS, EDIT, SUBFORMAT, AUTONUMBER, SPECTYPE, SPECCLASS, CSI) | Hardcodes only SUBFORMAT="NEW" and AUTONUMBER="TRUE" |
| 3 | **BRL tags in header** | LOW | Uses `<BRL/>` (blank line) tags after header table for vertical spacing | SIM never emits BRL |
| 4 | **Column widths in TAB** | LOW | Specific `WIDTH` + `AUTOWIDTH="0"` on COL, `HEIGHT` + `AUTOHEIGHT="0"` on ROW | SIM computes equal widths (`450/cols`), no ROW HEIGHT |
| 5 | **HDR table attributes** | LOW | `<TAB BORDERS="0">` inside HDR with full STS/STY/ALN structure | SIM never serializes HDR table content |
| 6 | **CEL INDEX attribute** | LOW | Some cells use `INDEX="2"` to skip columns | SIM never emits INDEX on CEL |
| 7 | **MERGEDOWN attribute** | LOW | `MERGEDOWN="1"` for vertical cell merges | SIM only handles MERGEACROSS (horizontal) |
| 8 | **SCN format** | NONE | `<SCN>SECTION 31 00 00</SCN>` | Identical |
| 9 | **PRA tag in header** | MEDIUM | `<PRA>USACE</PRA>` inside header identifies preparing activity | Stripped (parsed as transparent) |
| 10 | **UFGS version in header** | MEDIUM | `UFGS-31 00 00 (August 2023)` with date in header cell | Not emitted |

**Note:** The manual test procedure (`tests/interop-test-procedure.md`) lists "SIM outputs LF" as a known difference, but this is already resolved — `sec-serializer.js` joins with `\r\n` (CRLF).

**Key insight:** Divergences 1, 3, 5, 9, 10 are all solved by preserving the original `<HDR>` verbatim (Phase 2). This single fix addresses 5 of 10 divergences.

---

## Phase 1: Expand Automated Roundtrip Tests

### Task 1.1: Build binary-level diff scanner

**Files:**
- Create: `tools/interop-scan.mjs`

The scanner goes beyond block-level comparison (which the existing `tools/roundtrip-test.js` already does). It categorizes differences at the XML text level into three buckets:

- **Whitespace diffs:** Line endings, indentation, blank lines (benign)
- **Structural diffs:** Missing/added tags, attribute differences, tag ordering (may break SIEditor)
- **Content diffs:** Text content changes, encoding corruption (data loss)

- [ ] **Step 1: Create the scanner**

```js
// tools/interop-scan.mjs
// Usage:
//   node --import ./tools/json-loader.mjs tools/interop-scan.mjs                          # all files
//   node --import ./tools/json-loader.mjs tools/interop-scan.mjs reference/31_00_00.SEC   # one file
```

The scanner should:
1. Read each .SEC file (latin1 encoding)
2. Extract metadata (section number, title, date, MTA tags, header structure)
3. Parse -> serialize via SIM's pipeline
4. Compare serialized output against original at the byte level:
   - Count whitespace-only diffs (CRLF vs LF, indentation, blank lines)
   - Count structural diffs (missing tags, changed attributes, tag order)
   - Count content diffs (text changes, encoding byte mismatches)
   - Specifically check: HDR presence/fidelity, MTA tag count, PRT count, TAB attribute completeness
5. Output `test-results/interop-scan.json` + human-readable summary to stdout

- [ ] **Step 2: Run against full 690-file corpus**

```bash
node --import ./tools/json-loader.mjs tools/interop-scan.mjs
```

Record baseline divergence counts per category.

- [ ] **Step 3: Commit**

```bash
git add tools/interop-scan.mjs
git commit -m "feat: add binary-level interop scanner with diff categorization"
```

### Task 1.2: Build automated interop test suite

**Files:**
- Create: `tests/interop.node-test.mjs`
- Modify: `package.json`

Uses Node built-in test runner. Tests validate structural properties of SIM-serialized output using `31_00_00.SEC` as the primary fixture.

- [ ] **Step 1: Write the interop test file**

17 test categories (use `it.each()` for data-driven checks, keep to <=30 tests total):

```
1. XML declaration: encoding="windows-1252" present
2. Root element: <SEC xmlns:xsi="..."> with correct schema URL
3. MTA tags: at minimum SUBFORMAT and AUTONUMBER present
4. HDR element: present and well-formed
5. SCN/STL/DTE: present with correct content matching original
6. PRT count: matches original file
7. SPT nesting: max depth matches original
8. NTE grouping: every NPR is inside an NTE
9. OLG grouping: consecutive OLIs are inside an OLG
10. REF structure: ORG + RID/RTL entries preserved
11. TAB structure: COLUMNCOUNT/ROWCOUNT attributes present, ROW/CEL valid
12. TBL roundtrip: THD preserved, BRK tags present
13. Inline marks: RID/SRF/SUB/ENG/MET/TAI tags present (not HTML spans)
14. Revision tags: ADD/DEL/CHG tags present (inline + block-level)
15. No HTML leakage: no <span>, <ins>, <del>, <b>, <em>, <u> in output
16. Encoding: non-ASCII characters survive roundtrip (degree, curly quotes, en-dash)
17. Line endings: CRLF (\r\n) used consistently
```

Tests that fail due to known divergences should use `it.skip()` with `// KNOWN: divergence #N` so the suite runs green but documents gaps.

- [ ] **Step 2: Run and verify**

```bash
node --import ./tools/json-loader.mjs --test tests/interop.node-test.mjs
```

- [ ] **Step 3: Add npm script to `package.json`**

```json
"test:interop": "node --import ./tools/json-loader.mjs --test tests/interop.node-test.mjs"
```

- [ ] **Step 4: Commit**

```bash
git add tests/interop.node-test.mjs package.json
git commit -m "feat: add automated interop test suite (17 structural checks)"
```

---

## Phase 2: Fix Serializer Gaps (Highest Risk First)

### Task 2.1: Add `extractMetadata()` to parser + preserve MTA tags

**Files:**
- Modify: `src/lib/sec-parser.js` — add `extractMetadata()` named export
- Modify: `src/lib/sec-serializer.js` — emit preserved MTA tags
- Test: `src/lib/__tests__/sec-serializer.test.js`

Currently MTA is in the parser's `SKIP_TAGS` set (not extracted into blocks), and the serializer hardcodes only SUBFORMAT + AUTONUMBER. Real SEC files have additional MTA tags that SIEditor may expect.

**Design decision:** Add `extractMetadata()` as a **named export in `sec-parser.js`**. This function extracts section number, title, date, MTA tags, and (in Task 2.2) raw HDR from the XML string. `parseSEC()` signature stays unchanged (returns blocks only). Callers (App.jsx, roundtrip tools, interop scanner) call `extractMetadata(xmlString)` separately and pass the result to `serializeSEC()`.

**Note:** `tools/roundtrip-test.js` already has a local `extractMeta()` (lines 22–31) doing section/title/date extraction. After this task, update `roundtrip-test.js` to import `extractMetadata` from `sec-parser.js` instead of its local copy.

- [ ] **Step 1: Write failing test for MTA preservation**

Add a test to `sec-serializer.test.js`:
1. Create metadata with `{ mta: { STATUS: 'CHG', EDIT: 'TRUE', SPECTYPE: 'UFGS', SPECCLASS: '31 00 00' } }`
2. Serialize blocks with this metadata
3. Assert all MTA tags appear in output

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run src/lib/__tests__/sec-serializer.test.js --reporter=verbose
```

- [ ] **Step 3: Implement MTA preservation in serializer**

In `serializeSEC()`, after the hardcoded MTA lines:

```js
if (metadata.mta) {
  for (const [name, content] of Object.entries(metadata.mta)) {
    if (name !== 'SUBFORMAT' && name !== 'AUTONUMBER') {
      lines.push(`<MTA NAME="${name}" CONTENT="${content}"/>`);
    }
  }
}
```

- [ ] **Step 4: Add `extractMetadata()` named export to `sec-parser.js`**

```js
/**
 * Extract metadata from a .SEC XML string for roundtrip serialization.
 * Separate from parseSEC() — callers use both independently.
 */
export function extractMetadata(xml) {
  const meta = { sectionNumber: '00 00 00', sectionTitle: 'UNTITLED', date: '' };
  const scn = xml.match(/<SCN[^>]*>SECTION\s+([\d\s.]+)<\/SCN>/i);
  if (scn) meta.sectionNumber = scn[1].trim();
  const stl = xml.match(/<STL[^>]*>(.*?)<\/STL>/i);
  if (stl) meta.sectionTitle = stl[1].trim();
  const dte = xml.match(/<DTE[^>]*>(.*?)<\/DTE>/i);
  if (dte) meta.date = dte[1].trim();

  const mta = {};
  const mtaRegex = /<MTA\s+NAME="([^"]+)"\s+CONTENT="([^"]*)"\/>/g;
  let m;
  while ((m = mtaRegex.exec(xml)) !== null) {
    mta[m[1]] = m[2];
  }
  meta.mta = mta;
  return meta;
}
```

- [ ] **Step 5: Run tests**

```bash
npx vitest run src/lib/__tests__/sec-serializer.test.js --reporter=verbose
```

- [ ] **Step 6: Commit**

```bash
git add src/lib/sec-parser.js src/lib/sec-serializer.js src/lib/__tests__/sec-serializer.test.js
git commit -m "feat: preserve MTA metadata tags through serialize roundtrip"
```

### Task 2.2: Preserve header structure (verbatim passthrough)

**Files:**
- Modify: `src/lib/sec-parser.js` — extend `extractMetadata()` with `rawHeader`
- Modify: `src/lib/sec-serializer.js` — emit original HDR when available
- Test: `src/lib/__tests__/sec-serializer.test.js`

**Depends on:** Task 2.1 (`extractMetadata()` exists).

This is the #1 risk. SIEditor will likely choke on the minimal 3-line header. Fix: preserve the original `<HDR>...</HDR>` verbatim during roundtrip. New documents (no original) still get the minimal header.

- [ ] **Step 1: Write failing test**

Test that when metadata includes `rawHeader`, the serializer emits it instead of the minimal header.

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run src/lib/__tests__/sec-serializer.test.js --reporter=verbose
```

- [ ] **Step 3: Extend `extractMetadata()` to capture raw HDR**

Add to `extractMetadata()` in `sec-parser.js`:

```js
const hdrMatch = xml.match(/<HDR>[\s\S]*?<\/HDR>/);
if (hdrMatch) meta.rawHeader = hdrMatch[0];
```

- [ ] **Step 4: Use raw header in serializer**

In `serializeSEC()`, replace the minimal header block:

```js
if (metadata.rawHeader) {
  lines.push(metadata.rawHeader);
} else {
  // Minimal header for new documents
  lines.push('<HDR><AST/>');
  lines.push(`<HL4>UNIFIED FACILITIES GUIDE SPECIFICATIONS</HL4><BRK/>`);
  lines.push('<AST/><BRK/></HDR>');
}
```

- [ ] **Step 5: Run tests (serializer + roundtrip + interop)**

```bash
npx vitest run src/lib/__tests__/sec-serializer.test.js --reporter=verbose
npx vitest run src/lib/__tests__/sec-roundtrip.test.js --reporter=verbose
npm run test:interop
```

- [ ] **Step 6: Commit**

```bash
git add src/lib/sec-parser.js src/lib/sec-serializer.js src/lib/__tests__/sec-serializer.test.js
git commit -m "feat: preserve original HDR block through serialize roundtrip"
```

### Task 2.3: Improve table serialization fidelity

**Files:**
- Modify: `src/lib/sec-parser.js` — extract column widths and row heights in `extractTable()`
- Modify: `src/lib/sec-serializer.js` — emit preserved attributes in `serializeTable()`
- Test: `src/lib/__tests__/sec-serializer.test.js`

Legacy tables have specific column widths (`WIDTH="225.75"`), `AUTOWIDTH="0"`, row heights (`HEIGHT="15.00"`), and `AUTOHEIGHT="0"`. SIM computes equal widths and omits height/auto attributes.

**Ripple risk:** Adding `colWidths` and `rowHeights` to the table data model affects `table-ops.js`. New fields must be optional (undefined = computed defaults) so existing code paths are unaffected. The `npm test` step catches any breakage in the 17 existing `table-ops.test.js` tests.

- [ ] **Step 1: Write failing test**

Test that serialized table output includes AUTOWIDTH on COL and HEIGHT/AUTOHEIGHT on ROW when table metadata includes these values.

- [ ] **Step 2: Extend `extractTable()` to capture widths and heights**

In `sec-parser.js:extractTable()`, add separate queries (COL elements are siblings of ROW inside TDA, not currently queried at all):
- `tda.querySelectorAll('COL')` → `colWidths: [225.75, 224.25]` from WIDTH attributes
- For each `ROW`: `rowElem.getAttribute('HEIGHT')` → `rowHeights: [15.00, 12.00, ...]`

- [ ] **Step 3: Update `serializeTable()` to emit preserved attributes**

When `table.colWidths` exists, use those instead of computed equal widths. Add `AUTOWIDTH="0"`. When `table.rowHeights` exists, add `HEIGHT` and `AUTOHEIGHT="0"` to ROW.

- [ ] **Step 4: Run full test suite**

```bash
npm test
npm run test:interop
```

- [ ] **Step 5: Commit**

```bash
git add src/lib/sec-parser.js src/lib/sec-serializer.js src/lib/__tests__/sec-serializer.test.js
git commit -m "feat: preserve table column widths and row heights through roundtrip"
```

### Task 2.4: Re-run corpus scanner + update interop tests

**Files:**
- Modify: `tests/interop.node-test.mjs` (un-skip passing tests, add regression assertions)

- [ ] **Step 1: Re-run scanner after fixes**

```bash
node --import ./tools/json-loader.mjs tools/interop-scan.mjs
```

- [ ] **Step 2: Compare before/after divergence counts**

Document improvement per category (MTA, header, table attributes).

- [ ] **Step 3: Update interop tests**

Un-skip tests that now pass. Add corpus-wide regression assertions.

- [ ] **Step 4: Run all test suites**

```bash
npm test && npm run test:compliance && npm run test:interop && npm run test:ufgs
```

- [ ] **Step 5: Commit**

```bash
git add tools/interop-scan.mjs tests/interop.node-test.mjs
git commit -m "fix: close interop gaps — MTA, header, table attribute preservation"
```

---

## Phase 3: SIEditor Validation via Windows MCP

### Task 3.1: Smoke tests — 10 representative files

**Tools:** Windows MCP (App, Snapshot, Screenshot, Click, Type, Shortcut, PowerShell)

SIEditor is a GUI desktop app with no CLI mode. Windows MCP lets us automate the entire flow:
1. Copy SIM-exported file to a temp location
2. Launch SIEditor with the file path
3. Snapshot the UI to detect error dialogs
4. Screenshot the editor view for visual verification
5. Close SIEditor

**Test file selection (10 files covering major feature areas):**

| # | File | Why |
|---|------|-----|
| 1 | `31 00 00.SEC` | Primary test fixture — EARTHWORK, multi-part, tables, refs, notes |
| 2 | `03 30 00.SEC` | Heavy tables, cast-in-place concrete |
| 3 | `22 00 00.SEC` | Plumbing, extensive inline marks |
| 4 | `26 20 00.SEC` | Electrical, deep SPT nesting |
| 5 | `32 12 16.16.SEC` | Known roundtrip edge case (THD/HL3 boundary shift) |
| 6 | `32 13 13.43.SEC` | Known roundtrip edge case (THD/HL3 boundary shift) |
| 7 | `01 33 00.SEC` | Submittal procedures, heavy SUB marks |
| 8 | `33 71 02.SEC` | Utility specs, TAI marks |
| 9 | `01 42 00.sec` | Lowercase extension edge case (scanner must use case-insensitive glob `*.[sS][eE][cC]`) |
| 10 | `40 60 00.SEC` | Preformatted table (TBL blocks) roundtrip — Cooling Water Systems |

**Three test levels per file:**

| Level | What | How to detect |
|-------|------|---------------|
| **Smoke** | Opens without error | Snapshot UI — no error dialog, editor canvas visible |
| **Content** | Paragraphs, section structure correct | Snapshot text content, check PRT headings in tag view |
| **Deep** | Tag view matches expected structure | Toggle SIEditor to tag view (`</>` button), screenshot, compare inline marks |

- [ ] **Step 1: Generate SIM-exported versions of the 10 test files**

Use the Node pipeline (not browser UI) to generate exports:

```js
// For each file: read -> parse -> extractMetadata -> serialize -> write
// Save to test-results/interop/<filename>_SIM.SEC
```

Write a small Node script `tools/interop-export.mjs` that does this for the 10 selected files.

- [ ] **Step 2: Smoke test — open each file in SIEditor via Windows MCP**

For each of the 10 exported files:

1. **Launch SIEditor:**
   ```
   Windows MCP App: launch "C:\Program Files (x86)\SpecsIntact 5\SIEditor.exe"
   ```
   Wait for it to load.

2. **Open the file:** Use File > Open or Ctrl+O, navigate to the exported file, and open it.
   ```
   Windows MCP Shortcut: ctrl+o
   Windows MCP Type: <path to exported file>
   Windows MCP Shortcut: enter
   ```

3. **Check for errors:** Take a Snapshot with `use_vision=True`. Look for:
   - Error dialog boxes (modal windows with "Error", "Warning", "Invalid" text)
   - "Parse error" or "invalid tag" messages
   - Normal editor canvas with section content visible

4. **Record result:** Screenshot the editor view. Save PASS/FAIL to `tests/sieditor-smoke.md`.

5. **Close the file:** Ctrl+W or File > Close.

- [ ] **Step 3: Content verification — spot-check 3 files**

For `31_00_00.SEC`, `03_30_00.SEC`, and `22_00_00.SEC`:

1. After opening, Snapshot the editor to read visible text
2. Verify section title, PART headings visible
3. Scroll down and Snapshot to check table rendering
4. Screenshot for the record

- [ ] **Step 4: Deep verification — tag view on 2 files**

For `31_00_00.SEC` and a file with heavy inline marks:

1. Toggle tag view in SIEditor (find the tag view button via Snapshot)
2. Screenshot the tag view
3. Verify inline marks (RID, SUB, ENG/MET) are visible with correct tag wrappers

- [ ] **Step 5: Log results and commit**

Create `tests/sieditor-smoke.md` with results table:

```markdown
# SIEditor Smoke Test Results — [date]

| File | Smoke | Content | Deep | Notes |
|------|-------|---------|------|-------|
| 31_00_00.SEC | PASS/FAIL | PASS/FAIL | PASS/FAIL | ... |
```

```bash
git add tests/sieditor-smoke.md tools/interop-export.mjs
git commit -m "feat: add SIEditor smoke test results via Windows MCP automation"
```

### Task 3.2: Diagnose and fix any SIEditor failures

If any smoke tests fail:

- [ ] **Step 1: Capture the exact error**

Use Windows MCP Snapshot with `use_vision=True` to read the error dialog text.

- [ ] **Step 2: Compare the failing file against a working legacy file**

Open the original (non-SIM) version in SIEditor to confirm it works. Then diff the two XML files to isolate the structural difference causing the failure.

- [ ] **Step 3: Fix the serializer**

Based on the error, update `sec-serializer.js`. The most likely culprits:
- Missing HDR structure (fixed in Phase 2)
- Missing MTA tags (fixed in Phase 2)
- Unexpected tag nesting or missing closing tags
- Encoding issues (UTF-8 bytes in a windows-1252 declared file)

- [ ] **Step 4: Re-export and re-test**

Re-run the export script, re-open in SIEditor, verify the fix.

- [ ] **Step 5: Add regression test and commit**

```bash
git add src/lib/sec-serializer.js src/lib/__tests__/sec-serializer.test.js
git commit -m "fix: resolve SIEditor rejection — [specific issue]"
```

---

## Phase 4: Reverse Import Validation (SIEditor -> SIM)

### Task 4.1: Encoding edge case tests

**Files:**
- Modify: `tests/interop.node-test.mjs`

The SIEditor -> SIM direction is largely covered by the 690-file corpus test (all files were authored in legacy SpecsIntact). This task adds targeted encoding edge case tests.

- [ ] **Step 1: Add encoding roundtrip tests**

Test these windows-1252 special characters survive import -> re-export:

```js
const ENCODING_CASES = [
  { char: '\u00B0', name: 'degree sign', byte: 0xB0 },       // °
  { char: '\u2013', name: 'en-dash', byte: 0x96 },            // –
  { char: '\u2014', name: 'em-dash', byte: 0x97 },            // —
  { char: '\u2018', name: 'left single quote', byte: 0x91 },  // '
  { char: '\u2019', name: 'right single quote', byte: 0x92 }, // '
  { char: '\u201C', name: 'left double quote', byte: 0x93 },  // "
  { char: '\u201D', name: 'right double quote', byte: 0x94 }, // "
  { char: '\u2022', name: 'bullet', byte: 0x95 },             // •
  { char: '\u2026', name: 'ellipsis', byte: 0x85 },           // …
  { char: '\u2122', name: 'trademark', byte: 0x99 },          // ™
  { char: '\u20AC', name: 'euro sign', byte: 0x80 },          // €
];
```

For each: create a synthetic SEC with the character in a TXT block, parse, serialize, verify the character is preserved (not replaced with `?`).

- [ ] **Step 2: Create a SIEditor-authored test file via Windows MCP**

Use Windows MCP to create a file in SIEditor with special characters:

1. Launch SIEditor
2. Create a new section (File > New)
3. Type text containing degree signs, curly quotes, em-dashes
4. Save as `test-results/interop/encoding_test_legacy.SEC`
5. Close SIEditor

Then import this file into SIM's parser and verify all characters survive.

- [ ] **Step 3: Run tests**

```bash
npm run test:interop
```

- [ ] **Step 4: Commit**

```bash
git add tests/interop.node-test.mjs
git commit -m "feat: add encoding edge case tests for reverse import validation"
```

---

## Phase 5: CI Integration

### Task 5.1: Wire up `test:interop` and document

**Files:**
- Modify: `package.json` (already done in Phase 1, verify)
- Modify: `CLAUDE.md` (update test count, add interop test docs)

- [ ] **Step 1: Verify `npm run test:interop` works**

```bash
npm run test:interop
```

- [ ] **Step 2: Run full suite to confirm nothing is broken**

```bash
npm test && npm run test:compliance && npm run test:interop && npm run test:ufgs && npm run test:corpus
```

- [ ] **Step 3: Update CLAUDE.md**

Update the test coverage table, running commands section, and total test count to include interop tests.

- [ ] **Step 4: Final commit**

```bash
git add package.json CLAUDE.md
git commit -m "docs: add interop test suite to CI commands and CLAUDE.md"
```

---

## Deferred (out of scope)

- **BRL tag emission** — Low impact. SIEditor likely ignores missing BRL in body content.
- **CEL INDEX attribute** — Would require tracking cell position during serialization. Low impact.
- **MERGEDOWN (vertical merge)** — Requires parser changes to detect vertical spans. Low usage in UFGS corpus.
- **Header table reconstruction for new files** — When SIM creates a file from scratch (no original to preserve), the minimal header is used. Building a proper table-based header from metadata would require a template system. Deferred to deployment phase.

---

## Success Criteria

1. `npm run test:interop` passes with >=15 structural checks
2. Binary-level scanner categorizes all 690 .SEC files; 0 content-level diffs, structural diffs limited to deferred items only
3. MTA tags from original files survive parse -> serialize -> re-parse
4. HDR blocks from original files are preserved verbatim in serialized output
5. Table COL widths and ROW heights are preserved through roundtrip
6. SIEditor smoke test: >=8/10 files open without errors (via Windows MCP automation)
7. SIEditor content test: >=3/3 spot-checked files display correct structure
8. Encoding roundtrip: all 11 windows-1252 special characters survive
9. Existing test suites (466 Vitest + 69 Node + 140 Playwright) still pass
10. `npm run test:interop` is documented in CLAUDE.md and package.json
