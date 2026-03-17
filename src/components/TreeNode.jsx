import { useState } from "react";
import { ChevronRight, ChevronDown } from "lucide-react";

export default function TreeNode({ node, selectedId, onSelect, depth = 0, numberMap }) {
  const [expanded, setExpanded] = useState(node.depth <= 0);
  const [hovered, setHovered] = useState(false);
  const hasChildren = node.children && node.children.length > 0;
  const isSelected = selectedId === node.id;

  const isPart = node.text.startsWith("PART ");
  const isUpperCase = node.text === node.text.toUpperCase() && !isPart;
  const sectionNum = numberMap && numberMap[node.id];

  let bgColor = "transparent";
  if (isSelected) {
    bgColor = "rgba(99,132,168,0.25)";
  } else if (hovered) {
    bgColor = "rgba(99,132,168,0.1)";
  }

  return (
    <div>
      <div
        onClick={() => {
          onSelect(node.id);
          if (hasChildren) setExpanded(!expanded);
        }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 4,
          padding: "5px 8px",
          paddingLeft: depth * 16 + 8,
          cursor: "pointer",
          borderRadius: 4,
          fontSize: isPart ? 13 : isUpperCase ? 12 : 12,
          fontWeight: isPart ? 700 : isUpperCase ? 600 : 400,
          letterSpacing: isPart || isUpperCase ? "0.02em" : 0,
          color: isSelected ? "#f0f0f0" : isPart ? "#c8d6e5" : "#94a3b8",
          backgroundColor: bgColor,
          borderLeft: isSelected ? "2px solid #6384a8" : "2px solid transparent",
          transition: "all 0.15s ease",
        }}
      >
        {hasChildren ? (
          expanded ? <ChevronDown size={14} style={{ flexShrink: 0, opacity: 0.5 }} /> : <ChevronRight size={14} style={{ flexShrink: 0, opacity: 0.5 }} />
        ) : (
          <span style={{ width: 14, flexShrink: 0 }} />
        )}
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {sectionNum && <span style={{ opacity: 0.6, marginRight: 5, fontFamily: "'SF Mono', 'Consolas', monospace", fontSize: 11 }}>{sectionNum}</span>}
          {isPart ? node.text : node.text.replace(/^PART \d+\s*/, "")}
        </span>
      </div>
      {expanded && hasChildren && node.children.map(child => (
        <TreeNode key={child.id} node={child} selectedId={selectedId} onSelect={onSelect} depth={depth + 1} numberMap={numberMap} />
      ))}
    </div>
  );
}
