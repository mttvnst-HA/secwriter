import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import SlashMenu, { SLASH_ITEMS } from "./SlashMenu.jsx";
import { BLOCK_MARGINS } from "../lib/ini-config.js";
import { cleanTaiClasses } from "../lib/tailor-profile.js";
import { annotateDomWithDiff } from "../lib/text-diff.js";
import { initInlineLinting, clearBlockLinting, extractPlainText, findFindingAtCursor, DEBOUNCE_MS } from "../lib/inline-linter.js";
import { getRules } from "../lib/compliance-rules.js";
import InlineTooltip from "./InlineTooltip.jsx";

function EditableBlock({ block, onUpdate, onEnterKey, isFocused, onFocus, oliLabel, onDelete, onFocusPrev, onFocusNext, onConvertBlock, resolveHtml, tailorKey, onAcceptRevision, onRejectRevision, onRevisionAction, trackChanges, snapshotText, comments, onCommentClick, onInlineFix }) {
  const ref = useRef(null);
  const [slashOpen, setSlashOpen] = useState(false);
  const [slashFilter, setSlashFilter] = useState("");
  const [slashIdx, setSlashIdx] = useState(0);
  const [delPopup, setDelPopup] = useState(null); // { el, rect } for del click popup

  // Detect if block has inline revision marks (for gutter button display)
  const hasInlineRevisions = useMemo(() => {
    if (!block.html) return false;
    return /<ins\s+class="mark-add"|<del\s+class="mark-del"/.test(block.html);
  }, [block.html]);

  // Ref callback - fires the instant React attaches the DOM node
  const editable = block.type === "txt" || block.type === "note" || block.type === "oli" || block.type === "item" || block.type === "lst" || block.isNew;
  const setRef = useCallback((node) => {
    ref.current = node;
    if (!node) return;
    // Initialize content on mount
    if (editable && block.html && !node.dataset.init) {
      node.innerHTML = resolveHtml ? resolveHtml(block.html) : block.html;
      node.dataset.init = "1";
    } else if (!editable) {
      node.innerHTML = resolveHtml ? resolveHtml(block.html || "") : (block.html || "");
    }
  }, [editable, block.html, resolveHtml]);

  // Keep non-editable blocks synced when html changes after mount
  useEffect(() => {
    if (!editable && ref.current) {
      ref.current.innerHTML = resolveHtml ? resolveHtml(block.html || "") : (block.html || "");
    }
  }, [editable, block.html, resolveHtml]);

  // Sync editable block DOM when block.html changes externally (e.g. Accept All / Reject All)
  // Only sync if the block is NOT currently focused (avoid disrupting active editing)
  useEffect(() => {
    if (editable && ref.current && ref.current.dataset.init) {
      if (document.activeElement !== ref.current) {
        ref.current.innerHTML = resolveHtml ? resolveHtml(block.html || "") : (block.html || "");
      }
    }
  }, [editable, block.html, resolveHtml]);

  // Re-apply TAI resolution when tailoring profile changes
  useEffect(() => {
    if (!ref.current || !resolveHtml) return;
    // Re-resolve from clean block.html (not DOM innerHTML which may have stale classes)
    const resolved = resolveHtml(block.html || "");
    ref.current.innerHTML = resolved;
  }, [tailorKey]);

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
    if (ref.current) {
      // Track Changes: annotate diff before saving
      if (trackChanges && snapshotText != null) {
        annotateDomWithDiff(ref.current, snapshotText);
      }
      // Strip TAI resolution classes before saving to state
      const html = cleanTaiClasses(ref.current.innerHTML);
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
      if (ref.current) onUpdate(block.id, ref.current.innerHTML);
      onEnterKey(block.id);
      return;
    }

    if (e.key === "Backspace" && isEmpty()) {
      e.preventDefault();
      onDelete(block.id);
      return;
    }

    if (e.key === "ArrowUp" && isCursorAtStart()) {
      e.preventDefault();
      if (ref.current) onUpdate(block.id, ref.current.innerHTML);
      onFocusPrev(block.id);
      return;
    }

    if (e.key === "ArrowDown" && isCursorAtEnd()) {
      e.preventDefault();
      if (ref.current) onUpdate(block.id, ref.current.innerHTML);
      onFocusNext(block.id);
      return;
    }
  }, [block.id, onEnterKey, onUpdate, onDelete, onFocusPrev, onFocusNext, slashOpen, slashFiltered, slashIdx]);

  // Detect slash commands via input monitoring
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
  }, [slashOpen]);

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
    const html = ref.current.innerHTML;
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
  const lintBlock = useCallback(() => {
    if (!ref.current) return;
    try {
      const cachedRules = getRules();
      const plainText = extractPlainText(ref.current);
      initInlineLinting(ref.current, block.id, plainText, cachedRules, {
        isNoteBlock: block.type === 'note',
      });
    } catch {
      // Linting failed (element not ready), ignore
    }
  }, [block.id, block.type]);

  useEffect(() => {
    const el = ref.current;
    if (!el || !editable) return;

    const onNativeInput = () => {
      if (lintTimerRef.current) clearTimeout(lintTimerRef.current);
      lintTimerRef.current = setTimeout(lintBlock, DEBOUNCE_MS);
    };

    // Lint on focus (re-lint when clicking back into a block with violations)
    const onFocus = () => lintBlock();

    el.addEventListener('input', onNativeInput);
    el.addEventListener('focus', onFocus);

    return () => {
      el.removeEventListener('input', onNativeInput);
      el.removeEventListener('focus', onFocus);
      if (lintTimerRef.current) clearTimeout(lintTimerRef.current);
      clearBlockLinting(block.id);
    };
  }, [block.id, editable, lintBlock]);

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
    }
    if (onInlineFix) {
      onInlineFix(blockId, fixedHtml);
    }
    // Re-lint the updated content
    setTimeout(lintBlock, 50);
  }, [onInlineFix, lintBlock]);

  const dismissTooltip = useCallback(() => setTooltipFinding(null), []);

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
  // These are absolute per block type, not cumulative with depth
  const MARGINS = BLOCK_MARGINS;
  const leftMargin = MARGINS[block.type] || 15;

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
      color: "#334155",
      marginTop: 8,
      paddingLeft: 0,  // Align list header text at margin, left of OLI labels
    });
  } else if (isItem) {
    Object.assign(baseStyle, {
      color: "#334155",
      paddingLeft: 20,
      position: "relative",
    });
  } else if (isOli) {
    Object.assign(baseStyle, {
      color: "#334155",
      paddingLeft: 28,  // room for the a. b. c. label
    });
  } else {
    // txt or any new block type not matched above
    Object.assign(baseStyle, {
      color: "#1e293b",
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
          left: MARGINS.oli - 4,
          top: 5,
          color: "#475569",
          fontSize: 15,
          fontWeight: 500,
          userSelect: "none",
          width: 24,
          textAlign: "right",
        }}>{oliLabel}</span>
      )}
      <div
        ref={setRef}
        data-block-id={block.id}
        contentEditable={editable}
        spellCheck={editable}
        suppressContentEditableWarning
        onKeyDown={editable ? handleKeyDown : undefined}
        onInput={editable ? handleInput : undefined}
        onBlur={editable ? handleBlurWithLinting : undefined}
        onClick={(e) => { handleDelClick(e); onFocus(block.id); }}
        style={{
          ...baseStyle,
          cursor: editable ? "text" : "default",
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
