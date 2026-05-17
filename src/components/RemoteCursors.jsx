import { useEffect, useRef, useState } from 'react';
import { getBlockEditable } from '../lib/block-registry.js';

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
/**
 * @param peers       Array of `{ clientId, user, cursor }` from
 *                    `awareness.getStates()`. `user` carries the persistent
 *                    identity ({ id, name, color }).
 * @param selfId      The LOCAL user's PERSISTENT id (identity.id hex string),
 *                    NOT the Yjs `awareness.clientID` (an integer that
 *                    changes per connection). Both the presence bar and the
 *                    filter below use the persistent identity id so all
 *                    tabs/reconnects of the same user collapse into one
 *                    presence entry. If you ever confuse namespaces here
 *                    you'll either render a self-cursor (when selfId is a
 *                    clientID and user.id is identity.id) or dedupe wrong.
 * @param editorRef   Ref to the editor container div, used to scope the
 *                    block query and attach observers.
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
        // Prefer the App-scoped registry — for PM-mounted blocks this
        // returns the EditorView's DOM root (where text actually lives)
        // rather than the surrounding container div. The registry is
        // module-global, so verify the returned element lives inside
        // this editor's container before trusting it (preserves the
        // editor-scoped containment from da41ff1). Falls back to a
        // scoped querySelector for blocks not yet registered.
        const root = container || document;
        const registered = getBlockEditable(cursor.blockId);
        const inScope = registered && (!container || container.contains(registered));
        const blockEl = (inScope ? registered : null)
          || root.querySelector(/* allowed: block-registry fallback */ `[data-block-id="${cursor.blockId}"]`);
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
      // N2 — MutationObserver fires on every keystroke in every block.
      // Without this guard we'd call setPositions (and therefore rerender
      // the overlay) 60x/sec during sustained typing even when no remote
      // cursor actually moved. Shallow-compare against the last computed
      // positions and bail out when nothing changed.
      setPositions((prev) => (cursorListsEqual(prev, next) ? prev : next));
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
      // M-4: debounce measurement via requestIdleCallback (50ms fallback)
      // so sustained local typing does not trigger O(peers × measure) on
      // every keystroke. Leading-edge measurement still happens via the
      // selectionchange handler; this observer only backs it up.
      let idleScheduled = false;
      const idleSchedule = () => {
        if (idleScheduled) return;
        idleScheduled = true;
        const ric = window.requestIdleCallback || ((cb) => setTimeout(cb, 50));
        ric(() => {
          idleScheduled = false;
          scheduleMeasure();
        });
      };
      mutationObs = new MutationObserver(idleSchedule);
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

/** Shallow-compare two cursor position lists by id+coords+height. */
function cursorListsEqual(a, b) {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (x.id !== y.id || x.top !== y.top || x.left !== y.left || x.height !== y.height || x.name !== y.name || x.color !== y.color) {
      return false;
    }
  }
  return true;
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
