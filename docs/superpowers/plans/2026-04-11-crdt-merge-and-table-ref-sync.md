# Character-Level CRDT Merge + Fine-Grained Table/REF Sync — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace whole-text replacement and JSON last-write-wins in SIM's Yjs collab layer with character-level Y.Text CRDT (with formatting attributes) for text blocks, and nested Yjs structures for table/REF blocks — enabling true concurrent editing.

**Architecture:** A new `ytext-html.js` module provides bidirectional conversion between HTML strings (what contentEditable uses) and Y.Text with formatting attributes (what Yjs CRDTs use). Table and REF blocks get dedicated `ytable-crdt.js` and `yref-crdt.js` modules that model cell text as Y.Text and structural data as nested Y.Array/Y.Map. `collab.js` is modified to call these converters instead of doing whole-text/JSON replacement. The sec-parser, sec-serializer, and all React components are unchanged.

**Tech Stack:** Yjs (Y.Text formatting attributes, Y.Array, Y.Map), DOMParser (browser + linkedom on server)

**Design spec:** `docs/superpowers/specs/2026-04-11-collab-hardening-design.md` (Features 1 + 2)

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `src/lib/ytext-html.js` | Create | HTML ↔ Y.Text+attributes bidirectional converter |
| `src/lib/ytable-crdt.js` | Create | Table data ↔ nested Yjs structure converter |
| `src/lib/yref-crdt.js` | Create | REF data ↔ nested Yjs structure converter |
| `src/lib/collab.js` | Modify | Replace whole-text and JSON_KEYS with converter calls |
| `server/room-serializer.cjs` | Modify | Handle Y.Text attributes when serializing to .SEC |
| `src/lib/__tests__/ytext-html.test.js` | Create | Tests for HTML ↔ Y.Text conversion |
| `src/lib/__tests__/ytable-crdt.test.js` | Create | Tests for table CRDT operations |
| `src/lib/__tests__/yref-crdt.test.js` | Create | Tests for REF CRDT operations |
| `src/lib/__tests__/collab.test.js` | Modify | Add two-doc merge tests for attributes, tables, refs |

---

## Task 1: `yTextToHtml` — Y.Text Deltas to HTML String

**Files:**
- Create: `src/lib/__tests__/ytext-html.test.js`
- Create: `src/lib/ytext-html.js`

This is the receive direction: convert Y.Text (with formatting attributes) into an HTML string that EditableBlock can render. Pure string construction — no DOM needed.

- [ ] **Step 1: Write failing tests for `yTextToHtml`**

```javascript
// src/lib/__tests__/ytext-html.test.js
import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import { yTextToHtml } from '../ytext-html.js';

/** Helper: build a Y.Text from a delta array. */
function makeYText(deltas) {
  const ydoc = new Y.Doc();
  const yText = ydoc.getText('test');
  ydoc.transact(() => {
    let pos = 0;
    for (const d of deltas) {
      yText.insert(pos, d.insert, d.attributes || {});
      pos += d.insert.length;
    }
  });
  return yText;
}

describe('yTextToHtml', () => {
  it('converts plain text with no attributes', () => {
    const yText = makeYText([{ insert: 'Hello world' }]);
    expect(yTextToHtml(yText)).toBe('Hello world');
  });

  it('converts bold attribute to <b> tag', () => {
    const yText = makeYText([
      { insert: 'Hello ' },
      { insert: 'bold', attributes: { bold: true } },
      { insert: ' world' },
    ]);
    expect(yTextToHtml(yText)).toBe('Hello <b>bold</b> world');
  });

  it('converts italic attribute to <i> tag', () => {
    const yText = makeYText([
      { insert: 'Hello ' },
      { insert: 'italic', attributes: { italic: true } },
    ]);
    expect(yTextToHtml(yText)).toBe('Hello <i>italic</i>');
  });

  it('converts underline attribute to <u> tag', () => {
    const yText = makeYText([
      { insert: 'underlined', attributes: { underline: true } },
    ]);
    expect(yTextToHtml(yText)).toBe('<u>underlined</u>');
  });

  it('converts mark attribute to <span class="mark-XXX">', () => {
    const yText = makeYText([
      { insert: 'See ' },
      { insert: 'ASTM C33', attributes: { mark: 'rid' } },
      { insert: ' for details' },
    ]);
    expect(yTextToHtml(yText)).toBe('See <span class="mark-rid">ASTM C33</span> for details');
  });

  it('converts tai mark with markOption to data-opt attribute', () => {
    const yText = makeYText([
      { insert: 'tailored text', attributes: { mark: 'tai', markOption: 'OPTION_A' } },
    ]);
    expect(yTextToHtml(yText)).toBe('<span class="mark-tai" data-opt="OPTION_A">tailored text</span>');
  });

  it('converts revision "add" to <ins class="mark-add">', () => {
    const yText = makeYText([
      { insert: 'added text', attributes: { revision: 'add' } },
    ]);
    expect(yTextToHtml(yText)).toBe('<ins class="mark-add">added text</ins>');
  });

  it('converts revision "del" to <del class="mark-del">', () => {
    const yText = makeYText([
      { insert: 'deleted', attributes: { revision: 'del' } },
    ]);
    expect(yTextToHtml(yText)).toBe('<del class="mark-del">deleted</del>');
  });

  it('converts revision "chg" to <span class="mark-chg">', () => {
    const yText = makeYText([
      { insert: 'changed', attributes: { revision: 'chg' } },
    ]);
    expect(yTextToHtml(yText)).toBe('<span class="mark-chg">changed</span>');
  });

  it('converts revision with author color to style attribute', () => {
    const yText = makeYText([
      { insert: 'added', attributes: { revision: 'add', revisionAuthorColor: '#ff6b6b' } },
    ]);
    expect(yTextToHtml(yText)).toBe('<ins class="mark-add" style="--author-color:#ff6b6b">added</ins>');
  });

  it('converts comment attribute to <span class="mark-comment">', () => {
    const yText = makeYText([
      { insert: 'commented', attributes: { comment: 'comment-123' } },
    ]);
    expect(yTextToHtml(yText)).toBe('<span class="mark-comment" data-comment-id="comment-123">commented</span>');
  });

  it('converts commentResolved to mark-comment-resolved class', () => {
    const yText = makeYText([
      { insert: 'resolved', attributes: { comment: 'c1', commentResolved: true } },
    ]);
    expect(yTextToHtml(yText)).toBe('<span class="mark-comment-resolved" data-comment-id="c1">resolved</span>');
  });

  it('handles stacked attributes: bold + mark-rid', () => {
    const yText = makeYText([
      { insert: 'ASTM D2487', attributes: { bold: true, mark: 'rid' } },
    ]);
    // Nesting order: mark (outer) → format (inner)
    expect(yTextToHtml(yText)).toBe('<span class="mark-rid"><b>ASTM D2487</b></span>');
  });

  it('handles stacked: revision + mark + format', () => {
    const yText = makeYText([
      { insert: 'new ref', attributes: { revision: 'add', mark: 'rid', bold: true } },
    ]);
    // Nesting: revision → mark → format
    expect(yTextToHtml(yText)).toBe('<ins class="mark-add"><span class="mark-rid"><b>new ref</b></span></ins>');
  });

  it('handles adjacent segments with same attribute merging', () => {
    // Two deltas with same attributes should merge into one tag span
    const yText = makeYText([
      { insert: 'hello', attributes: { bold: true } },
      { insert: ' world', attributes: { bold: true } },
    ]);
    expect(yTextToHtml(yText)).toBe('<b>hello world</b>');
  });

  it('returns empty string for empty Y.Text', () => {
    const ydoc = new Y.Doc();
    const yText = ydoc.getText('test');
    expect(yTextToHtml(yText)).toBe('');
  });

  it('escapes HTML entities in text content', () => {
    const yText = makeYText([{ insert: '3 < 5 & 5 > 3' }]);
    expect(yTextToHtml(yText)).toBe('3 &lt; 5 &amp; 5 &gt; 3');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/__tests__/ytext-html.test.js`
Expected: FAIL — module `../ytext-html.js` not found

- [ ] **Step 3: Implement `yTextToHtml`**

