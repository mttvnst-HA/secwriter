import { useState, useRef, useCallback } from "react";
import * as tc from "./track-changes.js";

const MAX_HISTORY = 100;

/**
 * Custom hook that wraps blocks + opaque track-changes state with undo/redo
 * history.
 *
 * Debounce: the first setBlocks call after unpause captures a snapshot,
 * then auto-pauses. Structural actions call resumeHistory() before their
 * setBlocks, which unpauses and ensures a new undo entry is created.
 *
 * The hook is agnostic about the shape of `tcState` — it stores whatever
 * the track-changes module hands it and restores it on undo/redo.
 *
 * @param {Array} initialBlocks
 * @returns {Object}
 */
export function useUndoableBlocks(initialBlocks) {
  const [blocks, _setBlocks] = useState(initialBlocks);
  const [tcState, _setTcState] = useState(() => tc.createInitial());

  const historyRef = useRef({ past: [], future: [] });
  const pausedRef = useRef(false);
  const undoingRef = useRef(false); // true during undo/redo to suppress blur-triggered setBlocks
  const currentRef = useRef({ blocks: initialBlocks, tcState: tc.createInitial() });

  // Keep currentRef in sync
  currentRef.current.blocks = blocks;
  currentRef.current.tcState = tcState;

  const setBlocks = useCallback((updater) => {
    // During undo/redo, blur-triggered setBlocks calls must be suppressed
    // to prevent them from racing with the undo/redo _setBlocks call.
    if (undoingRef.current) return;

    _setBlocks(prev => {
      const next = typeof updater === 'function' ? updater(prev) : updater;

      if (!pausedRef.current) {
        // Capture (blocks, tcState) snapshot atomically before mutation.
        const snapshot = {
          blocks: prev,
          tcState: currentRef.current.tcState,
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

  const setTcState = useCallback((updater) => {
    _setTcState(prev => (typeof updater === 'function' ? updater(prev) : updater));
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
      tcState: currentRef.current.tcState,
    });

    _setBlocks(snapshot.blocks);
    _setTcState(snapshot.tcState);
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
      tcState: currentRef.current.tcState,
    });

    _setBlocks(snapshot.blocks);
    _setTcState(snapshot.tcState);
    pausedRef.current = false;
    undoingRef.current = false;
  }, []);

  const canUndo = historyRef.current.past.length > 0;
  const canRedo = historyRef.current.future.length > 0;

  return {
    blocks,
    tcState,
    setBlocks,
    setBlocksDirect,
    setTcState,
    undo,
    redo,
    canUndo,
    canRedo,
    clearHistory,
    resumeHistory,
  };
}
