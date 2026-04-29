/**
 * ytext-html.js — Y.Text deltas ↔ HTML string conversion
 *
 * Receive direction: yTextToHtml converts Y.Text (with formatting attributes)
 * into an HTML string that EditableBlock can render.
 *
 * Nesting order (outermost → innermost): comment → revision → mark → format
 */

/**
 * Escape special HTML characters in text content.
 * @param {string} str
 * @returns {string}
 */
function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Escape a string for safe interpolation into an HTML attribute value.
 * Prevents attribute injection from untrusted Y.Doc data (e.g. remote peers).
 * @param {string} str
 * @returns {string}
 */
function escapeAttr(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Known mark types — used as allowlist for class name interpolation (defense-in-depth)
const VALID_MARKS = new Set(['rid', 'srf', 'sub', 'eng', 'met', 'tai', 'tst', 'url', 'att', 'comment']);

// All attribute keys that affect tag generation, in nesting order
const NESTING_KEYS = ['comment', 'revision', 'mark', 'bold', 'italic', 'underline'];
// Auxiliary keys that modify how a primary key renders
const AUX_KEYS = ['markOption', 'revisionAuthor', 'revisionAuthorColor', 'commentResolved'];

/**
 * Check if two attribute objects produce the same HTML tags.
 * Normalizes falsy values to null so that `false`, `undefined`, and absent
 * keys are treated as equivalent (Yjs may use any of these to represent
 * "attribute removed").
 * @param {object} a
 * @param {object} b
 * @returns {boolean}
 */
function attrsEqual(a, b) {
  if (a === b) return true;
  if (!a || !b) return (!a || Object.keys(a).length === 0) && (!b || Object.keys(b).length === 0);
  for (const key of NESTING_KEYS) {
    if ((a[key] || null) !== (b[key] || null)) return false;
  }
  for (const key of AUX_KEYS) {
    if ((a[key] || null) !== (b[key] || null)) return false;
  }
  return true;
}

/**
 * Build the opening HTML tag(s) string and matching closing tag(s) string for
 * a given attributes object, in the correct nesting order:
 *   comment → revision → mark → format (bold/italic/underline)
 *
 * @param {object} attrs
 * @returns {{ open: string, close: string }}
 */
function buildTags(attrs) {
  if (!attrs || Object.keys(attrs).length === 0) {
    return { open: '', close: '' };
  }

  const openParts = [];
  const closeParts = [];

  // Layer 1 (outermost): comment
  if (attrs.comment) {
    const cls = attrs.commentResolved ? 'mark-comment-resolved' : 'mark-comment';
    openParts.push(`<span class="${cls}" data-comment-id="${escapeAttr(attrs.comment)}">`);
    closeParts.unshift('</span>');
  }

  // Layer 2: revision
  if (attrs.revision) {
    const rev = attrs.revision;
    const styleAttr = attrs.revisionAuthorColor
      ? ` style="--author-color:${escapeAttr(attrs.revisionAuthorColor)}"`
      : '';
    const authorIdAttr = attrs.revisionAuthor
      ? ` data-author-id="${escapeAttr(attrs.revisionAuthor)}"`
      : '';

    if (rev === 'add') {
      openParts.push(`<ins class="mark-add"${authorIdAttr}${styleAttr}>`);
      closeParts.unshift('</ins>');
    } else if (rev === 'del') {
      openParts.push(`<del class="mark-del"${authorIdAttr}${styleAttr}>`);
      closeParts.unshift('</del>');
    } else if (rev === 'chg') {
      openParts.push(`<span class="mark-chg"${authorIdAttr}${styleAttr}>`);
      closeParts.unshift('</span>');
    }
  }

  // Layer 3: mark (allowlist prevents class-name injection from malicious peers)
  if (attrs.mark && VALID_MARKS.has(attrs.mark)) {
    const markClass = `mark-${attrs.mark}`;
    const dataOpt = (attrs.mark === 'tai' && attrs.markOption) ? ` data-opt="${escapeAttr(attrs.markOption)}"` : '';
    openParts.push(`<span class="${markClass}"${dataOpt}>`);
    closeParts.unshift('</span>');
  }

  // Layer 4 (innermost): format — bold, italic, underline
  if (attrs.bold) {
    openParts.push('<b>');
    closeParts.unshift('</b>');
  }
  if (attrs.italic) {
    openParts.push('<i>');
    closeParts.unshift('</i>');
  }
  if (attrs.underline) {
    openParts.push('<u>');
    closeParts.unshift('</u>');
  }

  return {
    open: openParts.join(''),
    close: closeParts.join(''),
  };
}

// Mark class names that map to the `mark` attribute (e.g. mark-rid → 'rid')
const MARK_CLASSES = new Set(['rid', 'srf', 'sub', 'eng', 'met', 'tai', 'tst', 'url', 'att', 'hls']);

/**
 * Extract the `--author-color` CSS custom property value from an inline style string.
 * @param {string} style  e.g. "--author-color:#ff6b6b"
 * @returns {string|null}
 */
function extractAuthorColor(style) {
  if (!style) return null;
  const match = style.match(/--author-color:\s*([^;]+)/);
  return match ? match[1].trim() : null;
}

/**
 * Merge child formatting context into parent context.
 * Child values override parent values on same key.
 * @param {object} parent
 * @param {object} child
 * @returns {object}
 */
function mergeAttrs(parent, child) {
  if (!child || Object.keys(child).length === 0) return parent;
  return { ...parent, ...child };
}

/**
 * Derive formatting attributes contributed by a single DOM element.
 * Returns only the attrs added at this level (not inherited from parent).
 * @param {Element} el
 * @returns {object}
 */
function attrsFromElement(el) {
  const tag = el.tagName ? el.tagName.toLowerCase() : '';
  const cls = el.className || '';

  // Skip tag-label spans — they are editor UI injected by syncTagLabels(), not content
  if (cls.includes('tag-label')) return null; // null = skip entire subtree

  const attrs = {};

  // Format tags
  if (tag === 'b' || tag === 'strong') attrs.bold = true;
  if (tag === 'i' || tag === 'em') attrs.italic = true;
  if (tag === 'u') attrs.underline = true;

  // Revision tags
  if (tag === 'ins' && cls.includes('mark-add')) {
    attrs.revision = 'add';
    const authorId = el.getAttribute('data-author-id');
    if (authorId) attrs.revisionAuthor = authorId;
    const color = extractAuthorColor(el.getAttribute('style') || '');
    if (color) attrs.revisionAuthorColor = color;
  } else if (tag === 'del' && cls.includes('mark-del')) {
    attrs.revision = 'del';
    const authorId = el.getAttribute('data-author-id');
    if (authorId) attrs.revisionAuthor = authorId;
    const color = extractAuthorColor(el.getAttribute('style') || '');
    if (color) attrs.revisionAuthorColor = color;
  } else if (cls.includes('mark-chg')) {
    attrs.revision = 'chg';
    const authorId = el.getAttribute('data-author-id');
    if (authorId) attrs.revisionAuthor = authorId;
    const color = extractAuthorColor(el.getAttribute('style') || '');
    if (color) attrs.revisionAuthorColor = color;
  }

  // Comment spans
  if (cls.includes('mark-comment-resolved')) {
    const commentId = el.getAttribute('data-comment-id');
    if (commentId) {
      attrs.comment = commentId;
      attrs.commentResolved = true;
    }
  } else if (cls.includes('mark-comment')) {
    const commentId = el.getAttribute('data-comment-id');
    if (commentId) attrs.comment = commentId;
  }

  // Mark spans: mark-rid, mark-srf, mark-sub, etc.
  if (tag === 'span' && !attrs.revision && !attrs.comment) {
    for (const markType of MARK_CLASSES) {
      if (cls.includes(`mark-${markType}`)) {
        attrs.mark = markType;
        if (markType === 'tai') {
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
 * Walk a DOM subtree recursively, emitting {char, attrs} tuples for every
 * character in text nodes (excluding zero-width spaces \u200B).
 *
 * @param {Node} node         — current DOM node
 * @param {object} parentAttrs — accumulated attrs from ancestor elements
 * @param {Array} result       — output array to push into
 */
function walkNode(node, parentAttrs, result) {
  const TEXT_NODE = 3;
  const ELEMENT_NODE = 1;

  if (node.nodeType === TEXT_NODE) {
    const text = node.nodeValue || '';
    for (const char of text) {
      if (char === '\u200B') continue; // strip zero-width spaces
      result.push({ char, attrs: parentAttrs });
    }
    return;
  }

  if (node.nodeType === ELEMENT_NODE) {
    const delta = attrsFromElement(node);
    if (delta === null) return; // skip entire subtree (tag-label)

    const childAttrs = mergeAttrs(parentAttrs, delta);
    for (const child of node.childNodes) {
      walkNode(child, childAttrs, result);
    }
    return;
  }

  // Other node types (comments, etc.) — recurse if they have children
  if (node.childNodes && node.childNodes.length > 0) {
    for (const child of node.childNodes) {
      walkNode(child, parentAttrs, result);
    }
  }
}

/**
 * Parse an HTML string into a flat list of {char, attrs} tuples.
 *
 * Each tuple represents one character from the visible text content, with the
 * merged formatting attributes that apply to it. Used by applyHtmlToYText to
 * diff block HTML against Y.Text state in the publish direction.
 *
 * @param {string} html
 * @returns {Array<{char: string, attrs: object}>}
 */
export function htmlToAttrList(html) {
  if (!html) return [];

  // Wrap in a root element and parse as text/xml — this is the established
  // pattern in this codebase (see sec-serializer.js). linkedom's DOMParser
  // supports text/xml reliably across both browser and Node test environments.
  //
  // Pre-processing: replace HTML-only entities (&nbsp;, &mdash;, etc.) with
  // their numeric equivalents, since XML only defines 5 entities (amp, lt, gt,
  // apos, quot). Also escape bare ampersands that aren't entity references.
  const HTML_ENTITIES = { nbsp: 160, mdash: 8212, ndash: 8211, trade: 8482, copy: 169, reg: 174, laquo: 171, raquo: 187, bull: 8226, hellip: 8230, euro: 8364 };
  let safeHtml = html.replace(/&([a-zA-Z]+);/g, (match, name) => {
    if (['amp', 'lt', 'gt', 'apos', 'quot'].includes(name)) return match; // XML built-ins
    const code = HTML_ENTITIES[name];
    return code ? `&#${code};` : match;
  });
  safeHtml = safeHtml.replace(/&(?![a-zA-Z#][a-zA-Z0-9]*;)/g, '&amp;');
  const parser = new DOMParser();
  const doc = parser.parseFromString(`<root>${safeHtml}</root>`, 'text/xml');

  // Browser DOMParser returns a document containing a <parsererror> element
  // when the input isn't well-formed XML (e.g. a bare <br> the contentEditable
  // emits). Walking such a doc would inject the human-readable error message
  // ("This page contains the following errors...") into the Y.Text as content
  // and silently corrupt R2 on persist. Refuse to parse instead.
  // (linkedom is lenient and never produces parsererror, so this guard is
  // a no-op in unit tests but critical in the browser.)
  const parseError = doc.querySelector('parsererror');
  if (parseError) {
    const detail = (parseError.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    throw new Error(`htmlToAttrList: malformed HTML produced parsererror: ${detail}`);
  }

  // The root element is the <root> wrapper we added
  const root = doc.documentElement;

  const result = [];
  for (const child of root.childNodes) {
    walkNode(child, {}, result);
  }
  return result;
}

/**
 * Read Y.Text delta state into per-character {char, attrs} tuples.
 * Cleans attrs the same way attrsEqual normalizes: only NESTING_KEYS + AUX_KEYS
 * are kept, and falsy values are omitted.
 *
 * @param {import('yjs').Text} yText
 * @returns {Array<{char: string, attrs: object}>}
 */
function yTextToAttrList(yText) {
  const deltas = yText.toDelta();
  const result = [];
  for (const delta of deltas) {
    const raw = delta.attributes || {};
    // Clean: only keep known keys with truthy values
    const cleaned = {};
    for (const key of NESTING_KEYS) {
      if (raw[key]) cleaned[key] = raw[key];
    }
    for (const key of AUX_KEYS) {
      if (raw[key]) cleaned[key] = raw[key];
    }
    const text = delta.insert;
    for (const char of text) {
      result.push({ char, attrs: cleaned });
    }
  }
  return result;
}

/**
 * Compute LCS (Longest Common Subsequence) diff operations between two
 * character arrays. Returns an array of operations:
 *   { type: 'keep', oldIdx, newIdx }
 *   { type: 'delete', oldIdx }
 *   { type: 'insert', newIdx }
 *
 * Uses standard DP with Uint16Array rows for memory efficiency.
 *
 * @param {string[]} oldChars
 * @param {string[]} newChars
 * @returns {Array<{type: string, oldIdx?: number, newIdx?: number}>}
 */
function lcsOps(oldChars, newChars) {
  const m = oldChars.length;
  const n = newChars.length;

  // Guard: Uint16Array overflows at 65535.  Fall back to a simple
  // "delete all old, insert all new" edit script for oversized blocks.
  if (m > 65535 || n > 65535) {
    const ops = [];
    for (let i = 0; i < m; i++) ops.push({ type: 'delete', oldIdx: i });
    for (let j = 0; j < n; j++) ops.push({ type: 'insert', newIdx: j });
    return ops;
  }

  // Build full LCS table for backtracking.
  // Uint16Array for memory efficiency (capped at 65535 chars).
  const table = [];
  for (let i = 0; i <= m; i++) {
    table[i] = new Uint16Array(n + 1);
  }
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldChars[i - 1] === newChars[j - 1]) {
        table[i][j] = table[i - 1][j - 1] + 1;
      } else {
        table[i][j] = table[i - 1][j] > table[i][j - 1] ? table[i - 1][j] : table[i][j - 1];
      }
    }
  }

  // Backtrack from table[m][n]
  const ops = [];
  let i = m;
  let j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldChars[i - 1] === newChars[j - 1]) {
      ops.push({ type: 'keep', oldIdx: i - 1, newIdx: j - 1 });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || table[i][j - 1] >= table[i - 1][j])) {
      ops.push({ type: 'insert', newIdx: j - 1 });
      j--;
    } else {
      ops.push({ type: 'delete', oldIdx: i - 1 });
      i--;
    }
  }

  ops.reverse();
  return ops;
}

/**
 * Compute the attribute delta between old and new attrs.
 * Only includes keys that changed. Removed attrs are set to null (Yjs convention).
 * Returns null if no changes.
 *
 * @param {object} oldAttrs
 * @param {object} newAttrs
 * @returns {object|null}
 */
function attrsDelta(oldAttrs, newAttrs) {
  const delta = {};
  let hasChange = false;
  const allKeys = [...NESTING_KEYS, ...AUX_KEYS];
  for (const key of allKeys) {
    const oldVal = oldAttrs[key] || null;
    const newVal = newAttrs[key] || null;
    if (oldVal !== newVal) {
      delta[key] = newVal; // null removes the attribute in Yjs
      hasChange = true;
    }
  }
  return hasChange ? delta : null;
}

/**
 * Apply an HTML string to a Y.Text instance using minimal CRDT operations.
 *
 * Diffs the new HTML against the current Y.Text state and emits only the
 * necessary insert/delete/format operations, preserving Y.Text identity
 * and minimizing CRDT overhead.
 *
 * @param {import('yjs').Text} yText
 * @param {string} newHtml
 */
export function applyHtmlToYText(yText, newHtml) {
  // Guard: detached Y.Text (no doc) — return silently
  if (!yText.doc) return;

  let newTuples;
  try {
    newTuples = htmlToAttrList(newHtml || '');
  } catch (err) {
    // Malformed HTML — leave Y.Text untouched rather than corrupting it.
    // The contentEditable still shows the user's input; only Yjs sync skips.
    // eslint-disable-next-line no-console
    console.warn('applyHtmlToYText: skipping update due to parse error', { err: err.message, htmlPreview: String(newHtml || '').slice(0, 200) });
    return;
  }
  const oldTuples = yTextToAttrList(yText);

  // Quick equality check — if both text and attrs match, skip entirely
  if (oldTuples.length === newTuples.length) {
    let identical = true;
    for (let i = 0; i < oldTuples.length; i++) {
      if (oldTuples[i].char !== newTuples[i].char || !attrsEqual(oldTuples[i].attrs, newTuples[i].attrs)) {
        identical = false;
        break;
      }
    }
    if (identical) return;
  }

  // Extract plain chars for LCS
  const oldChars = oldTuples.map(t => t.char);
  const newChars = newTuples.map(t => t.char);

  const ops = lcsOps(oldChars, newChars);

  // Apply ops inside a transaction for atomicity
  yText.doc.transact(() => {
    // pos tracks current position in the Y.Text as we apply mutations
    let pos = 0;

    for (const op of ops) {
      if (op.type === 'keep') {
        // Check if formatting changed
        const oldAttrs = oldTuples[op.oldIdx].attrs;
        const newAttrs = newTuples[op.newIdx].attrs;
        const delta = attrsDelta(oldAttrs, newAttrs);
        if (delta) {
          yText.format(pos, 1, delta);
        }
        pos++;
      } else if (op.type === 'delete') {
        yText.delete(pos, 1);
        // pos stays same — next char shifts down
      } else if (op.type === 'insert') {
        const attrs = newTuples[op.newIdx].attrs;
        // Only pass attrs if non-empty
        const hasAttrs = Object.keys(attrs).length > 0;
        yText.insert(pos, newTuples[op.newIdx].char, hasAttrs ? attrs : undefined);
        pos++;
      }
    }
  });
}

/**
 * Convert a Y.Text instance into an HTML string.
 *
 * Adjacent deltas with identical attributes are merged into a single tag span.
 * HTML entities in text content are escaped.
 *
 * @param {import('yjs').Text} yText
 * @returns {string}
 */
export function yTextToHtml(yText) {
  // toDelta() returns an array of { insert: string, attributes?: object }
  const deltas = yText.toDelta();
  if (!deltas || deltas.length === 0) return '';

  // Merge adjacent deltas with identical attributes before rendering.
  // This avoids e.g. <b>hello</b><b> world</b> when Yjs splits them.
  const merged = [];
  for (const delta of deltas) {
    const attrs = delta.attributes || null;
    const prev = merged[merged.length - 1];
    if (prev && attrsEqual(prev.attributes, attrs)) {
      prev.insert += delta.insert;
    } else {
      merged.push({ insert: delta.insert, attributes: attrs });
    }
  }

  let html = '';
  for (const delta of merged) {
    const attrs = delta.attributes || {};
    const { open, close } = buildTags(attrs);
    html += open + escapeHtml(delta.insert) + close;
  }
  return html;
}

/**
 * Seed a detached Y.Text from HTML without requiring a Y.Doc transaction.
 * Used by blockToYMap / tableToYStructure where Y.Text has no doc yet.
 * Parses HTML into {char, attrs} tuples and inserts each run with attributes.
 *
 * @param {import('yjs').Text} yText
 * @param {string} html
 */
export function seedYTextFromHtml(yText, html) {
  let tuples;
  try {
    tuples = htmlToAttrList(html || '');
  } catch (err) {
    // Malformed HTML during seed — emit no characters rather than poisoning
    // the freshly-attached Y.Text with parsererror message text.
    // eslint-disable-next-line no-console
    console.warn('seedYTextFromHtml: skipping seed due to parse error', { err: err.message, htmlPreview: String(html || '').slice(0, 200) });
    return;
  }
  if (tuples.length === 0) return;
  // Group consecutive tuples with identical attrs into runs for efficiency.
  // Track position manually — yText.length returns 0 on detached Y.Text instances.
  let pos = 0;
  let runStart = 0;
  while (runStart < tuples.length) {
    const baseAttrs = tuples[runStart].attrs;
    let runEnd = runStart + 1;
    while (runEnd < tuples.length) {
      if (attrsEqual(tuples[runEnd].attrs, baseAttrs)) runEnd++;
      else break;
    }
    const text = tuples.slice(runStart, runEnd).map(t => t.char).join('');
    const hasAttrs = baseAttrs && Object.keys(baseAttrs).length > 0;
    yText.insert(pos, text, hasAttrs ? baseAttrs : undefined);
    pos += text.length;
    runStart = runEnd;
  }
}
