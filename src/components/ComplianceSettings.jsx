import { useState, useCallback } from "react";
import { getApiKey, setApiKey, clearApiKey, testConnection } from "../lib/compliance-ai.js";

export default function ComplianceSettings({ onClose, ignoredCount = 0, mutedCount = 0, onResetIgnored, onResetMuted }) {
  const [key, setKey] = useState(getApiKey() || "");
  const [model, setModel] = useState(
    localStorage.getItem("sim-compliance-model") || "claude-sonnet-4-20250514"
  );
  const [testResult, setTestResult] = useState(null); // null | 'testing' | { success, error }
  const [saved, setSaved] = useState(false);

  const handleSave = useCallback(() => {
    if (key.trim()) {
      setApiKey(key.trim());
    } else {
      clearApiKey();
    }
    localStorage.setItem("sim-compliance-model", model);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }, [key, model]);

  const handleTest = useCallback(async () => {
    if (!key.trim()) {
      setTestResult({ success: false, error: "No API key entered" });
      return;
    }
    setTestResult("testing");
    const result = await testConnection(key.trim());
    setTestResult(result);
  }, [key]);

  const handleClear = useCallback(() => {
    clearApiKey();
    setKey("");
    setTestResult(null);
    setSaved(false);
  }, []);

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        backgroundColor: "rgba(0,0,0,0.4)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 10000,
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        style={{
          backgroundColor: "var(--color-surface, white)",
          borderRadius: 8,
          padding: "24px",
          width: 420,
          maxWidth: "90vw",
          boxShadow: "0 8px 32px rgba(0,0,0,0.2)",
          fontFamily: "var(--font-family, 'Inter', sans-serif)",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
          <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: "var(--color-text, #202124)" }}>
            Compliance AI Settings
          </h3>
          <button
            onClick={onClose}
            style={{
              border: "none", background: "transparent", fontSize: 18,
              cursor: "pointer", color: "var(--color-text, #5f6368)", padding: 4,
            }}
          >✕</button>
        </div>

        {/* API Key */}
        <label style={{ display: "block", fontSize: 13, fontWeight: 600, color: "var(--color-text, #334155)", marginBottom: 4 }}>
          Anthropic API Key
        </label>
        <input
          type="password"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder="sk-ant-..."
          style={{
            width: "100%",
            padding: "8px 10px",
            border: "1px solid var(--color-border, #cbd5e1)",
            borderRadius: 4,
            fontSize: 13,
            fontFamily: "monospace",
            marginBottom: 8,
            boxSizing: "border-box",
            backgroundColor: "var(--color-surface, white)",
            color: "var(--color-text, #334155)",
          }}
        />

        <div style={{
          fontSize: 11, color: "#ef4444", marginBottom: 12, lineHeight: 1.4,
          padding: "6px 8px", backgroundColor: "#fef2f2", borderRadius: 4,
        }}>
          Your API key is stored in your browser's local storage. Do not use this on a shared or public computer.
        </div>

        {/* Model selection */}
        <label style={{ display: "block", fontSize: 13, fontWeight: 600, color: "var(--color-text, #334155)", marginBottom: 4 }}>
          Model
        </label>
        <select
          value={model}
          onChange={(e) => setModel(e.target.value)}
          style={{
            width: "100%",
            padding: "6px 8px",
            border: "1px solid var(--color-border, #cbd5e1)",
            borderRadius: 4,
            fontSize: 13,
            marginBottom: 16,
            backgroundColor: "var(--color-surface, white)",
            color: "var(--color-text, #334155)",
          }}
        >
          <option value="claude-sonnet-4-20250514">Claude Sonnet 4 (recommended)</option>
          <option value="claude-haiku-3-5-20241022">Claude Haiku 3.5 (faster/cheaper)</option>
        </select>

        {/* Action buttons */}
        <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
          <button
            onClick={handleSave}
            style={{
              padding: "6px 16px", borderRadius: 4, border: "none",
              backgroundColor: "#2563eb", color: "white", fontWeight: 600,
              fontSize: 13, cursor: "pointer",
            }}
          >
            {saved ? "✓ Saved" : "Save"}
          </button>
          <button
            onClick={handleTest}
            disabled={testResult === "testing"}
            style={{
              padding: "6px 16px", borderRadius: 4,
              border: "1px solid var(--color-border, #cbd5e1)",
              backgroundColor: "var(--color-surface, white)",
              color: "var(--color-text, #334155)",
              fontWeight: 600, fontSize: 13, cursor: "pointer",
              opacity: testResult === "testing" ? 0.5 : 1,
            }}
          >
            {testResult === "testing" ? "Testing..." : "Test Connection"}
          </button>
          <button
            onClick={handleClear}
            style={{
              padding: "6px 16px", borderRadius: 4,
              border: "1px solid #dc262633",
              backgroundColor: "#fef2f2",
              color: "#dc2626",
              fontWeight: 600, fontSize: 13, cursor: "pointer",
            }}
          >
            Clear Key
          </button>
        </div>

        {/* Test result */}
        {testResult && testResult !== "testing" && (
          <div style={{
            padding: "8px 10px", borderRadius: 4, fontSize: 12,
            backgroundColor: testResult.success ? "#f0fdf4" : "#fef2f2",
            color: testResult.success ? "#16a34a" : "#dc2626",
            border: testResult.success ? "1px solid #16a34a33" : "1px solid #dc262633",
          }}>
            {testResult.success
              ? "✓ Connection successful — API key is valid"
              : `✗ ${testResult.error}`}
          </div>
        )}

        {/* Ignored findings reset */}
        <div style={{ marginTop: 16, paddingTop: 12, borderTop: '1px solid #e5e7eb' }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: '#1e293b', marginBottom: 6 }}>
            Ignored findings
          </div>
          <div style={{ fontSize: 12, color: '#64748b', marginBottom: 8 }}>
            {ignoredCount === 0
              ? 'No findings dismissed in this document.'
              : `${ignoredCount} findings dismissed across this document.`}
          </div>
          <button
            onClick={() => {
              const ok = window.confirm(`Reset all ${ignoredCount} dismissed findings? They will reappear.`);
              if (ok) onResetIgnored();
            }}
            disabled={ignoredCount === 0}
            style={{
              padding: '6px 12px',
              fontSize: 13,
              backgroundColor: ignoredCount === 0 ? '#f1f5f9' : '#fff',
              color: ignoredCount === 0 ? '#94a3b8' : '#dc2626',
              border: `1px solid ${ignoredCount === 0 ? '#e2e8f0' : '#fca5a5'}`,
              borderRadius: 4,
              cursor: ignoredCount === 0 ? 'not-allowed' : 'pointer',
            }}
          >
            Reset ignored findings
          </button>
        </div>

        {/* Muted rules reset */}
        <div style={{ marginTop: 12 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: '#1e293b', marginBottom: 6 }}>
            Muted rules
          </div>
          <div style={{ fontSize: 12, color: '#64748b', marginBottom: 8 }}>
            {mutedCount === 0
              ? 'No rules muted in this document.'
              : `${mutedCount} rules muted in this document.`}
          </div>
          <button
            onClick={() => {
              const ok = window.confirm(`Reset all ${mutedCount} muted rules? Their findings will reappear.`);
              if (ok) onResetMuted();
            }}
            disabled={mutedCount === 0}
            style={{
              padding: '6px 12px',
              fontSize: 13,
              backgroundColor: mutedCount === 0 ? '#f1f5f9' : '#fff',
              color: mutedCount === 0 ? '#94a3b8' : '#dc2626',
              border: `1px solid ${mutedCount === 0 ? '#e2e8f0' : '#fca5a5'}`,
              borderRadius: 4,
              cursor: mutedCount === 0 ? 'not-allowed' : 'pointer',
            }}
          >
            Reset muted rules
          </button>
        </div>
      </div>
    </div>
  );
}
