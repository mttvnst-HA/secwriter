import { useLayoutEffect, useMemo, useRef, useState } from "react";

export const SLASH_ITEMS = [
  { type: "title", label: "Heading", desc: "Section heading (Tab/Shift+Tab to change level)", icon: "H" },
  { type: "txt", label: "Paragraph", desc: "Plain text paragraph", icon: "\u00b6" },
  { type: "note", label: "Designer Note", desc: "Note to the designer (not in published spec)", icon: "\u2709" },
  { type: "oli", label: "Ordered List", desc: "Lettered list item (a. b. c.)", icon: "a." },
  { type: "item", label: "List Item", desc: "Bulleted list item", icon: "\u2022" },
  { type: "lst", label: "List Header", desc: "Submittal group header (e.g. SD-01)", icon: "\u2630" },
  { type: "ref", label: "Reference", desc: "Standards reference group (ORG + RID/RTL)", icon: "\uD83D\uDCDA" },
  { type: "table", label: "Table", desc: "Data table with editable cells", icon: "\u25A6" },
  { type: "pagebreak", label: "Page Break", desc: "Insert a page break for printing", icon: "\u2504" },
];

export default function SlashMenu({ filter, selectedIdx, onSelect, position }) {
  const [hoverIdx, setHoverIdx] = useState(-1);
  const [flipped, setFlipped] = useState(false);
  const menuRef = useRef(null);

  const filtered = useMemo(() => SLASH_ITEMS.filter(item => {
    if (!filter) return true;
    const q = filter.toLowerCase();
    return item.label.toLowerCase().startsWith(q);
  }), [filter]);

  // Check if menu overflows viewport and flip above if needed
  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const viewportHeight = window.innerHeight;
    const margin = 8;
    setFlipped(rect.bottom > viewportHeight - margin);
  }, [filtered.length]);

  if (filtered.length === 0) return null;

  const safeIdx = Math.min(selectedIdx, filtered.length - 1);
  // Hover takes visual priority over keyboard selection
  const activeIdx = hoverIdx >= 0 ? hoverIdx : safeIdx;

  return (
    <div
      ref={menuRef}
      style={{
        position: "absolute",
        left: position.left || 15,
        ...(flipped
          ? { bottom: position.top || 28 }
          : { top: position.top || 28 }),
        zIndex: 1000,
        backgroundColor: "#ffffff",
        border: "1px solid #e2e8f0",
        borderRadius: 8,
        boxShadow: "0 8px 24px rgba(0,0,0,0.12), 0 2px 8px rgba(0,0,0,0.08)",
        width: 280,
        padding: "4px 0",
        overflow: "hidden",
      }}
      onMouseLeave={() => setHoverIdx(-1)}
    >
      <div style={{ padding: "6px 12px 4px", fontSize: 10, color: "#94a3b8", fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase" }}>
        Insert block
      </div>
      {filtered.map((item, i) => {
        const isActive = i === activeIdx;
        return (
          <div
            key={item.type}
            onMouseDown={(e) => {
              e.preventDefault();
              onSelect(item.type);
            }}
            onMouseEnter={() => setHoverIdx(i)}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "7px 12px",
              cursor: "pointer",
              backgroundColor: isActive ? "#f1f5f9" : "transparent",
              borderLeft: isActive ? "2px solid #6384a8" : "2px solid transparent",
              transition: "background 0.1s",
            }}
          >
            <span style={{
              width: 28,
              height: 28,
              borderRadius: 6,
              backgroundColor: "#f1f5f9",
              border: "1px solid #e2e8f0",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 14,
              fontWeight: 700,
              color: "#475569",
              flexShrink: 0,
            }}>
              {item.icon}
            </span>
            <div>
              <div style={{ fontSize: 13, fontWeight: 600, color: "#1e293b" }}>{item.label}</div>
              <div style={{ fontSize: 11, color: "#94a3b8" }}>{item.desc}</div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
