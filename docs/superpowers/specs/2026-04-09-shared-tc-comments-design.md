# Shared Track Changes & Shared Comments — Design

**Date:** 2026-04-09
**Branch:** `multi-user`
**Status:** Design approved, ready for implementation planning

## Goal

Extend SIM's multi-user collaboration prototype so that Track Changes and Comments are shared across all clients in a room, with per-author attribution. Outside a room, single-user behavior is unchanged.

## Design decisions (from brainstorming)

1. **TC model:** room-wide toggle + per-author inline marks (author attribution via `data-author-*` attributes on `<ins>`/`<del>`).
2. **Comments model:** `yComments: Y.Map<commentId, Y.Map>` with `entries: Y.Array<Y.Map>` for thread replies, so concurrent replies merge cleanly.
3. **Scope:** minimal shared TC + shared comments, plus author identity visible in comment UI (avatars + names from `identity.js`).
4. **Undo scope:** neither TC toggle nor comment operations are tracked by `Y.UndoManager` — matches current single-user behavior.
5. **TC baseline source:** the toggler's current view at toggle-time (matches single-user). Snapshots cleared on disable.
6. **Accept/Reject authority:** any user can accept/reject any mark. Matches the prototype's trust model.

## Data model additions (`Y.Doc`)

```text
yTc: Y.Map                                       room-wide TC state
  enabled: boolean
  snapshots: Y.Map<blockId, string>               plaintext baselines

yComments: Y.Map<commentId, Y.Map>                comment metadata
  blockId: string
  status: 'open' | 'resolved'
  highlightText: string
  createdAt: number
  authorId: string
  authorName: string
  authorColor: string
  entries: Y.Array<Y.Map>                         thread replies
    id, authorId, authorName, authorColor, text, ts
```

Block HTML continues to carry `mark-comment` highlight spans (synced via the existing `yStore` → html Y.Text pathway). The new `yComments` Y.Map is the parallel metadata store, mirroring single-user's split of DOM highlights + React `comments` Map.

## Author attribution on TC marks

When `refineWordDiff()` in `text-diff.js` produces `<ins>` / `<del>` spans during a TC diff pass, it gains an optional `author` parameter (`{id, name, color}`). If provided, the produced marks carry:

```html
<ins data-author-id="u-abc" data-author-color="#7a3" data-author-name="Alice">...</ins>
<del data-author-id="u-abc" data-author-color="#7a3" data-author-name="Alice">...</del>
```

`editor.css` colors the mark border/underline using an inline CSS custom property (set when rendering), falling back to the existing ADD/DEL colors when no author is present. Serializer preserves attributes on internal roundtrip; `.SEC` export strips them (SpecsIntact SGML has no author field).

## `collab.js` — new session handles

```js
session.publishTc({ enabled, snapshots })        // origin: 'local-tc'
session.publishComment(id, commentData)          // origin: 'local-comments'
session.publishCommentReply(id, replyData)       // origin: 'local-comments'
session.publishCommentStatus(id, status)         // origin: 'local-comments'
session.deleteComment(id)                        // origin: 'local-comments'
```

Each mutator opens a `ydoc.transact(fn, 'local-*')`. The existing `handleAfterTx` filter — which treats any `local-*` origin as local — already prevents echo. Two new change detectors get added to `handleAfterTx`:

```js
const tcChanged       = cpt.has(yTc) || ch.has(yTc);
const commentsChanged = cpt.has(yComments) || ch.has(yComments);
if (tcChanged)       onRemoteTc?.(readTc(yTc));
if (commentsChanged) onRemoteComments?.(readComments(yComments));
```

New read helpers `readTc(yTc)` and `readComments(yComments)` deep-convert to plain JS objects for consumption by React. Mirroring `yBlocksToArray` and `readYMeta`.

**Seeding:** the first client to join an empty room writes `yTc.enabled = false`, an empty `snapshots` Y.Map, and an empty `yComments` Y.Map. Subsequent joiners inherit whatever exists.

**UndoManager:** unchanged. Still tracks `[yOrder, yStore]`. `yTc` and `yComments` are intentionally excluded (design decision 4).

## `App.jsx` wiring

When `inRoom === true`, `trackChanges`, `tcSnapshots`, and `comments` become **derived views** of the Y.Doc (parallel to how `blocks` is already a derived view):

- `onRemoteTc` callback → `setTrackChanges(tc.enabled)` + `setTcSnapshots(new Map(Object.entries(tc.snapshots)))`.
- `onRemoteComments` callback → `setComments(new Map(...))`.
- Local user toggles TC → call `session.publishTc({enabled: !current, snapshots: newSnapshots})` instead of mutating local state directly.
- Local user creates a comment → call `session.publishComment(...)` (the html mutation for the `mark-comment` span still flows through the existing `setBlocks` / `publishBlocks` path).
- Local user replies / resolves / reopens / deletes → `publishCommentReply` / `publishCommentStatus` / `deleteComment`.

**Accept/Reject snapshot sync (critical):** `handleRevisionAction` in a room must update both the block html AND the corresponding `yTc.snapshots[blockId]` entry in the same tick. Otherwise Bob sees Alice's new html against his stale snapshot and the diff re-generates phantom marks.

Sequence inside a room:
```js
const newBlocks = blocks.map(b => b.id === id ? {...b, html: newHtml} : b);
setBlocks(newBlocks);                 // triggers publishBlocks → yStore
const newPlain = stripHtml(newHtml);
const snaps = new Map(tcSnapshots);
snaps.set(id, newPlain);
setTcSnapshots(snaps);                // triggers publishTc → yTc.snapshots
```

