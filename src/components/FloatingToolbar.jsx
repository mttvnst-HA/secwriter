import { useState, useEffect, useCallback, useRef } from "react";
import {
  applyFormatTr,
  applyInlineMarkTr,
  applyRevisionTr,
  applyInlineRevisionResolveTr,
  applyChangeCaseTr,
} from '../lib/pm-toolbar.js';
import {
  getBlockView,
  flushPendingUpdateById,
  cancelPendingUpdateById,
} from '../lib/block-registry.js';
import { pmFragmentToHtml } from '../lib/pmdoc-html.js';

/**
 * Inline mark types available in the floating toolbar.
 * cls must match the CSS classes in editor.css (mark-rid, mark-srf, etc.)
 * tag is the SGML tag name used during serialization.
 */
const MARK_TYPES = [
  { tag: "RID", cls: "mark-rid", label: "RID", title: "Reference Standard (ASTM, AASHTO)", color: "#86198f", bg: "#fae8ff" },
  { tag: "SRF", cls: "mark-srf", label: "SRF", title: "Section Cross-Reference", color: "#701a75", bg: "#f5d0fe" },
  { tag: "SUB", cls: "mark-sub", label: "SUB", title: "Submittal Item", color: "#1e40af", bg: "#dbeafe" },
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
  { tag: "ADD", cls: "mark-add", label: "ADD", title: "Mark as Addition", color: "#008000", bg: "#f0fdf4", htmlTag: "ins" },
  { tag: "DEL", cls: "mark-del", label: "DEL", title: "Mark as Deletion", color: "#ff4444", bg: "#fef2f2", htmlTag: "del" },
];

