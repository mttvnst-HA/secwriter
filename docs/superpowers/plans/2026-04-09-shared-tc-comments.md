# Shared Track Changes & Shared Comments — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Share Track Changes state (room-wide toggle + per-author inline marks) and Comments (add/reply/resolve/reopen/delete with author attribution) across all clients in a collaborative room, while preserving current single-user behavior when outside a room.

**Architecture:** Add two new top-level Yjs shared types to the per-room `Y.Doc`: `yTc` (enabled flag + snapshots Y.Map) and `yComments` (Y.Map<id, Y.Map> with `entries: Y.Array<Y.Map>`). Extend `CollabSession` with publish/read helpers for both, observed via the existing `afterTransaction` handler using two new change detectors that mirror the existing `blocksChanged` / `metaChanged` routing. React `trackChanges` / `tcSnapshots` / `comments` state becomes a derived view of Y.Doc when `inRoom`. Author attribution on `<ins>`/`<del>` marks is carried by `data-author-*` attributes emitted from `refineWordDiff`. Neither `yTc` nor `yComments` is tracked by `Y.UndoManager` (matches single-user semantics).

**Tech Stack:** Yjs 13.6, y-websocket 1.5.4, React 18.3, Vitest 4.1, linkedom 0.18.

**Spec:** `docs/superpowers/specs/2026-04-09-shared-tc-comments-design.md`

---

## File Structure

### Files created
- None — all changes extend existing files.

### Files modified
| File | Responsibility |
|---|---|
| `src/lib/collab.js` | New shared types (`yTc`, `yComments`), new session handles (`publishTc`, `publishComment`, `publishCommentReply`, `publishCommentStatus`, `deleteComment`), new read helpers (`readTc`, `readComments`), new routing branches in `handleAfterTx`, new seeding branch in `handleSync`, `onRemoteTc` / `onRemoteComments` callbacks |
| `src/lib/__tests__/collab.test.js` | 15 new tests covering TC + comments sync, two-doc merge, origin filters, routing |
| `src/lib/text-diff.js` | Optional `author` parameter on `refineWordDiff` → emits `data-author-id`, `data-author-name`, `data-author-color` on produced `<ins>`/`<del>` spans |
| `src/lib/__tests__/text-diff.test.js` | 3 new tests for author attribute emission |
| `src/App.jsx` | Wire `onRemoteTc` / `onRemoteComments` into `createCollabSession` call, derive TC/comments from Y.Doc when `inRoom`, publish local toggles/edits, update `handleRevisionAction` to publish snapshot alongside html, pass identity to diff helper |
| `src/components/CommentPopup.jsx` | Render author chip (colored initials + name) per comment create + reply |
| `src/components/EditableBlock.jsx` | Comment gutter marker shows author initial/color from comment metadata |
| `src/styles/editor.css` | Author-colored border on `ins`/`del` via `--author-color` CSS variable with fallback to existing ADD/DEL colors |
| `CLAUDE.md` | Remove shared TC / shared Comments from roadmap, update "Multi-user collaboration" section to describe new yTc/yComments layout + origin list + identity invariants, update test counts (539 → 557 Vitest) |

---

## Task 1: Add `yTc` and `yComments` shared types to `createCollabSession`

**Files:**
- Modify: `src/lib/collab.js` (session constructor + JSDoc header)

This task ONLY adds the shared types and seeds them on first join. No publish or read APIs yet — those land in subsequent tasks. This keeps the diff reviewable and the test surface small.

- [ ] **Step 1: Update the JSDoc header comment**

Open `src/lib/collab.js` and replace the data-layout block at the top (lines ~8-25) with:

```javascript
/**
 * Collaborative editing layer (prototype).
 *
 * Uses Yjs CRDT + y-websocket to sync the block array across clients in a
 * shared room. The Y.Doc is the source of truth when `inRoom` is true; the
 * React `blocks` state becomes a derived view.
 *
 * Data layout (one Y.Doc per room):
 *   yOrder:    Y.Array<string>        ordered block IDs (the document outline)
 *   yStore:    Y.Map<string, Y.Map>   block data, keyed by block ID
 *                                     each value Y.Map has { id, type, part,
 *                                     depth, section, level?, html: Y.Text,
 *                                     table?, ref?, revision? }
 *   yMeta:     Y.Map                  { sectionNumber, sectionTitle, date, fileName }
 *   yTc:       Y.Map                  { enabled: boolean,
 *                                       snapshots: Y.Map<blockId, string> }
 *                                     Room-wide Track Changes state. When
 *                                     `enabled` flips on, `snapshots` is
 *                                     populated with the plaintext of every
 *                                     block at that moment (the baseline
 *                                     everyone diffs against). Flipping off
 *                                     clears `snapshots` in the same
 *                                     transaction.
 *   yComments: Y.Map<id, Y.Map>       Shared comment metadata. Each comment
 *                                     Y.Map has { blockId, status,
 *                                     highlightText, createdAt, authorId,
 *                                     authorName, authorColor,
 *                                     entries: Y.Array<Y.Map> } where each
 *                                     entry is { id, type, authorId,
 *                                     authorName, authorColor, text, ts }.
 *                                     Using Y.Array for entries lets
 *                                     concurrent replies from different
 *                                     clients merge without loss.
 *   awareness: { user: {id,name,color}, cursor: {blockId, index} }
 *
 * Transaction origins used by this module (all must begin with 'local-' so
 * handleAfterTx's prefix filter suppresses local echo):
 *   'local-publish'   — block structure + html changes (yOrder + yStore)
 *   'local-meta'      — section metadata (yMeta)
 *   'local-tc'        — Track Changes toggle + snapshot updates (yTc)
 *   'local-comments'  — comment create/reply/status/delete (yComments)
 *   'seed'            — initial room seeding (not a local edit)
 *
 * Why split ordering from storage:
 *   Yjs shared types (Y.Map/Y.Text) cannot be moved between positions in a
 *   Y.Array — a "move" requires delete+reinsert, which creates a fresh
 *   instance and DESTROYS any concurrent edits another client is making to
 *   the original Y.Text. See the "CRDT identity invariant" note in
 *   CLAUDE.md. By storing blocks in a keyed Y.Map and keeping only string
 *   IDs in the ordering Y.Array, reorders become cheap (reorder strings)
 *   and Y.Text identity is preserved across any structural change —
 *   insert, delete, or reorder.
 *
 * Prototype limitations (see CLAUDE.md roadmap):
 *   - html sync uses whole-text replacement (no per-character CRDT merge)
 *   - table/ref blocks sync as whole-value replacements (coarse)
 *   - no server-side .SEC persistence — Y.Doc on relay is in-memory CRDT;
 *     .SEC + sidecar .comments.json live on each user's local disk
 */
```

- [ ] **Step 2: Declare the new shared types inside `createCollabSession`**

Find the `const yMeta = ydoc.getMap('meta');` line (around line 342) and insert immediately after:

```javascript
  const yTc = ydoc.getMap('tc');
  const yComments = ydoc.getMap('comments');
```

- [ ] **Step 3: Seed `yTc.enabled = false` and an empty snapshots map on first join**

Find the existing seeding block inside `handleSync` that starts with `if (yMeta.size === 0 && initialMeta ...)` (around line 376) and add a new branch directly after it, still inside the `if (isSynced && !seeded)` block:

```javascript
      // Seed yTc on first join if empty. Use a nested Y.Map for snapshots so
      // individual snapshot updates can happen without rewriting the whole
      // tc state. yComments is just an empty Y.Map — no seeding needed; it
      // gets populated when someone creates a comment.
      if (yTc.size === 0) {
        ydoc.transact(() => {
          yTc.set('enabled', false);
          yTc.set('snapshots', new Y.Map());
        }, 'seed');
      }
```

- [ ] **Step 4: Expose the new types on the returned session object**

Find the `return {` block at the end of `createCollabSession` (around line 455) and add the two new fields between `yMeta` and `awareness`:

```javascript
  return {
    ydoc,
    yOrder,
    yStore,
    yMeta,
    yTc,
    yComments,
    awareness,
    provider,
    undoManager,
    // ... existing method fields follow
```

- [ ] **Step 5: Verify no regression in existing tests**

