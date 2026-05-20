# Architecture review

Open deepening-candidates backlog from `/improve-codebase-architecture` passes. **This file should be short.** When an entry lands, replace it with a one-line log row that points at the PR — the details belong in `CLAUDE.md`, `CONTEXT.md`, or the commit.

For each open candidate: name the friction, name the shallow seam, sketch a direction. Do **not** propose interfaces here — that's the grilling conversation.

Vocabulary: architecture terms (*module, interface, depth, seam, leverage, locality, deletion test*) are defined in the `improve-codebase-architecture` skill's `LANGUAGE.md`. Domain terms are in [`CONTEXT.md`](../CONTEXT.md).

---

# Open backlog

## 9. `PmEditableBlock`: view-mount tangled with per-keystroke verb rewriting

**Files:** `src/components/PmEditableBlock.jsx` (~980 LOC)

**Friction:** Three concerns glued in one component: (a) `EditorView` lifecycle (mount, ySyncPlugin bind, handle register, unmount), (b) `dispatchTransaction` interceptor (TC rewrite via `rewriteForTrackChanges`, `TC_RESOLVE_META` skip, `COMMENT_RECONCILE_META` skip, synthesized `'input'` for linter, debounce settle, `onUpdate` echo gating), (c) prop wiring (paste sanitizer, click → del-popup dispatch, auto-focus for `isNew`). The verb-rewrite logic (b) lives mid-component; invariants like "TC_RESOLVE_META skips rewriter only, not linter or onUpdate" are inferred from CLAUDE.md item 7, not enforced by a module.

**Why shallow:** the interceptor reads as inline component code, but its real interface is "given a tr, decide which side effects fire" — a non-trivial state machine over PM-meta keys. Interface (a function reference) is dramatically smaller than implementation (~200 LOC of branching).

**Deletion test:** extract (b) into `pmEditorInterceptors`. PmEditableBlock shrinks to ~300 LOC mount wrapper; the four "load-bearing meta sentinel" facts become unit-tested invariants instead of comment lore.

**Sketch:** a `dispatchTransaction` factory `(callbacks, metaHandlers) → tr => void` that owns the verb rewrite layer; PmEditableBlock owns mount/unmount only.

---

## 11. `block-registry` flush helpers — mechanical iterators, scattered call-site reasoning

**Files:** `src/lib/block-registry.js` lines ~157–199 (`flushPendingUpdateById`, `flushAllPendingUpdates`, `cancelPendingUpdateById`); call sites in App.jsx (`handleAcceptAll` / `handleRejectAll`), FloatingToolbar via `dispatchToolbarVerb`, inline-TC accept

**Friction:** Three near-identical iterators (~50 LOC of duplicated handle iteration + try/catch). The *why* — M4 regression guard ("doc-wide TC gestures must flush the 400ms PM debounce first or accept-all silently no-ops"), toolbar settle, inline-TC cancel — lives at call sites as comments + CLAUDE.md TC item 9. Helpers are mechanical; cohesion is invisible.

**Why shallow:** three method names for what is really one "flush coordinator for DOM-bridge gestures"; load-bearing reason for each call lives outside the module.

**Deletion test:** concentrates. A `flushCoordinator` module that names each call-site purpose as a verb (`flushForDocWideTcGesture`, `flushAfterToolbarDispatch`, `cancelForInlineTcAcceptSettlement`) pins the M4 regression as a structural feature instead of comment lore.

**Sketch:** replace the three mechanical helpers with named-intent verbs; originals become private impl.

---

## 12. PM plugin construction scattered across `PmEditableBlock` — no single seam

**Files:** `src/lib/pm-plugins/*` (slash-menu, tag-labels, keymap, relpos-selection, active-comment, word-boundary-undo) + construction site in `PmEditableBlock.jsx`

**Friction:** Six plugins constructed inline at `EditorView` setup. Inter-plugin dependencies (slash-menu state read by keymap, word-boundary-undo coordinating with the UndoManager pair) live as implicit ordering. Adding a new plugin requires editing `PmEditableBlock`. Looks pluggable, isn't.

**Why shallow:** appearance of a plugin seam without the substance (no single place to register, configure, or test the set together).

**Deletion test:** borderline. `createPmPluginSet(callbacks)` gives one testable seam (assert order + callback wiring) but does not unlock new tests for any individual plugin. Lower-priority than #9–#11.

**Sketch:** plugin-set factory, callbacks-in / plugin-array-out, ordering and inter-plugin deps documented in one place.

---

# Non-candidates (verified, not opportunities today)

- **App.jsx (~2050 LOC):** symptom of #9 + #10 + #11, not a target. Land those, App drops ~200 LOC.
- **FloatingToolbar (~589 LOC):** deepened in #120 — bottom-heavy (UI state + mark-button iteration), not shallow.
- **`revisions.js` / `revision-resolve` / `pm-tc-mark`:** parsing duplication checked — no overlap. revisions.js operates on HTML strings; pm-tc-mark operates on PM marks. Distinct substrates.
- **server-side:** `GET /rooms` event-loop fix (#112) closed the recent shallow seam. Migration broker already extracts cleanly.

---

# Landed log

| # | Title | Landed | Module / ADR |
|---|---|---|---|
| 1 | Track-changes snapshot Map across six call sites | 2026-05-02 | `src/lib/track-changes.js` |
| 2 | Comments as parallel store glued by 10 handlers | 2026-05-02 | `src/lib/comments.js` |
| 3 | Three linting tiers scattered across App + EditableBlock | #35 | `src/lib/linting.js`, `useBlockLinting.js` |
| 4 | CompliancePanel half-UI half-domain | 2026-05-02 | `src/lib/compliance.js`, `compliance-highlight.js` |
| 5 | Collab publish-path coordination inlined in App | 2026-05-02 | `src/hooks/useCollabSession.js`, satisfies ADR-0004 §3 |
| 6 | Storage backends — three near-identical atomicity loops | 2026-05-02 | `server/room-storage.cjs`, ADR-0005 |
| 7 | FloatingToolbar PM-verb dispatch protocol | #120 | `dispatchToolbarVerb` in `src/lib/pm-toolbar.js` |
| 8 | Blocks reducer + dispatcher | #123 | `src/lib/blocks.js` |
| 10 | `useCollabSession` coordination refs as pure reducer | 2026-05-19 | `src/lib/session-coordination.js` |

Pattern that emerged across #1–#6: a pure reducer `{ state, verbs, selectors, property-tested invariants }`. Used by `track-changes.js`, `comments.js`, `linting.js`, `compliance.js`, and `room-storage.cjs`. Established playbook for new domain modules.

The PM substrate migration (issue #47, sub-PRs 1c..1i-b.2, complete 2026-05-19) is a separate architectural arc captured in [ADR-0006](adr/0006-pm-substrate-migration.md), the PM substrate section of [`CONTEXT.md`](../CONTEXT.md), and `CLAUDE.md`. Net effect on the metrics this backlog measured: App.jsx ~2050 (down from 2852); legacy contentEditable path (`EditableBlock.jsx`, `useBlockBinder.js`, `useUndoableBlocks.js`, `VITE_PM_EDITOR`, `chromium-legacy` Playwright project) retired.

Three "future review" hints surfaced at the end of the substrate work — verified by the 2026-05-19 pass: (a) PM plugin set vs App keymap = fading, folded into #12; (b) block-registry flush helpers = real, #11; (c) useCollabSession refs = real, #10.
