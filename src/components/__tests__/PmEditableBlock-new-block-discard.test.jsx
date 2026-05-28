// @vitest-environment jsdom
//
// PmEditableBlock-new-block-discard.test.jsx — a block created empty and new
// (Enter / slash-convert) should be discarded if the user presses Escape or
// clicks outside the block BEFORE typing anything into it. Once any content
// is typed the block is committed and neither gesture removes it. A pre-
// existing (non-new) block is never auto-discarded.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import * as Y from 'yjs';
import { prosemirrorToYXmlFragment } from 'y-prosemirror';

import { htmlToPmFragment } from '../../lib/pmdoc-html.js';
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

let container = null;
let root = null;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  if (root) act(() => { root.unmount(); });
  if (container) document.body.removeChild(container);
  container = null;
  root = null;
});

async function renderBlock({ block, yStore, onDelete }) {
  await act(async () => {
    root.render(
      <div>
        {/* App chrome outside the editor content region (toolbar). */}
        <button id="ext-toolbar" type="button">Track Changes</button>
        {/* Editor content region — clicks here count as "moving on" in the doc. */}
        <div className="editor-scroll">
          <PmEditableBlock
            block={block}
            yStore={yStore}
            onUpdate={vi.fn()}
            identity={{ id: 'u1', name: 'U', color: '#000' }}
            showTags={false}
            lintingState={linting.createInitial({ enabled: false })}
            lintingDispatch={vi.fn()}
            onEnterKey={vi.fn()}
            isFocused={false}
            onFocus={vi.fn()}
            oliLabel={null}
            onDelete={onDelete}
            onFocusPrev={vi.fn()}
            onFocusNext={vi.fn()}
            onConvertBlock={vi.fn()}
            onChangeOliLevel={vi.fn()}
            resolveHtml={(h) => h}
            tailorKey={null}
            trackChanges={false}
            onAcceptRevision={vi.fn()}
            onRejectRevision={vi.fn()}
            onRefreshTcSnapshot={vi.fn()}
            commentsState={null}
            onCommentClick={vi.fn()}
            onInlineFix={vi.fn()}
            readOnly={false}
          />
        </div>
      </div>
    );
  });
  // PM EditorView mounts via useSyncExternalStore subscription — wait for it.
  await new Promise((r) => setTimeout(r, 50));
}

async function getView(blockId) {
  const { getBlockView } = await import('../../lib/block-registry.js');
  return getBlockView(blockId);
}

function pressEscape(view) {
  const event = new KeyboardEvent('keydown', { key: 'Escape' });
  act(() => {
    view.someProp('handleKeyDown', (f) => f(view, event));
  });
}

// Click elsewhere within the editor content region (a different spot in the
// document) — this counts as moving on, so an untouched new block is discarded.
function clickInEditorRegion() {
  act(() => {
    container.querySelector('.editor-scroll').dispatchEvent(
      new MouseEvent('mousedown', { bubbles: true }),
    );
  });
}

// Click app chrome outside the editor region (toolbar) — NOT a discard.
function clickToolbar() {
  act(() => {
    container.querySelector('#ext-toolbar').dispatchEvent(
      new MouseEvent('mousedown', { bubbles: true }),
    );
  });
}

function typeChar(view, ch) {
  act(() => {
    view.dispatch(view.state.tr.insertText(ch));
  });
}

describe('PmEditableBlock new-block discard', () => {
  it('Escape discards an untouched new empty block', async () => {
    const onDelete = vi.fn();
    const { yStore } = setupYStore('b1', '<p></p>');
    await renderBlock({ block: { id: 'b1', type: 'txt', html: '<p></p>', isNew: true }, yStore, onDelete });
    const view = await getView('b1');
    expect(view).toBeTruthy();

    pressEscape(view);
    expect(onDelete).toHaveBeenCalledWith('b1');
  });

  it('clicking elsewhere in the document discards an untouched new empty block', async () => {
    const onDelete = vi.fn();
    const { yStore } = setupYStore('b1', '<p></p>');
    await renderBlock({ block: { id: 'b1', type: 'txt', html: '<p></p>', isNew: true }, yStore, onDelete });
    await getView('b1');

    clickInEditorRegion();
    expect(onDelete).toHaveBeenCalledWith('b1');
  });

  it('clicking app chrome (toolbar) outside the editor region does NOT discard', async () => {
    const onDelete = vi.fn();
    const { yStore } = setupYStore('b1', '<p></p>');
    await renderBlock({ block: { id: 'b1', type: 'txt', html: '<p></p>', isNew: true }, yStore, onDelete });
    await getView('b1');

    clickToolbar();
    expect(onDelete).not.toHaveBeenCalled();
  });

  it('does NOT discard after the user types content', async () => {
    const onDelete = vi.fn();
    const { yStore } = setupYStore('b1', '<p></p>');
    await renderBlock({ block: { id: 'b1', type: 'txt', html: '<p></p>', isNew: true }, yStore, onDelete });
    const view = await getView('b1');

    typeChar(view, 'x');
    pressEscape(view);
    clickInEditorRegion();
    expect(onDelete).not.toHaveBeenCalled();
  });

  it('does NOT discard a pre-existing (non-new) empty block', async () => {
    const onDelete = vi.fn();
    const { yStore } = setupYStore('b1', '<p></p>');
    await renderBlock({ block: { id: 'b1', type: 'txt', html: '<p></p>', isNew: false }, yStore, onDelete });
    const view = await getView('b1');

    pressEscape(view);
    clickInEditorRegion();
    expect(onDelete).not.toHaveBeenCalled();
  });

  it('clicking inside the block does not discard it', async () => {
    const onDelete = vi.fn();
    const { yStore } = setupYStore('b1', '<p></p>');
    await renderBlock({ block: { id: 'b1', type: 'txt', html: '<p></p>', isNew: true }, yStore, onDelete });
    await getView('b1');

    const wrapper = container.querySelector('#block-b1');
    expect(wrapper).toBeTruthy();
    act(() => {
      wrapper.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    expect(onDelete).not.toHaveBeenCalled();
  });
});
