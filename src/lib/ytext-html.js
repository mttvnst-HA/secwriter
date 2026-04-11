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
    openParts.push(`<span class="${cls}" data-comment-id="${attrs.comment}">`);
    closeParts.unshift('</span>');
  }

  // Layer 2: revision
  if (attrs.revision) {
    const rev = attrs.revision;
    const styleAttr = attrs.revisionAuthorColor
      ? ` style="--author-color:${attrs.revisionAuthorColor}"`
      : '';

    if (rev === 'add') {
      openParts.push(`<ins class="mark-add"${styleAttr}>`);
      closeParts.unshift('</ins>');
    } else if (rev === 'del') {
      openParts.push(`<del class="mark-del"${styleAttr}>`);
      closeParts.unshift('</del>');
    } else if (rev === 'chg') {
      openParts.push(`<span class="mark-chg"${styleAttr}>`);
      closeParts.unshift('</span>');
    }
  }

  // Layer 3: mark
  if (attrs.mark) {
    const markClass = `mark-${attrs.mark}`;
    const dataOpt = (attrs.mark === 'tai' && attrs.markOption) ? ` data-opt="${attrs.markOption}"` : '';
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
    const color = extractAuthorColor(el.getAttribute('style') || '');
    if (color) attrs.revisionAuthorColor = color;
  } else if (tag === 'del' && cls.includes('mark-del')) {
    attrs.revision = 'del';
    const color = extractAuthorColor(el.getAttribute('style') || '');
    if (color) attrs.revisionAuthorColor = color;
  } else if (cls.includes('mark-chg')) {
    attrs.revision = 'chg';
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
  // Escape any bare ampersands that aren't already part of an entity reference
  // so the XML parser doesn't choke.
  const safeHtml = html.replace(/&(?![a-zA-Z#][a-zA-Z0-9]*;)/g, '&amp;');
  const parser = new DOMParser();
  const doc = parser.parseFromString(`<root>${safeHtml}</root>`, 'text/xml');

  // The root element is the <root> wrapper we added
  const root = doc.documentElement;

  const result = [];
  for (const child of root.childNodes) {
    walkNode(child, {}, result);
  }
  return result;
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
