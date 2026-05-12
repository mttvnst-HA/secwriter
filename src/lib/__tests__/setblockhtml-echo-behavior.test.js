// @vitest-environment jsdom
//
// Regression test pinning the empirical justification for sub-PR 1g's
// `COMMENT_RECONCILE_META`-gated `onUpdate` skip in PmEditableBlock's
// `dispatchTransaction`.
//
// Background: sub-PR 1g introduces a comment-reconcile path that dispatches
// PM transactions to add / remove / re-attribute `comment` marks on the
// substrate. ySyncPlugin handles the PM-to-substrate write with origin
// `ySyncPluginKey` (UndoManager skips it). The question during design review
// was whether the dispatchTransaction's debounced `onUpdate` could be left
// un-gated for these transactions — i.e. let it fire `handleBlockUpdate`,
// which calls `setBlockHtml(yStore, id, html)` with the post-reconcile html.
//
// Hypothesis being tested: `setBlockHtml`'s `prosemirrorToYXmlFragment`
// diff-and-merge IS a no-op when the input PM doc matches the substrate's
// current state, so the un-gated path produces zero echo ops.
//
// Hypothesis is FALSE. Even when ySyncPlugin has just written a doc to the
// substrate and `setBlockHtml` is called with `pmFragmentToHtml` of the SAME
// state, `prosemirrorToYXmlFragment` produces a non-empty Yjs op with
// origin `'local-publish'`. That op enters the Yjs UndoManager (which tracks
// `'local-publish'`), so an un-gated reconcile path would let Ctrl+Z un-do
// the reconciliation — potentially looping with the next reconcile pass.
//
// Conclusion: the `COMMENT_RECONCILE_META` PM-meta sentinel in 1g MUST gate
// the `onUpdate` debounce, not just the synthesized 'input' event.
//
// If this test ever fails in the "echo op produced" direction (i.e. the
// diff-and-merge becomes a true no-op for matching inputs), the gating
// rationale should be re-evaluated — leaving onUpdate un-gated would no
// longer create an echo op, and item 5 of the second design review (the
// "gate onUpdate" position) would become moot.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as Y from 'yjs';
import { EditorState, PluginKey } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { ySyncPlugin, prosemirrorToYXmlFragment } from 'y-prosemirror';

import { schema } from '../pm-schema.js';
import { htmlToPmFragment, pmFragmentToHtml } from '../pmdoc-html.js';
import { setBlockHtml } from '../block-html-store.js';

let root;
let ydoc;
let yStore;
let yXml;
let view;
let updateLog;

function setupSubstrate(initialHtml) {
  ydoc = new Y.Doc();
  yStore = ydoc.getMap('blocks');
  const yMap = new Y.Map();
  yXml = new Y.XmlFragment();
  yMap.set('html', yXml);
  yStore.set('b1', yMap);
  prosemirrorToYXmlFragment(htmlToPmFragment(initialHtml), yXml);
}

function trackUpdates() {
  updateLog = [];
  ydoc.on('update', (update, origin) => {
    updateLog.push({
      origin,
      originStr: String(origin),
      bytes: update.byteLength,
    });
  });
}

function mountView(initialHtml) {
  setupSubstrate(initialHtml);
  const state = EditorState.create({ schema, plugins: [ySyncPlugin(yXml)] });
  view = new EditorView(root, {
    state,
    dispatchTransaction(tr) {
      const newState = this.state.apply(tr);
      this.updateState(newState);
    },
  });
  // After mount, ySyncPlugin has fired its initial-sync transaction.
  // Track updates only from this point.
  trackUpdates();
}

function findCommentMarkRange() {
  const commentMarkType = schema.marks.comment;
  let from = -1;
  let to = -1;
  view.state.doc.descendants((node, pos) => {
    if (node.isText && node.marks.some((m) => m.type === commentMarkType)) {
      if (from < 0) from = pos;
      to = pos + node.nodeSize;
    }
    return true;
  });
  return { from, to };
}

