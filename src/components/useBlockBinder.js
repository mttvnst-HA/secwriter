/**
 * useBlockBinder — Y.Doc ↔ React binding for a single block's html.
 *
 * Sub-PR 1b (#22). EditableBlock uses this hook to read the current html
 * (initial render + remote-driven updates) and to write its own edits back
 * to the substrate. Replaces the snapshot-diff publish path for html: the
 * caller writes per-keystroke (still debounced inside EditableBlock for
 * Range stability with FloatingToolbar) and the substrate's setBlockHtml
 * synthesizes the matching Yjs delta.
 *
 * Read pathway: useSyncExternalStore over subscribeBlock + getBlockHtml.
 *   - subscribeBlock observes both the Y.Text and the parent yStore key,
 *     so a remote-driven Y.Map identity change for an existing block id
 *     (delete+re-add) re-binds without losing notifications.
 *   - getBlockHtml is memoized via the substrate's per-Y.Text cache, so
 *     useSyncExternalStore's snapshot equality check (Object.is) bails the
 *     re-render when nothing changed.
 *
 * Write pathway: write(html) → setBlockHtml in a 'local-publish' transaction.
 *   No-op if yStore is null (out-of-room mode hasn't allocated its local
 *   substrate yet, or in-room session has been destroyed).
 *
 * Inputs: { yStore, blockId } — both may legitimately be null/undefined
 * during transitions; the hook returns html='' and a no-op write so callers
 * don't need null-guards.
 */

import { useCallback, useSyncExternalStore } from 'react';

import {
  getBlockHtml,
  setBlockHtml,
  subscribeBlock,
} from '../lib/block-html-store.js';

const NOOP = () => {};

export function useBlockBinder({ yStore, blockId }) {
  const subscribe = useCallback(
    (notify) => (yStore && blockId ? subscribeBlock(yStore, blockId, notify) : NOOP),
    [yStore, blockId],
  );
  const getSnapshot = useCallback(
    () => (yStore && blockId ? getBlockHtml(yStore, blockId) : ''),
    [yStore, blockId],
  );
  const html = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  const write = useCallback(
    (next) => {
      if (!yStore || !blockId) return;
      setBlockHtml(yStore, blockId, next);
    },
    [yStore, blockId],
  );

  return { html, write };
}
