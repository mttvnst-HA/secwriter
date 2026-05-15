// @vitest-environment jsdom
//
// pm-relpos.test.js — sub-PR 1g.7 (#88) covering the view-discovery
// wrapper for Y.RelativePosition save/restore.
//
// The lower-level primitives in pm-plugins/relpos-selection.js are
// covered by relpos-selection.test.js. This file pins the API the new
// FloatingToolbar callers will use: a view-only signature with internal
// binding/fragment discovery, and a cross-fragment guard via blockId.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as Y from 'yjs';
import { EditorState, TextSelection } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { ySyncPlugin, prosemirrorToYXmlFragment } from 'y-prosemirror';

import { schema } from '../pm-schema.js';
import { htmlToPmFragment } from '../pmdoc-html.js';
import { saveSelection, restoreSelection } from '../pm-relpos.js';

function makeView({ html = 'hello world', blockId = 'b1', plugins = null } = {}) {
  const ydoc = new Y.Doc();
  const yXml = ydoc.getXmlFragment(blockId);
  const pmDoc = htmlToPmFragment(html);
  prosemirrorToYXmlFragment(pmDoc, yXml);

  const state = EditorState.create({
    schema,
    plugins: plugins == null ? [ySyncPlugin(yXml)] : plugins,
  });
  const root = document.createElement('div');
  document.body.appendChild(root);
  const view = new EditorView(root, {
    state,
    attributes: { 'data-block-id': blockId },
  });
  return { ydoc, yXml, view, root, blockId };
}

let contexts;
beforeEach(() => { contexts = []; });
afterEach(() => {
  for (const c of contexts) {
    try { c.view.destroy(); } catch { /* */ }
    try { c.root.remove(); } catch { /* */ }
  }
});

describe('pm-relpos.saveSelection', () => {
  it('returns null for missing view', () => {
    expect(saveSelection(null)).toBeNull();
    expect(saveSelection(undefined)).toBeNull();
  });

  it('returns null when the view has no ySyncPlugin binding', () => {
    // EditorView constructed without ySyncPlugin — no binding present.
    const ctx = makeView({ plugins: [] });
    contexts.push(ctx);
    expect(saveSelection(ctx.view)).toBeNull();
  });

  it('returns a tuple with the block id on a valid view', () => {
    const ctx = makeView({ html: 'hello world', blockId: 'block-A' });
    contexts.push(ctx);
    const $a = ctx.view.state.doc.resolve(2);
    const $h = ctx.view.state.doc.resolve(6);
    ctx.view.dispatch(ctx.view.state.tr.setSelection(TextSelection.between($a, $h)));

    const saved = saveSelection(ctx.view);
    expect(saved).not.toBeNull();
    expect(saved.blockId).toBe('block-A');
    expect(saved.relAnchor).toBeDefined();
    expect(saved.relHead).toBeDefined();
  });
});

