// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { EditorState } from 'prosemirror-state';
import { schema } from '../pm-schema.js';
import { tagLabelsPlugin, tagLabelsPluginKey } from '../pm-plugins/tag-labels.js';

function makeStateWithMark({ initialVisible = false, kind = 'rid', option = null } = {}) {
  const plugins = [tagLabelsPlugin({ initialVisible })];
  let state = EditorState.create({ schema, plugins });
  // Insert a paragraph with a single inlineMark span.
  const mark = schema.marks.inlineMark.create({ kind, option });
  const text = schema.text('ASTM E11', [mark]);
  const p = schema.nodes.paragraph.create(null, text);
  const tr = state.tr.replaceWith(0, state.doc.content.size, p);
  state = state.apply(tr);
  return state;
}

function getDecoCount(state) {
  const ps = tagLabelsPluginKey.getState(state);
  if (!ps?.decorations) return 0;
  return ps.decorations.find().length;
}

describe('tag-labels plugin', () => {
  it('emits zero decorations when invisible', () => {
    const state = makeStateWithMark({ initialVisible: false });
    expect(getDecoCount(state)).toBe(0);
  });

  it('emits widget decorations when visible (one per mark boundary)', () => {
    const state = makeStateWithMark({ initialVisible: true });
    // 1 inlineMark → 2 widgets (open + close).
    expect(getDecoCount(state)).toBe(2);
  });

  it('toggle from invisible → visible via meta produces decorations', () => {
    let state = makeStateWithMark({ initialVisible: false });
    expect(getDecoCount(state)).toBe(0);
    const tr = state.tr.setMeta(tagLabelsPluginKey, { visible: true });
    state = state.apply(tr);
    expect(getDecoCount(state)).toBe(2);
  });

  it('toggle visible → invisible empties decorations', () => {
    let state = makeStateWithMark({ initialVisible: true });
    expect(getDecoCount(state)).toBe(2);
    const tr = state.tr.setMeta(tagLabelsPluginKey, { visible: false });
    state = state.apply(tr);
    expect(getDecoCount(state)).toBe(0);
  });

  it('TAI mark with option emits the OPT-bearing open tag', () => {
    const state = makeStateWithMark({ initialVisible: true, kind: 'tai', option: 'A1' });
    const ps = tagLabelsPluginKey.getState(state);
    const widgets = ps.decorations.find();
    expect(widgets.length).toBe(2);
    // Render the first widget DOM to inspect text.
    const dom = widgets[0].type.toDOM(null, null);
    expect(dom.textContent).toBe('<TAI OPT=A1>');
    expect(dom.contentEditable).toBe('false');
    expect(dom.className).toBe('tag-label');
  });

  it('selection-only transactions do not rebuild decorations (cache)', () => {
    let state = makeStateWithMark({ initialVisible: true });
    const before = tagLabelsPluginKey.getState(state).decorations;
    // Selection-only tx: no doc change, no visibility flip → cached set.
    const tr = state.tr.setSelection(state.selection);
    state = state.apply(tr);
    const after = tagLabelsPluginKey.getState(state).decorations;
    expect(after).toBe(before);
  });
});
