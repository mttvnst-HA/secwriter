# Architecture review — 2026-05-01

A snapshot of architectural deepening opportunities surfaced by the `improve-codebase-architecture` skill. Each entry names a place where the current design is shallow (interface nearly as complex as the implementation, or coordination logic spread across many call sites) and sketches what deepening would look like — without proposing the interface yet.

This file is a **backlog**, not a plan. Pick one, drop into a grilling conversation, and either:

- Land the deepening (close the entry here, reference the PR).
- Reject it with a load-bearing reason (close the entry, write an ADR in `docs/adr/` so it doesn't get re-suggested).
- Defer it (leave it open, optionally add a "when-to-revisit" condition).

Architecture vocabulary used below — *module, interface, depth, seam, leverage, locality, deletion test* — is defined in the `improve-codebase-architecture` skill's `LANGUAGE.md`. Domain vocabulary — *block, transparent tag, TC snapshot, publish path, etc.* — is defined in [`CONTEXT.md`](../CONTEXT.md).

**Status (2026-05-02): all six numbered entries have landed.** Each became its own pure-reducer / hook / adapter module with property-tested invariants. App.jsx shrank from ~2850 lines to ~2470. The pure-reducer pattern (`{ state, verbs, selectors, property-tested invariant }`) is now the established playbook for new domain modules in this codebase — see `track-changes.js`, `comments.js`, `linting.js`, `compliance.js`, and `room-storage.cjs`.

---

## 1. Track-changes snapshot lives as a Map across six unrelated call sites

**Status:** Landed — `src/lib/track-changes.js` is now a pure reducer over `{ enabled, snapshots, publishSeq }`. App dispatches verbs (`enable / disable / acceptInline / rejectInline / acceptAll / rejectAll / markBlockCreated / applyResolveAtBlock / applyRemote`) and reads selectors (`isEnabled / getSnapshot / getPublishableState / revisionFlagForCreate / revisionFlagForDelete`). `tcDirtyRef` and the eight ad-hoc `setTcSnapshots(...)` sites are gone; the publish effect gates on `publishSeq` instead. Property test asserts the `snapshot[id] === visibleText(html)` invariant.

**Files:** `src/App.jsx:115,834,1133,1192,1393,1553,2311,2623`, `src/components/EditableBlock.jsx:62`, `src/components/FloatingToolbar.jsx`, `src/lib/useUndoableBlocks.js`

**Friction:** `tcSnapshots` is a `Map<blockId, plainText>` in App state. Every mutation that changes a block's text must also update the snapshot, or phantom revisions reappear next blur. The `CLAUDE.md` "Track Changes Architecture" section has a warning to that effect — a sign the invariant lives in the maintainer's head, not the code. Two parallel callbacks (`onUpdate` vs `onRevisionAction`) exist solely to encode "did this mutation also update the snapshot?"

**Why shallow:** the interface (a Map and a setter) is exactly as complex as the implementation. There's no module enforcing the invariant `snapshot[id] === getVisibleText(blocks[id].html)` after every accept/reject/blur. The dual-callback split is leakage of an internal coordination concern.

**Deletion test:** delete the Map and the dual callbacks. Complexity *concentrates* — the diff/accept/reject logic gathers into one place that owns "what did this block say when TC turned on, and what's the next legal mutation?" Locality wins.

**Sketch:** a track-changes module that holds the baseline state privately and exposes "apply this user action" verbs (accept inline del, accept all, blur-diff). App stops knowing about snapshots; revision marks become a derived view, not a side-channel of mutations.

**Tests improve:** today this is largely E2E because the Map is hidden in component state. A module makes the invariant property-testable: every action returns a `(blocks, snapshots)` pair that round-trips.

---

## 2. Comments are a parallel store glued to DOM spans by 10 handlers

**Status:** Landed — `src/lib/comments.js` is now a pure reducer over `{ byId: Map<commentId, Comment>, seenRemoteIds: Set<commentId> }`. App dispatches verbs (`createDraft / updateCreate / reply / resolve / reopen / remove / mergeRemote`) and reads selectors (`size / get / all / isDraft / getCreateEntry / reconcileBlocks / normalizeForLoad`). The 10 hand-coordinated comment handlers collapsed into 7 dispatcher sites; `dispatchComment(envelope)` is the single seam to collab. Span↔metadata sync is `useEffect([blocks, commentsState])` → `cm.reconcileBlocks` (idempotent selector, routed through `setBlocksDirect` so it does not pollute undo). `mergeRemote` (M2.5) preserves local drafts and tombstones peer-deletions; `orphan-comment-spans.js` is deleted along with its test, and the latent ghost-span pathology is now a unit test (`comments-merge.test.js`) instead of a collab E2E.

**Files:** `src/lib/comments.js` (new), `src/lib/__tests__/comments.test.js` (new — 32 tests), `src/lib/__tests__/comments-merge.test.js` (new — 17 tests), `src/App.jsx`, `src/components/CommentPopup.jsx`, `src/styles/editor.css`, `src/lib/collab.js`, `src/lib/useUndoableBlocks.js` (added `setBlocksDirect`)

---

## 3. Three linting tiers + a suppression rule scattered across App, EditableBlock, and module globals

**Status:** Open

**Files:** `src/App.jsx:146,1211,2197,2659`, `src/components/EditableBlock.jsx:62,6`, `src/lib/inline-linter.js:26–76`, `src/lib/grammar-checker.js`, `src/lib/nlp-rules.js`, `src/lib/compliance-rules.js`

**Friction:** to know whether a block will lint, you need three facts in three files: `inlineLintingEnabled` (App state, prop-drilled), `compliancePanelActive` (App state, prop-drilled, used to *suspend* linting), and per-engine readiness (lazy-loaded module globals in `inline-linter.js`). Findings live in three module-global Maps. The "static rules win on overlap" de-dup rule and the "deferred to panel" filter both live inside `inline-linter.js` but the gating policy lives in EditableBlock.

**Why shallow:** the inline-linter module is a bag-of-functions, not a seam. Its caller (EditableBlock) knows internal facts (which Maps to clear, when to suppress). Hiding state in module globals while exposing the gate to callers is the worst of both — global mutable state with no central invariant.

**Deletion test:** moving gating, readiness, and finding-storage behind one module's interface concentrates ~6 coordinated mutations into one place. The CompliancePanel suppression becomes a single method call instead of a prop wired through two components.

**Sketch:** a linting module that owns the three tiers' state, exposes a single "lint this focused block under these conditions" verb, and surfaces readiness as one boolean.

**Tests improve:** today `inline-linter.test.js` exists but most behavior is exercised through EditableBlock's lifecycle. A module makes the de-dup and deferral rules table-testable.

---

## 4. CompliancePanel is half UI, half compliance domain

**Status:** Landed — `src/lib/compliance.js` is a pure reducer over `{ scope, status, result, decisions, activeGroup, ai }` per ADR-0005. App owns the state (TC/comments/linting parity); the panel reads via selectors and dispatches verbs (`setScope / startCheck / setResult / acceptGroup / rejectGroup / acceptItem / rejectItem / markGroupsAccepted / setActiveGroup` plus the AI lifecycle: `aiStart / aiProgress / aiSuccess / aiError / aiAbort / aiClearError`). `compliance-highlight.js` owns the `.compliance-highlight` DOM mutation as a single App-level effect, matching linting's `CSS.highlights` pattern. Pure fix-computation helpers (`computeItemFix / computeGroupFixes / computeFormattingFixes`) extracted from the panel's accept handlers — testable without rendering React. The panel kept only true UI state (filter tab, accordion expand, "Why?" toggle, onboarding flag, settings modal flag) and the `AbortController` ref. Local-only — no `publish` envelopes; the local edits from accepting fixes flow through the existing `setBlocks` path. Five property-tested invariants assert: I1 `setResult` clears decisions and `activeGroup`; I2/I3 decisions ⊆ result keys under random verb sequences; I4 `activeGroup` ∈ result keys ∪ {null}; I5 AI status stays in `{idle, running, error}` and `sessionTokens` is monotone non-decreasing.

**Files:** `src/lib/compliance.js` (new — 454 lines), `src/lib/compliance-highlight.js` (new — 159 lines), `src/lib/__tests__/compliance.test.js` (new — 59 tests including 3 property tests), `src/lib/__tests__/compliance-highlight.test.js` (new — 20 tests), `src/App.jsx`, `src/components/CompliancePanel.jsx` (948 → 769 lines).

---

## 5. Collab publish path: known debt (issue #22), but a smaller win is hoistable now

**Status:** Landed — `src/hooks/useCollabSession.js` owns the session lifecycle (createCollabSession + teardown + DEV `window.__collab` exposure), the four publish effects (blocks, meta, TC, comments dispatch), all coordination refs (`sessionReadyRef`, `metaReadyRef`, `lastRemoteBlocksRef`, `lastPublishedTcSeqRef`, `publishDisabledRef`), the doc-size-cap latch + toasts, and the cursor broadcast. App passes a prop bag of remote-event callbacks (`onBlocksReceived`, `onMetaReceived`, `onTcReceived`, `onCommentsReceived`, `onPresenceChange`, `onStatusChange`) and reads back `{ dispatchComment, markTcSeqApplied, tryUndo, tryRedo, canUndo, canRedo }`. The TC echo gate is a tiny protocol seam: App's `setTcState` updater calls `markTcSeqApplied(next.publishSeq)` after `tc.applyRemote(...)` so the publish effect treats the new state as already-seen by peers. App.jsx 2654 → 2469 lines (-185); hook is 430 lines; 17 unit tests with a fake session replace the previously E2E-only coverage of echo guards, ready gates, seq gating, and the size-cap latch. ADR-0004 "When to revisit" §3 is now satisfied — issue #22 lands by editing the hook's body, not App.

**Files:** `src/hooks/useCollabSession.js` (new — 430 lines), `src/hooks/__tests__/useCollabSession.test.jsx` (new — 17 tests), `src/App.jsx` (2654 → 2469 lines), `docs/adr/0004-collab-publish-snapshot-diff.md` (When-to-revisit §3 marked landed).

---

## 6. Storage backends: three near-identical 80-line atomicity loops

**Status:** Landed — `server/room-storage.cjs` is now a `RoomStorageBase` class that owns the public methodset (`writeRoom / readRoom / deleteRoom / listRooms / statRoom / quarantineRoom / archiveRoom / restoreRoom / listArchivedRooms / deleteArchivedRoom`) by composing seven adapter primitives (`_putBytes / _getBytes / _deleteKey / _listKeys / _statKey / _copyKey / _keyForArtifact`) plus three name-parsing hooks. `server/storage-shared.cjs` owns `sanitize()` (was triple-copied with an apologetic comment) and `ARTIFACT_CATALOG` (was hard-coded across every method of every backend). Adding a fourth artifact is now a one-line catalog edit. Each backend shrank to a thin adapter; Local overrides `writeRoom` to keep its stage-rename-rollback atomicity; Azure overrides it to keep the `.ydoc` blob lease. ADR-0005 captures why atomicity is per-backend (Local has filesystem rename, Azure has leases, S3 has nothing — the honest cross-backend contract is `.ydoc`-LAST write ordering, not multi-artifact atomicity). New `server/__tests__/storage-contract.test.mjs` runs 12 contract assertions × 3 backends (36 tests). Two latent bugs surfaced and fixed during unification: S3 `listArchivedRooms` returned `{ name, archivedAt }` while collab-server's sweep used `room.id` (S3 sweep was silently a no-op); Azure stored `archivedat` metadata as `Date.now()` (numeric string) which `new Date(...)` returns Invalid Date for, so the Azure sweep never deleted archived rooms either. Both backends now return uniform `{ id, archivedAt }` with ISO-8601 timestamps.

**Files:** `server/storage-shared.cjs` (new), `server/room-storage.cjs` (new), `server/storage-local.cjs`, `server/storage-azure.cjs`, `server/storage-s3.cjs`, `server/__tests__/storage-contract.test.mjs` (new — 36 tests across 3 backends), `docs/adr/0005-storage-adapter-atomicity-per-backend.md` (new)

---

## Honorable mentions (not candidates)

- **App.jsx (2852 lines, ~50 callbacks):** size is a *symptom* of the missing domain seams in #1–#5, not a candidate of its own. If we deepen TC, comments, linting, compliance, and publish, App.jsx ends up around 1000–1200 lines without targeting it directly.
- **`src/lib/compliance-diff.js`:** verified — only referenced by itself and `COMPLIANCE.md`. This is dead code, not architecture; just delete it (separate task).
