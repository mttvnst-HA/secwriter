import { useState, useEffect, useCallback, useRef } from "react";

/**
 * Inline mark types available in the floating toolbar.
 * cls must match the CSS classes in editor.css (mark-rid, mark-srf, etc.)
 * tag is the SGML tag name used during serialization.
 */
const MARK_TYPES = [
  { tag: "RID", cls: "mark-rid", label: "RID", title: "Reference Standard (ASTM, AASHTO)", color: "#86198f", bg: "#fae8ff" },
  { tag: "SRF", cls: "mark-srf", label: "SRF", title: "Section Cross-Reference", color: "#701a75", bg: "#f5d0fe" },
  { tag: "SUB", cls: "mark-sub", label: "SUB", title: "Submittal Item", color: "#1e40af", bg: "#dbeafe" },
  { tag: "ENG", cls: "mark-eng", label: "ENG", title: "English Units", color: "#1d4ed8", bg: "#dbeafe" },
  { tag: "MET", cls: "mark-met", label: "MET", title: "Metric Units", color: "#b91c1c", bg: "#fee2e2" },
  { tag: "TAI", cls: "mark-tai", label: "TAI", title: "Tailoring Option", color: "#0e7490", bg: "#cffafe" },
];

const FORMAT_TYPES = [
  { tag: "BLD", label: "B", title: "Bold", style: { fontWeight: 700 }, htmlTag: "b" },
  { tag: "ITA", label: "I", title: "Italic", style: { fontStyle: "italic" }, htmlTag: "i" },
  { tag: "UND", label: "U", title: "Underline", style: { textDecoration: "underline" }, htmlTag: "u" },
];

/**
 * FloatingToolbar - appears above a text selection to let users apply inline marks.
 *
 * Listens for selectionchange events. When the user selects text inside a
 * contentEditable block (identified by data-block-id), the toolbar appears
 * positioned just above the selection. Clicking a mark button wraps the
 * selected text in a <span class="mark-xxx"> element.
 */
const REVISION_TYPES = [
  { tag: "ADD", cls: "mark-add", label: "ADD", title: "Mark as Addition", color: "#16a34a", bg: "#f0fdf4", htmlTag: "ins" },
  { tag: "DEL", cls: "mark-del", label: "DEL", title: "Mark as Deletion", color: "#dc2626", bg: "#fef2f2", htmlTag: "del" },
];

