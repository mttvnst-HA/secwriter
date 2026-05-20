# ADR-0010: Comments architecture — opaque reducer + dual reconcile (substrate + html-walk)

**Status:** Accepted
**Date:** 2026-05-19

## Context

Comments in SecWriter need three things: (1) inline anchoring via `<span class="mark-comment">` spans inside `block.html`, (2) separate metadata (author, ts, replies, status), (3) consistency under collab — peer-driven status flips and deletions must reclassify spans without polluting the local undo stack.

Sub-PR 1g ([#69](https://github.com/mttvnst-HA/secwriter/pull/69)) brought comments under the PM substrate ([ADR-0006](0006-pm-substrate-migration.md), [ADR-0007](0007-single-pm-editor.md)). The reducer at `src/lib/comments.js` follows the same opaque-state-plus-selectors playbook as Track Changes ([ADR-0009](0009-track-changes-per-keystroke.md)), Linting ([ADR-0012](0012-inline-linting-css-highlights.md)), and Compliance ([ADR-0011](0011-compliance-rule-engine.md)).

## Decision

Comments use a pure reducer module (`src/lib/comments.js`) that owns a DOM-based highlight + separate metadata store:

1. **State is opaque.** App holds it as `commentsState` and reads it via selectors (`size`, `get`, `all`, `isDraft`, `getCreateEntry`, `reconcileBlocks`, `normalizeForLoad`); mutates it via verbs (`createDraft`, `updateCreate`, `reply`, `resolve`, `reopen`, `remove`, `mergeRemote`). Shape: `{ byId: Map<commentId, Comment>, seenRemoteIds: Set<commentId> }`. Verbs return `{ state, publish }`; caller supplies `identity` and `ts`.
2. **Span↔metadata reconciliation is a selector.** App runs `useEffect([blocks, commentsState])` → `setBlocksDirect(prev => cm.reconcileBlocks(prev, commentsState))`. The selector unwraps orphan spans (id missing from state) and reclasses open↔resolved when className disagrees with `state.byId.get(id).status`. Idempotent — returns the original `blocks` ref when nothing changes; React bails out, no loop. Post-1i-b.2 `setBlocksDirect` is an alias for `setBlocks` (the snapshot-stack distinction died with `useUndoableBlocks`); the call site stays for clarity at the comment-reconcile seam. The same effect also mirrors any html change into the substrate via `setBlockHtmlSilent(activeYStoreRef.current, b.id, b.html)` (silent origin, not tracked by either UndoManager) so peers see comment-status reclassifies without polluting the local undo stack.
3. **Single collab dispatcher.** `session.dispatchComment(envelope)` switches on `envelope.kind ∈ {create, reply, status, delete}` and forwards to the underlying `*ToDoc` functions. The legacy four session methods (`publishComment`, `publishCommentReply`, `publishCommentStatus`, `deleteComment`) are gone. Verbs that produce no publish (drafts) return `publish: null`.
4. **`mergeRemote` semantics (M2.5).** For each id in `remote ∪ prev.byId`: if id is in remote, remote wins; else if id is in `seenRemoteIds`, drop (peer deletion); else preserve (local draft). `seenRemoteIds` is monotonically non-shrinking — once an id has been observed from peers, its later absence is authoritative.
5. **Editable blocks** persist comment spans in `block.html`; `reconcileBlocks` reclasses/unwraps them on every state change. **Ref/table blocks** derive spans at render time: `RefBlock` and `TableBlock` accept `commentsState` + `activeCommentId` props, call `cm.getBlockComments(state, block.id)`, and run each text field through `cm.computeCommentSegments(text, blockComments)` to wrap matching substrings with `mark-comment` / `mark-comment-resolved`. No DOM drift possible — spans are recomputed from metadata every render. The popup's click-to-open and active-highlight flow is identical to editable blocks.
6. **Active highlight is mode-conditional.** PM-mounted editable blocks: the `activeCommentPlugin` (`src/lib/pm-plugins/active-comment.js`) holds a singleton `activeCommentId` plugin state; App calls `setActiveComment(view, commentId)` via `block-registry.getBlockView`. The plugin emits an inline `Decoration.inline(from, to, { class: 'mark-comment-active' })` over the matching `comment` mark's range. CSS rule: `.mark-comment.mark-comment-active` and `.mark-comment-resolved.mark-comment-active` (light + dark). DecorationSet is cached in plugin state per the PM guide's Decorations recommendation. Ref/table blocks have no PM EditorView; `RefBlock` / `TableBlock` render `data-active="true"` directly in JSX from the `activeCommentId` prop (see their `renderWithCommentMarks` / `renderCellContent` helpers), and CSS uses the `[data-active="true"]` attribute selector. Reconcile (item 2) owns the className transitions across `comment.status` flips.
7. **Load-boundary shim.** `normalizeForLoad(rawCommentsObj)` runs in `onRemoteComments` and the auto-save restore path. It promotes legacy `author` → `authorName` and `timestamp` (ISO) → `ts` (number); canonical fields take priority. The module never sees legacy fields.
8. **Export:** serializer strips `mark-comment` spans. A sidecar `.comments.json` is saved alongside the `.SEC` file.
9. **File import clears comments** — `loadSECContent()` calls `setCommentsState(cm.createInitial())` so comments from a prior file don't leak.
10. **Toolbar comment-create path.** PM editable blocks dispatch `applyCommentMarkTr` (`src/lib/pm-toolbar.js`) and reach the substrate via ySyncPlugin — same shape as the other five mark verbs. Ref/table blocks (no PM EditorView registered) keep the `range.surroundContents(<span class="mark-comment">)` DOM-mutation path inside the comment-button onClick; the substrate is updated through the `onCommentCreate` envelope (which carries `null` html for ref blocks since their content lives in `block.ref`, not `block.html`).

**Substrate-side reconcile (1g).** For PM-mounted blocks, a per-block `useEffect([commentsState])` in `PmEditableBlock.jsx` calls `reconcileCommentMarks(view.state, commentsState)` (`src/lib/pm-comments.js`) and dispatches the returned tr. The verb is idempotent — receiving peers (whose substrate is already updated via the originator's ySyncPlugin op) get a null tr and dispatch nothing. The tr is tagged with `COMMENT_RECONCILE_META`; `dispatchTransaction` skips the synthesized `'input'` event and the `onUpdate` debounce for reconcile-tagged trs. The latter is empirically necessary (see `src/lib/__tests__/setblockhtml-echo-behavior.test.js`) — un-gated `onUpdate` would call `setBlockHtml(..., 'local-publish')` and produce an echo Yjs op the UndoManager captures. Ref/table blocks still rely on `cm.reconcileBlocks`'s html walk via the App-level effect (its `shouldSkip` predicate skips any block that has a registered PM EditorView).

## Consequences

- **Positive:**
  - **No DOM drift.** Ref/table spans are recomputed from metadata every render; PM blocks are reconciled via the substrate-side reconcile + html-walk fallback.
  - **Peer reconciles don't pollute local undo.** `setBlockHtmlSilent` uses a distinct origin that neither UndoManager tracks.
  - **Same opaque-state playbook** as TC ([ADR-0009](0009-track-changes-per-keystroke.md)), linting ([ADR-0012](0012-inline-linting-css-highlights.md)), compliance ([ADR-0011](0011-compliance-rule-engine.md)).
  - **`Decoration.inline` for active highlight** — uses PM's idiomatic decoration API instead of mutating spans.
- **Negative / cost:**
  - **Two reconcile paths.** Substrate-side reconcile (PM blocks) + html-walk (ref/table blocks). The `shouldSkip` predicate in `cm.reconcileBlocks` is the seam; both must stay in sync if comment semantics change.
  - **`COMMENT_RECONCILE_META` is a PM-meta sentinel, NOT a Yjs origin.** Easy to conflate. The corresponding Yjs op still uses origin `ySyncPluginKey` — the meta only governs PM-side filtering, not the substrate write path.
  - **`Decoration.inline` nests a `<span>` inside the mark's own `<span>`.** Active-state CSS must use a descendant combinator, not a compound selector. Pitfall captured in CLAUDE.md.
- **Re-litigation risk:**
  - **"Why not store comments as PM marks like TC?"** Comments need metadata (author, ts, replies, status) that don't fit cleanly in mark attrs, and the metadata persists across PM doc rewrites (orphan-recovery on accept-all, etc.). The `byId` map decouples lifecycle from PM doc state.
  - **"Why a separate substrate-side reconcile when html-walk already exists?"** The html-walk runs on the React `blocks` array — it doesn't see the substrate-only state during the 400ms PM `onUpdate` debounce window. The substrate-side reconcile fires immediately so peers see status flips without lag.
  - **"Why `mergeRemote` instead of `replaceWith`?"** Local drafts (not yet published) would be wiped by replace. The `seenRemoteIds` + draft-preservation logic is load-bearing.

## Alternatives considered

- **Comments as PM schema marks (no separate `byId` store).** Rejected — metadata (replies, status, author) doesn't fit mark attrs cleanly, and PM doc rewrites (accept-all, slash-conversion) would drop the metadata.
- **Single reconcile path (html-walk only).** Rejected — the 400ms `onUpdate` debounce window in PmEditableBlock would leave peers with stale comment classes until the debounce fires.
- **CSS-only active highlight (no PM decoration).** Rejected — pseudo-class targeting on the comment's mark span requires the span to be the focused element, but PM's contentEditable doesn't expose individual mark spans as focusable. The decoration API solves this cleanly.
