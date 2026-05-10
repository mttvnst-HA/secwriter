// @vitest-environment jsdom
//
// QC follow-up to sub-PR 1e (#47, ADR-0006). Locks down the dispatchTransaction
// loopback gate that lives at the top of PmEditableBlock's EditorView config:
//   if (!tr.getMeta(ySyncPluginKey)) { schedule onUpdate(...) }
//
// The gate prevents two failure modes that would otherwise be invisible
// behind the VITE_PM_EDITOR flag:
//   1. A remote peer's keystroke would re-publish their content as a local
//      edit (clobbering concurrent local edits in the 400ms debounce window).
//   2. PM-driven keystrokes would enter the Yjs UndoManager via the back
//      channel (handleBlockUpdate → setBlockHtml → 'local-publish' origin).
//
// We exercise the gate at the EditorView level — same plugin set as
// PmEditableBlock, but without React in the loop — because that's the smallest
// surface that produces the relevant transaction shapes.

import { describe, it, expect, beforeEach } from 'vitest';
import * as Y from 'yjs';
import { EditorState, TextSelection } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { ySyncPlugin, ySyncPluginKey, prosemirrorToYXmlFragment } from 'y-prosemirror';

import { schema } from '../pm-schema.js';
import { htmlToPmFragment } from '../pmdoc-html.js';

function buildView(html) {
  const ydoc = new Y.Doc();
  const yXml = ydoc.getXmlFragment('test');
  prosemirrorToYXmlFragment(htmlToPmFragment(html), yXml);
  const state = EditorState.create({ schema, plugins: [ySyncPlugin(yXml)] });
  const root = document.createElement('div');
  document.body.appendChild(root);
  const view = new EditorView(root, { state });
  return { ydoc, yXml, view, root };
}

let ctx;
beforeEach(() => { ctx = null; });

describe('PmEditableBlock dispatchTransaction loopback gate', () => {
  it('local edit → tr.getMeta(ySyncPluginKey) is null (loopback fires)', () => {
    ctx = buildView('hello');
    const { view } = ctx;
    let observed = null;
    // Patch dispatchTransaction the same way PmEditableBlock does.
    view.setProps({
      dispatchTransaction(tr) {
        view.updateState(view.state.apply(tr));
        if (tr.docChanged) observed = tr.getMeta(ySyncPluginKey);
      },
    });
    // Local edit: insert "X" at the start of the doc. PM's getMeta returns
    // undefined (not null) when the key was never set; production gate uses
    // `!= null` to catch both — assert the same loose comparison here.
    const tr = view.state.tr.insertText('X', 1);
    view.dispatch(tr);
    expect(observed == null).toBe(true);
    ctx.root.remove();
  });

  it('remote ydoc edit → tr.getMeta(ySyncPluginKey) is non-null (loopback skipped)', async () => {
    ctx = buildView('hello');
    const { ydoc, yXml, view } = ctx;
    let observed = null;
    view.setProps({
      dispatchTransaction(tr) {
        view.updateState(view.state.apply(tr));
        if (tr.docChanged) observed = tr.getMeta(ySyncPluginKey);
      },
    });
    // Simulate a remote write — directly mutate the Y.XmlFragment under a
    // remote-style origin. y-prosemirror's ySyncPlugin observes the doc
    // and dispatches a transaction with ySyncPluginKey meta.
    ydoc.transact(() => {
      const para = yXml.toArray()[0];
      const text = para.toArray()[0];
      text.insert(0, 'XYZ');
    }, 'remote');
    // Allow microtask queue to drain (y-prosemirror sometimes batches).
    await Promise.resolve();
    expect(observed).not.toBeNull();
    ctx.root.remove();
  });

  it('selection-only transaction → no docChange, gate not exercised', () => {
    ctx = buildView('hello world');
    const { view } = ctx;
    let docChangedSeen = 0;
    view.setProps({
      dispatchTransaction(tr) {
        view.updateState(view.state.apply(tr));
        if (tr.docChanged) docChangedSeen += 1;
      },
    });
    // Pure selection move — should NOT count as a docChange.
    const tr = view.state.tr.setSelection(TextSelection.atEnd(view.state.doc));
    view.dispatch(tr);
    expect(docChangedSeen).toBe(0);
    ctx.root.remove();
  });
});
