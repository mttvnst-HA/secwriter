# Real-World .SEC File Testing — Design Spec

**Date:** 2026-03-24
**Branch:** `feat/real-world-sec-testing`
**Scope:** Validate parser across full UFGS master set (691 files), fix discovered gaps, leave a permanent regression test suite.

## Context

The existing `tools/roundtrip-test.js` passes all 691 UFGS .SEC files in `reference/UFGS_M/` with zero diffs (parse → serialize → re-parse). However, roundtrip consistency does not guarantee parser completeness — tags can be silently dropped or inlined as text without affecting structural round-trip.

A tag census of all 691 files identified **60 unique SGML tags**. Cross-referencing against the parser's handled/skipped sets revealed four gaps where content is silently lost or degraded.

## Tag Census Results

All 60 tags in the UFGS master set, categorized by parser handling:

| Status | Tags |
|--------|------|
| **Block-level (handled)** | PRT, SPT, TTL, TXT, NPR, NPG, OLI, LST, ITM, TAB, REF |
| **Container (handled)** | NTE, OLG, SBM |
| **Revision wrapper (handled)** | ADD, DEL, CHG (block + inline) |
| **Inline mark (handled)** | RID, SRF, SUB, ENG, MET, TAI, TST, URL, HLS |
| **Inline format (handled)** | BLD, ITA, UND, HL1, HL2, HL3, HL4, SBS, SPS, CTR |
| **Skip (handled — content discarded)** | BRK, BRL, AST, NED, PGE, MTA, END, EOD |
| **Pass-through (handled)** | SCP, PRA |
| **Metadata (root-filtered)** | HDR, SCN, STL, DTE, SEC |
| **Table-internal (handled)** | WBK, TDA, ROW, CEL, DTA, STS, STY, ALN, COL |
| **REF-internal (handled)** | ORG, RTL, OAD |
| **GAP — needs fix** | TBL, THD, ATT, INT |
| **Defined in .ini but absent from corpus** | TOC, OTH, DOC, INC |

## Parser Gaps

### 1. TBL — Unformatted Tables (High Priority)

**Occurrences:** 94 tags across 17 files.
**Current behavior:** Content silently inlined as text, whitespace and structure lost.

TBL is a preformatted text block used for forms, checklists, and warranty documents. Unlike TAB (structured XML table with rows/cells), TBL uses whitespace alignment with a monospace font.

**Structure in the wild:**
```xml
<TBL>
  <THD>Header text</THD>
  Preformatted body text with spaces for alignment
  <BRK/>
  More lines with <RID>inline marks</RID>
</TBL>
```

**Fix:** New block type `"tbl"`. Parser extracts TBL content preserving whitespace. BRK tags inside TBL are converted to `\n` (unlike the rest of the parser where BRK is in SKIP_TAGS — TBL requires explicit line break handling since whitespace is significant). THD content stored separately as a header. PGE tags inside TBL are ignored (page breaks are a print concern, not a data concern). Rendered read-only with `white-space: pre; font-family: 'Courier New', monospace` per section.ini `[FONTS]` DOC setting. Serializer writes back as `<TBL>[<THD>...</THD>]content</TBL>`.

**Nesting:** In the UFGS corpus, TBL appears as a direct child of SPT in all but one case. File `08 34 02.SEC` has a TBL nested inside an NTE block. This is handled the same way the parser handles TAB-inside-TXT: the containing block's content is emitted first, then the TBL is promoted to a sibling block. The parser already has this pattern at lines 204-230 for TAB extraction.

**Data model:**
```json
{
  "type": "tbl",
  "html": "<b>Header text</b>\nPreformatted body with <span class=\"mark-rid\">inline marks</span>",
  "part": 1,
  "depth": 2,
  "section": "n41"
}
```
THD content is stored in `html` as bold text (`<b>...</b>`) at the start, separated from body by `\n`. Inline marks (RID, SRF, SUB, ATT) within TBL body are converted to spans like any other block. This keeps the data model uniform — no new fields needed.

**Rendering:** TBL blocks go through the existing block rendering pipeline in App.jsx. A branch for `type === "tbl"` renders a `<div class="block-tbl">` with `contentEditable={false}` and `dangerouslySetInnerHTML`. No new React component needed.

**Scope limit:** Read-only rendering only. No contentEditable editing of TBL blocks in this work.

### 2. ATT — Attachment References (Medium Priority)

**Occurrences:** 170 tags across 10+ files.
**Current behavior:** Tag stripped, text content inlined without semantic markup.

ATT wraps attachment names referenced in spec text (e.g., "ENG Form 4025-R"). Semantically similar to RID (reference identifier) but for attached documents rather than external standards.

**Structure in the wild:**
```xml
<TXT>Use the <ATT>ENG Form 4025-R</ATT> transmittal form.</TXT>
```

