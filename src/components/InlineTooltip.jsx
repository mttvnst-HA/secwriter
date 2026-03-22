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
export default function InlineTooltip({ finding, blockId, onFix, onDismiss, blockEl }) {
  const [showWhy, setShowWhy] = useState(false);
  const tooltipRef = useRef(null);
  const [pos, setPos] = useState(null);

  // Position the tooltip near the cursor
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

      // Position above the highlighted text
      let top = rect.top - 8;
      let left = rect.left + rect.width / 2;

      // Viewport bounds checking
      const tooltipWidth = 320;
      const tooltipHeight = 100;

      // Keep within horizontal bounds
      if (left - tooltipWidth / 2 < 8) left = tooltipWidth / 2 + 8;
      if (left + tooltipWidth / 2 > window.innerWidth - 8) left = window.innerWidth - tooltipWidth / 2 - 8;

      // If not enough room above, show below
      if (top - tooltipHeight < 8) {
        top = rect.bottom + 8;
      }

      setPos({ top, left });
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
      const fixedHtml = violation.fixFn(currentHtml, violation.match, violation.replacement);
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
        transform: 'translate(-50%, -100%)',
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
        }}>"{violation.match}"</code>
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
      <div style={{ marginTop: 8, marginLeft: 14, display: 'flex', gap: 6, alignItems: 'center' }}>
        {hasFix ? (
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
        ) : (
          <span style={{ fontSize: 11, color: '#94a3b8', fontStyle: 'italic' }}>
            Use Compliance Panel for AI fix
          </span>
        )}
      </div>
    </div>
  );
}
