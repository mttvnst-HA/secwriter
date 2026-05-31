// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import CommentPopup from '../CommentPopup.jsx';

// Submitted (non-new, open) comment → renders the thread card.
const EXISTING = {
  id: 'comment-dismiss-1',
  status: 'open',
  entries: [{ type: 'create', text: 'hi', authorName: 'A', authorColor: '#000', ts: 0 }],
};

// New, empty draft → renders the composer.
const DRAFT = {
  id: 'comment-dismiss-2',
  status: 'open',
  entries: [{ type: 'create', text: '', authorName: 'A', authorColor: '#000', ts: 0 }],
};

function renderPopup(container, comment, handlers) {
  const root = createRoot(container);
  const noop = () => {};
  act(() => {
    root.render(
      <CommentPopup
        comment={comment}
        rect={{ top: 100, bottom: 120 }}
        onReply={handlers.onReply || noop}
        onResolve={handlers.onResolve || noop}
        onReopen={handlers.onReopen || noop}
        onDelete={handlers.onDelete || noop}
        onClose={handlers.onClose || noop}
        onUpdateCreate={handlers.onUpdateCreate || noop}
      />
    );
  });
  return root;
}

describe('CommentPopup outside-click dismiss (#195 follow-up)', () => {
  let container, outside;

  beforeEach(() => {
    localStorage.setItem('sim-comment-author', 'A'); // skip name prompt
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => { cb(); return 1; });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
    container = document.createElement('div');
    document.body.appendChild(container);
    outside = document.createElement('div');
    document.body.appendChild(outside);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    container.remove();
    outside.remove();
  });

  it('keeps an existing comment open when the span is de-selected (outside mousedown)', () => {
    const onClose = vi.fn();
    const onDelete = vi.fn();
    const root = renderPopup(container, EXISTING, { onClose, onDelete });

    act(() => {
      outside.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });

    expect(onClose).not.toHaveBeenCalled();
    expect(onDelete).not.toHaveBeenCalled();

    act(() => root.unmount());
  });

  it('still discards an empty draft on outside mousedown', () => {
    const onClose = vi.fn();
    const onDelete = vi.fn();
    const root = renderPopup(container, DRAFT, { onClose, onDelete });

    act(() => {
      outside.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });

    expect(onDelete).toHaveBeenCalledWith(DRAFT.id);
    expect(onClose).toHaveBeenCalled();

    act(() => root.unmount());
  });
});
