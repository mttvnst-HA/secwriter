import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

export const SLASH_ITEMS = [
  { type: "title", label: "Heading", desc: "Section heading (Tab/Shift+Tab to change level)", icon: "H" },
  { type: "txt", label: "Paragraph", desc: "Plain text paragraph", icon: "¶" },
  { type: "note", label: "Designer Note", desc: "Note to the designer (not in published spec)", icon: "✉" },
  { type: "oli", label: "Ordered List", desc: "Lettered list item (a. b. c.)", icon: "a." },
  { type: "item", label: "List Item", desc: "Bulleted list item", icon: "•" },
  { type: "lst", label: "List Header", desc: "Submittal group header (e.g. SD-01)", icon: "☰" },
  { type: "ref", label: "Reference", desc: "Standards reference group (ORG + RID/RTL)", icon: "📚" },
  { type: "table", label: "Table", desc: "Data table with editable cells", icon: "▦" },
  { type: "pagebreak", label: "Page Break", desc: "Insert a page break for printing", icon: "┄" },
];

const ANCHOR_GAP = 4; // px between caret bottom/top and menu edge
const HEADER_HEIGHT = 26;
const ROW_HEIGHT = 50;
const MENU_WIDTH = 280;
const VIEWPORT_MARGIN = 8;

export function computePlacement({ anchorRect, viewportHeight, menuHeight, margin }) {
  const spaceBelow = viewportHeight - anchorRect.bottom - margin;
  const spaceAbove = anchorRect.top - margin;

  if (menuHeight <= spaceBelow) {
    return { placement: 'below', maxHeight: null, top: anchorRect.bottom + ANCHOR_GAP };
  }
  if (menuHeight <= spaceAbove) {
    return {
      placement: 'above',
      maxHeight: null,
      top: anchorRect.top - menuHeight - ANCHOR_GAP,
    };
  }
  if (spaceBelow >= spaceAbove) {
    return {
      placement: 'below',
      maxHeight: Math.max(spaceBelow, 120),
      top: anchorRect.bottom + ANCHOR_GAP,
    };
  }
  return {
    placement: 'above',
    maxHeight: Math.max(spaceAbove, 120),
    top: margin,
  };
}

export function computeLeft({ anchorRect, menuWidth, viewportWidth, margin }) {
  const desired = anchorRect.left;
  return Math.max(margin, Math.min(desired, viewportWidth - menuWidth - margin));
}

