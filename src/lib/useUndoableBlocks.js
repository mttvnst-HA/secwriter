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
  const currentRef = useRef({ blocks: initialBlocks, tcSnapshots: new Map() });

  // Keep currentRef in sync
  currentRef.current.blocks = blocks;
  currentRef.current.tcSnapshots = tcSnapshots;

  const setBlocks = useCallback((updater) => {
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

    // Blur active element to force DOM sync
    if (document.activeElement && document.activeElement.blur) {
      document.activeElement.blur();
    }

    const snapshot = h.past.pop();
    h.future.push({
      blocks: currentRef.current.blocks,
      tcSnapshots: new Map(currentRef.current.tcSnapshots),
    });

    _setBlocks(snapshot.blocks);
    _setTcSnapshots(new Map(snapshot.tcSnapshots));
    pausedRef.current = false;
  }, []);

  const redo = useCallback(() => {
    const h = historyRef.current;
    if (h.future.length === 0) return;

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
