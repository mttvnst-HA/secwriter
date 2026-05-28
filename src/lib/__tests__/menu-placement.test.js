import { describe, it, expect } from 'vitest';
import { computePlacement, computeLeft } from '../menu-placement.js';

describe('computePlacement', () => {
  it('places below when there is room', () => {
    const r = computePlacement({
      anchorRect: { top: 100, bottom: 120 },
      viewportHeight: 800, menuHeight: 200, margin: 8,
    });
    expect(r.placement).toBe('below');
    expect(r.top).toBe(124); // bottom + ANCHOR_GAP(4)
    expect(r.maxHeight).toBeNull();
  });

  it('places above when below lacks room but above has it', () => {
    const r = computePlacement({
      anchorRect: { top: 700, bottom: 720 },
      viewportHeight: 800, menuHeight: 200, margin: 8,
    });
    expect(r.placement).toBe('above');
    expect(r.top).toBe(700 - 200 - 4);
  });

  it('clamps with maxHeight when neither side fits', () => {
    const r = computePlacement({
      anchorRect: { top: 300, bottom: 320 },
      viewportHeight: 600, menuHeight: 5000, margin: 8,
    });
    expect(['above', 'below']).toContain(r.placement);
    expect(r.maxHeight).toBeGreaterThan(0);
  });
});

describe('computeLeft', () => {
  it('returns the anchor left when it fits', () => {
    expect(computeLeft({ anchorRect: { left: 50 }, menuWidth: 280, viewportWidth: 1000, margin: 8 })).toBe(50);
  });
  it('clamps to the right viewport edge', () => {
    expect(computeLeft({ anchorRect: { left: 990 }, menuWidth: 280, viewportWidth: 1000, margin: 8 })).toBe(1000 - 280 - 8);
  });
  it('clamps to the left margin', () => {
    expect(computeLeft({ anchorRect: { left: -50 }, menuWidth: 280, viewportWidth: 1000, margin: 8 })).toBe(8);
  });
});