Run:
```bash
npm test -- collab.test.js
```
Expected: all existing tests pass (33 tests currently). The new Y types don't alter any existing code path yet.

- [ ] **Step 6: Commit**

```bash
git add src/lib/collab.js
git commit -m "feat(collab): add yTc + yComments shared types (scaffold)"
```

---

## Task 2: Add `publishTc` + `readTc` helpers and route TC transactions in `handleAfterTx`

**Files:**
- Modify: `src/lib/collab.js` (new helper + session method + afterTransaction routing)
- Modify: `src/lib/__tests__/collab.test.js` (new tests)

- [ ] **Step 1: Write the failing tests**

Open `src/lib/__tests__/collab.test.js` and add this `describe` block at the end of the file, before the final closing brace if any:

```javascript
describe('shared Track Changes (M-shared-tc)', () => {
  function makeDocWithTc() {
    const ydoc = new Y.Doc();
    const yOrder = ydoc.getArray('order');
    const yStore = ydoc.getMap('store');
    const yTc = ydoc.getMap('tc');
    // Mirror the seed that createCollabSession performs.
    ydoc.transact(() => {
      yTc.set('enabled', false);
      yTc.set('snapshots', new Y.Map());
    }, 'seed');
    return { ydoc, yOrder, yStore, yTc };
  }

  it('publishTc writes enabled + snapshots under local-tc origin', () => {
    const { ydoc, yTc } = makeDocWithTc();
    const origins = [];
    ydoc.on('afterTransaction', (tx) => { origins.push(tx.origin); });

    publishTcToDoc(ydoc, yTc, { enabled: true, snapshots: { n1: 'Hello', n2: 'World' } });

    expect(yTc.get('enabled')).toBe(true);
    const snaps = yTc.get('snapshots');
    expect(snaps.get('n1')).toBe('Hello');
    expect(snaps.get('n2')).toBe('World');
    expect(origins).toContain('local-tc');
  });

  it('publishTc with enabled=false clears snapshots in the same transaction', () => {
    const { ydoc, yTc } = makeDocWithTc();
    // First enable + populate
    publishTcToDoc(ydoc, yTc, { enabled: true, snapshots: { n1: 'Hello' } });
    expect(yTc.get('snapshots').size).toBe(1);
    // Now disable — snapshots must be cleared
    publishTcToDoc(ydoc, yTc, { enabled: false, snapshots: {} });
    expect(yTc.get('enabled')).toBe(false);
    expect(yTc.get('snapshots').size).toBe(0);
  });

  it('readTc returns enabled + snapshots as a plain object', () => {
    const { ydoc, yTc } = makeDocWithTc();
    publishTcToDoc(ydoc, yTc, { enabled: true, snapshots: { n1: 'Hello', n2: 'World' } });
    const out = readTc(yTc);
    expect(out).toEqual({ enabled: true, snapshots: { n1: 'Hello', n2: 'World' } });
  });

  it('two-doc merge: publishTc on A propagates enabled+snapshots to B', () => {
    const { ydoc: docA, yTc: tcA } = makeDocWithTc();
    const { ydoc: docB, yTc: tcB } = makeDocWithTc();
    publishTcToDoc(docA, tcA, { enabled: true, snapshots: { n1: 'Hello', n2: 'World' } });
    // Exchange updates both directions.
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));
    Y.applyUpdate(docA, Y.encodeStateAsUpdate(docB));
    expect(readTc(tcB)).toEqual({ enabled: true, snapshots: { n1: 'Hello', n2: 'World' } });
  });

  it('two-doc merge: concurrent snapshot updates on different blocks both converge', () => {
    const { ydoc: docA, yTc: tcA } = makeDocWithTc();
    const { ydoc: docB, yTc: tcB } = makeDocWithTc();
    // Start both on an enabled TC with baseline snapshots.
    publishTcToDoc(docA, tcA, { enabled: true, snapshots: { n1: 'A0', n2: 'B0' } });
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));
    // Concurrent divergent edits:
    publishTcToDoc(docA, tcA, { enabled: true, snapshots: { n1: 'A1', n2: 'B0' } });
    publishTcToDoc(docB, tcB, { enabled: true, snapshots: { n1: 'A0', n2: 'B1' } });
    // Cross-apply updates.
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));
    Y.applyUpdate(docA, Y.encodeStateAsUpdate(docB));
    // Both convergent results: n1 has A's last write, n2 has B's last write.
    const a = readTc(tcA);
    const b = readTc(tcB);
    expect(a).toEqual(b);
    expect(a.snapshots.n1).toBe('A1');
    expect(a.snapshots.n2).toBe('B1');
  });
});
```

At the top of the file, extend the import from `../collab.js` to include the two new symbols you're about to export (the test currently references `publishTcToDoc` and `readTc`):

```javascript
import {
  // ... existing imports
  publishTcToDoc,
  readTc,
} from '../collab.js';
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npm test -- collab.test.js
```
Expected: 5 new failing tests with "publishTcToDoc is not a function" or similar import error.

- [ ] **Step 3: Implement `publishTcToDoc` + `readTc` in `collab.js`**

Add these two exported functions near the other standalone helpers, just below `readYMeta` (around line 176):

```javascript
/**
 * Snapshot the yTc Y.Map as a plain `{ enabled, snapshots }` object. The
 * snapshots Y.Map is converted to a plain object keyed by blockId.
 */
export function readTc(yTc) {
  const enabled = !!yTc.get('enabled');
  const snapsMap = yTc.get('snapshots');
  const snapshots = {};
  if (snapsMap && typeof snapsMap.forEach === 'function') {
    snapsMap.forEach((value, key) => { snapshots[key] = value; });
  }
  return { enabled, snapshots };
}

/**
 * Apply a TC state update to yTc inside a 'local-tc' transaction. Writes
 * `enabled` and rewrites the `snapshots` Y.Map to match `snapshots` exactly
 * (deletes entries missing from the input). When enabled is false, callers
 * are expected to pass an empty snapshots object — this function does NOT
 * auto-clear snapshots, so the invariant lives in the caller.
 */
export function publishTcToDoc(ydoc, yTc, { enabled, snapshots }) {
  ydoc.transact(() => {
    if (yTc.get('enabled') !== enabled) yTc.set('enabled', !!enabled);
    let snapsMap = yTc.get('snapshots');
    if (!(snapsMap instanceof Y.Map)) {
      snapsMap = new Y.Map();
      yTc.set('snapshots', snapsMap);
    }
    const next = snapshots && typeof snapshots === 'object' ? snapshots : {};
    // Delete keys not present in the incoming object.
    const nextKeys = new Set(Object.keys(next));
    for (const k of Array.from(snapsMap.keys())) {
      if (!nextKeys.has(k)) snapsMap.delete(k);
    }
    // Write or update the rest.
    for (const [k, v] of Object.entries(next)) {
      if (snapsMap.get(k) !== v) snapsMap.set(k, v);
    }
  }, 'local-tc');
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npm test -- collab.test.js
```
Expected: all 5 new TC tests pass + all existing collab tests still pass.

- [ ] **Step 5: Add the `session.publishTc` method**

Inside `createCollabSession`'s returned object, add immediately after `publishMeta`:

```javascript
    publishTc(tc) {
      // M-shared-tc — room-wide Track Changes state. `tc` is
      // { enabled: boolean, snapshots: { [blockId]: string } }. When
      // disabling, callers pass an empty snapshots object so the baseline
      // is cleared in the same transaction as the flag flip.
      publishTcToDoc(ydoc, yTc, tc);
    },
```

- [ ] **Step 6: Add TC change detection to `handleAfterTx`**

Find `handleAfterTx` around line 397. Add a new detector line next to the existing `metaChanged`, and a new emit branch at the end:

```javascript
    const blocksChanged =
      cpt.has(yOrder) || cpt.has(yStore) || ch.has(yOrder) || ch.has(yStore);
    const metaChanged = cpt.has(yMeta) || ch.has(yMeta);
    const tcChanged = cpt.has(yTc) || ch.has(yTc);

    if (blocksChanged) {
      onRemoteBlocks?.(yBlocksToArray(yOrder, yStore), { initial: false });
    }
    if (metaChanged) {
      onRemoteMeta?.(readYMeta(yMeta), { initial: false });
    }
    if (tcChanged) {
      onRemoteTc?.(readTc(yTc), { initial: false });
    }
```

