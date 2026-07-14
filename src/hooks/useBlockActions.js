// The block-action surface. Deepens App by absorbing the ~20 pure
// `dispatchBlocks(b => Blocks.verb(...))` wrappers plus the inline JSX arrows
// into one hook that owns dispatchBlocksVerb wiring.
//
// yStore and framing are read from REFS at action-call time (not captured at
// render) so a mid-session room / collab-mode swap can't strand a stale
// reference — same discipline App's old `dispatchBlocks` used for
// `activeYStoreRef.current` / `framingForHandler()`. Reading via refs also
// lets App instantiate this hook EARLY (before every handler that references
// `blockActions`) without a temporal-dead-zone on `framingForHandler`.
//
// Cross-reducer coordination (linting / tc / comments / compliance setState)
// deliberately stays in App's mixed handlers — this hook is block-verbs only.
// See CLAUDE.md "Blocks Reducer Architecture".

import { useMemo, useRef } from 'react';
import * as Blocks from '../lib/blocks.js';

export function useBlockActions(deps) {
  // Keep a ref to the latest deps bag so the returned action object can have
  // a permanently stable identity (computed once via useMemo(..., [])) while
  // every action still reads blocksRef/setBlocks/yStoreRef/framingRef/
  // setFocusedBlockId/focusBlock/tcStateRef fresh at CALL time. This mirrors
  // the "read from refs, not render-captured values" discipline one level up:
  // even the deps bag itself is read through a ref, so a caller that passes
  // new ref/callback instances across renders (e.g. before its own refs are
  // memoized) can't strand this hook's action object on stale closures.
  const depsRef = useRef(deps);
  depsRef.current = deps;

  return useMemo(() => {
    const dispatch = (compute, opts) => {
      const { blocksRef, setBlocks, yStoreRef, framingRef, setFocusedBlockId, focusBlock } = depsRef.current;
      return Blocks.dispatchBlocksVerb(
        {
          blocksRef,
          setBlocks,
          yStore: yStoreRef.current,
          framing: framingRef.current,
          setFocusedBlockId,
          focusBlock,
        },
        compute,
        opts,
      );
    };
    const tcState = () => depsRef.current.tcStateRef.current;

    return {
      reorderSection: (dragId, dropId, position) =>
        dispatch((b) => Blocks.reorderSectionVerb(b, dragId, dropId, position)),
      searchReplace: (blockId, offset, length, replacement) =>
        dispatch((b) => Blocks.searchReplaceAt(b, blockId, offset, length, replacement)),
      removeOrphaned: (blockId, rid) =>
        dispatch((b) => Blocks.removeOrphanedRid(b, blockId, rid)),
      addReference: ({ org, rid, rtl }) =>
        dispatch((b) => Blocks.addReference(b, { org, rid, rtl, newId: `ref-${Date.now()}` })),
      insertAfter: (afterId) =>
        dispatch((b) => Blocks.createBlockAfter(b, afterId, { newId: `new-${Date.now()}`, tcState: tcState() })),
      changeOliLevel: (blockId, delta) =>
        dispatch((b) => Blocks.changeOliLevel(b, blockId, delta)),
      convertToTitle: (blockId) =>
        dispatch((b) => Blocks.convertToTitle(b, blockId)),
      convertBlock: (blockId, newType, newId) =>
        dispatch((b) => Blocks.convertBlock(b, blockId, newType, { newId: newId ?? `new-${Date.now()}` })),
      convertBlockType: (blockId, newType) =>
        dispatch((b) => Blocks.convertBlockType(b, blockId, newType, { tcState: tcState() })),
      promote: (blockId) =>
        dispatch((b) => Blocks.promoteTitle(b, blockId)),
      demote: (blockId) =>
        dispatch((b) => Blocks.demoteTitle(b, blockId)),
      deleteBlock: (blockId) =>
        dispatch((b) => Blocks.deleteBlock(b, blockId, tcState())),
      updateHtml: (id, html) =>
        dispatch((b) => Blocks.updateBlockHtml(b, id, html)),
      updateHtmlPmSync: (id, html) =>
        dispatch((b) => Blocks.updateBlockHtmlPmSync(b, id, html)),
      mergeBlockData: (id, data) =>
        dispatch((b) => Blocks.mergeBlockData(b, id, data)),
      updateRefScalar: (id, data) =>
        dispatch((b) => Blocks.updateRefScalar(b, id, data)),
      acceptRevision: (id) =>
        dispatch((b) => Blocks.acceptBlockRevision(b, id)),
      rejectRevision: (id) =>
        dispatch((b) => Blocks.rejectBlockRevision(b, id)),
      acceptAllRevisions: () =>
        dispatch(Blocks.acceptAllRevisionsVerb, { preFlush: 'all' }),
      rejectAllRevisions: () =>
        dispatch(Blocks.rejectAllRevisionsVerb, { preFlush: 'all' }),
      applyInlineFix: (blockId, fixedText) =>
        dispatch((b) => Blocks.applyInlineFix(b, blockId, fixedText)),
      // The CompliancePanel callsite invokes this with a 2nd `label` arg; the
      // verb ignores it, so it's dropped here at the dispatch boundary.
      complianceAcceptGroup: (fixesByBlock) =>
        dispatch((b) => Blocks.complianceAcceptGroup(b, fixesByBlock)),
    };
    // Empty deps: the action object's identity must never change across
    // renders (App wires it into memoized child props / keymaps). Every
    // action closure reads depsRef.current at call time instead of closing
    // over blocksRef/setBlocks/yStoreRef/framingRef/setFocusedBlockId/
    // focusBlock/tcStateRef from this render — so a caller-side identity
    // change (a re-memoized focusBlock, a swapped yStoreRef, etc.) is picked
    // up on the next call without ever invalidating this memo.
  }, []);
}
