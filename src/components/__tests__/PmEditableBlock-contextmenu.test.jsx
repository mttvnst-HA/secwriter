// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { getBlockHandle, __resetBlockRegistry } from '../../lib/block-registry.js';
import PmEditableBlock from '../PmEditableBlock.jsx';
import * as linting from '../../lib/linting.js';

// Minimal substrate stub: PmEditableBlock bails to an unmounted view when
// yStore.get(id) is undefined, so getView()/getContextAtCoords resolve with
// a null view and return null without throwing. That is exactly the
// "never block the native menu mid-teardown" contract we assert here.
const yStoreStub = { get: () => undefined, observe() {}, unobserve() {} };

afterEach(() => { cleanup(); __resetBlockRegistry(); });

function renderBlock(props = {}) {
  const block = { id: 'b1', type: 'txt', html: '<p>hello</p>', part: 1, depth: 0 };
  render(
    <PmEditableBlock
      block={block}
      yStore={yStoreStub}
      onUpdate={vi.fn()}
      onEnterKey={vi.fn()}
      isFocused={false}
      onFocus={vi.fn()}
      oliLabel={null}
      onDelete={vi.fn()}
      onFocusPrev={vi.fn()}
      onFocusNext={vi.fn()}
      onConvertBlock={vi.fn()}
      onConvertBlockType={vi.fn()}
      onChangeOliLevel={vi.fn()}
      resolveHtml={(html) => html}
      tailorKey={null}
      trackChanges={false}
      identity={{ name: 'tester' }}
      onAcceptRevision={vi.fn()}
      onRejectRevision={vi.fn()}
      commentsState={null}
      onCommentClick={vi.fn()}
      onInlineFix={vi.fn()}
      lintingState={linting.createInitial({ enabled: false })}
      lintingDispatch={vi.fn()}
      showTags={false}
      readOnly={false}
      {...props}
    />,
  );
  return getBlockHandle('b1');
}

describe('PmEditableBlock context-menu handle', () => {
  it('registers a getContextAtCoords handle method', () => {
    const handle = renderBlock();
    expect(typeof handle.getContextAtCoords).toBe('function');
  });

  it('getContextAtCoords returns null when the view is unmounted (never blocks native menu)', () => {
    const handle = renderBlock();
    expect(handle.getContextAtCoords({ x: 10, y: 10 })).toBeNull();
  });
});
