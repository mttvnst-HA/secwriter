import { useState, useRef, useCallback } from "react";

const MAX_HISTORY = 100;

/**
 * Custom hook that wraps blocks + tcSnapshots state with undo/redo history.
 *
 * Debounce: the first setBlocks call after unpause captures a snapshot,
 * then auto-pauses. Structural actions call resumeHistory() before their
 * setBlocks, which unpauses and ensures a new undo entry is created.
 *
 * @param {Array} initialBlocks
 * @returns {Object}
 */
export function useUndoableBlocks(initialBlocks) {
  const [blocks, _setBlocks] = useState(initialBlocks);
  const [tcSnapshots, _setTcSnapshots] = useState(new Map());

  const historyRef = useRef({ past: [], future: [] });
  const pausedRef = useRef(false);
  const undoingRef = useRef(false); // true during undo/redo to suppress blur-triggered setBlocks
  const currentRef = useRef({ blocks: initialBlocks, tcSnapshots: new Map() });

  // Keep currentRef in sync
  currentRef.current.blocks = blocks;
  currentRef.current.tcSnapshots = tcSnapshots;

  const setBlocks = useCallback((updater) => {
    // During undo/redo, blur-triggered setBlocks calls must be suppressed
    // to prevent them from racing with the undo/redo _setBlocks call.
    if (undoingRef.current) return;

    _setBlocks(prev => {
      const next = typeof updater === 'function' ? updater(prev) : updater;

      if (!pausedRef.current) {
        // Capture snapshot before mutation
        const snapshot = {
          blocks: prev,
          tcSnapshots: new Map(currentRef.current.tcSnapshots),
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

  const setTcSnapshots = useCallback((updater) => {
    _setTcSnapshots(prev => {
      const next = typeof updater === 'function' ? updater(prev) : updater;
      return next;
    });
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
    const activeEl = document.activeElement;
    let dirtyBlockId = null;
    let dirtyHtml = null;
    if (activeEl?.dataset?.blockId && activeEl.contentEditable === 'true') {
      dirtyBlockId = activeEl.dataset.blockId;
      dirtyHtml = activeEl.innerHTML;
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
      tcSnapshots: new Map(currentRef.current.tcSnapshots),
    });

    _setBlocks(snapshot.blocks);
    _setTcSnapshots(new Map(snapshot.tcSnapshots));
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
      tcSnapshots: new Map(currentRef.current.tcSnapshots),
    });

    _setBlocks(snapshot.blocks);
    _setTcSnapshots(new Map(snapshot.tcSnapshots));
    pausedRef.current = false;
    undoingRef.current = false;
  }, []);

  const canUndo = historyRef.current.past.length > 0;
  const canRedo = historyRef.current.future.length > 0;

  return {
    blocks,
    tcSnapshots,
    setBlocks,
    setTcSnapshots,
    undo,
    redo,
    canUndo,
    canRedo,
    clearHistory,
    resumeHistory,
  };
}
