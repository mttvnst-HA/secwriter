import { useEffect, useState } from 'react';

/**
 * Absolute-positioned overlay rendering a thin colored caret + name label
 * for every remote user whose cursor falls inside a block currently in the
 * DOM. Best-effort: if the block isn't mounted, the cursor is hidden.
 *
 * Approach:
 *   - Each remote peer broadcasts { blockId, index } via awareness.
 *   - We measure the position of character `index` inside
 *     [data-block-id="<blockId>"] using a transient Range + getClientRects().
 *   - Re-measure on window scroll/resize and whenever peers change.
 */
export default function RemoteCursors({ peers, selfId, editorRef }) {
  const [positions, setPositions] = useState([]);

  useEffect(() => {
    function measure() {
      const next = [];
      for (const p of peers) {
        if (!p?.user || p.user.id === selfId) continue;
        const cursor = p.cursor;
        if (!cursor || !cursor.blockId) continue;
        const blockEl = document.querySelector(`[data-block-id="${cursor.blockId}"]`);
        if (!blockEl) continue;
        const rect = caretRectAt(blockEl, cursor.index || 0);
        if (!rect) continue;
        next.push({
          id: p.user.id,
          name: p.user.name,
          color: p.user.color || '#64748b',
          top: rect.top + window.scrollY,
          left: rect.left + window.scrollX,
          height: rect.height || 18,
        });
      }
      setPositions(next);
    }

    measure();
    const raf = requestAnimationFrame(measure);
    window.addEventListener('scroll', measure, true);
    window.addEventListener('resize', measure);
    const interval = setInterval(measure, 1000); // cheap fallback for layout drift
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('scroll', measure, true);
      window.removeEventListener('resize', measure);
      clearInterval(interval);
    };
  }, [peers, selfId, editorRef]);

  return (
    <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 500 }}>
      {positions.map((p) => (
        <div key={p.id}>
          <div style={{
            position: 'absolute',
            top: p.top, left: p.left,
            width: 2, height: p.height,
            background: p.color,
            opacity: 0.85,
          }} />
          <div style={{
            position: 'absolute',
            top: p.top - 18, left: p.left,
            fontSize: 10, fontWeight: 600,
            color: '#fff', background: p.color,
            padding: '1px 5px', borderRadius: 3,
            whiteSpace: 'nowrap',
          }}>
            {p.name}
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * Walk text nodes in `el` and return a DOMRect for the caret at plain-text
 * offset `index`. Returns null if the offset exceeds the text length.
 */
function caretRectAt(el, index) {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
  let remaining = index;
  let node;
  while ((node = walker.nextNode())) {
    const len = node.nodeValue.length;
    if (remaining <= len) {
      const range = document.createRange();
      range.setStart(node, remaining);
      range.setEnd(node, remaining);
      const rects = range.getClientRects();
      if (rects.length > 0) return rects[0];
      // Fall back to the block's own rect if the range had no rects (rare).
      return el.getBoundingClientRect();
    }
    remaining -= len;
  }
  // Index past end — clamp to end of block.
  return el.getBoundingClientRect();
}
