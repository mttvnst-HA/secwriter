// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import FloatingToolbar from '../FloatingToolbar.jsx';

describe('FloatingToolbar — smoke test (U11)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('renders nothing when there is no selection (initial state)', () => {
    // Forward-compat smoke: with no selection, the toolbar is hidden and no
    // handlers fire. Guards against accidental removal of the isRefBlock /
    // visibility gate that would let buttons reach state for ref/table
    // blocks (where they should always be hidden) — the deeper invariant
    // (isRefBlock-gates-buttons in the JSX) is exercised by the E2E
    // 'FloatingToolbar appears' / 'hides on Escape' tests, while this
    // smoke catches prop-signature and import regressions.
    const onBlockUpdate = vi.fn();
    const onRevisionAction = vi.fn();
    const onRefreshTcSnapshot = vi.fn();
    const onCommentCreate = vi.fn();

    const editorRef = { current: document.body };

    render(
      <FloatingToolbar
        editorRef={editorRef}
        onBlockUpdate={onBlockUpdate}
        onRevisionAction={onRevisionAction}
        onRefreshTcSnapshot={onRefreshTcSnapshot}
        trackChanges={true}
        onCommentCreate={onCommentCreate}
        identity={{ id: 'A', color: '#000' }}
        readOnly={false}
      />,
    );

    // No selection → toolbar renders nothing visible.
    expect(screen.queryByTitle('Bold')).toBeNull();
    expect(screen.queryByTitle('Mark as Addition')).toBeNull();
    expect(screen.queryByTitle('Mark as Deletion')).toBeNull();
    expect(screen.queryByTitle('Add Comment')).toBeNull();

    // No handlers should have been called during mount.
    expect(onBlockUpdate).not.toHaveBeenCalled();
    expect(onRevisionAction).not.toHaveBeenCalled();
    expect(onRefreshTcSnapshot).not.toHaveBeenCalled();
    expect(onCommentCreate).not.toHaveBeenCalled();
  });
});
