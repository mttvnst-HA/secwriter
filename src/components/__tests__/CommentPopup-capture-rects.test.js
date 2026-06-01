import { describe, it, expect } from 'vitest';
import { captureCommentRects, shouldShowCommentPopup } from '../CommentPopup.jsx';

// The all-popups layer auto-shows a popup for every OPEN comment, but resolved
// comments stay collapsed (issue #195 follow-up). A resolved comment still
// opens when it's the explicitly-focused one (clicked span) so it can be
// reopened.
describe('shouldShowCommentPopup', () => {
  const open = { id: 'a', status: 'open' };
  const resolved = { id: 'b', status: 'resolved' };

  it('shows an open comment regardless of focus', () => {
    expect(shouldShowCommentPopup(open, null)).toBe(true);
    expect(shouldShowCommentPopup(open, 'other')).toBe(true);
  });

  it('collapses a resolved comment that is not focused', () => {
    expect(shouldShowCommentPopup(resolved, null)).toBe(false);
    expect(shouldShowCommentPopup(resolved, 'other')).toBe(false);
  });

  it('shows a resolved comment when it is the focused (clicked) one', () => {
    expect(shouldShowCommentPopup(resolved, 'b')).toBe(true);
  });
});

// When the comment-highlight layer is on, App renders ONE popup per comment
// (issue #195 follow-up: all popups visible, persisting until the toggle is
// turned off). captureCommentRects builds the id→rect map the render walks,
// omitting any comment whose span isn't currently in the DOM so a popup never
// floats over a comment that isn't rendered.
describe('captureCommentRects', () => {
  it('maps each id to its span rect', () => {
    const rects = { a: { top: 10 }, b: { top: 20 }, c: { top: 30 } };
    const map = captureCommentRects(['a', 'b', 'c'], (id) => rects[id]);
    expect([...map.keys()]).toEqual(['a', 'b', 'c']);
    expect(map.get('b')).toEqual({ top: 20 });
  });

  it('omits ids whose span is not in the DOM (getRect returns null)', () => {
    const rects = { a: { top: 10 }, c: { top: 30 } };
    const map = captureCommentRects(['a', 'b', 'c'], (id) => rects[id] ?? null);
    expect([...map.keys()]).toEqual(['a', 'c']);
    expect(map.has('b')).toBe(false);
  });

  it('returns an empty map for no ids', () => {
    const map = captureCommentRects([], () => ({ top: 0 }));
    expect(map.size).toBe(0);
  });
});