**Fix:** Add as inline mark. Parser maps `<ATT>` → `<span class="mark-att">`. Serializer maps back. No color defined in section.ini `[COLORS]`, so no special styling beyond the mark class. Per .ini RULES: `ATT=PCDATA,NED,RID,SUB`.

**Nesting:** ATT is always used inline in the UFGS corpus (inside TXT, OLI, etc.). Zero instances of block-level ATT as a direct child of PRT/SPT. The .ini grammar allows it, but it doesn't occur in practice — no block-level handling needed.

### 3. THD — Table Header (Part of TBL Fix)

**Occurrences:** 78 tags, always inside TBL.
**Fix:** Parsed as a sub-element of TBL. Stored in the block's `header` field. Rendered as a bold header line above the preformatted body.

### 4. INT — Table Cell Fill (Low Priority)

**Occurrences:** 4 files (33 09 5x series — fire protection).
**Current behavior:** Ignored inside STS/STY parsing.

INT is a self-closing tag inside STY that defines cell background color/pattern:
```xml
<STY SID="s50"><INT COLOR="#f2f2f2" PATTERN="SOLID"/></STY>
```

**Fix:** Extract COLOR and PATTERN attributes from INT inside STY. Store in table block's style data (keyed by STY SID). At render time, cells with a matching STYLEID attribute get `background-color` applied. Only SOLID pattern is supported (the only value in the corpus) — other patterns are ignored. Purely cosmetic.

## Test Suite Design

Two new test files using Node's built-in test runner (not Vitest — avoids OOM on 691-file scan):

### `tests/ufgs-tag-coverage.node-test.mjs`

Scans all 691 .SEC files for every SGML tag, cross-references against the parser's handled/skipped/container sets, and asserts zero unhandled tags.

**Tests (~5):**
- All tags in UFGS master are accounted for (handled, skipped, or container-internal)
- No parse errors on any file
- TBL tags produce `type: "tbl"` blocks (after fix)
- ATT tags produce `mark-att` spans in block HTML (after fix)
- INT attributes are captured in table style data (after fix)

### `tests/ufgs-structural.node-test.mjs`

Parses all 691 files and validates structural properties.

**Tests (~8):**
- Every file produces at least 1 block
- Every file has at least one title block
- All block types are in the known set (`title`, `txt`, `note`, `oli`, `item`, `lst`, `table`, `ref`, `pagebreak`, `tbl`)
- No file has blocks with depth > 10 (sanity check)
- Table blocks have valid structure (rows, cells)
- Ref blocks have org field
- Part numbers are monotonically increasing (some specs skip parts)
- Block count distribution is reasonable (no file has 0 blocks, flag outliers)

**Test design:** Tests use batch assertions within a single `it()` block (per project rule: ≤30 tests per file). For example, "all 691 files parse without error" is one `it()` that loops all files and collects failures, not 691 individual tests. Data-driven edge case checks (e.g., specific TBL files) use `it.each()`.

**Performance budget:** The full 691-file scan must complete in under 60 seconds. The roundtrip test currently runs in ~10s, so parsing alone is fast. The tag extraction scan adds regex overhead per file but should remain under budget.

### npm scripts

```json
{
  "test:ufgs": "node --test tests/ufgs-tag-coverage.node-test.mjs && node --test tests/ufgs-structural.node-test.mjs"
}
```

## Files Modified

| File | Change |
|------|--------|
| `src/lib/sec-parser.js` | Add TBL/THD block parsing, ATT inline mark, INT style extraction |
| `src/lib/sec-serializer.js` | Add TBL/THD serialization, ATT mark round-trip |
| `src/lib/sec-parser.test.js` | Unit tests for TBL, ATT, INT parsing |
| `src/lib/sec-serializer.test.js` | Unit tests for TBL, ATT serialization |
| `src/styles/editor.css` | TBL rendering styles (pre, monospace), mark-att class |
| `src/App.jsx` | Add `type === "tbl"` rendering branch (read-only div) |
| `tests/ufgs-tag-coverage.node-test.mjs` | New — tag coverage regression suite |
| `tests/ufgs-structural.node-test.mjs` | New — structural validation suite |
| `package.json` | Add `test:ufgs` script |
| `CLAUDE.md` | Add TBL editing and Attachment Wizard to Future Features roadmap |

## Out of Scope

- TBL editing (contentEditable for preformatted blocks) — future feature
- Attachment wizard/validation — future feature
- New UI components (TBL rendered as a styled div, not a new React component)
- Compliance rule changes
- Serializer cosmetic differences (header format, whitespace normalization)
- Changes to existing roundtrip test

## Success Criteria

1. `npm run test:ufgs` passes (tag coverage + structural validation)
2. `tools/roundtrip-test.js` still passes all 691 files
3. Existing `npm test` (457 Vitest) still passes
4. The 17 TBL files produce proper `tbl` blocks instead of inlined text
5. ATT marks are preserved through parse → serialize → re-parse
6. INT cell backgrounds render in affected tables
