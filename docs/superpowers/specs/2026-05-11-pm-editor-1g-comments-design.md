# PM Editor 1g — Comments via PM Schema Mark + Decoration (Design)

**Parent:** issue [#47](https://github.com/mttvnst-HA/secwriter/issues/47). Predecessor sub-PR: 1f.9 ([#66](https://github.com/mttvnst-HA/secwriter/pull/66), FloatingToolbar PM-transaction conversion). Issue #64 resolution merged in [#67](https://github.com/mttvnst-HA/secwriter/pull/67).

## Goal

Move editable-block comments from the DOM-span-plus-metadata pattern (`<span class="mark-comment" data-comment-id>` + imperative `setAttribute('data-active', 'true')` via `document.querySelector`) to a PM-native pattern: the existing `comment` schema mark for storage, a new `activeCommentPlugin` for active-highlight decoration, and a substrate-side reconcile path that dispatches PM transactions under a new `COMMENT_RECONCILE_META` sentinel.

The `comment` mark + `applyCommentMarkTr` building blocks landed in PR #67. 1g completes the migration.

## Acceptance criteria

1. Active-highlight UI: clicking a comment span in a PM-mounted block applies a visible highlight (`mark-comment-active` class via PM decoration), distinct from the resting `mark-comment` color. Closing the popup removes the highlight. Behavior matches legacy `data-active` visually.
2. Orphan unwrap: deleting a comment locally removes the `comment` mark from the substrate of the host block. A peer client sees the mark disappear via ySyncPlugin.
3. Status reclass: resolving (or reopening) a comment flips the `comment` mark's `resolved` attr in the substrate. The rendered span class transitions between `mark-comment` and `mark-comment-resolved`.
4. Reconcile transactions do NOT enter the Yjs UndoManager. Ctrl+Z in the host block undoes user typing, not reconcile-driven mark changes.
5. Reconcile transactions do NOT trigger inline linting re-run for the host block (mark-attr changes don't affect text).
6. Legacy mode (`VITE_PM_EDITOR=false`) continues to use `cm.reconcileBlocks` html-walk and CommentPopup's imperative `setAttribute('data-active')`. Zero behavioral change.
7. Ref/table blocks unchanged (no PM EditorView registered; they continue to derive comment segments at render time via `cm.computeCommentSegments` and use React-rendered `data-active` attribute).
8. No regression in `npm test`, `npm run test:server`, `npm run test:compliance`, `npm run test:e2e` under both `chromium-legacy` and `chromium` (PM) projects.

## Out of scope

1. TC per-keystroke (sub-PR 1h).
2. Flag removal / legacy code-path deletion (sub-PR 1i).
3. Any change to `applyCommentMarkTr` or the FloatingToolbar PM-branch comment-create path (delivered by #67).
4. Multi-highlight (hover-from-sidebar / multi-select-from-CompliancePanel). Singleton `activeCommentId` only — see the brainstorming decision in this doc's "Rejected alternatives" section.

---

## Architecture

### Component map

**New files:**

| File | Purpose |
|---|---|
| `src/lib/pm-plugins/active-comment.js` | PM plugin holding singleton `activeCommentId` state. Exports `activeCommentPlugin()` and `setActiveComment(view, commentId \| null)`. Renders inline decoration applying `class: 'mark-comment-active'` to the matching `comment` mark's range. DecorationSet cached in plugin state; invalidates on `tr.docChanged \|\| activeCommentId changed`. Mirrors the `tag-labels.js` precedent. |
| `src/lib/pm-comments.js` | Pure verb `reconcileCommentMarks(state, commentsState) → Transaction \| null`. Walks `state.doc`, finds disagreements (orphan ids + resolved-attr mismatches), returns a tr that removes by mark-INSTANCE and re-adds with corrected attrs. Tagged via `tr.setMeta(COMMENT_RECONCILE_META, true)`. Returns null when the doc already agrees with state — receiving peers no-op. Also exports `COMMENT_RECONCILE_META = {}` sentinel. |
| `src/lib/__tests__/pm-comments.test.js` | Property tests: idempotence (verb on already-reconciled doc returns null), orphan unwrap preserves adjacent text, status-flip preserves neighboring marks, mark-instance removal preserves adjacent comment ids. |
| `src/lib/pm-plugins/__tests__/active-comment.test.js` | Plugin state transitions (setActiveComment dispatches meta tr), decoration cache invalidation on docChanged, decoration cache short-circuit on same-id meta dispatch. |
| `src/components/__tests__/PmEditableBlock-comment-reconcile.test.jsx` | Per-block reconcile effect: fires when `commentsStateProp` changes, dispatches `reconcileCommentMarks` result, gates the synthesized `'input'` event and `onUpdate` debounce. |

**Already in place (no change for 1g):**

| File | What's there |
|---|---|
| `src/lib/pm-schema.js` (lines 127-139) | `comment` mark with `{id, resolved}` attrs. |
| `src/lib/pm-toolbar.js` | `applyCommentMarkTr` (PR #67). |
| `src/components/FloatingToolbar.jsx` | PM-branch for comment button (PR #67). |
| `src/components/PmEditableBlock.jsx` (lines 277-287) | `handleClick` routes `.mark-comment` clicks to `onCommentClick(id, rect)`. |
| `src/lib/__tests__/pmdoc-html.test.js` (`prosemirrorToYXmlFragment integration` describe) | Pins the contract that `prosemirrorToYXmlFragment` preserves the `comment` mark across diff-and-merge (post-#64 resolution). |
| `src/lib/__tests__/setblockhtml-echo-behavior.test.js` | Pins the empirical justification for gating `onUpdate` on `COMMENT_RECONCILE_META` (see "The onUpdate gating decision" section below). |

**Modified files:**

| File | Change |
|---|---|
| `src/lib/comments.js` | `reconcileBlocks` signature gains `{ shouldSkip = () => false } = {}` param. Inside the `.map`, `if (shouldSkip(b.id)) return b;` short-circuits PM-mounted blocks. |
| `src/components/PmEditableBlock.jsx` | (a) Adds `activeCommentPlugin()` to plugin list. (b) `dispatchTransaction` reads `const isReconcile = tr.getMeta(COMMENT_RECONCILE_META) === true` and skips BOTH the synthesized `'input'` event (linter) AND the `onUpdate` debounce. (c) New per-block `useEffect([commentsStateProp])` calls `reconcileCommentMarks(view.state, commentsStateRef.current)` and dispatches if non-null. (d) New `commentsState` prop. |
| `src/App.jsx` | (a) Passes `commentsState` prop to `PmEditableBlock`. (b) Updates the reconcile effect at App.jsx:754-767 to pass `{ shouldSkip: id => pmMountedIds.has(id) }` where `pmMountedIds` is computed inline from the current `block-registry` state. (c) New App effect on `[openCommentId, commentsState.byId.get(openCommentId)?.blockId]` wires `setActiveComment` against the right view via `getBlockView`, tracking the previously-highlighted view in `prevViewRef` to clear it cleanly when the active comment moves between blocks. |
| `src/components/CommentPopup.jsx` | The `useEffect` at lines 78-83 becomes mode-conditional: `if (getBlockView(comment.blockId) != null) return undefined;` then the existing `setAttribute` path runs only for blocks with no PM view (legacy editable + ref/table). |
| `src/styles/editor.css` | KEEP `.mark-comment[data-active="true"]` rules (ref/table still uses the attribute via React-rendered output, legacy editable blocks still use the popup's `setAttribute`). ADD `.mark-comment.mark-comment-active` and `.mark-comment-resolved.mark-comment-active` rules with identical visual treatment. Dual selectors cost nothing. |
| `CLAUDE.md` | Comments Architecture item 6 — describe the mode-conditional pattern (legacy/ref/table → `data-active` attribute; PM → decoration class). Add `COMMENT_RECONCILE_META` to the "Nine non-obvious invariants" section near the existing reserved Yjs origins; note that it is a PM-meta sentinel, NOT a Yjs origin, and that ySyncPlugin still translates the resulting Yjs op as `ySyncPluginKey`. Update the "PM plugin module set" entry under 1e with `active-comment.js`. |

### The `activeCommentPlugin`

Plugin state shape:

```js
{
  activeCommentId: string | null,
  decorations: DecorationSet,
}
```

Setter (matches `setTagsVisible` in `tag-labels.js`):

```js
export function setActiveComment(view, commentId) {
  view.dispatch(view.state.tr.setMeta(setActiveCommentKey, commentId));
}
```

Plugin reducer:

```js
state: {
  init(_, state) {
    return {
      activeCommentId: null,
      decorations: buildDecorations(state.doc, null),
    };
  },
  apply(tr, prev, _oldState, newState) {
    const metaSet = tr.getMeta(setActiveCommentKey);
    let activeCommentId = prev.activeCommentId;
    let needsRebuild = false;
    if (metaSet !== undefined) {
      if (metaSet !== prev.activeCommentId) {
        activeCommentId = metaSet;
        needsRebuild = true;
      }
    }
    if (tr.docChanged) needsRebuild = true;
    if (!needsRebuild) return prev;
    return {
      activeCommentId,
      decorations: buildDecorations(newState.doc, activeCommentId),
    };
  },
},
props: {
  decorations(state) {
    return this.getState(state).decorations;
  },
},
```

`buildDecorations(doc, activeCommentId)`:

- Returns `DecorationSet.empty` when `activeCommentId === null`.
- Otherwise walks `doc.descendants`; for each text node carrying a `comment` mark with matching id, emits `Decoration.inline(pos, pos + node.nodeSize, { class: 'mark-comment-active' })`.
- DecorationSet is built once and stored in plugin state; the reducer rebuilds only on `tr.docChanged || activeCommentId changed`. The PM guide ([prosemirror.net/docs/guide/](https://prosemirror.net/docs/guide/), Decorations section) explicitly recommends this pattern: *"When you have a lot of decorations, recreating the set on the fly for every redraw is likely to be too expensive. In such cases, the recommended way to maintain your decorations is to put the set in your plugin's state, map it forward through changes, and only change it when you need to."*

Same-id meta short-circuit (`if (metaSet === prev.activeCommentId) ... no rebuild`) means App's wiring effect can safely re-dispatch `setActiveComment(view, sameId)` without thrashing the DecorationSet. **Empirical contract:** a meta-only PM transaction (`tr.setMeta(key, value)` with `tr.docChanged === false`) produces zero Yjs ops via ySyncPlugin — verified by `src/lib/__tests__/setblockhtml-echo-behavior.test.js`'s "meta-only PM transaction" case. So popup-open/close dispatches do not echo to the substrate.

### The `reconcileCommentMarks` verb

Pure function:

```js
export const COMMENT_RECONCILE_META = {};

export function reconcileCommentMarks(state, commentsState) {
  const commentMarkType = state.schema.marks.comment;
  if (!commentMarkType) return null;
  const byId = commentsState.byId;
  let tr = state.tr;
  let dirty = false;

  // Walk text nodes from end → start so position arithmetic survives splice ops.
  const ranges = [];
  state.doc.descendants((node, pos) => {
    if (!node.isText) return true;
    for (const m of node.marks) {
      if (m.type !== commentMarkType) continue;
      ranges.push({ from: pos, to: pos + node.nodeSize, mark: m });
    }
    return true;
  });

  for (let i = ranges.length - 1; i >= 0; i--) {
    const { from, to, mark } = ranges[i];
    const comment = byId.get(mark.attrs.id);
    if (!comment) {
      // Orphan: remove the mark instance (not by type — preserves adjacent comment ids).
      tr = tr.removeMark(from, to, mark);
      dirty = true;
      continue;
    }
    const wantResolved = comment.status === 'resolved';
    if (mark.attrs.resolved !== wantResolved) {
      tr = tr
        .removeMark(from, to, mark)
        .addMark(from, to, commentMarkType.create({ id: mark.attrs.id, resolved: wantResolved }));
      dirty = true;
    }
  }

  if (!dirty) return null;
  return tr.setMeta(COMMENT_RECONCILE_META, true);
}
```

Notes:

1. **Walks end → start** so each `removeMark`/`addMark` doesn't shift positions of unprocessed ranges. PM transactions accumulate position maps, but using reverse-order ranges sidesteps the question entirely.
2. **Mark INSTANCE in `removeMark`.** Passing the markType strips ALL comment marks in the range (including adjacent neighbors with different ids). Passing the instance honors attr equality and removes only that mark.
3. **Idempotent.** A second call against the now-reconciled doc finds no disagreements, returns null. This is what makes the verb safe to call from every PM-mounted block on every `commentsState` change — receiving peers (whose substrate is already updated via the originator's ySyncPlugin op) dispatch no work.

### The per-block reconcile effect in `PmEditableBlock`

```js
const commentsStateRef = useRef(commentsState);
commentsStateRef.current = commentsState;

useEffect(() => {
  const view = viewRef.current;
  if (!view) return;
  const tr = reconcileCommentMarks(view.state, commentsStateRef.current);
  if (tr) view.dispatch(tr);
}, [commentsState]);
```

The verb's idempotency means blocks with no comments dispatch no tr. No `hasComments` short-circuit is needed (and would be wrong — see "Rejected alternatives").

### The `dispatchTransaction` gate

```js
const isRemote = tr.getMeta(ySyncPluginKey) != null;
const isReconcile = tr.getMeta(COMMENT_RECONCILE_META) === true;

if (tr.docChanged) {
  if (!isReconcile && this.dom) {
    try { this.dom.dispatchEvent(new Event('input', { bubbles: true })); } catch {}
  }
  setHasInlineRevisions(docHasInlineRevisions(newState.doc));

  if (!isRemote && !isReconcile) {
    if (onUpdateDebounceRef.current) clearTimeout(onUpdateDebounceRef.current);
    onUpdateDebounceRef.current = setTimeout(() => { ... }, 400);
  }
}
```

Two gates added: skip synthesized `'input'` event (no linter re-run for mark-attr changes), skip `onUpdate` debounce (no echo write through `setBlockHtml` — see next section).

### The `onUpdate` gating decision

Two independent reviews of the original design disagreed on whether `onUpdate` should be gated for reconcile transactions. The contradiction was resolved empirically.

`handleBlockUpdate` calls `setBlockHtml(yStore, id, html)`. `setBlockHtml` ALWAYS wraps the write in `ydoc.transact(..., 'local-publish')` — the origin the Yjs UndoManager tracks.

The test at `src/lib/__tests__/setblockhtml-echo-behavior.test.js` mounts a real PM `EditorView` with `ySyncPlugin`, dispatches a reconcile-shaped transaction, then calls `setBlockHtml` with `pmFragmentToHtml(view.state.doc)` (un-gated `onUpdate` simulation). Observed: `setBlockHtml` produces a non-empty Yjs op with origin `'local-publish'` even when the html matches what ySyncPlugin just wrote. `prosemirrorToYXmlFragment`'s diff-and-merge is not a true no-op for byte-stable inputs.

Consequence of leaving `onUpdate` un-gated: every reconcile pass produces a `'local-publish'` echo op that the UndoManager captures. Ctrl+Z would un-reconcile, then the next render would re-reconcile, possibly looping.

**Decision: gate `onUpdate`.** `block.html` (React projection) goes slightly stale on mark-attr-only changes — but every documented consumer of `block.html` (the .SEC serializer strips `mark-comment` spans entirely, the TC snapshot uses visible-text equality not html equality, search/replace operates on text, `useUndoableBlocks` captures stale html harmlessly, linting/compliance operate on text) is insensitive to mark-class differences. The substrate stays canonical; export reads substrate via `getBlockHtml`.

### The App-side wiring

**`pmMountedIds` for `shouldSkip`:**

```js
// Memoized inline in the reconcile effect at App.jsx:754-767:
const pmMountedIds = new Set();
for (const b of blocks) {
  if (getBlockView(b.id) != null) pmMountedIds.add(b.id);
}
const next = cm.reconcileBlocks(prev, commentsState, {
  shouldSkip: id => pmMountedIds.has(id),
});
```

Not a `useMemo` — the set is recomputed on every effect run because `block-registry`'s state changes outside React's render cycle. The cost is O(blocks.length); typical < 1ms.

**`setActiveComment` wiring effect:**

```js
const prevViewRef = useRef(null);
const activeBlockId = commentsState.byId.get(openCommentId)?.blockId ?? null;

useEffect(() => {
  const nextView = activeBlockId ? getBlockView(activeBlockId) : null;

  if (prevViewRef.current && prevViewRef.current !== nextView) {
    setActiveComment(prevViewRef.current, null);
  }
  if (nextView) {
    setActiveComment(nextView, openCommentId);
  }
  prevViewRef.current = nextView;
}, [openCommentId, activeBlockId]);
```

Deps are narrow: `openCommentId` AND the resolved `activeBlockId`. `activeBlockId` is computed at render time from `commentsState` (a normal React state read, not a ref) so dep tracking is reactive without ref aliasing. Peer replies to OTHER comments don't refire the effect because they don't change the dep values. Re-dispatching `setActiveComment(view, sameId)` is safe because the plugin reducer detects the no-op and short-circuits.

### CommentPopup mode gate

```js
useEffect(() => {
  if (getBlockView(comment.blockId) != null) return undefined; // PM decoration owns it
  const el = document.querySelector(`[data-comment-id="${comment.id}"]`);
  if (!el) return undefined;
  el.setAttribute('data-active', 'true');
  return () => { el.removeAttribute('data-active'); };
}, [comment.id, comment.blockId]);
```

PM-mounted blocks: skip the imperative path; decoration owns the highlight. Legacy editable + ref/table blocks: keep `setAttribute` (legacy blocks have html-injected spans not React-rendered; ref/table blocks also React-render `data-active` from the `activeCommentId` prop, making the popup's `setAttribute` a harmless duplicate — agrees with the existing pattern in CLAUDE.md Comments Architecture item 6).

### CSS additions

```css
.mark-comment.mark-comment-active,
.mark-comment-resolved.mark-comment-active {
  /* identical visual treatment to the existing .mark-comment[data-active="true"] rule */
}
```

Add the corresponding dark-mode rule if the existing one exists.

---

## Data flow walkthroughs

### Scenario 1: User clicks a comment to open the popup

1. User clicks `.mark-comment` span. `PmEditableBlock.handleClick` (lines 277-287) calls `onCommentClick(id, rect)`.
2. App's `handleCommentClick` sets `openCommentId` state.
3. App effect on `[openCommentId, blockId]` resolves comment → block → view, calls `setActiveComment(view, openCommentId)`.
4. PM dispatches a no-op tr with `setActiveCommentKey` meta.
5. Plugin reducer updates state, builds DecorationSet, returns.
6. `props.decorations` returns the new set; PM applies inline decoration adding `class="mark-comment-active"` to the matching span.
7. CSS `.mark-comment.mark-comment-active` highlights the span.
8. `CommentPopup` mounts. Its useEffect checks `getBlockView(comment.blockId)` — non-null → no `setAttribute` (decoration owns it).

### Scenario 2: User resolves the comment

1. CommentPopup calls `onResolve(commentId)`.
2. App's `handleCommentResolve` calls `cm.resolve(commentsState, {...})` — `commentsState.byId.get(id).status` flips to `'resolved'`.
3. `setCommentsState(next)` triggers re-render.
4. `PmEditableBlock`'s per-block reconcile effect fires for blocks whose `commentsState` prop changed.
5. `reconcileCommentMarks(view.state, commentsState)` walks doc, finds the mark's `resolved !== true`, returns a tr that removes + re-adds the mark with `resolved: true`.
6. `view.dispatch(tr)` — `dispatchTransaction` reads `isReconcile = true`, skips `'input'` event and `onUpdate` debounce.
7. ySyncPlugin writes substrate with origin `ySyncPluginKey` — UndoManager skips it.
8. PM re-renders; `comment` mark's `toDOM` emits `class="mark-comment-resolved"` instead of `class="mark-comment"`.
9. `activeCommentPlugin` rebuilds DecorationSet (docChanged) — decoration now applied via `.mark-comment-resolved.mark-comment-active`.
10. Substrate change propagates to peers via Yjs sync. On the peer side: ySyncPlugin updates their substrate's mark attr, PM re-renders, peer's `commentsState` updates via `onCommentsReceived → mergeRemote`, peer's reconcile effect fires, walks doc, finds no disagreement → null tr → no dispatch (idempotency).

### Scenario 3: User deletes the comment

1. CommentPopup calls `onDelete(commentId)`.
2. App's `handleCommentDelete` calls `cm.remove(commentsState, ...)` — `commentsState.byId` no longer contains the id.
3. `setOpenCommentId(null)` — App's `setActiveComment` wiring effect fires, calls `setActiveComment(prevView, null)`.
4. Plugin reducer clears `activeCommentId`, builds empty DecorationSet.
5. Per-block reconcile effect fires.
6. Verb walks doc, finds orphan mark (id ∉ byId), returns tr that removes by mark-instance.
7. `view.dispatch(tr)` — same gates as Scenario 2.
8. ySyncPlugin writes substrate; mark gone.
9. PM re-renders; the span is no longer wrapped with `comment` mark — it's just text.
10. Peers' substrate updates; their reconcile effects no-op (already in sync).

### Scenario 4: Peer creates a comment on another tab

1. Peer's `applyCommentMarkTr` adds the `comment` mark; their substrate updates.
2. Our ySyncPlugin observes the update; PM re-renders our view with the new `<span class="mark-comment">`.
3. Our `commentsState` updates via `onCommentsReceived → mergeRemote`.
4. Our per-block reconcile effect fires.
5. Verb finds: mark exists in doc, id IS in byId, status matches resolved attr → no disagreement → null tr → no dispatch.
6. UI shows the new comment span with no flicker.

---

## Rejected alternatives

### Multi-highlight `Set<string>` instead of singleton

Considered for "future hover-from-sidebar" or "multi-select-from-CompliancePanel" flows. Rejected because (a) no such flows exist or are roadmapped; (b) those flows would likely want their OWN plugin and CSS class (`mark-comment-hover` separate from `mark-comment-active`) since the visual treatments would differ; (c) YAGNI. Singleton it is. If a multi-highlight flow lands later, a separate plugin is the right shape.

### Per-block `useEffect` driven by an `activeCommentId` prop

Considered as an alternative to App's imperative `setActiveComment` glue. Rejected because (a) only one comment is ever active at a time — every other block's effect runs no-ops on every popup open/close, fanning out the prop through 300 blocks; (b) the imperative-setter pattern is already established by `tag-labels.js`'s `setTagsVisible`; (c) tracking `prevViewRef` in App is simpler than fanning out the prop.

### PM widget decoration overlay

Considered as a more flexible alternative to inline decoration. Rejected — the existing visual is a CSS-driven background-color change. Inline decoration with a class is sufficient. Widget overlay is over-engineered.

### `hasComments` prop to short-circuit per-block reconcile effect

A previous review suggested computing `blockHasComments = new Set([...byId.values()].map(c => c.blockId))` at App level and passing `hasComments={...}` to short-circuit. Rejected because of the true→false bug: when the last comment on a block is DELETED, the prop flips true→false, the effect bails with `hasComments=false`, and the orphan mark on the substrate is never reconciled. The verb's idempotency already handles the short-circuit cheaply (doc walk on a comment-free block is O(n) but finds no marks and returns null in O(1) tr-building work).

### Abandon the `comment` schema mark; derive highlights from `commentsState` only

The most aggressive alternative proposed during review. Rejected because (a) it departs from the issue plan (Q3/Q8); (b) it makes PR #67's `applyCommentMarkTr` pointless; (c) position survives edits via PM marks — decoration-from-substring-match (the approach `cm.computeCommentSegments` uses for ref/table) is fragile in long editable text where the same substring may appear multiple times or change as the user edits; (d) the agent's premise that `prosemirrorToYXmlFragment` drops the `comment` mark on serialize was based on stale CLAUDE.md (pre-#67); empirically the mark survives.

### Use a separate Yjs origin (not just a PM meta) for reconcile

Considered as a way to definitively prevent UndoManager capture. Rejected because the PM dispatch goes through ySyncPlugin which uses `ySyncPluginKey` as the Yjs origin — already not tracked by the UndoManager. The PM meta `COMMENT_RECONCILE_META` is only needed for PM-side filtering (the `'input'` event + `onUpdate` debounce). The Yjs origin is `ySyncPluginKey`. Distinguishing reconcile-driven Yjs ops from typing-driven Yjs ops at the substrate layer would require dispatching outside ySyncPlugin's transact wrapper, which is more invasive and provides no clear benefit.

### ADR-0007 for the PM-meta sentinel pattern

Considered creating a small ADR. Rejected — existing ADRs document load-bearing TRADEOFFS with alternatives considered. A sentinel-object pattern in `dispatchTransaction` is a code idiom, not a tradeoff. A paragraph in CLAUDE.md's invariants section plus JSDoc at the export site is sufficient. Save an ADR for 1h if the TC-keystroke meta has real alternatives (e.g., distinct Yjs origin vs. PM meta with non-trivial implications).

---

## Risk register

| Risk | Mitigation |
|---|---|
| `block.html` staleness for mark-class-only changes confuses a future consumer | Documented in CLAUDE.md Comments Architecture; all current consumers (serializer, TC, search/replace, undoableBlocks, linting, compliance) are insensitive. If a future consumer cares, it should read `getBlockHtml(yStore, id)` directly. |
| `prosemirrorToYXmlFragment` becomes a true no-op for matching inputs in a future y-prosemirror release | `setblockhtml-echo-behavior.test.js` would fail. The fail signals that the `onUpdate` gate can be relaxed. Re-evaluate. |
| Mark instance equality across `removeMark` and `addMark` calls within the same tr | PM marks are immutable; `mark.eq()` is structural equality. We pass the same instance to `removeMark` then create a new instance for `addMark`. Confirmed safe by the `pm-comments.test.js` property tests. |
| `setActiveComment(view, null)` called against a destroyed view (block-registry handle leaked after unmount) | `block-registry.unregister` runs in the unmount cleanup. `getBlockView(id)` returns null for unregistered blocks. `prevViewRef.current` may still hold the stale view reference; calling `setActiveComment` on a destroyed view throws. Mitigation: catch + log inside `setActiveComment`, OR validate `view.dom.isConnected` before dispatching. The latter is cheaper. |
| Two-tab same-comment race: peer A resolves at the same instant peer B replies | `commentsState` merges via `cm.mergeRemote` (M2.5 semantics); the resolve and reply are independent envelopes; both peers' reconcile effects fire idempotently. Verified by reasoning + a `collab.spec.js` E2E that asserts both peers converge. |

---

## Test coverage

### New unit tests

- `src/lib/__tests__/pm-comments.test.js`:
  - `reconcileCommentMarks` returns null when doc + state agree.
  - Orphan mark (id ∉ byId) → tr removes the mark; running again returns null.
  - Status flip (mark.resolved !== state.status) → tr removes + re-adds with corrected attr.
  - Adjacent comment marks with different ids preserved when only one needs reconciling.
  - Mark on `text` node followed immediately by `text` without the mark → no spurious removal of neighboring text.
  - Tr is tagged with `COMMENT_RECONCILE_META`.
- `src/lib/pm-plugins/__tests__/active-comment.test.js`:
  - `setActiveComment(view, id)` dispatches meta tr, plugin state updates.
  - `setActiveComment(view, sameId)` is a no-op at the reducer level (state unchanged).
  - DecorationSet cache rebuilds on `tr.docChanged`.
  - DecorationSet cache rebuilds on activeCommentId change.
  - Decoration applies `mark-comment-active` class only to matching `comment` mark range.
  - `setActiveComment(view, null)` clears the DecorationSet.

### New component test

- `src/components/__tests__/PmEditableBlock-comment-reconcile.test.jsx`:
  - Mount with a doc containing a `comment` mark for an id NOT in `commentsState.byId` → effect dispatches reconcile tr → mark removed.
  - Mount with matching state → effect's verb returns null → no dispatch.
  - Reconcile-tagged tr does NOT fire `'input'` event on the DOM root (linter doesn't re-run).
  - Reconcile-tagged tr does NOT schedule an `onUpdate` debounce (App's `block.html` stays unchanged).

### E2E additions

- `tests/e2e/editor.spec.js` under both `chromium-legacy` and `chromium` (PM) projects:
  - Click a comment span → active highlight appears.
  - Resolve the comment → span class transitions; active highlight color updates.
  - Delete the comment → span unwraps to plain text; popup closes.
  - Reopen the popup on a non-existent comment id (orphan recovery edge) — no crash.
- `tests/e2e/collab.spec.js`:
  - Two-tab: peer A creates a comment; peer B sees it without flicker.
  - Two-tab: peer A resolves; peer B's substrate mark flips to `mark-comment-resolved` via ySyncPlugin; peer B's reconcile effect dispatches null (no echo op).
  - Two-tab: peer A deletes; peer B's substrate mark removed; peer B's popup (if open on that id) closes via the existing dismiss path.

### E2E helper additions

- `tests/e2e/pm-helpers.js`:
  - `pmGetActiveCommentDecoration(page, blockId) → string | null` — returns the `activeCommentId` from the plugin state via `window.__simEditorTestUtils`.

### Existing tests that must still pass

- `src/lib/__tests__/comments.test.js` — verify the `shouldSkip` predicate plumbing doesn't break existing assertions.
- `src/lib/__tests__/comments-merge.test.js` — M2.5 mergeRemote semantics unaffected.
- `src/lib/__tests__/comment-report.test.js` — serialization unaffected.
- `src/lib/__tests__/doc-export.test.js` — .SEC export still strips `mark-comment` spans.
- `src/lib/__tests__/setblockhtml-echo-behavior.test.js` — pins the empirical gate rationale.
- `src/lib/__tests__/pmdoc-html.test.js` `prosemirrorToYXmlFragment integration` — pins the post-#64 mark-survival contract.
- All `chromium-legacy` Playwright tests — zero change.

---

## Migration / rollout

Sub-PR 1g is a behavior change for PM-mounted blocks only. The `VITE_PM_EDITOR` flag stays on for rooms that opt in. Default-off rooms (legacy) use the unchanged `cm.reconcileBlocks` path.

Merge order:
1. Sub-PR 1g lands behind the existing flag.
2. Sub-PR 1h lands TC per-keystroke (independent of 1g).
3. Sub-PR 1i removes the flag and deletes the legacy code path; the `shouldSkip` predicate becomes unused and gets removed; the CommentPopup mode-conditional collapses to the PM-only path (or to ref/table-React-only path).

---

## Effort estimate

2-3 days, matching the issue's planning table for 1g.

- New files: `active-comment.js` (~80 LOC), `pm-comments.js` (~70 LOC), three test files (~250 LOC combined).
- Modified files: `comments.js` (~5 LOC change), `PmEditableBlock.jsx` (~30 LOC), `App.jsx` (~40 LOC), `CommentPopup.jsx` (~3 LOC), `editor.css` (~10 LOC), CLAUDE.md (~15 LOC).
- E2E additions: ~40 LOC.

Total: ~540 LOC across ~10 files.
