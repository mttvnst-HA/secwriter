/**
 * pmdoc-html.js — ProseMirror Node / Y.XmlFragment ↔ HTML string conversion.
 *
 * Mirror of `ytext-html.js` for the PM substrate (issue #47). Produces HTML
 * byte-identical to `yTextToHtml(yText)` for any equivalent input — the
 * interop suite (1d) is the gate. The byte-stability property test for the
 * 690-file UFGS_M corpus is the 1c gate.
 *
 * Runs in both the browser and Node. Pure prosemirror-model + Y/PM op
 * composition — no PM EditorView, no DOM mutation. Importable from the CJS
 * server (server/room-serializer.cjs) via dynamic import (1d). The Y.XmlFragment
 * walker duck-types its input rather than `import * as Y from 'yjs'` so we
 * don't compound the existing "Yjs was already imported" warning when this
 * module is dynamic-imported into the CJS server bundle.
 *
 * Public API:
 *   pmFragmentToHtml(input) → string
 *     Accepts a ProseMirror Node (e.g. a doc) or a Y.XmlFragment. Walks
 *     paragraphs+inline content, emits HTML via the same `buildTags` /
 *     `escapeHtml` rules as yTextToHtml. Adjacent runs with identical attrs
 *     are merged before rendering.
 *   htmlToPmFragment(html) → PM Node
 *     Parses an HTML string into a ProseMirror doc. Wraps the input in a
 *     <p> so PM gets valid block-level content; the resulting doc has one
 *     paragraph whose inline content reproduces `html`. Used by the
 *     byte-stability property test.
 *
 * Adversarial-input fallback (Q31/E6):
 *   Unknown inlineMark kinds, malformed YXmlText delta attributes, and
 *   non-string inserts are dropped silently. Never throws on input from
 *   peers — schema-invalid steps lose the offending mark, never the text.
 */

import { DOMParser as PMDOMParser } from 'prosemirror-model';
import { schema, INLINE_MARK_KINDS, VALID_MARKS } from './pm-schema.js';

const REVISION_KINDS = new Set(['add', 'del', 'chg']);

