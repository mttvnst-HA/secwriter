# Comments module extraction (architecture review #2)

**Goal:** make span↔metadata drift impossible by construction; fold orphan-comment-spans cleanup into a `mergeRemote` reducer; collapse 10 hand-coordinated comment handlers in App.jsx into a small dispatcher pattern. Same playbook as the track-changes extraction (commit `d19d37b`).

Backlog source: `docs/architecture-review-2026-05-01.md` entry #2.

## Locked decisions (from grilling)

| # | Decision |
|---|---|
| Q1 | Module owns DOM mutation. App stops touching `el.className`. |
| Q2 | Reconcile operates on editable blocks only (`b.html` present). Ref/table divergence documented in `CONTEXT.md`. The latent ref-block-html-corruption bug is a follow-up PR (rare in practice). |
| Q3 | Verbs return `{ state, publish }`. Pure: caller passes `ts` and `identity`. |
| Q4 | `mergeRemote` uses M2.5 — union with a `seenRemoteIds` tombstone discriminator. Preserves local drafts; drops peer-deleted entries. |
| Q5 | New shape only inside the module. `normalizeForLoad` shim at the load boundary handles legacy `author`/`timestamp` fields. CommentPopup fallback resolvers are deprecated in a follow-up PR. |
| Q6 | Active highlight uses `data-active` attribute, not className. CSS `.mark-comment-active` becomes `.mark-comment[data-active="true"]` (light + dark). Reconcile is a selector, not a verb. |
| Q7 | `mergeRemote` does NOT take `blocks`. Reconcile is a separate `useEffect([blocks, commentsState])`. Single `dispatchComment(envelope)` on collab session; the four discrete session methods are deleted. |
| Q8 | Verbs: `createInitial / createDraft / updateCreate / reply / resolve / reopen / remove / mergeRemote`. Selectors: `size / get / all / isDraft / getCreateEntry / reconcileBlocks / normalizeForLoad`. `remove` not `delete` (reserved word at export). |
| Q9 | Single PR. Two test files (`comments.test.js` for verbs+selectors ≤30 tests; `comments-merge.test.js` for mergeRemote+reconcile+property tests ≤20 tests). |

## Module API

```js
// State
type CommentsState = {
  byId: Map<string, Comment>,
  seenRemoteIds: Set<string>,
}

type Comment = {
  id, blockId, status: 'open' | 'resolved',
  highlightText, createdAt,
  authorId, authorName, authorColor,
  entries: Entry[],
}

type Entry = {
  id, type: 'create' | 'reply' | 'resolve' | 'reopen',
  text?, authorId, authorName, authorColor, ts,
}

// Publish envelope (1:1 with existing collab.js *ToDoc fns)
type PublishEnvelope =
  | { kind: 'create',  commentId, payload: { blockId, status, highlightText, createdAt, author, initialText } }
  | { kind: 'reply',   commentId, reply:   { author, text, ts } }
  | { kind: 'status',  commentId, status: 'open'|'resolved', meta: { author, ts } }
  | { kind: 'delete',  commentId }

// Verbs (all pure)
createInitial() → state
createDraft(state, { commentId, blockId, highlightText, identity, ts }) → { state, publish: null }
updateCreate(state, { commentId, text, identity, ts })                    → { state, publish }
reply(state, { commentId, text, identity, ts })                            → { state, publish }
resolve(state, { commentId, identity, ts })                                → { state, publish }
reopen(state, { commentId, identity, ts })                                 → { state, publish }
remove(state, { commentId })                                               → { state, publish }
mergeRemote(state, remoteCommentsObj)                                      → state

// Selectors (pure)
size(state) → number
get(state, commentId) → Comment | undefined
all(state) → Comment[]                              // fresh array
isDraft(comment) → boolean                          // entries.length === 1 && entries[0].type === 'create' && !entries[0].text
getCreateEntry(comment) → Entry | undefined
reconcileBlocks(blocks, state) → blocks             // idempotent
normalizeForLoad(rawCommentsObj) → rawCommentsObj   // legacy → canonical at load boundary
```

### M2.5 mergeRemote semantics