Both publishes use distinct `local-*` origins, so each arrives at Bob as a pure-remote change and the two `onRemote*` callbacks fire sequentially. Bob's re-diff against the updated snapshot collapses to empty — no phantom marks.

**Accept All / Reject All** batches block updates into one publish and snapshot rewrites into a single `publishTc` call immediately after.

**TC toggle OFF** clears `yTc.snapshots` in the same Y.Doc transaction that sets `yTc.enabled = false`.

**Outside a room:** all existing local `useState` paths remain unchanged. Zero regression risk for single-user.

## Identity for new comments

The existing `src/lib/identity.js` already provides `{id, name, color}` from `sessionStorage['sim-identity']`. Every new comment and reply captures this at creation time and stores it in `yComments`. Outside a room, the same identity is used if present; otherwise fall back to the current "You" behavior.

## `CommentPopup` UI (scope B)

- Comment gutter marker shows a small colored dot matching `authorColor` + first initial, reusing `PresenceBar`'s color style.
- Thread replies render an author chip (colored initials circle + name) before each reply text.
- Resolve/reopen/delete buttons unchanged — any room participant can use them.

## Files touched

| File | Change |
|------|--------|
| `src/lib/collab.js` | New Y types (`yTc`, `yComments`), `publishTc`, `publishComment*`, `deleteComment`, `readTc`, `readComments`, new change detection in `handleAfterTx`, new seeding in `handleSync` |
| `src/lib/__tests__/collab.test.js` | 15 new tests (see below) |
| `src/lib/text-diff.js` | Optional `author` param on `refineWordDiff()` → `data-author-*` attributes on `<ins>`/`<del>` |
| `src/App.jsx` | Wire `onRemoteTc` / `onRemoteComments`, derive TC/comments from Y.Doc when `inRoom`, update `handleRevisionAction` to publish snapshot alongside html, pass identity into diff helper |
| `src/components/CommentPopup.jsx` | Render author chips for comment + each reply |
| `src/components/EditableBlock.jsx` | Comment gutter marker shows author initial/color |
| `src/styles/editor.css` | Author-colored border on `ins`/`del` via CSS custom property |
| `CLAUDE.md` | Update "Multi-user collaboration" section; remove shared TC / shared Comments from roadmap; bump test counts |

## Tests

New in `src/lib/__tests__/collab.test.js`:

1. Shared TC: enabling captures current `yStore` text as snapshots for every block.
2. Shared TC: disabling clears snapshots in the same transaction.
3. Shared TC: two-doc — enable on A propagates `enabled=true` + matching snapshots to B.
4. Shared TC: accept on A publishes new snapshot that silences diff on B.
5. Shared TC: two-doc merge — concurrent accepts on different blocks both converge.
6. Shared comments: create comment publishes full metadata (authorId/color/highlightText).
7. Shared comments: reply from B appears in A's thread entries Y.Array.
8. Shared comments: concurrent replies from A and B both land (Y.Array merge, no loss).
9. Shared comments: resolve on A propagates status='resolved' to B.
10. Shared comments: reopen round-trip.
11. Shared comments: delete on A removes entry on B.
12. Shared comments: CRDT merge — A resolves while B replies, both effects survive.
13. `CollabSession.publishCommentReply` uses `local-comments` origin (no echo).
14. `CollabSession.publishTc` uses `local-tc` origin (no echo).
15. `handleAfterTx` routes pure-TC transactions to `onRemoteTc` only (not `onRemoteBlocks`).

All 15 are unit tests using two `Y.Doc` instances with manual `applyUpdate` for cross-doc merge scenarios (same pattern as existing `two-doc CRDT merge` tests in `collab.test.js`).

## Deployment implications (callout)

This spec preserves the current prototype persistence model: the Y.Doc (blocks + TC + comments + meta) lives in memory on the `y-websocket` relay server and is persisted as a binary CRDT snapshot at `server/collab-db/<room>.ydoc`. `.SEC` files and `.comments.json` sidecars are written only to **each user's local disk**, only when that user explicitly hits Ctrl+S (via File System Access API).

In a hosted Azure deployment this creates two gaps worth flagging before they bite:

1. **Sidecar is point-in-time per user.** If Alice saves while Bob is still typing a reply, only Alice's sidecar reflects the room state at her save moment; Bob's sidecar (if he ever saves) diverges. Reopening either file single-user loads a different view of the comments.
2. **No server-side `.SEC` of record.** The relay's binary snapshot is a CRDT blob, not a human-openable `.SEC`. If the relay VM is reimaged and nobody happened to save locally, the room's work is gone even though the server "persisted" it.

These gaps are acceptable for the localhost prototype and do **not** block this feature. They become real problems in a hosted deployment. The follow-up spec `2026-04-09-server-owned-documents-design.md` (option 2 in the deployment discussion — Azure Blob Storage as the document backing store, with server-side open/save endpoints) will address both. Build this feature first; plan that spec next.

## Non-goals (explicitly out of scope)

- Sidecar `.comments.json` shared on export (remains per-session).
- Author field in SGML `.SEC` export.
- Per-user read-state / unread comment indicators.
- Moving comment operations into `Y.UndoManager`.
- Intra-block character-level CRDT merge (still whole-Y.Text replacement).
- Auth / TLS / rate limiting (orthogonal; tracked separately on roadmap).

## Rollout

Land on the `multi-user` branch. Single-user behavior is unchanged because every new code path is gated on `inRoom`. `multi-user` is not yet merged to `main`, so there's no production impact.