export default function FloatingToolbar({
  editorRef,
  onBlockUpdate,
  onRevisionAction,
  onRefreshTcSnapshot,
  trackChanges,
  onCommentCreate,
  identity,
  readOnly = false,
}) {
  const [visible, setVisible] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const [insideRevision, setInsideRevision] = useState(null); // "add" | "del" | null
  const [isRefBlock, setIsRefBlock] = useState(false);
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

    let blockEl = node?.closest?.("[data-block-id][contenteditable='true']");
    let refBlock = false;

    // Fallback: check for ref block or table block (non-contentEditable)
    if (!blockEl) {
      blockEl = node?.closest?.("[data-block-id]");
      if (blockEl?.querySelector?.(".ref-block")) {
        refBlock = true;
      } else {
        blockEl = null;
      }
    }
    // Fallback: table cells (no data-block-id, but inside div[id^="block-"])
    if (!blockEl) {
      const tableWrapper = node?.closest?.('[id^="block-"]');
      if (tableWrapper?.querySelector?.('table')) {
        blockEl = tableWrapper;
        refBlock = true; // treat like ref block — show only comment button, no format/mark buttons
      }
    }

    if (!blockEl) {
      setVisible(false);
      return;
    }

    // Make sure the block is inside our editor pane
    if (editorRef?.current && !editorRef.current.contains(blockEl)) {
      setVisible(false);
      return;
    }

    setIsRefBlock(refBlock);

    // Save the range so we can restore it after toolbar click
    // Extract blockId: from data-block-id attribute or from id="block-xxx"
    const blockId = blockEl.dataset.blockId || blockEl.id?.replace(/^block-/, '') || null;

    selectionRef.current = {
      range: range.cloneRange(),
      blockId,
      blockEl,
      isRefBlock: refBlock,
    };

    // Position above the selection
    // getBoundingClientRect() gives viewport coords in zoomed pixels; we need
    // pre-zoom coords for position:absolute inside the zoomed editor container.
    const rect = range.getBoundingClientRect();
    const editorEl = editorRef?.current;
    const editorRect = editorEl?.getBoundingClientRect() || { top: 0, left: 0 };
    const zoom = parseFloat(editorEl?.style?.zoom) || 1;

    setPosition({
      top: (rect.top - editorRect.top) / zoom - 44,
      left: (rect.left - editorRect.left + rect.width / 2) / zoom,
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
      // Escape dismisses the toolbar and collapses the selection
      if (e.key === "Escape") {
        setVisible(false);
        const sel = window.getSelection();
        if (sel && !sel.isCollapsed) sel.collapseToEnd();
        return;
      }
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
    const { blockId } = saved;
    const view = blockId ? getBlockView(blockId) : null;

    if (view) {
      // PM path — read selection from PM state.
      const kindMap = { 'mark-rid': 'rid', 'mark-srf': 'srf', 'mark-sub': 'sub' };
      const kind = kindMap[markType.cls];
      if (!kind) return;
      const tr = applyInlineMarkTr(view.state, kind);
      if (tr) {
        view.dispatch(tr);
        if (!window.__simEditorTestUtils?.__isFlushOverridden?.()) {
          flushPendingUpdateById(blockId);
        }
      }
      setVisible(false);
      return;
    }

    // Legacy path — DOM mutation (unchanged from pre-1f.9).
    const { range, blockEl } = saved;
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);

    let parentMark = range.commonAncestorContainer;
    if (parentMark.nodeType === 3) parentMark = parentMark.parentElement;
    const existingMark = parentMark.closest?.(`.${markType.cls}`);

    if (existingMark) {
      const text = document.createTextNode(existingMark.textContent);
      existingMark.parentNode.replaceChild(text, existingMark);
    } else {
      const span = document.createElement("span");
      span.className = markType.cls;
      try {
        range.surroundContents(span);
      } catch {
        const fragment = range.extractContents();
        span.appendChild(fragment);
        range.insertNode(span);
      }
    }

    sel.removeAllRanges();
    if (onBlockUpdate && blockEl) onBlockUpdate(blockId, blockEl.innerHTML);
    setVisible(false);
  }, [onBlockUpdate]);

  const applyRevision = useCallback((revType) => {
    const saved = selectionRef.current;
    if (!saved) return;
    const { blockId } = saved;
    const view = blockId ? getBlockView(blockId) : null;

    if (view) {
      // PM path
      const kind = revType.tag === 'ADD' ? 'add' : 'del';
      const tr = applyRevisionTr(view.state, kind, {
        authorId: identity?.id ?? null,
        authorColor: identity?.color ?? null,
      });
      if (tr) {
        view.dispatch(tr);
        if (!window.__simEditorTestUtils?.__isFlushOverridden?.()) {
          flushPendingUpdateById(blockId);
        }
      }
      setVisible(false);
      return;
    }

    // Legacy path
    const { range, blockEl } = saved;
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);

    let parentNode = range.commonAncestorContainer;
    if (parentNode.nodeType === 3) parentNode = parentNode.parentElement;
    const existingEl = parentNode.closest?.(revType.htmlTag + "." + revType.cls);

    if (existingEl && blockEl.contains(existingEl)) {
      const text = document.createTextNode(existingEl.textContent);
      existingEl.parentNode.replaceChild(text, existingEl);
    } else {
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
    if (onBlockUpdate && blockEl) onBlockUpdate(blockId, blockEl.innerHTML);
    setVisible(false);
  }, [onBlockUpdate, identity]);

  // Change case: cycles UPPER → lower → Title
  const changeCase = useCallback(() => {
    const saved = selectionRef.current;
    if (!saved || saved.isRefBlock) return;
    const { blockId } = saved;
    const view = blockId ? getBlockView(blockId) : null;

    if (view) {
      // PM path
      const tr = applyChangeCaseTr(view.state);
      if (tr) {
        view.dispatch(tr);
        if (!window.__simEditorTestUtils?.__isFlushOverridden?.()) {
          flushPendingUpdateById(blockId);
        }
      }
      setVisible(false);
      return;
    }

    // Legacy path
    const { range, blockEl } = saved;
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    const text = range.toString();
    if (!text) return;
    let newText;
    if (text === text.toUpperCase()) newText = text.toLowerCase();
    else if (text === text.toLowerCase()) newText = text.replace(/\b\w/g, c => c.toUpperCase());
    else newText = text.toUpperCase();
    range.deleteContents();
    range.insertNode(document.createTextNode(newText));
    sel.removeAllRanges();
    if (onBlockUpdate && blockEl) onBlockUpdate(blockId, blockEl.innerHTML);
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
    const view = blockId ? getBlockView(blockId) : null;

    if (view) {
      // PM path
      const tr = applyInlineRevisionResolveTr(view.state, action);
      if (tr) {
        view.dispatch(tr);
        // CANCEL — not flush. Distinct from the other PM toolbar verbs
        // (format / inline-mark / revision-apply / change-case) which call
        // flushPendingUpdateById to push the new html through
        // handleBlockUpdate → setBlocks. Here we DON'T want that path —
        // handleBlockUpdate runs outside any resumeHistory() window, so
        // its setBlocks lands inside useUndoableBlocks's paused state and
        // does NOT capture a snapshot. If we then call onRefreshTcSnapshot
        // (which DOES resumeHistory), its setBlocks would capture a
        // snapshot of the post-handleBlockUpdate state — the wrong "prev".
        // Skipping the flush and letting onRefreshTcSnapshot own the
        // single setBlocks call makes the captured snapshot the true
        // pre-action state. Cancel the pending debounce so a late timer
        // doesn't re-issue setBlocks 400ms later with the same html.
        if (!window.__simEditorTestUtils?.__isFlushOverridden?.()) {
          cancelPendingUpdateById(blockId);
        }
        // TC snapshot refresh — DOES NOT call setBlockHtml (PM dispatch
        // already wrote the substrate via ySyncPlugin) but DOES call
        // resumeHistory + setBlocks + setTcState, so the action enters
        // the App-level useUndoableBlocks stack as one frame.
        if (onRefreshTcSnapshot) {
          try {
            const html = pmFragmentToHtml(view.state.doc);
            onRefreshTcSnapshot(blockId, html);
          } catch { /* defensive */ }
        }
      }
      window.getSelection()?.removeAllRanges();
      setVisible(false);
      return;
    }

    // Legacy path
    const sel = window.getSelection();
    const range = saved.range;
    let node = range.commonAncestorContainer;
    if (node.nodeType === 3) node = node.parentElement;

    const insEl = node.closest?.("ins.mark-add");
    const delEl = node.closest?.("del.mark-del");

    if (insEl && blockEl.contains(insEl)) {
      if (action === "accept") {
        const text = document.createTextNode(insEl.textContent);
        insEl.parentNode.replaceChild(text, insEl);
      } else {
        insEl.parentNode.removeChild(insEl);
      }
    } else if (delEl && blockEl.contains(delEl)) {
      if (action === "accept") {
        delEl.parentNode.removeChild(delEl);
      } else {
        const text = document.createTextNode(delEl.textContent);
        delEl.parentNode.replaceChild(text, delEl);
      }
    }

    sel.removeAllRanges();
    const updateFn = onRevisionAction || onBlockUpdate;
    if (updateFn && blockEl) updateFn(blockId, blockEl.innerHTML);
    setVisible(false);
  }, [onBlockUpdate, onRevisionAction, onRefreshTcSnapshot]);

  const applyFormat = useCallback((formatType) => {
    const saved = selectionRef.current;
    if (!saved) return;
    const { blockId } = saved;
    const view = blockId ? getBlockView(blockId) : null;

    if (view) {
      // PM path
      const kindMap = { 'BLD': 'bold', 'ITA': 'italic', 'UND': 'underline' };
      const kind = kindMap[formatType.tag];
      if (!kind) return;
      const tr = applyFormatTr(view.state, kind);
      if (tr) {
        view.dispatch(tr);
        if (!window.__simEditorTestUtils?.__isFlushOverridden?.()) {
          flushPendingUpdateById(blockId);
        }
      }
      setVisible(false);
      return;
    }

    // Legacy path
    const { range, blockEl } = saved;
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);

    let parentNode = range.commonAncestorContainer;
    if (parentNode.nodeType === 3) parentNode = parentNode.parentElement;
    const existingTag = parentNode.closest?.(formatType.htmlTag);

    if (existingTag && blockEl.contains(existingTag)) {
      const text = document.createTextNode(existingTag.textContent);
      existingTag.parentNode.replaceChild(text, existingTag);
    } else {
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
    if (onBlockUpdate && blockEl) onBlockUpdate(blockId, blockEl.innerHTML);
    setVisible(false);
  }, [onBlockUpdate]);

  if (!visible || readOnly) return null;

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
        gap: 3,
        padding: "5px 8px",
        backgroundColor: "#1e293b",
        borderRadius: 8,
        boxShadow: "0 4px 16px rgba(0,0,0,0.2), 0 0 0 1px rgba(0,0,0,0.1)",
        userSelect: "none",
        whiteSpace: "nowrap",
      }}
    >
      {/* Format buttons (not shown for ref blocks) */}
      {!isRefBlock && FORMAT_TYPES.map(fmt => (
        <button
          key={fmt.tag}
          title={fmt.title}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => applyFormat(fmt)}
          style={{
            padding: "4px 10px",
            fontSize: 14,
            fontWeight: fmt.tag === "BLD" ? 700 : 400,
            fontStyle: fmt.tag === "ITA" ? "italic" : "normal",
            textDecoration: fmt.tag === "UND" ? "underline" : "none",
            color: "#f1f5f9",
            backgroundColor: "transparent",
            border: "none",
            borderRadius: 4,
            cursor: "pointer",
            lineHeight: "22px",
            minWidth: 30,
          }}
          onMouseEnter={(e) => e.target.style.backgroundColor = "#334155"}
          onMouseLeave={(e) => e.target.style.backgroundColor = "transparent"}
        >
          {fmt.label}
        </button>
      ))}

      {/* Change Case button (not shown for ref blocks) */}
      {!isRefBlock && (
        <button
          title="Change Case (UPPER → lower → Title)"
          onMouseDown={(e) => e.preventDefault()}
          onClick={changeCase}
          style={{
            padding: "3px 8px",
            fontSize: 12,
            fontWeight: 600,
            color: "#f1f5f9",
            backgroundColor: "transparent",
            border: "none",
            borderRadius: 4,
            cursor: "pointer",
            lineHeight: "22px",
            fontVariant: "small-caps",
          }}
          onMouseEnter={(e) => e.target.style.backgroundColor = "#334155"}
          onMouseLeave={(e) => e.target.style.backgroundColor = "transparent"}
        >Aa</button>
      )}

      {/* Divider + Mark buttons (not shown for ref blocks) */}
      {!isRefBlock && <div style={{ width: 1, height: 24, backgroundColor: "#475569", margin: "0 5px" }} />}

      {!isRefBlock && MARK_TYPES.map(mark => (
        <button
          key={mark.tag}
          title={mark.title}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => applyMark(mark)}
          style={{
            padding: "3px 9px",
            fontSize: 12,
            fontWeight: 600,
            color: mark.color,
            backgroundColor: mark.bg,
            border: "none",
            borderRadius: 4,
            cursor: "pointer",
            lineHeight: "20px",
            letterSpacing: "0.02em",
          }}
          onMouseEnter={(e) => e.target.style.opacity = "0.8"}
          onMouseLeave={(e) => e.target.style.opacity = "1"}
        >
          {mark.label}
        </button>
      ))}

      {/* Revision mark buttons (only when Track Changes is on, not for ref blocks) */}
      {!isRefBlock && trackChanges && (
        <>
          <div style={{ width: 1, height: 24, backgroundColor: "#475569", margin: "0 5px" }} />
          {REVISION_TYPES.map(rev => (
            <button
              key={rev.tag}
              title={rev.title}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => applyRevision(rev)}
              style={{
                padding: "3px 9px",
                fontSize: 12,
                fontWeight: 600,
                color: rev.color,
                backgroundColor: rev.bg,
                border: `1px solid ${rev.color}40`,
                borderRadius: 4,
                cursor: "pointer",
                lineHeight: "20px",
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

      {/* Inline accept/reject (when cursor is inside a revision mark, not for ref blocks) */}
      {!isRefBlock && insideRevision && (
        <>
          <div style={{ width: 1, height: 24, backgroundColor: "#475569", margin: "0 5px" }} />
          <button
            title={`Accept ${insideRevision === "add" ? "addition" : "deletion"}`}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => handleInlineRevisionAction("accept")}
            style={{
              padding: "3px 8px",
              fontSize: 14,
              color: "#008000",
              backgroundColor: "#f0fdf4",
              border: "1px solid #00800040",
              borderRadius: 4,
              cursor: "pointer",
              lineHeight: "20px",
            }}
          >
            ✓
          </button>
          <button
            title={`Reject ${insideRevision === "add" ? "addition" : "deletion"}`}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => handleInlineRevisionAction("reject")}
            style={{
              padding: "3px 8px",
              fontSize: 14,
              color: "#ff4444",
              backgroundColor: "#fef2f2",
              border: "1px solid #ff444440",
              borderRadius: 4,
              cursor: "pointer",
              lineHeight: "20px",
            }}
          >
            ✗
          </button>
        </>
      )}

      {/* XXX(#64): Comment-create stays on the DOM-mutation path in
          both legacy and PM modes. y-prosemirror's
          prosemirrorToYXmlFragment drops the `comment` mark, so we
          cannot dispatch a PM transaction here without losing the
          mark on the next ySync round-trip. In PM mode the visible
          <span class="mark-comment"> is reverted by PM's DOMObserver
          on the next render, but the metadata still reaches
          commentsState via onCommentCreate. The disagreement is
          accepted per CLAUDE.md Comments-Architecture note 10 until
          issue #64 is resolved. */}
      {/* Comment button */}
      {onCommentCreate && selectionRef.current?.blockId && (
        <>
          {!isRefBlock && <div style={{ width: 1, height: 24, backgroundColor: "#475569", margin: "0 5px" }} />}
          <button
            title="Add Comment"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              const { range, blockId, blockEl, isRefBlock: refBlock } = selectionRef.current || {};
              if (!range || !blockEl) return;
              const sel = window.getSelection();
              sel.removeAllRanges();
              sel.addRange(range);
              const commentId = `comment-${Date.now()}`;
              const span = document.createElement("span");
              span.className = "mark-comment";
              span.setAttribute("data-comment-id", commentId);
              try { range.surroundContents(span); } catch {
                const fragment = range.extractContents();
                span.appendChild(fragment);
                range.insertNode(span);
              }
              // For ref blocks, pass null html (don't overwrite block.html — ref data is in block.ref)
              const html = refBlock ? null : blockEl.innerHTML;
              onCommentCreate(blockId, html, commentId, span.textContent);
              setVisible(false);
            }}
            style={{
              padding: "3px 9px",
              fontSize: 14,
              color: "#854d0e",
              backgroundColor: "#fef9c3",
              border: "1px solid #eab30860",
              borderRadius: 4,
              cursor: "pointer",
              lineHeight: "20px",
            }}
          >
            &#x1F4AC;
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
