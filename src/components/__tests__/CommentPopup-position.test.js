import { describe, it, expect } from 'vitest';
import { computeCommentPopupPosition } from '../CommentPopup.jsx';

// The popup must stay within the editor text pane — below the toolbar/ribbon
// (paneTop) and above the bottom status bar (paneBottom) — not the full
// window. Signature: computeCommentPopupPosition(rect, paneTop, paneBottom).
describe('computeCommentPopupPosition', () => {
  const PANE_TOP = 100;     // ribbon bottom edge
  const PANE_BOTTOM = 800;  // status-bar top edge
  // POPUP_CARD_HEIGHT = 300 → maxTop = 800 - 300 = 500

  it('falls back to a fixed top when no rect is given', () => {
    expect(computeCommentPopupPosition(null, PANE_TOP, PANE_BOTTOM))
      .toEqual({ top: 200, hidden: false });
  });

  it('aligns the popup top with the span top when in view', () => {
    expect(computeCommentPopupPosition({ top: 300, bottom: 320 }, PANE_TOP, PANE_BOTTOM))
      .toEqual({ top: 300, hidden: false });
  });

  it('clamps the top so the card stays above the pane bottom', () => {
    // span near the pane bottom: top would push the 300px card past paneBottom
    expect(computeCommentPopupPosition({ top: 780, bottom: 795 }, PANE_TOP, PANE_BOTTOM))
      .toEqual({ top: 500, hidden: false });
  });

  it('clamps the top to the pane top, never over the ribbon', () => {
    // span partially under the ribbon but still in the pane → pin at paneTop,
    // NOT at the window top (8) which would float the card over the ribbon.
    expect(computeCommentPopupPosition({ top: 40, bottom: 140 }, PANE_TOP, PANE_BOTTOM))
      .toEqual({ top: 100, hidden: false });
  });

  it('hides the popup when the span has scrolled above the pane top (under the ribbon)', () => {
    // span fully above paneTop → hidden, not floating in the ribbon.
    expect(computeCommentPopupPosition({ top: 20, bottom: 90 }, PANE_TOP, PANE_BOTTOM))
      .toEqual({ top: 100, hidden: true });
  });

  it('hides the popup when the span has scrolled below the pane bottom', () => {
    expect(computeCommentPopupPosition({ top: 820, bottom: 860 }, PANE_TOP, PANE_BOTTOM))
      .toEqual({ top: 500, hidden: true });
  });

  it('stays aligned with a span near the pane bottom using the measured card height', () => {
    // A short card (150px) reserves less room → maxTop = 800 - 150 = 650, so a
    // span at top=620 keeps the card aligned with it instead of jumping up to
    // the 300px-reservation clamp (500).
    expect(computeCommentPopupPosition({ top: 620, bottom: 640 }, PANE_TOP, PANE_BOTTOM, 150))
      .toEqual({ top: 620, hidden: false });
  });

  it('still clamps a short card so its bottom rests above the pane bottom', () => {
    // span very low (top=720) with a 150px card → 720 + 150 = 870 > 800 → clamp
    // to paneBottom - cardHeight = 650 (card bottom at 800, as low as it goes).
    expect(computeCommentPopupPosition({ top: 720, bottom: 740 }, PANE_TOP, PANE_BOTTOM, 150))
      .toEqual({ top: 650, hidden: false });
  });
});
