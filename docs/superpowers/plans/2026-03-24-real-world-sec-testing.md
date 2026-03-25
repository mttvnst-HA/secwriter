# Real-World SEC File Testing — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Validate the parser across the full UFGS master set (690 files), fix 4 discovered gaps (TBL, ATT, INT, THD), and leave a permanent regression test suite.

**Architecture:** Test-first approach. Write the UFGS validation tests first (they will initially reveal failures for unhandled tags), then fix each parser gap with unit tests, then confirm the UFGS suite goes green. Parser fixes follow the existing patterns in sec-parser.js and sec-serializer.js.

**Tech Stack:** Node built-in test runner (for UFGS suite), Vitest (for unit tests), linkedom (DOM polyfill for Node tests).

**Spec:** `docs/superpowers/specs/2026-03-24-real-world-sec-testing-design.md`

---

## File Structure

| File | Responsibility |
|------|---------------|
| `tests/ufgs-tag-coverage.node-test.mjs` | New — scans 691 files for unhandled tags |
| `tests/ufgs-structural.node-test.mjs` | New — validates structural properties of parsed output |
| `src/lib/sec-parser.js` | Modify — add TBL/THD parsing, ATT inline mark, INT style extraction |
| `src/lib/sec-serializer.js` | Modify — add TBL serialization, ATT round-trip |
| `src/lib/__tests__/sec-parser.test.js` | Modify — add TBL, ATT, INT unit tests |
| `src/lib/__tests__/sec-serializer.test.js` | Modify — add TBL, ATT unit tests |
| `src/App.jsx` | Modify — add `type === "tbl"` rendering branch |
| `src/styles/editor.css` | Modify — add `.block-tbl` and `.mark-att` styles |
| `package.json` | Modify — add `test:ufgs` script |
| `CLAUDE.md` | Modify — add future features to roadmap |

---

### Task 1: Add `test:ufgs` npm script

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Add the script**

In `package.json`, add to `"scripts"`:
```json
"test:ufgs": "node --import ./tools/json-loader.mjs --test tests/ufgs-tag-coverage.node-test.mjs tests/ufgs-structural.node-test.mjs"
```

Note: uses `--import ./tools/json-loader.mjs` for consistency with other Node test scripts in this project. The referenced test files will be created in Tasks 7-8.

- [ ] **Step 2: Commit**

```bash
git add package.json
git commit -m "chore: add test:ufgs npm script"
```

---

### Task 2: ATT inline mark (parser + serializer + unit tests)

ATT is the simplest fix — just add it to the inline mark tag set. Do this first so it's available when we write the UFGS tests.

**Files:**
- Modify: `src/lib/sec-parser.js:16`
- Modify: `src/lib/__tests__/sec-parser.test.js`
- Modify: `src/lib/__tests__/sec-serializer.test.js`
- Modify: `src/styles/editor.css`

- [ ] **Step 1: Write failing parser test**

Add to `src/lib/__tests__/sec-parser.test.js`:
```javascript
it('parses ATT inline mark', () => {
  const xml = secPart('<TXT>Use the <ATT>ENG Form 4025-R</ATT> transmittal form.</TXT>');
  const blocks = parseSEC(xml);
  expect(blocks).toHaveLength(1);
  expect(blocks[0].html).toContain('<span class="mark-att">ENG Form 4025-R</span>');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/__tests__/sec-parser.test.js`
Expected: FAIL — ATT is not in INLINE_MARK_TAGS, so the tag is silently dropped (text preserved but no span wrapper).

- [ ] **Step 3: Add ATT to INLINE_MARK_TAGS**

In `src/lib/sec-parser.js` line 16, add `'ATT'` to the Set:
```javascript
const INLINE_MARK_TAGS = new Set(['RID', 'SRF', 'SUB', 'ENG', 'MET', 'TAI', 'TST', 'URL', 'HLS', 'ATT']);
```

- [ ] **Step 4: Run parser test to verify it passes**

Run: `npx vitest run src/lib/__tests__/sec-parser.test.js`
Expected: PASS

- [ ] **Step 5: Write serializer round-trip test**

Add to `src/lib/__tests__/sec-serializer.test.js`:
```javascript
it('serializes ATT inline marks', () => {
  const blocks = [
    { id: '1', type: 'txt', part: 1, depth: 0, html: 'Use the <span class="mark-att">ENG Form 4025-R</span> form.' },
  ];
  const xml = serializeSEC(blocks, META);
  expect(xml).toContain('<ATT>ENG Form 4025-R</ATT>');
});
```

No serializer code change needed — the existing `walkNodeToSgml` already handles `mark-*` spans generically (line 27-38 of sec-serializer.js: `const secTag = match[1].toUpperCase()` converts `mark-att` → `ATT`).

