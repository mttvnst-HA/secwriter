# ADR-0008: Single blocks-reducer dispatcher owns every mutation of the blocks array

**Status:** Accepted
**Date:** 2026-05-19

## Context

Pre-2026-05-19 the `blocks` React-state array was mutated from 14 named handlers in `src/App.jsx` plus 7 inline JSX `onClick`/`onChange` closures. Each handler hand-wove four coordination steps in a specific order: (1) `flushPendingUpdateById` to drain any in-flight 400ms PM `onUpdate` debounce, (2) substrate write via `setBlockHtml(yStore, id, html, 'local-publish')` (or skip, for PM-click paths where ySyncPlugin already wrote the substrate), (3) `setBlocks(prev => …)`, (4) `setFocusedBlockId` or `focusBlock` for focus restoration. Mis-ordering any pair (e.g. forgetting the flush, doing setBlocks before substrate write, or skipping the registry-mirror call) silently broke undo, peer sync, or focus.

The 1h work introduced `forceFrame()` as a fifth coordination point — every click-driven `setBlocks` had to pair with a Yjs UndoManager `forceFrame` to close the prior capture window. Adding it across 21 sites was error-prone; the related `setBlocks → applyBlocksToYDoc` structural-diff publish path (ADR-0004) makes site-by-site coordination even more brittle because structural changes ride a separate channel from html writes.

The 1g comments-reconcile path also requires a "silent" origin (`setBlockHtmlSilent`) so peer-driven reclassifies stay off the local undo stack — yet another coordination axis the per-site code had to track.

## Decision

Route every `blocks` mutation through a single dispatcher at `src/lib/blocks.js`. The reducer extends the pure-verb playbook already used by Track Changes ([ADR-0009](0009-track-changes-per-keystroke.md)), Comments ([ADR-0010](0010-comments-reducer-dual-reconcile.md)), Linting ([ADR-0012](0012-inline-linting-css-highlights.md)), and Compliance ([ADR-0011](0011-compliance-rule-engine.md)) to the blocks array itself:

