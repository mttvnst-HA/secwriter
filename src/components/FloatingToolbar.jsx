import { useState, useEffect, useCallback, useRef } from "react";
import {
  applyFormatTr,
  applyInlineMarkTr,
  applyRevisionTr,
  applyInlineRevisionResolveTr,
  applyChangeCaseTr,
  applyCommentMarkTr,
  dispatchToolbarVerb,
  extractHtml,
  extractRangeText,
} from '../lib/pm-toolbar.js';
import { getBlockView } from '../lib/block-registry.js';
import { saveSelection as savePmRelpos } from '../lib/pm-relpos.js';

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

/**
 * 1g.7 (#88) — Y.RelativePosition save/restore for the floating toolbar:
 * save happens here on `selectionchange` (so the saved tuple captures
 * the user's intended target the moment they finish selecting); restore
 * happens inside `dispatchToolbarVerb` immediately before the verb's PM
 * dispatch. If the saved relpos is null (legacy/ref/table block — no PM
 * EditorView), the restore is a no-op and the verb runs against
 * `view.state.selection` as-is.
 */

export default function FloatingToolbar({
  editorRef,
  onRefreshTcSnapshot,
  // 1h Q36 Commit C review — forceFrame closes the active Yjs
  // UndoManager capture window before a PM toolbar dispatch, so the
  // toolbar action doesn't coalesce with the user's prior typing in
  // Ctrl+Z. App passes `inRoom ? collab.forceFrame : localUndo.forceFrame`.
  // Optional: defensive callers may omit it.
  onForceFrame,
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

    // 1g.7 (#88) — save a Y.RelativePosition tuple for PM-mounted blocks.
    // Used by PM-path action handlers to restore the view's selection
    // right before dispatching a tr, so a peer's edit between toolbar
    // open and click doesn't shift the action off the user's intended
    // target. Falls back to the DOM Range for legacy / ref / table blocks
    // (no PM view registered → savedRelpos === null).
    let savedRelpos = null;
    if (blockId) {
      const view = getBlockView(blockId);
      if (view) {
        try { savedRelpos = savePmRelpos(view); }
        catch { savedRelpos = null; }
      }
    }

    selectionRef.current = {
      range: range.cloneRange(),
      blockId,
      blockEl,
      isRefBlock: refBlock,
      savedRelpos,
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
    const view = saved.blockId ? getBlockView(saved.blockId) : null;
    const kindMap = { 'mark-rid': 'rid', 'mark-srf': 'srf', 'mark-sub': 'sub' };
    const kind = kindMap[markType.cls];
    if (!kind) return;
    dispatchToolbarVerb({
      view,
      saved,
      compute: (state) => applyInlineMarkTr(state, kind),
      onForceFrame,
    });
    setVisible(false);
  }, [onForceFrame]);

  const applyRevision = useCallback((revType) => {
    const saved = selectionRef.current;
    if (!saved) return;
    const view = saved.blockId ? getBlockView(saved.blockId) : null;
    const kind = revType.tag === 'ADD' ? 'add' : 'del';
    // Issue #97 — pass trackChanges so the verb can suppress its legacy
    // toggle-off path on ranges already owned by per-keystroke marking
    // (1h Q33). Out-of-TC mode the toggle remains intact.
    dispatchToolbarVerb({
      view,
      saved,
      compute: (state) => applyRevisionTr(state, kind, {
        authorId: identity?.id ?? null,
        authorColor: identity?.color ?? null,
      }, trackChanges),
      onForceFrame,
    });
    setVisible(false);
    // Issue #97 — `trackChanges` must be in deps. Without it, the closure
    // captures the initial value (false) and never observes the user
    // flipping TC on; `applyRevisionTr` then runs the legacy toggle-off
    // path on a range already marked by per-keystroke marking, stripping
    // the marks the user just typed.
  }, [identity, onForceFrame, trackChanges]);

  // Change case: cycles UPPER → lower → Title
  const changeCase = useCallback(() => {
    const saved = selectionRef.current;
    if (!saved || saved.isRefBlock) return;
    const view = saved.blockId ? getBlockView(saved.blockId) : null;
    dispatchToolbarVerb({
      view,
      saved,
      compute: (state) => applyChangeCaseTr(state),
      onForceFrame,
    });
    setVisible(false);
  }, [onForceFrame]);

  /**
   * Accept or reject an inline revision mark.
   * action: "accept" or "reject"
   *
   * Settlement is 'caller-owned' (declared in applyInlineRevisionResolveTr's
   * descriptor): the dispatcher calls cancelPendingUpdateById, not flush.
   * The 400ms onUpdate debounce is cleared so a late-firing setBlocks does
   * not clobber the snapshot that onRefreshTcSnapshot is about to settle.
   */
  const handleInlineRevisionAction = useCallback((action) => {
    const saved = selectionRef.current;
    if (!saved) return;
    const view = saved.blockId ? getBlockView(saved.blockId) : null;
    const result = dispatchToolbarVerb({
      view,
      saved,
      compute: (state) => applyInlineRevisionResolveTr(state, action),
      onForceFrame,
    });
    if (result.dispatched && onRefreshTcSnapshot) {
      // TC snapshot refresh — DOES NOT call setBlockHtml (PM dispatch
      // already wrote the substrate via ySyncPlugin); calls setBlocks
      // + setTcState to reflect the action in React state.
      try { onRefreshTcSnapshot(result.blockId, extractHtml(result.state)); }
      catch { /* defensive */ }
    }
    window.getSelection()?.removeAllRanges();
    setVisible(false);
  }, [onRefreshTcSnapshot, onForceFrame]);

  const applyFormat = useCallback((formatType) => {
    const saved = selectionRef.current;
    if (!saved) return;
    const view = saved.blockId ? getBlockView(saved.blockId) : null;
    const kindMap = { 'BLD': 'bold', 'ITA': 'italic', 'UND': 'underline' };
    const kind = kindMap[formatType.tag];
    if (!kind) return;
    dispatchToolbarVerb({
      view,
      saved,
      compute: (state) => applyFormatTr(state, kind),
      onForceFrame,
    });
    setVisible(false);
  }, [onForceFrame]);

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

      {/* Comment button. PM path dispatches addMark via applyCommentMarkTr
          (issue #64 resolution — the prior carve-out was based on a
          misdiagnosis; the `comment` mark survives prosemirrorToYXmlFragment
          fine). Legacy / ref / table blocks still use the DOM-mutation
          path (no PM EditorView registered for those). */}
      {onCommentCreate && selectionRef.current?.blockId && (
        <>
          {!isRefBlock && <div style={{ width: 1, height: 24, backgroundColor: "#475569", margin: "0 5px" }} />}
          <button
            title="Add Comment"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              const saved = selectionRef.current || {};
              const { range, blockId, blockEl, isRefBlock: refBlock } = saved;
              if (!range || !blockEl) return;
              const view = blockId ? getBlockView(blockId) : null;

              if (view && !refBlock) {
                // PM path. commentId is caller-generated pre-dispatch
                // so it can flow into the verb's args AND into the
                // post-dispatch onCommentCreate envelope. The verb's
                // descriptor still owns settlement (flush) + range.
                const commentId = `comment-${Date.now()}`;
                const result = dispatchToolbarVerb({
                  view,
                  saved,
                  compute: (state) => applyCommentMarkTr(state, commentId),
                  onForceFrame,
                });
                if (result.dispatched) {
                  onCommentCreate(
                    result.blockId,
                    extractHtml(result.state),
                    commentId,
                    extractRangeText(result.state, result.range),
                  );
                }
                setVisible(false);
                return;
              }

              // Legacy / ref-block DOM path (unchanged).
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