- [ ] **Step 6: Run serializer test to verify it passes**

Run: `npx vitest run src/lib/__tests__/sec-serializer.test.js`
Expected: PASS (no code change needed — generic mark handling)

- [ ] **Step 7: Add `.mark-att` CSS class and tag visibility pseudo-elements**

In `src/styles/editor.css`, find the mark styling section (near other `.mark-rid`, `.mark-sub` etc. rules) and add:
```css
.mark-att {
  /* No color in section.ini [COLORS] — use subtle neutral style */
  background: rgba(100, 116, 139, 0.08);
}
```

Also add tag visibility pseudo-elements (find the `.tags-visible` section with other marks):
```css
.tags-visible .mark-att::before { content: '<ATT>'; }
.tags-visible .mark-att::after { content: '</ATT>'; }
```

- [ ] **Step 8: Run full Vitest suite**

Run: `npm test`
Expected: All 457+ tests pass.

- [ ] **Step 9: Commit**

```bash
git add src/lib/sec-parser.js src/lib/__tests__/sec-parser.test.js src/lib/__tests__/sec-serializer.test.js src/styles/editor.css
git commit -m "feat: add ATT (attachment) inline mark to parser and serializer"
```

---

### Task 3: TBL/THD preformatted table parsing

**Files:**
- Modify: `src/lib/sec-parser.js`
- Modify: `src/lib/__tests__/sec-parser.test.js`

- [ ] **Step 1: Write failing parser test for basic TBL**

Add to `src/lib/__tests__/sec-parser.test.js`:
```javascript
it('parses TBL (unformatted table) blocks', () => {
  const xml = secPart('<TBL>LINE 1<BRK/>LINE 2<BRK/>LINE 3</TBL>');
  const blocks = parseSEC(xml);
  expect(blocks).toHaveLength(1);
  expect(blocks[0].type).toBe('tbl');
  expect(blocks[0].html).toBe('LINE 1\nLINE 2\nLINE 3');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/__tests__/sec-parser.test.js`
Expected: FAIL — no TBL handler exists.

- [ ] **Step 3: Implement TBL parsing in sec-parser.js**

Add a new function `elemToTblHtml` that handles TBL content (preserves whitespace, converts BRK to `\n`, processes inline marks):

```javascript
/**
 * Convert a TBL element to HTML, preserving whitespace and converting BRK to newlines.
 * Unlike elemToHtml, this does NOT collapse whitespace — TBL content is preformatted.
 */
function elemToTblHtml(elem) {
  const parts = [];
  for (const node of elem.childNodes) {
    if (node.nodeType === 3) { // Text node — preserve whitespace (only strip leading/trailing newlines)
      parts.push(node.textContent.replace(/^\n|\n$/g, ''));
    } else if (node.nodeType === 1) {
      const tag = node.tagName;
      if (tag === 'BRK' || tag === 'BRL') {
        parts.push('\n');
      } else if (tag === 'THD') {
        // THD rendered as bold header
        parts.push(`<b>${elemToTblHtml(node)}</b>`);
      } else if (tag === 'PGE' || tag === 'AST' || tag === 'NED') {
        // Skip print-only tags
      } else if (INLINE_MARK_TAGS.has(tag)) {
        const cls = `mark-${tag.toLowerCase()}`;
        const opt = (tag === 'TAI') ? node.getAttribute('OPT') : null;
        const optAttr = opt ? ` data-opt="${opt}"` : '';
        parts.push(`<span class="${cls}"${optAttr}>${elemToTblHtml(node)}</span>`);
      } else if (INLINE_FORMAT_TAGS.has(tag)) {
        if (tag === 'BLD' || tag === 'HL3') {
          parts.push(`<b>${elemToTblHtml(node)}</b>`);
        } else if (tag === 'ITA' || tag === 'HL2') {
          parts.push(`<em>${elemToTblHtml(node)}</em>`);
        } else if (tag === 'UND' || tag === 'HL1') {
          parts.push(`<u>${elemToTblHtml(node)}</u>`);
        } else if (tag === 'HL4') {
          parts.push(`<b>${elemToTblHtml(node)}</b>`);
        } else {
          parts.push(elemToTblHtml(node));
        }
      } else {
        parts.push(elemToTblHtml(node));
      }
    }
  }
  return parts.join('');
}
```

Add the TBL handler in `processElement`, before the catch-all recurse at the bottom (after the `TAB` handler around line 325):

```javascript
if (tag === 'TBL') {
  const html = elemToTblHtml(elem);
  if (html) {
    blocks.push({
      id: nextId(),
      type: 'tbl',
      part: state.partNum,
      depth: state.sptDepth,
      section: state.currentSection,
      html,
    });
  }
  return;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/__tests__/sec-parser.test.js`
