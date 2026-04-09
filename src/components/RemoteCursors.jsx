import { useEffect, useRef, useState } from 'react';

/**
 * Absolute-positioned overlay rendering a thin colored caret + name label
 * for every remote user whose cursor falls inside a block currently in the
 * DOM. Best-effort: if the block isn't mounted, the cursor is hidden.
 *
 * Coordinate space:
 *   The overlay sits as `position: absolute; inset: 0` inside the editor's
 *   `position: relative` wrapper. All cursor coordinates must therefore be
 *   expressed *relative to the overlay's own bounding rect*, NOT to the
 *   document. An earlier version added window.scrollY which rendered the
 *   carets hundreds of pixels offscreen.
 *
 * Layout-drift tracking:
 *   Caret positions shift whenever the editor content changes (typing,
 *   block insertion, image load) or its box changes (window resize, font
 *   size toggle). Rather than polling on an interval — which burns CPU
 *   and battery continuously — we observe the actual causes:
 *     - scroll:             capture: true on window so nested scrollers bubble up
 *     - ResizeObserver:     editor container geometry changes
 *     - MutationObserver:   childList + characterData + subtree (typing, inserts)
 *   All three funnel into a rAF-throttled measure() so rapid typing coalesces
 *   into at most one measurement per frame.
 *
 *   Observers are fully torn down when there are no remote peers — no
 *   background work when the user is alone in the room.
 */
export default function RemoteCursors({ peers, selfId, editorRef }) {
  const overlayRef = useRef(null);
  const [positions, setPositions] = useState([]);

  useEffect(() => {
    // Nothing to draw and nothing to observe when we're alone.
    const remotePeers = peers.filter((p) => p?.user && p.user.id !== selfId);
    if (remotePeers.length === 0) {
      setPositions([]);
      return undefined;
    }

    const container = editorRef?.current || null;

    function measureNow() {
      const overlay = overlayRef.current;
      if (!overlay) return;
      const ox = overlay.getBoundingClientRect();

      const next = [];
      for (const p of remotePeers) {
        const cursor = p.cursor;
        if (!cursor || !cursor.blockId) continue;
        // Scope the query to the editor container when we have one, so
        // multiple editor instances (e.g. test harnesses) don't cross-
        // contaminate and so stray elements outside the editor can't
        // shadow a real block id.
        const root = container || document;
        const blockEl = root.querySelector(`[data-block-id="${cursor.blockId}"]`);
        if (!blockEl) continue;
        const rect = caretRectAt(blockEl, cursor.index || 0);
        if (!rect) continue;
        next.push({
          id: p.user.id,
          name: p.user.name,
          color: p.user.color || '#64748b',
          top: rect.top - ox.top,
          left: rect.left - ox.left,
          height: rect.height || 18,
        });
      }
      setPositions(next);
    }

    // rAF-throttled scheduler: many events per frame collapse into one
    // measurement. Critical during rapid typing where MutationObserver
    // may fire hundreds of times per second.
    let rafPending = false;
    function scheduleMeasure() {
      if (rafPending) return;
      rafPending = true;
      requestAnimationFrame(() => {
        rafPending = false;
        measureNow();
      });
    }

    // Initial measure on the next frame so layout is settled.
    scheduleMeasure();

    // Global events.
    window.addEventListener('scroll', scheduleMeasure, true);
    window.addEventListener('resize', scheduleMeasure);

    // Geometry + DOM observers scoped to the editor container.
    let resizeObs = null;
    let mutationObs = null;
    if (container && typeof ResizeObserver !== 'undefined') {
      resizeObs = new ResizeObserver(scheduleMeasure);
      resizeObs.observe(container);
    }
    if (container && typeof MutationObserver !== 'undefined') {
      mutationObs = new MutationObserver(scheduleMeasure);
      mutationObs.observe(container, {
        childList: true,
        characterData: true,
        subtree: true,
      });
    }

    return () => {
      window.removeEventListener('scroll', scheduleMeasure, true);
      window.removeEventListener('resize', scheduleMeasure);
      if (resizeObs) resizeObs.disconnect();
      if (mutationObs) mutationObs.disconnect();
    };
  }, [peers, selfId, editorRef]);

  return (
    <div ref={overlayRef} style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 500 }}>
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
      return el.getBoundingClientRect();
    }
    remaining -= len;
  }
  return el.getBoundingClientRect();
}
