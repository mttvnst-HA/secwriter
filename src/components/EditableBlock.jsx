import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import SlashMenu, { SLASH_ITEMS } from "./SlashMenu.jsx";
import { BLOCK_MARGINS } from "../lib/ini-config.js";
import { cleanTaiClasses } from "../lib/tailor-profile.js";
import { annotateDomWithDiff } from "../lib/text-diff.js";
import { initInlineLinting, clearBlockLinting, extractPlainText, findFindingAtCursor, getBlockFindingSeverity, DEBOUNCE_MS } from "../lib/inline-linter.js";
import { addUserWord } from "../lib/grammar-checker.js";
import { getRules } from "../lib/compliance-rules.js";
import InlineTooltip from "./InlineTooltip.jsx";
import { NO_EXFIL_PROPS } from "../lib/no-exfil.js";

// Idle window after the last keystroke before we fire onUpdate (and therefore
// publishBlocks → Y.Doc → R2). Short enough that a hard reload loses at most
// ~one half-second of typing; long enough that we don't re-walk every block
// through applyBlocksToYDoc on every character. Exported so tests can pin
// against the same value.
export const PUBLISH_DEBOUNCE_MS = 400;

/** Sanitize pasted text: collapse newlines to single space, strip zero-width spaces, trim */
export function sanitizePasteText(text) {
  return text.replace(/[\r\n]+/g, ' ').replace(/\u200B/g, '').trimEnd();
}

// Mark class → SGML tag name mapping for inline tag labels
const MARK_TAG_MAP = {
  'mark-rid': 'RID', 'mark-srf': 'SRF', 'mark-sub': 'SUB',
  'mark-eng': 'ENG', 'mark-met': 'MET', 'mark-tst': 'TST',
  'mark-url': 'URL', 'mark-att': 'ATT', 'mark-tai': 'TAI',
};

/** Inject or remove contentEditable=false tag label spans inside a DOM container */
function syncTagLabels(container, visible) {
  if (!container) return;
  // Remove existing tag labels first
  container.querySelectorAll('.tag-label').forEach(el => el.remove());
  if (!visible) return;
  // Inject tag labels before/after each mark span
  for (const [cls, tag] of Object.entries(MARK_TAG_MAP)) {
    container.querySelectorAll(`.${cls}`).forEach(span => {
      const openTag = tag === 'TAI' && span.dataset.opt
        ? `<TAI OPT=${span.dataset.opt}>`
        : `<${tag}>`;
      const open = document.createElement('span');
      open.className = 'tag-label';
      open.contentEditable = 'false';
      open.textContent = openTag;
      const close = document.createElement('span');
      close.className = 'tag-label';
      close.contentEditable = 'false';
      close.textContent = `</${tag}>`;
      span.prepend(open);
      span.append(close);
    });
  }
}

/** Strip tag-label spans from innerHTML before saving to state */
function stripTagLabels(html) {
  return html.replace(/<span[^>]*class="tag-label"[^>]*>[^<]*<\/span>/g, '');
}

