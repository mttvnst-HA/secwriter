import { useRef, useCallback, useEffect } from "react";
import { sanitizePasteText } from "./EditableBlock.jsx";

function TitleBlock({ block, onFocus, isFocused, sectionNum, onUpdate, onPromote, onDemote, onEnterKey, onDelete, onFocusPrev, onFocusNext }) {
  const ref = useRef(null);
  const initialized = useRef(false);
  const isPart = block.html.startsWith("PART ");
  const depth = block.depth;

  useEffect(() => {
    if (ref.current && !initialized.current && !isPart) {
      ref.current.innerHTML = block.html;
      initialized.current = true;
    }
  }, []);

  const handleKeyDown = useCallback((e) => {
    if (e.key === "Tab") {
      e.preventDefault();
      if (e.shiftKey) {
        onPromote(block.id);
      } else {
        onDemote(block.id);
      }
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      if (ref.current) onUpdate(block.id, ref.current.innerHTML);
      onEnterKey(block.id);
      return;
    }
    if (e.key === "Backspace") {
      const text = ref.current ? ref.current.textContent.trim() : "";
      if (text.length === 0) {
        e.preventDefault();
        onDelete(block.id);
        return;
      }
    }
    if (e.key === "ArrowUp") {
      const sel = window.getSelection();
      if (sel.rangeCount && sel.getRangeAt(0).collapsed) {
        const range = sel.getRangeAt(0);
        const pre = document.createRange();
        pre.setStart(ref.current, 0);
        pre.setEnd(range.startContainer, range.startOffset);
        if (pre.toString().length === 0) {
          e.preventDefault();
          if (ref.current) onUpdate(block.id, ref.current.innerHTML);
          onFocusPrev(block.id);
        }
      }
      return;
    }
    if (e.key === "ArrowDown") {
      const sel = window.getSelection();
      if (sel.rangeCount && sel.getRangeAt(0).collapsed) {
        const range = sel.getRangeAt(0);
        const post = document.createRange();
        post.setStart(range.endContainer, range.endOffset);
        post.setEnd(ref.current, ref.current.childNodes.length);
        if (post.toString().length === 0) {
          e.preventDefault();
          if (ref.current) onUpdate(block.id, ref.current.innerHTML);
          onFocusNext(block.id);
        }
      }
      return;
    }
  }, [block.id, onUpdate, onPromote, onDemote, onEnterKey, onDelete, onFocusPrev, onFocusNext]);

  const handleBlur = useCallback(() => {
    if (ref.current && !isPart) {
      onUpdate(block.id, ref.current.innerHTML);
    }
  }, [block.id, onUpdate, isPart]);

  const handlePaste = useCallback((e) => {
    e.preventDefault();
    const text = sanitizePasteText(e.clipboardData.getData('text/plain'));
    if (text) {
      document.execCommand('insertText', false, text);
    }
  }, []);

  const style = {
    fontFamily: "'Georgia', 'Cambria', serif",
    fontWeight: isPart ? 800 : depth === 1 ? 700 : 600,
    fontSize: isPart ? 18 : depth === 1 ? 15 : 14,
    textTransform: depth <= 1 ? "uppercase" : "none",
    letterSpacing: isPart ? "0.04em" : depth === 1 ? "0.02em" : 0,
    color: isPart ? "#0f172a" : depth === 1 ? "#1e293b" : "#334155",
    padding: isPart ? "20px 12px 8px" : depth === 1 ? "16px 12px 4px" : "10px 12px 2px",
    marginLeft: 0,
    borderBottom: isPart ? "2px solid #1e293b" : depth === 1 ? "1px solid #e2e8f0" : "none",
    cursor: "text",
    borderRadius: 3,
    backgroundColor: isFocused ? "#f1f5f9" : "transparent",
    display: "flex",
    alignItems: "baseline",
    gap: 8,
    outline: "none",
  };

  return (
    <div
      id={`block-${block.id}`}
      style={style}
      onClick={() => onFocus(block.id)}
      data-tag="TTL"
    >
      {sectionNum && (
        <span style={{
          color: "#6384a8",
          fontFamily: "'SF Mono', 'Consolas', monospace",
          fontSize: isPart ? 18 : depth === 1 ? 14 : 13,
          fontWeight: 700,
          flexShrink: 0,
          minWidth: depth === 1 ? 40 : depth === 2 ? 56 : depth === 3 ? 72 : 88,
          userSelect: "none",
        }}>
          {sectionNum}
        </span>
      )}
      {isPart ? (
        <span dangerouslySetInnerHTML={{ __html: block.html }} />
      ) : (
        <span
          ref={ref}
          data-block-id={block.id}
          contentEditable
          suppressContentEditableWarning
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          onBlur={handleBlur}
          style={{ outline: "none", flex: 1, minWidth: 20 }}
        />
      )}
      {isFocused && !isPart && (
        <span style={{
          fontSize: 10,
          color: "#94a3b8",
          whiteSpace: "nowrap",
          userSelect: "none",
          flexShrink: 0,
        }}>
          Tab/Shift+Tab to change level
        </span>
      )}
    </div>
  );
}

export default TitleBlock;
