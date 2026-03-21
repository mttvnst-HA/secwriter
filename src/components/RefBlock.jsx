import { useState, useCallback } from "react";
import { BLOCK_MARGINS } from "../lib/ini-config.js";

function RefBlock({ block, onUpdate, isFocused, onFocus, onAcceptRevision, onRejectRevision, onCommentClick }) {
  const ref = block.ref || { org: '', entries: [] };
  const [editingOrg, setEditingOrg] = useState(false);
  const [editingIdx, setEditingIdx] = useState(-1);
  const [orgDraft, setOrgDraft] = useState('');
  const [ridDraft, setRidDraft] = useState('');
  const [rtlDraft, setRtlDraft] = useState('');

  const updateRef = useCallback((newRef) => {
    onUpdate(block.id, { ref: newRef });
  }, [block.id, onUpdate]);

  // ─── ORG editing ───
  function startEditOrg() {
    setOrgDraft(ref.org);
    setEditingOrg(true);
    setEditingIdx(-1);
  }

  function saveOrg() {
    updateRef({ ...ref, org: orgDraft.trim() });
    setEditingOrg(false);
  }

  function cancelOrg() {
    setEditingOrg(false);
  }

  // ─── Entry editing ───
  function startEditEntry(idx) {
    setRidDraft(ref.entries[idx].rid);
    setRtlDraft(ref.entries[idx].rtl);
    setEditingIdx(idx);
    setEditingOrg(false);
  }

  function saveEntry() {
    if (editingIdx < 0) return;
    const newEntries = [...ref.entries];
    newEntries[editingIdx] = { rid: ridDraft.trim(), rtl: rtlDraft.trim() };
    updateRef({ ...ref, entries: newEntries });
    setEditingIdx(-1);
  }

  function cancelEntry() {
    // If adding a new entry and both fields are empty, remove it
    if (editingIdx >= 0) {
      const entry = ref.entries[editingIdx];
      if (!entry.rid && !entry.rtl && !ridDraft.trim() && !rtlDraft.trim()) {
        deleteEntry(editingIdx);
        setEditingIdx(-1);
        return;
      }
    }
    setEditingIdx(-1);
  }

  function deleteEntry(idx) {
    const newEntries = ref.entries.filter((_, i) => i !== idx);
    updateRef({ ...ref, entries: newEntries });
    if (editingIdx === idx) setEditingIdx(-1);
  }

  function addEntry() {
    const newEntries = [...ref.entries, { rid: '', rtl: '' }];
    updateRef({ ...ref, entries: newEntries });
    // Start editing the new entry
    setRidDraft('');
    setRtlDraft('');
    setEditingIdx(newEntries.length - 1);
    setEditingOrg(false);
  }

  function handleEntryKeyDown(e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      saveEntry();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancelEntry();
    }
  }

  function handleOrgKeyDown(e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      saveOrg();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancelOrg();
    }
  }

  const revisionClass = block.revision ? `block-revision-${block.revision}` : '';
  const leftMargin = BLOCK_MARGINS['txt'] || 15;

  return (
    <div
      id={`block-${block.id}`}
      style={{ position: "relative" }}
      className={revisionClass}
      data-block-id={block.id}
      tabIndex={0}
      onClick={(e) => {
        // Check if user clicked a comment highlight
        const commentEl = e.target.closest?.('span.mark-comment');
        if (commentEl && onCommentClick) {
          e.stopPropagation();
          const commentId = commentEl.getAttribute('data-comment-id');
          if (commentId) {
            onCommentClick(commentId, commentEl.getBoundingClientRect());
          }
          return;
        }
        onFocus(block.id);
      }}
    >
      {/* Block-level revision accept/reject gutter buttons */}
      {block.revision && onAcceptRevision && (
        <div style={{
          position: "absolute",
          left: -4,
          top: 4,
          display: "flex",
          flexDirection: "column",
          gap: 2,
          zIndex: 10,
        }}>
          <button
            onClick={(e) => { e.stopPropagation(); onAcceptRevision(block.id); }}
            title={`Accept ${block.revision}`}
            style={{
              width: 18, height: 18,
              border: "1px solid #00800040", borderRadius: 3,
              backgroundColor: "#f0fdf4", color: "#008000",
              fontSize: 11, cursor: "pointer",
              display: "flex", alignItems: "center", justifyContent: "center",
              padding: 0, lineHeight: 1,
            }}
          >✓</button>
          <button
            onClick={(e) => { e.stopPropagation(); onRejectRevision(block.id); }}
            title={`Reject ${block.revision}`}
            style={{
              width: 18, height: 18,
              border: "1px solid #ff444440", borderRadius: 3,
              backgroundColor: "#fef2f2", color: "#ff4444",
              fontSize: 11, cursor: "pointer",
              display: "flex", alignItems: "center", justifyContent: "center",
              padding: 0, lineHeight: 1,
            }}
          >✗</button>
        </div>
      )}

      <div className="ref-block" style={{
        marginLeft: leftMargin,
        marginBottom: 8,
        border: isFocused ? "1px solid #cbd5e1" : "1px solid transparent",
        borderRadius: 4,
        boxShadow: isFocused ? "0 0 0 2px rgba(99,132,168,0.15)" : "none",
        transition: "border 0.15s, box-shadow 0.15s",
        padding: "4px 0",
      }}>
        {/* ORG Header */}
        {editingOrg ? (
          <div style={{ padding: "6px 12px" }}>
            <input
              autoFocus
              value={orgDraft}
              onChange={e => setOrgDraft(e.target.value)}
              onKeyDown={handleOrgKeyDown}
              onBlur={saveOrg}
              placeholder="Organization name (e.g. ASTM INTERNATIONAL)"
              style={{
                width: "100%", fontSize: 14, fontWeight: 700,
                border: "1px solid #cbd5e1", borderRadius: 3,
                padding: "4px 8px", outline: "none",
                color: "#1e293b",
              }}
            />
          </div>
        ) : (
          <div
            className="ref-org"
            style={{
              fontWeight: 700, fontSize: 14, color: "#1e293b",
              padding: "6px 12px", cursor: "pointer",
              display: "flex", alignItems: "center", gap: 8,
            }}
            onDoubleClick={startEditOrg}
          >
            <span style={{ flex: 1 }}>{ref.org || <span style={{ color: "#94a3b8", fontStyle: "italic", fontWeight: 400 }}>Double-click to set organization</span>}</span>
            <button
              onClick={(e) => { e.stopPropagation(); startEditOrg(); }}
              className="ref-action-btn"
              title="Edit organization"
              style={{
                opacity: 0.3, transition: "opacity 0.15s",
                border: "none", background: "transparent",
                cursor: "pointer", fontSize: 16, color: "#64748b",
                padding: "4px 6px", minWidth: 32, minHeight: 32,
              }}
            >✏️</button>
          </div>
        )}

        {/* RID/RTL Entries */}
        {ref.entries.map((entry, idx) => (
          editingIdx === idx ? (
            <div key={idx} className="ref-entry" style={{
              display: "flex", gap: 8, padding: "4px 12px",
              alignItems: "center",
            }}>
              <input
                autoFocus
                value={ridDraft}
                onChange={e => setRidDraft(e.target.value)}
                onKeyDown={handleEntryKeyDown}
                placeholder="RID (e.g. ASTM C33)"
                style={{
                  width: 180, fontSize: 13,
                  border: "1px solid #cbd5e1", borderRadius: 3,
                  padding: "3px 6px", outline: "none",
                  fontFamily: "'SF Mono', Consolas, monospace",
                  color: "#86198f",
                }}
              />
              <input
                value={rtlDraft}
                onChange={e => setRtlDraft(e.target.value)}
                onKeyDown={handleEntryKeyDown}
                onBlur={saveEntry}
                placeholder="Title/description"
                style={{
                  flex: 1, fontSize: 13,
                  border: "1px solid #cbd5e1", borderRadius: 3,
                  padding: "3px 6px", outline: "none",
                  color: "#334155",
                }}
              />
              <button
                onMouseDown={(e) => { e.preventDefault(); saveEntry(); }}
                style={{
                  border: "none", background: "#f0fdf4",
                  color: "#008000", cursor: "pointer",
                  fontSize: 12, padding: "2px 6px", borderRadius: 3,
                }}
              >✓</button>
              <button
                onMouseDown={(e) => { e.preventDefault(); cancelEntry(); }}
                style={{
                  border: "none", background: "#fef2f2",
                  color: "#ff4444", cursor: "pointer",
                  fontSize: 12, padding: "2px 6px", borderRadius: 3,
                }}
              >✗</button>
            </div>
          ) : (
            <div key={idx} className="ref-entry" style={{
              display: "flex", gap: 12, padding: "4px 12px",
              alignItems: "baseline", cursor: "pointer",
            }}
              onDoubleClick={() => startEditEntry(idx)}
            >
              <span className="mark-rid" style={{ flexShrink: 0 }}>
                {entry.rid || '???'}
              </span>
              <span className="ref-rtl" style={{
                color: "#334155", fontSize: 14, flex: 1, lineHeight: "1.65",
              }}>
                {entry.rtl}
              </span>
              <button
                onClick={(e) => { e.stopPropagation(); startEditEntry(idx); }}
                className="ref-action-btn"
                title="Edit reference"
                style={{
                  opacity: 0.3, transition: "opacity 0.15s",
                  border: "none", background: "transparent",
                  cursor: "pointer", fontSize: 16, color: "#64748b",
                  padding: "4px 6px", minWidth: 32, minHeight: 32,
                }}
              >✏️</button>
              <button
                onClick={(e) => { e.stopPropagation(); deleteEntry(idx); }}
                className="ref-action-btn"
                title="Delete reference"
                style={{
                  opacity: 0.3, transition: "opacity 0.15s",
                  border: "none", background: "transparent",
                  cursor: "pointer", fontSize: 16, color: "#ef4444",
                  padding: "4px 6px", minWidth: 32, minHeight: 32,
                }}
              >🗑</button>
            </div>
          )
        ))}

        {/* Add Reference button */}
        <div
          className="ref-add-btn"
          onClick={addEntry}
          style={{
            fontSize: 12, color: "#6384a8", cursor: "pointer",
            padding: "4px 12px", marginTop: 2,
          }}
        >
          ＋ Add Reference
        </div>
      </div>
    </div>
  );
}

export default RefBlock;
