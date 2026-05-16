# Sub-PR 1i Task 1a.3 — `setBlockHtml` Call-Site Audit

**Date:** 2026-05-16
**Branch:** `feat/1i-a-ci-prep`
**Baseline commit:** `e5ce52f` (1a.1 head)
**Author:** Claude (subagent under sub-PR 1i)
**Status:** Interim — fold this content into the 1i-b.2 PR description, then delete the file (or leave as historical record per task 1a.1 precedent).

## Purpose

Enumerate every `setBlockHtml(` call site in `src/` (excluding tests and the
definition file `src/lib/block-html-store.js`) and classify each as one of
three categories, with the disposition Task 1i-b.2 (handler-triad collapse +
FloatingToolbar legacy-branch deletion) and Task 1i-b.1 step 5
(comment-reconcile silent variant) should apply.

Categories:

- **PM-dispatch redundant** — caller path runs `view.dispatch(tr)` (or
  flushes a debounced PM `onUpdate` after one) BEFORE reaching `setBlockHtml`.
  `ySyncPlugin` has already written the substrate; the `setBlockHtml` is a
  no-op delta that produces an echo `'local-publish'` Yjs op. Removable once
  the only callers are PM-dispatch ones.
- **Non-PM required** — caller generates the HTML *outside* any PM
  `EditorView` (string manipulation, programmatic mutation, search/replace,
  compliance fix). The substrate has not been written; `setBlockHtml` is the
  only path that publishes the change to peers and to the binder. Must stay.
- **Comment-reconcile** — `useEffect([blocks, commentsState])` mirrors
  `cm.reconcileBlocks` html changes into the substrate. Echoes through
  ySyncPlugin and re-enters the UndoManager unless wrapped in the silent
  variant introduced by Task 1i-b.1 step 5.

## Summary

| Category | Count | Disposition |
|---|---|---|
| PM-dispatch redundant | 4 (3 handlers + 1 binder write) | Remove during 1i-b.2; `useBlockBinder.write` keeps its `setBlockHtml` (binder write is the actual substrate-author path when the editor flag is off OR when the binder is the originator — it is NOT preceded by `view.dispatch`) |
| Non-PM required | 6 | Keep |
| Comment-reconcile | 1 | Move to silent variant (Task 1i-b.1 step 5) |
| **Total production call sites** | **11** | — |

(11 = 11 hits in `src/App.jsx` + 1 hit in `src/components/useBlockBinder.js` − the binder is a Non-PM hot path and is counted in row 2.)

Recount with the binder included: 4 PM-dispatch redundant + 6 Non-PM required (including the binder) + 1 Comment-reconcile = 11. Cross-checked against the Grep output.

## Per-Call-Site Audit

### 1. `src/App.jsx:813` — `useEffect([blocks, commentsState])` comment reconcile

```js
if (next !== prev && yStore) {
  for (const b of next) {
    if (typeof b.html !== 'string') continue;
    const before = prev.find(p => p.id === b.id);
    if (before && before.html !== b.html) setBlockHtml(yStore, b.id, b.html);
  }
}
```

- **Calling context:** App-level effect that runs `cm.reconcileBlocks` over
  the block array and mirrors html mutations (orphan-span unwrap,
  comment-span class flip) into the substrate so peers see the resolution.
- **Category:** Comment-reconcile.
- **Disposition:** Move to silent variant in Task 1i-b.1 step 5. The current
  `setBlockHtml(yStore, b.id, b.html)` writes with origin `'local-publish'`,
  which is tracked by both Yjs UndoManagers (post-1h Commit B). A comment
  resolve/reopen captured by Yjs `'local-publish'` enters the local undo
  stack, so Ctrl+Z reverts a peer-driven mark-class flip. Step 5 introduces
  `setBlockHtmlSilent` (origin distinct from `'local-publish'`, NOT tracked
  by either UndoManager) and rewrites this site.
