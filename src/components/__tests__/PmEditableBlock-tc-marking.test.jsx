// @vitest-environment jsdom
//
// PmEditableBlock-tc-marking.test.jsx — sub-PR 1h (#47) Q33 integration.
//
// Pins that PmEditableBlock's `dispatchTransaction` actually routes user
// edits through the marking pipeline when TC is on, and that the gating
// (remote / undo / reconcile / TC off) correctly bypasses the rewrite.
//
// Unit-level coverage for the rewrite function itself lives in
// pm-tc-mark.test.js. This file covers WIRING.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import * as Y from 'yjs';
import { prosemirrorToYXmlFragment } from 'y-prosemirror';

import { htmlToPmFragment } from '../../lib/pmdoc-html.js';
import { getBlockView } from '../../lib/block-registry.js';
import * as linting from '../../lib/linting.js';
import PmEditableBlock from '../PmEditableBlock.jsx';

function setupYStore(blockId, html) {
  const ydoc = new Y.Doc();
  const yStore = ydoc.getMap('blocks');
  const yMap = new Y.Map();
  const yXml = new Y.XmlFragment();
  yMap.set('html', yXml);
  yStore.set(blockId, yMap);
  prosemirrorToYXmlFragment(htmlToPmFragment(html), yXml);
  return { ydoc, yStore };
}

async function renderBlock(container, { trackChanges, identity, yStore, html }) {
  const onUpdate = vi.fn();
  const block = { id: 'b1', type: 'txt', html, isNew: false };
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <PmEditableBlock
        block={block}
        yStore={yStore}
        onUpdate={onUpdate}
        identity={identity}
        showTags={false}
        lintingState={linting.createInitial({ enabled: false })}
        lintingDispatch={vi.fn()}
        onEnterKey={vi.fn()}
        isFocused={false}
        onFocus={vi.fn()}
        oliLabel={null}
        onDelete={vi.fn()}
        onFocusPrev={vi.fn()}
        onFocusNext={vi.fn()}
        onConvertBlock={vi.fn()}
        onChangeOliLevel={vi.fn()}
        resolveHtml={(h) => h}
        tailorKey={null}
        trackChanges={trackChanges}
        snapshotText={null}
        onAcceptRevision={vi.fn()}
        onRejectRevision={vi.fn()}
        onRevisionAction={vi.fn()}
        commentsState={null}
        onCommentClick={vi.fn()}
        onInlineFix={vi.fn()}
        readOnly={false}
      />,
    );
  });
  return { root, onUpdate };
}

function getMarksAt(doc, from, to) {
  const marks = new Set();
  doc.nodesBetween(from, to, (node) => {
    if (!node.isText) return true;
    for (const m of node.marks) marks.add(m.type.name);
    return false;
  });
  return marks;
}

let container;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
});
afterEach(() => {
  container?.remove();
});

describe('PmEditableBlock — TC marking pipeline wiring (Q33)', () => {
  it('typing under TC=on adds revisionAdd marks via dispatchTransaction', async () => {
    const { yStore } = setupYStore('b1', '');
    const { root } = await renderBlock(container, {
      trackChanges: true,
      identity: { id: 'alice', name: 'Alice', color: '#ff6b6b' },
      yStore,
      html: '',
    });
    await new Promise((r) => setTimeout(r, 50));
    const view = getBlockView('b1');
    expect(view).toBeTruthy();

    // Simulate user typing "hello" at position 1 (inside the empty paragraph).
    await act(async () => {
      view.dispatch(view.state.tr.insertText('hello', 1));
    });

    // Doc should show "hello" wrapped in revisionAdd marks.
    expect(view.state.doc.textContent).toBe('hello');
    const marks = getMarksAt(view.state.doc, 1, 6);
    expect(marks.has('revisionAdd')).toBe(true);
    root.unmount();
  });

  it('typing under TC=off does NOT add any revision marks', async () => {
    const { yStore } = setupYStore('b1', '');
    const { root } = await renderBlock(container, {
      trackChanges: false,
      identity: { id: 'alice', name: 'Alice', color: '#ff6b6b' },
      yStore,
      html: '',
    });
    await new Promise((r) => setTimeout(r, 50));
    const view = getBlockView('b1');

    await act(async () => {
      view.dispatch(view.state.tr.insertText('hello', 1));
    });

    expect(view.state.doc.textContent).toBe('hello');
    const marks = getMarksAt(view.state.doc, 1, 6);
    expect(marks.has('revisionAdd')).toBe(false);
    expect(marks.has('revisionDel')).toBe(false);
    root.unmount();
  });

  it('backspacing under TC=on rewrites delete to revisionDel (text stays visible)', async () => {
    // Seed with "abc" already in the substrate.
    const { yStore } = setupYStore('b1', 'abc');
    const { root } = await renderBlock(container, {
      trackChanges: true,
      identity: { id: 'alice', name: 'Alice', color: '#ff6b6b' },
      yStore,
      html: 'abc',
    });
    await new Promise((r) => setTimeout(r, 50));
    const view = getBlockView('b1');
    expect(view.state.doc.textContent).toBe('abc');

    // Backspace at end of "abc" — delete position 3..4.
    await act(async () => {
      view.dispatch(view.state.tr.delete(3, 4));
    });

    // Text still "abc" — "c" carries revisionDel.
    expect(view.state.doc.textContent).toBe('abc');
    const cMarks = getMarksAt(view.state.doc, 3, 4);
    expect(cMarks.has('revisionDel')).toBe(true);
    root.unmount();
  });

  it('self-cancel: typing then immediately backspacing removes the text', async () => {
    const { yStore } = setupYStore('b1', '');
    const { root } = await renderBlock(container, {
      trackChanges: true,
      identity: { id: 'alice', name: 'Alice', color: '#ff6b6b' },
      yStore,
      html: '',
    });
    await new Promise((r) => setTimeout(r, 50));
    const view = getBlockView('b1');

    // Type "x".
    await act(async () => {
      view.dispatch(view.state.tr.insertText('x', 1));
    });
    expect(view.state.doc.textContent).toBe('x');

    // Backspace it. "x" carries revisionAdd:alice — backspacing should
    // actually remove it, not wrap in <ins><del>.
    await act(async () => {
      view.dispatch(view.state.tr.delete(1, 2));
    });

    expect(view.state.doc.textContent).toBe('');
    root.unmount();
  });
});