// ── HTML emission helpers (byte-identical to ytext-html.js) ──────────────────

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeAttr(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

const NESTING_KEYS = ['comment', 'revision', 'mark', 'bold', 'italic', 'underline'];
const AUX_KEYS = ['markOption', 'revisionAuthor', 'revisionAuthorColor', 'commentResolved'];

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

function buildTags(attrs) {
  if (!attrs || Object.keys(attrs).length === 0) {
    return { open: '', close: '' };
  }
  const openParts = [];
  const closeParts = [];

  // Layer 1 (outermost): comment.
  if (attrs.comment) {
    const cls = attrs.commentResolved ? 'mark-comment-resolved' : 'mark-comment';
    openParts.push(`<span class="${cls}" data-comment-id="${escapeAttr(attrs.comment)}">`);
    closeParts.unshift('</span>');
  }

  // Layer 2: revision.
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

  // Layer 3: inlineMark (allowlist via VALID_MARKS — defends against
  // class-name injection from peers carrying unexpected `kind` values).
  if (attrs.mark && VALID_MARKS.has(attrs.mark)) {
    const markClass = `mark-${attrs.mark}`;
    const dataOpt = (attrs.mark === 'tai' && attrs.markOption)
      ? ` data-opt="${escapeAttr(attrs.markOption)}"`
      : '';
    openParts.push(`<span class="${markClass}"${dataOpt}>`);
    closeParts.unshift('</span>');
  }

  // Layer 4 (innermost): format.
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

  return { open: openParts.join(''), close: closeParts.join('') };
}

function deltasToHtml(deltas) {
  if (!deltas || deltas.length === 0) return '';

  // Merge adjacent runs with identical attrs. Mirrors `yTextToHtml`'s pre-emit
  // merge so concurrent insertions that produce two equally-attributed runs
  // render as one tag pair.
  const merged = [];
  for (const d of deltas) {
    if (!d || typeof d.insert !== 'string' || d.insert.length === 0) continue;
    const attrs = d.attributes || null;
    const prev = merged[merged.length - 1];
    if (prev && attrsEqual(prev.attributes, attrs)) {
      prev.insert += d.insert;
    } else {
      merged.push({ insert: d.insert, attributes: attrs });
    }
  }

  let html = '';
  for (const d of merged) {
    const attrs = d.attributes || {};
    const { open, close } = buildTags(attrs);
    html += open + escapeHtml(d.insert).replace(/\n/g, '<br>') + close;
  }
  return html;
}

// ── PM Node → deltas ─────────────────────────────────────────────────────────

function pmMarksToAttrs(marks) {
  if (!marks || marks.length === 0) return {};
  const attrs = {};
  for (const mark of marks) {
    const name = mark.type && mark.type.name;
    const a = mark.attrs || {};
    switch (name) {
      case 'comment':
        if (a.id) {
          attrs.comment = a.id;
          if (a.resolved) attrs.commentResolved = true;
        }
        break;
      case 'revision':
        if (REVISION_KINDS.has(a.kind)) {
          attrs.revision = a.kind;
          if (a.authorId) attrs.revisionAuthor = a.authorId;
          if (a.authorColor) attrs.revisionAuthorColor = a.authorColor;
        }
        break;
      case 'inlineMark':
        // Adversarial fallback (Q31/E6): unknown kind is silently dropped at
        // this step. The text content of the mark is preserved (PM still
        // recurses into the marked text).
        if (INLINE_MARK_KINDS.has(a.kind)) {
          attrs.mark = a.kind;
          if (a.kind === 'tai' && a.option) attrs.markOption = a.option;
        }
        break;
      case 'bold': attrs.bold = true; break;
      case 'italic': attrs.italic = true; break;
      case 'underline': attrs.underline = true; break;
      // unknown mark types: dropped silently (Q31/E6 forward-compat)
    }
  }
  return attrs;
}

function pmNodeToDeltas(pmNode) {
  const deltas = [];
  // descendants visits every node in document order; leaves are text /
  // hard_break, block nodes (paragraph) are visited but contribute no delta.
  pmNode.descendants((node) => {
    if (node.isText) {
      deltas.push({ insert: node.text, attributes: pmMarksToAttrs(node.marks) });
    } else if (node.type && node.type.name === 'hard_break') {
      deltas.push({ insert: '\n', attributes: pmMarksToAttrs(node.marks || []) });
    }
    return true;
  });
  return deltas;
}

// ── Y.XmlFragment → deltas ───────────────────────────────────────────────────

// Duck-type detectors. We avoid `import * as Y from 'yjs'` so this module
// doesn't add a second yjs import path to the CJS server bundle (issue #47
// Q22 — the existing "Yjs was already imported" warning shouldn't grow).

function isYXmlText(child) {
  return child && typeof child.toDelta === 'function';
}

function isYXmlElement(child) {
  return child
    && typeof child.nodeName === 'string'
    && typeof child.toArray === 'function';
}

// y-prosemirror appends a `--<8-char-hash>` suffix to attr keys for mark types
// declared with `excludes: ''` (overlap-capable). See
// node_modules/y-prosemirror/dist/y-prosemirror.cjs:1167 (`hashedMarkNameRegex`)
// and the `isOverlapping` branch at marksToAttributes (line ~1199). The
// SecWriter schema declares `inlineMark` with `excludes: ''` so that RID/SRF/etc.
// can stack at the PM-doc layer (sub-PR 1f.9). Strip the suffix when reading
// back so our switch can dispatch on the canonical mark name.
const HASHED_ATTR_KEY_RE = /^(.*)--[a-zA-Z0-9+/=]{8}$/;
function stripHashSuffix(key) {
  const m = HASHED_ATTR_KEY_RE.exec(key);
  return m ? m[1] : key;
}

function yDeltaAttrsToAttrs(rawAttrs) {
  if (!rawAttrs || typeof rawAttrs !== 'object') return {};
  const attrs = {};
  for (const rawKey of Object.keys(rawAttrs)) {
    const key = stripHashSuffix(rawKey);
    const v = rawAttrs[rawKey];
    switch (key) {
      // y-prosemirror stores marks-without-attrs as `{}` (or sometimes null
      // after Yjs format ops). Both treated as set.
      case 'bold': if (v != null) attrs.bold = true; break;
      case 'italic': if (v != null) attrs.italic = true; break;
      case 'underline': if (v != null) attrs.underline = true; break;
      case 'comment':
        if (v && typeof v === 'object' && v.id) {
          attrs.comment = v.id;
          if (v.resolved) attrs.commentResolved = true;
        }
        break;
      case 'revision':
        if (v && typeof v === 'object' && REVISION_KINDS.has(v.kind)) {
          attrs.revision = v.kind;
          if (v.authorId) attrs.revisionAuthor = v.authorId;
          if (v.authorColor) attrs.revisionAuthorColor = v.authorColor;
        }
        break;
      case 'inlineMark':
        if (v && typeof v === 'object' && INLINE_MARK_KINDS.has(v.kind)) {
          attrs.mark = v.kind;
          if (v.kind === 'tai' && v.option) attrs.markOption = v.option;
        }
        break;
      // unknown keys: ignored (Q31/E6 forward-compat)
    }
  }
  return attrs;
}

function yXmlToDeltas(yXml) {
  const deltas = [];

  function emit(child) {
    if (isYXmlText(child)) {
      let childDeltas;
      try {
        childDeltas = child.toDelta();
      } catch {
        // Q31/E6: malformed YXmlText state — skip rather than throw.
        return;
      }
      if (!Array.isArray(childDeltas)) return;
      for (const d of childDeltas) {
        if (!d || typeof d.insert !== 'string') continue; // non-string inserts (embeds) skipped
        deltas.push({ insert: d.insert, attributes: yDeltaAttrsToAttrs(d.attributes) });
      }
    } else if (isYXmlElement(child)) {
      if (child.nodeName === 'hard_break') {
        deltas.push({ insert: '\n', attributes: {} });
      } else {
        // Recurse into block-level elements (paragraph, etc.).
        let grandChildren;
        try {
          grandChildren = child.toArray();
        } catch {
          return;
        }
        if (!Array.isArray(grandChildren)) return;
        for (const g of grandChildren) emit(g);
      }
    }
  }

  let topChildren;
  try {
    topChildren = yXml.toArray();
  } catch {
    return [];
  }
  if (!Array.isArray(topChildren)) return [];
  for (const c of topChildren) emit(c);
  return deltas;
}

// ── Public API ───────────────────────────────────────────────────────────────

export function pmFragmentToHtml(input) {
  if (input == null) return '';
  // PM Node: has descendants() and a NodeType.
  if (typeof input.descendants === 'function' && input.type && input.type.name) {
    return deltasToHtml(pmNodeToDeltas(input));
  }
  // Y.XmlFragment: has toArray() but no nodeName (a YXmlElement has both).
  if (typeof input.toArray === 'function' && typeof input.nodeName !== 'string') {
    return deltasToHtml(yXmlToDeltas(input));
  }
  return '';
}

export function htmlToPmFragment(html) {
  // Empty input → empty doc with one paragraph (the schema requires `block+`).
  if (!html) {
    return schema.node('doc', null, [schema.node('paragraph')]);
  }
  // Wrap in a single <p> so PM has unambiguous block content. The existing
  // SecWriter html shape is inline-only (single-paragraph blocks), so this
  // wrap is the canonical shape.
  const parser = new DOMParser();
  const doc = parser.parseFromString(
    `<div id="pmdoc-html-root"><p>${html}</p></div>`,
    'text/html',
  );
  const root = doc.getElementById('pmdoc-html-root') || doc.body || doc.documentElement;
  // Strip editor-UI tag-label spans before parse. Mirrors ytext-html.js's
  // attrsFromElement, which returns null for `tag-label` class to skip the
  // entire subtree. PM's parseDOM with `getAttrs → false` falls through to
  // the children rather than dropping them, so we pre-remove the nodes.
  const tagLabels = root.querySelectorAll && root.querySelectorAll('.tag-label');
  if (tagLabels) {
    for (const el of tagLabels) {
      if (el && el.parentNode) el.parentNode.removeChild(el);
    }
  }
  return PMDOMParser.fromSchema(schema).parse(root);
}
