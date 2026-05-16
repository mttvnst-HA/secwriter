// @vitest-environment jsdom
//
// PmEditableBlock-tc-resolve.test.jsx — regression for issue #96.
//
// Bug: when Track Changes is enabled, dispatchDelAction's Accept produces
// `tr.delete(from, to)` over a range that already carries a revisionDel
// mark. PmEditableBlock.dispatchTransaction routes every local docChanged
// tr through `rewriteForTrackChanges`, whose `collectDeleteSegments` only
// classifies a range as 'cancel' (actually delete) when the text carries
// a revisionAdd mark by the current author. Text carrying revisionDel is
// classified as 'mark' instead — phase A re-adds the already-present
// revisionDel mark (no-op) and phase B has nothing to delete. The dispatch
// silently becomes a no-op and the <del> element stays.
//
// Fix shape: dispatchDelAction tags its tr with `TC_RESOLVE_META`;
// PmEditableBlock's dispatchTransaction skips the TC-rewrite path when the
// meta is set. Mirrors the COMMENT_RECONCILE_META pattern (pm-comments.js
// + PmEditableBlock-comment-reconcile.test.jsx).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import * as Y from 'yjs';
import { prosemirrorToYXmlFragment } from 'y-prosemirror';

import { htmlToPmFragment } from '../../lib/pmdoc-html.js';
import { dispatchDelAction } from '../../lib/pm-del-popup.js';
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

async function renderBlock(container, { block, yStore, trackChanges }) {
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <PmEditableBlock
        block={block}
        yStore={yStore}
        onUpdate={vi.fn()}
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
        trackChanges={trackChanges}
        snapshotText={vi.fn(() => '')}
        onAcceptRevision={vi.fn()}
        onRejectRevision={vi.fn()}
        onRevisionAction={vi.fn()}
        onRefreshTcSnapshot={vi.fn()}
        commentsState={null}
        onCommentClick={vi.fn()}
        onInlineFix={vi.fn()}
        readOnly={false}
      />,
    );
  });
  return root;
}

let container;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
});
afterEach(() => {
  container?.remove();
});

describe('PmEditableBlock — TC-resolve dispatchTransaction gate (issue #96)', () => {
  it('dispatchDelAction Accept removes the deletion when Track Changes is ON', async () => {
    const html = '<p>before <del class="mark-del" data-author-id="u">deleted</del> after</p>';
    const { yStore } = setupYStore('b1', html);
    const block = { id: 'b1', type: 'txt', html, isNew: false };

    const root = await renderBlock(container, { block, yStore, trackChanges: true });
    await new Promise((r) => setTimeout(r, 50));

    const view = getBlockView('b1');
    expect(view).toBeTruthy();

    const delEl = view.dom.querySelector('del.mark-del');
    expect(delEl).toBeTruthy();
    expect(delEl.textContent).toBe('deleted');

    await act(async () => {
      dispatchDelAction(view, delEl, 'accept');
    });

    expect(view.dom.querySelectorAll('del.mark-del').length).toBe(0);
    expect(view.state.doc.textContent).not.toContain('deleted');
    expect(view.state.doc.textContent).toBe('before  after');

    root.unmount();
  });

  it('control: dispatchDelAction Accept removes the deletion when Track Changes is OFF (legacy-passing path)', async () => {
    // Sanity check that the harness is correct: with TC off, the rewriter
    // does not run, and the del-popup path works as the unit tests cover.
    const html = '<p>before <del class="mark-del" data-author-id="u">deleted</del> after</p>';
    const { yStore } = setupYStore('b2', html);
    const block = { id: 'b2', type: 'txt', html, isNew: false };

    const root = await renderBlock(container, { block, yStore, trackChanges: false });
    await new Promise((r) => setTimeout(r, 50));

    const view = getBlockView('b2');
    expect(view).toBeTruthy();
    const delEl = view.dom.querySelector('del.mark-del');
    expect(delEl).toBeTruthy();

    await act(async () => {
      dispatchDelAction(view, delEl, 'accept');
    });

    expect(view.dom.querySelectorAll('del.mark-del').length).toBe(0);
    expect(view.state.doc.textContent).toBe('before  after');

    root.unmount();
  });
});