- [ ] **Step 7: Add `onRemoteTc` to the `createCollabSession` parameter list and initial emit**

Extend the destructured parameter list (around line 328):

```javascript
export function createCollabSession({
  room,
  wsUrl = DEFAULT_WS_URL,
  identity,
  initialBlocks,
  initialMeta,
  onRemoteBlocks,
  onRemoteMeta,
  onRemoteTc,
  onRemoteComments,
  onPresenceChange,
  onStatusChange,
}) {
```

(Yes, also add `onRemoteComments` now — Task 3 uses it.)

Inside `handleSync`, after the existing `onRemoteMeta?.(...)` initial emit, add:

```javascript
      onRemoteTc?.(readTc(yTc), { initial: true });
      onRemoteComments?.(readComments(yComments), { initial: true });
```

(`readComments` lands in Task 3 — expect a ReferenceError until then. Leave this line as-is; the next task fixes it. We sequence this way to keep the afterTransaction routing tests self-contained.)

Because the next task will make `readComments` available, add a temporary shim AT THE TOP OF the file, just below the existing helpers, so tests for this task still pass:

```javascript
// Temporary: replaced with full implementation in Task 3.
export function readComments(yComments) {
  const out = {};
  if (!yComments || typeof yComments.forEach !== 'function') return out;
  return out;
}
```

- [ ] **Step 8: Add the routing test**

Append to the `describe('shared Track Changes ...)` block:

```javascript
  it('handleAfterTx routes pure-TC transactions through onRemoteTc (not onRemoteBlocks)', async () => {
    // Simulate two docs connected via manual update relay to exercise
    // handleAfterTx without a real WebSocket. We don't need createCollabSession
    // here — we just need to verify the routing logic inside it, so we
    // import and call the handler shape directly by spying on callbacks.
    const ydoc = new Y.Doc();
    const yOrder = ydoc.getArray('order');
    const yStore = ydoc.getMap('store');
    const yMeta = ydoc.getMap('meta');
    const yTc = ydoc.getMap('tc');
    const yComments = ydoc.getMap('comments');
    ydoc.transact(() => {
      yTc.set('enabled', false);
      yTc.set('snapshots', new Y.Map());
    }, 'seed');

    const calls = { blocks: 0, meta: 0, tc: 0, comments: 0 };
    ydoc.on('afterTransaction', (tx) => {
      const origin = tx.origin;
      if (typeof origin === 'string' && origin.startsWith('local-')) return;
      if (origin === 'seed') return;
      if (tx.changed.size === 0 && tx.changedParentTypes.size === 0) return;
      const cpt = tx.changedParentTypes;
      const ch = tx.changed;
      if (cpt.has(yOrder) || cpt.has(yStore) || ch.has(yOrder) || ch.has(yStore)) calls.blocks++;
      if (cpt.has(yMeta) || ch.has(yMeta)) calls.meta++;
      if (cpt.has(yTc) || ch.has(yTc)) calls.tc++;
      if (cpt.has(yComments) || ch.has(yComments)) calls.comments++;
    });

    // Simulate a REMOTE tc update by applying a state update from a peer doc.
    const peer = new Y.Doc();
    const peerTc = peer.getMap('tc');
    peer.transact(() => {
      peerTc.set('enabled', true);
      peerTc.set('snapshots', new Y.Map());
    }, 'seed');
    Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(peer));

    expect(calls.tc).toBeGreaterThan(0);
    expect(calls.blocks).toBe(0);
    expect(calls.meta).toBe(0);
    expect(calls.comments).toBe(0);
  });
```

- [ ] **Step 9: Run the tests**

```bash
npm test -- collab.test.js
```
Expected: all new tests pass. If the routing test fires both `tc` and something else, the detector logic has a bug.

- [ ] **Step 10: Commit**

```bash
git add src/lib/collab.js src/lib/__tests__/collab.test.js
git commit -m "feat(collab): publishTc + readTc + yTc routing in afterTransaction"
```

---

## Task 3: Add `publishComment*` / `deleteComment` + `readComments` helpers

