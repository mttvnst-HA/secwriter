// src/lib/menu-placement.js
/**
 * menu-placement.js — viewport placement math for pointer/caret-anchored
 * popups. Extracted verbatim from SlashMenu.jsx so SlashMenu and the new
 * ContextMenu share one implementation. No logic change.
 */

const ANCHOR_GAP = 4; // px between anchor edge and menu edge

export function computePlacement({ anchorRect, viewportHeight, menuHeight, margin }) {
  const spaceBelow = viewportHeight - anchorRect.bottom - margin;
  const spaceAbove = anchorRect.top - margin;

  if (menuHeight <= spaceBelow) {
    return { placement: 'below', maxHeight: null, top: anchorRect.bottom + ANCHOR_GAP };
  }
  if (menuHeight <= spaceAbove) {
    return { placement: 'above', maxHeight: null, top: anchorRect.top - menuHeight - ANCHOR_GAP };
  }
  if (spaceBelow >= spaceAbove) {
    return { placement: 'below', maxHeight: Math.max(spaceBelow, 120), top: anchorRect.bottom + ANCHOR_GAP };
  }
  return { placement: 'above', maxHeight: Math.max(spaceAbove, 120), top: margin };
}

export function computeLeft({ anchorRect, menuWidth, viewportWidth, margin }) {
  const desired = anchorRect.left;
  return Math.max(margin, Math.min(desired, viewportWidth - menuWidth - margin));
}
