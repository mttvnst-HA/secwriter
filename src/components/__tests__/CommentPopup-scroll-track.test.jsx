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

function renderPopup(container, rect, paneRef) {
  const root = createRoot(container);
  act(() => {
    root.render(
      <CommentPopup
        comment={COMMENT}
        rect={rect}
        paneRef={paneRef}
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

  it('pins the card to the pane top (below the ribbon), never over it', () => {
    // Pane = the editor scroll viewport: ribbon bottom at y=200, status bar at y=900.
    const paneRef = { current: { getBoundingClientRect: () => ({ top: 200, bottom: 900 }) } };
    // Span scrolled partly under the ribbon (top=40) but still inside the pane.
    span.getBoundingClientRect = () => ({ top: 40, bottom: 240 });
    const root = renderPopup(container, { top: 40, bottom: 240 }, paneRef);
    const card = container.querySelector('[data-test="comment-popup"]');
    // Card pinned at pane top (200), NOT the window top (8).
    expect(card.style.top).toBe('200px');
    expect(card.style.display).toBe('');
    act(() => root.unmount());
  });

  it('hides the card when the span scrolls above the pane top (under the ribbon)', () => {
    const paneRef = { current: { getBoundingClientRect: () => ({ top: 200, bottom: 900 }) } };
    span.getBoundingClientRect = () => ({ top: 60, bottom: 150 }); // fully above paneTop=200
    const root = renderPopup(container, { top: 60, bottom: 150 }, paneRef);
    const card = container.querySelector('[data-test="comment-popup"]');
    expect(card.style.display).toBe('none');
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
