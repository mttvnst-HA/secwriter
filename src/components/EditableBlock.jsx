import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import SlashMenu, { SLASH_ITEMS } from "./SlashMenu.jsx";
import { BLOCK_MARGINS } from "../lib/ini-config.js";
import { cleanTaiClasses } from "../lib/tailor-profile.js";

function EditableBlock({ block, onUpdate, onEnterKey, isFocused, onFocus, oliLabel, onDelete, onFocusPrev, onFocusNext, onConvertBlock, resolveHtml, tailorKey, onAcceptRevision, onRejectRevision }) {
  const ref = useRef(null);
  const [slashOpen, setSlashOpen] = useState(false);
  const [slashFilter, setSlashFilter] = useState("");
  const [slashIdx, setSlashIdx] = useState(0);

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
      // Strip TAI resolution classes before saving to state
      const html = cleanTaiClasses(ref.current.innerHTML);
      onUpdate(block.id, html);
    }
    setTimeout(() => {
      setSlashOpen(false);
      setSlashFilter("");
    }, 150);
  }, [block.id, onUpdate]);

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
    fontSize: 14,
    lineHeight: "1.65",
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
      backgroundColor: isFocused ? "#f8fafc" : "transparent",
    });
  }

  const revisionClass = block.revision ? `block-revision-${block.revision}` : '';

  return (
    <div style={{ position: "relative" }} className={revisionClass}>
      {/* Block-level revision accept/reject gutter buttons */}
      {block.revision && onAcceptRevision && (
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
            title={`Accept ${block.revision}`}
            style={{
              width: 18,
              height: 18,
              border: "1px solid #16a34a40",
              borderRadius: 3,
              backgroundColor: "#f0fdf4",
              color: "#16a34a",
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
            title={`Reject ${block.revision}`}
            style={{
              width: 18,
              height: 18,
              border: "1px solid #dc262640",
              borderRadius: 3,
              backgroundColor: "#fef2f2",
              color: "#dc2626",
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
          fontSize: 14,
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
        suppressContentEditableWarning
        onKeyDown={editable ? handleKeyDown : undefined}
        onInput={editable ? handleInput : undefined}
        onBlur={editable ? handleBlur : undefined}
        onClick={() => onFocus(block.id)}
        style={{
          ...baseStyle,
          cursor: editable ? "text" : "default",
          border: isFocused && editable ? "1px solid #cbd5e1" : "1px solid transparent",
          boxShadow: isFocused && editable ? "0 0 0 2px rgba(99,132,168,0.15)" : "none",
        }}
      />
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