**Files:**
- Modify: `src/lib/collab.js` (replace the shim, add publishers, add session methods, wire routing)
- Modify: `src/lib/__tests__/collab.test.js` (new tests)

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/__tests__/collab.test.js`:

```javascript
describe('shared Comments (M-shared-comments)', () => {
  function makeDocWithComments() {
    const ydoc = new Y.Doc();
    const yComments = ydoc.getMap('comments');
    return { ydoc, yComments };
  }

  const ALICE = { id: 'u-alice', name: 'Alice', color: '#7a3' };
  const BOB = { id: 'u-bob', name: 'Bob', color: '#37a' };

  function sampleCommentPayload(overrides = {}) {
    return {
      blockId: 'n1',
      status: 'open',
      highlightText: 'the quick fox',
      createdAt: 1712600000000,
      author: ALICE,
      initialText: 'Please rewrite',
      ...overrides,
    };
  }

  it('publishCommentToDoc stores full metadata + initial create entry', () => {
    const { ydoc, yComments } = makeDocWithComments();
    publishCommentToDoc(ydoc, yComments, 'c-1', sampleCommentPayload());
    const cMap = yComments.get('c-1');
    expect(cMap.get('blockId')).toBe('n1');
    expect(cMap.get('status')).toBe('open');
    expect(cMap.get('highlightText')).toBe('the quick fox');
    expect(cMap.get('authorId')).toBe('u-alice');
    expect(cMap.get('authorName')).toBe('Alice');
    expect(cMap.get('authorColor')).toBe('#7a3');
    const entries = cMap.get('entries');
    expect(entries.length).toBe(1);
    expect(entries.get(0).get('type')).toBe('create');
    expect(entries.get(0).get('text')).toBe('Please rewrite');
    expect(entries.get(0).get('authorId')).toBe('u-alice');
  });

  it('publishCommentReplyToDoc appends to the entries Y.Array', () => {
    const { ydoc, yComments } = makeDocWithComments();
    publishCommentToDoc(ydoc, yComments, 'c-1', sampleCommentPayload());
    publishCommentReplyToDoc(ydoc, yComments, 'c-1', {
      author: BOB,
      text: 'Agreed',
      ts: 1712600001000,
    });
    const entries = yComments.get('c-1').get('entries');
    expect(entries.length).toBe(2);
    expect(entries.get(1).get('type')).toBe('reply');
    expect(entries.get(1).get('text')).toBe('Agreed');
    expect(entries.get(1).get('authorName')).toBe('Bob');
  });

  it('publishCommentStatusToDoc toggles status + appends an event entry', () => {
    const { ydoc, yComments } = makeDocWithComments();
    publishCommentToDoc(ydoc, yComments, 'c-1', sampleCommentPayload());
    publishCommentStatusToDoc(ydoc, yComments, 'c-1', 'resolved', { author: BOB, ts: 100 });
    const cMap = yComments.get('c-1');
    expect(cMap.get('status')).toBe('resolved');
    const entries = cMap.get('entries');
    expect(entries.get(entries.length - 1).get('type')).toBe('resolve');
    expect(entries.get(entries.length - 1).get('authorName')).toBe('Bob');
  });

  it('deleteCommentFromDoc removes the entry entirely', () => {
    const { ydoc, yComments } = makeDocWithComments();
    publishCommentToDoc(ydoc, yComments, 'c-1', sampleCommentPayload());
    expect(yComments.has('c-1')).toBe(true);
    deleteCommentFromDoc(ydoc, yComments, 'c-1');
    expect(yComments.has('c-1')).toBe(false);
  });

  it('readComments returns plain { [id]: commentObject } with entries array', () => {
    const { ydoc, yComments } = makeDocWithComments();
    publishCommentToDoc(ydoc, yComments, 'c-1', sampleCommentPayload());
    publishCommentReplyToDoc(ydoc, yComments, 'c-1', {
      author: BOB, text: 'Agreed', ts: 1,
    });
    const out = readComments(yComments);
    expect(out['c-1']).toMatchObject({
      blockId: 'n1',
      status: 'open',
      authorName: 'Alice',
    });
    expect(Array.isArray(out['c-1'].entries)).toBe(true);
    expect(out['c-1'].entries.length).toBe(2);
    expect(out['c-1'].entries[1].text).toBe('Agreed');
  });

  it('two-doc merge: reply from B appears in A after sync', () => {
    const { ydoc: docA, yComments: cA } = makeDocWithComments();
    const { ydoc: docB, yComments: cB } = makeDocWithComments();
    publishCommentToDoc(docA, cA, 'c-1', sampleCommentPayload());
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));
    publishCommentReplyToDoc(docB, cB, 'c-1', {
      author: BOB, text: 'From Bob', ts: 100,
    });
    Y.applyUpdate(docA, Y.encodeStateAsUpdate(docB));
    const readA = readComments(cA);
    expect(readA['c-1'].entries.length).toBe(2);
    expect(readA['c-1'].entries[1].text).toBe('From Bob');
  });

  it('two-doc merge: concurrent replies from A and B both land', () => {
    const { ydoc: docA, yComments: cA } = makeDocWithComments();
    const { ydoc: docB, yComments: cB } = makeDocWithComments();
    publishCommentToDoc(docA, cA, 'c-1', sampleCommentPayload());
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));
    // Concurrent replies — neither doc has seen the other yet.
    publishCommentReplyToDoc(docA, cA, { author: ALICE, text: 'From Alice', ts: 1 });
    publishCommentReplyToDoc(docB, cB, { author: BOB, text: 'From Bob', ts: 2 });
    // Cross-apply.
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));
    Y.applyUpdate(docA, Y.encodeStateAsUpdate(docB));
    const a = readComments(cA);
    const b = readComments(cB);
    // Both replies present on both sides, plus the original create.
    expect(a['c-1'].entries.length).toBe(3);
    expect(b['c-1'].entries.length).toBe(3);
    const textsA = a['c-1'].entries.map((e) => e.text).sort();
    expect(textsA).toContain('From Alice');
    expect(textsA).toContain('From Bob');
  });

  it('two-doc merge: A resolves while B replies — both effects survive', () => {
    const { ydoc: docA, yComments: cA } = makeDocWithComments();
    const { ydoc: docB, yComments: cB } = makeDocWithComments();
    publishCommentToDoc(docA, cA, 'c-1', sampleCommentPayload());
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));
    publishCommentStatusToDoc(docA, cA, 'c-1', 'resolved', { author: ALICE, ts: 1 });
    publishCommentReplyToDoc(docB, cB, { author: BOB, text: 'Wait', ts: 2 });
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));
    Y.applyUpdate(docA, Y.encodeStateAsUpdate(docB));
    const a = readComments(cA);
    expect(a['c-1'].status).toBe('resolved');
    const texts = a['c-1'].entries.map((e) => e.text);
    expect(texts).toContain('Wait');
  });

  it('two-doc merge: deleteComment on A removes entry on B after sync', () => {
    const { ydoc: docA, yComments: cA } = makeDocWithComments();
    const { ydoc: docB, yComments: cB } = makeDocWithComments();
    publishCommentToDoc(docA, cA, 'c-1', sampleCommentPayload());
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));
    expect(cB.has('c-1')).toBe(true);
    deleteCommentFromDoc(docA, cA, 'c-1');
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));
    expect(cB.has('c-1')).toBe(false);
  });

  it('publishCommentReplyToDoc uses local-comments origin', () => {
    const { ydoc, yComments } = makeDocWithComments();
    publishCommentToDoc(ydoc, yComments, 'c-1', sampleCommentPayload());
    const origins = [];
    ydoc.on('afterTransaction', (tx) => { origins.push(tx.origin); });
    publishCommentReplyToDoc(ydoc, yComments, 'c-1', { author: BOB, text: 'hi', ts: 1 });
    expect(origins).toContain('local-comments');
  });
});
```

Extend the import at the top of the test file:

```javascript
import {
  // ... existing
  publishCommentToDoc,
  publishCommentReplyToDoc,
  publishCommentStatusToDoc,
  deleteCommentFromDoc,
  readComments,
} from '../collab.js';
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npm test -- collab.test.js
```
Expected: 9 new failing tests with import errors.

- [ ] **Step 3: Replace the `readComments` shim with the real implementation**

In `src/lib/collab.js`, delete the temporary shim from Task 2 and replace with:

```javascript
/**
 * Snapshot yComments as a plain object keyed by comment ID. Each comment
 * is a plain object with scalar fields + `entries: Array<plainEntry>`.
 *
 * The shape matches the React `comments` Map value used elsewhere in the
 * app, so callers can do `new Map(Object.entries(readComments(yComments)))`.
 */
export function readComments(yComments) {
  const out = {};
  if (!yComments || typeof yComments.forEach !== 'function') return out;
  yComments.forEach((cMap, id) => {
    if (!cMap || typeof cMap.get !== 'function') return;
    const entry = {
      id,
      blockId: cMap.get('blockId'),
      status: cMap.get('status') || 'open',
      highlightText: cMap.get('highlightText') || '',
      createdAt: cMap.get('createdAt') || 0,
      authorId: cMap.get('authorId') || '',
      authorName: cMap.get('authorName') || '',
      authorColor: cMap.get('authorColor') || '',
      entries: [],
    };
    const entries = cMap.get('entries');
    if (entries && typeof entries.forEach === 'function') {
      entries.forEach((eMap) => {
        if (!eMap || typeof eMap.get !== 'function') return;
        entry.entries.push({
          id: eMap.get('id') || '',
          type: eMap.get('type') || 'reply',
          authorId: eMap.get('authorId') || '',
          authorName: eMap.get('authorName') || '',
          authorColor: eMap.get('authorColor') || '',
          text: eMap.get('text') || '',
          ts: eMap.get('ts') || 0,
        });
      });
    }
    out[id] = entry;
  });
  return out;
}
```

- [ ] **Step 4: Add the four publisher functions**

Immediately below `readComments`, add:

```javascript
/**
 * Build a Y.Map entry suitable for insertion into a comment's `entries`
 * Y.Array. Scalar fields only — no nested shared types, so replies merge
 * by position (Y.Array concurrent-insert semantics).
 */
function buildEntryYMap({ type, author, text, ts, id }) {
  const m = new Y.Map();
  m.set('id', id || `e-${Math.random().toString(36).slice(2, 10)}`);
  m.set('type', type);
  m.set('authorId', author?.id || '');
  m.set('authorName', author?.name || '');
  m.set('authorColor', author?.color || '');
  m.set('text', text || '');
  m.set('ts', typeof ts === 'number' ? ts : Date.now());
  return m;
}

/**
 * Create a new shared comment in yComments. `payload` is:
 *   { blockId, status, highlightText, createdAt, author, initialText }
 * The initial 'create' entry is added to the entries Y.Array in the same
 * transaction.
 */
export function publishCommentToDoc(ydoc, yComments, id, payload) {
  ydoc.transact(() => {
    const cMap = new Y.Map();
    cMap.set('blockId', payload.blockId);
    cMap.set('status', payload.status || 'open');
    cMap.set('highlightText', payload.highlightText || '');
    cMap.set('createdAt', payload.createdAt || Date.now());
    cMap.set('authorId', payload.author?.id || '');
    cMap.set('authorName', payload.author?.name || '');
    cMap.set('authorColor', payload.author?.color || '');
    const entries = new Y.Array();
    entries.push([buildEntryYMap({
      type: 'create',
      author: payload.author,
      text: payload.initialText || '',
      ts: payload.createdAt || Date.now(),
    })]);
    cMap.set('entries', entries);
    yComments.set(id, cMap);
  }, 'local-comments');
}

/**
 * Append a reply entry to an existing comment's entries Y.Array. No-op if
 * the comment does not exist (could happen if a concurrent delete beat us).
 */
export function publishCommentReplyToDoc(ydoc, yComments, id, { author, text, ts }) {
  ydoc.transact(() => {
    const cMap = yComments.get(id);
    if (!cMap) return;
    const entries = cMap.get('entries');
    if (!(entries instanceof Y.Array)) return;
    entries.push([buildEntryYMap({ type: 'reply', author, text, ts })]);
  }, 'local-comments');
}