function EditableBlock({ block, onUpdate, onEnterKey, isFocused, onFocus, oliLabel, onDelete, onFocusPrev, onFocusNext, onConvertBlock, onChangeOliLevel, resolveHtml, tailorKey, onAcceptRevision, onRejectRevision, onRevisionAction, trackChanges, snapshotText, identity, comments, onCommentClick, onInlineFix, inlineLintingEnabled = true, compliancePanelActive = false, showTags = false, readOnly = false }) {
  const ref = useRef(null);
  const [slashOpen, setSlashOpen] = useState(false);
  const [slashFilter, setSlashFilter] = useState("");
  const [slashIdx, setSlashIdx] = useState(0);
  const [delPopup, setDelPopup] = useState(null); // { el, rect } for del click popup
  // Debounced input → onUpdate so live typing reaches collab without requiring blur (#21).
  // Track Changes annotation still runs only on blur via handleBlur — debounced fires
  // carry pre-annotation HTML; the blur publish remains source of truth for revision marks.
  const inputDebounceRef = useRef(null);
  // Latest block.html, mirrored into a ref so setRef can read it without
  // taking a useCallback dep on it. Without this, every debounced publish
  // changes block.html → setRef identity → React detaches/re-attaches the
  // contentEditable ref → setRef body re-runs syncTagLabels mid-edit. That
  // race broke E2E tests that select text and click a toolbar button within
  // the debounce window (the saved Range from FloatingToolbar's checkSelection
  // was getting invalidated by the re-attach).
  const blockHtmlRef = useRef(block.html);
  useEffect(() => { blockHtmlRef.current = block.html; }, [block.html]);

  // Detect if block has inline revision marks (for gutter button display)
  const hasInlineRevisions = useMemo(() => {
    if (!block.html) return false;
    return /<ins\s+class="mark-add"|<del\s+class="mark-del"/.test(block.html);
  }, [block.html]);

  // Ref callback - fires the instant React attaches the DOM node
  const typeEditable = block.type === "txt" || block.type === "note" || block.type === "oli" || block.type === "item" || block.type === "lst" || block.isNew;
  const editable = typeEditable && !readOnly;
  const setRef = useCallback((node) => {
    ref.current = node;
    if (!node) return;
    const html = blockHtmlRef.current;
    // Initialize content on mount. dataset.init is a "we've mounted" flag the
    // sync useEffect below uses to skip pre-mount runs — set it regardless of
    // whether html is empty, otherwise blocks born empty (created via Enter
    // with no initial content) never get the flag and the sync useEffect
    // permanently skips the DOM rewrite, leaving stale content behind on
    // Accept All / Reject All.
    if (editable && !node.dataset.init) {
      if (html) {
        node.innerHTML = resolveHtml ? resolveHtml(html) : html;
      }
      node.dataset.init = "1";
    } else if (!editable) {
      node.innerHTML = resolveHtml ? resolveHtml(html || "") : (html || "");
    }
    syncTagLabels(node, showTags);
  }, [editable, resolveHtml, showTags]);

  // Keep non-editable blocks synced when html changes after mount
  useEffect(() => {
    if (!editable && ref.current) {
      ref.current.innerHTML = resolveHtml ? resolveHtml(block.html || "") : (block.html || "");
      syncTagLabels(ref.current, showTags);
    }
  }, [editable, block.html, resolveHtml, showTags]);

  // Sync editable block DOM when block.html changes externally (e.g. Accept All / Reject All)
  // Only sync if the block is NOT currently focused (avoid disrupting active editing)
  useEffect(() => {
    if (editable && ref.current && ref.current.dataset.init) {
      if (document.activeElement !== ref.current) {
        ref.current.innerHTML = resolveHtml ? resolveHtml(block.html || "") : (block.html || "");
        syncTagLabels(ref.current, showTags);
      }
    }
  }, [editable, block.html, resolveHtml, showTags]);

  // Re-apply TAI resolution when tailoring profile changes
  useEffect(() => {
    if (!ref.current || !resolveHtml) return;
    // Re-resolve from clean block.html (not DOM innerHTML which may have stale classes)
    const resolved = resolveHtml(block.html || "");
    ref.current.innerHTML = resolved;
    syncTagLabels(ref.current, showTags);
  }, [tailorKey, showTags]);

  // Inject/remove inline tag labels when showTags toggles
  useEffect(() => {
    syncTagLabels(ref.current, showTags);
  }, [showTags]);

  // For new/converted blocks: place caret after mount + paint
  const needsFocus = block.isNew && editable;
  useEffect(() => {
    if (needsFocus && ref.current) {
      // Insert zero-width space so browser has a text node to anchor the caret
      if (!ref.current.textContent) {
        ref.current.innerHTML = "\u200B";
      }
      ref.current.focus();
      const range = document.createRange();
      range.selectNodeContents(ref.current);
      range.collapse(false);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      // Clean up the zero-width space on first real input
      const cleanup = () => {
        if (ref.current) {
          const content = ref.current.textContent || "";
          if (content.includes("\u200B")) {
            // Preserve cursor position by replacing ZWS without resetting content
            const sel = window.getSelection();
            const cursorOffset = sel.rangeCount ? sel.getRangeAt(0).startOffset : 0;
            ref.current.textContent = content.replace(/\u200B/g, "");
            // Restore cursor
            if (ref.current.childNodes.length > 0) {
              const range = document.createRange();
              const newOffset = Math.max(0, cursorOffset - 1);
              range.setStart(ref.current.childNodes[0], Math.min(newOffset, ref.current.textContent.length));
              range.collapse(true);
              sel.removeAllRanges();
              sel.addRange(range);
            }
          }
        }
        ref.current?.removeEventListener("input", cleanup);
      };
      ref.current.addEventListener("input", cleanup);
    }
  }, []);

  function isCursorAtStart() {
    const sel = window.getSelection();
    if (!sel.rangeCount) return false;
    const range = sel.getRangeAt(0);
    if (!range.collapsed) return false;
    // Check if we're at the very beginning
    const preRange = document.createRange();
    preRange.setStart(ref.current, 0);
    preRange.setEnd(range.startContainer, range.startOffset);
    return preRange.toString().length === 0;
  }

  function isCursorAtEnd() {
    const sel = window.getSelection();
    if (!sel.rangeCount) return false;
    const range = sel.getRangeAt(0);
    if (!range.collapsed) return false;
    const postRange = document.createRange();
    postRange.setStart(range.endContainer, range.endOffset);
    postRange.setEnd(ref.current, ref.current.childNodes.length);
    return postRange.toString().length === 0;
  }

  function isEmpty() {
    if (!ref.current) return true;
    const text = (ref.current.textContent || "").replace(/\u200B/g, "");
    return text.trim().length === 0;
  }

  // Get filtered slash items count for index clamping
  const slashFiltered = useMemo(() => {
    if (!slashOpen) return [];
    return SLASH_ITEMS.filter(item => {
      if (!slashFilter) return true;
      const q = slashFilter.toLowerCase();
      return item.label.toLowerCase().startsWith(q);
    });
  }, [slashOpen, slashFilter]);

  const converting = useRef(false);

  function handleSlashSelect(type) {
    converting.current = true; // prevent blur from triggering state updates
    setSlashOpen(false);
    setSlashFilter("");
    setSlashIdx(0);
    if (ref.current) ref.current.textContent = "";
    onConvertBlock(block.id, type);
  }

  const handleBlur = useCallback(() => {
    if (converting.current) return; // skip blur during slash menu conversion
    // Cancel any pending debounced input publish — the blur fires onUpdate
    // synchronously below with the final HTML (and TC annotation, if enabled).
    if (inputDebounceRef.current) {
      clearTimeout(inputDebounceRef.current);
      inputDebounceRef.current = null;
    }
    if (ref.current) {
      // Track Changes: annotate diff before saving
      if (trackChanges && snapshotText != null) {
        annotateDomWithDiff(ref.current, snapshotText, identity || null);
      }
      // Strip tag labels and TAI resolution classes before saving to state
      const html = stripTagLabels(cleanTaiClasses(ref.current.innerHTML));
      onUpdate(block.id, html);
    }
    setTimeout(() => {
      setSlashOpen(false);
      setSlashFilter("");
    }, 150);
  }, [block.id, onUpdate, trackChanges, snapshotText]);

  const handleKeyDown = useCallback((e) => {
    // Slash menu navigation
    if (slashOpen) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSlashIdx(i => Math.min(i + 1, slashFiltered.length - 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSlashIdx(i => Math.max(i - 1, 0));
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        if (slashFiltered.length > 0) {
          handleSlashSelect(slashFiltered[Math.min(slashIdx, slashFiltered.length - 1)].type);
        }
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setSlashOpen(false);
        setSlashFilter("");
        return;
      }
      // Let other keys through to update the filter via onInput
    }

    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (ref.current) onUpdate(block.id, stripTagLabels(ref.current.innerHTML));
      onEnterKey(block.id);
      return;
    }

    // Tab / Shift+Tab: demote/promote OLI list level (capped 1..4 per UFS Figure A-1)
    if (e.key === "Tab" && block.type === "oli" && onChangeOliLevel) {
      e.preventDefault();
      if (ref.current) onUpdate(block.id, stripTagLabels(ref.current.innerHTML));
      onChangeOliLevel(block.id, e.shiftKey ? -1 : 1);
      return;
    }

    if (e.key === "Backspace" && isEmpty()) {
      e.preventDefault();
      onDelete(block.id);
      return;
    }

    if (e.key === "ArrowUp" && isCursorAtStart()) {
      e.preventDefault();
      if (ref.current) onUpdate(block.id, stripTagLabels(ref.current.innerHTML));
      onFocusPrev(block.id);
      return;
    }

    if (e.key === "ArrowDown" && isCursorAtEnd()) {
      e.preventDefault();
      if (ref.current) onUpdate(block.id, stripTagLabels(ref.current.innerHTML));
      onFocusNext(block.id);
      return;
    }
  }, [block.id, block.type, onEnterKey, onUpdate, onDelete, onFocusPrev, onFocusNext, onChangeOliLevel, slashOpen, slashFiltered, slashIdx]);

  // Detect slash commands via input monitoring + schedule a debounced publish
  // so live typing reaches collab/persistence without requiring blur (#21).
  const handleInput = useCallback(() => {
    if (!ref.current) return;
    const text = (ref.current.textContent || "").replace(/\u200B/g, "");

    if (text.startsWith("/")) {
      const filter = text.slice(1);
      setSlashOpen(true);
      setSlashFilter(filter);
      setSlashIdx(0);
    } else {
      if (slashOpen) {
        setSlashOpen(false);
        setSlashFilter("");
      }
    }

    // Debounced onUpdate. Pre-annotation (no Track Changes diff) on purpose —
    // annotation runs only at blur via handleBlur. Peers see plain edits live;
    // revision marks materialize when the editor blurs.
    //
    // Defer if the user has an active non-collapsed selection — they're
    // probably mid-toolbar-action (select text → click Mark/Case/Comment).
    // Publishing now would re-render and could invalidate the saved Range
    // FloatingToolbar restored before mutating. The next input event will
    // re-arm this timer; blur will flush via handleBlur.
    if (inputDebounceRef.current) clearTimeout(inputDebounceRef.current);
    inputDebounceRef.current = setTimeout(() => {
      inputDebounceRef.current = null;
      if (!ref.current) return;
      const sel = typeof window !== "undefined" ? window.getSelection?.() : null;
      if (sel && !sel.isCollapsed && ref.current.contains(sel.anchorNode)) return;
      const html = stripTagLabels(cleanTaiClasses(ref.current.innerHTML));
      onUpdate(block.id, html);
    }, PUBLISH_DEBOUNCE_MS);
  }, [slashOpen, block.id, onUpdate]);

  // Cancel pending debounced publish on unmount so a stale timer can't fire
  // onUpdate against a different block id (handleBlockUpdate would still
  // no-op since it map-matches by id, but we don't want to leak the timer).
  useEffect(() => {
    return () => {
      if (inputDebounceRef.current) {
        clearTimeout(inputDebounceRef.current);
        inputDebounceRef.current = null;
      }
    };
  }, []);

  // Strip formatting from pasted content — insert plain text only.
  // execCommand('insertText') is deprecated but remains the only reliable way to
  // insert text into contentEditable while preserving the browser's native undo stack.
  const handlePaste = useCallback((e) => {
    e.preventDefault();
    const text = sanitizePasteText(e.clipboardData.getData('text/plain'));
    if (text) {
      document.execCommand('insertText', false, text);
    }
  }, []);

  // Handle clicks on <del> elements and comment spans
  const handleDelClick = useCallback((e) => {
    // Check for comment click
    const commentEl = e.target.closest?.('span.mark-comment');
    if (commentEl && ref.current?.contains(commentEl) && onCommentClick) {
      const commentId = commentEl.getAttribute('data-comment-id');
      if (commentId) {
        e.stopPropagation();
        onCommentClick(commentId, commentEl.getBoundingClientRect());
        return;
      }
    }
    // Check for del click
    const delEl = e.target.closest?.('del.mark-del');
    if (delEl && ref.current?.contains(delEl)) {
      e.stopPropagation();
      setDelPopup({ el: delEl, rect: delEl.getBoundingClientRect() });
      return;
    }
    setDelPopup(null);
  }, [onCommentClick]);

  const handleDelAction = useCallback((action) => {
    if (!delPopup?.el || !ref.current) return;
    const delEl = delPopup.el;
    if (action === 'accept') {
      // Accept DEL: remove del and its content
      delEl.parentNode.removeChild(delEl);
    } else {
      // Reject DEL: restore content (strip del tag, keep text)
      const text = document.createTextNode(delEl.textContent);
      delEl.parentNode.replaceChild(text, delEl);
    }
    setDelPopup(null);
    // Save updated HTML and sync snapshot
    const html = stripTagLabels(ref.current.innerHTML);
    if (onRevisionAction) {
      onRevisionAction(block.id, html);
    } else {
      onUpdate(block.id, html);
    }
  }, [delPopup, block.id, onRevisionAction, onUpdate]);

  // Dismiss del popup on blur or scroll
  useEffect(() => {
    if (!delPopup) return;
    const dismiss = () => setDelPopup(null);
    window.addEventListener('scroll', dismiss, true);
    return () => window.removeEventListener('scroll', dismiss, true);
  }, [delPopup]);

  // ── Inline linting: debounced input + lint on focus ──
  const lintTimerRef = useRef(null);
  const [lintSeverity, setLintSeverity] = useState(null); // 'high' | 'medium' | 'low' | null
  const lintBlock = useCallback(() => {
    if (!ref.current || !inlineLintingEnabled || compliancePanelActive) {
      clearBlockLinting(block.id);
      setLintSeverity(null);
      return;
    }
    try {
      const cachedRules = getRules();
      const plainText = extractPlainText(ref.current);
      initInlineLinting(ref.current, block.id, plainText, cachedRules, {
        isNoteBlock: block.type === 'note',
      });
      // Update gutter dot after a short delay (grammar is async)
      setTimeout(() => setLintSeverity(getBlockFindingSeverity(block.id)), 200);
    } catch {
      // Linting failed (element not ready), ignore
    }
  }, [block.id, block.type, inlineLintingEnabled, compliancePanelActive]);

  useEffect(() => {
    const el = ref.current;
    if (!el || !editable) return;

    // If linting is disabled or compliance panel is active, clear and skip
    if (!inlineLintingEnabled || compliancePanelActive) {
      clearBlockLinting(block.id);
      return;
    }

    const onNativeInput = () => {
      if (lintTimerRef.current) clearTimeout(lintTimerRef.current);
      lintTimerRef.current = setTimeout(lintBlock, DEBOUNCE_MS);
    };

    // Lint on focus (re-lint when clicking back into a block with violations)
    const onFocusLint = () => lintBlock();

    el.addEventListener('input', onNativeInput);
    el.addEventListener('focus', onFocusLint);

    // If this block is already focused when linting is (re-)enabled, lint immediately
    if (document.activeElement === el) {
      lintBlock();
    }

    return () => {
      el.removeEventListener('input', onNativeInput);
      el.removeEventListener('focus', onFocusLint);
      if (lintTimerRef.current) clearTimeout(lintTimerRef.current);
      clearBlockLinting(block.id);
    };
  }, [block.id, editable, lintBlock, inlineLintingEnabled, compliancePanelActive]);

  // ── Inline tooltip: selectionchange listener ──
  const [tooltipFinding, setTooltipFinding] = useState(null);
  const selTimerRef = useRef(null);

  useEffect(() => {
    if (!editable) return;

    const checkCursorForTooltip = () => {
      if (selTimerRef.current) clearTimeout(selTimerRef.current);
      selTimerRef.current = setTimeout(() => {
        const sel = document.getSelection();
        if (!sel || !sel.isCollapsed || !sel.rangeCount) {
          setTooltipFinding(null);
          return;
        }
        // Only check if cursor is inside this block
        if (!ref.current || !ref.current.contains(sel.anchorNode)) {
          setTooltipFinding(null);
          return;
        }
        const finding = findFindingAtCursor(sel.anchorNode, sel.anchorOffset);
        setTooltipFinding(finding);
      }, 100);
    };

    // Arrow keys may not always fire selectionchange, so also listen for keyup
    const onKeyUp = (e) => {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' ||
          e.key === 'ArrowUp' || e.key === 'ArrowDown' ||
          e.key === 'Home' || e.key === 'End') {
        checkCursorForTooltip();
      }
    };

    // Dismiss tooltip immediately when user starts typing so it doesn't block editing
    const onInput = () => {
      setTooltipFinding(null);
    };

    document.addEventListener('selectionchange', checkCursorForTooltip);
    document.addEventListener('keyup', onKeyUp);
    if (ref.current) ref.current.addEventListener('input', onInput);
    const el = ref.current;
    return () => {
      document.removeEventListener('selectionchange', checkCursorForTooltip);
      document.removeEventListener('keyup', onKeyUp);
      if (el) el.removeEventListener('input', onInput);
      if (selTimerRef.current) clearTimeout(selTimerRef.current);
    };
  }, [editable]);

  // Handle inline fix: update DOM directly (block is focused), call onFix, re-lint
  const handleInlineFix = useCallback((blockId, fixedHtml) => {
    setTooltipFinding(null);
    clearBlockLinting(blockId);
    // Update DOM directly since block is focused (React sync skips focused blocks)
    if (ref.current) {
      ref.current.innerHTML = fixedHtml;
      syncTagLabels(ref.current, showTags);
    }
    if (onInlineFix) {
      onInlineFix(blockId, fixedHtml);
    }
    // Re-lint the updated content
    setTimeout(lintBlock, 50);
  }, [onInlineFix, lintBlock]);

  const dismissTooltip = useCallback(() => setTooltipFinding(null), []);

  // Add a word to the user's custom dictionary and re-lint this block
  const handleAddToDictionary = useCallback(async (word) => {
    setTooltipFinding(null);
    try {
      await addUserWord(word);
    } catch {
      // ignore
    }
    // Re-lint so the highlight disappears
    setTimeout(lintBlock, 50);
  }, [lintBlock]);

  // On blur: dismiss tooltip, keep highlights persistent.
  // Re-lint after a short delay because blur → onUpdate → React re-render
  // replaces DOM text nodes, which invalidates existing Range objects.
  const origHandleBlur = handleBlur;
  const handleBlurWithLinting = useCallback(() => {
    setTooltipFinding(null);
    if (lintTimerRef.current) clearTimeout(lintTimerRef.current);
    origHandleBlur();
    // Re-create Ranges on the updated DOM after React re-renders
    setTimeout(lintBlock, 50);
  }, [origHandleBlur, lintBlock]);

  const isNote = block.type === "note";
  const isTxt = block.type === "txt";
  const isOli = block.type === "oli";
  const isItem = block.type === "item";
  const isLst = block.type === "lst";
  const isNew = block.isNew;

  // Margins from section.ini (inches converted to px at ~96 DPI)
  // These are absolute per block type, not cumulative with depth.
  // Exception: OLI adds per-level indentation (UFS 1-300-02 Figure A-1
  // shows 4 progressively indented levels a. / (1) / (a) / 1.).
  const MARGINS = BLOCK_MARGINS;
  const OLI_LEVEL_STEP = 24; // px per additional level (~0.25")
  let leftMargin = MARGINS[block.type] || 15;
  if (isOli) {
    const lvl = Math.max(1, Math.min(block.level || 1, 4));
    leftMargin = MARGINS.oli + (lvl - 1) * OLI_LEVEL_STEP;
  }

  const baseStyle = {
    padding: isTxt ? "6px 12px" : isNote ? "6px 12px" : "4px 12px",
    marginLeft: leftMargin,
    marginBottom: 2,
    outline: "none",
    borderRadius: 3,
    minHeight: 24,
    transition: "background 0.15s ease",
  };

  if (isNote) {
    Object.assign(baseStyle, {
      borderLeft: "3px solid #f59e0b",
      backgroundColor: "#fffbeb",
      color: "#92400e",
      fontStyle: "normal",
      marginBottom: 4,
      marginRight: 85,  // NPR=0.89,0.89 - equal indent both sides
      padding: "6px 12px 6px 14px",
    });
  } else if (isLst) {
    Object.assign(baseStyle, {
      fontWeight: 600,
      marginTop: 8,
      paddingLeft: 0,  // Align list header text at margin, left of OLI labels
    });
  } else if (isItem) {
    Object.assign(baseStyle, {
      paddingLeft: 20,
      position: "relative",
    });
  } else if (isOli) {
    Object.assign(baseStyle, {
      paddingLeft: 28,  // room for the a. b. c. label
    });
  } else {
    // txt or any new block type not matched above
    Object.assign(baseStyle, {
      backgroundColor: isFocused ? "#fafaf7" : "transparent",
    });
  }

  const revisionClass = `${block.revision ? `block-revision-${block.revision}` : ''} ${isNote ? 'block-type-note' : ''}`.trim();

  // Map block type to SGML tag name for tags-visible mode
  const sgmlTag = { txt: 'TXT', note: 'NTE', oli: 'OLI', item: 'ITM', lst: 'LST' }[block.type] || 'TXT';

  return (
    <div id={`block-${block.id}`} style={{ position: "relative" }} className={revisionClass} data-tag={sgmlTag}>
      {/* Block-level and inline revision accept/reject gutter buttons */}
      {(block.revision || hasInlineRevisions) && onAcceptRevision && (
        <div style={{
          position: "absolute",
          left: -4,
          top: 4,
          display: "flex",
          flexDirection: "column",
          gap: 2,
          zIndex: 10,
        }}>
          <button
            onClick={() => onAcceptRevision(block.id)}
            title={block.revision ? `Accept ${block.revision}` : 'Accept inline changes'}
            style={{
              width: 18,
              height: 18,
              border: "1px solid #00800040",
              borderRadius: 3,
              backgroundColor: "#f0fdf4",
              color: "#008000",
              fontSize: 11,
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: 0,
              lineHeight: 1,
            }}
          >✓</button>
          <button
            onClick={() => onRejectRevision(block.id)}
            title={block.revision ? `Reject ${block.revision}` : 'Reject inline changes'}
            style={{
              width: 18,
              height: 18,
              border: "1px solid #ff444440",
              borderRadius: 3,
              backgroundColor: "#fef2f2",
              color: "#ff4444",
              fontSize: 11,
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: 0,
              lineHeight: 1,
            }}
          >✗</button>
        </div>
      )}
      {isItem && (
          <span style={{
            position: "absolute",
            left: MARGINS.item + 4,
            top: 6,
            color: "#94a3b8",
            fontSize: 10,
            userSelect: "none",
          }}>&#9679;</span>
        )}
        {isOli && oliLabel && (
          <span style={{
            position: "absolute",
            left: leftMargin - 4,
            top: 4,               // match editable div paddingTop
            height: "1.5em",      // span the first text line
            display: "flex",
            alignItems: "flex-end", // bottom-align with first line baseline
            justifyContent: "flex-end",
            color: "#475569",
            fontSize: 15,
            lineHeight: 1,
            fontWeight: 500,
            userSelect: "none",
            width: 28,
          }}>{oliLabel}</span>
        )}
        {lintSeverity && inlineLintingEnabled && !compliancePanelActive && (
          <span
            title={`${lintSeverity} severity finding`}
            style={{
              position: "absolute",
              left: 2,
              top: 8,
              width: 6,
              height: 6,
              borderRadius: "50%",
              backgroundColor: lintSeverity === 'high' ? '#ef4444' : lintSeverity === 'medium' ? '#f59e0b' : '#3b82f6',
              pointerEvents: "none",
            }}
          />
        )}
        <div
          ref={setRef}
          data-block-id={block.id}
          contentEditable={editable}
          {...NO_EXFIL_PROPS}
          suppressContentEditableWarning
          onKeyDown={editable ? handleKeyDown : undefined}
          onInput={editable ? handleInput : undefined}
          onPaste={editable ? handlePaste : undefined}
          onBlur={editable ? handleBlurWithLinting : undefined}
          onClick={(e) => { handleDelClick(e); onFocus(block.id); }}
          style={{
            ...baseStyle,
            cursor: editable ? "text" : readOnly ? "not-allowed" : "default",
            opacity: readOnly ? 0.8 : 1,
            border: isFocused && editable ? "1px solid #cbd5e1" : "1px solid transparent",
            boxShadow: isFocused && editable ? "0 0 0 2px rgba(99,132,168,0.15)" : "none",
          }}
        />
      {/* Del element click popup for individual accept/reject */}
      {delPopup && (
        <div style={{
          position: "fixed",
          top: delPopup.rect.top - 34,
          left: delPopup.rect.left + delPopup.rect.width / 2,
          transform: "translateX(-50%)",
          display: "flex",
          gap: 2,
          padding: "3px 6px",
          backgroundColor: "#1e293b",
          borderRadius: 6,
          boxShadow: "0 4px 12px rgba(0,0,0,0.25)",
          zIndex: 100,
        }}>
          <button
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => handleDelAction('accept')}
            title="Accept deletion (remove text)"
            style={{
              width: 22, height: 22, border: "none", borderRadius: 3,
              backgroundColor: "transparent", color: "#4ade80",
              fontSize: 13, cursor: "pointer", display: "flex",
              alignItems: "center", justifyContent: "center", padding: 0,
            }}
          >✓</button>
          <button
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => handleDelAction('reject')}
            title="Reject deletion (restore text)"
            style={{
              width: 22, height: 22, border: "none", borderRadius: 3,
              backgroundColor: "transparent", color: "#f87171",
              fontSize: 13, cursor: "pointer", display: "flex",
              alignItems: "center", justifyContent: "center", padding: 0,
            }}
          >✗</button>
        </div>
      )}
      {/* Inline linting tooltip */}
      {tooltipFinding && editable && (
        <InlineTooltip
          finding={tooltipFinding}
          blockId={block.id}
          onFix={handleInlineFix}
          onDismiss={dismissTooltip}
          onAddToDictionary={handleAddToDictionary}
          blockEl={ref.current}
        />
      )}
      {slashOpen && editable && (
        <SlashMenu
          filter={slashFilter}
          selectedIdx={slashIdx}
          onSelect={handleSlashSelect}
          position={{ left: leftMargin + 12, top: 32 }}
        />
      )}
    </div>
  );
}

export default EditableBlock;
