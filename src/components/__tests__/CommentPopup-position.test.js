import { describe, it, expect } from 'vitest';
import { computeCommentPopupPosition } from '../CommentPopup.jsx';

describe('computeCommentPopupPosition', () => {
  const VH = 800;

  it('falls back to a fixed top when no rect is given', () => {
    expect(computeCommentPopupPosition(null, VH)).toEqual({ top: 200, hidden: false });
  });

  it('aligns the popup top with the span top when in view', () => {
    expect(computeCommentPopupPosition({ top: 300, bottom: 320 }, VH))
      .toEqual({ top: 300, hidden: false });
  });

  it('clamps the top so the card stays on screen near the bottom', () => {
    // span near the bottom: top would push the 300px card off-screen
    expect(computeCommentPopupPosition({ top: 780, bottom: 795 }, VH))
      .toEqual({ top: 500, hidden: false });
  });

  it('clamps the top to a small minimum near the top edge', () => {
    expect(computeCommentPopupPosition({ top: -5, bottom: 40 }, VH))
      .toEqual({ top: 8, hidden: false });
  });

  it('hides the popup when the span has scrolled above the viewport', () => {
    expect(computeCommentPopupPosition({ top: -120, bottom: -40 }, VH))
      .toEqual({ top: 8, hidden: true });
  });

  it('hides the popup when the span has scrolled below the viewport', () => {
    expect(computeCommentPopupPosition({ top: 900, bottom: 940 }, VH))
      .toEqual({ top: 500, hidden: true });
  });
});
