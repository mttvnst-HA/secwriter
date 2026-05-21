/**
 * useBlockLinting — per-block lifecycle hook for inline linting.
 *
 * Owns all DOM-bound and async effects:
 *   - debounced lint cycle on input
 *   - lint on focus
 *   - lint on enable/un-suspend (when block is focused)
 *   - synchronous static-rule + NLP pass
 *   - asynchronous Harper grammar dispatch with stale detection
 *   - lazy-load triggers for Harper + compromise
 *   - undeduped findings stashed in byBlock (dedup runs in getRangesByTier)
 *   - Range creation against the live DOM
 *   - cursor-based tooltip detection (selectionchange + arrow keys)
 *
 * Reads + writes the linting state via the supplied dispatch. CSS.highlights
 * mutation lives in App's top-level effect, fed by `getRangesByTier(state)`.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import {
  extractPlainText,
  createRangeForMatch,
  findFindingAtCursor,
  computeFixedText,
} from '../lib/inline-linter.js';
import {
  setBlockFindings,
  clearBlock,
  getBlockFindings,
  getBlockSeverity,
  getGrammarText,
  isActive,
  isDeferredRule,
  computeIgnoreKey,
} from '../lib/linting.js';
import { fingerprintBlock } from '../lib/lint-sidecar.js';
import { runStaticRules, getRules } from '../lib/compliance-rules.js';
import {
  checkGrammar,
  isGrammarReady,
  initGrammarChecker,
} from '../lib/grammar-checker.js';
import { detectNlpIssues, isNlpReady, preloadNlp } from '../lib/nlp-rules.js';
import { addUserWord } from '../lib/grammar-checker.js';

/** Idle window after the last keystroke before re-linting the focused block. */
export const LINT_DEBOUNCE_MS = 500;

/** Re-lint delay after a fix or blur (DOM has just been replaced). */
const POST_MUTATION_RELINT_MS = 50;

/** Tooltip cursor-position read debounce after selectionchange. */
const TOOLTIP_DEBOUNCE_MS = 100;

/**
 * @param {Object} args
 * @param {() => Element|null} args.getEl — returns the contentEditable DOM node
 * @param {string} args.blockId
 * @param {string} args.blockType
 * @param {boolean} args.editable
 * @param {Object} args.lintingState
 * @param {(updater: (s) => s) => void} args.dispatch — setLintingState
 * @param {(blockId: string, fixedHtml: string) => void} [args.onFix]
 * @param {(node: Element|null, html: string) => void} [args.applyTagLabels]
 *   Called after an inline fix replaces innerHTML, so the block's mark spans
 *   get their `<TAG>` labels re-injected if tag visibility is on.
 * @param {number} [args.elVersion=0]
 *   Monotonically increasing tick the caller bumps whenever `getEl()` would
 *   start returning a different DOM node (e.g. PM EditorView mounted late
 *   after the initial render because yStore was null). PmEditableBlock is
 *   the sole supplier post-1i-b.2; it always passes a non-zero version on
 *   mount.
 * @returns {{
 *   severity: 'high'|'medium'|'low'|null,
 *   tooltipFinding: {range: Range, violation: object} | null,
 *   dismissTooltip: () => void,
 *   applyFix: (blockId: string, fixedHtml: string) => void,
 *   addToDictionary: (word: string) => Promise<void>,
 *   reLintAfterMutation: () => void,
 * }}
 */