- **Rationale:** Reconcile fires automatically when peer comment ops arrive;
  the user did not author this html mutation locally, so it has no business
  on the local undo stack.

### 2. `src/App.jsx:827` — `handleBlockUpdate`

```js
const handleBlockUpdate = useCallback((id, html) => {
  const yStore = activeYStoreRef.current;
  if (yStore) setBlockHtml(yStore, id, html);
  setBlocks(prev => prev.map(b => b.id === id ? { ...b, html } : b));
}, []);
```

- **Calling context:** The debounced-typing handler wired into PM
  `EditorView`'s `dispatchTransaction` onUpdate (`PmEditableBlock.jsx:474–477`,
  flushed by `PmEditableBlock`'s blur / flushPending path at lines
  371–377 and 587–595), into FloatingToolbar's `onBlockUpdate` (lines 288,
  346, 391, 531, 478 — every PM verb calls
  `flushPendingUpdateById(blockId)` after `view.dispatch`, which awakens the
  pending debounce and calls back into `handleBlockUpdate`), and into
  `TitleBlock`'s `onUpdate` (ref'd at `App.jsx:2543`).
- **Category:** SPLIT — currently both PM-dispatch redundant (PmEditableBlock
  + FloatingToolbar PM branches) AND Non-PM required (TitleBlock, which
  stays contentEditable through 1i; FloatingToolbar's legacy DOM-mutation
  branch). Post-1i-b.2 deletes the FloatingToolbar legacy branches and the
  remaining caller surface is: (a) PmEditableBlock's debounced onUpdate
  (PM-dispatch redundant); (b) TitleBlock's contentEditable input handler
  (Non-PM required; TitleBlock is NOT being retired — only EditableBlock).
- **Disposition:** Keep `setBlockHtml` in `handleBlockUpdate`. The
  TitleBlock caller still needs the substrate write. The PM-side redundancy
  is benign (it produces a zero-delta echo op via
  `prosemirrorToYXmlFragment` diff-and-merge; the empirical
  `setblockhtml-echo-behavior.test.js` shows this is bytewise-byte-stable but
  not literally a no-op — see CLAUDE.md "non-obvious invariants" item on the
  `'migrate-v2'` origin, by analogy). Task 1i-b.2 *may* introduce a
  PM-aware fast-path that skips the write when `getBlockView(id) != null`,
  but the plan's "collapse the triad" goal does not strictly require it.
  Marking as **keep** for the audit; revisit during b.2 implementation.

### 3. `src/App.jsx:868` — `handleLegacyRevisionAction`

```js
const handleLegacyRevisionAction = useCallback((id, html) => {
  resumeHistory();
  framingForHandler().forceFrame();
  const yStore = activeYStoreRef.current;
  if (yStore) setBlockHtml(yStore, id, html);
  setBlocks(prev => prev.map(b => b.id === id ? { ...b, html } : b));
}, [resumeHistory]);
```

- **Calling context:** Wired into `EditableBlock`'s del-popup
  `onRevisionAction` (legacy contentEditable accept/reject of inline TC
  marks) and `FloatingToolbar`'s legacy inline-revision-resolve branch
  (line 477 — `const updateFn = onRevisionAction || onBlockUpdate;`).
  Used after the legacy click path has already mutated `blockEl.innerHTML`
  and serialized it.
- **Category:** Non-PM required (TODAY) → REMOVED ENTIRELY (post-1i-b.2).
- **Disposition:** **Remove the entire handler in 1i-b.2.** The plan's
  "Collapse the handler triad" step deletes `handleLegacyRevisionAction`
  along with the contentEditable legacy del-popup and FloatingToolbar legacy
  inline-resolve branch that call it. After deletion, the two remaining
  resolve paths are PmEditableBlock's del-popup → `handleBlockUpdatePmSync`
  and FloatingToolbar's PM inline-resolve → `handleBlockUpdatePmSync`
  (`onRefreshTcSnapshot`), both of which skip `setBlockHtml`.

