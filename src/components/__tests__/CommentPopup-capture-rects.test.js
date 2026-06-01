import { describe, it, expect } from 'vitest';
import { captureCommentRects } from '../CommentPopup.jsx';

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
