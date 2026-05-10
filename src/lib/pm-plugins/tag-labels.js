/**
 * tag-labels.js — PM plugin that emits widget decorations for SGML tag
 * visibility, replacing EditableBlock's `syncTagLabels()` DOM injection.
 *
 * Sub-PR 1e (#47, v2 plan Q4). When `showTags` is on, every `inlineMark`
 * range gets a `<span class="tag-label" contentEditable="false">` widget
 * inserted before its open and after its close — visually identical to the
 * legacy renderer's output.
 *
 * Why decorations instead of inline marks: PM's mark system attaches text
 * to a mark; tag labels are NOT text — they're auxiliary UI that must NOT
 * roundtrip into the html serializer. Decorations are PM-side-only and the
 * y-prosemirror serializer never sees them, so the html stays clean.
 *
 * Why widget decorations instead of CSS pseudo-elements: see CLAUDE.md
 * "Tag Visibility Toggle" — pseudo-elements don't create caret positions
 * inside contentEditable. Widget decorations create real DOM nodes with
 * `contentEditable=false`, giving the browser explicit caret boundaries.
 *
 * State shape: `{ visible: boolean }`. Toggled via a meta on a no-op
 * transaction: `view.dispatch(view.state.tr.setMeta(tagLabelsPluginKey,
 * { visible }))`.
 *
 * Decoration recompute is lazy: cached against the doc reference + visible
 * flag pair. PM rebuilds decorations on every transaction, but this
 * plugin's `decorations` selector returns the cached DecorationSet when
 * the doc hasn't changed.
 */

import { Plugin, PluginKey } from 'prosemirror-state';
import { Decoration, DecorationSet } from 'prosemirror-view';

import { INLINE_MARK_KINDS } from '../pm-schema.js';

export const tagLabelsPluginKey = new PluginKey('sim-tag-labels');

// Mirrors EditableBlock's MARK_TAG_MAP — kept here so the plugin owns the
// mark-class → SGML-tag mapping for PM. INLINE_MARK_KINDS is the schema's
// allowlist; this map is the rendering-side string lookup.
const MARK_KIND_TO_TAG = {
  rid: 'RID', srf: 'SRF', sub: 'SUB',
  eng: 'ENG', met: 'MET', tst: 'TST',
  url: 'URL', att: 'ATT', tai: 'TAI',
  hls: 'HLS', hl1: 'HL1', hl2: 'HL2', hl3: 'HL3', hl4: 'HL4',
};

function makeLabelWidget(text) {
  // PM widget decorations need a plain DOM-construction function; the doc
  // assumes browser DOM (the plugin only ever runs inside an EditorView).
  return () => {
    const el = document.createElement('span');
    el.className = 'tag-label';
    el.contentEditable = 'false';
    el.textContent = text;
    return el;
  };
}

function buildDecorations(doc) {
  const decos = [];
  doc.descendants((node, pos) => {
    if (!node.isText) return true;
    const inlineMark = node.marks.find((m) => m.type.name === 'inlineMark');
    if (!inlineMark) return true;
    const kind = inlineMark.attrs?.kind;
    if (!INLINE_MARK_KINDS.has(kind)) return true;
    const tag = MARK_KIND_TO_TAG[kind];
    if (!tag) return true;
    const openTag = (kind === 'tai' && inlineMark.attrs?.option)
      ? `<TAI OPT=${inlineMark.attrs.option}>`
      : `<${tag}>`;
    decos.push(Decoration.widget(pos, makeLabelWidget(openTag), { side: -1 }));
    decos.push(Decoration.widget(pos + node.nodeSize, makeLabelWidget(`</${tag}>`), { side: 1 }));
    return false;
  });
  return DecorationSet.create(doc, decos);
}

export function tagLabelsPlugin({ initialVisible = false } = {}) {
  return new Plugin({
    key: tagLabelsPluginKey,
    state: {
      init: (_args, state) => ({
        visible: !!initialVisible,
        decorations: initialVisible ? buildDecorations(state.doc) : DecorationSet.empty,
      }),
      apply: (tr, prev, _oldState, newState) => {
        let nextVisible = prev.visible;
        const meta = tr.getMeta(tagLabelsPluginKey);
        if (meta && typeof meta.visible === 'boolean') nextVisible = meta.visible;

        // Two regenerate triggers: visibility flipped, or the doc changed
        // while visible. When invisible, return the empty set (cheap).
        if (!nextVisible) {
          if (prev.visible === false) return prev;
          return { visible: false, decorations: DecorationSet.empty };
        }

        // QC minor-11: cache the previous decoration set whenever neither the
        // doc nor visibility changed. The earlier `!== DecorationSet.empty`
        // guard was wrong-direction: when the doc has no inline marks,
        // buildDecorations() returns the empty singleton, the guard fired,
        // and we rebuilt on every transaction.
        if (!tr.docChanged && nextVisible === prev.visible) {
          return prev;
        }

        return { visible: true, decorations: buildDecorations(newState.doc) };
      },
    },
    props: {
      decorations(state) {
        return tagLabelsPluginKey.getState(state)?.decorations || null;
      },
    },
  });
}

/** Toggle helper: dispatch into an existing EditorView. */
export function setTagsVisible(view, visible) {
  if (!view) return;
  view.dispatch(view.state.tr.setMeta(tagLabelsPluginKey, { visible: !!visible }));
}
