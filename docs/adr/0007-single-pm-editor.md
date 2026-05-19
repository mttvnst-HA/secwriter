# ADR-0007: Retire the legacy contentEditable path; SecWriter is a single PM-based editor

**Status:** Accepted
**Date:** 2026-05-18

## Context

Issue [#47](https://github.com/mttvnst-HA/secwriter/issues/47) replaced the snapshot-diff-into-Y.Text substrate with a y-prosemirror character-level binding. The arc landed across sub-PRs 1a..1i-b.2:

1. 1a (#45) — Y.Doc-as-substrate adapter (`block-html-store.js`).
2. 1b (#46, #48) — per-block binder + publish-effect rewire.
3. 1b.1 (#49) — `schemaVersion` gate that refuses any room with `schemaVersion > MAX_SUPPORTED_SCHEMA_VERSION`.
4. 1c (#50) — PM schema (`src/lib/pm-schema.js`) + `pmdoc-html.js` serializer. Pure code, no persisted-state change.
5. 1d (#51) — substrate swap (Y.Text → Y.XmlFragment) + server-side migration broker. See [ADR-0006](0006-pm-substrate-migration.md).
6. 1e (#56) — mount PM `EditorView` per editable block.
7. 1f.5..1f.9 (#62..#66) — PM-aware compliance highlights, new-block focus, test-utils seam, FloatingToolbar PM-transaction conversion.
8. 1g (#69) — comments via PM mark + decoration.
9. 1h (#94..#101) — per-keystroke TC marking, TC reducer shrink to `{ enabled, publishSeq }`, atomic UndoManager pair.
10. 1i-a (#106) — switch CI gate to chromium PM project.
11. 1i-b.1 (#107) — runtime rewire (origin flip, migrationPartial banner, reconcile gate).
12. 1i-b.2 (#109, this ADR) — delete the legacy contentEditable path.

Between 1e and 1i-b.1, both editors coexisted behind a `VITE_PM_EDITOR` build flag. The bridge was load-bearing: PM-mode bugs surfaced during 1f.5..1h could be hot-reverted by flipping the flag without redeploying, and the Playwright suite ran both modes via a `chromium-legacy` project + `forcePmEditor` fixture.

By the end of 1h:

1. Every editor surface (per-block edit, TC, comments, compliance highlights, FloatingToolbar verbs, slash menu, paste, focus, undo) had a PM-mode implementation pinned by tests.
2. The legacy path had no remaining unique behavior — `EditableBlock.jsx` was a thin delegate to `PmEditableBlock` under the flag-on branch, kept alive as a safety net.
3. Maintaining both editors cost real complexity: branching in App's TC publish path, `FloatingToolbar` carrying parallel legacy and PM verb implementations, dual Playwright project runs (chromium + chromium-legacy = ~2x CI time), `getEditorMode()` branches scattered across test files, `forcePmEditor` fixture wiring, `feature-flags.js` module + test, plus the `useBlockBinder.js` and `useUndoableBlocks.js` legacy support modules.
4. The `migrationPartial` banner (1d) made the legacy Y.Text read/write fall-back permanent for blocks the broker couldn't convert. PM blocks and legacy-substrate blocks now coexist *within* a single room — the editor-mode flag was no longer the axis along which "legacy" varied.

The decision is whether to keep the flag (and the parallel implementations it gates) as an emergency revert, or delete it and accept PM as the only editor.

## Decision

Delete the legacy contentEditable path entirely. Concretely:

1. Remove `src/components/EditableBlock.jsx`, `src/components/__tests__/EditableBlock.test.jsx`, `src/components/useBlockBinder.js`, `src/components/__tests__/useBlockBinder.test.jsx`, `src/lib/useUndoableBlocks.js`, `src/lib/feature-flags.js`, `src/lib/__tests__/feature-flags.test.js`.
2. App renders `PmEditableBlock` directly for every editable block; no wrapper or delegate.
3. `FloatingToolbar`'s legacy verb branches are removed; only the PM-transaction verbs remain.
4. Playwright config has a single `chromium` project. The `chromium-legacy` project and the `forcePmEditor` fixture are deleted.
5. Test files that branched on editor mode (`getEditorMode()` from `tests/e2e/pm-helpers.js`) collapse to the PM path; the helper is deleted.
6. The `VITE_PM_EDITOR` environment variable is no longer read anywhere.
7. The migrationPartial banner stays — legacy *substrate* (Y.Text html slots) is separate from the legacy *editor* and still has to be supported per ADR-0006.

The CLAUDE.md banner is updated to record that #47 is closed by sub-PR 1i-b.2 (#109, merged 2026-05-19).

## Consequences

- **Positive:**
  1. **One editor, one set of invariants.** App's TC publish path, FloatingToolbar verbs, comment-mark application, paste handling, focus routing, and undo all branch on substrate (PM EditorView vs raw contentEditable for TitleBlock) rather than on edit mode. The CONTEXT.md anti-glossary records the retired names.
  2. **CI is roughly half the wall time.** Single chromium project replaces chromium + chromium-legacy. The full E2E gate is now `editor.spec.js` + `collab.spec.js` under `--project=chromium` only.
  3. **`useUndoableBlocks` and its snapshot stack are gone.** The atomic UndoManager pair (in-room via `collab.js`, out-of-room via `useLocalSubstrateUndoManager`) is the sole source of truth for undo. The dual-store model that justified `setBlocksDirect` is gone, though the alias is retained at the comment-reconcile seam for naming clarity.
  4. **Test files lose `getEditorMode()` branches** — a class of test maintenance that produced fragile spec files dies.
  5. **Future PM bug fixes don't have to be ported to legacy.** Every PR after #109 can assume PM behavior.
- **Negative / cost:**
  1. **No fast-revert escape hatch.** If a PM substrate regression hits production, the rollback is a git revert + redeploy rather than a flag flip. Mitigation: the chromium gate runs every PR; the documented baseline flakes catalogued in `docs/superpowers/notes/1i-a-pm-failures.md` plus the `--repeat-each=5 --workers=1` re-run protocol distinguish flake from regression before merge.
  2. **`migrationPartial` rooms still hit the Y.Text read path.** Editor mode is unified, but substrate is not — `block-html-store.js`'s read path retains the `yTextToHtml` fallback, and `yMapToBlock` still branches on duck-type during `.SEC` flush. Those branches are pinned by ADR-0006, not by editor mode, and stay.
  3. **One coverage hole was accepted at merge.** A legacy-only comment-attribute test deleted in #109 has no direct ref/table-block analog; the loss is flagged in `tests/e2e/editor.spec.js` for follow-up.
  4. **A spawn-from-#109 follow-up surfaced** the `countRevisions` chg-regex gap (`src/lib/revisions.js` was missing `[^>]*` between `class="mark-chg"` and `>`, so attributed chgs went uncounted). Fixed in commit f1f896d, pinned by a regression test. The deletion sweep made the existing add/del regexes' attr-awareness load-bearing; the chg case was the same bug shape, latent until then.
- **Re-litigation risk:**
  1. **"Should we keep the flag for emergency revert?"** No. The flag's value was bounded to the 1c..1h migration window. Post-1i-b.2, flipping it back would re-introduce four months of bug fixes that exist only in the PM path (TC per-keystroke marking, comment reconcile via PM mark, FloatingToolbar PM verbs, atomic UndoManager). The flag would not produce a working editor — it would produce a regression cliff.
  2. **"Should we keep `useUndoableBlocks` as a fallback if the UndoManager pair has a bug?"** No. The two systems disagree on framing semantics (snapshot stack groups by setBlocks call; UndoManager groups by `captureTimeout` + `forceFrame`). Routing one path through one and the other through the other is how the dual-store ghost-comment-span class of bug surfaced. The integration test `src/lib/__tests__/word-boundary-undo.test.js` ("hello world. → 3 frames") pins the UndoManager configuration.

## Alternatives considered

1. **Keep the flag indefinitely as an escape hatch.** Rejected per the re-litigation analysis above — the flag would not produce a working editor after 1h, only a regression cliff. The maintenance cost of keeping the legacy code paths alive (FloatingToolbar dual-verbs, dual playwright projects, `getEditorMode()` branches in every spec file) is real and ongoing.
2. **Delete the flag and the bridge code but keep `EditableBlock.jsx` as a degenerate wrapper.** Rejected — the wrapper became a one-liner delegate and added a name (`EditableBlock`) that future readers would look up before realizing it's a pass-through. Deleting the file means new contributors find `PmEditableBlock` directly.
3. **Defer the deletion to a separate post-#109 PR.** Rejected — #109's scope already touches every file the legacy path lives in. Splitting the deletion across two PRs would mean the second PR has near-zero substantive change and the first ships dead code.

## When to revisit

1. **PM substrate has to be replaced wholesale.** If y-prosemirror or PM upstream releases a breaking change that can't be absorbed by the pinned 1.x adapter and the migration cost exceeds the cost of writing a new editor, the single-editor decision blocks an incremental fallback. At that point a *new* editor would land behind a fresh flag and we would repeat the 1c..1i-b.2 arc against PM (instead of against contentEditable).
2. **An unfixable PM-only regression ships to production.** If the documented baseline flakes + isolated re-run protocol fails to catch a class of regression and the cost of a git-revert deployment exceeds the cost of restoring the flag, the decision should be re-evaluated. As of this ADR there is no observed case.
3. **The `migrationPartial` substrate-fallback is itself retired.** If every production room has been confirmed to be schemaVersion=2 (no remaining `migrationPartial`), the Y.Text fallback in `block-html-store.js` and `yMapToBlock` can be deleted; that simplification is gated on the v2 migration being demonstrably complete, not on this ADR.
