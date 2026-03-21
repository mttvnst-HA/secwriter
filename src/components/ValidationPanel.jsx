import { useMemo, useState } from "react";
import { validateDocument } from "../lib/doc-validation.js";

const SEVERITY_STYLES = {
  error: { color: '#dc2626', bg: '#fef2f2', icon: '●', label: 'Error' },
  warning: { color: '#d97706', bg: '#fffbeb', icon: '▲', label: 'Warning' },
  info: { color: '#2563eb', bg: '#eff6ff', icon: 'ℹ', label: 'Info' },
};

export default function ValidationPanel({ blocks, onClose, onNavigate }) {
  const issues = useMemo(() => validateDocument(blocks), [blocks]);
  const [filter, setFilter] = useState('all'); // 'all' | 'error' | 'warning' | 'info'

  const filtered = filter === 'all' ? issues : issues.filter(i => i.severity === filter);

  const errorCount = issues.filter(i => i.severity === 'error').length;
  const warnCount = issues.filter(i => i.severity === 'warning').length;
  const infoCount = issues.filter(i => i.severity === 'info').length;

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
          Document Validation
        </span>
        <span style={{ color: "#64748b", fontSize: 12 }}>
          {issues.length} issue{issues.length !== 1 ? 's' : ''}
        </span>

        {/* Filter chips */}
        <div style={{ display: "flex", gap: 4, marginLeft: 8 }}>
          {[
            { key: 'all', label: `All (${issues.length})` },
            { key: 'error', label: `${errorCount}`, color: '#dc2626' },
            { key: 'warning', label: `${warnCount}`, color: '#d97706' },
            { key: 'info', label: `${infoCount}`, color: '#2563eb' },
          ].map(f => (
            <button key={f.key} onClick={() => setFilter(f.key)} style={{
              padding: "1px 8px", fontSize: 11, borderRadius: 10,
              border: filter === f.key ? `1px solid ${f.color || '#334155'}` : '1px solid #e2e8f0',
              backgroundColor: filter === f.key ? (f.color ? f.color + '10' : '#f1f5f9') : 'white',
              color: f.color || '#334155',
              cursor: 'pointer', fontWeight: filter === f.key ? 600 : 400,
            }}>{f.label}</button>
          ))}
        </div>

        <div style={{ flex: 1 }} />
        <button onClick={onClose} style={{
          border: "none", background: "transparent", color: "#94a3b8",
          fontSize: 16, cursor: "pointer", padding: "0 4px",
        }}>&#x2715;</button>
      </div>

      {/* Issues list */}
      {filtered.length === 0 ? (
        <div style={{ padding: "8px 16px", color: "#64748b", fontSize: 12 }}>
          {issues.length === 0 ? 'No issues found — document looks good.' : 'No issues match this filter.'}
        </div>
      ) : (
        <div style={{ maxHeight: 200, overflowY: "auto", padding: "4px 16px" }}>
          {filtered.map((issue, i) => {
            const sev = SEVERITY_STYLES[issue.severity];
            return (
              <div key={`${issue.category}-${issue.blockId || ''}-${i}`}
                onClick={() => {
                  if (issue.blockId && onNavigate) {
                    const el = document.getElementById(`block-${issue.blockId}`);
                    if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
                  }
                }}
                style={{
                  display: "flex", alignItems: "flex-start", gap: 8, padding: "4px 0",
                  borderBottom: "1px solid #f1f5f9",
                  cursor: issue.blockId ? "pointer" : "default",
                }}
              >
                <span style={{
                  color: sev.color, fontSize: 10, marginTop: 3, flexShrink: 0,
                }}>{sev.icon}</span>
                <span style={{
                  fontSize: 11, color: sev.color, fontWeight: 600, minWidth: 55,
                  flexShrink: 0,
                }}>{issue.category}</span>
                <span style={{ fontSize: 12, color: "#334155", flex: 1 }}>
                  {issue.message}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
