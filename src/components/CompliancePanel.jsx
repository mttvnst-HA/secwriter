import { useState, useCallback, useMemo, useEffect, useRef } from "react";
import { checkCompliance } from "../lib/compliance-checker.js";
import { computeComplianceDiff } from "../lib/compliance-diff.js";
import { getApiKey, requestAIRewrite, estimateTokens, estimateCost } from "../lib/compliance-ai.js";
import ComplianceSettings from "./ComplianceSettings.jsx";

const SEVERITY_COLORS = {
  high: { bg: "#fef2f2", border: "#ef4444", text: "#991b1b", badge: "#dc2626" },
  medium: { bg: "#fffbeb", border: "#f59e0b", text: "#92400e", badge: "#d97706" },
  low: { bg: "#eff6ff", border: "#3b82f6", text: "#1e40af", badge: "#2563eb" },
};

export default function CompliancePanel({
  blocks,
  focusedBlockId,
  onAcceptFix,
  onAcceptGroupFix,
  onScrollToBlock,
  trackChanges,
  unitDisplay,
}) {
  const [scope, setScope] = useState("document");
  const [result, setResult] = useState(null); // { violations, groups, stats }
  const [filter, setFilter] = useState("high");
  const [expandedGroups, setExpandedGroups] = useState(new Set());
  const [expandedWhy, setExpandedWhy] = useState(new Set());
  const [activeGroup, setActiveGroup] = useState(null); // ruleId of currently selected group
  const [acceptedGroups, setAcceptedGroups] = useState(new Set());
  const [rejectedGroups, setRejectedGroups] = useState(new Set());
  const [acceptedItems, setAcceptedItems] = useState(new Set()); // individual block violations
  const [rejectedItems, setRejectedItems] = useState(new Set());
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiProgress, setAiProgress] = useState(null);
  const [aiError, setAiError] = useState(null);
  const [sessionTokens, setSessionTokens] = useState(0);
  const abortRef = useRef(null);

  // First-run onboarding
  useEffect(() => {
    if (!localStorage.getItem("sim-compliance-onboarded")) {
      setShowOnboarding(true);
    }
  }, []);

  const dismissOnboarding = useCallback(() => {
    setShowOnboarding(false);
    localStorage.setItem("sim-compliance-onboarded", "1");
  }, []);

  // Clear all compliance highlights from the DOM
  const clearHighlights = useCallback(() => {
    document.querySelectorAll('.compliance-highlight').forEach(el => {
      const parent = el.parentNode;
      if (parent) {
        parent.replaceChild(document.createTextNode(el.textContent), el);
        parent.normalize();
      }
    });
  }, []);

  // Apply highlights for a group's violations, optionally scroll to a specific block
  const applyHighlights = useCallback((group, scrollToBlockId) => {
    clearHighlights();

    for (const v of group.instances) {
      const blockEl = document.querySelector(`[data-block-id="${v.blockId}"]`);
      if (!blockEl) continue;

      const walker = document.createTreeWalker(blockEl, NodeFilter.SHOW_TEXT, null);
      const matchLower = v.match.toLowerCase();
      const nodesToProcess = [];

      let node;
      while ((node = walker.nextNode())) {
        if (node.parentElement?.closest?.('del.mark-del')) continue;
        if (node.parentElement?.closest?.('.compliance-highlight')) continue;
        const text = node.textContent.toLowerCase();
        let searchFrom = 0;
        let idx;
        while ((idx = text.indexOf(matchLower, searchFrom)) >= 0) {
          // Check word boundaries to avoid substring matches
          // (e.g., "contract" should not match inside "Contractor")
          const charBefore = idx > 0 ? text[idx - 1] : '';
          const charAfter = idx + matchLower.length < text.length ? text[idx + matchLower.length] : '';
          const isWordBoundaryBefore = !charBefore || !/[a-z]/i.test(charBefore);
          const isWordBoundaryAfter = !charAfter || !/[a-z]/i.test(charAfter);
          if (isWordBoundaryBefore && isWordBoundaryAfter) {
            nodesToProcess.push({ node, idx, matchLen: v.match.length });
            break; // One highlight per text node per violation
          }
          searchFrom = idx + 1;
        }
      }

      for (let i = nodesToProcess.length - 1; i >= 0; i--) {
        const { node: textNode, idx, matchLen } = nodesToProcess[i];
        try {
          const range = document.createRange();
          range.setStart(textNode, idx);
          range.setEnd(textNode, idx + matchLen);
          const highlight = document.createElement('span');
          highlight.className = 'compliance-highlight';
          range.surroundContents(highlight);
        } catch { /* skip if range is invalid */ }
      }
    }

    // Scroll to specific block if provided, otherwise first highlight
    if (scrollToBlockId) {
      const targetBlock = document.querySelector(`[data-block-id="${scrollToBlockId}"]`);
      const targetHighlight = targetBlock?.querySelector('.compliance-highlight');
      if (targetHighlight) {
        targetHighlight.scrollIntoView({ behavior: 'smooth', block: 'center' });
      } else if (targetBlock) {
        targetBlock.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    } else {
      const firstHighlight = document.querySelector('.compliance-highlight');
      if (firstHighlight) {
        firstHighlight.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }
  }, [clearHighlights]);

  // When activeGroup changes, apply highlights
  const prevActiveGroupRef = useRef(null);
  useEffect(() => {
    if (!activeGroup || !result) {
      clearHighlights();
      prevActiveGroupRef.current = null;
      return;
    }

    const group = result.groups.find(g => g.ruleId === activeGroup);
    if (!group) return;

    // Only scroll on initial activation (not re-renders of same group)
    const isNewGroup = prevActiveGroupRef.current !== activeGroup;
    prevActiveGroupRef.current = activeGroup;

    if (isNewGroup) {
      applyHighlights(group, null); // scroll to first match
    }

    return () => clearHighlights();
  }, [activeGroup, result, applyHighlights, clearHighlights]);

  // Run compliance check (async — yields to browser to prevent "Page Unresponsive")
  const [checking, setChecking] = useState(false);
  const handleRunCheck = useCallback(async () => {
    setChecking(true);
    const anchorId = scope === "document" ? null : focusedBlockId;
    const res = await checkCompliance(blocks, scope, anchorId, { unitDisplay });
    setResult(res);
    setFilter("high");
    setExpandedGroups(new Set());
    setExpandedWhy(new Set());
    setAcceptedGroups(new Set());
    setRejectedGroups(new Set());
    setAcceptedItems(new Set());
    setRejectedItems(new Set());
    setChecking(false);
  }, [blocks, scope, focusedBlockId, unitDisplay]);

  // Auto-fix all formatting violations — apply fixFn to block HTML
  const handleAutoFixFmt = useCallback(() => {
    if (!result) return;
    const fmtViolations = result.violations.filter(
      (v) => v.category === "formatting" && v.fixFn !== null
    );
    if (fmtViolations.length === 0) return;

    // Collect unique block IDs and their fix functions
    const fixFnByBlock = new Map();
    for (const v of fmtViolations) {
      if (!fixFnByBlock.has(v.blockId)) {
        fixFnByBlock.set(v.blockId, []);
      }
      fixFnByBlock.get(v.blockId).push(v.fixFn);
    }

    // Apply all fix functions to each block's HTML
    const fixesByBlock = new Map();
    for (const [blockId, fixFns] of fixFnByBlock) {
      const block = blocks.find(b => b.id === blockId);
      if (!block?.html) continue;
      let html = block.html;
      for (const fn of fixFns) {
        try {
          const result = fn(html);
          if (result !== null) html = result;
        } catch { /* skip */ }
      }
      if (html !== block.html) {
        fixesByBlock.set(blockId, html);
      }
    }

    if (fixesByBlock.size === 0) return;

    onAcceptGroupFix(fixesByBlock, `Compliance: auto-fixed ${fmtViolations.length} formatting items`);

    // Mark formatting groups as accepted
    const fmtGroupIds = result.groups
      .filter((g) => g.category === "formatting")
      .map((g) => g.ruleId);
    setAcceptedGroups((prev) => {
      const next = new Set(prev);
      fmtGroupIds.forEach((id) => next.add(id));
      return next;
    });
  }, [result, blocks, onAcceptGroupFix]);

  // Accept all instances in a group — apply fix function to block HTML
  const handleAcceptGroup = useCallback(
    (group) => {
      const fixableInstances = group.instances.filter((v) => v.fixFn !== null);
      if (fixableInstances.length === 0) return;

      // Collect unique block IDs that need fixing
      const blockIdsToFix = [...new Set(fixableInstances.map(v => v.blockId))];

      // Build a map of blockId → fixFn (use the first instance's fixFn per block — they're the same rule)
      const fixFnByBlock = new Map();
      for (const v of fixableInstances) {
        if (!fixFnByBlock.has(v.blockId)) {
          fixFnByBlock.set(v.blockId, v.fixFn);
        }
      }

      // Apply fixFn to each block's HTML
      const fixesByBlock = new Map();
      for (const blockId of blockIdsToFix) {
        const block = blocks.find(b => b.id === blockId);
        if (!block?.html) continue;
        const fixFn = fixFnByBlock.get(blockId);
        if (!fixFn) continue;
        try {
          const fixedHtml = fixFn(block.html);
          if (fixedHtml !== null && fixedHtml !== block.html) {
            fixesByBlock.set(blockId, fixedHtml);
          }
        } catch { /* skip blocks where fix fails */ }
      }

      if (fixesByBlock.size === 0) return;

      onAcceptGroupFix(
        fixesByBlock,
        `Compliance: accepted ${fixesByBlock.size} "${group.representative?.match || group.ruleId}" fixes`
      );
      setAcceptedGroups((prev) => new Set(prev).add(group.ruleId));
      setActiveGroup(null); // clear highlights
    },
    [onAcceptGroupFix, blocks]
  );

  // Reject all in a group
  const handleRejectGroup = useCallback((group) => {
    setRejectedGroups((prev) => new Set(prev).add(group.ruleId));
    setActiveGroup(null); // clear highlights
  }, []);

  // Accept individual instance — apply fixFn to block HTML
  const handleAcceptItem = useCallback(
    (violation) => {
      if (!violation.fixFn) return;
      const block = blocks.find(b => b.id === violation.blockId);
      if (!block?.html) return;
      try {
        const fixedHtml = violation.fixFn(block.html);
        if (fixedHtml !== null && fixedHtml !== block.html) {
          onAcceptFix(violation.blockId, fixedHtml);
        }
      } catch { return; }
      setAcceptedItems((prev) => new Set(prev).add(`${violation.blockId}-${violation.index}`));
    },
    [onAcceptFix, blocks]
  );

  // Reject individual instance
  const handleRejectItem = useCallback((violation) => {
    setRejectedItems((prev) => new Set(prev).add(`${violation.blockId}-${violation.index}`));
  }, []);

  // AI batch rewrite
  const handleAIFixAll = useCallback(async () => {
    const apiKey = getApiKey();
    if (!apiKey) {
      setShowSettings(true);
      return;
    }
    if (!result) return;

    const aiViolations = result.violations.filter(v => v.fixFn === null);
    if (aiViolations.length === 0) return;

    const tokens = estimateTokens(blocks, aiViolations);
    const cost = estimateCost(tokens);
    const proceed = window.confirm(
      `AI rewrite will process ${aiViolations.length} violations.\nEstimated: ~${tokens.toLocaleString()} tokens (~$${cost.toFixed(4)})\n\nProceed?`
    );
    if (!proceed) return;

    setAiLoading(true);
    setAiError(null);
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const { rewrites, tokensUsed } = await requestAIRewrite(
        blocks, aiViolations, apiKey, {
          model: localStorage.getItem('sim-compliance-model') || 'claude-sonnet-4-20250514',
          abortSignal: controller.signal,
          onProgress: setAiProgress,
        }
      );

      setSessionTokens(prev => prev + tokensUsed);

      // Apply rewrites as proposed fixes
      if (rewrites.length > 0) {
        const fixesByBlock = new Map();
        for (const r of rewrites) {
          fixesByBlock.set(r.blockId, r.proposed);
        }
        onAcceptGroupFix(fixesByBlock, `Compliance AI: rewrote ${rewrites.length} blocks`);
      }
    } catch (err) {
      if (err.name !== 'AbortError') {
        setAiError(err.message);
      }
    } finally {
      setAiLoading(false);
      setAiProgress(null);
      abortRef.current = null;
    }
  }, [result, blocks, onAcceptGroupFix]);

  const handleAICancel = useCallback(() => {
    if (abortRef.current) abortRef.current.abort();
  }, []);

  // Toggle expanded group (accordion — only one open at a time)
  const toggleGroup = useCallback((ruleId) => {
    setExpandedGroups((prev) => {
      if (prev.has(ruleId)) return new Set(); // collapse if already open
      return new Set([ruleId]); // open this one, close all others
    });
  }, []);

  // Toggle "Why?" section
  const toggleWhy = useCallback((ruleId) => {
    setExpandedWhy((prev) => {
      const next = new Set(prev);
      if (next.has(ruleId)) next.delete(ruleId);
      else next.add(ruleId);
      return next;
    });
  }, []);

  // Filtered groups
  const filteredGroups = useMemo(() => {
    if (!result) return [];
    if (filter === "all") return result.groups;
    return result.groups.filter((g) => g.severity === filter);
  }, [result, filter]);

  // Counts for summary
  const fmtCount = useMemo(() => {
    if (!result) return 0;
    return result.violations.filter((v) => v.category === "formatting" && v.fixFn !== null).length;
  }, [result]);

  const needsAICount = useMemo(() => {
    if (!result) return 0;
    return result.violations.filter((v) => v.fixFn === null).length;
  }, [result]);

  // Severity bar percentages
  const barPcts = useMemo(() => {
    if (!result || result.stats.total === 0) return { high: 0, medium: 0, low: 0 };
    const t = result.stats.total;
    return {
      high: (result.stats.high / t) * 100,
      medium: (result.stats.medium / t) * 100,
      low: (result.stats.low / t) * 100,
    };
  }, [result]);

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
                {fmtCount > 0 && !acceptedGroups.has("FMT-001") && (
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
            const isAccepted = acceptedGroups.has(group.ruleId);
            const isRejected = rejectedGroups.has(group.ruleId);
            const isExpanded = expandedGroups.has(group.ruleId);
            const isWhyOpen = expandedWhy.has(group.ruleId);
            const colors = SEVERITY_COLORS[group.severity] || SEVERITY_COLORS.medium;
            const hasFix = group.instances.some((v) => v.fixFn !== null);

            return (
              <div
                key={group.ruleId}
                onClick={(e) => {
                  // Don't toggle if clicking a button inside the card
                  if (e.target.closest('button')) return;
                  // Set this group as active (clicking same group keeps it active — no toggle off)
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
                        applyHighlights(group, group.representative.blockId);
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
                    {group.instances.map((v, idx) => {
                      const itemKey = `${v.blockId}-${v.index}`;
                      const itemAccepted = acceptedItems.has(itemKey);
                      const itemRejected = rejectedItems.has(itemKey);

                      return (
                        <div
                          key={itemKey}
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
                              // Re-apply highlights and scroll to this specific block
                              const group = result?.groups.find(g => g.ruleId === v.ruleId);
                              if (group) applyHighlights(group, v.blockId);
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

              {aiLoading ? (
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