```javascript
// src/lib/ytext-html.js
/**
 * Bidirectional converter between HTML strings and Y.Text with formatting
 * attributes. Used by the collab layer to enable character-level CRDT merge
 * while keeping contentEditable blocks working with plain HTML strings.
 *
 * Attribute schema (see design spec for full table):
 *   bold: true              → <b>
 *   italic: true            → <i>
 *   underline: true         → <u>
 *   mark: "rid"|"srf"|...   → <span class="mark-XXX">
 *   markOption: string      → data-opt (only with mark="tai")
 *   revision: "add"|"del"|"chg" → <ins>/<del>/<span class="mark-chg">
 *   revisionAuthor: string  → data-author-id
 *   revisionAuthorColor: string → --author-color CSS var
 *   comment: string         → <span class="mark-comment" data-comment-id>
 *   commentResolved: true   → mark-comment-resolved class
 */

// ── Attribute key constants ────────────────────────────────────────────────
// Nesting order (outermost first): comment → revision → mark → format
const FORMAT_KEYS = ['bold', 'italic', 'underline'];
const NESTING_ORDER = ['comment', 'revision', 'mark', ...FORMAT_KEYS];

/**
 * Escape text for safe HTML embedding.
 */
function escapeHtml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Compute the set of open/close tags needed for a given attribute set.
 * Returns { open: string, close: string } with tags in nesting order.
 */
function tagsForAttrs(attrs) {
  if (!attrs || Object.keys(attrs).length === 0) return { open: '', close: '' };

  const opens = [];
  const closes = [];

  // Comment (outermost)
  if (attrs.comment) {
    const resolvedCls = attrs.commentResolved ? 'mark-comment-resolved' : 'mark-comment';
    opens.push(`<span class="${resolvedCls}" data-comment-id="${attrs.comment}">`);
    closes.unshift('</span>');
  }

  // Revision
  if (attrs.revision) {
    const colorStyle = attrs.revisionAuthorColor
      ? ` style="--author-color:${attrs.revisionAuthorColor}"`
      : '';
    if (attrs.revision === 'add') {
      opens.push(`<ins class="mark-add"${colorStyle}>`);
      closes.unshift('</ins>');
    } else if (attrs.revision === 'del') {
      opens.push(`<del class="mark-del"${colorStyle}>`);
      closes.unshift('</del>');
    } else if (attrs.revision === 'chg') {
      opens.push(`<span class="mark-chg">`);
      closes.unshift('</span>');
    }
  }

  // Semantic mark
  if (attrs.mark) {
    const cls = `mark-${attrs.mark}`;
    const optAttr = (attrs.mark === 'tai' && attrs.markOption)
      ? ` data-opt="${attrs.markOption}"`
      : '';
    opens.push(`<span class="${cls}"${optAttr}>`);
    closes.unshift('</span>');
  }

  // Formatting (innermost)
  if (attrs.bold) { opens.push('<b>'); closes.unshift('</b>'); }
  if (attrs.italic) { opens.push('<i>'); closes.unshift('</i>'); }
  if (attrs.underline) { opens.push('<u>'); closes.unshift('</u>'); }

  return { open: opens.join(''), close: closes.join('') };
}

/**
 * Check if two attribute objects are equivalent for tag-generation purposes.
 */
function attrsEqual(a, b) {
  if (a === b) return true;
  if (!a || !b) return (!a || Object.keys(a).length === 0) && (!b || Object.keys(b).length === 0);
  for (const key of NESTING_ORDER) {
    if ((a[key] || null) !== (b[key] || null)) return false;
  }
  // Also check auxiliary keys
  if ((a.markOption || null) !== (b.markOption || null)) return false;
  if ((a.revisionAuthor || null) !== (b.revisionAuthor || null)) return false;
  if ((a.revisionAuthorColor || null) !== (b.revisionAuthorColor || null)) return false;
  if ((a.commentResolved || false) !== (b.commentResolved || false)) return false;
  return true;
}

/**
 * Convert a Y.Text (with formatting attributes) to an HTML string.
 *
 * Iterates Y.Text deltas, tracks attribute transitions, and emits
 * open/close HTML tags at boundaries. Adjacent deltas with identical
 * attributes are merged into a single tag span.
 *
 * @param {import('yjs').Text} yText
 * @returns {string} HTML string
 */
export function yTextToHtml(yText) {
  const deltas = yText.toDelta();
  if (deltas.length === 0) return '';

  const parts = [];
  let prevAttrs = null;

  for (const delta of deltas) {
    const text = delta.insert;
    if (typeof text !== 'string') continue; // skip embeds

    const attrs = delta.attributes || null;

    if (!attrsEqual(prevAttrs, attrs)) {
      // Close previous tags
      if (prevAttrs) {
        const prev = tagsForAttrs(prevAttrs);
        parts.push(prev.close);
      }
      // Open new tags
      if (attrs && Object.keys(attrs).length > 0) {
        const cur = tagsForAttrs(attrs);
        parts.push(cur.open);
      }
    }

    parts.push(escapeHtml(text));
    prevAttrs = attrs;
  }

  // Close final tags
  if (prevAttrs) {
    const prev = tagsForAttrs(prevAttrs);
    parts.push(prev.close);
  }

  return parts.join('');
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/__tests__/ytext-html.test.js`
Expected: All 17 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/ytext-html.js src/lib/__tests__/ytext-html.test.js
git commit -m "feat(collab): yTextToHtml — Y.Text deltas to HTML string converter"
```

---

## Task 2: `htmlToAttrList` — Parse HTML to Flat Attribute Tuples

**Files:**
- Modify: `src/lib/__tests__/ytext-html.test.js`
- Modify: `src/lib/ytext-html.js`

This is a helper for the publish direction. It parses an HTML string into a flat list of `{char, attrs}` tuples that can be diffed against Y.Text content.

- [ ] **Step 1: Write failing tests for `htmlToAttrList`**

Append to `src/lib/__tests__/ytext-html.test.js`:

```javascript
import { yTextToHtml, htmlToAttrList } from '../ytext-html.js';

describe('htmlToAttrList', () => {
  it('parses plain text into char tuples with empty attrs', () => {
    const result = htmlToAttrList('Hello');
    expect(result).toEqual([
      { char: 'H', attrs: {} },
      { char: 'e', attrs: {} },
      { char: 'l', attrs: {} },
      { char: 'l', attrs: {} },
      { char: 'o', attrs: {} },
    ]);
  });

  it('parses <b> as bold attribute', () => {
    const result = htmlToAttrList('a<b>B</b>c');
    expect(result).toEqual([
      { char: 'a', attrs: {} },
      { char: 'B', attrs: { bold: true } },
      { char: 'c', attrs: {} },
    ]);
  });

  it('parses <i> and <em> as italic attribute', () => {
    const r1 = htmlToAttrList('<i>x</i>');
    const r2 = htmlToAttrList('<em>x</em>');
    expect(r1).toEqual([{ char: 'x', attrs: { italic: true } }]);
    expect(r2).toEqual([{ char: 'x', attrs: { italic: true } }]);
  });

  it('parses <u> as underline attribute', () => {
    const result = htmlToAttrList('<u>x</u>');
    expect(result).toEqual([{ char: 'x', attrs: { underline: true } }]);
  });

  it('parses <span class="mark-rid"> as mark attribute', () => {
    const result = htmlToAttrList('<span class="mark-rid">ASTM</span>');
    expect(result).toEqual([
      { char: 'A', attrs: { mark: 'rid' } },
      { char: 'S', attrs: { mark: 'rid' } },
      { char: 'T', attrs: { mark: 'rid' } },
      { char: 'M', attrs: { mark: 'rid' } },
    ]);
  });

  it('parses mark-tai with data-opt', () => {
    const result = htmlToAttrList('<span class="mark-tai" data-opt="OPT_A">x</span>');
    expect(result).toEqual([{ char: 'x', attrs: { mark: 'tai', markOption: 'OPT_A' } }]);
  });

  it('parses <ins class="mark-add"> as revision add', () => {
    const result = htmlToAttrList('<ins class="mark-add">x</ins>');
    expect(result).toEqual([{ char: 'x', attrs: { revision: 'add' } }]);
  });

  it('parses <del class="mark-del"> as revision del', () => {
    const result = htmlToAttrList('<del class="mark-del">x</del>');
    expect(result).toEqual([{ char: 'x', attrs: { revision: 'del' } }]);
  });

  it('parses <span class="mark-chg"> as revision chg', () => {
    const result = htmlToAttrList('<span class="mark-chg">x</span>');
    expect(result).toEqual([{ char: 'x', attrs: { revision: 'chg' } }]);
  });

  it('parses ins with --author-color style', () => {
    const result = htmlToAttrList('<ins class="mark-add" style="--author-color:#ff6b6b">x</ins>');
    expect(result).toEqual([{ char: 'x', attrs: { revision: 'add', revisionAuthorColor: '#ff6b6b' } }]);
  });

  it('parses <span class="mark-comment" data-comment-id="c1">', () => {
    const result = htmlToAttrList('<span class="mark-comment" data-comment-id="c1">x</span>');
    expect(result).toEqual([{ char: 'x', attrs: { comment: 'c1' } }]);
  });

  it('parses mark-comment-resolved', () => {
    const result = htmlToAttrList('<span class="mark-comment-resolved" data-comment-id="c1">x</span>');
    expect(result).toEqual([{ char: 'x', attrs: { comment: 'c1', commentResolved: true } }]);
  });

  it('parses nested: <span class="mark-rid"><b>X</b></span>', () => {
    const result = htmlToAttrList('<span class="mark-rid"><b>X</b></span>');
    expect(result).toEqual([{ char: 'X', attrs: { mark: 'rid', bold: true } }]);
  });

  it('strips tag-label spans (contentEditable=false)', () => {
    const result = htmlToAttrList('<span class="tag-label" contenteditable="false">[RID]</span>ASTM');
    expect(result).toEqual([
      { char: 'A', attrs: {} },
      { char: 'S', attrs: {} },
      { char: 'T', attrs: {} },
      { char: 'M', attrs: {} },
    ]);
  });

  it('strips zero-width spaces', () => {
    const result = htmlToAttrList('\u200Bhello');
    expect(result).toEqual([
      { char: 'h', attrs: {} },
      { char: 'e', attrs: {} },
      { char: 'l', attrs: {} },
      { char: 'l', attrs: {} },
      { char: 'o', attrs: {} },
    ]);
  });

  it('returns empty array for empty string', () => {
    expect(htmlToAttrList('')).toEqual([]);
  });

  it('roundtrips: yTextToHtml(yText) → htmlToAttrList → same chars+attrs', () => {
    const ydoc = new Y.Doc();
    const yText = ydoc.getText('test');
    ydoc.transact(() => {
      yText.insert(0, 'Hello ', {});
      yText.insert(6, 'bold', { bold: true });
      yText.insert(10, ' ', {});
      yText.insert(11, 'ref', { mark: 'rid' });
    });
    const html = yTextToHtml(yText);
    const tuples = htmlToAttrList(html);
    const text = tuples.map(t => t.char).join('');
    expect(text).toBe('Hello bold ref');
    expect(tuples[6].attrs).toEqual({ bold: true });
    expect(tuples[11].attrs).toEqual({ mark: 'rid' });
  });
});
```

- [ ] **Step 2: Run tests to verify new tests fail**

Run: `npx vitest run src/lib/__tests__/ytext-html.test.js`
Expected: FAIL — `htmlToAttrList` not exported

- [ ] **Step 3: Implement `htmlToAttrList`**

Add to `src/lib/ytext-html.js`:

```javascript
// ── HTML → attribute tuples ────────────────────────────────────────────────

// Mark class → attribute key/value mapping
const MARK_CLASS_MAP = {
  'mark-rid': { mark: 'rid' },
  'mark-srf': { mark: 'srf' },
  'mark-sub': { mark: 'sub' },
  'mark-eng': { mark: 'eng' },
  'mark-met': { mark: 'met' },
  'mark-tai': { mark: 'tai' },
  'mark-tst': { mark: 'tst' },
  'mark-url': { mark: 'url' },
  'mark-att': { mark: 'att' },
  'mark-hls': { mark: 'hls' },
};

/**
 * Extract formatting attributes from a DOM element.
 * Returns an object with attribute keys set, or empty object.
 */
