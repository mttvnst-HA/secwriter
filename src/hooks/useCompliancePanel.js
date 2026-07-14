/**
 * useCompliancePanel — App's compliance-panel intent (architecture-review
 * candidate #1, slice 4a).
 *
 * Re-grill note: the backlog scoped a single `useReviewPanels` bundling
 * comments + compliance + lint. Comments already extracted on their own
 * (useComments). The remaining "lint + compliance" pair is NOT one module —
 * the coupling map splits it along the collab axis:
 *
 *   - `lintingState` is collab-published DOCUMENT state (same lifecycle as
 *     blocks/comments/tc): read OUT by useCollabSession (3 publish slices —
 *     byBlock sidecar, ignored.findings, ignored.mutedRules), by useFileSession
 *     (sidecar export), and by useBlockLinting's per-keystroke raw `dispatch`;
 *     written IN by 4 peer remote-merge callbacks. It is a custodian-hook
 *     concern (a later slice mirroring useComments), NOT a panel.
 *   - `complianceState` is genuinely PRIVATE: `comp.createInitial()`, an
 *     ephemeral scan result. NOT collab-published, NOT file-exported. Read only
 *     by the toolbar toggle, the CompliancePanel render, and the highlight+
 *     scroll effect below. Its ONLY wire to lint is `complianceOpen` driving
 *     the 1-line `linting.setSuspended` effect — which stays in App (a lint
 *     write) reading this hook's `complianceOpen`.
 *
 * So compliance extracts here as the deep, self-contained half; lint stays in
 * App pending its own custodian slice.
 *
 * Owns: `complianceOpen` (panel visibility), `complianceState` (scan reducer
 * state), `lastComplianceScrollRef` (scroll-gate), and the CSS Custom Highlight
 * effect that paints `compliance-active` ranges + scrolls the active group into
 * view. The effect is co-located with the state it reads; it touches only the
 * `compliance-active` highlight key (disjoint from linting's compliance-error /
 * grammar-error / passive-voice keys), so its declaration-order relative to the
 * lint-highlight effect is immaterial — verified against a production build per
 * CLAUDE.md Rule #12 (StrictMode masks single-invoke effect-order bugs).
 *
 * Injected (App-owned): `blocks` — a dep so PM-driven DOM rewrites (which
 * detach the Range-anchored text nodes) trigger a fresh range build.
 *
 * Returned setters (`setComplianceOpen`, `setComplianceState`) are consumed by
 * App: the toolbar toggle flips `complianceOpen` (mutually exclusive with the
 * comments panel), and CompliancePanel drives `setComplianceState` as
 * `dispatchCompliance`.
 */
import { useState, useEffect, useRef } from 'react';
import * as comp from '../lib/compliance.js';
import { findHighlightTargetsInBlock } from '../lib/compliance-ranges.js';
import { getBlockDom } from '../lib/block-registry.js';

export function useCompliancePanel({ blocks }) {
  const [complianceOpen, setComplianceOpen] = useState(false);
  const [complianceState, setComplianceState] = useState(() => comp.createInitial());

  // Compliance highlight via CSS Custom Highlight API. Mirrors the linting
  // tier-effect pattern in App. Building Range objects (instead of injecting
  // spans) keeps the highlights stable across PM EditorView re-renders —
  // PM's view tear-down would have clobbered injected DOM. Computing the
  // targets is pure (compliance-ranges.js); the side effect lives here.
  //
  // `blocks` is in the dep array so PM-driven DOM rewrites (which detach the
  // text nodes our Range objects anchor to) trigger a fresh range build. But
  // scroll must NOT re-fire on every typing pause — only on panel open,
  // active group change, or fresh scan. The ref below gates the scroll
  // against (open, group, result) so block-only re-runs skip the scrollTo.
  const lastComplianceScrollRef = useRef({ open: false, group: null, result: null });
  useEffect(() => {
    if (typeof document === 'undefined') return;
    if (typeof CSS === 'undefined' || !CSS.highlights) return;
    const clear = () => CSS.highlights.delete('compliance-active');

    const prev = lastComplianceScrollRef.current;
    const triggerScroll = complianceOpen && (
      prev.open !== complianceOpen
      || prev.group !== complianceState.activeGroup
      || prev.result !== complianceState.result
    );
    lastComplianceScrollRef.current = {
      open: complianceOpen,
      group: complianceState.activeGroup,
      result: complianceState.result,
    };

    if (!complianceOpen) { clear(); return; }
    const group = comp.getActiveGroupObject(complianceState);
    if (!group || !Array.isArray(group.instances)) { clear(); return; }
    const ranges = [];
    let firstRange = null;
    for (const v of group.instances) {
      const blockEl = getBlockDom(v.blockId)
        || document.querySelector(/* allowed: block-registry fallback */ `[data-block-id="${v.blockId}"]`);
      if (!blockEl) continue;
      const targets = findHighlightTargetsInBlock(blockEl, v.match);
      for (const t of targets) {
        try {
          const range = document.createRange();
          range.setStart(t.textNode, t.startOffset);
          range.setEnd(t.textNode, t.startOffset + t.length);
          ranges.push(range);
          if (!firstRange) firstRange = range;
        } catch { /* invalid range — skip */ }
      }
    }
    if (ranges.length > 0) {
      CSS.highlights.set('compliance-active', new Highlight(...ranges));
      if (triggerScroll && firstRange && typeof firstRange.getBoundingClientRect === 'function') {
        const rect = firstRange.getBoundingClientRect();
        if (rect && (rect.top || rect.bottom)) {
          window.scrollTo({
            top: window.scrollY + rect.top - window.innerHeight / 2,
            behavior: 'smooth',
          });
        }
      }
    } else {
      clear();
    }
    return clear;
  }, [complianceOpen, complianceState.activeGroup, complianceState.result, blocks]);

  return { complianceOpen, setComplianceOpen, complianceState, setComplianceState };
}
