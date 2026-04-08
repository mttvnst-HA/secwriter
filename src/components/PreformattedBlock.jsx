import { useRef, useCallback, useEffect } from "react";

/**
 * PreformattedBlock — editable wrapper for `tbl` (preformatted/monospace) blocks.
 *
 * TBL blocks store content as HTML with literal `\n` line breaks plus optional
 * inline mark spans (RID, HL4, etc.). The serializer (serializeTbl) converts
 * `\n` ↔ `<BRK/>` and an outer `<b>...</b>` ↔ `<THD>...</THD>`.
 *
 * Design:
 * - Uncontrolled contentEditable: innerHTML is set once on mount via ref callback;
 *   subsequent React re-renders never re-set innerHTML while user is typing
 *   (would clobber caret). External updates re-init only when block.id changes.
 * - Commit on blur — TBL is whitespace-sensitive, debounced input would jitter caret.
 * - Normalize on blur: <br> → \n, </div><div> → \n, &nbsp; → space, strip ZWSP.
 * - spellCheck=false (consistent with rest of SIM, no browser exfiltration).
 */
function PreformattedBlock({ block, isFocused, onFocus, onUpdate, showTags = false }) {
  const ref = useRef(null);
  const initIdRef = useRef(null);

  const setRef = useCallback((node) => {
    ref.current = node;
    if (!node) return;
    // Initialize innerHTML once per block.id. Re-init if the block identity changes
    // (e.g. file load) but never on simple re-renders during editing.
    if (initIdRef.current !== block.id) {
      node.innerHTML = block.html || "";
      initIdRef.current = block.id;
    }
  }, [block.id, block.html]);

  // If block.html changes externally (undo/redo, accept/reject revision, file load
  // for the same id), sync the DOM. Skip when the change originated from our own blur.
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    // Compare normalized innerHTML to incoming html. If different and the node is
    // not currently focused, update.
    const current = normalize(node.innerHTML);
    if (current !== (block.html || "") && document.activeElement !== node) {
      node.innerHTML = block.html || "";
    }
  }, [block.html]);

  const handleBlur = () => {
    const node = ref.current;
    if (!node) return;
    const next = normalize(node.innerHTML);
    if (next !== (block.html || "")) {
      onUpdate?.(block.id, { html: next });
    }
  };

  const handleClick = () => {
    onFocus?.(block.id);
  };

  return (
    <div
      ref={setRef}
      key={block.id}
      id={`block-${block.id}`}
      className="block-tbl"
      data-block-id={block.id}
      data-tag="TBL"
      contentEditable={true}
      suppressContentEditableWarning={true}
      spellCheck={false}
      onClick={handleClick}
      onBlur={handleBlur}
      style={{
        padding: "12px 16px",
        margin: "4px 0",
        outline: isFocused ? "2px solid #3b82f6" : "none",
      }}
    />
  );
}

/** Normalize contentEditable innerHTML back into TBL block storage shape. */
function normalize(html) {
  if (!html) return "";
  return html
    // Browser inserts <div>foo</div> for new lines (Chrome) or <br> (Firefox)
    .replace(/<div><br\s*\/?><\/div>/gi, "\n")
    .replace(/<div>/gi, "\n")
    .replace(/<\/div>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/&nbsp;/g, " ")
    .replace(/\u200B/g, "")
    // Strip a leading newline introduced by the first <div> wrap
    .replace(/^\n/, "");
}

export default PreformattedBlock;
