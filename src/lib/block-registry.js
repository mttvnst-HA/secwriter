/**
 * block-registry.js — App-scoped registry of mounted block components
 * (PmEditableBlock and TitleBlock), keyed by blockId.
 *
 * Sub-PR 1e (#47, v2 plan Q17/E4). Replaces the previous
 * `document.querySelector('[data-block-id="…"]')` reach-ins used for
 * imperative focus, mark-suggestion DOM syncs, and caret restoration.
 * PM-mounted blocks own their internal DOM and don't expose a single
 * contentEditable for those reach-ins.
 *
 * The registry is a single module-level Map. Mounted blocks register
 * their imperative handle on mount and unregister on unmount. App.jsx
 * callsites that previously did querySelector(...) now call
 * `focusBlockById(id, { atEnd })` etc.
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
 *   getEditable() → Element | null — the block's editable surface
 *     (PmEditableBlock returns its EditorView's DOM root; TitleBlock
 *     returns its contentEditable title span)
 *   getPlainText() → string — current text content (DOM-safe)
 *   setHtml(html) — PmEditableBlock: NO-OP (PM owns its DOM and
 *     re-renders from state.doc on every dispatch; App callers needing
 *     to push html into PM should call `setBlockHtml(yStore, id, html)`
 *     directly so ySyncPlugin observes the substrate change).
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
 * @property {(() => void)=} cancelPendingUpdate
 *   PM handle: clears the onUpdate debounce timer WITHOUT firing onUpdate.
 *   Legacy: no-op. Used by callers that will push their own setBlocks
 *   downstream (e.g. inline TC accept/reject's onRefreshTcSnapshot) and
 *   must not have a late debounce flush re-issue setBlocks with stale html.
 * @property {((coords: {x:number,y:number}) => object | null)=} getContextAtCoords
 *   PM handle: resolves a context descriptor (mark/selection state) at the
 *   given viewport coordinate for the right-click context menu. Other hosts
 *   omit it (App resolves Title/Ref/Table from the DOM directly).
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
 * Return the EditorView for a PM-mounted block, or null. Returns null for
 * non-PM blocks (TitleBlock, RefBlock, TableBlock) and for brand-new PM
 * blocks not yet mounted. Use the null result to fork between the PM
 * transaction path and the DOM-mutation path in FloatingToolbar.
 */
export function getBlockView(blockId) {
  const h = handles.get(blockId);
  return h && typeof h.getView === 'function' ? h.getView() : null;
}

/**
 * Resolve a context descriptor at viewport coordinates for a PM-mounted
 * block via its `getContextAtCoords` handle. Returns null for non-PM hosts
 * (no such handle), unknown ids, or a throwing handle (mid-teardown view).
 * Never throws — the App-level contextmenu listener relies on a null return
 * to fall through to the native browser menu.
 */
export function getContextAtCoordsById(blockId, coords) {
  const h = handles.get(blockId);
  if (!h || typeof h.getContextAtCoords !== 'function') return null;
  try {
    return h.getContextAtCoords(coords) ?? null;
  } catch {
    /* mid-teardown view — never block the native menu */
    return null;
  }
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

/**
 * Cancel a PM handle's pending debounced onUpdate WITHOUT firing it. Used
 * by callers (1f.9 inline TC accept/reject) that own their own downstream
 * setBlocks and must prevent a late-firing debounce from re-issuing
 * setBlocks with pre-toolbar html, which would clobber the just-applied TC
 * snapshot. No-op for legacy handles or unknown ids.
 */
export function cancelPendingUpdateById(blockId) {
  const h = handles.get(blockId);
  if (h && typeof h.cancelPendingUpdate === 'function') {
    try { h.cancelPendingUpdate(); } catch { /* defensive */ }
  }
}

/**
 * Synchronously flush every registered PM block's pending debounced
 * onUpdate. Used by document-wide gestures (Accept All / Reject All, future
 * bulk operations) that read App's blocksRef.current and need it to reflect
 * the current PM substrate rather than the pre-debounce snapshot.
 *
 * #109 M4 regression: handleAcceptAll/handleRejectAll without this flush
 * see stale block html for any block whose user just typed into PM within
 * the 400ms onUpdate debounce window. The TC marks (revisionAdd / revisionDel)
 * live in the substrate but not yet in React state, so acceptAllRevisions
 * cannot strip the <ins>/<del> serialization — and once TC is disabled by
 * the same handler, those marks survive with no UI to clear them.
 *
 * Safe to call when no handles are registered or no debounces are pending.
 */
export function flushAllPendingUpdates() {
  for (const [, h] of handles) {
    if (h && typeof h.flushPendingUpdate === 'function') {
      try { h.flushPendingUpdate(); } catch { /* defensive */ }
    }
  }
}

/** Test-only — full reset between Vitest cases. */
export function __resetBlockRegistry() {
  handles.clear();
}
