# SpecsIntact Modern (SIM)

A modern web-based editor for UFGS (Unified Facilities Guide Specifications) .SEC files, replacing the legacy SpecsIntact desktop application (SIEditor).

**Terminology:** "specsintact-modern" / "SIM" / "SI Modern" = this web app. "SpecsIntact" / "SIEditor" = the legacy Windows desktop application.

## Project Context

**What this is:** A rich text editor that reads and writes SpecsIntact .SEC files (XML-based SGML format with windows-1252 encoding, used by the U.S. military for construction specifications). The editor makes spec authoring feel like Google Docs or Notion while preserving the underlying SGML structure.

**Who it's for:** Engineers (especially geotechnical) who currently use MS Word as a workaround because SpecsIntact's tag-based editing is too clunky. The tool eliminates the Word-to-SpecsIntact round-trip workflow.

**Key design principle:** The engineer should never think about tags or SGML. Enter creates a paragraph. / opens a block type menu. Tab promotes/demotes headings. The SGML structure is inferred from context, not selected from a toolbar.

## Architecture

```
src/
  App.jsx                  # Main editor layout (sidebar, toolbar, editor pane) ~628 lines
  main.jsx                 # Entry point
  components/
    EditableBlock.jsx      # contentEditable block (txt, note, oli, item, lst) ~323 lines
    TitleBlock.jsx         # Section heading with inline editing, Tab/Shift+Tab depth ~145 lines
    TableBlock.jsx         # Read-only table rendering ~93 lines
    TreeNode.jsx           # Sidebar navigation tree node (recursive) ~62 lines
    SlashMenu.jsx          # / command dropdown menu ~94 lines
    FloatingToolbar.jsx    # Selection-based toolbar for inline marks + B/I/U + revision marks ~400 lines
    MarkSuggestions.jsx    # Auto-detect pattern suggestions (RID/SRF pills) ~153 lines
    MarkLegend.jsx         # Data element color key bar ~20 lines
    TailoringProfile.jsx   # TAI profile selector (branch/region/delivery dropdowns) ~150 lines
    RevisionControls.jsx   # Track Changes toggle, Show Revisions, Accept/Reject All ~130 lines
  lib/
    numbering.js           # Section numbering (1.1, 1.2.1, etc.) and OLI labels (a. b. c.) ~101 lines
    tree-builder.js        # Builds hierarchical tree from flat block array ~20 lines
    ini-config.js          # Formatting rules from SpecsIntact .ini files (margins, colors, nesting) ~80 lines
    sec-parser.js          # .SEC file parser (XML -> block array) ~377 lines
    sec-serializer.js      # Block array -> .SEC XML serializer ~378 lines
    encoding.js            # Windows-1252 encoder for .SEC export ~66 lines
    mark-patterns.js       # Auto-detect RID/SRF patterns in text ~96 lines
    tailor-profile.js      # TAI OPT matching, resolution, cleanup ~150 lines
    revisions.js           # Accept/reject logic for tracked changes, stats ~174 lines
    __tests__/
      setup.js             # Vitest DOMParser polyfill (linkedom)
      numbering.test.js    # 30 tests
      tree-builder.test.js # 10 tests
      encoding.test.js     # 11 tests
      sec-parser.test.js   # 27 tests
      sec-serializer.test.js # 23 tests
      sec-roundtrip.test.js  # 8 tests
      revisions.test.js    # 22 tests
      mark-patterns.test.js  # 18 tests
      tailor-profile.test.js # 31 tests
  data/
    sample-31-00-00.json   # Pre-parsed sample data (UFGS 31 00 00 EARTHWORK)
  styles/
    editor.css             # Inline mark styles, scrollbar, placeholder text
reference/
  section.ini              # SpecsIntact formatting rules (AUTHORITATIVE - always check this)
  document.ini             # Document-level formatting variant
  other.ini                # Other formatting variant
  UFGS.tpl                 # UFGS section template
  31_00_00.SEC             # Sample spec file (EARTHWORK)
  UFGS_M/01_42_00.sec      # Additional sample
  WebHelp/                 # Legacy SpecsIntact help system
tests/
  interop-test-procedure.md # 6 manual round-trip interop test scenarios
tools/
  parse-sec.js             # Node CLI: parse .SEC -> JSON
  roundtrip-test.js        # Test parse -> serialize -> re-parse
  diagnose-depth.js        # Debug SPT nesting
  diagnose-html.js         # Debug HTML extraction
```

## Running

```bash
npm install
npm run dev          # Vite dev server at localhost:5173
npm test             # Run all 143 unit tests (Vitest)
npm run test:watch   # Watch mode
npm run test:e2e     # Run 57 Playwright E2E tests
npm run parse -- input.sec output.json  # CLI: parse SEC to JSON
```

## Critical Rules

### Always check the .ini files for formatting

The `reference/section.ini` file is the authoritative source for:
- **[MARGINS]** - Left/right indent per block type (in inches). These are ABSOLUTE per type, not cumulative with nesting depth.
  - TXT=0.16,0 → 15px | OLI=0.50,0 → 48px | ITM=0.85,0 → 82px | LST=0.50,0 → 48px | NPR=0.89,0.89 → 85px
