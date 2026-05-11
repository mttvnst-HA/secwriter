/**
 * pm-schema.js — ProseMirror schema for SecWriter blocks.
 *
 * Layering (outermost → innermost):
 *   comment > revision > inlineMark > format(bold/italic/underline)
 *
 * In ProseMirror, a mark's render position is determined by its `rank`, which
 * comes from the order in `marks` below. Earlier = outer. The order here mirrors
 * `buildTags` in ytext-html.js so PM-rendered HTML is byte-identical to the
 * Y.Text-rendered HTML produced by `yTextToHtml`.
 *
 * Each mark uses the default `excludes: '_'` (excludes itself), so a single
 * range cannot carry two `revision` marks. Layering is by rank order, not by
 * `excludes`.
 *
 * VALID_MARKS / MARK_CLASSES asymmetry (Q31/E3 in issue #47 v2 plan):
 *   - VALID_MARKS gates the RECEIVE direction (allowlist for class-name
 *     interpolation when emitting HTML; defends against malicious peer mark
 *     kinds). Includes `comment` because comment is its own top-level layer
 *     that emits a class-bearing span.
 *   - MARK_CLASSES gates the PARSE direction (sibling kinds matched against
 *     `mark-{kind}` class names when reading HTML back into the schema).
 *     Includes `hls` because `hls` is a sibling kind of rid/srf/etc., NOT a
 *     separate layer like `comment`.
 *   They are at different layers — not a bug. Documented here so future
 *   readers don't try to "unify" them.
 *
 * Adversarial-input fallback (Q31/E6):
 *   Unknown `inlineMark.kind` values DROP the kind silently in `toDOM` and
 *   parseDOM (returning a plain span / `false`); we never throw. Rationale:
 *   peers running future schemas could otherwise wedge the editor on first
 *   sync. Logging is opt-in via console.warn at the boundary so test runs
 *   stay quiet by default.
 */

import { Schema } from 'prosemirror-model';

// Source of truth for inlineMark kinds. hl1-hl4 added per Q26 (6,047 occurrences
// in reference/UFGS_M/). `hls` is a sibling kind of rid/srf/etc., not a separate
// layer like `comment`.
export const INLINE_MARK_KINDS = new Set([
  'rid', 'srf', 'sub', 'eng', 'met', 'tai', 'tst', 'url', 'att',
  'hls', 'hl1', 'hl2', 'hl3', 'hl4',
]);

// Receive-direction allowlist for class-name interpolation. Comment is a
// separate top-level layer (its own schema mark), so it lives here too.
export const VALID_MARKS = new Set([...INLINE_MARK_KINDS, 'comment']);

// Parse-direction sibling-kind set. Same membership as INLINE_MARK_KINDS —
// exported separately so the asymmetry with VALID_MARKS is explicit at the
// call site (and so a reader can grep for the two names independently).
export const MARK_CLASSES = new Set([...INLINE_MARK_KINDS]);

const REVISION_KINDS = new Set(['add', 'del', 'chg']);

function getCommentAttrs(el) {
  const cls = el.getAttribute('class') || '';
  if (cls.includes('mark-comment-resolved')) {
    return { id: el.getAttribute('data-comment-id') || '', resolved: true };
  }
  // Don't match the resolved variant via plain mark-comment substring.
  if (/(?:^|\s)mark-comment(?:\s|$)/.test(cls)) {
    return { id: el.getAttribute('data-comment-id') || '', resolved: false };
  }
  return false;
}

function extractAuthorColor(style) {
  if (!style) return null;
  const m = style.match(/--author-color:\s*([^;]+)/);
  return m ? m[1].trim() : null;
}

function getRevisionAttrs(kind) {
  return (el) => {
    const authorId = el.getAttribute('data-author-id');
    const authorColor = extractAuthorColor(el.getAttribute('style') || '');
    return {
      kind,
      authorId: authorId || null,
      authorColor: authorColor || null,
    };
  };
}

