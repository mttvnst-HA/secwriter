import { useState, useCallback } from "react";
import { ChevronRight, ChevronDown } from "lucide-react";

export default function TreeNode({ node, selectedId, onSelect, depth = 0, numberMap, forceExpand = false, onReorder }) {
  const [expanded, setExpanded] = useState(node.depth <= 0);
  const [hovered, setHovered] = useState(false);
  const [dropPosition, setDropPosition] = useState(null); // "before" | "after" | null
  const hasChildren = node.children && node.children.length > 0;
  const isSelected = selectedId === node.id;
  const isExpanded = forceExpand || expanded;

  const isPart = node.text.startsWith("PART ");
  const isUpperCase = node.text === node.text.toUpperCase() && !isPart;
  const sectionNum = numberMap && numberMap[node.id];

  let bgColor = "transparent";
  if (isSelected) {
    bgColor = "rgba(99,132,168,0.25)";
  } else if (hovered) {
    bgColor = "rgba(99,132,168,0.1)";
  }

  const handleDragStart = useCallback((e) => {
    e.dataTransfer.setData("text/plain", node.id);
    e.dataTransfer.effectAllowed = "move";
    e.currentTarget.style.opacity = "0.4";
  }, [node.id]);

  const handleDragEnd = useCallback((e) => {
    e.currentTarget.style.opacity = "1";
    setDropPosition(null);
  }, []);

  const handleDragOver = useCallback((e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const rect = e.currentTarget.getBoundingClientRect();
    const midY = rect.top + rect.height / 2;
    setDropPosition(e.clientY < midY ? "before" : "after");
  }, []);

  const handleDragLeave = useCallback(() => {
    setDropPosition(null);
  }, []);

  const handleDrop = useCallback((e) => {
    e.preventDefault();
    const dragId = e.dataTransfer.getData("text/plain");
    if (dragId && dragId !== node.id && onReorder) {
      const rect = e.currentTarget.getBoundingClientRect();
      const midY = rect.top + rect.height / 2;
      const pos = e.clientY < midY ? "before" : "after";
      onReorder(dragId, node.id, pos);
    }
    setDropPosition(null);
  }, [node.id, onReorder]);

  const dropIndicatorStyle = dropPosition ? {
    position: "absolute",
    left: 0,
    right: 0,
    height: 2,
    backgroundColor: "#3b82f6",
    ...(dropPosition === "before" ? { top: 0 } : { bottom: 0 }),
  } : null;

  return (
    <div>
      <div
        draggable={!!onReorder}
        onDragStart={onReorder ? handleDragStart : undefined}
        onDragEnd={onReorder ? handleDragEnd : undefined}
        onDragOver={onReorder ? handleDragOver : undefined}
        onDragLeave={onReorder ? handleDragLeave : undefined}
        onDrop={onReorder ? handleDrop : undefined}
        onClick={() => {
          onSelect(node.id);
          if (hasChildren) setExpanded(!expanded);
        }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => { setHovered(false); setDropPosition(null); }}
        style={{
          position: "relative",
          display: "flex",
          alignItems: "center",
          gap: 4,
          padding: "5px 8px",
          paddingLeft: depth * 16 + 8,
          cursor: onReorder ? "grab" : "pointer",
          borderRadius: 4,
          fontSize: isPart ? 14 : isUpperCase ? 13 : 13,
          fontWeight: isPart ? 700 : isUpperCase ? 600 : 400,
          letterSpacing: isPart || isUpperCase ? "0.02em" : 0,
          color: isSelected ? "#f0f0f0" : isPart ? "#e2e8f0" : "#cbd5e1",
          backgroundColor: bgColor,
          borderLeft: isSelected ? "2px solid #6384a8" : "2px solid transparent",
          transition: "all 0.15s ease",
        }}
      >
        {dropIndicatorStyle && <div style={dropIndicatorStyle} />}
        {hasChildren ? (
          isExpanded ? <ChevronDown size={14} style={{ flexShrink: 0, opacity: 0.5 }} /> : <ChevronRight size={14} style={{ flexShrink: 0, opacity: 0.5 }} />
        ) : (
          <span style={{ width: 14, flexShrink: 0 }} />
        )}
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {sectionNum && <span style={{ opacity: 0.75, marginRight: 5, fontFamily: "'SF Mono', 'Consolas', monospace", fontSize: 12 }}>{sectionNum}</span>}
          {isPart ? node.text : node.text.replace(/^PART \d+\s*/, "")}
        </span>
      </div>
      {isExpanded && hasChildren && node.children.map(child => (
        <TreeNode key={child.id} node={child} selectedId={selectedId} onSelect={onSelect} depth={depth + 1} numberMap={numberMap} forceExpand={forceExpand} onReorder={onReorder} />
      ))}
    </div>
  );
}