- **[COLORS]** - Color coding for inline data elements (RID=magenta, SUB=blue, ENG=blue, MET=red, etc.)
- **[RULES]** - What tags can nest inside what. This is the grammar.
- **[CODES]** - Tag names, descriptions, and whether they're TRANSPARENT (inline) or block-level.
- **[FONTS]** - Font styling per tag.

**When adding or modifying any formatting, read the .ini file first.** Do not guess at margins or colors.

### Tag categories (from .ini analysis)

**TRANSPARENT tags** (inline wrappers - 20 tags): ADD, BLD, CHG, CTR, DEL, ENG, HL1, HL2, HL3, HL4, HLS, INC, ITA, MET, SBS, SPS, TAI, TST, UND, URL

**Data-driven inline tags** (need structured treatment):
- SUB (323 occurrences) - Submittal items -> compiled into submittal register
- SRF (164) - Section cross-references -> validate against project package
- RID (529 inline) - Standard citations (ASTM, AASHTO) -> sync with REFERENCES section
- TAI (302) - Tailoring options by service branch/region/delivery method
- ENG/MET (~500 each) - Dual unit display pairs

**Block elements hierarchy:** SEC > PRT > SPT > {TXT, OLG, OLI, LST, ITM, NTE, NPR, SBM, TAB, TBL, TTL, REF}

### contentEditable focus management

This was the hardest part of the prototype. The pattern that works:

1. **New blocks** use a ref callback (`setRef`). When React attaches the DOM node, the callback inserts a zero-width space (`\u200B`) for caret anchoring and calls `node.focus()`.
2. **Existing blocks** (arrow key navigation, tree select, delete-focus-prev) use `focusBlock()` in the main App, which does `document.querySelector('[data-block-id="..."]').focus()` via setTimeout(0).
3. **Click focus** is browser-native - the `handleClickFocus` just updates visual state, doesn't programmatically focus.
4. **The zero-width space** must be stripped in `handleInput` and `isEmpty()` checks.

Do NOT add additional focus effects or competing focus mechanisms. The current pattern was arrived at through extensive debugging.

### Slash menu -> block conversion

When the slash menu converts a block type, `handleConvertBlock` creates a block with a **new ID**. This forces a React remount, which triggers the ref callback, which handles focus. Do not try to reuse the old block ID - the ref callback won't re-fire on an existing DOM node.

### Windows-1252 encoding

.SEC files use windows-1252 encoding (declared in the XML header). SIM handles this:
- **Import:** `FileReader.readAsArrayBuffer()` + `TextDecoder('windows-1252')` — NOT `readAsText()` (which defaults to UTF-8)
- **Export:** `encodeWindows1252(xml)` from `src/lib/encoding.js` returns `Uint8Array` with proper byte mapping for characters 0x80–0x9F (curly quotes, em-dash, euro, trademark, bullet, etc.)

## Data Model

Each document is a flat array of blocks:

```json
{
  "id": "n42",
  "type": "txt",        // title | txt | note | oli | item | lst | table
  "part": 1,            // PART number (1, 2, 3)
  "depth": 2,           // SPT nesting depth (0 = PART level, 1 = first subpart, etc.)
  "section": "n41",     // ID of the parent title block
  "level": 1,           // OLI only: list level (1 = a.b.c., 2 = 1.2.3.)
  "html": "...",         // Rich text content with <span class="mark-rid"> etc.
  "table": { ... },     // table blocks only: { columns, rows: [[{text, colspan}]] }
  "isNew": true          // Transient flag for newly created blocks (controls editability + focus)
}
```

## Development Status

### Completed ✅

**Core Editor**
- [x] Tree navigation with auto-numbering (6 levels deep)
- [x] Rich text editing for TXT blocks via contentEditable
- [x] Enter/Backspace/Arrow key block management
- [x] Heading editing with Tab/Shift+Tab promote/demote
- [x] Slash command menu (/ to insert any block type)
- [x] List continuation (Enter on OLI/ITM creates next item; Enter on empty exits)
- [x] Table rendering with colspan support (read-only)
- [x] Inline data marks (RID, SRF, SUB, ENG, MET, TAI, TST, URL, HLS) color-coded
- [x] Pattern recognition for RID/SRF marks (auto-detect + suggestion pills + Mark all)
- [x] Formatting margins from section.ini
- [x] Section numbering (1.1, 1.2.1, hierarchical) with PART resets
- [x] OLI labels (a/b/c level-1, 1/2/3 level-2+, overflow aa/ab/ac)
- [x] Note (NTE/NPR) grouping with proper styling
- [x] TAI tailoring resolution (set branch/region/delivery → hide/show conditional content)
- [x] Tracked changes (ADD/DEL/CHG) — inline and block-level revision marks with accept/reject