### 4. `src/App.jsx:882` — `handleBlockUpdateWithSync`

```js
const handleBlockUpdateWithSync = useCallback((id, html) => {
  const handle = getBlockHandle(id);
  if (handle) handle.setHtml(html);
  const yStore = activeYStoreRef.current;
  if (yStore) setBlockHtml(yStore, id, html);
  setBlocks(prev => prev.map(b => b.id === id ? { ...b, html } : b));
}, []);
```

- **Calling context:** Wired into `MarkSuggestions`'s `onApply` prop
  (`App.jsx:2732`). MarkSuggestions detects ASTM/section-number patterns in
  the block's html, builds a new html string via regex string manipulation
  (no DOM, no PM EditorView), and calls `onApply(blockId, newHtml)`. Also
  invoked from the DEV-only `window.__simEditorTestUtils.setBlockHtml`
  E2E seam (`App.jsx:911`).
- **Category:** Non-PM required.
- **Disposition:** **Keep.** MarkSuggestions never opens a PM `EditorView` —
  it operates on the html string only. Without `setBlockHtml`, peers would
  never see the mark wrapper and the binder would render stale html on the
  next remote-driven snapshot fetch. The `handle.setHtml(html)` call before
  it is the legacy contentEditable DOM sync, which becomes a no-op for
  PM-mounted blocks (registry returns a handle whose `setHtml` no-ops if
  the block has a PM EditorView). Post-1i the registry's setHtml stays as a
  null-coalescing no-op for the PM-only world; the `setBlockHtml` call is
  the load-bearing one.

### 5. `src/App.jsx:957` — `handleSearchReplace`

```js
const handleSearchReplace = useCallback((blockId, offset, length, replacement) => {
  resumeHistory();
  framingForHandler().forceFrame();
  setBlocks(prev => prev.map(b => {
    if (b.id !== blockId || !b.html) return b;
    const newHtml = replaceMatchInHtml(b.html, offset, length, replacement);
    const handle = getBlockHandle(blockId);
    if (handle) handle.setHtml(newHtml);
    const yStore = activeYStoreRef.current;
    if (yStore) setBlockHtml(yStore, blockId, newHtml);
    return { ...b, html: newHtml };
  }));
}, []);
```

- **Calling context:** Search-and-replace panel. `replaceMatchInHtml`
  walks the html string and produces a new html string — string
  manipulation, no PM dispatch.
- **Category:** Non-PM required.
- **Disposition:** **Keep.** Same reasoning as MarkSuggestions: no PM
  EditorView is opened during the replacement.

### 6. `src/App.jsx:1271` — `handleAcceptAll` (inside `framing.withUndoFrame`)

```js
framing.withUndoFrame(() => {
  for (let i = 0; i < next.length; i++) {
    const b = next[i];
    const before = prev.find(p => p.id === b.id);
    if (before && typeof b.html === 'string' && before.html !== b.html) {
      setBlockHtml(yStore, b.id, b.html);
    }
  }
});
```

- **Calling context:** "Accept all revisions" button. `acceptAllRevisions`
  is a pure function over the block array that strips inline ins/del marks
  and removes deleted blocks — pure string manipulation, no PM dispatch.
- **Category:** Non-PM required.
- **Disposition:** **Keep.** The whole point of the `withUndoFrame` wrapper
  is to bundle N `setBlockHtml` writes into one Yjs UndoManager frame —
  removing the writes would silently fail to publish accept-all to peers.

### 7. `src/App.jsx:1293` — `handleRejectAll` (inside `framing.withUndoFrame`)

```js
framing.withUndoFrame(() => {
  for (let i = 0; i < next.length; i++) {
    const b = next[i];
    const before = prev.find(p => p.id === b.id);
    if (before && typeof b.html === 'string' && before.html !== b.html) {
      setBlockHtml(yStore, b.id, b.html);
    }
  }
});
```

