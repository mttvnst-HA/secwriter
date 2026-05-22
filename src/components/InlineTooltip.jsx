import { useState, useEffect, useRef, useCallback } from "react";

/**
 * InlineTooltip — floating tooltip for inline linting findings.
 *
 * Appears when the cursor (collapsed selection) is inside a highlighted range.
 * Shows violation details, UFS reference, and a "Fix" button if available.
 *
 * Props:
 *   finding    - { range, violation } from findFindingAtCursor()
 *   blockId    - current block ID
 *   onFix      - (blockId, fixedHtml) callback for applying fixes
 *   onDismiss  - () callback to hide tooltip
 *   blockEl    - the contentEditable DOM element (for computing fix text)
 */
export default function InlineTooltip({
  finding, blockId, onFix, onDismiss, blockEl,
  onAddToDictionary, onSuppress, blockHash, onMuteNlpRule,
}) {
  const [showWhy, setShowWhy] = useState(false);
  const tooltipRef = useRef(null);
  const [pos, setPos] = useState(null);  // { top, left, below }
  const [showDismissOnboarding, setShowDismissOnboarding] = useState(false);

  useEffect(() => {
    // Only show on first time a tooltip with a Dismiss button is opened.
    // The gate must match the Dismiss button's render gate below (`onSuppress`
    // function AND `blockHash` string) — otherwise the pop-down "Dismiss is
    // persistent" message appears with no button to click, and the localStorage
    // flag burns silently so the user never sees the message the next time
    // when the button actually exists.
    const seen = typeof window !== 'undefined' && localStorage.getItem('sim-dismiss-onboarded') === '1';
    if (!seen && typeof onSuppress === 'function' && typeof blockHash === 'string' && finding) {
      setShowDismissOnboarding(true);
      localStorage.setItem('sim-dismiss-onboarded', '1');
    }
  }, [finding, onSuppress, blockHash]);

  // Position the tooltip near the cursor, measuring actual height to avoid off-screen
  useEffect(() => {
    if (!finding?.range) {
      setPos(null);
      return;
    }

    try {
      const rect = finding.range.getBoundingClientRect();
      if (!rect || (rect.width === 0 && rect.height === 0)) {
        setPos(null);
        return;
      }

      // Measure actual tooltip height if rendered, else estimate
      const tooltipHeight = tooltipRef.current?.offsetHeight || 120;
      const tooltipWidth = 320;

      let left = rect.left + rect.width / 2;

      // Keep within horizontal bounds
      if (left - tooltipWidth / 2 < 8) left = tooltipWidth / 2 + 8;
      if (left + tooltipWidth / 2 > window.innerWidth - 8) left = window.innerWidth - tooltipWidth / 2 - 8;

      // Prefer positioning below the highlight so the flagged word stays visible.
      // Flip above only if there isn't enough room below.
      let top;
      let below = true;
      if (rect.bottom + tooltipHeight + 8 < window.innerHeight - 8) {
        top = rect.bottom + 8;
      } else if (rect.top - tooltipHeight - 8 > 8) {
        top = rect.top - 8;
        below = false;
      } else {
        // Neither fits fully — fall back to below and let it clip
        top = rect.bottom + 8;
      }

      setPos({ top, left, below });
    } catch {
      setPos(null);
    }
  }, [finding]);

  // Reset "Why?" expansion when finding changes
  useEffect(() => {
    setShowWhy(false);
  }, [finding?.violation?.ruleId]);

  // Escape key dismissal
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onDismiss();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onDismiss]);

  // Click outside dismissal
  useEffect(() => {
    const onClick = (e) => {
      if (tooltipRef.current && !tooltipRef.current.contains(e.target)) {
        onDismiss();
      }
    };
    // Use setTimeout to avoid the click that opened the tooltip from immediately closing it
    const timer = setTimeout(() => {
      document.addEventListener('mousedown', onClick);
    }, 50);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', onClick);
    };
  }, [onDismiss]);

  const handleFix = useCallback(() => {
    if (!finding?.violation || !blockEl || !onFix) return;

    const { violation } = finding;
    if (!violation.fixFn) return;

    try {
      const currentHtml = blockEl.innerHTML;
      const fixedHtml = violation.fixFn(currentHtml, violation.match, violation.replacement, violation.index);
      if (fixedHtml && fixedHtml !== currentHtml) {
        onFix(blockId, fixedHtml);
      }
    } catch {
      // Fix failed silently
    }
    onDismiss();
  }, [finding, blockEl, blockId, onFix, onDismiss]);

  if (!finding || !pos) return null;

  const { violation } = finding;
  const hasFix = !!violation.fixFn;

  // Show "Add to dictionary" for any Harper grammar/spelling finding on a single word.
  const isGrammar = typeof violation.ruleId === 'string' && violation.ruleId.startsWith('GRAMMAR-');
  const isSingleWord = isGrammar && /^[A-Za-z][A-Za-z'-]*$/.test(violation.match || '');
  const canAddToDict = isSingleWord && typeof onAddToDictionary === 'function';

  const isNlp = typeof violation.ruleId === 'string' && violation.ruleId.startsWith('NLP-');
  const canMute = isNlp && typeof onMuteNlpRule === 'function';

  const handleAddToDict = () => {
    if (!canAddToDict) return;
    try {
      onAddToDictionary(violation.match);
    } catch {
      // ignore
    }
    onDismiss();
  };

  // Compute replacement text for display if not explicitly set
  let displayReplacement = violation.replacement || null;
  if (!displayReplacement && hasFix && blockEl) {
    try {
      const currentHtml = blockEl.innerHTML;
      const fixedHtml = violation.fixFn(currentHtml, violation.match, violation.replacement, violation.index);
      if (fixedHtml && fixedHtml !== currentHtml) {
        // Extract what changed: find the difference around the match
        const matchIdx = currentHtml.indexOf(violation.match);
        if (matchIdx >= 0) {
          // The fix replaced violation.match with something — extract it
          const before = currentHtml.slice(0, matchIdx);
          const after = currentHtml.slice(matchIdx + violation.match.length);
          if (fixedHtml.startsWith(before) && fixedHtml.endsWith(after)) {
            displayReplacement = fixedHtml.slice(before.length, fixedHtml.length - after.length);
          }
        }
      }
    } catch {
      // Computation failed, no preview
    }
  }

  // Severity colors
  const severityColors = {
    high: { dot: '#ef4444', bg: '#fef2f2', border: '#fecaca' },
    medium: { dot: '#f59e0b', bg: '#fffbeb', border: '#fde68a' },
    low: { dot: '#3b82f6', bg: '#eff6ff', border: '#bfdbfe' },
  };
  const colors = severityColors[violation.severity] || severityColors.medium;

  return (
    <div
      ref={tooltipRef}
      onMouseDown={(e) => e.preventDefault()}
      style={{
        position: 'fixed',
        top: pos.top,
        left: pos.left,
        transform: pos.below ? 'translate(-50%, 0)' : 'translate(-50%, -100%)',
        maxWidth: 320,
        minWidth: 200,
        padding: '8px 12px',
        backgroundColor: colors.bg,
        border: `1px solid ${colors.border}`,
        borderRadius: 8,
        boxShadow: '0 4px 16px rgba(0,0,0,0.15)',
        zIndex: 90,
        fontSize: 13,
        lineHeight: 1.4,
        fontFamily: "'Inter', 'Segoe UI', sans-serif",
        cursor: 'default',
        userSelect: 'none',
      }}
    >
      {/* Header: severity dot + message */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6 }}>
        <span style={{
          width: 8,
          height: 8,
          borderRadius: '50%',
          backgroundColor: colors.dot,
          flexShrink: 0,
          marginTop: 4,
        }} />
        <span style={{ color: '#1e293b', fontWeight: 500 }}>
          {violation.message}
        </span>
      </div>

      {/* Match text */}
      <div style={{
        marginTop: 4,
        marginLeft: 14,
        fontSize: 12,
        color: '#64748b',
      }}>
        Found: <code style={{
          backgroundColor: 'rgba(0,0,0,0.06)',
          padding: '1px 4px',
          borderRadius: 3,
          fontFamily: "'SF Mono', Consolas, monospace",
          fontSize: 11,
        }}>"{violation.match.length > 40 ? violation.match.slice(0, 37) + '...' : violation.match}"</code>
      </div>

      {/* Why? expandable */}
      {violation.ufsRef && (
        <div style={{ marginTop: 4, marginLeft: 14 }}>
          <button
            onClick={() => setShowWhy(!showWhy)}
            onMouseDown={(e) => e.preventDefault()}
            style={{
              background: 'none',
              border: 'none',
              color: '#2563eb',
              fontSize: 12,
              cursor: 'pointer',
              padding: 0,
              textDecoration: 'underline',
              fontFamily: 'inherit',
            }}
          >
            {showWhy ? 'Hide' : 'Why?'}
          </button>
          {showWhy && (
            <div style={{
              marginTop: 4,
              fontSize: 11,
              color: '#475569',
              padding: '4px 8px',
              backgroundColor: 'rgba(0,0,0,0.04)',
              borderRadius: 4,
            }}>
              {violation.ufsRef}
            </div>
          )}
        </div>
      )}

      {/* Action buttons */}
      <div style={{ marginTop: 8, marginLeft: 14, display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        {hasFix ? (
          <>
            <button
              onClick={handleFix}
              onMouseDown={(e) => e.preventDefault()}
              style={{
                padding: '3px 10px',
                fontSize: 12,
                fontWeight: 600,
                backgroundColor: '#10b981',
                color: '#fff',
                border: 'none',
                borderRadius: 4,
                cursor: 'pointer',
                fontFamily: 'inherit',
              }}
            >
              Fix
            </button>
            {displayReplacement && (
              <span style={{ fontSize: 12, color: '#475569' }}>
                <code style={{
                  backgroundColor: 'rgba(16, 185, 129, 0.1)',
                  padding: '1px 4px',
                  borderRadius: 3,
                  fontFamily: "'SF Mono', Consolas, monospace",
                  fontSize: 11,
                  color: '#059669',
                }}>{violation.match}</code>
                {' \u2192 '}
                <code style={{
                  backgroundColor: 'rgba(16, 185, 129, 0.15)',
                  padding: '1px 4px',
                  borderRadius: 3,
                  fontFamily: "'SF Mono', Consolas, monospace",
                  fontSize: 11,
                  color: '#047857',
                  fontWeight: 600,
                }}>{displayReplacement}</code>
              </span>
            )}
          </>
        ) : !canAddToDict ? (
          <span style={{ fontSize: 11, color: '#94a3b8', fontStyle: 'italic' }}>
            Use Compliance Panel for AI fix
          </span>
        ) : null}
        {canAddToDict && (
          <button
            onClick={handleAddToDict}
            onMouseDown={(e) => e.preventDefault()}
            title="Add this word to your custom dictionary"
            style={{
              padding: '3px 10px',
              fontSize: 12,
              fontWeight: 500,
              backgroundColor: '#fff',
              color: '#2563eb',
              border: '1px solid #bfdbfe',
              borderRadius: 4,
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            + Add "{violation.match.length > 20 ? violation.match.slice(0, 17) + '...' : violation.match}" to dictionary
          </button>
        )}
        {/* Persistent Dismiss — survives reload */}
        {typeof onSuppress === 'function' && typeof blockHash === 'string' && (
          <button
            onClick={() => {
              onSuppress(violation.ruleId, blockHash, violation.match);
              onDismiss();
            }}
            onMouseDown={(e) => e.preventDefault()}
            title="Dismiss this specific finding (persists across reload; reset from Settings)"
            style={{
              padding: '3px 10px',
              fontSize: 12,
              fontWeight: 500,
              backgroundColor: '#fff',
              color: '#475569',
              border: '1px solid #cbd5e1',
              borderRadius: 4,
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            Dismiss
          </button>
        )}
        {canMute && (
          <button
            onClick={() => {
              const ok = window.confirm(`Mute ${violation.ruleId} in this document?`);
              if (ok) {
                onMuteNlpRule(violation.ruleId);
                onDismiss();
              }
            }}
            onMouseDown={(e) => e.preventDefault()}
            title={`Suppress all ${violation.ruleId} findings in this document. Reset from Settings.`}
            style={{
              padding: '3px 10px',
              fontSize: 12,
              fontWeight: 500,
              backgroundColor: '#fff',
              color: '#92400e',
              border: '1px solid #fde68a',
              borderRadius: 4,
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            Mute {violation.ruleId}
          </button>
        )}
      </div>
      {showDismissOnboarding && (
        <div style={{
          marginTop: 8,
          padding: '6px 10px',
          backgroundColor: 'rgba(59, 130, 246, 0.1)',
          border: '1px solid #93c5fd',
          borderRadius: 4,
          fontSize: 11,
          color: '#1e3a8a',
        }}>
          💡 Dismiss is persistent — survives reload. Reset from ⚙ Settings.
        </div>
      )}
    </div>
  );
}
