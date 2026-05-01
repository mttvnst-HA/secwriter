# Architecture review — 2026-05-01

A snapshot of architectural deepening opportunities surfaced by the `improve-codebase-architecture` skill. Each entry names a place where the current design is shallow (interface nearly as complex as the implementation, or coordination logic spread across many call sites) and sketches what deepening would look like — without proposing the interface yet.

This file is a **backlog**, not a plan. Pick one, drop into a grilling conversation, and either:

- Land the deepening (close the entry here, reference the PR).
- Reject it with a load-bearing reason (close the entry, write an ADR in `docs/adr/` so it doesn't get re-suggested).
- Defer it (leave it open, optionally add a "when-to-revisit" condition).

Architecture vocabulary used below — *module, interface, depth, seam, leverage, locality, deletion test* — is defined in the `improve-codebase-architecture` skill's `LANGUAGE.md`. Domain vocabulary — *block, transparent tag, TC snapshot, publish path, etc.* — is defined in [`CONTEXT.md`](../CONTEXT.md).

---

## 1. Track-changes snapshot lives as a Map across six unrelated call sites

**Status:** Open

**Files:** `src/App.jsx:115,834,1133,1192,1393,1553,2311,2623`, `src/components/EditableBlock.jsx:62`, `src/components/FloatingToolbar.jsx`, `src/lib/useUndoableBlocks.js`

**Friction:** `tcSnapshots` is a `Map<blockId, plainText>` in App state. Every mutation that changes a block's text must also update the snapshot, or phantom revisions reappear next blur. The `CLAUDE.md` "Track Changes Architecture" section has a warning to that effect — a sign the invariant lives in the maintainer's head, not the code. Two parallel callbacks (`onUpdate` vs `onRevisionAction`) exist solely to encode "did this mutation also update the snapshot?"

**Why shallow:** the interface (a Map and a setter) is exactly as complex as the implementation. There's no module enforcing the invariant `snapshot[id] === getVisibleText(blocks[id].html)` after every accept/reject/blur. The dual-callback split is leakage of an internal coordination concern.

**Deletion test:** delete the Map and the dual callbacks. Complexity *concentrates* — the diff/accept/reject logic gathers into one place that owns "what did this block say when TC turned on, and what's the next legal mutation?" Locality wins.

**Sketch:** a track-changes module that holds the baseline state privately and exposes "apply this user action" verbs (accept inline del, accept all, blur-diff). App stops knowing about snapshots; revision marks become a derived view, not a side-channel of mutations.

**Tests improve:** today this is largely E2E because the Map is hidden in component state. A module makes the invariant property-testable: every action returns a `(blocks, snapshots)` pair that round-trips.

---

## 2. Comments are a parallel store glued to DOM spans by 10 handlers

**Status:** Open

**Files:** `src/App.jsx:138,567–819` (10 comment handlers), `src/components/CommentPopup.jsx`, `src/components/EditableBlock.jsx`, `src/lib/orphan-comment-spans.js`

**Friction:** comments are dual-tracked — `<span class="mark-comment" data-comment-id>` in the DOM, metadata in a `Map` in App state. Each of 10 handlers (`handleCommentCreate`, `Reply`, `Resolve`, `Delete`, …) must keep span-class and metadata-status in lock-step by hand. The `orphan-comment-spans` module exists *only* because that hand-coordination occasionally fails on collab sync. Editable-block comments persist in `block.html`; ref/table comments live only in injected DOM. That divergence isn't documented in the data model.

**Why shallow:** there is no "comment" concept in the code — only a Map plus a CSS class plus ten orchestration handlers. The interface is the union of all ten handlers' implicit contracts.

**Deletion test:** if a comments module owned the span ↔ metadata binding, drift becomes impossible by construction. Orphan cleanup becomes a property of `merge(remote, local)` rather than a band-aid module.

**Sketch:** comment identity, span-class derivation, and remote-merge live in one module. App keeps UI state (which popup is open) and calls verbs.

**Tests improve:** the orphan-span pathology becomes a unit test instead of a collab E2E.

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

**Status:** Open

**Files:** `src/components/CompliancePanel.jsx` (948 lines), `src/lib/compliance-checker.js`, `src/lib/compliance-rules.js`, `src/lib/compliance-ai.js`

**Friction:** the panel owns 9+ pieces of state (result, filter, activeGroup, expandedGroups, expandedWhy, acceptedGroups, rejectedItems, aiLoading, aiError, sessionTokens) AND imperative DOM mutation (`applyHighlights` / `clearHighlights` walk the editor DOM and inject `.compliance-highlight` spans). It also orchestrates the AI tier directly. The three documented tiers (static / Harper / NLP) are not actually composed at one seam — only the static tier flows through the panel; grammar+NLP run separately in inline linting.

**Why shallow:** the "panel" concept conflates display state, finding-derivation cache, DOM highlighting, and AI orchestration. None of those pieces are reusable; each is implicitly coupled to the panel's render lifecycle.

**Deletion test:** delete the panel's highlight/AI/finding code, push it behind a compliance module — what's left is a pure UI shell. The leverage shows up the moment another caller (e.g. an "explain this finding" inline tooltip on a single block) wants the same machinery.

**Sketch:** compliance domain owns "run", "groupings", "highlight spec", and "AI rewrite". The panel renders state and dispatches user actions.

**Tests improve:** finding grouping and highlight-span generation become pure-function tests rather than React-Testing-Library DOM walks.

---

## 5. Collab publish path: known debt (issue #22), but a smaller win is hoistable now

**Status:** Open. See [ADR-0004](adr/0004-collab-publish-snapshot-diff.md) for the deferred full refactor.

**Files:** `src/App.jsx:1545–1560` (publish effect), `src/lib/collab.js:538–584,813`, `src/lib/ytext-html.js:586–700`

**Friction:** `CLAUDE.md` already flags this — block content reaches Y.Doc by string-diffing HTML against existing Y.Text inside `applyHtmlToYText`, not via a live `Y.Text` ↔ DOM binding. Issue #22 is the long-term fix. Independently of that fix, the *publish coordination* (`lastRemoteBlocksRef` guard, debounce, `DocSizeLimitError` handling, `sessionReadyRef`) is inlined in App.jsx, untestable without mocking Yjs, and re-litigated whenever someone touches the effect.

**Why shallow now:** the publish seam looks like a function call but the caller has to know about the remote-echo guard, the ready ref, and the error type. That's a leaky seam, not a deep one.

**Deletion test:** extracting just the *coordination* (not the diff) into a hook leaves the issue-#22 refactor easier — the Y.Text binding has a single, isolated home to land in. Without this, #22 will need to disturb App.jsx.

**Sketch:** a collab-publish hook that owns the guard ref and the error path. App calls one verb. Issue #22 lands by changing the hook's body, not by editing 40 places in App.

---

## 6. Storage backends: three near-identical 80-line atomicity loops

**Status:** Open

**Files:** `server/collab-server.cjs:450–520`, `server/storage-local.cjs`, `server/storage-azure.cjs`, `server/storage-s3.cjs`, `server/room-serializer.cjs`

**Friction:** all three backends repeat the same atomic-multi-artifact-write pattern (stage, rename in order, rollback on failure), each ~80 lines. Each backend hard-codes the artifact names (`.ydoc`, `.SEC`, `.comments.json`). The collab server itself knows that "persist a room" means "extract three artifacts via room-serializer, then call writeRoom on the chosen backend" — that's not the storage layer's interface, it's the caller assembling the contract.

**Why shallow:** the interface (`writeRoom({ ydocBytes, secBytes, commentsJson })`) is barely smaller than the implementation. Adding a fourth artifact (e.g. a `.tailoring.json` sidecar) requires editing all three backends *and* the caller. That's not a seam; that's three parallel implementations sharing a struct.

**Deletion test:** lifting "atomic multi-artifact write" into a shared helper, and lifting "what does a persisted room look like" into one place, makes adding/removing artifacts a one-file change. Each backend shrinks to a thin "where to put bytes" adapter.

**Sketch:** generic atomic-write helper at the storage layer; "room persistence" verb at the caller layer. Today's three-artifact bundle becomes one configuration point.

**Tests improve:** atomicity property tests (interrupt at each step, verify rollback) become engine-agnostic — they run against the local backend and the contract holds for the others.

---

## Honorable mentions (not candidates)

- **App.jsx (2852 lines, ~50 callbacks):** size is a *symptom* of the missing domain seams in #1–#5, not a candidate of its own. If we deepen TC, comments, linting, compliance, and publish, App.jsx ends up around 1000–1200 lines without targeting it directly.
- **`src/lib/compliance-diff.js`:** verified — only referenced by itself and `COMPLIANCE.md`. This is dead code, not architecture; just delete it (separate task).
