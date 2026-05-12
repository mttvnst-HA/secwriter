// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import * as Y from 'yjs';
import { prosemirrorToYXmlFragment } from 'y-prosemirror';

import { htmlToPmFragment } from '../../lib/pmdoc-html.js';
import { COMMENT_RECONCILE_META } from '../../lib/pm-comments.js';
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

let container;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
});
afterEach(() => {
  container?.remove();
});

describe('PmEditableBlock — comment reconcile dispatchTransaction gate', () => {
  it('reconcile-tagged tr does NOT fire synthesized "input" event', async () => {
    const { yStore } = setupYStore('b1', '<p>hello world</p>');
    const onUpdate = vi.fn();
    const block = { id: 'b1', type: 'txt', html: '<p>hello world</p>', isNew: false };

    const root = createRoot(container);
    await act(async () => {
      root.render(
        <PmEditableBlock
          block={block}
          yStore={yStore}
          onUpdate={onUpdate}
          identity={{ id: 'u', name: 'U', color: '#000' }}
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
          trackChanges={false}
          snapshotText={vi.fn(() => '')}
          onAcceptRevision={vi.fn()}
          onRejectRevision={vi.fn()}
          onRevisionAction={vi.fn()}
          comments={null}
          onCommentClick={vi.fn()}
          onInlineFix={vi.fn()}
          readOnly={false}
        />,
      );
    });
    // Wait for mount + ySyncPlugin initial sync.
    await new Promise((r) => setTimeout(r, 50));

    // Reach into the registered view via block-registry.
    const view = getBlockView('b1');
    expect(view).toBeTruthy();

    // Count input events fired on the editor DOM.
    let inputEventCount = 0;
    const editorEl = view.dom;
    editorEl.addEventListener('input', () => { inputEventCount += 1; });

    // Dispatch a reconcile-tagged tr that changes the doc (insertText counts as docChanged).
    await act(async () => {
      view.dispatch(view.state.tr.insertText('!', view.state.doc.content.size - 1).setMeta(COMMENT_RECONCILE_META, true));
    });
    await new Promise((r) => setTimeout(r, 50));

    // Gate should suppress the synthesized 'input' event.
    expect(inputEventCount).toBe(0);
    // Gate should also suppress the onUpdate debounce; wait past the 400ms window.
    await new Promise((r) => setTimeout(r, 500));
    expect(onUpdate).not.toHaveBeenCalled();
    root.unmount();
  });

  it('regular (non-reconcile) tr DOES fire synthesized "input" event AND onUpdate', async () => {
    // Control: prove the harness can see the events when no gate applies.
    const { yStore } = setupYStore('b2', '<p>hello world</p>');
    const onUpdate = vi.fn();
    const block = { id: 'b2', type: 'txt', html: '<p>hello world</p>', isNew: false };

    const root = createRoot(container);
    await act(async () => {
      root.render(
        <PmEditableBlock
          block={block}
          yStore={yStore}
          onUpdate={onUpdate}
          identity={{ id: 'u', name: 'U', color: '#000' }}
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
          trackChanges={false}
          snapshotText={vi.fn(() => '')}
          onAcceptRevision={vi.fn()}
          onRejectRevision={vi.fn()}
          onRevisionAction={vi.fn()}
          comments={null}
          onCommentClick={vi.fn()}
          onInlineFix={vi.fn()}
          readOnly={false}
        />,
      );
    });
    await new Promise((r) => setTimeout(r, 50));

    const view = getBlockView('b2');
    expect(view).toBeTruthy();
    let inputEventCount = 0;
    const editorEl = view.dom;
    editorEl.addEventListener('input', () => { inputEventCount += 1; });

    // Regular (non-reconcile) doc-changing dispatch.
    await act(async () => {
      view.dispatch(view.state.tr.insertText('!', view.state.doc.content.size - 1));
    });
    await new Promise((r) => setTimeout(r, 50));

    expect(inputEventCount).toBeGreaterThan(0);
    // Wait past the 400ms onUpdate debounce.
    await new Promise((r) => setTimeout(r, 500));
    expect(onUpdate).toHaveBeenCalled();
    root.unmount();
  });
});