/**
 * Change a comment's status ('open' | 'resolved') and append a status-event
 * entry to its entries Y.Array.
 */
export function publishCommentStatusToDoc(ydoc, yComments, id, status, { author, ts } = {}) {
  ydoc.transact(() => {
    const cMap = yComments.get(id);
    if (!cMap) return;
    cMap.set('status', status);
    const entries = cMap.get('entries');
    if (entries instanceof Y.Array) {
      entries.push([buildEntryYMap({
        type: status === 'resolved' ? 'resolve' : 'reopen',
        author,
        text: '',
        ts,
      })]);
    }
  }, 'local-comments');
}

/**
 * Remove a comment entirely. Local UI is responsible for stripping the
 * `mark-comment` span from the block HTML (that change flows through the
 * existing blocks → yStore pathway).
 */
export function deleteCommentFromDoc(ydoc, yComments, id) {
  ydoc.transact(() => {
    if (yComments.has(id)) yComments.delete(id);
  }, 'local-comments');
}
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
npm test -- collab.test.js
```
Expected: all 9 new comment tests pass.

- [ ] **Step 6: Add the four session methods**

In the returned object of `createCollabSession`, add immediately after `publishTc`:

```javascript
    publishComment(id, payload) {
      publishCommentToDoc(ydoc, yComments, id, payload);
    },
    publishCommentReply(id, reply) {
      publishCommentReplyToDoc(ydoc, yComments, id, reply);
    },
    publishCommentStatus(id, status, meta) {
      publishCommentStatusToDoc(ydoc, yComments, id, status, meta);
    },
    deleteComment(id) {
      deleteCommentFromDoc(ydoc, yComments, id);
    },
```

- [ ] **Step 7: Wire comment change detection into `handleAfterTx`**

Next to the existing `tcChanged`, add:

```javascript
    const commentsChanged = cpt.has(yComments) || ch.has(yComments);
```

And at the end of the emit branches:

```javascript
    if (commentsChanged) {
      onRemoteComments?.(readComments(yComments), { initial: false });
    }
