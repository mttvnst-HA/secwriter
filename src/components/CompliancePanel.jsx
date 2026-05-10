import { useState, useCallback, useMemo, useEffect, useRef } from "react";
import { checkCompliance } from "../lib/compliance-checker.js";
import { findFirstHighlightInBlock } from "../lib/compliance-highlight.js";
import { getApiKey, requestAIRewrite, estimateTokens, estimateCost } from "../lib/compliance-ai.js";
import * as comp from "../lib/compliance.js";
import { getBlockDom } from "../lib/block-registry.js";
import ComplianceSettings from "./ComplianceSettings.jsx";

const SEVERITY_COLORS = {
  high: { bg: "#fef2f2", border: "#ef4444", text: "#991b1b", badge: "#dc2626" },
  medium: { bg: "#fffbeb", border: "#f59e0b", text: "#92400e", badge: "#d97706" },
  low: { bg: "#eff6ff", border: "#3b82f6", text: "#1e40af", badge: "#2563eb" },
};

/**
 * CompliancePanel — UI shell for the compliance reducer.
 *
 * Domain state lives in App (`complianceState`) per ADR-0005. The panel reads
 * via selectors from `comp` and dispatches verbs via `dispatchCompliance`.
 * Pure UI state (filter tab, accordion expand, "Why?" toggle, onboarding,
 * settings modal) stays local to the panel — these are presentation, not
 * domain. The AbortController for AI runs is also panel-local because it's
 * a side-effect handle, not state.
 *
 * The .compliance-highlight DOM mutation is owned by App (single seam,
 * matches linting's CSS.highlights pattern). The panel only triggers
 * scroll-to-existing-highlight via findFirstHighlightInBlock.
 */