**File I/O**
- [x] SEC file import (drag-and-drop + Import button)
- [x] SEC file export (serialize blocks back to valid SGML)
- [x] Windows-1252 encoding/decoding (import and export)
- [x] REF block parsing (ORG headers, RID/RTL pairs)
- [x] Metadata extraction (section number, title, date)
- [x] Nested SPT hierarchy resolution
- [x] TAI OPT attribute preservation (round-trip fidelity)

**UI**
- [x] Sidebar navigation tree (collapsible, with numbering)
- [x] Toolbar (Import/Export, section number/title, status badge)
- [x] Mark legend (color key for inline marks)
- [x] Status bar (block count, section count, table count, keyboard hints)
- [x] Section banner (UFGS header with agency, section number, title, date)

**Testing & Quality**
- [x] 179 automated unit tests across 9 test files (Vitest)
- [x] 81 Playwright E2E tests (keyboard, navigation, slash menu, toolbar, marks, track changes)
- [x] Parse → serialize → re-parse roundtrip verified (including TAI OPT)
- [x] Bug audit completed (18 bugs identified, 13 fixed)
- [x] Interoperability test procedure documented (6 manual test scenarios)

### Known Limitations ⚠️

- **All text-bearing block types are now editable** (txt, note, oli, item, lst). Tables remain read-only.
- **Tables are read-only.** Table editing would be a significant feature addition.
- **No undo/redo.** Would require action history architecture.
- **Serializer differences from legacy SpecsIntact:** LF line endings (not CRLF), minimal header (not table-based), whitespace normalization, hardcoded MTA metadata. These are cosmetic — SIEditor should tolerate them, but interop testing will confirm.
- **Parser tested only with 31_00_00.SEC and synthetic data.** Not yet validated against full UFGS master set.

### Next Priorities 🔜

1. ~~Make all parsed blocks editable~~ ✅ Done — note, oli, item, lst are now editable
2. ~~Contextual floating toolbar~~ ✅ Done — select text → floating popup with B/I/U formatting + RID/SRF/SUB/ENG/MET/TAI marks; toggle on/off supported
3. ~~Pattern recognition for inline marks~~ ✅ Done — auto-detect RID/SRF patterns, suggestion pills below focused block, individual + "Mark all" apply
4. ~~TAI tailoring resolution~~ ✅ Done — set branch/region/delivery method, auto-hide excluded TAI content, "Show excluded" toggle dims instead of hiding
5. ~~Tracked changes~~ ✅ Done — ADD/DEL/CHG parsing/serialization, inline + block-level marks, Track Changes toggle, Show Revisions, Accept/Reject individual + all
6. **Reference section structured editing** — edit REF/ORG/RID/RTL in structured UI
7. **Cross-reference validation** — SRF links resolve against project package

### Future Roadmap 📋

- [ ] Drag-and-drop tree reordering — reorder sections/subsections by dragging nodes in the sidebar
- [ ] Monospace preview mode — toggle to a SpecsIntact-style monospace view showing how the spec will render in legacy SIEditor (read-only, faithful to print output)
- [ ] Undo/redo (action history store)
- [ ] Search/find in document (sidebar search field is currently a non-functional stub)
- [ ] Table editing (cell editor, add/remove rows/columns)
- [ ] Comment threading on blocks
- [ ] Submittal register compilation (SUB items → checklist)
- [ ] Batch operations (find/replace, multi-block style)
- [ ] Print/PDF export (UFGS print-ready format)
- [ ] Advanced REF section management (validate standards, check currency)
- [ ] CRLF line endings for full byte-level legacy parity

### Test Coverage 🧪

| Test File | Tests | Coverage |
|-----------|-------|----------|
| numbering.test.js | 30 | Section numbering, OLI labels, counter resets, overflow |
| sec-parser.test.js | 27 | Tag extraction, inline marks, tables, SPT depth, TAI OPT, ADD/DEL/CHG |
| sec-serializer.test.js | 23 | XML output, SPT wrapping, NTE/OLG grouping, TAI OPT, ADD/DEL/CHG |
| encoding.test.js | 11 | Windows-1252 byte mapping, special characters |
| tree-builder.test.js | 10 | Flat→tree conversion, multi-level nesting |
| sec-roundtrip.test.js | 8 | Parse → serialize → re-parse cycle, TAI OPT roundtrip, ADD/DEL/CHG roundtrip |
| revisions.test.js | 22 | Accept/reject inline + block revisions, batch operations, stats |
| mark-patterns.test.js | 18 | RID/SRF detection, already-marked skip, overlap handling |
| tailor-profile.test.js | 31 | Branch/region/delivery matching, resolution, cleanup |
| editor.spec.js (E2E) | 81 | Keyboard, navigation, slash menu, toolbar, marks, layout, track changes |

**Total: 179 unit tests + 81 E2E tests = 260 automated tests**

**Not yet tested:** Error recovery on malformed SEC input.

## Dependencies

**Production:** React 18.3, react-dom 18.3, lucide-react 0.383
**Dev:** Vite 8.0, @vitejs/plugin-react 6.0.1, Vitest 4.1, linkedom 0.18 (test DOM polyfill), Playwright (E2E)