beforeEach(() => {
  root = document.createElement('div');
  document.body.appendChild(root);
});

afterEach(() => {
  view?.destroy();
  view = null;
  ydoc?.destroy();
  root?.remove();
});

describe('setBlockHtml echo behavior — pins gating rationale for 1g COMMENT_RECONCILE_META', () => {
  it('setBlockHtml after a no-op (substrate already matches) STILL produces a local-publish op', () => {
    // This is the load-bearing observation: even when nothing has changed
    // since mount, calling setBlockHtml with the current pmFragmentToHtml
    // produces a non-zero Yjs op with origin 'local-publish'.
    mountView('<p>hello world</p>');
    const html = pmFragmentToHtml(view.state.doc);
    setBlockHtml(yStore, 'b1', html);
    const localPublishOps = updateLog.filter((u) => u.originStr === 'local-publish');
    expect(localPublishOps.length).toBeGreaterThan(0);
    expect(localPublishOps[0].bytes).toBeGreaterThan(0);
  });

  it('reconcile dispatch + un-gated setBlockHtml: two ops with DIFFERENT origins', () => {
    // The full simulated un-gated flow:
    //   1. Reconcile dispatches PM tr → ySyncPlugin writes substrate (ySyncPluginKey)
    //   2. Un-gated onUpdate fires → setBlockHtml writes substrate again (local-publish)
    // The second op is the echo the gate exists to prevent.
    mountView('<p>hello <span class="mark-comment" data-comment-id="c-1">world</span></p>');
    const { from, to } = findCommentMarkRange();
    expect(from).toBeGreaterThan(-1);
    const commentMarkType = schema.marks.comment;
    const targetNode = view.state.doc.nodeAt(from);
    const targetMark = targetNode.marks.find((m) => m.type === commentMarkType);
    // Reconcile path: remove + re-add with corrected resolved attr.
    const tr = view.state.tr
      .removeMark(from, to, targetMark)
      .addMark(from, to, commentMarkType.create({ id: 'c-1', resolved: true }));
    view.dispatch(tr);
    // Un-gated onUpdate simulation:
    const html = pmFragmentToHtml(view.state.doc);
    setBlockHtml(yStore, 'b1', html);
    // Expect at least two ops: one from ySyncPlugin and one from setBlockHtml.
    const ySyncOps = updateLog.filter(
      (u) => u.originStr !== 'local-publish' && u.bytes > 0,
    );
    const localPublishOps = updateLog.filter((u) => u.originStr === 'local-publish');
    expect(ySyncOps.length).toBeGreaterThan(0);
    expect(localPublishOps.length).toBeGreaterThan(0);
  });

  it('control: setBlockHtml with DIFFERENT content also produces a local-publish op (harness works)', () => {
    mountView('<p>hello world</p>');
    setBlockHtml(yStore, 'b1', '<p>hello WORLD</p>');
    const localPublishOps = updateLog.filter((u) => u.originStr === 'local-publish');
    expect(localPublishOps.length).toBeGreaterThan(0);
  });

  // Pinned for 1g's setActiveComment design: setActiveComment dispatches a
  // meta-only PM tr (no doc change) to toggle the activeCommentPlugin's
  // decoration state. ySyncPlugin runs on every tr (no tr.docChanged guard
  // in y-prosemirror master per WebFetch analysis), but the diff over an
  // unchanged doc is empty — verify no Yjs op is produced. Without this
  // contract, every popup open/close would generate a Yjs op and (depending
  // on origin) potentially enter the UndoManager.
  it('meta-only PM transaction produces zero Yjs ops via ySyncPlugin', () => {
    mountView('<p>hello world</p>');
    const someKey = new PluginKey('test-meta-only');
    const tr = view.state.tr.setMeta(someKey, 'value');
    expect(tr.docChanged).toBe(false);
    view.dispatch(tr);
    expect(updateLog.length).toBe(0);
  });
});