- **Calling context:** "Reject all revisions" — symmetric with
  `handleAcceptAll`. `rejectAllRevisions` is a pure block-array
  transformation; no PM dispatch.
- **Category:** Non-PM required.
- **Disposition:** **Keep.**

### 8. `src/App.jsx:1441` — `handleComplianceAcceptFix`

```js
const handleComplianceAcceptFix = useCallback((blockId, fixedText) => {
  resumeHistory();
  framingForHandler().forceFrame();
  const yStore = activeYStoreRef.current;
  if (yStore) setBlockHtml(yStore, blockId, fixedText);
  setBlocks(prev => prev.map(b => b.id === blockId ? { ...b, html: fixedText } : b));
}, []);
```

- **Calling context:** Compliance panel "Accept this fix" button. The fix
  text is produced by the rule engine's `fix()` callback against the block's
  html — string manipulation, no PM EditorView involved. Also wired into
  `EditableBlock`'s `onInlineFix` (the in-tooltip "Apply" button — `App.jsx:2722`).
- **Category:** Non-PM required.
- **Disposition:** **Keep.** The fix is authored outside PM; substrate must
  be written through this call to publish.

### 9. `src/App.jsx:1453` — `handleComplianceAcceptGroup` (inside `framing.withUndoFrame`)

```js
framing.withUndoFrame(() => {
  for (const [bid, html] of fixesByBlock) {
    if (typeof html === 'string') setBlockHtml(yStore, bid, html);
  }
});
```

- **Calling context:** Compliance panel "Accept all in this group" button.
  Same compliance-fix authorship pattern as case 8, batched across blocks
  with the same rule group.
- **Category:** Non-PM required.
- **Disposition:** **Keep.**

### 10. `src/App.jsx:2698` — `EditableBlock` `onAcceptRevision` prop (block-level revision)

```js
onAcceptRevision={(id) => {
  resumeHistory();
  framingForHandler().forceFrame();
  setBlocks(prev => {
    const idx = prev.findIndex(b => b.id === id);
    if (idx < 0) return prev;
    const b = prev[idx];
    if (b.revision === 'del') return prev.filter(bl => bl.id !== id);
    const next = [...prev];
    const html = b.html ? acceptAllInline(b.html) : b.html;
    if (activeYStore && typeof html === 'string') setBlockHtml(activeYStore, id, html);
    next[idx] = { ...b, revision: undefined, html };
    return next;
  });
}}
```

- **Calling context:** Block-level "Accept revision" gutter button on a
  block flagged with `revision === 'add'` or `'chg'`. `acceptAllInline` is
  a pure html-string transformer (`src/lib/revisions.js`); no PM dispatch.
- **Category:** Non-PM required.
- **Disposition:** **Keep.** The gutter button is wired to `EditableBlock`
  but the prop is shaped identically for both legacy and PM paths
  (block-level revision is a property of the block, not the inline content),
  so this site survives 1i-b.2 untouched. Issue an inline note during b.2
  review if this prop ends up moving to PmEditableBlock instead.

### 11. `src/App.jsx:2713` — `EditableBlock` `onRejectRevision` prop (block-level revision)

```js
onRejectRevision={(id) => {
  resumeHistory();
  framingForHandler().forceFrame();
  setBlocks(prev => {
    const idx = prev.findIndex(b => b.id === id);
    if (idx < 0) return prev;
    const b = prev[idx];
    if (b.revision === 'add') return prev.filter(bl => bl.id !== id);
    const next = [...prev];
    const html = b.html ? rejectAllInline(b.html) : b.html;
    if (activeYStore && typeof html === 'string') setBlockHtml(activeYStore, id, html);
    next[idx] = { ...b, revision: undefined, html };
    return next;
  });
}}
```

- **Calling context:** Symmetric with case 10. `rejectAllInline` is a pure
  html-string transformer.
- **Category:** Non-PM required.
- **Disposition:** **Keep.**