describe('pm-relpos.restoreSelection', () => {
  it('returns false for missing saved or view', () => {
    expect(restoreSelection(null, { blockId: 'x', relAnchor: {}, relHead: {} })).toBe(false);
    const ctx = makeView();
    contexts.push(ctx);
    expect(restoreSelection(ctx.view, null)).toBe(false);
  });

  it('returns false when the view has no binding', () => {
    const ctx = makeView({ blockId: 'b1' });
    contexts.push(ctx);
    const $a = ctx.view.state.doc.resolve(2);
    const $h = ctx.view.state.doc.resolve(6);
    ctx.view.dispatch(ctx.view.state.tr.setSelection(TextSelection.between($a, $h)));
    const saved = saveSelection(ctx.view);
    expect(saved).not.toBeNull();
    // Build a view WITHOUT ySyncPlugin to try restore into.
    const ctxNo = makeView({ blockId: 'b1', plugins: [] });
    contexts.push(ctxNo);
    expect(restoreSelection(ctxNo.view, saved)).toBe(false);
  });

  it('round-trips an identical selection through save → restore', () => {
    const ctx = makeView({ html: 'hello world', blockId: 'b1' });
    contexts.push(ctx);
    const $a = ctx.view.state.doc.resolve(2);
    const $h = ctx.view.state.doc.resolve(6);
    ctx.view.dispatch(ctx.view.state.tr.setSelection(TextSelection.between($a, $h)));

    const saved = saveSelection(ctx.view);
    expect(saved).not.toBeNull();

    // Move the cursor to simulate a re-render losing the selection.
    ctx.view.dispatch(ctx.view.state.tr.setSelection(TextSelection.atStart(ctx.view.state.doc)));
    expect(ctx.view.state.selection.from).toBe(1);

    const ok = restoreSelection(ctx.view, saved);
    expect(ok).toBe(true);
    expect(ctx.view.state.selection.from).toBe(2);
    expect(ctx.view.state.selection.to).toBe(6);
  });

  it('cross-block mismatch: refuses to restore a savedBlockA into viewBlockB', () => {
    // The save's blockId is 'block-A'; the view being restored into has
    // data-block-id 'block-B'. The guard fails CLOSED — silent off-by-one
    // would be worse than a clean false.
    const ctxA = makeView({ html: 'aaa', blockId: 'block-A' });
    contexts.push(ctxA);
    const $a = ctxA.view.state.doc.resolve(1);
    const $h = ctxA.view.state.doc.resolve(3);
    ctxA.view.dispatch(ctxA.view.state.tr.setSelection(TextSelection.between($a, $h)));
    const saved = saveSelection(ctxA.view);
    expect(saved.blockId).toBe('block-A');

    const ctxB = makeView({ html: 'bbb', blockId: 'block-B' });
    contexts.push(ctxB);
    const ok = restoreSelection(ctxB.view, saved);
    expect(ok).toBe(false);
  });

  it('round-trip survives a remote edit inserting text before the saved position', () => {
    // The 1h motivating case: FloatingToolbar opens at cursor end; while
    // toolbar UI is visible, a peer inserts at the start of the doc.
    // Y.RelativePosition tracks the original anchor — restore lands the
    // caret near the original character, not at the shifted offset.
    const ctx = makeView({ html: 'hello world', blockId: 'b1' });
    contexts.push(ctx);
    const collapsedAtEnd = ctx.view.state.doc.content.size - 1;
    const $h = ctx.view.state.doc.resolve(collapsedAtEnd);
    ctx.view.dispatch(ctx.view.state.tr.setSelection(TextSelection.between($h, $h)));

    const saved = saveSelection(ctx.view);
    expect(saved).not.toBeNull();

    // Simulate a remote insert: 'XYZ' prepended to the YXmlText.
    ctx.ydoc.transact(() => {
      const para = ctx.yXml.toArray()[0];
      const text = para.toArray()[0];
      text.insert(0, 'XYZ');
    }, 'remote-test');

    const ok = restoreSelection(ctx.view, saved);
    expect(ok).toBe(true);
    // The relative position should still point to the original anchor,
    // which is now 3 positions further from the start.
    expect(ctx.view.state.selection.from).toBeGreaterThan(collapsedAtEnd);
    expect(ctx.view.state.selection.from).toBeLessThanOrEqual(ctx.view.state.doc.content.size);
  });

  it('round-trip survives a remote DELETE before the saved position', () => {
    const ctx = makeView({ html: 'XYZhello world', blockId: 'b1' });
    contexts.push(ctx);
    // Anchor at the start of "hello" (position after "XYZ" = doc pos 4).
    const anchorPos = 4;
    const $h = ctx.view.state.doc.resolve(anchorPos);
    ctx.view.dispatch(ctx.view.state.tr.setSelection(TextSelection.between($h, $h)));

    const saved = saveSelection(ctx.view);
    expect(saved).not.toBeNull();

    // Peer deletes "XYZ" (3 chars at start).
    ctx.ydoc.transact(() => {
      const para = ctx.yXml.toArray()[0];
      const text = para.toArray()[0];
      text.delete(0, 3);
    }, 'remote-test');

    const ok = restoreSelection(ctx.view, saved);
    expect(ok).toBe(true);
    // After deletion the absolute position shifts by 3 backward, but the
    // logical "start of hello" character is at position 1 (paragraph
    // start). The restored selection should land near there.
    expect(ctx.view.state.selection.from).toBeLessThan(anchorPos);
  });
});
