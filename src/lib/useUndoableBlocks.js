import { useState, useRef, useCallback } from "react";

const MAX_HISTORY = 100;

/**
 * Custom hook that wraps blocks with undo/redo history.
 *
 * Debounce: the first setBlocks call after unpause captures a snapshot,
 * then auto-pauses. Structural actions call resumeHistory() before their
 * setBlocks, which unpauses and ensures a new undo entry is created.
 *
 * Snapshots are `{ blocks }` only. tcState used to ride here for atomic
 * (blocks, tcState) capture, but post-1h Q35+Q37 the TC reducer state is
 * `{ enabled, publishSeq }` — the lockstep bought nothing once per-block
 * snapshots left tcState, so 1i-b.1 moved tcState to a plain useState in
 * App. Accepted regression: Ctrl+Z across a TC enable/disable boundary
 * no longer undoes the toggle.
 *
 * @param {Array} initialBlocks
 * @param {Object} [options]
 * @param {(blockId: string) => string|null} [options.getPmDirtyHtml]
 *   PM-mode dirty-html resolver. PM EditorViews carry `data-pm-editor="true"`
 *   on the contentEditable element; for those, `activeEl.innerHTML` includes
 *   widget decorations (tag-labels, etc.) that must NOT enter the redo
 *   frame. The caller supplies a substrate-aware reader (typically
 *   `getBlockHtml(activeYStoreRef.current, id)`); the hook calls it lazily
 *   so it can capture the latest substrate state at undo-time even though
 *   the substrate ref is declared after this hook runs.
 * @returns {Object}
 */
export function useUndoableBlocks(initialBlocks, options) {
  const [blocks, _setBlocks] = useState(initialBlocks);

  const historyRef = useRef({ past: [], future: [] });
  const pausedRef = useRef(false);
  const undoingRef = useRef(false); // true during undo/redo to suppress blur-triggered setBlocks
  const currentRef = useRef({ blocks: initialBlocks });
  // Mirror options into a ref so the latest closure (which may reference
  // refs declared after the hook call) is read at undo-time.
  const optionsRef = useRef(options || null);
  optionsRef.current = options || null;

  // Keep currentRef in sync
  currentRef.current.blocks = blocks;

  const setBlocks = useCallback((updater) => {
    // During undo/redo, blur-triggered setBlocks calls must be suppressed
    // to prevent them from racing with the undo/redo _setBlocks call.
    if (undoingRef.current) return;

    _setBlocks(prev => {
      const next = typeof updater === 'function' ? updater(prev) : updater;

      if (!pausedRef.current) {
        // Capture blocks snapshot before mutation.
        const snapshot = {
          blocks: prev,
        };
        const h = historyRef.current;
        h.past.push(snapshot);
        if (h.past.length > MAX_HISTORY) h.past.shift();
        h.future = [];
        // Auto-pause after first capture (typing debounce)
        pausedRef.current = true;
      }

      return next;
    });
  }, []);

  // Bypass undo history. Use for mechanical / non-user-driven block updates
  // — comments reconcile (orphan unwrap, status reclass), remote-collab block
  // sync, etc. Otherwise these would push onto past + clear future, which
  // wipes the redo stack the moment a reconcile fires after Ctrl+Z.
  const setBlocksDirect = useCallback((updater) => {
    if (undoingRef.current) return;
    _setBlocks(prev => (typeof updater === 'function' ? updater(prev) : updater));
  }, []);

  const resumeHistory = useCallback(() => {
    pausedRef.current = false;
  }, []);

  const clearHistory = useCallback(() => {
    historyRef.current = { past: [], future: [] };
    pausedRef.current = false;
  }, []);

  const undo = useCallback(() => {
    const h = historyRef.current;
    if (h.past.length === 0) return;

    // Suppress blur-triggered setBlocks during undo
    undoingRef.current = true;

    // Capture the active block's current DOM content before blurring.
    // Typing that hasn't been synced to React state must be captured here
    // so redo can restore it accurately.
    //
    // Legacy contentEditable: read activeEl.innerHTML — captures the last
    // 0-400ms of typed chars that the binder debounce hasn't flushed yet.
    //
    // PM EditorView (data-pm-editor="true"): activeEl.innerHTML contains
    // widget decorations (tag-labels) and PM-internal markup that must NOT
    // enter the redo frame. ySyncPlugin writes to the substrate
    // synchronously per keystroke, so reading from the substrate captures
    // the same in-flight chars without the widget contamination. The
    // optional `getPmDirtyHtml` resolver supplied by the caller (App)
    // bridges this hook to the Y.Doc substrate without coupling here.
    const activeEl = document.activeElement;
    let dirtyBlockId = null;
    let dirtyHtml = null;
    if (activeEl?.dataset?.blockId && activeEl.contentEditable === 'true') {
      dirtyBlockId = activeEl.dataset.blockId;
      const isPm = typeof activeEl.closest === 'function'
        && activeEl.closest('[data-pm-editor="true"]') !== null;
      if (isPm) {
        const getPmDirtyHtml = optionsRef.current?.getPmDirtyHtml;
        if (typeof getPmDirtyHtml === 'function') {
          try {
            const fromSubstrate = getPmDirtyHtml(dirtyBlockId);
            dirtyHtml = typeof fromSubstrate === 'string' ? fromSubstrate : null;
          } catch { dirtyHtml = null; }
        }
      } else {
        dirtyHtml = activeEl.innerHTML;
      }
    }

    // Blur to dismiss focus-dependent UI (floating toolbar, etc.)
    if (activeEl && activeEl.blur) {
      activeEl.blur();
    }

    // Build the "current" snapshot for redo, patching in the dirty block's HTML
    let currentBlocks = currentRef.current.blocks;
    if (dirtyBlockId && dirtyHtml) {
      currentBlocks = currentBlocks.map(b =>
        b.id === dirtyBlockId ? { ...b, html: dirtyHtml } : b
      );
    }

    const snapshot = h.past.pop();
    h.future.push({
      blocks: currentBlocks,
    });

    _setBlocks(snapshot.blocks);
    pausedRef.current = false;
    undoingRef.current = false;
  }, []);

  const redo = useCallback(() => {
    const h = historyRef.current;
    if (h.future.length === 0) return;

    undoingRef.current = true;
    if (document.activeElement && document.activeElement.blur) {
      document.activeElement.blur();
    }

    const snapshot = h.future.pop();
    h.past.push({
      blocks: currentRef.current.blocks,
    });

    _setBlocks(snapshot.blocks);
    pausedRef.current = false;
    undoingRef.current = false;
  }, []);

  const canUndo = historyRef.current.past.length > 0;
  const canRedo = historyRef.current.future.length > 0;

  return {
    blocks,
    setBlocks,
    setBlocksDirect,
    undo,
    redo,
    canUndo,
    canRedo,
    clearHistory,
    resumeHistory,
  };
}