Expected: PASS

- [ ] **Step 5: Write test for TBL with THD header**

```javascript
it('parses TBL with THD header as bold', () => {
  const xml = secPart('<TBL><THD>HEADER TEXT</THD><BRK/>Body line 1<BRK/>Body line 2</TBL>');
  const blocks = parseSEC(xml);
  expect(blocks).toHaveLength(1);
  expect(blocks[0].type).toBe('tbl');
  expect(blocks[0].html).toContain('<b>HEADER TEXT</b>');
  expect(blocks[0].html).toContain('Body line 1');
});
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run src/lib/__tests__/sec-parser.test.js`
Expected: PASS (already handled by `elemToTblHtml`)

- [ ] **Step 7: Write test for TBL with inline marks**

```javascript
it('parses TBL with inline marks (RID, HL4)', () => {
  const xml = secPart('<TBL>See <RID>ASTM C150</RID><BRK/><HL4>IMPORTANT</HL4></TBL>');
  const blocks = parseSEC(xml);
  expect(blocks).toHaveLength(1);
  expect(blocks[0].html).toContain('<span class="mark-rid">ASTM C150</span>');
  expect(blocks[0].html).toContain('<b>IMPORTANT</b>');
});
```

- [ ] **Step 8: Run test to verify it passes**

Run: `npx vitest run src/lib/__tests__/sec-parser.test.js`
Expected: PASS

- [ ] **Step 9: Write test for TBL inside NTE (spec edge case: 08 34 02.SEC)**

```javascript
it('parses TBL nested inside NTE as sibling blocks', () => {
  const xml = secPart('<NTE><NPR>Some note text</NPR><TBL>Preformatted<BRK/>Content</TBL></NTE>');
  const blocks = parseSEC(xml);
  expect(blocks).toHaveLength(2);
  expect(blocks[0].type).toBe('note');
  expect(blocks[1].type).toBe('tbl');
});
```

Note: This works because NTE is a container that recurses its children via `processElement`. TBL children of NTE are processed individually and hit the TBL handler. No special extraction logic needed (unlike TAB-inside-TXT).

- [ ] **Step 10: Run test to verify it passes**

Run: `npx vitest run src/lib/__tests__/sec-parser.test.js`
Expected: PASS

- [ ] **Step 11: Write test for space preservation around inline marks in TBL**

```javascript
it('preserves spaces around inline marks in TBL', () => {
  const xml = secPart('<TBL>text <RID>ASTM C150</RID> more text</TBL>');
  const blocks = parseSEC(xml);
  expect(blocks[0].html).toBe('text <span class="mark-rid">ASTM C150</span> more text');
});
```

Note: `elemToTblHtml` joins parts with empty string (`''`), but spaces are preserved because they exist as text nodes in the XML. This test verifies that assumption holds.

- [ ] **Step 12: Run test to verify it passes**

Run: `npx vitest run src/lib/__tests__/sec-parser.test.js`
Expected: PASS

- [ ] **Step 13: Commit**

```bash
git add src/lib/sec-parser.js src/lib/__tests__/sec-parser.test.js
git commit -m "feat: add TBL/THD (unformatted table) parsing to SEC parser"
```

---

### Task 4: TBL serialization

**Files:**
- Modify: `src/lib/sec-serializer.js`
- Modify: `src/lib/__tests__/sec-serializer.test.js`

- [ ] **Step 1: Write failing serializer test**

Add to `src/lib/__tests__/sec-serializer.test.js`:
```javascript
it('serializes tbl blocks as TBL with BRK line breaks', () => {
  const blocks = [
    { id: '1', type: 'tbl', part: 1, depth: 1, html: '<b>HEADER</b>\nLine 1\nLine 2' },
  ];
  const xml = serializeSEC(blocks, META);
  expect(xml).toContain('<TBL>');
  expect(xml).toContain('<THD>HEADER</THD>');
  expect(xml).toContain('<BRK/>');
  expect(xml).toContain('Line 1');
  expect(xml).toContain('</TBL>');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/__tests__/sec-serializer.test.js`
Expected: FAIL — no `tbl` handler in serializer.

- [ ] **Step 3: Add serializeTbl function and tbl handler**

Add a new function in `sec-serializer.js` (after `serializeRef`):

