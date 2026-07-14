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
// slot-shape imports NOTHING (no yjs), so this stays safe to dynamic-import
// into the CJS server bundle — see that module's header + the note below.
import { isXmlFragmentSlot, isTextSlot, isYXmlElementNode } from './slot-shape.js';

// ── HTML emission helpers (byte-identical to ytext-html.js for single-kind) ──
//
// Sub-PR 1g.6 (#87): the legacy single `revision` attr key is replaced by
// three per-kind keys (revisionAdd, revisionDel, revisionChg). Each holds
// `{ authorId, authorColor }` or is absent. For single-kind input — the
// vast majority of UFGS content — exactly one of the three is set per run
// and the emitted HTML is byte-identical to the pre-1g.6 output (preserves
// the byte-stability invariant pinned by pmdoc-html-byte-stability.node-test.mjs).
// Multi-kind cross-author runs (Bob's revisionAdd inside Alice's
// revisionDel) emit nested wrappers in declared rank order: revisionAdd
// outer, revisionDel middle, revisionChg inner.

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

// Primitive layer keys — compared by `(a[k] || null) === (b[k] || null)`.
const PRIMITIVE_NESTING_KEYS = ['comment', 'mark', 'bold', 'italic', 'underline'];
// Per-kind revision keys — compared by deep-equal on `{authorId, authorColor}`.
const REVISION_NESTING_KEYS = ['revisionAdd', 'revisionDel', 'revisionChg'];
const AUX_KEYS = ['markOption', 'commentResolved'];

function revisionAttrsEq(a, b) {
  if (a === b) return true;
  if (!a || !b) return !a && !b;
  return (a.authorId || null) === (b.authorId || null)
    && (a.authorColor || null) === (b.authorColor || null);
}

function attrsEqual(a, b) {
  if (a === b) return true;
  if (!a || !b) return (!a || Object.keys(a).length === 0) && (!b || Object.keys(b).length === 0);
  for (const key of PRIMITIVE_NESTING_KEYS) {
    if ((a[key] || null) !== (b[key] || null)) return false;
  }
  for (const key of AUX_KEYS) {
    if ((a[key] || null) !== (b[key] || null)) return false;
  }
  for (const key of REVISION_NESTING_KEYS) {
    if (!revisionAttrsEq(a[key], b[key])) return false;
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

  // Layer 2: revision — emit per-kind wrappers in declared rank order
  // (Add → Del → Chg). Each layer is independent — single-kind input sets
  // exactly one and the byte-stability invariant holds.
  const REV_WRAPPERS = [
    ['revisionAdd', 'ins', 'mark-add'],
    ['revisionDel', 'del', 'mark-del'],
    ['revisionChg', 'span', 'mark-chg'],
  ];
  for (const [key, tag, cls] of REV_WRAPPERS) {
    const rev = attrs[key];
    if (!rev) continue;
    const styleAttr = rev.authorColor
      ? ` style="--author-color:${escapeAttr(rev.authorColor)}"`
      : '';
    const authorIdAttr = rev.authorId
      ? ` data-author-id="${escapeAttr(rev.authorId)}"`
      : '';
    openParts.push(`<${tag} class="${cls}"${authorIdAttr}${styleAttr}>`);
    closeParts.unshift(`</${tag}>`);
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
      // 1g.6 (#87) — separate MarkTypes per revision kind. Each text node
      // can carry up to three revision marks (one per MarkType), which
      // produce nested wrappers in buildTags layer 2.
      case 'revisionAdd':
        attrs.revisionAdd = {
          authorId: a.authorId || null,
          authorColor: a.authorColor || null,
        };
        break;
      case 'revisionDel':
        attrs.revisionDel = {
          authorId: a.authorId || null,
          authorColor: a.authorColor || null,
        };
        break;
      case 'revisionChg':
        attrs.revisionChg = {
          authorId: a.authorId || null,
          authorColor: a.authorColor || null,
        };
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

// Child-node duck-typing comes from slot-shape.js (isTextSlot / isYXmlElementNode);
// that module imports NOTHING, so it doesn't add a second yjs import path to the
// CJS server bundle (issue #47 Q22 — the "Yjs was already imported" warning
// shouldn't grow).

function yDeltaAttrsToAttrs(rawAttrs) {
  if (!rawAttrs || typeof rawAttrs !== 'object') return {};
  const attrs = {};
  for (const key of Object.keys(rawAttrs)) {
    const v = rawAttrs[key];
    // y-prosemirror suffixes mark-type keys with `--<random>` when the
    // MarkType declares `excludes: ''` (e.g. revisionAdd/Del/Chg post-1g.6),
    // so two instances of the same MarkType on one character can both
    // appear in the format dictionary without overwriting. We strip the
    // suffix to recover the base MarkType name. The current attrs shape
    // allows only ONE wrapper per kind per run; multiple same-kind marks
    // (rare — concurrent same-author + same-kind format ops) degrade to
    // last-write-wins, which acceptably loses the duplicate author info
    // but keeps the wrapper. Cross-kind multi-author audit (revisionAdd
    // + revisionDel) is unaffected because they use distinct base keys.
    const dashIdx = key.indexOf('--');
    const baseKey = dashIdx > 0 ? key.slice(0, dashIdx) : key;
    switch (baseKey) {
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
      // 1g.6 (#87) — y-prosemirror serializes PM marks into Y delta
      // attributes keyed by mark.type.name. The three new MarkType names
      // ride that mapping directly; each is independent and can coexist
      // (cross-kind multi-author audit).
      case 'revisionAdd':
        if (v && typeof v === 'object') {
          attrs.revisionAdd = {
            authorId: v.authorId || null,
            authorColor: v.authorColor || null,
          };
        }
        break;
      case 'revisionDel':
        if (v && typeof v === 'object') {
          attrs.revisionDel = {
            authorId: v.authorId || null,
            authorColor: v.authorColor || null,
          };
        }
        break;
      case 'revisionChg':
        if (v && typeof v === 'object') {
          attrs.revisionChg = {
            authorId: v.authorId || null,
            authorColor: v.authorColor || null,
          };
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
    if (isTextSlot(child)) {
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
    } else if (isYXmlElementNode(child)) {
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
  if (isXmlFragmentSlot(input)) {
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