```

(The `onRemoteComments` parameter was already added in Task 2 Step 7.)

- [ ] **Step 8: Run the full collab test suite**

```bash
npm test -- collab.test.js
```
Expected: all previous tests + 5 TC tests + 9 comment tests + routing test pass. Total: 48+ tests in this file.

- [ ] **Step 9: Commit**

```bash
git add src/lib/collab.js src/lib/__tests__/collab.test.js
git commit -m "feat(collab): shared comments CRDT model + publish/read helpers"
```

---

## Task 4: Author attribution on `<ins>`/`<del>` marks in `text-diff.js`

**Files:**
- Modify: `src/lib/text-diff.js` (optional `author` param through to mark emission)
- Modify: `src/lib/__tests__/text-diff.test.js` (3 new tests)

- [ ] **Step 1: Read the current `refineWordDiff` signature**

Open `src/lib/text-diff.js`. Locate `refineWordDiff` (the function that takes word-level diff ops and emits `<ins>`/`<del>` HTML). Also locate whichever helper actually builds the `<ins>...</ins>` / `<del>...</del>` strings — it's likely called from inside `refineWordDiff` or a sibling. Note the exact call site and the current signature.

- [ ] **Step 2: Write the failing tests**

Append to `src/lib/__tests__/text-diff.test.js`:

```javascript
describe('author attribution on ins/del marks', () => {
  const ALICE = { id: 'u-alice', name: 'Alice', color: '#7a3' };

  it('emits data-author-* attributes on <ins> when author is provided', () => {
    const html = refineWordDiff('the quick fox', 'the slow fox', { author: ALICE });
    expect(html).toContain('<ins');
    expect(html).toContain('data-author-id="u-alice"');
    expect(html).toContain('data-author-name="Alice"');
    expect(html).toContain('data-author-color="#7a3"');
  });

  it('emits data-author-* attributes on <del> when author is provided', () => {
    const html = refineWordDiff('the quick fox', 'the fox', { author: ALICE });
    expect(html).toContain('<del');
    expect(html).toContain('data-author-id="u-alice"');
  });

  it('omits data-author-* attributes when no author is provided (back-compat)', () => {
    const html = refineWordDiff('the quick fox', 'the slow fox');
    expect(html).toContain('<ins');
    expect(html).not.toContain('data-author-id');
    expect(html).not.toContain('data-author-name');
    expect(html).not.toContain('data-author-color');
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

```bash
npm test -- text-diff.test.js
```
Expected: 3 new failing tests.

- [ ] **Step 4: Thread `author` through `refineWordDiff`**

In `src/lib/text-diff.js`:

1. Change `refineWordDiff(oldText, newText)` to `refineWordDiff(oldText, newText, options = {})`.
2. Destructure `const { author } = options;` at the top.
3. Build the attribute suffix once:

```javascript
  const authorAttrs = author
    ? ` data-author-id="${escapeHtmlAttr(author.id)}" data-author-name="${escapeHtmlAttr(author.name)}" data-author-color="${escapeHtmlAttr(author.color)}"`
    : '';
```

4. Locate every string-template that currently produces `<ins>` or `<del>` tags inside this function (and any helper it calls). Replace each opening tag with the author-aware form. For example:

```javascript
// BEFORE:
return `<ins>${content}</ins>`;
// AFTER:
return `<ins${authorAttrs}>${content}</ins>`;
```

If `refineWordDiff` delegates to another helper (likely `emitMark` or similar), pass `authorAttrs` through to that helper and do the same substitution there. Grep for all occurrences:

```bash
grep -n '<ins\|<del' src/lib/text-diff.js
```

Every hit inside the diff-emission code path must include `${authorAttrs}`.

5. Add a local `escapeHtmlAttr` helper if one doesn't already exist in the file:

```javascript
function escapeHtmlAttr(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
```

(If the file already has one with a different name, use that instead.)

- [ ] **Step 5: Run the tests**

```bash
npm test -- text-diff.test.js
```
Expected: all 3 new tests pass + all existing text-diff tests still pass (20 previously).

- [ ] **Step 6: Commit**

```bash
git add src/lib/text-diff.js src/lib/__tests__/text-diff.test.js
git commit -m "feat(text-diff): optional author attribution on ins/del marks"
```

---

## Task 5: Wire shared TC into `App.jsx`

**Files:**
- Modify: `src/App.jsx` (add `onRemoteTc` / `onRemoteComments` to `createCollabSession`, derive TC state from Y.Doc when inRoom, publish on toggle + accept/reject, thread identity into diff)

- [ ] **Step 1: Add `onRemoteTc` callback to `createCollabSession` call**

Find the `createCollabSession({...})` call (around line 1058). Immediately after `onRemoteMeta`, add:

```javascript
      onRemoteTc: (tc, meta) => {
        // M-shared-tc — apply remote Track Changes state.
        // `tc` is { enabled: boolean, snapshots: { [blockId]: string } }.
        // Setting React state from a remote update does not round-trip
        // back to Y.Doc because the publish effects below gate on a
        // 'dirty' ref that's only set by user actions.
        remoteTcRef.current = tc;
        setTrackChanges(!!tc.enabled);
        setTcSnapshots(new Map(Object.entries(tc.snapshots || {})));
      },
      onRemoteComments: (commentsObj, meta) => {
        // M-shared-comments — replace the local comments Map with the
        // authoritative Y.Doc snapshot. The mark-comment DOM spans are
        // synced via the existing blocks→yStore pathway, so nothing to
        // do here besides the metadata Map.
        remoteCommentsRef.current = commentsObj;
        setComments(new Map(Object.entries(commentsObj || {})));
      },
```

- [ ] **Step 2: Declare the new refs near `collabSessionRef`**

Find `const collabSessionRef = useRef(null);` (around line 167) and add beside it:

```javascript
  const remoteTcRef = useRef(null);
  const remoteCommentsRef = useRef(null);
  const tcDirtyRef = useRef(false);
```

- [ ] **Step 3: Add a publish effect for TC state**

Below the existing `publishMeta` effect (around line 1225), add:

```javascript
  // M-shared-tc — publish local TC state changes to the Y.Doc.
  // Gating: only publish when `tcDirtyRef` is set, meaning the change came
  // from a user action (toggle, accept/reject). Remote updates clear it via
  // onRemoteTc so round-tripping is suppressed.
  useEffect(() => {
    if (!inRoom) return;
    const session = collabSessionRef.current;
    if (!session) return;
    if (!sessionReadyRef.current) return;
    if (!tcDirtyRef.current) return;
    tcDirtyRef.current = false;
    const snapshots = {};
    // When disabled, publish empty snapshots so the baseline is cleared
    // in the same transaction as the flag flip.
    if (trackChanges) {
      for (const [id, txt] of tcSnapshots.entries()) snapshots[id] = txt;
    }
    try {
      session.publishTc({ enabled: trackChanges, snapshots });
    } catch (err) {
      console.error('[collab] publishTc failed:', err);
    }
  }, [trackChanges, tcSnapshots, inRoom]);
```

- [ ] **Step 4: Mark TC state dirty from user actions**

Find the TC toggle handler in App.jsx. It's the `onClick` for the "Track Changes" button in `RevisionControls` — the prop is named something like `onToggleTrackChanges` / `setTrackChanges`. Before every callsite that calls `setTrackChanges(...)` for a user-initiated action (NOT the `onRemoteTc` callback), add `tcDirtyRef.current = true;` immediately before.

Grep for `setTrackChanges(` to find all callers:

```bash
grep -n 'setTrackChanges(' src/App.jsx
```

For each local (user-initiated) call, wrap it:

```javascript
tcDirtyRef.current = true;
setTrackChanges(next);
```

The **exception** is the `onRemoteTc` callback itself — do NOT mark dirty there; that's a remote application and must not round-trip.

Similarly, find every `setTcSnapshots(` call that comes from a user action (the effect in App.jsx that initializes snapshots when TC is enabled, and the one inside `handleRevisionAction`). Add `tcDirtyRef.current = true;` before each:

```bash
grep -n 'setTcSnapshots(' src/App.jsx
```

- [ ] **Step 5: Update `handleRevisionAction` to publish snapshot alongside html in a room**

Find `handleRevisionAction` (around line 605). The current body already calls `setBlocks` (which triggers a `publishBlocks` via the existing effect) and `setTcSnapshots`. Both the block publish AND the TC publish are now triggered by React effects, so the critical thing is just that both state updates happen in the same React tick — which they already do. Add an explicit `tcDirtyRef.current = true;` before `setTcSnapshots` to make sure the publish effect fires:

```javascript
  const handleRevisionAction = useCallback((id, html) => {
    resumeHistory();
    setBlocks(prev => prev.map(b => b.id === id ? { ...b, html } : b));
    if (trackChanges) {
      tcDirtyRef.current = true;
      setTcSnapshots(prev => {
        const next = new Map(prev);
        next.set(id, getVisibleTextFromHtml(html));
        return next;
      });
    }
  }, [trackChanges]);
```

- [ ] **Step 6: Thread identity into the diff helper**

Find every call site of `refineWordDiff` in App.jsx and the `EditableBlock` / `TitleBlock` components:

```bash
grep -rn 'refineWordDiff' src/
```

For each call in a render path, pass `{ author: identity }` when `inRoom`:

```javascript
refineWordDiff(oldText, newText, inRoom && identity ? { author: identity } : undefined)
```

If the diff is computed in a component that doesn't currently know about `identity`, pass it down as a prop from App.jsx. The two likely sites are in `EditableBlock.jsx` where TC diff is rendered — add `identity` to its prop list and the App.jsx `<EditableBlock>` usages.

- [ ] **Step 7: Run unit tests**

```bash
npm test
```
Expected: all Vitest tests pass (existing 539 + new 17 from Tasks 2–4 = 556). If any snapshot-style tests on `EditableBlock` or `App` break because of the new prop, update them minimally.

- [ ] **Step 8: Manual smoke test in two browser windows**

In two terminals:
```bash
npm run collab
npm run dev
```
Open two browsers/tabs at `http://localhost:5173/?room=demo-tc`. Each with a different identity name.

1. Alice toggles Track Changes ON → Bob sees the TC toggle light up and his baseline snapshots match.
2. Alice types "quick" → "slow" in a block → the `<ins>slow</ins><del>quick</del>` shows on BOTH screens with Alice's color.
3. Bob clicks Accept on Alice's change → the mark vanishes on BOTH screens and no phantom diff reappears on either side.
4. Alice toggles TC off → Bob's TC toggle flips off too, snapshots cleared.

If phantom diffs appear on accept, the snapshot publish is racing the block publish — debug by logging origins in `handleAfterTx`.

- [ ] **Step 9: Commit**

```bash
git add src/App.jsx src/components/EditableBlock.jsx
git commit -m "feat(collab): wire shared Track Changes into App.jsx"
```

---

## Task 6: Wire shared Comments into `App.jsx`

**Files:**
- Modify: `src/App.jsx` (publish comment operations in a room; derive comments from Y.Doc)

- [ ] **Step 1: Publish on comment create**

Find `handleCommentCreate` (around line 475). After the existing `setComments(...)` call, add a room branch:

```javascript
  const handleCommentCreate = useCallback((blockId, html, commentId, highlightText) => {
    if (html !== null) {
      setBlocks(prev => prev.map(b => b.id === blockId ? { ...b, html } : b));
    }
    const author = identity || { id: 'local', name: getAuthorName() || 'User', color: '#888' };
    const createdAt = Date.now();
    setComments(prev => {
      const next = new Map(prev);
      next.set(commentId, {
        id: commentId,
        blockId,
        status: "open",
        highlightText: highlightText || "",
        createdAt,
        authorId: author.id,
        authorName: author.name,
        authorColor: author.color,
        entries: [{ id: `e-${createdAt}`, type: "create", text: "", authorId: author.id, authorName: author.name, authorColor: author.color, ts: createdAt }],
      });
      return next;
    });
    if (inRoom && collabSessionRef.current) {
      try {
        collabSessionRef.current.publishComment(commentId, {
          blockId,
          status: 'open',
          highlightText: highlightText || '',
          createdAt,
          author,
          initialText: '',
        });
      } catch (err) {
        console.error('[collab] publishComment failed:', err);
      }
    }
    setOpenCommentId(commentId);
    setTimeout(() => {
      const el = document.querySelector(`[data-comment-id="${commentId}"]`);
      if (el) setCommentRect(el.getBoundingClientRect());
    }, 50);
  }, [inRoom, identity]);
```

- [ ] **Step 2: Publish on comment reply**

Rewrite `handleCommentReply`:

```javascript
  const handleCommentReply = useCallback((commentId, text, author) => {
    const effectiveAuthor = identity || { id: 'local', name: author || 'User', color: '#888' };
    const ts = Date.now();
    setComments(prev => {
      const next = new Map(prev);
      const c = next.get(commentId);
      if (!c) return prev;
      next.set(commentId, {
        ...c,
        entries: [...c.entries, {
          id: `e-${ts}`,
          type: "reply",
          text,
          authorId: effectiveAuthor.id,
          authorName: effectiveAuthor.name,
          authorColor: effectiveAuthor.color,
          ts,
        }],
      });
      return next;
    });
    if (inRoom && collabSessionRef.current) {
      try {
        collabSessionRef.current.publishCommentReply(commentId, {
          author: effectiveAuthor,
          text,
          ts,
        });
      } catch (err) {
        console.error('[collab] publishCommentReply failed:', err);
      }
    }
  }, [inRoom, identity]);
```

- [ ] **Step 3: Publish on resolve / reopen / delete**

Update `handleCommentResolve`:

```javascript
  const handleCommentResolve = useCallback((commentId) => {
    const effectiveAuthor = identity || { id: 'local', name: getAuthorName() || 'User', color: '#888' };
    const ts = Date.now();
    setComments(prev => {
      const next = new Map(prev);
      const c = next.get(commentId);
      if (!c) return prev;
      next.set(commentId, {
        ...c,
        status: "resolved",
        entries: [...c.entries, { id: `e-${ts}`, type: "resolve", authorId: effectiveAuthor.id, authorName: effectiveAuthor.name, authorColor: effectiveAuthor.color, ts }],
      });
      return next;
    });
    if (inRoom && collabSessionRef.current) {
      try {
        collabSessionRef.current.publishCommentStatus(commentId, 'resolved', { author: effectiveAuthor, ts });
      } catch (err) { console.error('[collab] publishCommentStatus failed:', err); }
    }
    const el = document.querySelector(`[data-comment-id="${commentId}"]`);
    if (el) {
      el.className = "mark-comment-resolved";
      const blockEl = el.closest('[data-block-id]');
      if (blockEl) {
        const blockId = blockEl.getAttribute('data-block-id');
        setBlocks(prev => prev.map(b => b.id === blockId ? { ...b, html: blockEl.innerHTML } : b));
      }
    }
  }, [inRoom, identity]);
```

Apply the same pattern to `handleCommentReopen` (publish status `'open'`) and `handleCommentDelete` (call `collabSessionRef.current.deleteComment(commentId)` after the local state update).

- [ ] **Step 4: Do not clear comments on SEC file load when in a room**

Find the `setComments(new Map())` call in the file-import path (around line 251 per the earlier grep). Gate it on `!inRoom`:

```javascript
if (!inRoom) setComments(new Map());
```

Because when in a room, `yComments` is authoritative — a local file import must not wipe the shared comment state.

- [ ] **Step 5: Unit tests**

```bash
npm test
```
Expected: all existing tests still pass. No new Vitest tests for this task — the comment publish paths are covered by Task 3's collab tests; App-level integration is covered by the manual smoke test.

- [ ] **Step 6: Manual two-window smoke test**

With `npm run collab` + `npm run dev` running, open two tabs at `?room=demo-comments`:

1. Alice highlights "the quick fox" and creates a comment "please rewrite" → Bob sees a yellow highlight and a comment marker with Alice's color/initial.
2. Bob replies "agreed" → Alice's thread updates with Bob's reply and Bob's color chip.
3. Alice resolves → on Bob's screen the comment turns gray/resolved.
4. Bob reopens → turns yellow again on both.
5. Alice deletes → comment gone on both.
6. Concurrent reply smoke test: disconnect Bob's tab (DevTools → Network → Offline), Alice replies, Bob replies, reconnect → both replies appear on both sides.

- [ ] **Step 7: Commit**

```bash
git add src/App.jsx
git commit -m "feat(collab): wire shared Comments into App.jsx"
```

---

## Task 7: Author chips in `CommentPopup` + gutter dot in `EditableBlock`

**Files:**
- Modify: `src/components/CommentPopup.jsx` (render author chip per entry)
- Modify: `src/components/EditableBlock.jsx` (gutter comment dot takes authorColor/Initial)
- Modify: `src/styles/editor.css` (new `.author-chip` styles)

- [ ] **Step 1: Add the `.author-chip` CSS**

Append to `src/styles/editor.css`:

```css
/* Shared-comments author chip — colored initial circle + name */
.author-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: #334155;
}
.author-chip__initial {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: var(--author-color, #888);
  color: #fff;
  font-weight: 600;
  font-size: 9px;
  line-height: 1;
  flex-shrink: 0;
}
```

- [ ] **Step 2: Update `CommentPopup.jsx` to show an author chip per entry**

Open `src/components/CommentPopup.jsx`. For each rendered entry (find the `entries.map(...)` render loop), render an author chip above or next to the text:

```jsx
{entry.authorName && (
  <span className="author-chip" style={{ '--author-color': entry.authorColor || '#888' }}>
    <span className="author-chip__initial">{(entry.authorName[0] || '?').toUpperCase()}</span>
    <span>{entry.authorName}</span>
  </span>
)}
<div className="comment-entry-text">{entry.text}</div>
```

Replace whatever the current "author line" rendering is with this. Preserve existing classes and layout — just add the initial circle.

- [ ] **Step 3: Update `EditableBlock.jsx` comment gutter marker**

Find the comment gutter rendering — it currently shows a small circle/marker next to a block when a comment exists. Pull the comment's `authorColor` + first letter of `authorName` from the `comments` prop:

```jsx
{blockComments.map((c) => (
  <button
    key={c.id}
    className="comment-gutter-marker"
    style={{ '--author-color': c.authorColor || '#888' }}
    onClick={(e) => onCommentClick(c.id, e.currentTarget.getBoundingClientRect())}
    title={`${c.authorName || 'Comment'}: ${c.entries?.[0]?.text || ''}`}
  >
    {(c.authorName?.[0] || 'C').toUpperCase()}
  </button>
))}
```

Ensure `.comment-gutter-marker` styles use `background: var(--author-color)` so the existing dot now colors per author. If the current CSS uses a hard-coded color, update it:

```css
.comment-gutter-marker {
  background: var(--author-color, #facc15);
  color: #fff;
  /* ... existing layout properties unchanged ... */
}
```

- [ ] **Step 4: Run tests**

```bash
npm test -- CommentPopup
npm test -- EditableBlock
```
Expected: any component-level tests still pass. If a snapshot needs updating because of new DOM nodes, update it.

- [ ] **Step 5: Manual smoke test**

In two browsers: create a comment as Alice, another as Bob. Both gutter markers should show distinct colors + initials. Open each popup — each entry should show the correct author chip.

- [ ] **Step 6: Commit**

```bash
git add src/components/CommentPopup.jsx src/components/EditableBlock.jsx src/styles/editor.css
git commit -m "feat(collab): author chips in comment popup + gutter marker"
```

---

## Task 8: Author-colored borders on `<ins>` / `<del>` marks

**Files:**
- Modify: `src/styles/editor.css`

- [ ] **Step 1: Add the author-color CSS**

Append to `src/styles/editor.css`, under the existing revision mark styles:

```css
/*
 * Shared Track Changes — per-author border on ins/del marks. The
 * data-author-color attribute is set by refineWordDiff when an author is
 * passed in (room mode). We use attr() via a CSS custom property defined
 * on the element itself so older browsers that do not support attr() for
 * non-string contexts still fall back to the default ADD/DEL colors.
 */
ins[data-author-color] {
  border-bottom: 2px solid attr(data-author-color color, #16a34a);
  text-decoration: none;
}
del[data-author-color] {
  text-decoration: line-through;
  text-decoration-color: attr(data-author-color color, #dc2626);
  text-decoration-thickness: 2px;
}

/* Fallback for browsers without attr() color support: use the per-element
 * style override we set in the component (see the JSX branch that writes
 * `style={{'--author-color': ...}}` when rendering). */
ins[data-author-color] {
  border-bottom-color: var(--author-color, #16a34a);
}
del[data-author-color] {
  text-decoration-color: var(--author-color, #dc2626);
}
```

The `attr()` color syntax is limited in current browsers, so the `var(--author-color)` fallback is the primary mechanism. `refineWordDiff` only sets the attribute, not the CSS variable, so we need one more small addition...

- [ ] **Step 2: Also write `style="--author-color:..."` in `refineWordDiff`**

Go back to `src/lib/text-diff.js` and update the `authorAttrs` builder from Task 4 to ALSO emit a style attribute:

```javascript
  const authorAttrs = author
    ? ` data-author-id="${escapeHtmlAttr(author.id)}" data-author-name="${escapeHtmlAttr(author.name)}" data-author-color="${escapeHtmlAttr(author.color)}" style="--author-color:${escapeHtmlAttr(author.color)}"`
    : '';
```

- [ ] **Step 3: Update the text-diff test for the inline style**

Update one of the text-diff tests from Task 4 to assert the style attribute is present:

```javascript
  it('emits --author-color CSS variable on ins', () => {
    const html = refineWordDiff('the quick fox', 'the slow fox', { author: ALICE });
    expect(html).toContain('style="--author-color:#7a3"');
  });
```

- [ ] **Step 4: Run tests**

```bash
npm test -- text-diff
```
Expected: all pass including the new style assertion.

- [ ] **Step 5: Manual smoke test**

Two browsers, TC on, each user edits a different block:
- Alice's insertions have a green border (her color)
- Bob's insertions have a blue border (his color)
- Alice's deletions show a strikethrough in her color
- Hover over a mark — it shows the author name via the `data-author-name` attribute (browser title fallback not implemented; this is visual only).

- [ ] **Step 6: Commit**

```bash
git add src/styles/editor.css src/lib/text-diff.js src/lib/__tests__/text-diff.test.js
git commit -m "feat(collab): author-colored borders on shared TC marks"
```

---

## Task 9: Update `CLAUDE.md`

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Remove shared TC / shared Comments from the roadmap**

Find this line in the "Known prototype limitations (roadmap)" section of the "Multi-user collaboration (prototype)" block:

```markdown
- Shared Track Changes — deferred
- Shared Comments — deferred
```

Delete both lines.

- [ ] **Step 2: Update the data model description**

Find the "Data model:" subsection of the "Multi-user collaboration (prototype)" section. Below the existing `yOrder` / `yStore` description, add:

```markdown
- `yTc: Y.Map` — room-wide Track Changes: `{ enabled: boolean, snapshots: Y.Map<blockId, string> }`. When `enabled` flips on, every block's current plaintext is captured into `snapshots` in the same transaction (the baseline everyone diffs against). Flipping off clears `snapshots` in the same transaction. Accept/Reject operations publish a new snapshot for the affected block alongside the html update so remote clients' diffs re-collapse to empty and no phantom marks reappear.
- `yComments: Y.Map<id, Y.Map>` — shared comment metadata. Each comment Y.Map holds scalar fields (`blockId`, `status`, `highlightText`, `createdAt`, `authorId/Name/Color`) plus `entries: Y.Array<Y.Map>` for the thread. Concurrent replies from different clients merge via Y.Array insert semantics — no reply is lost. The `mark-comment` highlight spans still live in block html (synced via `yStore`); `yComments` is the parallel metadata store.
```

- [ ] **Step 3: Update the transaction origin list**

Find any place that mentions `local-publish` / `local-meta` and expand the list to include the two new origins:

```markdown
Transaction origins used by the collab layer: `local-publish` (blocks), `local-meta` (section metadata), `local-tc` (Track Changes), `local-comments` (comment operations), `seed` (initial room population). `handleAfterTx` uses a `startsWith('local-')` prefix check so every local origin is suppressed without an explicit per-origin allowlist.
```

- [ ] **Step 4: Add the new CRDT identity invariants to the existing test list**

Find the `collab.test.js` row in the "Test Coverage" table. Bump its test count (33 → 48) and add the new coverage entries to its "Coverage" cell:

```markdown
| collab.test.js | 48 | Vitest | Y.Doc ↔ blocks conversion (yOrder+yStore model), seeding, in-place updates, structural changes (insert/delete/reorder), two-doc CRDT merge, **Y.Text identity preservation across insert/delete/reorder** including concurrent remote edit across a local reorder, **Y.UndoManager scoped to local origin does not revert remote edits**, **no-op publishes don't grow undo stack (I2)**, **same-tx delete+reinsert in-place (N6)**, **doc size guard (M7)**, **yMeta CRDT merge (M3)**, **shared TC publish/read/two-doc merge**, **shared Comments CRDT (concurrent replies, resolve+reply interleave, delete merge)**, **afterTransaction routes pure-TC transactions to onRemoteTc only** |
```

- [ ] **Step 5: Bump the test-diff row**

Find the `text-diff.test.js` row: 20 → 23.

- [ ] **Step 6: Update the totals**

Find:
```
**Total: 539 Vitest + 99 Node + 141 Playwright = 779 automated tests**
```

Update to:
```
**Total: 557 Vitest + 99 Node + 141 Playwright = 797 automated tests**
```

(18 new: 5 TC + 9 comments + 1 routing + 3 text-diff author = 18. Verify by running `npm test` and checking the summary — if the number drifts adjust to match.)

- [ ] **Step 7: Add Accept/Reject room-wide note**

In the "Track Changes architecture" section, add a new paragraph at the end:

```markdown
**In a room:** TC state is room-wide. The toggle, snapshots, and every inline revision mark are shared across all clients. Author attribution on `<ins>`/`<del>` marks uses `data-author-id`/`data-author-name`/`data-author-color` attributes emitted by `refineWordDiff` when called with an `author` option (identity from `identity.js`). Any participant can accept or reject any mark; the accept/reject path publishes both the html update and the new baseline snapshot so remote clients re-diff to empty and no phantom marks reappear. See `publishTcToDoc` in `src/lib/collab.js`.
```

- [ ] **Step 8: Sanity check**

```bash
npm test
```
Expected: totals match what you put in CLAUDE.md.

- [ ] **Step 9: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(claude-md): shared TC + shared Comments landed; update test counts and roadmap"
```

---

## Self-Review

### 1. Spec coverage

| Spec section | Task(s) |
|---|---|
| `yTc` data model | Task 1 (scaffold) + Task 2 (publish/read/routing) |
| `yComments` data model | Task 1 (types on session) + Task 3 (publish/read/routing) |
| Author attribution on `<ins>`/`<del>` via `data-author-*` | Task 4 (text-diff) + Task 8 (CSS) |
| `publishTc` / `publishComment*` / `deleteComment` session API | Task 2 + Task 3 |
| `onRemoteTc` / `onRemoteComments` callbacks | Task 2 + Task 3 (wiring) + Task 5 (App.jsx consumption) |
| Seeding: first client writes `enabled=false` + empty snapshots + empty comments | Task 1 (yTc seed); yComments auto-seeds as empty (no explicit seed needed, documented in Task 1 comment) |
| `Y.UndoManager` NOT tracking yTc/yComments | Task 1 left UndoManager untouched — implicit non-requirement satisfied |
| App.jsx derives TC/comments from Y.Doc when `inRoom` | Task 5 (TC) + Task 6 (comments) |
| Accept/Reject publishes snapshot alongside html | Task 5 Step 5 (`handleRevisionAction` updated with `tcDirtyRef.current = true`) |
| TC toggle OFF clears snapshots in same tx | Task 2 Step 3 (`publishTcToDoc` caller contract) + Task 5 Step 3 (publish effect passes empty snapshots when disabled) |
| Identity-based chips in comment UI (scope B) | Task 7 |
| Author-colored borders on TC marks | Task 8 |
| 15 new tests in collab.test.js | Task 2 (5 tests + 1 routing) + Task 3 (9 tests) = 15 ✓ |
| Deployment-implications callout | Documented in Task 1 Step 1 JSDoc (prototype limitations) + spec (already written) |
| Non-goals preserved | Sidecar export unchanged, no SGML author field, no per-user unread, no comment undo, no character-level merge — none of the above tasks touch these paths |
| CLAUDE.md updated | Task 9 |

All spec sections mapped to tasks. ✓

### 2. Placeholder scan

Searched for "TBD", "TODO", "implement later", "fill in details", "add appropriate", "handle edge cases". None present. Every step has concrete code or commands. ✓

### 3. Type consistency

- `publishTcToDoc(ydoc, yTc, {enabled, snapshots})` — consistent across Task 2 declaration, Task 5 usage
- `publishCommentToDoc(ydoc, yComments, id, payload)` with `payload.author` / `payload.initialText` — consistent across Task 3 declaration, Task 6 usage
- `session.publishTc` / `publishComment` / `publishCommentReply` / `publishCommentStatus` / `deleteComment` — consistent
- `readTc(yTc)` returns `{ enabled, snapshots }` — matches both `onRemoteTc` callback usage in Task 5 and two-doc merge tests in Task 2
- `readComments(yComments)` returns `{ [id]: {blockId, status, highlightText, createdAt, authorId, authorName, authorColor, entries: [...]} }` — matches `onRemoteComments` usage in Task 5 Step 1 and the comments-map usage in CommentPopup (Task 7)
- `refineWordDiff(old, new, options?)` with `options.author = {id, name, color}` — consistent across Task 4 declaration, test assertions, Task 5 usage
- `tcDirtyRef` / `remoteTcRef` / `commentsDirtyRef` / `remoteCommentsRef` — only declared in Task 5 Step 2; `commentsDirtyRef` is declared but never used because comment publishes happen imperatively in the handlers (Task 6), not via a React effect. That's intentional — remove the unused ref.

Fix: in Task 5 Step 2, remove `commentsDirtyRef` from the ref declarations list — it's unused. Corrected block:

```javascript
  const remoteTcRef = useRef(null);
  const remoteCommentsRef = useRef(null);
  const tcDirtyRef = useRef(false);
```

(Applying that correction now — see below.)
