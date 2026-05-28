import { useMemo, useState } from "react";
import { validateRids, validateSrfs, extractRefRids } from "../lib/cross-ref-validation.js";

export default function CrossRefPanel({ blocks, sectionNumber, onRemoveOrphaned }) {
  const { unlinked, orphaned } = useMemo(() => validateRids(blocks), [blocks]);
  const { selfReferences } = useMemo(() => validateSrfs(blocks, sectionNumber), [blocks, sectionNumber]);
  const refRids = useMemo(() => extractRefRids(blocks), [blocks]);
  const [expanded, setExpanded] = useState(false);

  const ridTotal = unlinked.length + orphaned.length;
  const srfTotal = selfReferences.length;
  if (ridTotal === 0 && srfTotal === 0) return null;

  const handleRemove = (rid) => {
    if (!onRemoveOrphaned) return;
    const blockId = refRids.get(rid);
    if (blockId) onRemoveOrphaned(blockId, rid);
  };

  const handleRemoveAll = () => {
    if (!onRemoveOrphaned) return;
    for (const rid of orphaned) {
      const blockId = refRids.get(rid);
      if (blockId) onRemoveOrphaned(blockId, rid);
    }
  };

  const removeBtnStyle = {
    borderRadius: 3,
    fontSize: 10,
    padding: "1px 6px",
    cursor: "pointer",
    fontWeight: 600,
    marginLeft: 6,
    lineHeight: "16px",
  };

  return (
    <div className="cross-ref-banner" style={{
      padding: "4px 16px",
      borderBottom: "1px solid #e2e8f0",
      backgroundColor: "#fffbeb",
      fontSize: 11,
    }}>
      <div
        onClick={() => setExpanded(!expanded)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          cursor: "pointer",
          userSelect: "none",
        }}
      >
        <span style={{ fontSize: 10, opacity: 0.5 }}>{expanded ? "▼" : "▶"}</span>
        <span style={{ color: "#92400e", fontWeight: 600 }}>
          {unlinked.length > 0 && (
            <span>{unlinked.length} unlinked citation{unlinked.length !== 1 ? "s" : ""}</span>
          )}
          {unlinked.length > 0 && (orphaned.length > 0 || srfTotal > 0) && ", "}
          {orphaned.length > 0 && (
            <span>{orphaned.length} orphaned reference{orphaned.length !== 1 ? "s" : ""}</span>
          )}
          {orphaned.length > 0 && srfTotal > 0 && ", "}
          {srfTotal > 0 && (
            <span>{srfTotal} self-reference{srfTotal !== 1 ? "s" : ""}</span>
          )}
        </span>
      </div>
      {expanded && (
        <div style={{ marginTop: 4, marginLeft: 18, display: "flex", flexDirection: "column", gap: 2 }}>
          {unlinked.map(rid => (
            <div key={`u-${rid}`} style={{ color: "#b45309", fontSize: 11 }}>
              <span style={{ opacity: 0.6 }}>cited but not in REFERENCES:</span>{" "}
              <span style={{ fontWeight: 600, fontFamily: "'SF Mono', 'Consolas', monospace" }}>{rid}</span>
            </div>
          ))}
          {orphaned.map(rid => (
            <div key={`o-${rid}`} style={{ color: "#78716c", fontSize: 11, display: "flex", alignItems: "center" }}>
              <span style={{ opacity: 0.6 }}>in REFERENCES but never cited:</span>{" "}
              <span style={{ fontWeight: 600, fontFamily: "'SF Mono', 'Consolas', monospace" }}>{rid}</span>
              {onRemoveOrphaned && (
                <button
                  onClick={(e) => { e.stopPropagation(); handleRemove(rid); }}
                  title={`Remove ${rid} from REFERENCES`}
                  className="cross-ref-remove-btn"
                  style={removeBtnStyle}
                >Remove</button>
              )}
            </div>
          ))}
          {orphaned.length > 1 && onRemoveOrphaned && (
            <div style={{ marginTop: 4 }}>
              <button
                onClick={(e) => { e.stopPropagation(); handleRemoveAll(); }}
                title="Remove all orphaned references"
                className="cross-ref-remove-btn"
                style={{
                  ...removeBtnStyle,
                  marginLeft: 0,
                  padding: "2px 10px",
                  fontSize: 11,
                }}
              >Remove All Orphaned ({orphaned.length})</button>
            </div>
          )}
          {selfReferences.map(srf => (
            <div key={`sr-${srf}`} style={{ color: "#b45309", fontSize: 11 }}>
              <span style={{ opacity: 0.6 }}>section references itself:</span>{" "}
              <span style={{ fontWeight: 600, fontFamily: "'SF Mono', 'Consolas', monospace" }}>{srf}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