function attrsFromElement(el) {
  const attrs = {};
  const tag = el.tagName.toLowerCase();

  if (tag === 'b' || tag === 'strong') {
    attrs.bold = true;
  } else if (tag === 'i' || tag === 'em') {
    attrs.italic = true;
  } else if (tag === 'u') {
    attrs.underline = true;
  } else if (tag === 'ins') {
    const cls = el.getAttribute('class') || '';
    if (cls.includes('mark-add')) {
      attrs.revision = 'add';
      const style = el.getAttribute('style') || '';
      const colorMatch = style.match(/--author-color:\s*([^;"]+)/);
      if (colorMatch) attrs.revisionAuthorColor = colorMatch[1].trim();
    }
  } else if (tag === 'del') {
    const cls = el.getAttribute('class') || '';
    if (cls.includes('mark-del')) {
      attrs.revision = 'del';
      const style = el.getAttribute('style') || '';
      const colorMatch = style.match(/--author-color:\s*([^;"]+)/);
      if (colorMatch) attrs.revisionAuthorColor = colorMatch[1].trim();
    }
  } else if (tag === 'span') {
    const cls = el.getAttribute('class') || '';

    // Comment marks
    if (cls.includes('mark-comment-resolved')) {
      attrs.comment = el.getAttribute('data-comment-id') || '';
      attrs.commentResolved = true;
    } else if (cls.includes('mark-comment')) {
      attrs.comment = el.getAttribute('data-comment-id') || '';
    }

    // Change mark
    if (cls.includes('mark-chg')) {
      attrs.revision = 'chg';
    }

    // Semantic marks
    for (const [markCls, markAttrs] of Object.entries(MARK_CLASS_MAP)) {
      if (cls.includes(markCls)) {
        Object.assign(attrs, markAttrs);
        if (markAttrs.mark === 'tai') {
          const opt = el.getAttribute('data-opt');
          if (opt) attrs.markOption = opt;
        }
        break;
      }
    }
  }

  return attrs;
}

/**
 * Merge parent and child attribute objects.
 * Child attrs override parent for same keys.
 */
function mergeAttrs(parent, child) {
  const merged = { ...parent };
  for (const [k, v] of Object.entries(child)) {
    merged[k] = v;
  }
  return merged;
}

/**
 * Clean an attrs object: remove keys with falsy values and return
 * a clean object (or empty object if no attrs).
 */
function cleanAttrs(attrs) {
  const clean = {};
  for (const [k, v] of Object.entries(attrs)) {
    if (v !== undefined && v !== null && v !== false) clean[k] = v;
  }
  return clean;
}

/**
 * Walk a DOM tree and collect {char, attrs} tuples for every text character.
 * Accumulates formatting context from parent elements.
 */
function walkNode(node, parentAttrs, result) {
  for (const child of node.childNodes) {
    if (child.nodeType === 3) {
      // Text node — emit chars with current attrs
      const text = child.textContent.replace(/\u200B/g, '');
      const cleaned = cleanAttrs(parentAttrs);
      for (const char of text) {
        result.push({ char, attrs: { ...cleaned } });
      }
    } else if (child.nodeType === 1) {
      const tag = child.tagName.toLowerCase();
      const cls = child.getAttribute?.('class') || '';

      // Skip tag-label spans (editor UI, not content)
      if (cls.includes('tag-label')) continue;

      const elemAttrs = attrsFromElement(child);
      const merged = mergeAttrs(parentAttrs, elemAttrs);
      walkNode(child, merged, result);
    }
  }
}

/**
 * Parse an HTML string into a flat list of {char, attrs} tuples.
 * Each tuple represents one character with its accumulated formatting.
 *
 * Strips zero-width spaces and tag-label spans (editor UI elements).
 * Uses DOMParser (browser-native or linkedom polyfill on server).
 *
 * @param {string} html
 * @returns {Array<{char: string, attrs: object}>}
 */
export function htmlToAttrList(html) {
  if (!html) return [];

  const parser = new DOMParser();
  const doc = parser.parseFromString(`<root>${html}</root>`, 'text/html');
  const root = doc.body?.firstChild || doc.querySelector('root') || doc.body;

  const result = [];
  walkNode(root, {}, result);
  return result;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/__tests__/ytext-html.test.js`
Expected: All tests PASS (both yTextToHtml and htmlToAttrList)

- [ ] **Step 5: Commit**

```bash
git add src/lib/ytext-html.js src/lib/__tests__/ytext-html.test.js
git commit -m "feat(collab): htmlToAttrList — parse HTML to attribute tuples for CRDT diff"
```

---

## Task 3: `applyHtmlToYText` — Diff HTML Against Y.Text and Apply Minimal Operations

**Files:**
- Modify: `src/lib/__tests__/ytext-html.test.js`
- Modify: `src/lib/ytext-html.js`

This is the publish direction. Diffs the new HTML against the current Y.Text state and emits minimal insert/delete/format operations.

- [ ] **Step 1: Write failing tests for `applyHtmlToYText`**

Append to `src/lib/__tests__/ytext-html.test.js`:

```javascript
import { yTextToHtml, htmlToAttrList, applyHtmlToYText } from '../ytext-html.js';

describe('applyHtmlToYText', () => {
  function makeEmptyYText() {
    const ydoc = new Y.Doc();
    return ydoc.getText('test');
  }

  it('seeds empty Y.Text from HTML', () => {
    const yText = makeEmptyYText();
    applyHtmlToYText(yText, 'Hello <b>world</b>');
    expect(yTextToHtml(yText)).toBe('Hello <b>world</b>');
  });

  it('appends text to existing Y.Text', () => {
    const yText = makeEmptyYText();
    applyHtmlToYText(yText, 'Hello');
    applyHtmlToYText(yText, 'Hello world');
    expect(yTextToHtml(yText)).toBe('Hello world');
  });

  it('deletes text from Y.Text', () => {
    const yText = makeEmptyYText();
    applyHtmlToYText(yText, 'Hello world');
    applyHtmlToYText(yText, 'Hello');
    expect(yTextToHtml(yText)).toBe('Hello');
  });

  it('replaces text in middle', () => {
    const yText = makeEmptyYText();
    applyHtmlToYText(yText, 'Hello world');
    applyHtmlToYText(yText, 'Hello earth');
    expect(yTextToHtml(yText)).toBe('Hello earth');
  });

  it('adds formatting to existing text', () => {
    const yText = makeEmptyYText();
    applyHtmlToYText(yText, 'Hello world');
    applyHtmlToYText(yText, 'Hello <b>world</b>');
    expect(yTextToHtml(yText)).toBe('Hello <b>world</b>');
  });

  it('removes formatting from existing text', () => {
    const yText = makeEmptyYText();
    applyHtmlToYText(yText, 'Hello <b>world</b>');
    applyHtmlToYText(yText, 'Hello world');
    expect(yTextToHtml(yText)).toBe('Hello world');
  });

  it('adds mark to existing text', () => {
    const yText = makeEmptyYText();
    applyHtmlToYText(yText, 'See ASTM C33');
    applyHtmlToYText(yText, 'See <span class="mark-rid">ASTM C33</span>');
    expect(yTextToHtml(yText)).toBe('See <span class="mark-rid">ASTM C33</span>');
  });

  it('handles simultaneous text change + format change', () => {
    const yText = makeEmptyYText();
    applyHtmlToYText(yText, 'old text');
    applyHtmlToYText(yText, '<b>new text</b>');
    expect(yTextToHtml(yText)).toBe('<b>new text</b>');
  });

  it('preserves Y.Text identity (does not create new Y.Text)', () => {
    const ydoc = new Y.Doc();
    const yText = ydoc.getText('test');
    applyHtmlToYText(yText, 'Hello');
    const ref1 = ydoc.getText('test');
    applyHtmlToYText(yText, 'Hello world');
    const ref2 = ydoc.getText('test');
    expect(ref1).toBe(ref2); // Same object
  });

  it('no-ops when HTML has not changed', () => {
    const yText = makeEmptyYText();
    applyHtmlToYText(yText, 'Hello <b>world</b>');
    const beforeLength = yText.toDelta().length;
    applyHtmlToYText(yText, 'Hello <b>world</b>');
    const afterLength = yText.toDelta().length;
    expect(afterLength).toBe(beforeLength);
    expect(yTextToHtml(yText)).toBe('Hello <b>world</b>');
  });

  it('handles empty to empty (no-op)', () => {
    const yText = makeEmptyYText();
    applyHtmlToYText(yText, '');
    expect(yTextToHtml(yText)).toBe('');
  });

  it('roundtrip: apply → read → apply again preserves content', () => {
    const yText = makeEmptyYText();
    const html = 'See <span class="mark-rid"><b>ASTM C33</b></span> and <span class="mark-srf">01 33 00</span>';
    applyHtmlToYText(yText, html);
    const readBack = yTextToHtml(yText);
    applyHtmlToYText(yText, readBack); // Should be a no-op
    expect(yTextToHtml(yText)).toBe(readBack);
  });
});
```

- [ ] **Step 2: Run tests to verify new tests fail**

Run: `npx vitest run src/lib/__tests__/ytext-html.test.js`
Expected: FAIL — `applyHtmlToYText` not exported

- [ ] **Step 3: Implement `applyHtmlToYText`**

Add to `src/lib/ytext-html.js`:

```javascript
// ── LCS diff for plain-text characters ─────────────────────────────────────

/**
 * Compute LCS (Longest Common Subsequence) table for two strings.
 * Returns the LCS length table for backtracking.
 */
function lcsTable(a, b) {
  const m = a.length, n = b.length;
  // Use typed arrays for memory efficiency
  const prev = new Uint16Array(n + 1);
  const curr = new Uint16Array(n + 1);
  const table = [new Uint16Array(prev)];

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        curr[j] = prev[j - 1] + 1;
      } else {
        curr[j] = Math.max(prev[j], curr[j - 1]);
      }
    }
    table.push(new Uint16Array(curr));
    prev.set(curr);
    curr.fill(0);
  }
  return table;
}

/**
 * Backtrack through LCS table to produce edit operations.
 * Returns array of { type: 'keep'|'delete'|'insert', oldIdx?, newIdx? }
 */
function lcsOps(oldChars, newChars) {
  const m = oldChars.length, n = newChars.length;
  if (m === 0 && n === 0) return [];
  if (m === 0) return newChars.map((_, j) => ({ type: 'insert', newIdx: j }));
  if (n === 0) return oldChars.map((_, i) => ({ type: 'delete', oldIdx: i }));

  const table = lcsTable(oldChars, newChars);
  const ops = [];
  let i = m, j = n;

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldChars[i - 1] === newChars[j - 1]) {
      ops.push({ type: 'keep', oldIdx: i - 1, newIdx: j - 1 });
      i--; j--;
    } else if (j > 0 && (i === 0 || table[i][j - 1] >= table[i - 1][j])) {
      ops.push({ type: 'insert', newIdx: j - 1 });
      j--;
    } else {
      ops.push({ type: 'delete', oldIdx: i - 1 });
      i--;
    }
  }

  return ops.reverse();
}

/**
 * Read the current Y.Text state as {char, attrs} tuples.
 */
function yTextToAttrList(yText) {
  const deltas = yText.toDelta();
  const result = [];
  for (const d of deltas) {
    if (typeof d.insert !== 'string') continue;
    const attrs = cleanAttrs(d.attributes || {});
    for (const char of d.insert) {
      result.push({ char, attrs: { ...attrs } });
    }
  }
  return result;
}

/**
 * Apply an HTML string to a Y.Text with minimal CRDT operations.
 *
 * 1. Parse newHtml into {char, attrs} tuples
 * 2. Read current Y.Text into same format
 * 3. LCS diff on plain characters
 * 4. Apply delete, insert (with attrs), and format operations
 *
 * @param {import('yjs').Text} yText
 * @param {string} newHtml
 */
export function applyHtmlToYText(yText, newHtml) {
  const newList = htmlToAttrList(newHtml || '');
  const oldList = yTextToAttrList(yText);

  const oldChars = oldList.map(t => t.char);
  const newChars = newList.map(t => t.char);

  const ops = lcsOps(oldChars, newChars);

  // Build a list of Y.Text mutations
  // Process ops to compute Y.Text position-based operations
  const doc = yText.doc;
  if (!doc) return;

  doc.transact(() => {
    let yPos = 0; // Current position in Y.Text

    for (const op of ops) {
      if (op.type === 'keep') {
        // Check if attributes changed
        const oldAttrs = oldList[op.oldIdx].attrs;
        const newAttrs = newList[op.newIdx].attrs;
        if (!attrsEqual(oldAttrs, newAttrs)) {
          // Build the attribute delta (set new, remove old)
          const delta = {};
          for (const key of NESTING_ORDER) {
            const oldVal = oldAttrs[key] || null;
            const newVal = newAttrs[key] || null;
            if (oldVal !== newVal) {
              delta[key] = newVal === null ? null : newVal;
            }
          }
          // Auxiliary keys
          for (const key of ['markOption', 'revisionAuthor', 'revisionAuthorColor', 'commentResolved']) {
            const oldVal = oldAttrs[key] || null;
            const newVal = newAttrs[key] || null;
            if (oldVal !== newVal) {
              delta[key] = newVal === null ? null : newVal;
            }
          }
          yText.format(yPos, 1, delta);
        }
        yPos++;
      } else if (op.type === 'delete') {
        yText.delete(yPos, 1);
        // yPos stays the same (next char shifts down)
      } else if (op.type === 'insert') {
        const attrs = newList[op.newIdx].attrs;
        const insertAttrs = Object.keys(attrs).length > 0 ? attrs : undefined;
        yText.insert(yPos, newList[op.newIdx].char, insertAttrs);
        yPos++;
      }
    }
  }, doc.clientID ? undefined : 'apply');
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/__tests__/ytext-html.test.js`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/ytext-html.js src/lib/__tests__/ytext-html.test.js
git commit -m "feat(collab): applyHtmlToYText — diff HTML against Y.Text with minimal CRDT ops"
```

---

## Task 4: Two-Doc CRDT Merge Test for Y.Text Attributes

**Files:**
- Modify: `src/lib/__tests__/ytext-html.test.js`

Verify that concurrent edits on two Y.Docs merge correctly through the attribute-aware CRDT.

- [ ] **Step 1: Write two-doc merge tests**

Append to `src/lib/__tests__/ytext-html.test.js`:

```javascript
describe('two-doc CRDT merge', () => {
  function syncDocs(doc1, doc2) {
    const sv1 = Y.encodeStateVector(doc1);
    const sv2 = Y.encodeStateVector(doc2);
    const update1 = Y.encodeStateAsUpdate(doc1, sv2);
    const update2 = Y.encodeStateAsUpdate(doc2, sv1);
    Y.applyUpdate(doc1, update2);
    Y.applyUpdate(doc2, update1);
  }

  it('merges concurrent text insertions at different positions', () => {
    const doc1 = new Y.Doc(); const doc2 = new Y.Doc();
    const yt1 = doc1.getText('t'); const yt2 = doc2.getText('t');

    // Seed both docs with same content
    applyHtmlToYText(yt1, 'Hello world');
    syncDocs(doc1, doc2);

    // Doc1: insert " beautiful" after "Hello"
    applyHtmlToYText(yt1, 'Hello beautiful world');
    // Doc2: insert " cruel" before "world"
    applyHtmlToYText(yt2, 'Hello cruel world');

    syncDocs(doc1, doc2);

    // Both insertions should be present
    const result = yTextToHtml(yt1);
    expect(result).toContain('beautiful');
    expect(result).toContain('cruel');
    expect(yTextToHtml(yt1)).toBe(yTextToHtml(yt2)); // convergence
  });

  it('merges concurrent formatting on non-overlapping ranges', () => {
    const doc1 = new Y.Doc(); const doc2 = new Y.Doc();
    const yt1 = doc1.getText('t'); const yt2 = doc2.getText('t');

    applyHtmlToYText(yt1, 'Hello world');
    syncDocs(doc1, doc2);

    // Doc1: bold "Hello"
    applyHtmlToYText(yt1, '<b>Hello</b> world');
    // Doc2: mark "world" as RID
    applyHtmlToYText(yt2, 'Hello <span class="mark-rid">world</span>');

    syncDocs(doc1, doc2);

    const result = yTextToHtml(yt1);
    expect(result).toContain('<b>Hello</b>');
    expect(result).toContain('<span class="mark-rid">world</span>');
    expect(yTextToHtml(yt1)).toBe(yTextToHtml(yt2));
  });

  it('merges concurrent text edit + formatting on same word', () => {
    const doc1 = new Y.Doc(); const doc2 = new Y.Doc();
    const yt1 = doc1.getText('t'); const yt2 = doc2.getText('t');

    applyHtmlToYText(yt1, 'Hello world');
    syncDocs(doc1, doc2);

    // Doc1: bold "world"
    applyHtmlToYText(yt1, 'Hello <b>world</b>');
    // Doc2: append "!" 
    applyHtmlToYText(yt2, 'Hello world!');

    syncDocs(doc1, doc2);

    const r1 = yTextToHtml(yt1);
    const r2 = yTextToHtml(yt2);
    expect(r1).toBe(r2); // convergence
    expect(r1).toContain('<b>world</b>');
    expect(r1).toContain('!');
  });
});
```

- [ ] **Step 2: Run tests**

Run: `npx vitest run src/lib/__tests__/ytext-html.test.js`
Expected: All tests PASS (CRDT merge is handled by Yjs)

- [ ] **Step 3: Commit**

```bash
git add src/lib/__tests__/ytext-html.test.js
git commit -m "test(collab): two-doc CRDT merge tests for Y.Text attribute merge"
```

---

## Task 5: Integrate `ytext-html` into `collab.js`

**Files:**
- Modify: `src/lib/collab.js`
- Modify: `src/lib/__tests__/collab.test.js`

Replace whole-text replacement with `applyHtmlToYText`/`yTextToHtml`.

- [ ] **Step 1: Write integration test in collab.test.js**

Add a new `describe` block to `src/lib/__tests__/collab.test.js`:

```javascript
describe('character-level CRDT merge (attribute-aware)', () => {
  it('concurrent text edits on same block merge via Y.Text attributes', () => {
    const { ydoc: doc1, yOrder: o1, yStore: s1 } = makeDoc();
    const { ydoc: doc2, yOrder: o2, yStore: s2 } = makeDoc();

    const blocks = [
      { id: 'b1', type: 'txt', part: 1, depth: 1, section: 's1', html: 'Hello world' },
    ];

    // Seed both docs
    seedYBlocks(doc1, o1, s1, blocks);
    const sv1 = Y.encodeStateVector(doc1);
    Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1, Y.encodeStateVector(doc2)));

    // Doc1: bold "world"
    applyBlocksToYDoc(doc1, o1, s1, [
      { id: 'b1', type: 'txt', part: 1, depth: 1, section: 's1', html: 'Hello <b>world</b>' },
    ]);

    // Doc2: append " today"
    applyBlocksToYDoc(doc2, o2, s2, [
      { id: 'b1', type: 'txt', part: 1, depth: 1, section: 's1', html: 'Hello world today' },
    ]);

    // Sync
    const update1 = Y.encodeStateAsUpdate(doc1, Y.encodeStateVector(doc2));
    const update2 = Y.encodeStateAsUpdate(doc2, Y.encodeStateVector(doc1));
    Y.applyUpdate(doc1, update2);
    Y.applyUpdate(doc2, update1);

    // Both docs should converge with both edits preserved
    const result1 = yBlocksToArray(o1, s1);
    const result2 = yBlocksToArray(o2, s2);
    expect(result1[0].html).toBe(result2[0].html);
    expect(result1[0].html).toContain('<b>world</b>');
    expect(result1[0].html).toContain('today');
  });

  it('concurrent mark addition on different words merges', () => {
    const { ydoc: doc1, yOrder: o1, yStore: s1 } = makeDoc();
    const { ydoc: doc2, yOrder: o2, yStore: s2 } = makeDoc();

    const blocks = [
      { id: 'b1', type: 'txt', part: 1, depth: 1, section: 's1', html: 'See ASTM C33 and 01 33 00' },
    ];

    seedYBlocks(doc1, o1, s1, blocks);
    Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1, Y.encodeStateVector(doc2)));

    // Doc1: mark RID
    applyBlocksToYDoc(doc1, o1, s1, [
      { id: 'b1', type: 'txt', part: 1, depth: 1, section: 's1', html: 'See <span class="mark-rid">ASTM C33</span> and 01 33 00' },
    ]);

    // Doc2: mark SRF
    applyBlocksToYDoc(doc2, o2, s2, [
      { id: 'b1', type: 'txt', part: 1, depth: 1, section: 's1', html: 'See ASTM C33 and <span class="mark-srf">01 33 00</span>' },
    ]);

    // Sync
    const update1 = Y.encodeStateAsUpdate(doc1, Y.encodeStateVector(doc2));
    const update2 = Y.encodeStateAsUpdate(doc2, Y.encodeStateVector(doc1));
    Y.applyUpdate(doc1, update2);
    Y.applyUpdate(doc2, update1);

    const result1 = yBlocksToArray(o1, s1);
    const result2 = yBlocksToArray(o2, s2);
    expect(result1[0].html).toBe(result2[0].html);
    expect(result1[0].html).toContain('mark-rid');
    expect(result1[0].html).toContain('mark-srf');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/__tests__/collab.test.js`
Expected: FAIL — concurrent edits overwrite each other (current whole-text replacement)

- [ ] **Step 3: Modify `collab.js` to use `ytext-html` converters**

In `src/lib/collab.js`, make these changes:

1. Add import at top:
```javascript
import { applyHtmlToYText, yTextToHtml } from './ytext-html.js';
```

2. Replace `blockToYMap()` (lines 167-181):
```javascript
/** Build a Y.Map from a plain block object. */
function blockToYMap(block) {
  const yMap = new Y.Map();
  for (const k of SCALAR_KEYS) {
    if (block[k] !== undefined) yMap.set(k, block[k]);
  }
  const yText = new Y.Text();
  applyHtmlToYText(yText, block.html || '');
  yMap.set('html', yText);
  for (const k of JSON_KEYS) {
    if (block[k] !== undefined) yMap.set(k, JSON.stringify(block[k]));
  }
  return yMap;
}
```

3. Replace `yMapToBlock()` (lines 184-200):
```javascript
/** Build a plain block object from a Y.Map. */
function yMapToBlock(yMap) {
  const block = {};
  for (const k of SCALAR_KEYS) {
    const v = yMap.get(k);
    if (v !== undefined) block[k] = v;
  }
  const yText = yMap.get('html');
  block.html = yText instanceof Y.Text ? yTextToHtml(yText) : (yText || '');
  for (const k of JSON_KEYS) {
    const raw = yMap.get(k);
    if (raw !== undefined) {
      try { block[k] = typeof raw === 'string' ? JSON.parse(raw) : raw; }
      catch { /* ignore */ }
    }
  }
  return block;
}
```

4. Replace the html update section of `updateYMapFromBlock()` (lines 447-459):
```javascript
  const yText = ymap.get('html');
  if (yText instanceof Y.Text) {
    applyHtmlToYText(yText, typeof block.html === 'string' ? block.html : '');
  } else {
    const t = new Y.Text();
    applyHtmlToYText(t, typeof block.html === 'string' ? block.html : '');
    ymap.set('html', t);
  }
```

- [ ] **Step 4: Run all collab tests**

Run: `npx vitest run src/lib/__tests__/collab.test.js`
Expected: All existing + new tests PASS

- [ ] **Step 5: Run full test suite to check for regressions**

Run: `npm test`
Expected: All 566 Vitest tests PASS

- [ ] **Step 6: Commit**

```bash
git add src/lib/collab.js src/lib/__tests__/collab.test.js
git commit -m "feat(collab): integrate ytext-html — character-level CRDT merge for text blocks"
```

---

## Task 6: `ytable-crdt.js` — Table CRDT Converter

**Files:**
- Create: `src/lib/__tests__/ytable-crdt.test.js`
- Create: `src/lib/ytable-crdt.js`

- [ ] **Step 1: Write failing tests**

```javascript
// src/lib/__tests__/ytable-crdt.test.js
import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import { tableToYStructure, yStructureToTable, diffTableForPublish, applyTableCellEdits } from '../ytable-crdt.js';
import { yTextToHtml } from '../ytext-html.js';

function makeTableYMap() {
  const ydoc = new Y.Doc();
  const yMap = ydoc.getMap('table');
  return { ydoc, yMap };
}

const sampleTable = {
  columns: 2,
  rows: [
    [{ text: 'A1', colspan: 1 }, { text: 'B1', colspan: 1 }],
    [{ text: 'A2', colspan: 1 }, { text: 'B2', colspan: 1 }],
  ],
};

describe('tableToYStructure + yStructureToTable roundtrip', () => {
  it('roundtrips a simple table', () => {
    const { ydoc, yMap } = makeTableYMap();
    ydoc.transact(() => tableToYStructure(yMap, sampleTable));
    const result = yStructureToTable(yMap);
    expect(result.columns).toBe(2);
    expect(result.rows.length).toBe(2);
    expect(result.rows[0][0].text).toBe('A1');
    expect(result.rows[0][1].text).toBe('B1');
    expect(result.rows[1][0].text).toBe('A2');
    expect(result.rows[1][1].colspan).toBe(1);
  });

  it('preserves colspan values', () => {
    const table = {
      columns: 3,
      rows: [[{ text: 'merged', colspan: 2 }, { text: 'C1', colspan: 1 }]],
    };
    const { ydoc, yMap } = makeTableYMap();
    ydoc.transact(() => tableToYStructure(yMap, table));
    const result = yStructureToTable(yMap);
    expect(result.rows[0][0].colspan).toBe(2);
  });

  it('preserves optional colWidths and rowHeights', () => {
    const table = { ...sampleTable, colWidths: [100, 200], rowHeights: [24, 30] };
    const { ydoc, yMap } = makeTableYMap();
    ydoc.transact(() => tableToYStructure(yMap, table));
    const result = yStructureToTable(yMap);
    expect(result.colWidths).toEqual([100, 200]);
    expect(result.rowHeights).toEqual([24, 30]);
  });

  it('preserves cell HTML with marks via Y.Text', () => {
    const table = {
      columns: 1,
      rows: [[{ text: '<b>bold cell</b>', colspan: 1 }]],
    };
    const { ydoc, yMap } = makeTableYMap();
    ydoc.transact(() => tableToYStructure(yMap, table));
    const result = yStructureToTable(yMap);
    expect(result.rows[0][0].text).toBe('<b>bold cell</b>');
  });
});

describe('diffTableForPublish', () => {
  it('detects cell-text-only changes', () => {
    const next = {
      columns: 2,
      rows: [
        [{ text: 'A1 modified', colspan: 1 }, { text: 'B1', colspan: 1 }],
        [{ text: 'A2', colspan: 1 }, { text: 'B2', colspan: 1 }],
      ],
    };
    const result = diffTableForPublish(sampleTable, next);
    expect(result.type).toBe('cells');
    expect(result.changes).toEqual([{ row: 0, cell: 0, html: 'A1 modified' }]);
  });

  it('detects structural change (column count)', () => {
    const next = { columns: 3, rows: sampleTable.rows };
    const result = diffTableForPublish(sampleTable, next);
    expect(result.type).toBe('structural');
  });

  it('detects structural change (row count)', () => {
    const next = { columns: 2, rows: [sampleTable.rows[0]] };
    const result = diffTableForPublish(sampleTable, next);
    expect(result.type).toBe('structural');
  });

  it('detects structural change (colspan changed)', () => {
    const next = {
      columns: 2,
      rows: [
        [{ text: 'merged', colspan: 2 }],
        sampleTable.rows[1],
      ],
    };
    const result = diffTableForPublish(sampleTable, next);
    expect(result.type).toBe('structural');
  });

  it('returns no changes when tables are identical', () => {
    const result = diffTableForPublish(sampleTable, sampleTable);
    expect(result.type).toBe('cells');
    expect(result.changes).toEqual([]);
  });
});

describe('applyTableCellEdits', () => {
  it('updates a single cell Y.Text without touching other cells', () => {
    const { ydoc, yMap } = makeTableYMap();
    ydoc.transact(() => tableToYStructure(yMap, sampleTable));

    // Get reference to B2's Y.Text before edit
    const rowsArr = yMap.get('rows');
    const row1 = rowsArr.get(1);
    const cellB2Map = row1.get(1);
    const b2YText = cellB2Map.get('text');

    // Edit A1 only
    applyTableCellEdits(yMap, [{ row: 0, cell: 0, html: 'A1 edited' }]);

    // B2's Y.Text should be the same object (identity preserved)
    const b2YTextAfter = row1.get(1).get('text');
    expect(b2YTextAfter).toBe(b2YText);

    // A1 should have new content
    const result = yStructureToTable(yMap);
    expect(result.rows[0][0].text).toBe('A1 edited');
    expect(result.rows[1][1].text).toBe('B2');
  });
});

describe('two-doc table cell merge', () => {
  it('concurrent cell edits on different cells merge', () => {
    const doc1 = new Y.Doc(); const doc2 = new Y.Doc();
    const m1 = doc1.getMap('t'); const m2 = doc2.getMap('t');

    doc1.transact(() => tableToYStructure(m1, sampleTable));
    Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1, Y.encodeStateVector(doc2)));

    // Doc1 edits A1
    applyTableCellEdits(m1, [{ row: 0, cell: 0, html: 'Doc1 A1' }]);
    // Doc2 edits B2
    applyTableCellEdits(m2, [{ row: 1, cell: 1, html: 'Doc2 B2' }]);

    // Sync
    const u1 = Y.encodeStateAsUpdate(doc1, Y.encodeStateVector(doc2));
    const u2 = Y.encodeStateAsUpdate(doc2, Y.encodeStateVector(doc1));
    Y.applyUpdate(doc1, u2);
    Y.applyUpdate(doc2, u1);

    const r1 = yStructureToTable(m1);
    const r2 = yStructureToTable(m2);
    expect(r1.rows[0][0].text).toBe('Doc1 A1');
    expect(r1.rows[1][1].text).toBe('Doc2 B2');
    expect(r1.rows[0][0].text).toBe(r2.rows[0][0].text); // convergence
    expect(r1.rows[1][1].text).toBe(r2.rows[1][1].text);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/__tests__/ytable-crdt.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `ytable-crdt.js`**

```javascript
// src/lib/ytable-crdt.js
/**
 * Table CRDT converter — bidirectional mapping between plain TableData
 * and nested Yjs structures (Y.Array/Y.Map/Y.Text).
 *
 * Cell text uses Y.Text with formatting attributes (same schema as
 * ytext-html.js), enabling character-level CRDT merge for concurrent
 * cell edits. Structural operations (add/delete column, merge/split)
 * replace the entire rows structure (LWW).
 */

import * as Y from 'yjs';
import { applyHtmlToYText, yTextToHtml } from './ytext-html.js';

/**
 * Populate a Y.Map with nested Yjs structure from plain TableData.
 * Must be called inside a Y.Doc transaction.
 *
 * @param {import('yjs').Map} yMap - target Y.Map (will be cleared)
 * @param {{ columns: number, rows: Array<Array<{text, colspan, styleId?}>>, colWidths?, rowHeights?, styles? }} table
 */
export function tableToYStructure(yMap, table) {
  // Clear existing content
  for (const key of Array.from(yMap.keys())) yMap.delete(key);

  yMap.set('columns', table.columns);
  if (table.colWidths) yMap.set('colWidths', JSON.stringify(table.colWidths));
  if (table.rowHeights) yMap.set('rowHeights', JSON.stringify(table.rowHeights));
  if (table.styles) yMap.set('styles', JSON.stringify(table.styles));

  const yRows = new Y.Array();
  for (const row of table.rows) {
    const yRow = new Y.Array();
    for (const cell of row) {
      const yCell = new Y.Map();
      const yText = new Y.Text();
      applyHtmlToYText(yText, cell.text || '');
      yCell.set('text', yText);
      yCell.set('colspan', cell.colspan || 1);
      if (cell.styleId) yCell.set('styleId', cell.styleId);
      yRow.push([yCell]);
    }
    yRows.push([yRow]);
  }
  yMap.set('rows', yRows);
}

/**
 * Read nested Yjs structure back to plain TableData.
 *
 * @param {import('yjs').Map} yMap
 * @returns {{ columns: number, rows: Array<Array<{text, colspan, styleId?}>>, colWidths?, rowHeights?, styles? }}
 */
export function yStructureToTable(yMap) {
  const table = { columns: yMap.get('columns') || 1, rows: [] };

  const colWidths = yMap.get('colWidths');
  if (colWidths) { try { table.colWidths = JSON.parse(colWidths); } catch {} }

  const rowHeights = yMap.get('rowHeights');
  if (rowHeights) { try { table.rowHeights = JSON.parse(rowHeights); } catch {} }

  const styles = yMap.get('styles');
  if (styles) { try { table.styles = JSON.parse(styles); } catch {} }

  const yRows = yMap.get('rows');
  if (yRows && typeof yRows.toArray === 'function') {
    for (let r = 0; r < yRows.length; r++) {
      const yRow = yRows.get(r);
      const row = [];
      if (yRow && typeof yRow.toArray === 'function') {
        for (let c = 0; c < yRow.length; c++) {
          const yCell = yRow.get(c);
          const yText = yCell.get('text');
          const cell = {
            text: yText instanceof Y.Text ? yTextToHtml(yText) : (yText || ''),
            colspan: yCell.get('colspan') || 1,
          };
          const styleId = yCell.get('styleId');
          if (styleId) cell.styleId = styleId;
          row.push(cell);
        }
      }
      table.rows.push(row);
    }
  }

  return table;
}

/**
 * Diff two plain TableData objects to determine if a structural rebuild
 * is needed or if only cell text changed.
 *
 * @returns {{ type: 'structural', table: object } | { type: 'cells', changes: Array<{row, cell, html}> }}
 */
export function diffTableForPublish(prev, next) {
  // Structural checks
  if (prev.columns !== next.columns) return { type: 'structural', table: next };
  if (prev.rows.length !== next.rows.length) return { type: 'structural', table: next };
  if (JSON.stringify(prev.colWidths) !== JSON.stringify(next.colWidths)) return { type: 'structural', table: next };
  if (JSON.stringify(prev.rowHeights) !== JSON.stringify(next.rowHeights)) return { type: 'structural', table: next };

  for (let r = 0; r < prev.rows.length; r++) {
    if (prev.rows[r].length !== next.rows[r].length) return { type: 'structural', table: next };
    for (let c = 0; c < prev.rows[r].length; c++) {
      if ((prev.rows[r][c].colspan || 1) !== (next.rows[r][c].colspan || 1)) {
        return { type: 'structural', table: next };
      }
    }
  }

  // Cell-text-only changes
  const changes = [];
  for (let r = 0; r < prev.rows.length; r++) {
    for (let c = 0; c < prev.rows[r].length; c++) {
      if (prev.rows[r][c].text !== next.rows[r][c].text) {
        changes.push({ row: r, cell: c, html: next.rows[r][c].text });
      }
    }
  }

  return { type: 'cells', changes };
}

/**
 * Apply targeted cell text edits to the nested Yjs table structure.
 * Only touches the Y.Text of affected cells — all other cells' Y.Text
 * instances are preserved for concurrent CRDT merge.
 *
 * @param {import('yjs').Map} yMap - the table Y.Map with nested rows
 * @param {Array<{row: number, cell: number, html: string}>} changes
 */
export function applyTableCellEdits(yMap, changes) {
  const yRows = yMap.get('rows');
  if (!yRows) return;

  for (const { row, cell, html } of changes) {
    const yRow = yRows.get(row);
    if (!yRow) continue;
    const yCell = yRow.get(cell);
    if (!yCell) continue;
    const yText = yCell.get('text');
    if (yText instanceof Y.Text) {
      applyHtmlToYText(yText, html);
    }
  }
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/lib/__tests__/ytable-crdt.test.js`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/ytable-crdt.js src/lib/__tests__/ytable-crdt.test.js
git commit -m "feat(collab): ytable-crdt — nested Yjs structure for fine-grained table sync"
```

---

## Task 7: `yref-crdt.js` — REF CRDT Converter

**Files:**
- Create: `src/lib/__tests__/yref-crdt.test.js`
- Create: `src/lib/yref-crdt.js`

- [ ] **Step 1: Write failing tests**

```javascript
// src/lib/__tests__/yref-crdt.test.js
import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import { refToYStructure, yStructureToRef, applyRefEdits } from '../yref-crdt.js';

function makeRefYMap() {
  const ydoc = new Y.Doc();
  const yMap = ydoc.getMap('ref');
  return { ydoc, yMap };
}

const sampleRef = {
  org: 'ASTM INTERNATIONAL',
  entries: [
    { rid: 'ASTM C33', rtl: 'Standard Specification for Concrete Aggregates' },
    { rid: 'ASTM D2487', rtl: 'Classification of Soils' },
  ],
};

describe('refToYStructure + yStructureToRef roundtrip', () => {
  it('roundtrips a ref block', () => {
    const { ydoc, yMap } = makeRefYMap();
    ydoc.transact(() => refToYStructure(yMap, sampleRef));
    const result = yStructureToRef(yMap);
    expect(result.org).toBe('ASTM INTERNATIONAL');
    expect(result.entries.length).toBe(2);
    expect(result.entries[0].rid).toBe('ASTM C33');
    expect(result.entries[1].rtl).toBe('Classification of Soils');
  });

  it('handles empty entries array', () => {
    const ref = { org: 'TEST ORG', entries: [] };
    const { ydoc, yMap } = makeRefYMap();
    ydoc.transact(() => refToYStructure(yMap, ref));
    const result = yStructureToRef(yMap);
    expect(result.org).toBe('TEST ORG');
    expect(result.entries).toEqual([]);
  });
});

describe('applyRefEdits', () => {
  it('updates org text', () => {
    const { ydoc, yMap } = makeRefYMap();
    ydoc.transact(() => refToYStructure(yMap, sampleRef));
    const nextRef = { ...sampleRef, org: 'AASHTO' };
    applyRefEdits(yMap, sampleRef, nextRef);
    const result = yStructureToRef(yMap);
    expect(result.org).toBe('AASHTO');
  });

  it('updates entry rid text', () => {
    const { ydoc, yMap } = makeRefYMap();
    ydoc.transact(() => refToYStructure(yMap, sampleRef));
    const nextRef = {
      ...sampleRef,
      entries: [
        { rid: 'ASTM C33/C33M', rtl: sampleRef.entries[0].rtl },
        sampleRef.entries[1],
      ],
    };
    applyRefEdits(yMap, sampleRef, nextRef);
    const result = yStructureToRef(yMap);
    expect(result.entries[0].rid).toBe('ASTM C33/C33M');
    expect(result.entries[1].rid).toBe('ASTM D2487'); // unchanged
  });

  it('appends new entry', () => {
    const { ydoc, yMap } = makeRefYMap();
    ydoc.transact(() => refToYStructure(yMap, sampleRef));
    const nextRef = {
      ...sampleRef,
      entries: [...sampleRef.entries, { rid: 'ASTM D698', rtl: 'Lab Compaction' }],
    };
    applyRefEdits(yMap, sampleRef, nextRef);
    const result = yStructureToRef(yMap);
    expect(result.entries.length).toBe(3);
    expect(result.entries[2].rid).toBe('ASTM D698');
  });

  it('removes an entry', () => {
    const { ydoc, yMap } = makeRefYMap();
    ydoc.transact(() => refToYStructure(yMap, sampleRef));
    const nextRef = { ...sampleRef, entries: [sampleRef.entries[0]] };
    applyRefEdits(yMap, sampleRef, nextRef);
    const result = yStructureToRef(yMap);
    expect(result.entries.length).toBe(1);
    expect(result.entries[0].rid).toBe('ASTM C33');
  });
});

describe('two-doc ref merge', () => {
  it('concurrent entry additions merge', () => {
    const doc1 = new Y.Doc(); const doc2 = new Y.Doc();
    const m1 = doc1.getMap('r'); const m2 = doc2.getMap('r');

    doc1.transact(() => refToYStructure(m1, sampleRef));
    Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1, Y.encodeStateVector(doc2)));

    // Doc1 adds entry
    applyRefEdits(m1, sampleRef, {
      ...sampleRef,
      entries: [...sampleRef.entries, { rid: 'ASTM D698', rtl: 'Lab Compaction' }],
    });
    // Doc2 adds different entry
    applyRefEdits(m2, sampleRef, {
      ...sampleRef,
      entries: [...sampleRef.entries, { rid: 'AASHTO T99', rtl: 'Moisture-Density' }],
    });

    // Sync
    const u1 = Y.encodeStateAsUpdate(doc1, Y.encodeStateVector(doc2));
    const u2 = Y.encodeStateAsUpdate(doc2, Y.encodeStateVector(doc1));
    Y.applyUpdate(doc1, u2);
    Y.applyUpdate(doc2, u1);

    const r1 = yStructureToRef(m1);
    const r2 = yStructureToRef(m2);
    expect(r1.entries.length).toBe(4); // 2 original + 2 added
    expect(r1.entries.length).toBe(r2.entries.length); // convergence
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/__tests__/yref-crdt.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `yref-crdt.js`**

```javascript
// src/lib/yref-crdt.js
/**
 * REF block CRDT converter — bidirectional mapping between plain RefData
 * and nested Yjs structures.
 *
 * org uses Y.Text for character-level merge.
 * entries uses Y.Array<Y.Map> where each entry has rid/rtl as Y.Text.
 */

import * as Y from 'yjs';
import { applyHtmlToYText, yTextToHtml } from './ytext-html.js';

/**
 * Populate a Y.Map with nested Yjs structure from plain RefData.
 * Must be called inside a Y.Doc transaction.
 *
 * @param {import('yjs').Map} yMap
 * @param {{ org: string, entries: Array<{rid: string, rtl: string}> }} ref
 */
export function refToYStructure(yMap, ref) {
  for (const key of Array.from(yMap.keys())) yMap.delete(key);

  const yOrg = new Y.Text();
  applyHtmlToYText(yOrg, ref.org || '');
  yMap.set('org', yOrg);

  const yEntries = new Y.Array();
  for (const entry of ref.entries) {
    const yEntry = new Y.Map();
    const yRid = new Y.Text();
    applyHtmlToYText(yRid, entry.rid || '');
    yEntry.set('rid', yRid);
    const yRtl = new Y.Text();
    applyHtmlToYText(yRtl, entry.rtl || '');
    yEntry.set('rtl', yRtl);
    yEntries.push([yEntry]);
  }
  yMap.set('entries', yEntries);
}

/**
 * Read nested Yjs structure back to plain RefData.
 */
export function yStructureToRef(yMap) {
  const yOrg = yMap.get('org');
  const org = yOrg instanceof Y.Text ? yTextToHtml(yOrg) : (yOrg || '');

  const entries = [];
  const yEntries = yMap.get('entries');
  if (yEntries && typeof yEntries.toArray === 'function') {
    for (let i = 0; i < yEntries.length; i++) {
      const yEntry = yEntries.get(i);
      const yRid = yEntry.get('rid');
      const yRtl = yEntry.get('rtl');
      entries.push({
        rid: yRid instanceof Y.Text ? yTextToHtml(yRid) : (yRid || ''),
        rtl: yRtl instanceof Y.Text ? yTextToHtml(yRtl) : (yRtl || ''),
      });
    }
  }

  return { org, entries };
}

/**
 * Apply incremental edits to a ref Y.Map.
 * Updates org text, and diffs entry list for adds/removes/edits.
 *
 * @param {import('yjs').Map} yMap
 * @param {{ org: string, entries: Array<{rid, rtl}> }} prevRef
 * @param {{ org: string, entries: Array<{rid, rtl}> }} nextRef
 */
export function applyRefEdits(yMap, prevRef, nextRef) {
  const doc = yMap.doc;
  if (!doc) return;

  doc.transact(() => {
    // Update org
    if (prevRef.org !== nextRef.org) {
      const yOrg = yMap.get('org');
      if (yOrg instanceof Y.Text) {
        applyHtmlToYText(yOrg, nextRef.org || '');
      }
    }

    const yEntries = yMap.get('entries');
    if (!yEntries) return;

    const prevLen = prevRef.entries.length;
    const nextLen = nextRef.entries.length;
    const minLen = Math.min(prevLen, nextLen);

    // Update existing entries (text changes)
    for (let i = 0; i < minLen; i++) {
      const pe = prevRef.entries[i];
      const ne = nextRef.entries[i];
      if (pe.rid !== ne.rid || pe.rtl !== ne.rtl) {
        const yEntry = yEntries.get(i);
        if (!yEntry) continue;
        if (pe.rid !== ne.rid) {
          const yRid = yEntry.get('rid');
          if (yRid instanceof Y.Text) applyHtmlToYText(yRid, ne.rid || '');
        }
        if (pe.rtl !== ne.rtl) {
          const yRtl = yEntry.get('rtl');
          if (yRtl instanceof Y.Text) applyHtmlToYText(yRtl, ne.rtl || '');
        }
      }
    }

    // Remove extra entries (from the end)
    if (nextLen < prevLen) {
      yEntries.delete(nextLen, prevLen - nextLen);
    }

    // Append new entries
    if (nextLen > prevLen) {
      for (let i = prevLen; i < nextLen; i++) {
        const entry = nextRef.entries[i];
        const yEntry = new Y.Map();
        const yRid = new Y.Text();
        applyHtmlToYText(yRid, entry.rid || '');
        yEntry.set('rid', yRid);
        const yRtl = new Y.Text();
        applyHtmlToYText(yRtl, entry.rtl || '');
        yEntry.set('rtl', yRtl);
        yEntries.push([yEntry]);
      }
    }
  });
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/lib/__tests__/yref-crdt.test.js`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/yref-crdt.js src/lib/__tests__/yref-crdt.test.js
git commit -m "feat(collab): yref-crdt — nested Yjs structure for fine-grained REF sync"
```

---

## Task 8: Integrate Table/REF CRDT into `collab.js`

**Files:**
- Modify: `src/lib/collab.js`
- Modify: `src/lib/__tests__/collab.test.js`

Replace `JSON_KEYS` approach with CRDT converters.

- [ ] **Step 1: Write integration tests**

Add to `src/lib/__tests__/collab.test.js`:

```javascript
describe('fine-grained table/REF sync', () => {
  it('concurrent cell edits on same table block merge', () => {
    const { ydoc: doc1, yOrder: o1, yStore: s1 } = makeDoc();
    const { ydoc: doc2, yOrder: o2, yStore: s2 } = makeDoc();

    const table = {
      columns: 2,
      rows: [
        [{ text: 'A1', colspan: 1 }, { text: 'B1', colspan: 1 }],
        [{ text: 'A2', colspan: 1 }, { text: 'B2', colspan: 1 }],
      ],
    };
    const blocks = [{ id: 't1', type: 'table', part: 1, depth: 1, section: 's1', table }];

    seedYBlocks(doc1, o1, s1, blocks);
    Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1, Y.encodeStateVector(doc2)));

    // Doc1 edits A1
    const t1 = { ...table, rows: [[{ text: 'Doc1', colspan: 1 }, { text: 'B1', colspan: 1 }], table.rows[1]] };
    applyBlocksToYDoc(doc1, o1, s1, [{ ...blocks[0], table: t1 }]);

    // Doc2 edits B2
    const t2 = { ...table, rows: [table.rows[0], [{ text: 'A2', colspan: 1 }, { text: 'Doc2', colspan: 1 }]] };
    applyBlocksToYDoc(doc2, o2, s2, [{ ...blocks[0], table: t2 }]);

    // Sync
    const u1 = Y.encodeStateAsUpdate(doc1, Y.encodeStateVector(doc2));
    const u2 = Y.encodeStateAsUpdate(doc2, Y.encodeStateVector(doc1));
    Y.applyUpdate(doc1, u2);
    Y.applyUpdate(doc2, u1);

    const r1 = yBlocksToArray(o1, s1);
    const r2 = yBlocksToArray(o2, s2);
    expect(r1[0].table.rows[0][0].text).toBe('Doc1');
    expect(r1[0].table.rows[1][1].text).toBe('Doc2');
    expect(JSON.stringify(r1[0].table)).toBe(JSON.stringify(r2[0].table));
  });

  it('concurrent ref entry additions merge', () => {
    const { ydoc: doc1, yOrder: o1, yStore: s1 } = makeDoc();
    const { ydoc: doc2, yOrder: o2, yStore: s2 } = makeDoc();

    const ref = { org: 'ASTM', entries: [{ rid: 'C33', rtl: 'Aggregates' }] };
    const blocks = [{ id: 'r1', type: 'ref', part: 1, depth: 1, section: 's1', ref }];

    seedYBlocks(doc1, o1, s1, blocks);
    Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1, Y.encodeStateVector(doc2)));

    // Doc1 adds entry
    const ref1 = { ...ref, entries: [...ref.entries, { rid: 'D698', rtl: 'Compaction' }] };
    applyBlocksToYDoc(doc1, o1, s1, [{ ...blocks[0], ref: ref1 }]);

    // Doc2 adds different entry
    const ref2 = { ...ref, entries: [...ref.entries, { rid: 'D2487', rtl: 'Soils' }] };
    applyBlocksToYDoc(doc2, o2, s2, [{ ...blocks[0], ref: ref2 }]);

    // Sync
    const u1 = Y.encodeStateAsUpdate(doc1, Y.encodeStateVector(doc2));
    const u2 = Y.encodeStateAsUpdate(doc2, Y.encodeStateVector(doc1));
    Y.applyUpdate(doc1, u2);
    Y.applyUpdate(doc2, u1);

    const r1 = yBlocksToArray(o1, s1);
    const r2 = yBlocksToArray(o2, s2);
    expect(r1[0].ref.entries.length).toBe(3);
    expect(r1[0].ref.entries.length).toBe(r2[0].ref.entries.length);
  });

  it('backward compat: reads legacy JSON-string table as plain data', () => {
    const { ydoc, yOrder, yStore } = makeDoc();
    const table = { columns: 1, rows: [[{ text: 'cell', colspan: 1 }]] };

    // Manually create a legacy-format block (JSON string, not Y.Map)
    ydoc.transact(() => {
      const yMap = new Y.Map();
      yMap.set('id', 'legacy');
      yMap.set('type', 'table');
      yMap.set('table', JSON.stringify(table));
      const yText = new Y.Text();
      yText.insert(0, '');
      yMap.set('html', yText);
      yStore.set('legacy', yMap);
      yOrder.push(['legacy']);
    });

    const blocks = yBlocksToArray(yOrder, yStore);
    expect(blocks[0].table).toEqual(table);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/__tests__/collab.test.js`
Expected: FAIL — table/ref blocks still use JSON strings

- [ ] **Step 3: Modify `collab.js` for table/REF CRDT**

In `src/lib/collab.js`:

1. Add imports:
```javascript
import { tableToYStructure, yStructureToTable, diffTableForPublish, applyTableCellEdits } from './ytable-crdt.js';
import { refToYStructure, yStructureToRef, applyRefEdits } from './yref-crdt.js';
```

2. Remove `JSON_KEYS` constant (line 114). Replace all references.

3. Update `blockToYMap()` — replace the JSON_KEYS loop:
```javascript
function blockToYMap(block) {
  const yMap = new Y.Map();
  for (const k of SCALAR_KEYS) {
    if (block[k] !== undefined) yMap.set(k, block[k]);
  }
  const yText = new Y.Text();
  applyHtmlToYText(yText, block.html || '');
  yMap.set('html', yText);
  // Table/REF: nested CRDT structures
  if (block.table) {
    const yTable = new Y.Map();
    tableToYStructure(yTable, block.table);
    yMap.set('table', yTable);
  }
  if (block.ref) {
    const yRef = new Y.Map();
    refToYStructure(yRef, block.ref);
    yMap.set('ref', yRef);
  }
  return yMap;
}
```

4. Update `yMapToBlock()` — replace the JSON_KEYS loop:
```javascript
function yMapToBlock(yMap) {
  const block = {};
  for (const k of SCALAR_KEYS) {
    const v = yMap.get(k);
    if (v !== undefined) block[k] = v;
  }
  const yText = yMap.get('html');
  block.html = yText instanceof Y.Text ? yTextToHtml(yText) : (yText || '');
  // Table: nested CRDT or legacy JSON string
  const rawTable = yMap.get('table');
  if (rawTable) {
    if (typeof rawTable === 'string') {
      try { block.table = JSON.parse(rawTable); } catch {}
    } else if (typeof rawTable.get === 'function') {
      block.table = yStructureToTable(rawTable);
    }
  }
  // REF: nested CRDT or legacy JSON string
  const rawRef = yMap.get('ref');
  if (rawRef) {
    if (typeof rawRef === 'string') {
      try { block.ref = JSON.parse(rawRef); } catch {}
    } else if (typeof rawRef.get === 'function') {
      block.ref = yStructureToRef(rawRef);
    }
  }
  return block;
}
```

5. Update `updateYMapFromBlock()` — replace the JSON_KEYS loop with CRDT-aware updates:
```javascript
  // Table CRDT update
  const curTableYMap = ymap.get('table');
  if (block.table) {
    if (!curTableYMap || typeof curTableYMap === 'string') {
      // Legacy or new: create fresh CRDT structure
      const yTable = new Y.Map();
      tableToYStructure(yTable, block.table);
      ymap.set('table', yTable);
    } else {
      // Existing CRDT structure: diff for cell-only vs structural
      const prevTable = yStructureToTable(curTableYMap);
      const diff = diffTableForPublish(prevTable, block.table);
      if (diff.type === 'structural') {
        tableToYStructure(curTableYMap, block.table);
      } else if (diff.changes.length > 0) {
        applyTableCellEdits(curTableYMap, diff.changes);
      }
    }
  } else if (curTableYMap) {
    ymap.delete('table');
  }

  // REF CRDT update
  const curRefYMap = ymap.get('ref');
  if (block.ref) {
    if (!curRefYMap || typeof curRefYMap === 'string') {
      const yRef = new Y.Map();
      refToYStructure(yRef, block.ref);
      ymap.set('ref', yRef);
    } else {
      const prevRef = yStructureToRef(curRefYMap);
      applyRefEdits(curRefYMap, prevRef, block.ref);
    }
  } else if (curRefYMap) {
    ymap.delete('ref');
  }
```

6. Update `estimatePublishBytes()` — keep JSON.stringify for size estimation (it's an overestimate, which is correct for the guard):
```javascript
// No change needed — estimatePublishBytes already uses JSON.stringify
// for table/ref, which overestimates vs Yjs encoding. That's by design.
```

- [ ] **Step 4: Run all collab tests**

Run: `npx vitest run src/lib/__tests__/collab.test.js`
Expected: All tests PASS

- [ ] **Step 5: Run full test suite**

Run: `npm test`
Expected: All 566 Vitest tests PASS

- [ ] **Step 6: Commit**

```bash
git add src/lib/collab.js src/lib/__tests__/collab.test.js
git commit -m "feat(collab): integrate table/REF CRDT — fine-grained sync replaces JSON LWW"
```

---

## Task 9: Update Server-Side Room Serializer

**Files:**
- Modify: `server/room-serializer.cjs`
- Modify: `server/__tests__/room-serializer.test.mjs`

The server reads Y.Doc state to generate .SEC files. With the new attribute-based Y.Text and nested table/REF structures, the serializer needs to handle both formats.

- [ ] **Step 1: Write failing test for attribute-aware serialization**

Add to `server/__tests__/room-serializer.test.mjs`:

```javascript
it('serializes Y.Text with formatting attributes to plain HTML', async () => {
  // Create a doc with attribute-based Y.Text (new format)
  const ydoc = new Y.Doc();
  const yOrder = ydoc.getArray('order');
  const yStore = ydoc.getMap('store');
  const yMeta = ydoc.getMap('meta');

  ydoc.transact(() => {
    const yMap = new Y.Map();
    yMap.set('id', 'b1');
    yMap.set('type', 'txt');
    yMap.set('part', 1);
    yMap.set('depth', 1);
    const yText = new Y.Text();
    // Insert with attributes (new format)
    yText.insert(0, 'Hello ', {});
    yText.insert(6, 'bold', { bold: true });
    yMap.set('html', yText);
    yStore.set('b1', yMap);
    yOrder.push(['b1']);
    yMeta.set('sectionNumber', '99 00 00');
  });

  const result = await serializeRoom(ydoc);
  // The .SEC should contain the text with BLD tags
  const secText = new TextDecoder('windows-1252').decode(result.secBytes);
  expect(secText).toContain('<BLD>bold</BLD>');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:server`
Expected: FAIL — Y.Text.toString() strips attributes, so `<BLD>` tags are missing

- [ ] **Step 3: Update room-serializer.cjs**

The key issue: on the server side (CJS), `yMapToBlock()` from ESM `collab.js` now calls `yTextToHtml()` which uses formatting attributes. But the dual-package hazard means the ESM's Y.Text might not be the same class as the CJS Y.Text.

The existing coercion on line 57 (`b.html = b.html.toString()`) would strip attributes. We need to check: if the ESM module's `yBlocksToArray` already calls `yTextToHtml` (which it does after Task 5), then the blocks will already have proper HTML strings. The `.toString()` coercion should only fire as a fallback.

Update `server/room-serializer.cjs` line 56-58:

```javascript
  // Dual-package hazard: CJS require('yjs') and ESM import('yjs') may load
  // separate copies. The ESM yBlocksToArray now calls yTextToHtml() which
  // handles formatting attributes. The coercion below is a fallback for any
  // edge case where html is still a Y.Text object (e.g., toString() loses
  // attribute info, but this path should rarely fire now).
  for (const b of blocks) {
    if (b.html && typeof b.html !== 'string') b.html = String(b.html);
  }
```

No other changes needed — `yBlocksToArray` calls `yMapToBlock` which now uses `yTextToHtml`.

- [ ] **Step 4: Run server tests**

Run: `npm run test:server`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add server/room-serializer.cjs server/__tests__/room-serializer.test.mjs
git commit -m "fix(server): update room-serializer for attribute-aware Y.Text and CRDT table/ref"
```

---

## Task 10: Update Server-Side CJS Block Seeding

**Files:**
- Modify: `server/room-serializer.cjs`

The CJS `blockToYMap` in room-serializer.cjs (used by `seedRoomFromBlocks`) still uses plain `yText.insert(0, html)` and `JSON.stringify` for table/ref. This means uploaded .SEC files won't get the new CRDT structure. Update it to match.

- [ ] **Step 1: Update CJS `blockToYMap` in room-serializer.cjs**

The CJS side can't import ESM modules synchronously. Since seeding is a one-time operation and the full CRDT converters require ESM imports, the simplest approach is: keep the CJS seeding simple (plain text + JSON strings). The first client to connect and publish will upgrade the structure to CRDT format via `updateYMapFromBlock()`.

This is acceptable because:
- Seeding happens once (upload or first connect)
- The ESM `updateYMapFromBlock` handles the legacy → CRDT migration
- No concurrent edits happen during seeding

Add a comment to `seedRoomFromBlocks` documenting this:

```javascript
/**
 * Seed a Y.Doc with parsed blocks, using CJS Yjs to avoid dual-package hazard.
 * Clears existing content and replaces with the provided blocks.
 *
 * NOTE: Seeds with plain text Y.Text (no formatting attributes) and JSON strings
 * for table/ref. The ESM client's updateYMapFromBlock() will upgrade these to
 * attribute-based Y.Text and nested CRDT structures on first publish. This is
 * acceptable because seeding is a one-time operation with no concurrent edits.
 */
```

- [ ] **Step 2: Run server tests to verify nothing broke**

Run: `npm run test:server`
Expected: All tests PASS

- [ ] **Step 3: Commit**

```bash
git add server/room-serializer.cjs
git commit -m "docs(server): document CJS seeding legacy format — upgraded on first client publish"
```

---

## Task 11: Full Regression Test

**Files:** None (test-only)

- [ ] **Step 1: Run all Vitest tests**

Run: `npm test`
Expected: All 566+ Vitest tests PASS (count will increase with new tests)

- [ ] **Step 2: Run server tests**

Run: `npm run test:server`
Expected: All 22+ server tests PASS

- [ ] **Step 3: Run interop tests**

Run: `npm run test:interop`
Expected: All 17 interop tests PASS (parse → serialize → validate unchanged)

- [ ] **Step 4: Run interop encoding tests**

Run: `npm run test:interop:encoding`
Expected: All 11 encoding tests PASS

- [ ] **Step 5: Commit final state (if any test fixes were needed)**

```bash
git add -A
git commit -m "test: full regression pass after CRDT merge + table/REF sync integration"
```
