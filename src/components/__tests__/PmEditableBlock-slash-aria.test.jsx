// @vitest-environment jsdom
//
// PmEditableBlock-slash-aria.test.jsx — regression for the slash menu
// visibility redesign. When the slash menu opens, the PM editor's
// contentEditable DOM must gain combobox ARIA attributes so screen
// readers announce active-item changes (the listbox itself never
// holds focus). When the menu closes, the attributes must be removed.

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

async function renderBlock({ block, yStore }) {
  await act(async () => {
    root.render(
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
        onRefreshTcSnapshot={vi.fn()}
        commentsState={null}
        onCommentClick={vi.fn()}
        onInlineFix={vi.fn()}
        readOnly={false}
      />
    );
  });
  // PM EditorView mounts via useSyncExternalStore subscription — wait for it.
  await new Promise((r) => setTimeout(r, 50));
}

function getEditorDom() {
  return container.querySelector('.ProseMirror');
}

function typeChar(view, ch) {
  act(() => {
    view.dispatch(view.state.tr.insertText(ch));
  });
}

describe('PmEditableBlock combobox ARIA', () => {
  it('PM editor has no combobox attributes initially', async () => {
    const { yStore } = setupYStore('b1', '<p></p>');
    await renderBlock({ block: { id: 'b1', type: 'txt', html: '<p></p>', isNew: false }, yStore });
    const dom = getEditorDom();
    // The five attributes we manage. (PM may set its own attributes like
    // contenteditable; we only assert on ours.)
    expect(dom.hasAttribute('role')).toBe(false);
    expect(dom.hasAttribute('aria-haspopup')).toBe(false);
    expect(dom.hasAttribute('aria-expanded')).toBe(false);
    expect(dom.hasAttribute('aria-controls')).toBe(false);
    expect(dom.hasAttribute('aria-activedescendant')).toBe(false);
  });

  it('PM editor gains combobox attributes when slash menu opens', async () => {
    const { yStore } = setupYStore('b1', '<p></p>');
    await renderBlock({ block: { id: 'b1', type: 'txt', html: '<p></p>', isNew: false }, yStore });
    const { getBlockView } = await import('../../lib/block-registry.js');
    const view = getBlockView('b1');
    expect(view).toBeTruthy();

    // Typing '/' triggers the slash plugin -> React state mirror -> ARIA effect.
    typeChar(view, '/');

    const dom = getEditorDom();
    expect(dom.getAttribute('role')).toBe('combobox');
    expect(dom.getAttribute('aria-haspopup')).toBe('listbox');
    expect(dom.getAttribute('aria-expanded')).toBe('true');
    expect(dom.getAttribute('aria-controls')).toBe('sim-slash-listbox');
    expect(dom.getAttribute('aria-activedescendant')).toBe('sim-slash-item-0');
  });

  it('combobox attributes are removed when the leading slash is deleted', async () => {
    const { yStore } = setupYStore('b1', '<p></p>');
    await renderBlock({ block: { id: 'b1', type: 'txt', html: '<p></p>', isNew: false }, yStore });
    const { getBlockView } = await import('../../lib/block-registry.js');
    const view = getBlockView('b1');

    typeChar(view, '/');
    // Sanity: combobox attrs present.
    expect(getEditorDom().getAttribute('role')).toBe('combobox');

    // Remove the leading slash — plugin sees no leading '/', sets open: false,
    // mirror updates React state, effect tears down the attrs.
    // The slash is at position 1 inside the paragraph (position 0 is the node
    // boundary before the paragraph open tag, not a text position).
    act(() => {
      view.dispatch(view.state.tr.delete(1, 2));
    });

    const dom = getEditorDom();
    expect(dom.hasAttribute('role')).toBe(false);
    expect(dom.hasAttribute('aria-haspopup')).toBe(false);
    expect(dom.hasAttribute('aria-expanded')).toBe(false);
    expect(dom.hasAttribute('aria-controls')).toBe(false);
    expect(dom.hasAttribute('aria-activedescendant')).toBe(false);
  });
});