function getInlineMarkAttrs(el) {
  const cls = el.getAttribute('class') || '';
  // Skip comment / revision spans — they parse via their own mark rules.
  if (cls.includes('mark-comment') || cls.includes('mark-chg')) return false;
  // Skip editor-UI tag-label spans (injected by syncTagLabels in EditableBlock).
  if (cls.includes('tag-label')) return false;
  for (const kind of MARK_CLASSES) {
    const re = new RegExp(`(?:^|\\s)mark-${kind}(?:\\s|$)`);
    if (re.test(cls)) {
      const option = (kind === 'tai') ? (el.getAttribute('data-opt') || null) : null;
      return { kind, option };
    }
  }
  // Unknown mark kind — drop (Q31/E6). Returning false skips this rule; the
  // span's text content is still preserved via PM's recursion.
  return false;
}

export const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: {
      group: 'block',
      content: 'inline*',
      toDOM: () => ['p', 0],
      parseDOM: [{ tag: 'p' }],
    },
    text: { group: 'inline' },
    hard_break: {
      group: 'inline',
      inline: true,
      selectable: false,
      toDOM: () => ['br'],
      parseDOM: [{ tag: 'br' }],
    },
  },
  // Mark declaration order = rank order = render nesting order (earlier = outer).
  // Mirrors the comment > revision > mark > format layering documented in the
  // file header and in `buildTags` of ytext-html.js.
  marks: {
    comment: {
      attrs: {
        id: { default: '' },
        resolved: { default: false },
      },
      // The parser tries each mark's rules in spec order; the comment rule is
      // first and only matches spans whose class contains mark-comment[-resolved].
      parseDOM: [{ tag: 'span', getAttrs: getCommentAttrs }],
      toDOM: (m) => {
        const cls = m.attrs.resolved ? 'mark-comment-resolved' : 'mark-comment';
        return ['span', { class: cls, 'data-comment-id': m.attrs.id }, 0];
      },
    },
    revision: {
      attrs: {
        kind: { default: 'add' },
        authorId: { default: null },
        authorColor: { default: null },
      },
      parseDOM: [
        { tag: 'ins.mark-add', getAttrs: getRevisionAttrs('add') },
        { tag: 'del.mark-del', getAttrs: getRevisionAttrs('del') },
        { tag: 'span.mark-chg', getAttrs: getRevisionAttrs('chg') },
      ],
      toDOM: (m) => {
        const kind = REVISION_KINDS.has(m.attrs.kind) ? m.attrs.kind : 'add';
        const tag = kind === 'add' ? 'ins' : (kind === 'del' ? 'del' : 'span');
        const attrs = { class: `mark-${kind}` };
        if (m.attrs.authorId) attrs['data-author-id'] = m.attrs.authorId;
        if (m.attrs.authorColor) attrs.style = `--author-color:${m.attrs.authorColor}`;
        return [tag, attrs, 0];
      },
    },
    inlineMark: {
      // excludes: '' allows multiple inlineMark instances with different
      // `kind` attrs (e.g. RID + SRF) to coexist on the same text node.
      // Default PM behavior excludes by type, which would strip a SRF when
      // adding RID — incompatible with the attr-discriminated semantics that
      // pm-toolbar.applyInlineMarkTr relies on (sub-PR 1f.9, design spec
      // line 124).
      excludes: '',
      attrs: {
        kind: { default: 'rid' },
        option: { default: null },
      },
      parseDOM: [{ tag: 'span', getAttrs: getInlineMarkAttrs }],
      toDOM: (m) => {
        if (!INLINE_MARK_KINDS.has(m.attrs.kind)) {
          // Adversarial fallback (Q31/E6): unknown kind → render plain span,
          // never throw. The text content survives.
          return ['span', 0];
        }
        const attrs = { class: `mark-${m.attrs.kind}` };
        if (m.attrs.kind === 'tai' && m.attrs.option) {
          attrs['data-opt'] = m.attrs.option;
        }
        return ['span', attrs, 0];
      },
    },
    bold: {
      parseDOM: [{ tag: 'b' }, { tag: 'strong' }],
      toDOM: () => ['b', 0],
    },
    italic: {
      parseDOM: [{ tag: 'i' }, { tag: 'em' }],
      toDOM: () => ['i', 0],
    },
    underline: {
      parseDOM: [{ tag: 'u' }],
      toDOM: () => ['u', 0],
    },
  },
});