1. **State is the array.** `BlocksState = Block[]`. No wrapper struct — Yjs is the coordination layer, so there's nothing to bundle alongside.
2. **Verbs are pure.** 21 verbs covering create/delete/convert/promote/demote/level-change/reorder/html-update/inline-fix/compliance-group/ref-add/ref-orphan/revision-accept-or-reject (single and all). Each returns a `VerbResult = { state, effects }` descriptor (or `null` for "block not found"). `unchanged(prev)` is the "found but no-op" return.
3. **Effects descriptor.** `effects = { framing, substrateWrites, flush, focus }`. `framing` is a tagged union: `{ kind: 'newFrame' }` (forceFrame BEFORE substrate writes), `{ kind: 'wrappedFrame', writes }` (withUndoFrame wraps N writes so they form ONE Yjs undo frame regardless of captureTimeout), or `null`. `substrateWrites` is empty when framing=wrappedFrame — the writes live inside `framing.writes`. The descriptor models **html-slot writes only**; structural changes (create/delete/reorder) ride the implicit `setBlocks → applyBlocksToYDoc` diff path. Property test P3 pins "every SubstrateWrite.blockId references a block that exists in the verb's resulting state."
4. **Dispatcher protocol.** `dispatchBlocksVerb({blocksRef, setBlocks, yStore, framing, setFocusedBlockId, focusBlock}, compute, opts)` runs: optional `preFlush` (`flushAllPendingUpdates` / `flushPendingUpdateById`) → `compute(blocksRef.current)` → `framing.forceFrame()` if newFrame → substrate writes (or `withUndoFrame` wrap for wrappedFrame) → `setBlocks(state)` AND `blocksRef.current = state` (so a synchronous loop like Replace All / Remove All Orphaned sees the latest state mid-loop instead of the pre-loop snapshot) → flush → focus (`setFocusedBlockId` synchronously, or `focusBlock` via setTimeout(0) for the imperative variant). The sync mutation of `blocksRef.current` is load-bearing — without it, sequential dispatches in the same event-loop tick all read the pre-loop blocks and clobber each other on setBlocks. The next render commit overwrites the ref with the React state value anyway.
5. **App-side thin closure.** `dispatchBlocks(compute, opts)` in `src/App.jsx` wires `framing` from `framingForHandler()` (returns `collab` or `localUndo` per `inRoomRef`) and resolves `yStore` from `activeYStoreRef.current` at call time, so a mid-session room transition doesn't strand stale references. The 14 App.jsx handlers + 7 inline JSX handlers from pre-2026-05-19 collapse into one-line dispatch calls.
6. **Substrate-write origin.** Every write in `substrateWrites` and `framing.writes` defaults to origin `'local-publish'` (Yjs UndoManager-tracked). PM-click paths emit zero substrate writes because ySyncPlugin's PM dispatch already wrote the substrate — only the framing/setBlocks pieces are needed (`updateBlockHtmlPmSync`).
7. **Registry mirror is gone.** The pre-2026-05-19 `getBlockHandle(id).setHtml(html)` calls in `handleBlockUpdateWithSync` and `handleSearchReplace` were no-ops post-1i-b.2 (PmEditableBlock's `setHtml` handle is documented as a no-op; TitleBlock never registered one). The dispatcher does not call them. If a future non-PM editor surface re-introduces imperative html push, add the mirror to the dispatcher then.
8. **TC interaction.** Verbs that branch on TC state (`createBlockAfter`, `deleteBlock`) take `tcState` as an explicit arg — the reducer stays pure, and `tc.revisionFlagForCreate`/`revisionFlagForDelete` selectors handle the "is this a tracked add?" / "should this delete remove or mark?" decisions. The `tc.acceptAll` / `tc.rejectAll` state transition still lives in App because it's a separate reducer; the blocks-side mutation (strip marks, drop deleted blocks) lives in `acceptAllRevisionsVerb` / `rejectAllRevisionsVerb` with `preFlush: 'all'` to drain PM debounces first ([#109](https://github.com/mttvnst-HA/secwriter/pull/109) M4).

## Consequences

- **Positive:**
  - **One coordination point.** Adding a new mutation kind = author a verb + one-line dispatch. No risk of forgetting the flush / forceFrame / substrate-write pair.
  - **Property-testable.** Verbs are pure; effects are data descriptors. The dispatcher protocol can be exercised under a Vitest harness without rendering React or mounting yjs.
  - **Mode-aware framing.** The `collab` vs `localUndo` UndoManager pair is selected once in App and threaded through; the reducer doesn't know which mode it's in.
  - **`blocksRef.current` sync mutation** unlocks synchronous loop dispatches (Replace All, Remove All Orphaned) without per-site `await new Promise(setTimeout)` workarounds.
- **Negative / cost:**
  - **Descriptor verbosity.** The `effects` tagged union is more LOC than an imperative handler at the call site, but the cost is paid once in the verb instead of per-call-site.
  - **`'local-publish'` origin default** is right for nearly all verbs but wrong for comment-reconcile (which needs `'local-publish-silent'`). The reconcile path is handled by a dedicated `setBlockHtmlSilent` call from `useEffect([commentsState])` in App, not via a verb — see [ADR-0010](0010-comments-reducer-dual-reconcile.md).
  - **Structural changes** (create/delete/reorder) don't appear in `substrateWrites` because they ride the implicit `setBlocks → applyBlocksToYDoc` diff path. A reader looking at the descriptor to understand "what hit yjs" for those verbs has to know the publish path also fires.
- **Re-litigation risk:**
  - **"Why not just useReducer?"** React's `useReducer` doesn't compose with the async coordination steps (flush, forceFrame, substrate write). The dispatcher is intentionally not a React hook.
  - **"Why the synchronous `blocksRef.current` write?"** Without it, a sequential dispatch loop reads the pre-loop snapshot from `blocksRef.current` (React state hasn't committed yet) and clobbers itself. The next render commit overwrites the ref with the React state value, so the manual sync mutation is harmless after the loop ends.
  - **"Why not put `forceFrame` in the verb?"** Verbs are pure. The UndoManager pair lives in App because it's selected by `inRoomRef`. The dispatcher is the natural seam.

## Alternatives considered

- **useReducer + middleware (Redux-style).** Rejected — the four coordination steps are not pure-function-able and would push back into the call site through middleware escape hatches.
- **Per-verb dispatch closures (no central dispatcher).** Rejected — recreates the per-site coordination drift the refactor is solving.
- **Move framing into the verb.** Rejected — would couple `src/lib/blocks.js` to the UndoManager pair selection, which is mode-dependent.