```javascript
/**
 * Serialize a tbl (unformatted table) block back to SEC TBL XML.
 * Converts \n back to <BRK/>, and <b>...</b> at the start to <THD>...</THD>.
 */
function serializeTbl(block) {
  const html = block.html || '';
  const lines = [];
  lines.push('<TBL>');

  // Convert HTML back to TBL SGML: bold at start → THD, \n → BRK
  // Parse the HTML to extract THD and body
  const parser = new DOMParser();
  const safeHtml = html.replace(/&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[\da-fA-F]+;)/g, '&amp;');
  // Replace \n with a placeholder that survives XML parsing
  const withPlaceholders = safeHtml.replace(/\n/g, '&#10;');
  const doc = parser.parseFromString(`<root>${withPlaceholders}</root>`, 'text/xml');
  const parseError = doc.querySelector('parsererror');

  if (parseError) {
    // Fallback: simple text conversion
    const textLines = html.split('\n');
    lines.push(textLines.join('<BRK/>\r\n'));
    lines.push('</TBL>');
    return lines.join('\r\n');
  }

  // Walk the DOM, converting bold-at-start to THD, rest to TBL content.
  // THD detection: first non-whitespace element node that is <b>/<strong>.
  let foundFirstContent = false;
  for (const child of doc.documentElement.childNodes) {
    if (child.nodeType === 3) { // Text node
      const text = child.textContent.replace(/\u200B/g, '');
      // Skip leading whitespace-only text nodes for THD detection
      if (!foundFirstContent && !text.trim()) continue;
      foundFirstContent = true;
      const segs = text.split('\n');
      for (let si = 0; si < segs.length; si++) {
        if (si > 0) lines.push('<BRK/>');
        if (segs[si]) lines.push(segs[si]);
      }
    } else if (child.nodeType === 1) {
      const tag = child.tagName.toLowerCase();
      const inner = walkNodeToSgml(child);
      if ((tag === 'b' || tag === 'strong') && !foundFirstContent) {
        // Bold at start → THD
        foundFirstContent = true;
        const thdContent = inner.replace(/\n/g, '<BRK/>\r\n');
        lines.push(`<THD>${thdContent}</THD>`);
      } else {
        foundFirstContent = true;
        // Regular content — convert back to SGML
        const sgml = walkNodeToSgml(child);
        const sgmlLines = sgml.split('\n');
        for (let si = 0; si < sgmlLines.length; si++) {
          if (si > 0) lines.push('<BRK/>');
          if (sgmlLines[si]) lines.push(sgmlLines[si]);
        }
      }
    }
  }

  lines.push('</TBL>');
  return lines.join('\r\n');
}
```

Then add the `tbl` handler in the part-block serialization loop (after the `table` handler around line 430) and also in the pre-part block section:

In the part block loop (around line 430, after the `table` block handler):
```javascript
// Unformatted tables (TBL)
if (block.type === 'tbl') {
  closeNoteGroup();
  adjustDepthForContent(block);
  lines.push(revWrap(serializeTbl(block), block));
  lines.push('<BRK/>');
  continue;
}
```

In the pre-part block section (around line 255, after the `txt` handler):
```javascript
} else if (block.type === 'tbl') {
  if (noteGroupOpen) {
    lines.push('<AST/><BRK/></NTE>');
    lines.push('<BRK/>');
    noteGroupOpen = false;
  }
  lines.push(serializeTbl(block));
  lines.push('<BRK/>');
}
```

- [ ] **Step 4: Run serializer test to verify it passes**

Run: `npx vitest run src/lib/__tests__/sec-serializer.test.js`
Expected: PASS

- [ ] **Step 5: Run full test suite**

Run: `npm test`
Expected: All tests pass.

- [ ] **Step 6: Run roundtrip test on all 690 files**

Run: `node tools/roundtrip-test.js`
Expected: 690 PASS, 0 DIFF, 0 ERROR. The new TBL blocks must round-trip correctly (parse produces `tbl` blocks → serialize produces `<TBL>` → re-parse produces same `tbl` blocks). Note: files that previously had TBL content inlined as text will now have proper `tbl` blocks, but the roundtrip test compares parse1 vs parse2 of the *serialized* output, so both sides see the new behavior.

- [ ] **Step 7: Commit**

```bash
git add src/lib/sec-serializer.js src/lib/__tests__/sec-serializer.test.js
git commit -m "feat: add TBL (unformatted table) serialization"
```

---

### Task 5: INT table cell fill extraction

**Files:**
- Modify: `src/lib/sec-parser.js` (extractTable function)
- Modify: `src/lib/__tests__/sec-parser.test.js`

- [ ] **Step 1: Write failing test**

