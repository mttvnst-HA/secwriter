// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import * as Y from 'yjs';
import { EditorState, TextSelection } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { ySyncPlugin, ySyncPluginKey, prosemirrorToYXmlFragment } from 'y-prosemirror';

import { schema } from '../pm-schema.js';
import { htmlToPmFragment } from '../pmdoc-html.js';
import { saveSelection, restoreSelection } from '../pm-plugins/relpos-selection.js';

function buildView(html) {
  const ydoc = new Y.Doc();
  const yXml = ydoc.getXmlFragment('test');
  const pmDoc = htmlToPmFragment(html);
  prosemirrorToYXmlFragment(pmDoc, yXml);

  const state = EditorState.create({ schema, plugins: [ySyncPlugin(yXml)] });
  const root = document.createElement('div');
  document.body.appendChild(root);
  const view = new EditorView(root, { state });
  // Pull the binding out for getRelativeSelection.
  const binding = ySyncPluginKey.getState(view.state).binding;
  return { ydoc, yXml, view, binding, root };
}

describe('relpos-selection', () => {
  let ctx;
  beforeEach(() => {
    ctx = null;
  });

  it('saveSelection returns null on missing inputs', () => {
    expect(saveSelection({})).toBeNull();
    expect(saveSelection(null)).toBeNull();
  });

  it('saveSelection returns null when binding is absent (QC major-3)', () => {
    // Build a Y.XmlFragment + EditorView state but DO NOT extract the
    // binding — simulates a caller racing the EditorView's first sync, or
    // a test that builds a Yjs doc separately from a PM EditorView.
    ctx = buildView('hello world');
    const { view, yXml } = ctx;
    const $a = view.state.doc.resolve(2);
    const $h = view.state.doc.resolve(6);
    view.dispatch(view.state.tr.setSelection(TextSelection.between($a, $h)));
    // Pass binding=undefined explicitly — the no-binding path should refuse
    // to fabricate an off-by-one relpos via createRelativePositionFromTypeIndex.
    const saved = saveSelection({ blockId: 'b1', view, yXmlFragment: yXml });
    expect(saved).toBeNull();
    ctx.root.remove();
  });

  it('restoreSelection returns false when binding is absent', () => {
    ctx = buildView('hello world');
    const { ydoc, yXml, view, binding } = ctx;
    view.dispatch(view.state.tr.setSelection(TextSelection.between(view.state.doc.resolve(2), view.state.doc.resolve(4))));
    const saved = saveSelection({ blockId: 'b1', view, yXmlFragment: yXml, binding });
    expect(saved).not.toBeNull();
    // No binding passed to restore — must refuse.
    const ok = restoreSelection({ saved, view, ydoc, yXmlFragment: yXml });
    expect(ok).toBe(false);
    ctx.root.remove();
  });

  it('saveSelection returns a tuple for a non-empty selection', () => {
    ctx = buildView('hello world');
    const { view, yXml, binding } = ctx;
    const $a = view.state.doc.resolve(2);
    const $h = view.state.doc.resolve(6);
    view.dispatch(view.state.tr.setSelection(TextSelection.between($a, $h)));
    const saved = saveSelection({ blockId: 'b1', view, yXmlFragment: yXml, binding });
    expect(saved).not.toBeNull();
    expect(saved.blockId).toBe('b1');
    expect(saved.relAnchor).toBeDefined();
    expect(saved.relHead).toBeDefined();
    ctx.root.remove();
  });

  it('restoreSelection rebuilds a selection in a fresh view at the same offsets', () => {
    ctx = buildView('hello world');
    const { ydoc, yXml, view, binding } = ctx;
    const $a = view.state.doc.resolve(2);
    const $h = view.state.doc.resolve(6);
    view.dispatch(view.state.tr.setSelection(TextSelection.between($a, $h)));
    const saved = saveSelection({ blockId: 'b1', view, yXmlFragment: yXml, binding });
    expect(saved).not.toBeNull();

    // Move the editor's selection to the start to simulate a re-render.
    view.dispatch(view.state.tr.setSelection(TextSelection.atStart(view.state.doc)));
    expect(view.state.selection.from).toBe(1);

    const ok = restoreSelection({ saved, view, ydoc, yXmlFragment: yXml, binding });
    expect(ok).toBe(true);
    expect(view.state.selection.from).toBe(2);
    expect(view.state.selection.to).toBe(6);
    ctx.root.remove();
  });

  it('restoreSelection survives a remote edit landing between save and restore', () => {
    ctx = buildView('hello world');
    const { ydoc, yXml, view, binding } = ctx;
    // Cursor at position 6 (between "hello" and " world")
    view.dispatch(view.state.tr.setSelection(TextSelection.atEnd(view.state.doc)));
    const collapsedAtEnd = view.state.doc.content.size - 1;
    const $h = view.state.doc.resolve(collapsedAtEnd);
    view.dispatch(view.state.tr.setSelection(TextSelection.between($h, $h)));
    const saved = saveSelection({ blockId: 'b1', view, yXmlFragment: yXml, binding });
    expect(saved).not.toBeNull();

    // Simulate a remote edit: insert text at the very start of the fragment.
    // Use ydoc.transact to mimic a remote-origin write so y-prosemirror
    // doesn't treat it as local.
    ydoc.transact(() => {
      const xml = yXml.toArray()[0]; // first paragraph
      // Find the YXmlText child and prepend.
      const child = xml.toArray()[0];
      child.insert(0, 'XYZ');
    }, 'remote-test');

    // After the remote insert, the cursor should still be near the end —
    // the relative position survives the offset shift.
    const ok = restoreSelection({ saved, view, ydoc, yXmlFragment: yXml, binding });
    expect(ok).toBe(true);
    // Selection is at the new "end" (was pos = old size - 1; new doc has 3
    // more chars before that anchor).
    const newSize = view.state.doc.content.size;
    expect(view.state.selection.from).toBeGreaterThan(collapsedAtEnd);
    expect(view.state.selection.from).toBeLessThanOrEqual(newSize);
    ctx.root.remove();
  });
});
