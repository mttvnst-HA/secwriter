/**
 * block-registry.js — App-scoped registry of mounted EditableBlock /
 * PmEditableBlock components, keyed by blockId.
 *
 * Sub-PR 1e (#47, v2 plan Q17/E4). The legacy code path used
 * `document.querySelector('[data-block-id="…"]')` to imperatively focus
 * blocks, sync DOM after mark-suggestion replaces, and restore caret after
 * remote updates. PM-mounted blocks own their internal DOM and do not
 * expose a single contentEditable for these reach-ins.
 *
 * The registry is a single module-level Map. Mounted EditableBlock /
 * PmEditableBlock register their imperative handle on mount and unregister
 * on unmount. App.jsx callsites that previously did querySelector(...) now
 * call `focusBlockById(id, { atEnd })` etc.
 *
 * Module-level (not via React Context) because:
 *   1. App.jsx hooks are deeply nested — threading the registry through
 *      every callback prop would touch ~10 callsites.
 *   2. The registry has zero React-state semantics — it's a pure imperative
 *      side-channel between two siblings under a common provider.
 *   3. Tests can clear it via `__resetBlockRegistry()`.
 *
 * Each entry is a `BlockHandle`:
 *   focus({ atEnd?: boolean }) — places the caret in the block
 *   getDom() → Element | null — the block's outer container element
 *   getEditable() → Element | null — the contentEditable (legacy) or PM
 *     EditorView's DOM root (1e)
 *   getPlainText() → string — current text content (DOM-safe)
 *   setHtml(html) — legacy contentEditable path: replace innerHTML
 *     (used by MarkSuggestions). PM path: NO-OP. PM owns its DOM and
 *     re-renders from state.doc on every dispatch, so innerHTML writes
 *     are clobbered. App-level callsites that need the change to reach
 *     the substrate must call `setBlockHtml(yStore, id, html)` from
 *     `block-html-store.js` directly — `handle.setHtml` is retained on
 *     the PM handle only so the legacy callsite signature compiles.
 */

const handles = new Map();

/**
 * @typedef {Object} BlockHandle
 * @property {(opts?: {atEnd?: boolean}) => void} focus
 * @property {() => Element | null} getDom
 * @property {() => Element | null} getEditable
 * @property {() => string} getPlainText
 * @property {(html: string) => void} setHtml
 * @property {(() => import('prosemirror-view').EditorView | null)=} getView
 *   PM handle returns the EditorView; legacy returns null. Used by
 *   FloatingToolbar (1f.9) to choose the PM-transaction branch.
 * @property {(() => void)=} flushPendingUpdate
 *   PM handle: cancels onUpdate debounce timer and synchronously fires
 *   onUpdate(blockId, pmFragmentToHtml(view.state.doc)). Legacy: no-op.
 *   Required after a toolbar dispatch to close the 400ms window where
 *   App's blocks ref carries pre-toolbar html.
 */

/** Register a block's imperative handle. Idempotent: re-registering replaces. */
export function registerBlock(blockId, handle) {
  if (!blockId || !handle) return;
  handles.set(blockId, handle);
}

/** Remove a block from the registry. Safe to call on a non-registered id. */
export function unregisterBlock(blockId) {
  if (!blockId) return;
  handles.delete(blockId);
}

export function getBlockHandle(blockId) {
  return handles.get(blockId) || null;
}

/**
 * Focus a block by id. Returns true if the block was registered (i.e. the
 * focus call dispatched). Caller can use the boolean to decide whether to
 * fall through to a setTimeout retry while React finishes mounting.
 */
export function focusBlockById(blockId, opts) {
  const h = handles.get(blockId);
  if (!h) return false;
  try {
    h.focus(opts || { atEnd: true });
  } catch {
    return false;
  }
  return true;
}

/** Return the block's outer container DOM element, or null. */
export function getBlockDom(blockId) {
  const h = handles.get(blockId);
  return h ? h.getDom() : null;
}

/** Return the block's contentEditable element, or null. */
export function getBlockEditable(blockId) {
  const h = handles.get(blockId);
  return h ? h.getEditable() : null;
}

/** Bulk-iterate registered blocks. Insertion order — see
 *  listBlocksInDocumentOrder for callers that need DOM order (e.g. anchor
 *  selection across the editor's viewport). */
export function listRegisteredBlockIds() {
  return Array.from(handles.keys());
}

/**
 * Return registered blocks in document (DOM) order as `[{id, dom}, ...]`.
 * Insertion order diverges from document order whenever a block is created
 * mid-document (slash menu split, paste, undo/redo) — the new component
 * mounts AFTER its neighbours, so its handle is registered last even though
 * the element sits in the middle of the editor. Anchor-finding logic that
 * walks "first visible block from the top" must traverse DOM order.
 *
 * Entries whose `getDom()` returns null (mid-teardown, stale handle) are
 * excluded. Sort uses `compareDocumentPosition`; elements not connected to
 * the document compare equal and end up adjacent — they are excluded too
 * (caller treats null/disconnected as "no block here").
 */
export function listBlocksInDocumentOrder() {
  const out = [];
  for (const [id, h] of handles) {
    const dom = h.getDom?.();
    if (!dom || typeof dom.compareDocumentPosition !== 'function') continue;
    if (!dom.isConnected) continue;
    out.push({ id, dom });
  }
  out.sort((a, b) => {
    const rel = a.dom.compareDocumentPosition(b.dom);
    if (rel & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
    if (rel & Node.DOCUMENT_POSITION_PRECEDING) return 1;
    return 0;
  });
  return out;
}

/**
 * Return the EditorView for a PM-mounted block, or null. For legacy blocks
 * (EditableBlock's contentEditable path) and brand-new PM blocks not yet
 * mounted, returns null. Use the null result to fork between the PM
 * transaction path and the legacy DOM-mutation path in FloatingToolbar.
 */
export function getBlockView(blockId) {
  const h = handles.get(blockId);
  return h && typeof h.getView === 'function' ? h.getView() : null;
}

/**
 * Synchronously flush a PM handle's pending debounced onUpdate so App's
 * React blocks array reflects the substrate immediately. No-op for legacy
 * handles or unknown ids. Safe to call multiple times.
 */
export function flushPendingUpdateById(blockId) {
  const h = handles.get(blockId);
  if (h && typeof h.flushPendingUpdate === 'function') {
    try { h.flushPendingUpdate(); } catch { /* defensive */ }
  }
}

/** Test-only — full reset between Vitest cases. */
export function __resetBlockRegistry() {
  handles.clear();
}