export default function CompliancePanel({
  blocks,
  focusedBlockId,
  complianceState,
  dispatchCompliance,
  onAcceptFix,
  onAcceptGroupFix,
  unitDisplay,
}) {
  const result = comp.getResult(complianceState);
  const scope = comp.getScope(complianceState);
  const activeGroup = comp.getActiveGroup(complianceState);
  const checking = comp.isChecking(complianceState);
  const aiRunning = comp.isAiRunning(complianceState);
  const aiProgress = comp.getAiProgress(complianceState);
  const aiError = comp.getAiError(complianceState);
  const sessionTokens = comp.getSessionTokens(complianceState);

  // ── Local UI-only state ───────────────────────────────────────────────────
  const [filter, setFilter] = useState("high");
  const [expandedGroups, setExpandedGroups] = useState(new Set());
  const [expandedWhy, setExpandedWhy] = useState(new Set());
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const abortRef = useRef(null);

  // First-run onboarding
  useEffect(() => {
    if (!localStorage.getItem("sim-compliance-onboarded")) {
      setShowOnboarding(true);
    }
  }, []);

  // Reset transient UI state on each fresh result.
  useEffect(() => {
    setFilter("high");
    setExpandedGroups(new Set());
    setExpandedWhy(new Set());
  }, [result]);

  const dismissOnboarding = useCallback(() => {
    setShowOnboarding(false);
    localStorage.setItem("sim-compliance-onboarded", "1");
  }, []);

  // ── Verb dispatchers (concise reducer call sites) ─────────────────────────

  const setScope = useCallback((s) => {
    dispatchCompliance((state) => comp.setScope(state, s));
  }, [dispatchCompliance]);

  const setActiveGroup = useCallback((ruleId) => {
    dispatchCompliance((state) => comp.setActiveGroup(state, ruleId));
  }, [dispatchCompliance]);

  // ── Run scan ──────────────────────────────────────────────────────────────

  const handleRunCheck = useCallback(async () => {
    dispatchCompliance((state) => comp.startCheck(state));
    const anchorId = scope === "document" ? null : focusedBlockId;
    const res = await checkCompliance(blocks, scope, anchorId, { unitDisplay });
    dispatchCompliance((state) => comp.setResult(state, res));
  }, [blocks, scope, focusedBlockId, unitDisplay, dispatchCompliance]);

  // ── Accept/reject handlers ────────────────────────────────────────────────

  const handleAutoFixFmt = useCallback(() => {
    if (!result) return;
    const { fixes, ruleIds, count } = comp.computeFormattingFixes(result, blocks);
    if (fixes.size === 0) return;
    onAcceptGroupFix(fixes, `Compliance: auto-fixed ${count} formatting items`);
    dispatchCompliance((state) => comp.markGroupsAccepted(state, ruleIds));
  }, [result, blocks, onAcceptGroupFix, dispatchCompliance]);

  const handleAcceptGroup = useCallback((group) => {
    const fixes = comp.computeGroupFixes(group, blocks);
    if (fixes.size === 0) return;
    const label = `Compliance: accepted ${fixes.size} "${group.representative?.match || group.ruleId}" fixes`;
    onAcceptGroupFix(fixes, label);
    dispatchCompliance((state) => comp.acceptGroup(state, group.ruleId));
  }, [blocks, onAcceptGroupFix, dispatchCompliance]);

  const handleRejectGroup = useCallback((group) => {
    dispatchCompliance((state) => comp.rejectGroup(state, group.ruleId));
  }, [dispatchCompliance]);

  const handleAcceptItem = useCallback((violation) => {
    const fix = comp.computeItemFix(violation, blocks);
    if (!fix) return;
    onAcceptFix(fix.blockId, fix.html);
    dispatchCompliance((state) => comp.acceptItem(state, violation.blockId, violation.index));
  }, [blocks, onAcceptFix, dispatchCompliance]);

  const handleRejectItem = useCallback((violation) => {
    dispatchCompliance((state) => comp.rejectItem(state, violation.blockId, violation.index));
  }, [dispatchCompliance]);

  // Click on a representative sentence or instance — scroll to its highlight
  // (which has already been injected by App's effect when the group activated).
  const scrollToBlockHighlight = useCallback((blockId) => {
    const target =
      findFirstHighlightInBlock(document, blockId) ||
      getBlockDom(blockId);
    if (target) target.scrollIntoView({ behavior: "smooth", block: "center" });
  }, []);

  // ── AI batch rewrite ──────────────────────────────────────────────────────

  const handleAIFixAll = useCallback(async () => {
    const apiKey = getApiKey();
    if (!apiKey) {
      setShowSettings(true);
      return;
    }
    if (!result) return;

    const aiViolations = result.violations.filter((v) => v.fixFn === null);
    if (aiViolations.length === 0) return;

    const tokens = estimateTokens(blocks, aiViolations);
    const cost = estimateCost(tokens);
    const proceed = window.confirm(
      `AI rewrite will process ${aiViolations.length} violations.\nEstimated: ~${tokens.toLocaleString()} tokens (~$${cost.toFixed(4)})\n\nProceed?`
    );
    if (!proceed) return;

    dispatchCompliance((state) => comp.aiStart(state));
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const { rewrites, tokensUsed } = await requestAIRewrite(
        blocks, aiViolations, apiKey,
        {
          model: localStorage.getItem("sim-compliance-model") || "claude-sonnet-4-20250514",
          abortSignal: controller.signal,
          onProgress: (p) => dispatchCompliance((state) => comp.aiProgress(state, p)),
        }
      );

      if (rewrites.length > 0) {
        const fixesByBlock = new Map();
        for (const r of rewrites) fixesByBlock.set(r.blockId, r.proposed);
        onAcceptGroupFix(fixesByBlock, `Compliance AI: rewrote ${rewrites.length} blocks`);
      }
      dispatchCompliance((state) => comp.aiSuccess(state, tokensUsed));
    } catch (err) {
      if (err.name === "AbortError") {
        dispatchCompliance((state) => comp.aiAbort(state));
      } else {
        dispatchCompliance((state) => comp.aiError(state, err.message));
      }
    } finally {
      abortRef.current = null;
    }
  }, [result, blocks, onAcceptGroupFix, dispatchCompliance]);

  const handleAICancel = useCallback(() => {
    if (abortRef.current) abortRef.current.abort();
  }, []);

  // ── Local UI toggles ──────────────────────────────────────────────────────

  const toggleGroup = useCallback((ruleId) => {
    setExpandedGroups((prev) => {
      if (prev.has(ruleId)) return new Set();
      return new Set([ruleId]);
    });
  }, []);

  const toggleWhy = useCallback((ruleId) => {
    setExpandedWhy((prev) => {
      const next = new Set(prev);
      if (next.has(ruleId)) next.delete(ruleId);
      else next.add(ruleId);
      return next;
    });
  }, []);

  // ── Derived for render ────────────────────────────────────────────────────

  const filteredGroups = useMemo(
    () => comp.getFilteredGroups(complianceState, filter),
    [complianceState, filter]
  );
  const fmtCount = useMemo(() => comp.getFmtCount(complianceState), [complianceState]);
  const needsAICount = useMemo(() => comp.getNeedsAICount(complianceState), [complianceState]);
  const barPcts = useMemo(() => comp.getStatsBarPercents(complianceState), [complianceState]);

  return (
    <div
      style={{
        width: 320,
        borderLeft: "1px solid var(--color-border, #dadce0)",
        overflowY: "auto",
        padding: "12px",
        backgroundColor: "var(--color-surface, #fafafa)",
        flexShrink: 0,
        fontSize: 13,
        fontFamily: "var(--font-family, 'Inter', 'Segoe UI', sans-serif)",
        position: "relative",
      }}
    >
      {/* Header */}
      <div style={{ fontWeight: 700, fontSize: 14, color: "var(--color-text, #202124)", marginBottom: 12 }}>
        Compliance Check
      </div>

      {/* Onboarding tooltip */}
      {showOnboarding && (
        <div
          onClick={dismissOnboarding}
          style={{
            padding: "10px 12px",
            marginBottom: 12,
            backgroundColor: "#eff6ff",
            border: "1px solid #93c5fd",
            borderRadius: 6,
            fontSize: 12,
            lineHeight: 1.5,
            color: "#1e40af",
            cursor: "pointer",
          }}
        >
          The compliance checker reviews your spec against UFS 1-300-02 writing standards.
          Items are grouped by type — review one example, then apply to all similar cases.
          <span style={{ color: "#dc2626", fontWeight: 600 }}> Red</span> = required,
          <span style={{ color: "#d97706", fontWeight: 600 }}> amber</span> = recommended,
          <span style={{ color: "#2563eb", fontWeight: 600 }}> blue</span> = formatting (auto-fixable).
          <div style={{ fontSize: 10, marginTop: 4, color: "#6b7280" }}>Click to dismiss</div>
        </div>
      )}

      {/* Scope selector + Run button */}
      <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
        <select
          value={scope}
          onChange={(e) => setScope(e.target.value)}
          style={{
            flex: 1,
            padding: "4px 8px",
            borderRadius: 4,
            border: "1px solid var(--color-border, #cbd5e1)",
            fontSize: 12,
            backgroundColor: "var(--color-surface, white)",
            color: "var(--color-text, #334155)",
          }}
        >
          <option value="block">Current Block</option>
          <option value="subsection">This Section</option>
          <option value="part">This Part</option>
          <option value="document">Entire Document</option>
        </select>
        <button
          onClick={handleRunCheck}
          disabled={checking}
          style={{
            padding: "4px 12px",
            borderRadius: 4,
            border: "none",
            backgroundColor: checking ? "#93c5fd" : "#2563eb",
            color: "white",
            fontWeight: 600,
            fontSize: 12,
            cursor: checking ? "wait" : "pointer",
            minHeight: 32,
            whiteSpace: "nowrap",
            opacity: checking ? 0.7 : 1,
          }}
        >
          {checking ? "Checking..." : "Run Check"}
        </button>
      </div>

      {/* No results yet */}
      {!result && (
        <div style={{ color: "#6b7280", fontSize: 12, padding: "20px 0", textAlign: "center" }}>
          Select a scope and click "Run Check" to analyze your spec against UFS 1-300-02.
        </div>
      )}

      {/* Results */}
      {result && (
        <>
          {/* Summary bar */}
          <div
            style={{
              padding: "10px 12px",
              marginBottom: 12,
              backgroundColor: "var(--color-surface, white)",
              border: "1px solid var(--color-border, #e2e8f0)",
              borderRadius: 6,
            }}
          >
            {result.stats.total === 0 ? (
              <div style={{ color: "#16a34a", fontWeight: 600, textAlign: "center" }}>
                ✓ No violations found
              </div>
            ) : (
              <>
                {/* Severity bar */}
                <div
                  style={{
                    display: "flex",
                    height: 8,
                    borderRadius: 4,
                    overflow: "hidden",
                    marginBottom: 8,
                  }}
                >
                  {barPcts.high > 0 && (
                    <div style={{ width: `${barPcts.high}%`, backgroundColor: "#ef4444" }} />
                  )}
                  {barPcts.medium > 0 && (
                    <div style={{ width: `${barPcts.medium}%`, backgroundColor: "#f59e0b" }} />
                  )}
                  {barPcts.low > 0 && (
                    <div style={{ width: `${barPcts.low}%`, backgroundColor: "#3b82f6" }} />
                  )}
                </div>

                {/* Counts */}
                <div style={{ fontSize: 12, color: "var(--color-text, #475569)", display: "flex", gap: 8 }}>
                  <span style={{ color: "#dc2626", fontWeight: 600 }}>{result.stats.high} high</span>
                  <span>·</span>
                  <span style={{ color: "#d97706", fontWeight: 600 }}>{result.stats.medium} medium</span>
                  <span>·</span>
                  <span style={{ color: "#2563eb", fontWeight: 600 }}>{result.stats.low} low</span>
                </div>

                {/* Auto-fix FMT button */}
                {fmtCount > 0 && !comp.isGroupAccepted(complianceState, "FMT-001") && (
                  <button
                    onClick={handleAutoFixFmt}
                    style={{
                      marginTop: 8,
                      width: "100%",
                      padding: "6px 0",
                      borderRadius: 4,
                      border: "1px solid #93c5fd",
                      backgroundColor: "#eff6ff",
                      color: "#1e40af",
                      fontSize: 12,
                      fontWeight: 600,
                      cursor: "pointer",
                    }}
                  >
                    Auto-fix {fmtCount} formatting items
                  </button>
                )}
              </>
            )}
          </div>

          {/* Truncation warning */}
          {result.truncated && (
            <div style={{
              padding: "6px 10px",
              marginBottom: 8,
              borderRadius: 4,
              backgroundColor: "#fef3c7",
              border: "1px solid #f59e0b",
              color: "#92400e",
              fontSize: 11,
              lineHeight: 1.4,
            }}>
              Showing first 2,000 violations. Narrow the scope to see all results.
            </div>
          )}

          {/* Filter tabs */}
          {result.stats.total > 0 && (
            <div style={{ display: "flex", gap: 4, marginBottom: 10 }}>
              {["high", "medium", "low", "all"].map((f) => (
                <button
                  key={f}
                  onClick={() => setFilter(f)}
                  style={{
                    padding: "3px 8px",
                    borderRadius: 4,
                    border: filter === f ? "1px solid #2563eb" : "1px solid var(--color-border, #e2e8f0)",
                    backgroundColor: filter === f ? "#eff6ff" : "transparent",
                    color: filter === f ? "#1e40af" : "var(--color-text, #6b7280)",
                    fontSize: 11,
                    fontWeight: filter === f ? 600 : 400,
                    cursor: "pointer",
                    textTransform: "capitalize",
                  }}
                >
                  {f}
                </button>
              ))}
            </div>
          )}

          {/* Grouped findings */}
          {filteredGroups.map((group) => {
            const isAccepted = comp.isGroupAccepted(complianceState, group.ruleId);
            const isRejected = comp.isGroupRejected(complianceState, group.ruleId);
            const isExpanded = expandedGroups.has(group.ruleId);
            const isWhyOpen = expandedWhy.has(group.ruleId);
            const colors = SEVERITY_COLORS[group.severity] || SEVERITY_COLORS.medium;
            const hasFix = group.instances.some((v) => v.fixFn !== null);

            return (
              <div
                key={group.ruleId}
                onClick={(e) => {
                  if (e.target.closest("button")) return;
                  setActiveGroup(group.ruleId);
                }}
                style={{
                  marginBottom: 8,
                  border: activeGroup === group.ruleId
                    ? `2px solid ${colors.badge}`
                    : `1px solid ${colors.border}33`,
                  borderRadius: 6,
                  backgroundColor: isAccepted || isRejected ? "var(--color-surface, #f8f8f8)" : "var(--color-surface, white)",
                  opacity: isAccepted || isRejected ? 0.5 : 1,
                  overflow: "hidden",
                  cursor: "pointer",
                }}
              >
                {/* Group header */}
                <div style={{ padding: "8px 10px", borderBottom: isExpanded ? `1px solid ${colors.border}22` : "none" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      {isAccepted && <span style={{ color: "#16a34a" }}>✓</span>}
                      {isRejected && <span style={{ color: "#dc2626" }}>✗</span>}
                      <span
                        style={{
                          fontSize: 10,
                          fontWeight: 700,
                          padding: "1px 5px",
                          borderRadius: 3,
                          backgroundColor: colors.badge,
                          color: "white",
                        }}
                      >
                        {group.ruleId}
                      </span>
                      <span style={{ fontSize: 12, fontWeight: 600, color: "var(--color-text, #334155)" }}>
                        ({group.instances.length})
                      </span>
                    </div>
                  </div>

                  {/* Representative context */}
                  {group.representative && (
                    <div
                      style={{
                        fontSize: 12,
                        color: "var(--color-text, #475569)",
                        lineHeight: 1.5,
                        padding: "4px 0",
                        borderLeft: `2px solid ${colors.border}`,
                        paddingLeft: 8,
                        marginBottom: 6,
                        cursor: "pointer",
                      }}
                      onClick={(e) => {
                        e.stopPropagation();
                        setActiveGroup(group.ruleId);
                        scrollToBlockHighlight(group.representative.blockId);
                      }}
                    >
                      {group.representative.sentence}
                    </div>
                  )}

                  {/* Why? toggle */}
                  <div
                    onClick={() => toggleWhy(group.ruleId)}
                    style={{
                      fontSize: 11,
                      color: "#6b7280",
                      cursor: "pointer",
                      marginBottom: 6,
                    }}
                  >
                    {isWhyOpen ? "▾" : "▸"} Why?
                  </div>

                  {isWhyOpen && (
                    <div
                      style={{
                        fontSize: 11,
                        color: "var(--color-text, #475569)",
                        lineHeight: 1.5,
                        padding: "6px 8px",
                        backgroundColor: colors.bg,
                        borderRadius: 4,
                        marginBottom: 6,
                      }}
                    >
                      <div style={{ fontWeight: 600, marginBottom: 2 }}>{group.ufsRef}</div>
                      {group.message}
                    </div>
                  )}

                  {/* Action buttons */}
                  {!isAccepted && !isRejected && (
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                      {hasFix && (
                        <button
                          onMouseDown={(e) => e.stopPropagation()}
                          onClick={(e) => { e.stopPropagation(); e.preventDefault(); handleAcceptGroup(group); }}
                          style={{
                            padding: "6px 12px",
                            borderRadius: 4,
                            border: "1px solid #16a34a33",
                            backgroundColor: "#f0fdf4",
                            color: "#16a34a",
                            fontSize: 12,
                            fontWeight: 600,
                            cursor: "pointer",
                            minHeight: 32,
                          }}
                        >
                          Accept All {group.instances.filter((v) => v.fixFn !== null).length}
                        </button>
                      )}
                      <button
                        onMouseDown={(e) => e.stopPropagation()}
                        onClick={(e) => { e.stopPropagation(); e.preventDefault(); handleRejectGroup(group); }}
                        style={{
                          padding: "6px 12px",
                          borderRadius: 4,
                          border: "1px solid #dc262633",
                          backgroundColor: "#fef2f2",
                          color: "#dc2626",
                          fontSize: 12,
                          fontWeight: 600,
                          cursor: "pointer",
                          minHeight: 32,
                        }}
                      >
                        Reject All
                      </button>
                      {group.instances.length > 1 && (
                        <button
                          onMouseDown={(e) => e.stopPropagation()}
                          onClick={(e) => { e.stopPropagation(); toggleGroup(group.ruleId); }}
                          style={{
                            padding: "6px 12px",
                            borderRadius: 4,
                            border: "1px solid var(--color-border, #e2e8f0)",
                            backgroundColor: "transparent",
                            color: "var(--color-text, #6b7280)",
                            fontSize: 12,
                            cursor: "pointer",
                            minHeight: 32,
                          }}
                        >
                          {isExpanded ? "Collapse" : `View All ${group.instances.length} ▸`}
                        </button>
                      )}
                      {!hasFix && (
                        <span style={{ fontSize: 10, color: "#6b7280", alignSelf: "center" }}>
                          Needs AI rewrite
                        </span>
                      )}
                    </div>
                  )}
                </div>

                {/* Expanded individual instances */}
                {isExpanded && (
                  <div style={{ padding: "0 10px 8px" }}>
                    {group.instances.map((v) => {
                      const itemAccepted = comp.isItemAccepted(complianceState, v.blockId, v.index);
                      const itemRejected = comp.isItemRejected(complianceState, v.blockId, v.index);

                      return (
                        <div
                          key={`${v.blockId}-${v.index}`}
                          style={{
                            padding: "6px 8px",
                            marginTop: 6,
                            borderRadius: 4,
                            backgroundColor: itemAccepted
                              ? "#f0fdf4"
                              : itemRejected
                              ? "#fef2f2"
                              : "var(--color-surface, #f8fafc)",
                            border: "1px solid var(--color-border, #e2e8f0)",
                            opacity: itemAccepted || itemRejected ? 0.5 : 1,
                            fontSize: 11,
                          }}
                        >
                          <div
                            style={{ cursor: "pointer", color: "var(--color-text, #475569)", lineHeight: 1.4 }}
                            onClick={(e) => {
                              e.stopPropagation();
                              setActiveGroup(group.ruleId);
                              scrollToBlockHighlight(v.blockId);
                            }}
                          >
                            {v.sentence}
                          </div>
                          {!itemAccepted && !itemRejected && !isAccepted && !isRejected && (
                            <div style={{ display: "flex", gap: 4, marginTop: 4 }}>
                              {v.fixFn !== null && (
                                <button
                                  onClick={() => handleAcceptItem(v)}
                                  style={{
                                    padding: "2px 6px",
                                    borderRadius: 3,
                                    border: "1px solid #16a34a33",
                                    backgroundColor: "#f0fdf4",
                                    color: "#16a34a",
                                    fontSize: 10,
                                    cursor: "pointer",
                                  }}
                                >
                                  ✓ Accept
                                </button>
                              )}
                              <button
                                onClick={() => handleRejectItem(v)}
                                style={{
                                  padding: "2px 6px",
                                  borderRadius: 3,
                                  border: "1px solid #dc262633",
                                  backgroundColor: "#fef2f2",
                                  color: "#dc2626",
                                  fontSize: 10,
                                  cursor: "pointer",
                                }}
                              >
                                ✗ Reject
                              </button>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}

          {/* AI batch section */}
          {needsAICount > 0 && (
            <div
              style={{
                marginTop: 12,
                padding: "10px 12px",
                backgroundColor: "#faf5ff",
                border: "1px solid #c084fc33",
                borderRadius: 6,
              }}
            >
              <div style={{ fontWeight: 600, fontSize: 12, color: "#7c3aed", marginBottom: 4 }}>
                AI Rewrite Needed
              </div>
              <div style={{ fontSize: 11, color: "#6b21a8", lineHeight: 1.4, marginBottom: 8 }}>
                {needsAICount} violations need AI rewrite (vague language, complex restructuring).
              </div>

              {aiRunning ? (
                <div style={{ fontSize: 11, color: "#7c3aed" }}>
                  <span style={{ animation: "spin 1s linear infinite", display: "inline-block" }}>⟳</span>
                  {" "}Processing{aiProgress ? ` chunk ${aiProgress.chunk}/${aiProgress.totalChunks}` : ""}...
                  <button
                    onClick={handleAICancel}
                    style={{
                      marginLeft: 8, padding: "2px 8px", borderRadius: 4,
                      border: "1px solid #dc262633", backgroundColor: "#fef2f2",
                      color: "#dc2626", fontSize: 10, cursor: "pointer",
                    }}
                  >
                    Cancel
                  </button>
                </div>
              ) : getApiKey() ? (
                <button
                  onClick={handleAIFixAll}
                  style={{
                    padding: "6px 12px", borderRadius: 4, border: "none",
                    backgroundColor: "#7c3aed", color: "white", fontWeight: 600,
                    fontSize: 12, cursor: "pointer", width: "100%",
                  }}
                >
                  Fix All {needsAICount} with AI
                </button>
              ) : (
                <button
                  onClick={() => setShowSettings(true)}
                  style={{
                    padding: "6px 12px", borderRadius: 4,
                    border: "1px solid #7c3aed33", backgroundColor: "transparent",
                    color: "#7c3aed", fontWeight: 600, fontSize: 12,
                    cursor: "pointer", width: "100%",
                  }}
                >
                  Configure API Key to enable AI fixes
                </button>
              )}

              {aiError && (
                <div style={{ fontSize: 11, color: "#dc2626", marginTop: 6, lineHeight: 1.3 }}>
                  ✗ {aiError}
                </div>
              )}
            </div>
          )}

          {/* Footer: session tokens + settings */}
          {result && result.stats.total > 0 && (
            <div style={{
              marginTop: 12, paddingTop: 8,
              borderTop: "1px solid var(--color-border, #e2e8f0)",
              display: "flex", justifyContent: "space-between", alignItems: "center",
              fontSize: 10, color: "var(--color-text, #6b7280)",
            }}>
              {sessionTokens > 0 && (
                <span>Tokens: ~{sessionTokens.toLocaleString()} (~${estimateCost(sessionTokens).toFixed(4)})</span>
              )}
              <button
                onClick={() => setShowSettings(true)}
                style={{
                  border: "none", background: "transparent",
                  color: "var(--color-text, #6b7280)", cursor: "pointer",
                  fontSize: 11, marginLeft: "auto",
                }}
              >
                ⚙ Settings
              </button>
            </div>
          )}
        </>
      )}

      {/* Settings Modal */}
      {showSettings && (
        <ComplianceSettings onClose={() => setShowSettings(false)} />
      )}
    </div>
  );
}
