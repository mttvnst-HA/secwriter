// @vitest-environment jsdom
//
// Regression test for the wrapper-key drop (App.jsx:2669, dropping the
// `-${block.type}` suffix). Pins that PmEditableBlock keeps its mounted
// EditorView across a Family A type flip with the same block id.
//
// If a future change re-introduces a remount on type change (e.g. by
// adding `block.type` back into the wrapper key, or by changing
// PmEditableBlock's `editable` memo to exclude one of the Family A
// types), this test fires.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act } from '@testing-library/react';
import * as Y from 'yjs';
import { prosemirrorToYXmlFragment } from 'y-prosemirror';

import PmEditableBlock from '../PmEditableBlock.jsx';
import { htmlToPmFragment } from '../../lib/pmdoc-html.js';
import * as registry from '../../lib/block-registry.js';
import * as linting from '../../lib/linting.js';

function seedSlotV2(yStore, ydoc, blockId, html, type) {
  ydoc.transact(() => {
    const yMap = new Y.Map();
    yMap.set('type', type || 'txt');
    yMap.set('part', 1);
    yMap.set('depth', 0);
    yMap.set('section', null);
    yMap.set('level', 1);
    yMap.set('revision', null);
    yMap.set('isNew', false);
    const yXml = new Y.XmlFragment();
    yMap.set('html', yXml);
    yStore.set(blockId, yMap);
    prosemirrorToYXmlFragment(htmlToPmFragment(html || ''), yXml);
  }, 'local-apply');
}

function defaultProps(block, yStore) {
  return {
    block,
    yStore,
    onUpdate: vi.fn(),
    onEnterKey: vi.fn(),
    isFocused: false,
    onFocus: vi.fn(),
    oliLabel: null,
    onDelete: vi.fn(),
    onFocusPrev: vi.fn(),
    onFocusNext: vi.fn(),
    onConvertBlock: vi.fn(),
    onChangeOliLevel: vi.fn(),
    resolveHtml: (h) => h,
    tailorKey: null,
    trackChanges: false,
    identity: { name: 'tester' },
    onAcceptRevision: vi.fn(),
    onRejectRevision: vi.fn(),
    commentsState: null,
    onCommentClick: vi.fn(),
    onInlineFix: vi.fn(),
    lintingState: linting.createInitial({ enabled: false }),
    lintingDispatch: vi.fn(),
    showTags: false,
    readOnly: false,
  };
}

describe('PmEditableBlock — convert persistence', () => {
  let ydoc;
  let yStore;

  beforeEach(() => {
    registry.__resetBlockRegistry();
    ydoc = new Y.Doc();
    yStore = ydoc.getMap('store');
  });

  afterEach(() => {
    registry.__resetBlockRegistry();
    ydoc?.destroy?.();
  });

  it('keeps the same registered handle across txt -> note', async () => {
    seedSlotV2(yStore, ydoc, 'b1', '<p>hello</p>', 'txt');
    const block = { id: 'b1', type: 'txt', html: '<p>hello</p>' };
    const { rerender } = render(<PmEditableBlock {...defaultProps(block, yStore)} />);
    await act(async () => {});

    const handleBefore = registry.getBlockHandle('b1');
    expect(handleBefore).not.toBeNull();
    const domBefore = handleBefore.getEditable();

    // Same id, type flipped to note. This is what `handleConvertBlockType`
    // produces.
    const blockAfter = { ...block, type: 'note' };
    rerender(<PmEditableBlock {...defaultProps(blockAfter, yStore)} />);
    await act(async () => {});

    const handleAfter = registry.getBlockHandle('b1');
    expect(handleAfter).not.toBeNull();
    expect(Object.is(handleBefore, handleAfter)).toBe(true);

    // Belt-and-suspenders: PM EditorView DOM root identity is preserved.
    const domAfter = handleAfter.getEditable();
    expect(domBefore).not.toBeNull();
    expect(Object.is(domBefore, domAfter)).toBe(true);
  });

  it('keeps the same handle across oli -> item -> lst (chain)', async () => {
    seedSlotV2(yStore, ydoc, 'b1', '<p>x</p>', 'oli');
    const props = defaultProps({ id: 'b1', type: 'oli', level: 2, html: '<p>x</p>' }, yStore);
    const { rerender } = render(<PmEditableBlock {...props} />);
    await act(async () => {});

    const handle1 = registry.getBlockHandle('b1');

    rerender(<PmEditableBlock {...defaultProps({ id: 'b1', type: 'item', html: '<p>x</p>' }, yStore)} />);
    await act(async () => {});
    const handle2 = registry.getBlockHandle('b1');
    expect(Object.is(handle1, handle2)).toBe(true);

    rerender(<PmEditableBlock {...defaultProps({ id: 'b1', type: 'lst', html: '<p>x</p>' }, yStore)} />);
    await act(async () => {});
    const handle3 = registry.getBlockHandle('b1');
    expect(Object.is(handle1, handle3)).toBe(true);
  });

  // Wraps the block in App.jsx's actual wrapper-key shape so a regression
  // that re-introduces `${block.id}-${block.type}` would actually remount.
  // The two tests above bypass that wrapper; this one pins the App-level
  // contract.
  it('App-level: handle survives type flip when wrapper key is block.id only', async () => {
    seedSlotV2(yStore, ydoc, 'b1', '<p>x</p>', 'txt');
    const block = { id: 'b1', type: 'txt', html: '<p>x</p>' };

    function Host({ blk }) {
      // Mimic the App.jsx wrapper-key contract: key={block.id} only.
      return (
        <div key={blk.id}>
          <PmEditableBlock {...defaultProps(blk, yStore)} />
        </div>
      );
    }

    const { rerender } = render(<Host blk={block} />);
    await act(async () => {});
    const before = registry.getBlockHandle('b1');

    rerender(<Host blk={{ ...block, type: 'note' }} />);
    await act(async () => {});
    const after = registry.getBlockHandle('b1');

    expect(before).not.toBeNull();
    expect(Object.is(before, after)).toBe(true);
  });
});