export default function SlashMenu({ filter, selectedIdx, onSelect, onClose, onHoverChange, anchorRect, readOnly = false }) {
  // IMPORTANT: All hook calls happen unconditionally. Conditional render moves to
  // the END of the function, after all hooks. The parent gates the component's
  // mount with `slashAnchorRect && ...`, but anchorRect can transiently become null
  // (e.g. PM view tear-down) — moving the guard below the hooks keeps Rules of
  // Hooks happy across those transitions.

  const [resizeTick, setResizeTick] = useState(0);
  const [placement, setPlacement] = useState({ top: 0, left: 0, maxHeight: null });
  const menuRef = useRef(null);
  const activeItemRef = useRef(null);

  const filtered = useMemo(() => SLASH_ITEMS.filter(item => {
    if (!filter) return true;
    const q = filter.toLowerCase();
    return item.label.toLowerCase().startsWith(q);
  }), [filter]);

  // Single source of truth for highlight: parent's selectedIdx. Mouse hover
  // routes through `onHoverChange` so the parent updates selectedIdx — that
  // way arrow keys increment from the hovered row, not from a stale value.
  // Without this, hover-on-row-3 + arrow-down used to jump highlight from 3
  // to (old selectedIdx + 1), which looked erratic to the user.
  const safeIdx = Math.min(selectedIdx, Math.max(filtered.length - 1, 0));
  const activeIdx = safeIdx;

  // Resize listener — bumps tick so the layout effect re-runs.
  useEffect(() => {
    const onResize = () => setResizeTick(t => t + 1);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // Close on any scroll OUTSIDE the menu. We listen with capture so scrolls in any
  // ancestor scroll container (window, the editor scroll wrapper, etc.) reposition
  // away from the anchor — but a scroll whose target is the menu itself means the
  // user is mouse-wheeling the menu's own scrollbar, which must NOT close.
  useEffect(() => {
    if (!onClose) return undefined;
    const onScroll = (e) => {
      const menu = menuRef.current;
      if (menu && e.target instanceof Node && menu.contains(e.target)) return;
      onClose();
    };
    window.addEventListener('scroll', onScroll, { passive: true, capture: true });
    return () => window.removeEventListener('scroll', onScroll, { capture: true });
  }, [onClose]);

  // Placement computation — runs whenever the anchor / filter / viewport changes.
  useLayoutEffect(() => {
    if (!anchorRect) return;
    const itemCount = Math.max(filtered.length, 1);
    const menuHeight = HEADER_HEIGHT + itemCount * ROW_HEIGHT;
    const p = computePlacement({
      anchorRect,
      viewportHeight: window.innerHeight,
      menuHeight,
      margin: VIEWPORT_MARGIN,
    });
    const left = computeLeft({
      anchorRect,
      menuWidth: MENU_WIDTH,
      viewportWidth: window.innerWidth,
      margin: VIEWPORT_MARGIN,
    });
    setPlacement({ top: p.top, left, maxHeight: p.maxHeight });
  }, [anchorRect, filtered.length, resizeTick]);

  // Keep the keyboard-active item visible when scrolling internally.
  // Guard with ?.scrollIntoView?.() — jsdom doesn't implement scrollIntoView.
  useEffect(() => {
    activeItemRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [safeIdx]);

  // Conditional render — AFTER all hooks (Rules of Hooks).
  if (readOnly || !anchorRect) return null;

  const menu = (
    <div
      ref={menuRef}
      id="sim-slash-listbox"
      role="listbox"
      aria-label="Insert block"
      style={{
        position: 'fixed',
        top: placement.top,
        left: placement.left,
        width: MENU_WIDTH,
        maxHeight: placement.maxHeight ?? undefined,
        overflowY: placement.maxHeight ? 'auto' : 'visible',
        // Sticky header occupies the top of the scroll container. Without
        // scrollPaddingTop, scrollIntoView({ block: 'nearest' }) places row 0
        // at scroll position 0 and the sticky header overlaps it. The browser
        // honors scroll-padding when computing the target scroll position.
        scrollPaddingTop: HEADER_HEIGHT,
        // Prevent wheel events at the menu's scroll boundary from chaining to the
        // document — without this, scrolling past the menu's top/bottom would
        // trigger a window scroll and immediately close the menu.
        overscrollBehavior: 'contain',
        zIndex: 1000,
        backgroundColor: '#ffffff',
        border: '1px solid #e2e8f0',
        borderRadius: 8,
        boxShadow: '0 8px 24px rgba(0,0,0,0.12), 0 2px 8px rgba(0,0,0,0.08)',
        padding: '4px 0',
      }}
    >
      <div
        aria-hidden="true"
        style={{
          position: 'sticky',
          top: 0,
          backgroundColor: '#ffffff',
          padding: '6px 12px 4px',
          fontSize: 10,
          color: '#94a3b8',
          fontWeight: 600,
          letterSpacing: '0.06em',
          textTransform: 'uppercase',
        }}
      >
        Insert block
      </div>
      {filtered.length === 0 ? (
        <div role="status" aria-live="polite" style={{ padding: '12px', color: '#94a3b8', fontStyle: 'italic', fontSize: 12 }}>
          No matches
        </div>
      ) : (
        filtered.map((item, i) => {
          const isActive = i === activeIdx;
          const isKeyboardSelected = i === safeIdx;
          return (
            <div
              key={item.type}
              id={`sim-slash-item-${i}`}
              role="option"
              aria-selected={isKeyboardSelected}
              tabIndex={-1}
              ref={isKeyboardSelected ? activeItemRef : null}
              onMouseDown={(e) => {
                e.preventDefault();
                onSelect(item.type);
              }}
              // onMouseMove (not onMouseEnter): when arrow nav triggers a
              // scrollIntoView, rows slide under a stationary cursor and the
              // browser fires mouseenter on each new row — that would steal
              // the highlight away from the keyboard. mousemove requires actual
              // cursor motion, so it ignores scroll-induced row changes.
              onMouseMove={() => { if (onHoverChange && safeIdx !== i) onHoverChange(i); }}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '7px 12px',
                cursor: 'pointer',
                backgroundColor: isActive ? '#f1f5f9' : 'transparent',
                borderLeft: isActive ? '2px solid #6384a8' : '2px solid transparent',
                transition: 'background 0.1s',
              }}
            >
              <span style={{
                width: 28,
                height: 28,
                borderRadius: 6,
                backgroundColor: '#f1f5f9',
                border: '1px solid #e2e8f0',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 14,
                fontWeight: 700,
                color: '#475569',
                flexShrink: 0,
              }}>
                {item.icon}
              </span>
              <div>
                <div style={{ fontSize: 13, fontWeight: 600, color: '#1e293b' }}>{item.label}</div>
                <div style={{ fontSize: 11, color: '#94a3b8' }}>{item.desc}</div>
              </div>
            </div>
          );
        })
      )}
    </div>
  );

  return createPortal(menu, document.body);
}