```
seenRemoteIds: Set<commentId>  // monotonically grows on each mergeRemote
mergeRemote(prev, remote):
  for id in (remote ∪ prev.byId):
    if id in remote:                    nextById[id] = remote[id]    // remote wins on echo
    else if id in prev.seenRemoteIds:   skip                          // tombstone
    else:                                nextById[id] = prev.byId[id] // local draft preserved
  nextSeenRemoteIds = prev.seenRemoteIds ∪ remote.keys()
```

### reconcileBlocks rule

For each editable block (`b.html` present, contains `mark-comment`):
- Walk every `<span data-comment-id="X">`.
- If `X ∉ state.byId`: unwrap (orphan or local-deleted — both want the span gone).
- Else: ensure className matches `state.byId.get(X).status` (`mark-comment` for open, `mark-comment-resolved` for resolved).

Idempotent: returns original `blocks` ref when nothing changed.

## Migration table

| Change | File |
|---|---|
| Add module | `src/lib/comments.js` |
| Add tests (verbs + selectors) | `src/lib/__tests__/comments.test.js` |
| Add tests (merge + reconcile + props) | `src/lib/__tests__/comments-merge.test.js` |
| Delete | `src/lib/orphan-comment-spans.js` |
| Delete | `src/lib/__tests__/orphan-comment-spans.test.js` |
| Add `dispatchComment(envelope)` to session; delete `publishComment` / `publishCommentReply` / `publishCommentStatus` / `deleteComment` from session API. The underlying `*ToDoc` functions stay (the dispatch implementation). | `src/lib/collab.js` |
| 10 comment handlers → 7 dispatcher sites; add reconcile useEffect; delete `initialBlocksForCleanupRef`; `onRemoteComments` shrinks to ~3 lines; legacy field double-writes deleted | `src/App.jsx` |
| Replace `el.className` mutation with `data-active` attribute toggle | `src/components/CommentPopup.jsx` |
| `.mark-comment-active` → `.mark-comment[data-active="true"]` (light + dark) | `src/styles/editor.css` |
| Comments glossary: add `seenRemoteIds`, `reconcileBlocks`, `draft sentinel`, ref/table divergence | `CONTEXT.md` |
| Comments Architecture section restructure to match TC's structure | `CLAUDE.md` |
| Mark entry #2 Landed with module reference | `docs/architecture-review-2026-05-01.md` |

Existing `src/lib/__tests__/collab.test.js` is unchanged — it tests the underlying `*ToDoc` functions, which stay.

## TDD order

