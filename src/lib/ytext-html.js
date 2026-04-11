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
 * Check if two attribute objects are deeply equal (shallow comparison is
 * sufficient since attribute values are primitives).
 * @param {object} a
 * @param {object} b
 * @returns {boolean}
 */
function attrsEqual(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  return keysA.every(k => a[k] === b[k]);
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
    const dataOpt = attrs.markOption ? ` data-opt="${attrs.markOption}"` : '';
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