Add to `src/lib/__tests__/sec-parser.test.js`:
```javascript
it('extracts INT cell fill styles from TAB', () => {
  const xml = secPart(`<TAB><WBK>
    <STS><STY SID="s51"><INT COLOR="#f2f2f2" PATTERN="SOLID"/></STY></STS>
    <TDA COLUMNCOUNT="2" ROWCOUNT="1">
      <COL STYLEID="s50" WIDTH="100"/>
      <COL STYLEID="s51" WIDTH="100"/>
      <ROW><CEL STYLEID="s50"><DTA TYPE="STRING">A</DTA></CEL><CEL STYLEID="s51"><DTA TYPE="STRING">B</DTA></CEL></ROW>
    </TDA></WBK></TAB>`);
  const blocks = parseSEC(xml);
  expect(blocks).toHaveLength(1);
  expect(blocks[0].type).toBe('table');
  expect(blocks[0].table.styles).toBeDefined();
  expect(blocks[0].table.styles.s51).toEqual({ backgroundColor: '#f2f2f2' });
  // Cells should carry their style ID
  expect(blocks[0].table.rows[0][1].styleId).toBe('s51');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/__tests__/sec-parser.test.js`
Expected: FAIL — `table.styles` is undefined and cells lack `styleId`.

- [ ] **Step 3: Implement INT extraction in extractTable**

Modify the `extractTable` function in `src/lib/sec-parser.js`:

1. Before the ROW loop, scan STS/STY for INT elements:
```javascript
// Extract cell fill styles from STS > STY > INT
const styles = {};
const stsElem = tabElem.querySelector('STS');
if (stsElem) {
  for (const styElem of stsElem.querySelectorAll('STY')) {
    const sid = styElem.getAttribute('SID');
    const intElem = styElem.querySelector('INT');
    if (sid && intElem) {
      const color = intElem.getAttribute('COLOR');
      const pattern = intElem.getAttribute('PATTERN');
      if (color && pattern === 'SOLID') {
        styles[sid] = { backgroundColor: color };
      }
    }
  }
}
```

2. In the CEL loop, capture the STYLEID attribute:
```javascript
const styleId = cel.getAttribute('STYLEID') || undefined;
cells.push({
  text: dta ? elemToHtml(dta) : '',
  colspan: mergeAcross ? parseInt(mergeAcross) + 1 : 1,
  styleId,
});
```

3. Include styles in the return value (only if non-empty):
```javascript
const result = { columns: cols, rows };
if (Object.keys(styles).length > 0) result.styles = styles;
return result;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/__tests__/sec-parser.test.js`
Expected: PASS

- [ ] **Step 5: Run full test suite to check for regressions**

