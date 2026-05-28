import { useCallback } from "react";
import { BRANCHES, REGIONS, DELIVERY_METHODS } from "../lib/tailor-profile.js";

/**
 * Compact toolbar row for TAI tailoring profile selection.
 * Controls: on/off toggle, branch dropdown, region dropdown (NAVY only),
 * delivery method dropdown, show-all checkbox.
 */
export default function TailoringProfile({
  active,
  onActiveChange,
  profile,
  onProfileChange,
  showAll,
  onShowAllChange,
}) {
  const handleBranchChange = useCallback((e) => {
    const branch = e.target.value || null;
    onProfileChange({
      ...profile,
      branch,
      // Clear region when switching away from NAVY
      region: branch === "NAVY" ? profile.region : null,
    });
  }, [profile, onProfileChange]);

  const handleRegionChange = useCallback((e) => {
    onProfileChange({ ...profile, region: e.target.value || null });
  }, [profile, onProfileChange]);

  const handleDeliveryChange = useCallback((e) => {
    onProfileChange({ ...profile, deliveryMethod: e.target.value || null });
  }, [profile, onProfileChange]);

  const selectStyle = {
    padding: "3px 6px",
    fontSize: 11,
    border: "1px solid #e2e8f0",
    borderRadius: 4,
    backgroundColor: "#ffffff",
    color: "#334155",
    cursor: "pointer",
    outline: "none",
  };

  const labelStyle = {
    fontSize: 10,
    color: "#64748b",
    fontWeight: 600,
    letterSpacing: "0.04em",
    textTransform: "uppercase",
  };

  return (
    <div style={{
      display: "flex",
      alignItems: "center",
      gap: 12,
      padding: "4px 16px",
      borderBottom: "1px solid var(--sim-border, #e2e8f0)",
      backgroundColor: active ? "var(--sim-tint-success, #f0fdf4)" : "var(--sim-toolbar-bg, #fafafa)",
      fontSize: 11,
      transition: "background 0.2s ease",
    }}>
      {/* Toggle */}
      <button
        onClick={() => onActiveChange(!active)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 4,
          padding: "3px 8px",
          backgroundColor: active ? "#059669" : "#94a3b8",
          color: "#ffffff",
          border: "none",
          borderRadius: 4,
          cursor: "pointer",
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: "0.04em",
          transition: "background 0.2s ease",
        }}
      >
        <span style={{
          display: "inline-block",
          width: 6,
          height: 6,
          borderRadius: "50%",
          backgroundColor: active ? "#bbf7d0" : "#cbd5e1",
        }} />
        TAI
      </button>

      {/* Branch */}
      <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
        <span style={labelStyle}>Branch</span>
        <select
          value={profile.branch || ""}
          onChange={handleBranchChange}
          disabled={!active}
          style={{ ...selectStyle, opacity: active ? 1 : 0.5 }}
        >
          <option value="">All</option>
          {BRANCHES.map(b => <option key={b} value={b}>{b}</option>)}
        </select>
      </div>

      {/* Region (NAVY only) */}
      {profile.branch === "NAVY" && active && (
        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <span style={labelStyle}>Region</span>
          <select
            value={profile.region || ""}
            onChange={handleRegionChange}
            style={selectStyle}
          >
            <option value="">All NAVFAC</option>
            {REGIONS.filter(r => r !== "NAVFAC").map(r => (
              <option key={r} value={r}>{r.replace("NAVFAC ", "")}</option>
            ))}
          </select>
        </div>
      )}

      {/* Delivery Method */}
      <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
        <span style={labelStyle}>Delivery</span>
        <select
          value={profile.deliveryMethod || ""}
          onChange={handleDeliveryChange}
          disabled={!active}
          style={{ ...selectStyle, opacity: active ? 1 : 0.5 }}
        >
          <option value="">All</option>
          {DELIVERY_METHODS.map(d => <option key={d} value={d}>{d}</option>)}
        </select>
      </div>

      {/* Show All toggle */}
      {active && profile.branch && (
        <label style={{
          display: "flex",
          alignItems: "center",
          gap: 4,
          cursor: "pointer",
          fontSize: 11,
          color: "#475569",
          marginLeft: "auto",
        }}>
          <input
            type="checkbox"
            checked={showAll}
            onChange={(e) => onShowAllChange(e.target.checked)}
            style={{ cursor: "pointer" }}
          />
          Show excluded
        </label>
      )}
    </div>
  );
}
