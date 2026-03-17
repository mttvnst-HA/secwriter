import { useMemo } from "react";
import { detectPatterns } from "../lib/mark-patterns.js";

/**
 * MarkSuggestions - shows auto-detected pattern suggestions below a block.
 *
 * When the block contains text matching known patterns (ASTM standards,
 * section numbers, etc.) that aren't already marked, this component shows
 * small clickable pills. Clicking a pill wraps the matched text in the
 * appropriate mark span.
 *
 * Props:
 *   blockId   - ID of the block
 *   html      - The block's current HTML content
 *   onApply   - (blockId, newHtml) callback to update the block
 */
export default function MarkSuggestions({ blockId, html, onApply }) {
  const suggestions = useMemo(() => {
    if (!html) return [];
    // Strip HTML tags to get plain text for pattern matching
    const tmp = document.createElement("div");
    tmp.innerHTML = html;
    const text = tmp.textContent || "";
    return detectPatterns(text, html);
  }, [html]);

  if (suggestions.length === 0) return null;

  const handleApply = (suggestion) => {
    // Find the plain text match in the HTML and wrap it in a mark span
    // We need to be careful to only wrap text nodes, not existing tags
    const { text, cls } = suggestion;

    // Escape for use in regex
    const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    // Match the text but only if it's NOT already inside a mark span
    // Strategy: replace the first occurrence that isn't inside a span
    let newHtml = html;
    const re = new RegExp(`(?<!<span[^>]*>[^<]*)\\b(${escaped})\\b`, "");
    const simpleRe = new RegExp(`\\b${escaped}\\b`);

    // Check if we can find it outside of any span
    // Simple approach: temporarily remove all spans, find position, then apply
    const stripped = html.replace(/<span[^>]*>.*?<\/span>/g, (match) => "\x00".repeat(match.length));
    const pos = stripped.search(simpleRe);

    if (pos >= 0) {
      // Found the text outside of spans — wrap it
      const before = html.substring(0, pos);
      const match = html.substring(pos, pos + text.length);
      const after = html.substring(pos + text.length);
      newHtml = `${before}<span class="${cls}">${match}</span>${after}`;
      onApply(blockId, newHtml);
    }
  };

  const handleApplyAll = () => {
    let currentHtml = html;
    // Apply all suggestions in reverse order (right to left) to preserve positions
    const sorted = [...suggestions].sort((a, b) => b.start - a.start);
    for (const suggestion of sorted) {
      const { text, cls } = suggestion;
      const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const simpleRe = new RegExp(`\\b${escaped}\\b`);
      const stripped = currentHtml.replace(/<span[^>]*>.*?<\/span>/g, (m) => "\x00".repeat(m.length));
      const pos = stripped.search(simpleRe);
      if (pos >= 0) {
        const before = currentHtml.substring(0, pos);
        const match = currentHtml.substring(pos, pos + text.length);
        const after = currentHtml.substring(pos + text.length);
        currentHtml = `${before}<span class="${cls}">${match}</span>${after}`;
      }
    }
    onApply(blockId, currentHtml);
  };

  // Color map for pill backgrounds
  const COLORS = {
    rid: { bg: "#fae8ff", color: "#86198f", border: "#e879f9" },
    srf: { bg: "#f5d0fe", color: "#701a75", border: "#d946ef" },
    sub: { bg: "#dbeafe", color: "#1e40af", border: "#60a5fa" },
    eng: { bg: "#dbeafe", color: "#1d4ed8", border: "#60a5fa" },
    met: { bg: "#fee2e2", color: "#b91c1c", border: "#f87171" },
  };

  return (
    <div style={{
      display: "flex",
      flexWrap: "wrap",
      gap: 6,
      padding: "4px 12px 4px 48px",
      alignItems: "center",
    }}>
      <span style={{ fontSize: 10, color: "#94a3b8", fontWeight: 500, marginRight: 2 }}>
        Auto-detect:
      </span>
      {suggestions.map((s, i) => {
        const c = COLORS[s.type] || COLORS.rid;
        return (
          <button
            key={`${s.text}-${i}`}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => handleApply(s)}
            title={`Mark "${s.text}" as ${s.label}`}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              padding: "1px 8px",
              fontSize: 11,
              fontWeight: 500,
              color: c.color,
              backgroundColor: c.bg,
              border: `1px solid ${c.border}`,
              borderRadius: 12,
              cursor: "pointer",
              lineHeight: "18px",
              transition: "opacity 0.15s",
            }}
            onMouseEnter={(e) => e.target.style.opacity = "0.75"}
            onMouseLeave={(e) => e.target.style.opacity = "1"}
          >
            <span style={{ fontWeight: 600, fontSize: 10 }}>{s.label}</span>
            {s.text}
          </button>
        );
      })}
      {suggestions.length > 1 && (
        <button
          onMouseDown={(e) => e.preventDefault()}
          onClick={handleApplyAll}
          title="Mark all detected patterns"
          style={{
            padding: "1px 8px",
            fontSize: 10,
            fontWeight: 600,
            color: "#64748b",
            backgroundColor: "#f1f5f9",
            border: "1px solid #e2e8f0",
            borderRadius: 12,
            cursor: "pointer",
            lineHeight: "18px",
          }}
          onMouseEnter={(e) => e.target.style.backgroundColor = "#e2e8f0"}
          onMouseLeave={(e) => e.target.style.backgroundColor = "#f1f5f9"}
        >
          Mark all
        </button>
      )}
    </div>
  );
}