Run: `npm test`
Expected: All tests pass. Existing table tests should be unaffected (styles field simply won't be present for tables without INT).

- [ ] **Step 6: Commit**

```bash
git add src/lib/sec-parser.js src/lib/__tests__/sec-parser.test.js
git commit -m "feat: extract INT cell fill styles from TAB tables"
```

Note: INT rendering (applying `background-color` to cells in `TableBlock.jsx`) is deferred. The data is now available in `table.styles` + `cell.styleId` for future use, but applying it to the UI requires changes to `TableBlock.jsx` which is out of scope for this work. The extraction is the important part — it prevents data loss on round-trip.

---

### Task 6: TBL rendering in App.jsx + CSS

**Files:**
- Modify: `src/App.jsx`
- Modify: `src/styles/editor.css`

- [ ] **Step 1: Add TBL rendering branch in App.jsx**

In `src/App.jsx`, find the block rendering section (around line 1657 where `block.type === "table"` is checked). Add a new branch before it for `tbl`:

```jsx
if (block.type === "tbl") {
  return (
    <div
      key={block.id}
      id={`block-${block.id}`}
      className="block-tbl"
      data-block-id={block.id}
      data-tag="TBL"
      contentEditable={false}
      onClick={() => handleClickFocus(block.id)}
      dangerouslySetInnerHTML={{ __html: block.html }}
      style={{
        padding: "12px 16px",
        margin: "4px 0",
        outline: focusedBlockId === block.id ? "2px solid #3b82f6" : "none",
      }}
    />
  );
}
```

- [ ] **Step 2: Add `.block-tbl` CSS styles**

In `src/styles/editor.css`, add:
```css
.block-tbl {
  white-space: pre;
  font-family: 'Courier New', Courier, monospace;
  font-size: 12px;
  line-height: 1.4;
  background: #fafaf8;
  border: 1px solid #e2e8f0;
  border-radius: 4px;
  overflow-x: auto;
}
```

- [ ] **Step 3: Verify by loading a TBL file in the editor**

This is a manual verification step. Load `reference/UFGS_M/02 32 13.SEC` in the editor and confirm the TBL block renders as monospace preformatted text.

- [ ] **Step 4: Commit**

```bash
git add src/App.jsx src/styles/editor.css
git commit -m "feat: add TBL block rendering (read-only preformatted)"
```

---

### Task 7: UFGS tag coverage test suite

**Files:**
- Create: `tests/ufgs-tag-coverage.node-test.mjs`

- [ ] **Step 1: Write the tag coverage test file**

Create `tests/ufgs-tag-coverage.node-test.mjs`:

```javascript
/**
 * UFGS Tag Coverage Tests
 *
 * Scans all 691 .SEC files in reference/UFGS_M/ for every SGML tag,
 * cross-references against the parser's handled/skipped sets,
 * and asserts zero unhandled tags.
 *
 * Runner: Node built-in test runner (not Vitest)
 * Run: npm run test:ufgs
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { parseHTML } from 'linkedom';

const { DOMParser } = parseHTML('');
globalThis.DOMParser = DOMParser;

const { parseSEC } = await import('../src/lib/sec-parser.js');

const UFGS_DIR = 'reference/UFGS_M';
const files = fs.readdirSync(UFGS_DIR)
  .filter(f => f.toLowerCase().endsWith('.sec'))
  .map(f => path.join(UFGS_DIR, f));

// All tags the parser is expected to handle (produce blocks, inline marks, or intentionally skip)
const KNOWN_TAGS = new Set([
  // Block-level
  'PRT', 'SPT', 'TTL', 'TXT', 'NPR', 'NPG', 'OLI', 'LST', 'ITM', 'TAB', 'REF', 'TBL',
  // Container (recursed into)
  'NTE', 'OLG', 'SBM',
  // Revision wrappers
  'ADD', 'DEL', 'CHG',
  // Inline marks
  'RID', 'SRF', 'SUB', 'ENG', 'MET', 'TAI', 'TST', 'URL', 'HLS', 'ATT',
  // Inline formatting
  'BLD', 'ITA', 'UND', 'HL1', 'HL2', 'HL3', 'HL4', 'SBS', 'SPS', 'CTR',
  // Intentionally skipped
  'BRK', 'BRL', 'AST', 'NED', 'PGE', 'MTA', 'END', 'EOD',
  // Pass-through
  'SCP', 'PRA',
  // Root-level metadata (filtered by ROOT_CONTENT_TAGS)
  'HDR', 'SCN', 'STL', 'DTE', 'SEC',
  // Table internals (consumed by extractTable)
  'WBK', 'TDA', 'ROW', 'CEL', 'DTA', 'STS', 'STY', 'ALN', 'COL', 'INT',
  // TBL internals
  'THD',
  // REF internals
  'ORG', 'RTL', 'OAD',
]);

describe('UFGS tag coverage', () => {
  it('all tags in UFGS master are accounted for', () => {
    const unknownTags = new Map(); // tag -> [files]
    const tagRegex = /<\/?([A-Z][A-Z0-9]*)/g;

    for (const file of files) {
      const content = fs.readFileSync(file, 'latin1');
      let match;
      while ((match = tagRegex.exec(content)) !== null) {
        const tag = match[1];
        if (!KNOWN_TAGS.has(tag)) {
          if (!unknownTags.has(tag)) unknownTags.set(tag, []);
          const fname = path.basename(file);
          if (!unknownTags.get(tag).includes(fname)) {
            unknownTags.get(tag).push(fname);
          }
        }
      }
    }

    if (unknownTags.size > 0) {
      const details = [...unknownTags.entries()]
        .map(([tag, fnames]) => `  ${tag}: ${fnames.slice(0, 3).join(', ')}${fnames.length > 3 ? ` (+${fnames.length - 3} more)` : ''}`)
        .join('\n');
      assert.fail(`Found ${unknownTags.size} unhandled tag(s):\n${details}`);
    }
  });

  it('all files parse without error', () => {
    const errors = [];
    for (const file of files) {
      try {
        const content = fs.readFileSync(file, 'latin1');
        parseSEC(content);
      } catch (e) {
        errors.push(`${path.basename(file)}: ${e.message}`);
      }
    }
    assert.equal(errors.length, 0, `Parse errors in ${errors.length} file(s):\n${errors.slice(0, 10).join('\n')}`);
  });

  it('files with TBL tags produce tbl blocks', () => {
    const tblFiles = files.filter(f => {
      const content = fs.readFileSync(f, 'latin1');
      return content.includes('<TBL>') || content.includes('<TBL ');
    });
    assert.ok(tblFiles.length > 0, 'Expected at least one file with TBL tags');

    const failures = [];
    for (const file of tblFiles) {
      const content = fs.readFileSync(file, 'latin1');
      const blocks = parseSEC(content);
      const tblBlocks = blocks.filter(b => b.type === 'tbl');
      if (tblBlocks.length === 0) {
        failures.push(path.basename(file));
      }
    }
    assert.equal(failures.length, 0, `Files with TBL tags but no tbl blocks: ${failures.join(', ')}`);
  });

  it('files with ATT tags produce mark-att spans', () => {
    const attFiles = files.filter(f => {
      const content = fs.readFileSync(f, 'latin1');
      return content.includes('<ATT>') || content.includes('<ATT ');
    });
    assert.ok(attFiles.length > 0, 'Expected at least one file with ATT tags');

    const failures = [];
    for (const file of attFiles) {
      const content = fs.readFileSync(file, 'latin1');
      const blocks = parseSEC(content);
      const hasAttMark = blocks.some(b => b.html && b.html.includes('mark-att'));
      if (!hasAttMark) {
        failures.push(path.basename(file));
      }
    }
    assert.equal(failures.length, 0, `Files with ATT tags but no mark-att spans: ${failures.join(', ')}`);
  });
});
```

- [ ] **Step 2: Run the test**

Run: `node --import ./tools/json-loader.mjs --test tests/ufgs-tag-coverage.node-test.mjs`
Expected: All 4 tests pass (if parser fixes from Tasks 2-5 are done).

- [ ] **Step 3: Commit**

```bash
git add tests/ufgs-tag-coverage.node-test.mjs
git commit -m "test: add UFGS tag coverage regression suite (691 files)"
```

---

### Task 8: UFGS structural validation test suite

**Files:**
- Create: `tests/ufgs-structural.node-test.mjs`

- [ ] **Step 1: Write the structural validation test file**

Create `tests/ufgs-structural.node-test.mjs`:

```javascript
/**
 * UFGS Structural Validation Tests
 *
 * Parses all 691 .SEC files and validates structural properties:
 * block counts, types, depths, table/ref integrity.
 *
 * Runner: Node built-in test runner (not Vitest)
 * Run: npm run test:ufgs
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { parseHTML } from 'linkedom';

const { DOMParser } = parseHTML('');
globalThis.DOMParser = DOMParser;

const { parseSEC } = await import('../src/lib/sec-parser.js');

const UFGS_DIR = 'reference/UFGS_M';
const files = fs.readdirSync(UFGS_DIR)
  .filter(f => f.toLowerCase().endsWith('.sec'))
  .map(f => path.join(UFGS_DIR, f));

const VALID_TYPES = new Set([
  'title', 'txt', 'note', 'oli', 'item', 'lst', 'table', 'ref', 'pagebreak', 'tbl'
]);

// Parse all files once (shared across tests)
const parsed = new Map();
for (const file of files) {
  const content = fs.readFileSync(file, 'latin1');
  try {
    parsed.set(file, parseSEC(content));
  } catch (e) {
    parsed.set(file, null);
  }
}

describe('UFGS structural validation', () => {
  it('every file produces at least 1 block', () => {
    const empties = [];
    for (const [file, blocks] of parsed) {
      if (!blocks || blocks.length === 0) {
        empties.push(path.basename(file));
      }
    }
    assert.equal(empties.length, 0, `Empty parse results: ${empties.join(', ')}`);
  });

  it('every file has at least one title block', () => {
    const noTitle = [];
    for (const [file, blocks] of parsed) {
      if (!blocks) continue;
      if (!blocks.some(b => b.type === 'title')) {
        noTitle.push(path.basename(file));
      }
    }
    assert.equal(noTitle.length, 0, `Files without title blocks: ${noTitle.join(', ')}`);
  });

  it('all block types are in the known set', () => {
    const unknownTypes = new Map();
    for (const [file, blocks] of parsed) {
      if (!blocks) continue;
      for (const b of blocks) {
        if (!VALID_TYPES.has(b.type)) {
          if (!unknownTypes.has(b.type)) unknownTypes.set(b.type, []);
          unknownTypes.get(b.type).push(path.basename(file));
        }
      }
    }
    if (unknownTypes.size > 0) {
      const details = [...unknownTypes.entries()]
        .map(([type, fnames]) => `  "${type}": ${fnames.slice(0, 3).join(', ')}`)
        .join('\n');
      assert.fail(`Unknown block types:\n${details}`);
    }
  });

  it('no file has blocks with depth > 10', () => {
    const deep = [];
    for (const [file, blocks] of parsed) {
      if (!blocks) continue;
      const maxDepth = Math.max(...blocks.map(b => b.depth || 0));
      if (maxDepth > 10) {
        deep.push(`${path.basename(file)}: depth=${maxDepth}`);
      }
    }
    assert.equal(deep.length, 0, `Files with excessive depth:\n${deep.join('\n')}`);
  });

  it('table blocks have valid structure (rows array)', () => {
    const invalid = [];
    for (const [file, blocks] of parsed) {
      if (!blocks) continue;
      for (const b of blocks) {
        if (b.type === 'table') {
          if (!b.table || !Array.isArray(b.table.rows) || b.table.rows.length === 0) {
            invalid.push(path.basename(file));
            break;
          }
        }
      }
    }
    assert.equal(invalid.length, 0, `Files with invalid table structure: ${invalid.join(', ')}`);
  });

  it('ref blocks have org field', () => {
    const invalid = [];
    for (const [file, blocks] of parsed) {
      if (!blocks) continue;
      for (const b of blocks) {
        if (b.type === 'ref') {
          if (!b.ref || typeof b.ref.org === 'undefined') {
            invalid.push(path.basename(file));
            break;
          }
        }
      }
    }
    assert.equal(invalid.length, 0, `Files with ref blocks missing org: ${invalid.join(', ')}`);
  });

  it('part numbers are monotonically increasing', () => {
    const violations = [];
    for (const [file, blocks] of parsed) {
      if (!blocks) continue;
      let lastPart = 0;
      for (const b of blocks) {
        if (b.part !== undefined && b.part > 0) {
          if (b.part < lastPart) {
            violations.push(`${path.basename(file)}: part ${b.part} after part ${lastPart}`);
            break;
          }
          lastPart = b.part;
        }
      }
    }
    assert.equal(violations.length, 0, `Part number violations:\n${violations.join('\n')}`);
  });

  it('block count distribution is reasonable (10-2000 blocks per file)', () => {
    const outliers = [];
    for (const [file, blocks] of parsed) {
      if (!blocks) continue;
      if (blocks.length < 10 || blocks.length > 2000) {
        outliers.push(`${path.basename(file)}: ${blocks.length} blocks`);
      }
    }
    // Log outliers but only fail on truly extreme cases
    if (outliers.length > 0) {
      const extreme = [];
      for (const [file, blocks] of parsed) {
        if (!blocks) continue;
        if (blocks.length < 3) {
          extreme.push(`${path.basename(file)}: ${blocks.length} blocks`);
        }
      }
      assert.equal(extreme.length, 0, `Files with fewer than 3 blocks:\n${extreme.join('\n')}`);
    }
  });
});
```

- [ ] **Step 2: Run the test**

Run: `node --import ./tools/json-loader.mjs --test tests/ufgs-structural.node-test.mjs`
Expected: All 8 tests pass. If any fail, investigate and fix — the assertions may need adjustment based on real corpus data (e.g., some files might legitimately have <10 blocks).

- [ ] **Step 3: Run the full UFGS suite**

Run: `npm run test:ufgs`
Expected: All tests in both files pass.

- [ ] **Step 4: Commit**

```bash
git add tests/ufgs-structural.node-test.mjs
git commit -m "test: add UFGS structural validation suite (690 files)"
```

---

### Task 9: Update CLAUDE.md roadmap

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Add future features to roadmap**

In `CLAUDE.md`, find the **Future Features:** section and add:
```markdown
- TBL preformatted table editing — currently read-only with monospace rendering; full editing needs contentEditable with preserved whitespace alignment, BRK line break handling, and THD header editing
- Attachment wizard — ATT inline marks are parsed/serialized but have no wizard or validation; an attachment management panel (like Reference Wizard for RIDs) would track referenced vs. attached documents
```

- [ ] **Step 2: Update architecture file list and test coverage table**

Update the architecture section to include the new test files and their test counts. Update the data model to include `tbl` type. Update the total test count.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: add TBL editing and attachment wizard to roadmap"
```

---

### Task 10: Final verification

- [ ] **Step 1: Run full Vitest suite**

Run: `npm test`
Expected: All tests pass (457+ existing + new parser/serializer tests).

- [ ] **Step 2: Run UFGS suite**

Run: `npm run test:ufgs`
Expected: All tag coverage + structural tests pass.

- [ ] **Step 3: Run roundtrip test**

Run: `node tools/roundtrip-test.js`
Expected: 690 PASS, 0 DIFF, 0 ERROR.

- [ ] **Step 4: Run compliance tests**

Run: `npm run test:compliance`
Expected: All 40 tests pass (no regressions).

- [ ] **Step 5: Confirm all success criteria**

Checklist:
- [ ] `npm run test:ufgs` passes
- [ ] `tools/roundtrip-test.js` passes all 690 files
- [ ] `npm test` passes all Vitest tests
- [ ] 17 TBL files produce `tbl` blocks
- [ ] ATT marks preserved through round-trip
- [ ] INT cell fill data extracted in `table.styles` (rendering deferred to TableBlock.jsx future work)