1. Write `comments.test.js` per-verb tests against the planned API. Run → red.
2. Implement `createInitial` + per-verb skeletons returning `{ state: prev, publish: null }`. Run → most tests still red.
3. Implement each verb until its tests pass. Run after each.
4. Write `comments-merge.test.js` mergeRemote tests. Run → red.
5. Implement `mergeRemote` (M2.5). Run → green.
6. Write reconcileBlocks tests (covering today's orphan-spans cases + the new reclass cases + the property test). Run → red.
7. Implement `reconcileBlocks`. Run → green.
8. Write `normalizeForLoad` tests. Run → red. Implement. Run → green.
9. Write selector tests. Run → red. Implement. Run → green.
10. Migrate `collab.js`: add `dispatchComment`, delete the four session methods. `npm run test:server` (collab.test.js still passes — it imports the *ToDoc fns directly).
11. Migrate `App.jsx`: dispatcher pattern, reconcile effect, mergeRemote call, delete `initialBlocksForCleanupRef`, delete legacy field double-writes.
12. Migrate `CommentPopup.jsx`: data-active attribute.
13. Migrate `editor.css`: attribute selector.
14. Delete `orphan-comment-spans.js` + its test.
15. `npm test` (all pass).
16. `npm run test:e2e` with `--workers=2` (no comment-collab E2E exists; existing E2E should still pass).
17. Update `CONTEXT.md`, `CLAUDE.md`, `docs/architecture-review-2026-05-01.md`.

## Risks and edge cases

- **Echo of own publish.** Originator's `setCommentsState(...)` updates byId locally. The publish round-trips and onRemoteComments fires. mergeRemote merges remote into prev — for the echo, remote wins (per M2.5 rule). Comment data isn't lost because remote == what we just published.
- **Reconcile loop.** Idempotence is the safety net: when `reconcileBlocks` finds nothing to change, it returns the original `blocks` reference. React's `Object.is` short-circuits; no re-render; no loop.
- **Focused-block clobber.** If user is mid-edit on a block when reconcile produces new HTML for that block, `EditableBlock`'s sync useEffect already skips DOM mutation when the block is focused (`document.activeElement === ref.current`, `EditableBlock.jsx:122-129`). On blur, handleBlur reads the DOM HTML back and onUpdate fires; reconcile re-runs with the just-published HTML and reapplies the correct class if the user disturbed it. One-cycle latency, no data loss.
- **Stale auto-save.** `normalizeForLoad` runs at the load boundary so any legacy-field auto-save data gets canonicalized before reaching state.byId. Module never sees legacy fields.
- **Ref/table comments are unchanged behavior** — they remain visually transient (already broken today). A separate follow-up PR will derive ref/table comment highlights from metadata. Tracked as out-of-scope of this PR.

## Out of scope (follow-ups to file)

1. RefBlock / TableBlock should derive comment highlights from metadata at render time (fixes today's "ref-block comments are visually transient" bug).
2. Deprecate `CommentPopup`'s `resolveEntryAuthor` / `resolveEntryTs` fallbacks once we're confident no stale legacy auto-save data exists in production.
3. The "draft as local-only state, not in block.html until promote" idea (D4 from grilling) — closes the orphan window entirely instead of healing it. Not needed; M2.5 heals well.

## Remaining work (resumable checklist)

Status as of pause point: plan written; `comments.test.js` is red (module file doesn't exist). All grilling decisions are locked — do **not** redesign, implement.

- [x] Write implementation plan (this file).
- [x] Rename existing `comments.test.js` → `comment-report.test.js`.
- [x] Write `src/lib/__tests__/comments.test.js` (verbs + selectors + normalizeForLoad). Currently red: `Cannot find module '../comments.js'`.
- [ ] Implement `src/lib/comments.js` to satisfy `comments.test.js`. Make green.
- [ ] Write `src/lib/__tests__/comments-merge.test.js` (mergeRemote + reconcileBlocks + property tests, ≤20 tests). Confirm red.
- [ ] Implement `mergeRemote` (M2.5 with `seenRemoteIds`) and `reconcileBlocks` to satisfy the merge tests. Make green.
- [ ] Migrate `src/lib/collab.js`: add `dispatchComment(envelope)` (switch on `envelope.kind`); delete the four session methods (`publishComment`, `publishCommentReply`, `publishCommentStatus`, `deleteComment`). Underlying `*ToDoc` functions stay. Existing `collab.test.js` should pass unchanged.
- [ ] Migrate `src/App.jsx`: replace 10 comment handlers with the dispatcher pattern; add reconcile `useEffect([blocks, commentsState])`; delete `initialBlocksForCleanupRef`; delete legacy `author`/`timestamp` double-writes; `onRemoteComments` shrinks to ~3 lines using `mergeRemote`.
- [ ] Update `src/components/CommentPopup.jsx`: stop writing `el.className`; use `data-active` attribute on mount/unmount instead.
- [ ] Update `src/styles/editor.css`: `.mark-comment-active` → `.mark-comment[data-active="true"]` (and dark-mode equivalent).
- [ ] Delete `src/lib/orphan-comment-spans.js` and `src/lib/__tests__/orphan-comment-spans.test.js`.
- [ ] Run `npm test` — fix any regressions.
- [ ] Run `npm run test:e2e -- --workers=2` per the memory note about flaky default worker count.
- [ ] Update `CONTEXT.md` Comments glossary: add `seenRemoteIds`, `reconcileBlocks`, the draft sentinel, the ref/table divergence note.
- [ ] Update `CLAUDE.md` "Comments Architecture" section to match the TC section's structure.
- [ ] Mark `docs/architecture-review-2026-05-01.md` entry #2 status as **Landed** with the module reference (mirror entry #1's wording).
