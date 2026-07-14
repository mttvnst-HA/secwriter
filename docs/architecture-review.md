# Architecture review

Open deepening-candidates backlog from `/improve-codebase-architecture` passes. **This file should be short.** When an entry lands, replace it with a one-line log row that points at the PR — the details belong in `CLAUDE.md`, `CONTEXT.md`, or the commit.

For each open candidate: name the friction, name the shallow seam, sketch a direction. Do **not** propose interfaces here — that's the grilling conversation.

Vocabulary: architecture terms (*module, interface, depth, seam, leverage, locality, deletion test*) are defined in the `improve-codebase-architecture` skill's `LANGUAGE.md`. Domain terms are in [`CONTEXT.md`](../CONTEXT.md).

---

# Open backlog

## 2026-07-07 pass — App orchestrator decomposition (candidate #1)

The 2026-07-07 review surfaced 6 candidates. Five are landed or in-flight (sibling status below); **candidate #1 is the one large open item** — tagged *largest and riskiest*, best attacked incrementally.

**Friction.** `src/App.jsx` is a god-object: 3,418 LOC · 49 useState · 76 useCallback · 24 useEffect · 19 useRef. No action is testable without the whole closure.

**Shallow seam.** Cohesive intents (file I/O, review-panel coordination, editor actions) live inline in one component scope and reach each other through state-mirror refs. Ref audit — corrects the review's headline "19 TDZ refs": **10** are state-mirrors (`blocksRef`, `sectionMetaRef`, `commentsStateRef`, `tcStateRef`, `lintingStateRef`, `focusedBlockIdRef`, `collabReadOnlyRef`, `inRoomRef`, `authHeadersRef`, `toastPushRef`), **8** genuine DOM/session/effect-memory, exactly **1** (`clearHistoryRef`) a literal forward-declaration bridge. The win is "a cluster's mirror refs follow their state into a hook," not "19 refs evaporate."

**Direction.** Lift each intent behind its own hook (mirror `useCollabSession`); App keeps render + prop wiring. Candidates #5 (landed) and #2 (in-flight) were the first two slices. Remaining slices, cleanest-first:
1. **`useFileSession`, output half** — the 7 save/export/download handlers (`App.jsx:545–800`) are pure readers of blocks/meta/comments/currentFile with zero write-back → mechanical ~250-LOC lift, disjoint from #2, parallelizable now.
2. **`useFileSession`, input half** — import/drag-drop + `loadSECContent`/`applyLintSidecarPayload` write editor state (blocks/meta/comments/linting/history/substrate); higher coupling; dissolves the lone `clearHistoryRef` bridge.
3. **`useReviewPanels`** — comments + compliance + lint glue (reducers already in `src/lib/`); absorbs `lastComplianceScrollRef` / `pendingLintSidecarRef` / `prevActiveViewRef`.
4. **editor-actions** — deepest coupling; re-grill after #2 shrinks it (may not earn full extraction).