export default function FloatingToolbar({ editorRef, onBlockUpdate, trackChanges }) {
  const [visible, setVisible] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const [insideRevision, setInsideRevision] = useState(null); // "add" | "del" | null
  const toolbarRef = useRef(null);
  const selectionRef = useRef(null);

  const checkSelection = useCallback(() => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) {
      setVisible(false);
      return;
    }

    const range = sel.getRangeAt(0);
    const selectedText = range.toString().trim();
    if (!selectedText) {
      setVisible(false);
      return;
    }

    // Check if selection is inside a contentEditable block within our editor
    let node = range.commonAncestorContainer;
    if (node.nodeType === 3) node = node.parentElement;

    const blockEl = node?.closest?.("[data-block-id][contenteditable='true']");
    if (!blockEl) {
      setVisible(false);
      return;
    }

    // Make sure the block is inside our editor pane
    if (editorRef?.current && !editorRef.current.contains(blockEl)) {
      setVisible(false);
      return;
    }

    // Save the range so we can restore it after toolbar click
    selectionRef.current = {
      range: range.cloneRange(),
      blockId: blockEl.dataset.blockId,
      blockEl,
    };

    // Position above the selection
    // getBoundingClientRect() gives viewport coords; we need coords relative
    // to the editor's scrollable container (position:relative parent)
    const rect = range.getBoundingClientRect();
    const editorEl = editorRef?.current;
    const editorRect = editorEl?.getBoundingClientRect() || { top: 0, left: 0 };
    const scrollTop = editorEl?.scrollTop || 0;

    setPosition({
      top: rect.top - editorRect.top + scrollTop - 44,
      left: rect.left - editorRect.left + rect.width / 2,
    });

    // Detect if selection is inside a revision mark
    let checkNode = range.commonAncestorContainer;
    if (checkNode.nodeType === 3) checkNode = checkNode.parentElement;
    if (checkNode?.closest?.("ins.mark-add")) {
      setInsideRevision("add");
    } else if (checkNode?.closest?.("del.mark-del")) {
      setInsideRevision("del");
    } else {
      setInsideRevision(null);
    }

    setVisible(true);
  }, [editorRef]);

  useEffect(() => {
    // Use mouseup for reliable selection detection
    // selectionchange fires too frequently and before selection is finalized
    const handleMouseUp = () => {
      // Small delay to let the selection finalize
      setTimeout(checkSelection, 10);
    };

    const handleKeyUp = (e) => {
      // Check selection on shift+arrow key (text selection via keyboard)
      if (e.shiftKey && (e.key.startsWith("Arrow") || e.key === "Home" || e.key === "End")) {
        setTimeout(checkSelection, 10);
      }
    };

    // Hide on click outside or when selection collapses
    const handleMouseDown = (e) => {
      if (toolbarRef.current && toolbarRef.current.contains(e.target)) {
        // Click is on the toolbar itself — don't hide
        e.preventDefault(); // Prevent selection from collapsing
        return;
      }
      setVisible(false);
    };

    document.addEventListener("mouseup", handleMouseUp);
    document.addEventListener("keyup", handleKeyUp);
    document.addEventListener("mousedown", handleMouseDown);

    return () => {
      document.removeEventListener("mouseup", handleMouseUp);
      document.removeEventListener("keyup", handleKeyUp);
      document.removeEventListener("mousedown", handleMouseDown);
    };
  }, [checkSelection]);

  const applyMark = useCallback((markType) => {
    const saved = selectionRef.current;
    if (!saved) return;

    const { range, blockId, blockEl } = saved;

    // Restore the selection (toolbar mousedown prevented it from collapsing)
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);

    // Check if the selection is already inside this mark type
    let parentMark = range.commonAncestorContainer;
    if (parentMark.nodeType === 3) parentMark = parentMark.parentElement;
    const existingMark = parentMark.closest?.(`.${markType.cls}`);

    if (existingMark) {
      // Unwrap: replace the span with its text content
      const text = document.createTextNode(existingMark.textContent);
      existingMark.parentNode.replaceChild(text, existingMark);
    } else {
      // Wrap selection in a span with the mark class
      const span = document.createElement("span");
      span.className = markType.cls;
      try {
        range.surroundContents(span);
      } catch {
        // surroundContents fails if selection crosses element boundaries
        // Fall back to extracting and wrapping
        const fragment = range.extractContents();
        span.appendChild(fragment);
        range.insertNode(span);
      }
    }

    // Collapse selection after the new span
    sel.removeAllRanges();

    // Notify parent of the updated HTML
    if (onBlockUpdate && blockEl) {
      onBlockUpdate(blockId, blockEl.innerHTML);
    }

    setVisible(false);
  }, [onBlockUpdate]);

  const applyRevision = useCallback((revType) => {
    const saved = selectionRef.current;
    if (!saved) return;

    const { range, blockId, blockEl } = saved;

    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);

    // Check if already wrapped in this revision type
    let parentNode = range.commonAncestorContainer;
    if (parentNode.nodeType === 3) parentNode = parentNode.parentElement;
    const existingEl = parentNode.closest?.(revType.htmlTag + "." + revType.cls);

    if (existingEl && blockEl.contains(existingEl)) {
      // Unwrap
      const text = document.createTextNode(existingEl.textContent);
      existingEl.parentNode.replaceChild(text, existingEl);
    } else {
      // Wrap
      const el = document.createElement(revType.htmlTag);
      el.className = revType.cls;
      try {
        range.surroundContents(el);
      } catch {
        const fragment = range.extractContents();
        el.appendChild(fragment);
        range.insertNode(el);
      }
    }

    sel.removeAllRanges();

    if (onBlockUpdate && blockEl) {
      onBlockUpdate(blockId, blockEl.innerHTML);
    }

    setVisible(false);
  }, [onBlockUpdate]);

  /**
   * Accept or reject an inline revision mark.
   * action: "accept" or "reject"
   */
  const handleInlineRevisionAction = useCallback((action) => {
    const saved = selectionRef.current;
    if (!saved) return;

    const { blockId, blockEl } = saved;
    const sel = window.getSelection();
    const range = saved.range;

    // Find the revision mark element containing the cursor/selection
    let node = range.commonAncestorContainer;
    if (node.nodeType === 3) node = node.parentElement;

    const insEl = node.closest?.("ins.mark-add");
    const delEl = node.closest?.("del.mark-del");

    if (insEl && blockEl.contains(insEl)) {
      if (action === "accept") {
        // Accept ADD: strip ins tags, keep content
        const text = document.createTextNode(insEl.textContent);
        insEl.parentNode.replaceChild(text, insEl);
      } else {
        // Reject ADD: remove ins and content
        insEl.parentNode.removeChild(insEl);
      }
    } else if (delEl && blockEl.contains(delEl)) {
      if (action === "accept") {
        // Accept DEL: remove del and content
        delEl.parentNode.removeChild(delEl);
      } else {
        // Reject DEL: strip del tags, keep content (restore)
        const text = document.createTextNode(delEl.textContent);
        delEl.parentNode.replaceChild(text, delEl);
      }
    }

    sel.removeAllRanges();

    if (onBlockUpdate && blockEl) {
      onBlockUpdate(blockId, blockEl.innerHTML);
    }

    setVisible(false);
  }, [onBlockUpdate]);

  const applyFormat = useCallback((formatType) => {
    const saved = selectionRef.current;
    if (!saved) return;

    const { range, blockId, blockEl } = saved;

    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);

    // Check if already wrapped in this format
    let parentNode = range.commonAncestorContainer;
    if (parentNode.nodeType === 3) parentNode = parentNode.parentElement;
    const existingTag = parentNode.closest?.(formatType.htmlTag);

    if (existingTag && blockEl.contains(existingTag)) {
      // Unwrap
      const text = document.createTextNode(existingTag.textContent);
      existingTag.parentNode.replaceChild(text, existingTag);
    } else {
      // Wrap
      const el = document.createElement(formatType.htmlTag);
      try {
        range.surroundContents(el);
      } catch {
        const fragment = range.extractContents();
        el.appendChild(fragment);
        range.insertNode(el);
      }
    }

    sel.removeAllRanges();

    if (onBlockUpdate && blockEl) {
      onBlockUpdate(blockId, blockEl.innerHTML);
    }

    setVisible(false);
  }, [onBlockUpdate]);

  if (!visible) return null;

  return (
    <div
      ref={toolbarRef}
      style={{
        position: "absolute",
        top: position.top,
        left: position.left,
        transform: "translateX(-50%)",
        zIndex: 100,
        display: "flex",
        alignItems: "center",
        gap: 2,
        padding: "4px 6px",
        backgroundColor: "#1e293b",
        borderRadius: 8,
        boxShadow: "0 4px 16px rgba(0,0,0,0.2), 0 0 0 1px rgba(0,0,0,0.1)",
        userSelect: "none",
        whiteSpace: "nowrap",
      }}
    >
      {/* Format buttons */}
      {FORMAT_TYPES.map(fmt => (
        <button
          key={fmt.tag}
          title={fmt.title}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => applyFormat(fmt)}
          style={{
            padding: "3px 8px",
            fontSize: 12,
            fontWeight: fmt.tag === "BLD" ? 700 : 400,
            fontStyle: fmt.tag === "ITA" ? "italic" : "normal",
            textDecoration: fmt.tag === "UND" ? "underline" : "none",
            color: "#e2e8f0",
            backgroundColor: "transparent",
            border: "none",
            borderRadius: 4,
            cursor: "pointer",
            lineHeight: "20px",
            minWidth: 26,
          }}
          onMouseEnter={(e) => e.target.style.backgroundColor = "#334155"}
          onMouseLeave={(e) => e.target.style.backgroundColor = "transparent"}
        >
          {fmt.label}
        </button>
      ))}

      {/* Divider */}
      <div style={{ width: 1, height: 20, backgroundColor: "#475569", margin: "0 4px" }} />

      {/* Mark buttons */}
      {MARK_TYPES.map(mark => (
        <button
          key={mark.tag}
          title={mark.title}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => applyMark(mark)}
          style={{
            padding: "2px 7px",
            fontSize: 11,
            fontWeight: 600,
            color: mark.color,
            backgroundColor: mark.bg,
            border: "none",
            borderRadius: 4,
            cursor: "pointer",
            lineHeight: "18px",
            letterSpacing: "0.02em",
          }}
          onMouseEnter={(e) => e.target.style.opacity = "0.8"}
          onMouseLeave={(e) => e.target.style.opacity = "1"}
        >
          {mark.label}
        </button>
      ))}

      {/* Revision mark buttons (only when Track Changes is on) */}
      {trackChanges && (
        <>
          <div style={{ width: 1, height: 20, backgroundColor: "#475569", margin: "0 4px" }} />
          {REVISION_TYPES.map(rev => (
            <button
              key={rev.tag}
              title={rev.title}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => applyRevision(rev)}
              style={{
                padding: "2px 7px",
                fontSize: 11,
                fontWeight: 600,
                color: rev.color,
                backgroundColor: rev.bg,
                border: `1px solid ${rev.color}40`,
                borderRadius: 4,
                cursor: "pointer",
                lineHeight: "18px",
                letterSpacing: "0.02em",
              }}
              onMouseEnter={(e) => e.target.style.opacity = "0.8"}
              onMouseLeave={(e) => e.target.style.opacity = "1"}
            >
              {rev.label}
            </button>
          ))}
        </>
      )}

      {/* Inline accept/reject (when cursor is inside a revision mark) */}
      {insideRevision && (
        <>
          <div style={{ width: 1, height: 20, backgroundColor: "#475569", margin: "0 4px" }} />
          <button
            title={`Accept ${insideRevision === "add" ? "addition" : "deletion"}`}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => handleInlineRevisionAction("accept")}
            style={{
              padding: "2px 6px",
              fontSize: 12,
              color: "#16a34a",
              backgroundColor: "#f0fdf4",
              border: "1px solid #16a34a40",
              borderRadius: 4,
              cursor: "pointer",
              lineHeight: "18px",
            }}
          >
            ✓
          </button>
          <button
            title={`Reject ${insideRevision === "add" ? "addition" : "deletion"}`}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => handleInlineRevisionAction("reject")}
            style={{
              padding: "2px 6px",
              fontSize: 12,
              color: "#dc2626",
              backgroundColor: "#fef2f2",
              border: "1px solid #dc262640",
              borderRadius: 4,
              cursor: "pointer",
              lineHeight: "18px",
            }}
          >
            ✗
          </button>
        </>
      )}

      {/* Arrow pointer */}
      <div style={{
        position: "absolute",
        bottom: -6,
        left: "50%",
        transform: "translateX(-50%)",
        width: 0,
        height: 0,
        borderLeft: "6px solid transparent",
        borderRight: "6px solid transparent",
        borderTop: "6px solid #1e293b",
      }} />
    </div>
  );
}