### 12. `src/components/useBlockBinder.js:52` — `useBlockBinder().write`

```js
const write = useCallback(
  (next) => {
    if (!yStore || !blockId) return;
    setBlockHtml(yStore, blockId, next);
  },
  [yStore, blockId],
);
```

- **Calling context:** The hook's `write(html)` returned to callers. Used
  by the legacy `EditableBlock` (`handleInput` / `handleBlur` debounced
  publish) and *only* the legacy path — PmEditableBlock skips the binder
  write entirely (PM's ySyncPlugin owns the substrate). Post-1i legacy
  goes away, so this caller surface shrinks to zero in production code.
- **Category:** Non-PM required TODAY (legacy contentEditable is the
  substrate author) → DEAD AFTER 1i.
- **Disposition:** **Keep through 1i-b.2.** Removal lands in the legacy
  deletion sub-phase (per the 1i plan, the `EditableBlock.jsx` file +
  `useBlockBinder.js` retire together). If b.2 lands first, the binder
  hook + its `setBlockHtml` call stay temporarily.

---

## Cross-References

- Task 1i-b.1 step 5: introduces `setBlockHtmlSilent` (new origin distinct
  from `'local-publish'`, NOT in either UndoManager's `trackedOrigins`) and
  rewrites case 1 (App.jsx:813 comment-reconcile effect).
- Task 1i-b.2: collapses `handleBlockUpdate` / `handleLegacyRevisionAction`
  / `handleBlockUpdatePmSync` / `handleBlockUpdateWithSync` triad. Removes
  case 3 (`handleLegacyRevisionAction`) entirely along with the legacy
  FloatingToolbar branches and `EditableBlock` del-popup. Cases 2, 4–11
  stay; their handlers keep the `setBlockHtml` calls because all remaining
  callers either author HTML outside PM (4–11) or include TitleBlock as a
  Non-PM caller (case 2).
- Legacy retirement (later sub-phase of 1i): removes case 12
  (`useBlockBinder`) and the legacy contentEditable input path.

## Expected end-state after 1i (full)

| Call site | Today | After 1i-b.1 step 5 | After 1i-b.2 | After legacy retirement |
|---|---|---|---|---|
| App.jsx:813 (comment-reconcile) | `setBlockHtml` | `setBlockHtmlSilent` | unchanged | unchanged |
| App.jsx:827 (`handleBlockUpdate`) | `setBlockHtml` | unchanged | unchanged (TitleBlock still calls it) | unchanged |
| App.jsx:868 (`handleLegacyRevisionAction`) | `setBlockHtml` | unchanged | **handler deleted** | gone |
| App.jsx:882 (`handleBlockUpdateWithSync`) | `setBlockHtml` | unchanged | unchanged | unchanged |
| App.jsx:957 (`handleSearchReplace`) | `setBlockHtml` | unchanged | unchanged | unchanged |
| App.jsx:1271 (`handleAcceptAll`) | `setBlockHtml` | unchanged | unchanged | unchanged |
| App.jsx:1293 (`handleRejectAll`) | `setBlockHtml` | unchanged | unchanged | unchanged |
| App.jsx:1441 (`handleComplianceAcceptFix`) | `setBlockHtml` | unchanged | unchanged | unchanged |
| App.jsx:1453 (`handleComplianceAcceptGroup`) | `setBlockHtml` | unchanged | unchanged | unchanged |
| App.jsx:2698 (`onAcceptRevision`) | `setBlockHtml` | unchanged | unchanged | unchanged |
| App.jsx:2713 (`onRejectRevision`) | `setBlockHtml` | unchanged | unchanged | unchanged |
| useBlockBinder.js:52 (`write`) | `setBlockHtml` | unchanged | unchanged | **hook deleted** |

End-state count: 10 production `setBlockHtml` call sites (App.jsx:813
moved to `setBlockHtmlSilent`, App.jsx:868 deleted, useBlockBinder deleted).