export function useBlockLinting({
  getEl,
  blockId,
  blockType,
  editable,
  lintingState,
  dispatch,
  onFix,
  applyTagLabels,
  elVersion = 0,
}) {
  const [tooltipFinding, setTooltipFinding] = useState(null);
  const debounceRef = useRef(null);
  const selTimerRef = useRef(null);
  const isNoteBlock = blockType === 'note';
  const active = isActive(lintingState);

  // Mirror lintingState into a ref so listeners (selectionchange, keyup) read
  // fresh state without forcing the effect to re-bind on every state change.
  const stateRef = useRef(lintingState);
  useEffect(() => { stateRef.current = lintingState; }, [lintingState]);

  // ── Core lint cycle ────────────────────────────────────────────────────────

  const lint = useCallback(() => {
    const el = getEl();
    if (!el || !active) {
      dispatch(s => clearBlock(s, blockId));
      return;
    }
    let plainText;
    try { plainText = extractPlainText(el); } catch { return; }

    // 1. Static UFS rules (synchronous, fast).
    const rules = getRules();
    const allStatic = runStaticRules(plainText, blockId, rules, {
      skipBrackets: true,
      isNoteBlock,
    });
    const complianceViolations = allStatic.filter(v => !isDeferredRule(v));

    // 2. NLP rules — only if compromise is loaded; engines stash unfiltered
    // findings; dedup + ignore-filter runs in getRangesByTier (projection
    // layer) — see #140 / spec §4.3.
    let nlpViolations = [];
    if (isNlpReady()) {
      nlpViolations = detectNlpIssues(plainText, blockId, isNoteBlock);
    } else {
      preloadNlp();
    }

    // Build Range objects against the live DOM and stash sync findings.
    // Clear stale grammar in the same dispatch; if grammar is ready, the snapshot
    // text doubles as the stale-detection key for the upcoming async pass.
    // Findings are emitted with ignoreKey: null placeholder — the async pass below
    // populates real ignoreKeys once fingerprintBlock resolves (spec §6.2).
    const grammarReady = isGrammarReady();
    const complianceFindings = toFindings(el, complianceViolations).map(f => ({ ...f, ignoreKey: null }));
    const nlpFindings = toFindings(el, nlpViolations).map(f => ({ ...f, ignoreKey: null }));
    dispatch(s => setBlockFindings(s, blockId, {
      compliance: complianceFindings,
      nlp: nlpFindings,
      grammar: [],
      grammarText: grammarReady ? plainText : null,
    }));

    // Async hash + per-finding ignoreKey population. Race-safe: el.innerHTML
    // re-check before the second dispatch guards against stale results when the
    // user edits the block during the async window.
    const htmlSnapshot = el.innerHTML;
    (async () => {
      let blockHash;
      try { blockHash = await fingerprintBlock(htmlSnapshot); } catch { return; }
      const cKeys = await Promise.all(complianceFindings.map(f =>
        computeIgnoreKey(f.violation.ruleId, blockHash, f.violation.match)));
      const nKeys = await Promise.all(nlpFindings.map(f =>
        computeIgnoreKey(f.violation.ruleId, blockHash, f.violation.match)));
      if (!el.isConnected || el.innerHTML !== htmlSnapshot) return;  // stale
      dispatch(s => setBlockFindings(s, blockId, {
        compliance: complianceFindings.map((f, i) => ({ ...f, ignoreKey: cKeys[i] })),
        nlp: nlpFindings.map((f, i) => ({ ...f, ignoreKey: nKeys[i] })),
        blockHash,
      }));
    })();

    // 3. Grammar — async; merge results on resolve, abort if stale.
    if (grammarReady) {
      runGrammarPass({ el, plainText, blockId, dispatch });
    } else {
      // Once Harper loads, re-lint this block if it's still focused.
      initGrammarChecker().then(() => {
        const cur = getEl();
        if (cur && cur.isConnected && document.activeElement === cur) {
          lint();
        }
      }).catch(() => {});
    }
  }, [getEl, blockId, isNoteBlock, active, dispatch]);

  // ── Severity (read at render time from state) ─────────────────────────────

  const severity = active ? getBlockSeverity(lintingState, blockId) : null;

  // ── Input + focus + lifecycle wiring ──────────────────────────────────────

  useEffect(() => {
    const el = getEl();
    if (!el || !editable) return;

    if (!active) {
      dispatch(s => clearBlock(s, blockId));
      return;
    }

    const onInput = () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(lint, LINT_DEBOUNCE_MS);
    };
    const onFocus = () => lint();

    el.addEventListener('input', onInput);
    el.addEventListener('focus', onFocus);

    if (document.activeElement === el) lint();

    return () => {
      el.removeEventListener('input', onInput);
      el.removeEventListener('focus', onFocus);
      if (debounceRef.current) clearTimeout(debounceRef.current);
      dispatch(s => clearBlock(s, blockId));
    };
    // intentionally omits getEl/dispatch — those are stable refs from caller scope.
    // elVersion forces re-bind when the caller signals getEl() now returns a
    // different node (PM EditorView mounted post-yStore-sync — QC critical-2).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blockId, editable, lint, active, elVersion]);

  // ── Tooltip cursor tracking ───────────────────────────────────────────────

  useEffect(() => {
    if (!editable) return;

    const checkCursor = () => {
      if (selTimerRef.current) clearTimeout(selTimerRef.current);
      selTimerRef.current = setTimeout(() => {
        const sel = document.getSelection();
        const el = getEl();
        if (!sel || !sel.isCollapsed || !sel.rangeCount) {
          setTooltipFinding(null);
          return;
        }
        if (!el || !el.contains(sel.anchorNode)) {
          setTooltipFinding(null);
          return;
        }
        const findings = getBlockFindings(stateRef.current, blockId);
        setTooltipFinding(findFindingAtCursor(findings, sel.anchorNode, sel.anchorOffset));
      }, TOOLTIP_DEBOUNCE_MS);
    };

    const onKeyUp = (e) => {
      if (
        e.key === 'ArrowLeft' || e.key === 'ArrowRight' ||
        e.key === 'ArrowUp'   || e.key === 'ArrowDown' ||
        e.key === 'Home'      || e.key === 'End'
      ) checkCursor();
    };
    const onInput = () => setTooltipFinding(null);

    document.addEventListener('selectionchange', checkCursor);
    document.addEventListener('keyup', onKeyUp);
    const el = getEl();
    if (el) el.addEventListener('input', onInput);

    return () => {
      document.removeEventListener('selectionchange', checkCursor);
      document.removeEventListener('keyup', onKeyUp);
      if (el) el.removeEventListener('input', onInput);
      if (selTimerRef.current) clearTimeout(selTimerRef.current);
    };
    // lintingState is read inside the listener — re-binding only when editable flips
    // (or elVersion bumps for late PM mount).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editable, blockId, elVersion]);

  const dismissTooltip = useCallback(() => setTooltipFinding(null), []);

  // ── Inline fix: replace DOM, persist, re-lint ─────────────────────────────

  const applyFix = useCallback((id, fixedHtml) => {
    setTooltipFinding(null);
    dispatch(s => clearBlock(s, id));
    const el = getEl();
    if (el) {
      // Sub-PR 1e (#47): PM-owned DOM is re-rendered from state.doc on
      // every dispatch, so innerHTML writes here are clobbered. The PM
      // path persists the fix exclusively through onFix → setBlockHtml,
      // which lands on the substrate and replays back through the
      // ySyncPlugin.
      const isPm = el.getAttribute?.('data-pm-editor') === 'true';
      if (!isPm) {
        el.innerHTML = fixedHtml;
        if (applyTagLabels) applyTagLabels(el, fixedHtml);
      }
    }
    if (onFix) onFix(id, fixedHtml);
    setTimeout(lint, POST_MUTATION_RELINT_MS);
  }, [dispatch, getEl, applyTagLabels, onFix, lint]);

  const addToDictionary = useCallback(async (word) => {
    setTooltipFinding(null);
    try { await addUserWord(word); } catch { /* ignore */ }
    setTimeout(lint, POST_MUTATION_RELINT_MS);
  }, [lint]);

  // Re-lint after blur (caller calls this from their blur handler — DOM may have
  // been replaced by React re-render, invalidating prior Range objects).
  const reLintAfterMutation = useCallback(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    setTooltipFinding(null);
    setTimeout(lint, POST_MUTATION_RELINT_MS);
  }, [lint]);

  return {
    severity,
    tooltipFinding,
    dismissTooltip,
    applyFix,
    addToDictionary,
    reLintAfterMutation,
  };
}

// ── Helpers (module-internal) ───────────────────────────────────────────────

/** Convert a violation array to findings with Range objects against the live DOM. */
function toFindings(el, violations) {
  if (!violations.length) return [];
  const out = [];
  for (const v of violations) {
    const range = createRangeForMatch(el, v.match, v.index);
    if (range) out.push({ range, violation: v });
  }
  return out;
}

/**
 * Run Harper grammar check and merge results into state. Includes stale-result
 * detection (text changed mid-flight). Dedup against compliance + NLP runs in
 * getRangesByTier (projection layer) — see #140 / spec §4.3.
 *
 * Findings are emitted with ignoreKey: null placeholder synchronously, then a
 * second dispatch populates real ignoreKeys once fingerprintBlock resolves.
 */
function runGrammarPass({ el, plainText, blockId, dispatch }) {
  // Caller has already stashed plainText as grammarText for stale detection.
  checkGrammar(plainText, blockId).then(async grammarViolations => {
    const htmlSnapshot = el.innerHTML;
    const grammarFindings = toFindings(el, grammarViolations).map(f => ({ ...f, ignoreKey: null }));
    dispatch(s => {
      // Stale check: if grammarText changed while we awaited, our results are stale.
      if (getGrammarText(s, blockId) !== plainText) return s;
      // Store grammar verbatim; projection layer dedupes against the
      // post-filter compliance + nlp set.
      return setBlockFindings(s, blockId, { grammar: grammarFindings });
    });

    // Async hash + per-finding ignoreKey population for grammar findings.
    let blockHash;
    try { blockHash = await fingerprintBlock(htmlSnapshot); } catch { return; }
    const keys = await Promise.all(grammarFindings.map(f =>
      computeIgnoreKey(f.violation.ruleId, blockHash, f.violation.match)));
    if (!el.isConnected || el.innerHTML !== htmlSnapshot) return;  // stale
    dispatch(s => {
      if (getGrammarText(s, blockId) !== plainText) return s;
      return setBlockFindings(s, blockId, {
        grammar: grammarFindings.map((f, i) => ({ ...f, ignoreKey: keys[i] })),
      });
    });
  }).catch(() => {});
}