Gate per slice: behavior-preserving; full unit + `editor.spec.js`/`collab.spec.js` under chromium (Rule #10); verify undo/effect-order against a **production build**, not E2E — StrictMode masks single-invoke bugs (Rule #12).

**Sibling status (2026-07-07 pass):** #2 collapse block pass-throughs — in-flight (separate agent) · #3 one slot-shape discriminator — [PR #283](https://github.com/mttvnst-HA/secwriter/pull/283) · #4 room-deletion transaction seam — landed [#281](https://github.com/mttvnst-HA/secwriter/pull/281) · #5 shared substrate UndoManager factory — landed [#282](https://github.com/mttvnst-HA/secwriter/pull/282) · #6 concentrate revision resolution — speculative, grill the seam before extracting.

---

# Non-candidates (verified, not opportunities today)

- **App.jsx (~2050 LOC):** symptom of #10 (landed) — already absorbed. Not a target.
- **FloatingToolbar (~589 LOC):** deepened in #120 — bottom-heavy (UI state + mark-button iteration), not shallow.
- **`revisions.js` / `revision-resolve` / `pm-tc-mark`:** parsing duplication checked — no overlap. revisions.js operates on HTML strings; pm-tc-mark operates on PM marks. Distinct substrates.
- **server-side:** `GET /rooms` event-loop fix (#112) closed the recent shallow seam. Migration broker already extracts cleanly.
- **PmEditableBlock `dispatchTransaction` extraction (was #9):** grilled 2026-05-19. The four meta-sentinel invariants are already pinned at integration level (`PmEditableBlock-tc-resolve.test.jsx:92-117`, `PmEditableBlock-comment-reconcile.test.jsx:36-99`, `PmEditableBlock-tc-marking.test.jsx:94-190`, `pm-editor-dispatch.test.js:42-101`) — not undertested folklore. Replay-the-last-3-changes test on the 431-531 region: 1 cleaner (#96 TC_RESOLVE_META), 2 wash (1h Q33, 1g) — pure dispatchTransaction edits are 1/3 of changes; the other 2/3 are cross-cutting commits where the dispatchTransaction slice is one of several PmEditableBlock edits. Extraction win is aesthetic only and realizes 1/3 of the time. Not worth the ref-passing risk.
- **`block-registry` flush helpers (was #11):** grilled 2026-05-19. Backlog claimed "three near-identical iterators ~50 LOC + scattered call sites in App.jsx". Actual: 21 LOC across 3 different-shape helpers (single-id flush, single-id cancel, all-id flush), and post-#123 the App.jsx direct call sites are GONE — `flushAllPendingUpdates` now lives behind `dispatchBlocksVerb`'s `opts.preFlush='all'` (2 call sites in `App.jsx`) and `flushPendingUpdateById` / `cancelPendingUpdateById` live behind `dispatchToolbarVerb`'s settlement switch (`pm-toolbar.js:575-579`, 6 self + 1 caller-owned). The "named-intent verb" proposal (`flushForDocWideTcGesture` etc.) re-encodes purpose that already lives in the dispatchers' verb names. M4 regression guard documented centrally in `flushAllPendingUpdates`'s jsdoc (lines 184-189). preFlush is a property of WHEN convergence happens, not WHAT the verb does — pure-state callers (test harnesses using dispatchBlocksVerb directly) have no PM debounces to flush, so coupling preFlush to verb identity would mis-fit them.
- **PM plugin construction (was #12):** grilled 2026-05-19. Backlog claimed "inter-plugin dependencies (slash-menu state read by keymap, word-boundary-undo coordinating with UndoManager) live as implicit ordering." Actual: zero plugin-to-plugin state reads. `keymap.js` re-exports `getSlashMenuState` at line 149 but never imports it as a state read — real coordination is the `cb.isSlashOpen()` callback supplied by PmEditableBlock. word-boundary-undo coordinates with the UndoManager via a `getForceFrame` callback ref, not plugin state. Construction site is 28 LOC (PmEditableBlock.jsx:316-343); a `createPmPluginSet(callbacks)` factory removes those 28 LOC but cannot absorb the 41 LOC of upstream callback assembly (slashCallbacks bag + blockKeymap callback bag) because those are React-ref-shaped. Backlog's own self-assessment ("borderline, does not unlock new tests for any individual plugin") was correct. Ordering invariant (word-boundary BEFORE keymap) already pinned by 5-line inline comment + `word-boundary-undo.test.js`.

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
| 13 | Current-file record (sec.handle + sidecar.handle + fallbackName) — atomic swap on cross-file load | 2026-05-19 | `src/lib/current-file.js` |

Pattern that emerged across #1–#6: a pure reducer `{ state, verbs, selectors, property-tested invariants }`. Used by `track-changes.js`, `comments.js`, `linting.js`, `compliance.js`, and `room-storage.cjs`. Established playbook for new domain modules.

The PM substrate migration (issue #47, sub-PRs 1c..1i-b.2, complete 2026-05-19) is a separate architectural arc captured in [ADR-0006](adr/0006-pm-substrate-migration.md), the PM substrate section of [`CONTEXT.md`](../CONTEXT.md), and `CLAUDE.md`. Net effect on the metrics this backlog measured: App.jsx ~2050 (down from 2852); legacy contentEditable path (`EditableBlock.jsx`, `useBlockBinder.js`, `useUndoableBlocks.js`, `VITE_PM_EDITOR`, `chromium-legacy` Playwright project) retired.

Three "future review" hints surfaced at the end of the substrate work — re-grilled 2026-05-19: (a) useCollabSession refs was the only one that landed (#10 / `session-coordination.js`). (b) `block-registry` flush helpers (was #11) and (c) PM plugin set (was #12) were both rejected post-#123 — the dispatchers (`dispatchBlocksVerb`, `dispatchToolbarVerb`) already concentrate the cohesion the proposals were chasing. PmEditableBlock `dispatchTransaction` (was #9) also rejected — meta-sentinel invariants pinned at integration level, not folklore. See Non-candidates for details.

**Post-#123 audit complete (2026-05-19).** All four backlog candidates surfaced by the post-substrate-migration review have been resolved. Run `/improve-codebase-architecture` to surface new candidates against the current tree.
