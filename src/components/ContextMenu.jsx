// src/components/ContextMenu.jsx
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { computePlacement, computeLeft } from "../lib/menu-placement.js";

const MENU_WIDTH = 220;
const ROW_HEIGHT = 30;
const VIEWPORT_MARGIN = 8;

// Indices of the actionable (non-divider) items, in order.
function actionableIndices(items) {
  const out = [];
  items.forEach((it, i) => { if (!it.divider) out.push(i); });
  return out;
}

export default function ContextMenu({ items, anchor, onSelect, onClose }) {
  const menuRef = useRef(null);
  const [resizeTick, setResizeTick] = useState(0);
  // null until the layout effect computes a placement — avoids a one-frame
  // flash at the top-left corner before positioning runs.
  const [placement, setPlacement] = useState(null);
  // Highlight tracks an index into the FULL items array (dividers skipped by nav).
  const actionable = useMemo(() => actionableIndices(items), [items]);
  const [activeIdx, setActiveIdx] = useState(actionable[0] ?? -1);

  useEffect(() => { setActiveIdx(actionable[0] ?? -1); }, [actionable]);

  useEffect(() => {
    const onResize = () => setResizeTick(t => t + 1);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // Capture-phase dismiss: outside mousedown + outside scroll.
  useEffect(() => {
    if (!onClose) return undefined;
    const onDown = (e) => {
      const menu = menuRef.current;
      if (menu && e.target instanceof Node && menu.contains(e.target)) return;
      onClose();
    };
    const onScroll = (e) => {
      const menu = menuRef.current;
      if (menu && e.target instanceof Node && menu.contains(e.target)) return;
      onClose();
    };
    document.addEventListener('mousedown', onDown, true);
    window.addEventListener('scroll', onScroll, { passive: true, capture: true });
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('scroll', onScroll, { capture: true });
    };
  }, [onClose]);

  useLayoutEffect(() => {
    if (!anchor) return;
    const menuHeight = items.length * ROW_HEIGHT + 8;
    const anchorRect = { top: anchor.y, bottom: anchor.y, left: anchor.x };
    const p = computePlacement({ anchorRect, viewportHeight: window.innerHeight, menuHeight, margin: VIEWPORT_MARGIN });
    const left = computeLeft({ anchorRect, menuWidth: MENU_WIDTH, viewportWidth: window.innerWidth, margin: VIEWPORT_MARGIN });
    setPlacement({ top: p.top, left, maxHeight: p.maxHeight });
  }, [anchor, items.length, resizeTick]);

  const move = (dir) => {
    if (actionable.length === 0) return;
    const cur = actionable.indexOf(activeIdx);
    const next = cur < 0 ? 0 : (cur + dir + actionable.length) % actionable.length;
    setActiveIdx(actionable[next]);
  };

  const onKeyDown = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); onClose?.(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      const it = items[activeIdx];
      if (it && !it.divider) onSelect?.(it.id);
    }
  };

  // Focus the menu once it actually renders (placement !== null) so it
  // receives the keydowns. A plain []-deps effect would fire on the first
  // (null-placement) commit when the menu DOM does not exist yet.
  const hasFocusedRef = useRef(false);
  useEffect(() => {
    if (placement && !hasFocusedRef.current) {
      hasFocusedRef.current = true;
      menuRef.current?.focus?.();
    }
    return () => { hasFocusedRef.current = false; };
  }, [placement]);

  if (!anchor || items.length === 0 || !placement) return null;

  const menu = (
    <div
      ref={menuRef}
      role="menu"
      aria-label="Editor actions"
      tabIndex={-1}
      onKeyDown={onKeyDown}
      style={{
        position: 'fixed',
        top: placement.top,
        left: placement.left,
        width: MENU_WIDTH,
        maxHeight: placement.maxHeight ?? undefined,
        overflowY: placement.maxHeight ? 'auto' : 'visible',
        overscrollBehavior: 'contain',
        zIndex: 1000,
        backgroundColor: '#ffffff',
        border: '1px solid #e2e8f0',
        borderRadius: 8,
        boxShadow: '0 8px 24px rgba(0,0,0,0.12), 0 2px 8px rgba(0,0,0,0.08)',
        padding: '4px 0',
        outline: 'none',
        fontSize: 13,
        color: '#1e293b',
      }}
    >
      {items.map((it, i) => {
        if (it.divider) {
          return <div key={`d${i}`} aria-hidden="true" style={{ borderTop: '1px solid #eef2f7', margin: '4px 0' }} />;
        }
        const isActive = i === activeIdx;
        return (
          <div
            key={it.id}
            role="menuitem"
            tabIndex={-1}
            onMouseDown={(e) => { e.preventDefault(); onSelect?.(it.id); }}
            onMouseMove={() => { if (activeIdx !== i) setActiveIdx(i); }}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: '5px 12px',
              cursor: 'pointer',
              backgroundColor: isActive ? '#f1f5f9' : 'transparent',
            }}
          >
            <span style={{ width: 18, textAlign: 'center', flexShrink: 0 }}>{it.icon}</span>
            <span>{it.label}</span>
          </div>
        );
      })}
    </div>
  );

  return createPortal(menu, document.body);
}
