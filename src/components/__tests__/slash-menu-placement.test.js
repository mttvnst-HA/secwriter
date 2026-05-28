import { describe, it, expect } from 'vitest';
import { computePlacement, computeLeft } from '../SlashMenu.jsx';

describe('computePlacement', () => {
  const cases = [
    {
      name: 'fits below',
      anchorRect: { top: 100, bottom: 120 },
      viewportHeight: 800,
      menuHeight: 390,
      expected: { placement: 'below', maxHeight: null, top: 124 },
    },
    {
      name: 'fits above only',
      anchorRect: { top: 600, bottom: 620 },
      viewportHeight: 800,
      menuHeight: 390,
      expected: { placement: 'above', maxHeight: null, top: 206 },
    },
    {
      name: 'neither fits, more below',
      anchorRect: { top: 50, bottom: 70 },
      viewportHeight: 400,
      menuHeight: 390,
      expected: { placement: 'below', maxHeight: 322, top: 74 },
    },
    {
      name: 'neither fits, more above',
      anchorRect: { top: 350, bottom: 370 },
      viewportHeight: 400,
      menuHeight: 390,
      expected: { placement: 'above', maxHeight: 342, top: 8 },
    },
    {
      name: 'anchor at viewport top',
      anchorRect: { top: 0, bottom: 0 },
      viewportHeight: 800,
      menuHeight: 390,
      expected: { placement: 'below', maxHeight: null, top: 4 },
    },
    {
      name: 'anchor at viewport bottom',
      anchorRect: { top: 800, bottom: 800 },
      viewportHeight: 800,
      menuHeight: 390,
      expected: { placement: 'above', maxHeight: null, top: 406 },
    },
    {
      name: 'min maxHeight floor (degenerate)',
      anchorRect: { top: 50, bottom: 70 },
      viewportHeight: 100,
      menuHeight: 390,
      expected: { placement: 'above', maxHeight: 120, top: 8 },
    },
    {
      name: 'min maxHeight floor below branch',
      anchorRect: { top: 20, bottom: 40 },
      viewportHeight: 100,
      menuHeight: 390,
      expected: { placement: 'below', maxHeight: 120, top: 44 },
    },
  ];

  it.each(cases)('$name', ({ anchorRect, viewportHeight, menuHeight, expected }) => {
    const result = computePlacement({ anchorRect, viewportHeight, menuHeight, margin: 8 });
    expect(result).toEqual(expected);
  });
});

describe('computeLeft', () => {
  const cases = [
    { name: 'normal', anchorLeft: 100, expected: 100 },
    { name: 'would overflow right', anchorLeft: 1000, expected: 912 },
    { name: 'negative left clamps to margin', anchorLeft: -50, expected: 8 },
  ];

  it.each(cases)('$name', ({ anchorLeft, expected }) => {
    const result = computeLeft({
      anchorRect: { left: anchorLeft },
      menuWidth: 280,
      viewportWidth: 1200,
      margin: 8,
    });
    expect(result).toBe(expected);
  });
});
