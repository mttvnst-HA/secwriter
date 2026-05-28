import { useMemo } from "react";
import { countRevisions } from "../lib/revisions.js";

/**
 * Compact toolbar row for tracked changes controls.
 * - Track Changes toggle (on/off)
 * - Show Revisions toggle (eye icon)
 * - Accept All / Reject All buttons
 * - Revision stats display
 */
export default function RevisionControls({
  trackChanges,
  onTrackChangesChange,
  showRevisions,
  onShowRevisionsChange,
  showNotes,
  onShowNotesChange,
  unitDisplay,
  onUnitDisplayChange,
  blocks,
  onAcceptAll,
  onRejectAll,
}) {
  const stats = useMemo(() => countRevisions(blocks), [blocks]);
  const totalRevisions = stats.adds + stats.dels + stats.chgs;

  const labelStyle = {
    fontSize: 10,
    color: "#64748b",
    fontWeight: 600,
    letterSpacing: "0.04em",
    textTransform: "uppercase",
  };

  const btnStyle = (active, color) => ({
    display: "flex",
    alignItems: "center",
    gap: 4,
    padding: "3px 8px",
    backgroundColor: active ? color : "#94a3b8",
    color: "#ffffff",
    border: "none",
    borderRadius: 4,
    cursor: "pointer",
    fontSize: 10,
    fontWeight: 700,
    letterSpacing: "0.04em",
    transition: "background 0.2s ease",
  });

  const actionBtn = (color, bg) => ({
    padding: "3px 8px",
    fontSize: 10,
    fontWeight: 600,
    color: color,
    backgroundColor: bg,
    border: `1px solid ${color}20`,
    borderRadius: 4,
    cursor: totalRevisions > 0 ? "pointer" : "default",
    opacity: totalRevisions > 0 ? 1 : 0.4,
  });

  return (
    <div style={{
      display: "flex",
      alignItems: "center",
      gap: 12,
      padding: "4px 16px",
      borderBottom: "1px solid var(--sim-border, #e2e8f0)",
      backgroundColor: trackChanges ? "var(--sim-tint-info, #eff6ff)" : "var(--sim-toolbar-bg, #fafafa)",
      fontSize: 11,
      transition: "background 0.2s ease",
    }}>
      {/* Track Changes toggle */}
      <button
        onClick={() => onTrackChangesChange(!trackChanges)}
        aria-pressed={trackChanges}
        style={btnStyle(trackChanges, "#2563eb")}
      >
        <span style={{
          display: "inline-block",
          width: 6,
          height: 6,
          borderRadius: "50%",
          backgroundColor: trackChanges ? "#bfdbfe" : "#cbd5e1",
        }} />
        Track Changes
      </button>

      {/* Show Revisions toggle */}
      <button
        onClick={() => onShowRevisionsChange(!showRevisions)}
        style={{
          ...btnStyle(showRevisions, "#7c3aed"),
          backgroundColor: showRevisions ? "#7c3aed" : "#94a3b8",
        }}
        title={showRevisions ? "Hide revision marks" : "Show revision marks"}
      >
        <span style={{ fontSize: 12 }}>{showRevisions ? "👁" : "👁‍🗨"}</span>
        Revisions
      </button>

      {/* Show/Hide Notes toggle */}
      <button
        onClick={() => onShowNotesChange(!showNotes)}
        style={{
          ...btnStyle(showNotes, "#d97706"),
          backgroundColor: showNotes ? "#d97706" : "#94a3b8",
        }}
        title={showNotes ? "Hide specification notes" : "Show specification notes"}
      >
        <span style={{ fontSize: 12 }}>📝</span>
        Notes
      </button>

      {/* Units display toggle */}
      {onUnitDisplayChange && (
        <button
          onClick={() => {
            const next = unitDisplay === 'both' ? 'eng' : unitDisplay === 'eng' ? 'met' : 'both';
            onUnitDisplayChange(next);
          }}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 4,
            padding: "3px 8px",
            backgroundColor: unitDisplay === 'both' ? "#94a3b8" : unitDisplay === 'eng' ? "#1d4ed8" : "#b91c1c",
            color: "#ffffff",
            border: "none",
            borderRadius: 4,
            cursor: "pointer",
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: "0.04em",
            transition: "background 0.2s ease",
          }}
          title={`Units: ${unitDisplay === 'both' ? 'Both' : unitDisplay === 'eng' ? 'English only' : 'Metric only'} (click to cycle)`}
        >
          {unitDisplay === 'both' ? 'ENG+MET' : unitDisplay === 'eng' ? 'ENG' : 'MET'}
        </button>
      )}

      {/* Separator */}
      {totalRevisions > 0 && (
        <div style={{ width: 1, height: 18, backgroundColor: "#e2e8f0" }} />
      )}

      {/* Accept All / Reject All */}
      {totalRevisions > 0 && (
        <>
          <button
            onClick={onAcceptAll}
            style={actionBtn("#008000", "#f0fdf4")}
            title="Accept all revisions"
          >
            ✓ Accept All
          </button>
          <button
            onClick={onRejectAll}
            style={actionBtn("#ff4444", "#fef2f2")}
            title="Reject all revisions"
          >
            ✗ Reject All
          </button>
        </>
      )}

      {/* Stats */}
      {totalRevisions > 0 && (
        <span style={{
          ...labelStyle,
          marginLeft: "auto",
          textTransform: "none",
          fontWeight: 400,
          fontSize: 11,
          color: "#475569",
        }}>
          {stats.adds > 0 && (
            <span style={{ color: "#008000", fontWeight: 600 }}>
              {stats.adds} addition{stats.adds !== 1 ? "s" : ""}
            </span>
          )}
          {stats.adds > 0 && (stats.dels > 0 || stats.chgs > 0) && ", "}
          {stats.dels > 0 && (
            <span style={{ color: "#ff4444", fontWeight: 600 }}>
              {stats.dels} deletion{stats.dels !== 1 ? "s" : ""}
            </span>
          )}
          {stats.dels > 0 && stats.chgs > 0 && ", "}
          {stats.chgs > 0 && (
            <span style={{ color: "#ca8a04", fontWeight: 600 }}>
              {stats.chgs} change{stats.chgs !== 1 ? "s" : ""}
            </span>
          )}
        </span>
      )}
    </div>
  );
}
