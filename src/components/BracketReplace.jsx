import { useState, useMemo, useRef, useEffect } from "react";
import { findBrackets, groupBrackets } from "../lib/bracket-replace.js";
import { NO_EXFIL_PROPS } from "../lib/no-exfil.js";

export default function BracketReplace({ blocks, onReplace, onClose }) {
  const [replacements, setReplacements] = useState({}); // { innerText: replacementValue }
  const scrollRef = useRef(null);

  const brackets = useMemo(() => findBrackets(blocks), [blocks]);
  const groups = useMemo(() => groupBrackets(brackets), [brackets]);
  const groupList = useMemo(() => [...groups.values()].sort((a, b) => b.count - a.count), [groups]);

  // Scroll first entry into view in the editor when clicking
  const scrollToFirst = (entries) => {
    if (entries.length === 0) return;
    const first = entries[0];
    const el = document.getElementById(`block-${first.blockId}`);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
  };

  const handleReplace = (group) => {
    const value = replacements[group.innerText];
    if (value === undefined || value === '') return;
    // Replace in reverse offset order within each block to preserve positions
    const byBlock = new Map();
    for (const entry of group.entries) {
      if (!byBlock.has(entry.blockId)) byBlock.set(entry.blockId, []);
      byBlock.get(entry.blockId).push(entry);
    }
    for (const [blockId, entries] of byBlock) {
      const sorted = [...entries].sort((a, b) => b.offset - a.offset);
      for (const entry of sorted) {
        onReplace(blockId, entry.offset, entry.length, value);
      }
    }
    // Clear the replacement value
    setReplacements(prev => {
      const next = { ...prev };
      delete next[group.innerText];
      return next;
    });
  };

  const handleReplaceAll = () => {
    for (const group of groupList) {
      const value = replacements[group.innerText];
      if (value === undefined || value === '') continue;
      const byBlock = new Map();
      for (const entry of group.entries) {
        if (!byBlock.has(entry.blockId)) byBlock.set(entry.blockId, []);
        byBlock.get(entry.blockId).push(entry);
      }
      for (const [blockId, entries] of byBlock) {
        const sorted = [...entries].sort((a, b) => b.offset - a.offset);
        for (const entry of sorted) {
          onReplace(blockId, entry.offset, entry.length, value);
        }
      }
    }
    setReplacements({});
  };

  if (brackets.length === 0) {
    return (
      <div style={{
        padding: "8px 16px", borderBottom: "1px solid #e2e8f0",
        backgroundColor: "#f8fafc", fontSize: 13, display: "flex",
        alignItems: "center", gap: 8,
      }}>
        <span style={{ color: "#64748b" }}>No [bracketed] placeholders found in the document.</span>
        <button onClick={onClose} style={{
          marginLeft: "auto", border: "none", background: "transparent",
          color: "#94a3b8", fontSize: 16, cursor: "pointer",
        }}>&#x2715;</button>
      </div>
    );
  }

  const filledCount = groupList.filter(g => replacements[g.innerText]?.length > 0).length;

  return (
    <div style={{
      borderBottom: "1px solid #e2e8f0", backgroundColor: "#f8fafc", fontSize: 13,
    }}>
      {/* Header */}
      <div style={{
        padding: "6px 16px", display: "flex", alignItems: "center", gap: 8,
        borderBottom: "1px solid #e2e8f0",
      }}>
        <span style={{ fontWeight: 600, color: "#334155" }}>
          Bracket Replacement
        </span>
        <span style={{ color: "#64748b", fontSize: 12 }}>
          {brackets.length} placeholder{brackets.length !== 1 ? 's' : ''} in {groupList.length} group{groupList.length !== 1 ? 's' : ''}
        </span>
        <div style={{ flex: 1 }} />
        {filledCount > 0 && (
          <button onClick={handleReplaceAll} style={{
            border: "1px solid #16a34a", borderRadius: 4, backgroundColor: "#f0fdf4",
            color: "#16a34a", fontSize: 12, padding: "3px 10px", cursor: "pointer",
            fontWeight: 600,
          }}>Replace All Filled ({filledCount})</button>
        )}
        <button onClick={onClose} style={{
          border: "none", background: "transparent", color: "#94a3b8",
          fontSize: 16, cursor: "pointer", padding: "0 4px",
        }}>&#x2715;</button>
      </div>

      {/* Scrollable list */}
      <div ref={scrollRef} style={{
        maxHeight: 200, overflowY: "auto", padding: "4px 16px",
      }}>
        {groupList.map((group) => (
          <div key={group.innerText} style={{
            display: "flex", alignItems: "center", gap: 8, padding: "3px 0",
            borderBottom: "1px solid #f1f5f9",
          }}>
            <span
              onClick={() => scrollToFirst(group.entries)}
              title={`Click to scroll to first occurrence (${group.count} total)`}
              style={{
                fontFamily: "'SF Mono', Consolas, monospace", fontSize: 12,
                color: "#7c3aed", backgroundColor: "#f5f3ff", padding: "2px 6px",
                borderRadius: 3, cursor: "pointer", minWidth: 120, maxWidth: 220,
                overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
              }}
            >[{group.innerText}]</span>
            <span style={{ color: "#94a3b8", fontSize: 11, minWidth: 20 }}>
              ×{group.count}
            </span>
            <input
              type="text"
              value={replacements[group.innerText] || ''}
              onChange={(e) => setReplacements(prev => ({ ...prev, [group.innerText]: e.target.value }))}
              placeholder="Replacement value..."
              {...NO_EXFIL_PROPS}
              style={{
                flex: 1, maxWidth: 200, border: "1px solid #cbd5e1",
                borderRadius: 4, padding: "3px 8px", fontSize: 12, outline: "none",
              }}
            />
            <button
              onClick={() => handleReplace(group)}
              disabled={!replacements[group.innerText]?.length}
              title="Replace all occurrences of this bracket"
              style={{
                border: "1px solid #cbd5e1", borderRadius: 4, backgroundColor: "white",
                color: "#475569", fontSize: 12, padding: "3px 8px", cursor: "pointer",
                opacity: replacements[group.innerText]?.length ? 1 : 0.4,
              }}
            >Replace</button>
          </div>
        ))}
      </div>
    </div>
  );
}
