// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import CommentPopup from '../CommentPopup.jsx';

// A submitted (non-new, open) comment so the popup renders the thread card
// rather than the author-name prompt or the new-comment composer.
const COMMENT = {
  id: 'comment-track-1',
  status: 'open',
  entries: [{ type: 'create', text: 'hi', authorName: 'A', authorColor: '#000', ts: 0 }],
};

const noop = () => {};

function renderPopup(container, rect) {
  const root = createRoot(container);
  act(() => {
    root.render(
      <CommentPopup
        comment={COMMENT}
        rect={rect}
        onReply={noop} onResolve={noop} onReopen={noop}
        onDelete={noop} onClose={noop} onUpdateCreate={noop}
      />
    );
  });
  return root;
}

describe('CommentPopup scroll tracking', () => {
  let container, span, rafSpy;

  beforeEach(() => {
    localStorage.setItem('sim-comment-author', 'A'); // skip the name prompt
    // Run requestAnimationFrame callbacks synchronously for determinism.
    rafSpy = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => { cb(); return 1; });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});

    span = document.createElement('span');
    span.setAttribute('data-comment-id', COMMENT.id);
    span.getBoundingClientRect = () => ({ top: 300, bottom: 320 });
    document.body.appendChild(span);

    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    rafSpy.mockRestore();
    vi.restoreAllMocks();
    span.remove();
    container.remove();
  });

  it('repositions the card to follow its comment span on scroll', () => {
    const root = renderPopup(container, { top: 300, bottom: 320 });
    const card = container.querySelector('[data-test="comment-popup"]');
    expect(card.style.top).toBe('300px');

    // Span scrolls up to y=120; a scroll event should re-read it.
    span.getBoundingClientRect = () => ({ top: 120, bottom: 140 });
    act(() => { window.dispatchEvent(new Event('scroll')); });
    expect(card.style.top).toBe('120px');

    act(() => root.unmount());
  });

  it('hides the card when the span scrolls out of the viewport', () => {
    const root = renderPopup(container, { top: 300, bottom: 320 });
    const card = container.querySelector('[data-test="comment-popup"]');
    expect(card.style.display).toBe('');

    span.getBoundingClientRect = () => ({ top: -200, bottom: -100 });
    act(() => { window.dispatchEvent(new Event('scroll')); });
    expect(card.style.display).toBe('none');

    act(() => root.unmount());
  });
});
