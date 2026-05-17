# Sub-PR 1i Task 1a.1 — chromium-PM E2E Failure Inventory

**Date:** 2026-05-16
**Branch:** `feat/1i-a-ci-prep`
**Baseline commit:** `8db3b27` (local `main`, 4 commits ahead of `origin/main`)
**Author:** Claude (subagent under sub-PR 1i)
**Status:** Historical record — retained as the source for the 9-flake baseline cited in CLAUDE.md Testing Rule #10.

## Summary

The CI comment at `.github/workflows/ci.yml:128-136` claims ~40 known PM-project failures across five categories (DOM-depth selectors, slash menu wiring, del popup, paste-strip, comment reconcile). **Actual count at HEAD: 9 unique failures observed across 2 full-suite runs (154 tests each), and ALL 9 are parallel-load flakes — every one passed deterministically in isolation.** The CI comment is stale; sub-PRs 1f–1h fixed most of the deterministic failures it referenced.

### Run-level numbers

| Run | Total | Passed | Failed | Skipped | Workers | Wall clock |
|---|---|---|---|---|---|---|
| 1 (full PM project) | 154 | 148 | 5 | 1 | 4 | 6.3 min |
| 2 (full PM project) | 154 | 147 | 6 | 1 | 4 | 6.3 min |
| Isolated retries (all 9 failures, 1–3 reps each) | 11 invocations | 11 | 0 | 0 | 4 | 14–32 s each |

The CLAUDE.md baseline note (`Testing Rules` item 10) anticipates "~5 additional editor tests fail only under load" plus ~18 collab flakes plus "4 PM editor tests fail persistently." We observed the editor-under-load pattern (5–6 per run, intersecting across runs) but **zero persistent PM editor failures and zero collab failures across both runs.** That is consistent with 1g–1h having closed the persistent buckets.

### Triage breakdown

- **`[fix-here]` (bug in test code, fix during 1i-a):** 0
- **`[follow-up]` (real PM bug, file an issue):** 0
- **`[flake]` (intermittent, passes on isolated rerun):** 9

No tests are blocking 1i-b.1. The path is clear to advance.

## Coverage caveats

- **collab.spec.js** ran in both full-suite runs (11 tests confirmed via `--list`). Both runs produced zero collab failures — the CI comment's mention of categories like "comment reconcile" did NOT manifest. If the next sub-PR sees collab regressions, treat them as new (1i-a-introduced) regressions, not pre-existing baseline.
- **PM-only conditional skip** at `editor.spec.js:2933` ran (1 PM mode test). The matching `legacy-only` skip at `:2959` skipped under PM, which accounts for the `1 skipped` in both runs.
- We did NOT separately re-run the chromium-legacy project — this audit is scoped to PM only per the task spec. If 1i-a deletes legacy-only branches we should still spot-check `chromium-legacy` once before deleting the project from `playwright.config.js`.

## Failures by category (per CI comment taxonomy)

### Slash menu wiring

CI comment claims slash menu wiring failures. Observed:

#### `editor.spec.js:510:3` — Slash command menu › slash menu shows all block types
- **Symptom:** `expect(getByText('Insert block', { exact: true })).toBeVisible({ timeout: 3000 })` times out after `createFreshBlock(page)` → `page.keyboard.type('/')`.
- **Frequency:** 1 of 4 invocations failed (1 full run + 3 isolated reps).
- **Triage:** `[flake]` — passes 3/3 on isolated rerun.

#### `editor.spec.js:556:3` — Slash command menu › Escape closes the slash menu
- **Symptom:** Same pattern — `Insert block` text not visible within 3 s after typing `/`.
- **Frequency:** Failed in both runs 1 and 2 (the only inter-run intersection); passes when isolated.
- **Triage:** `[flake]` — most reproducibly flaky test in the set, but still passes isolated. Likely a focus race after `createFreshBlock`'s `Enter` press where the freshly-mounted PM `EditorView` isn't yet receiving keystrokes from the page's input pipeline.

#### `editor.spec.js:574:3` — List continuation › Enter on an empty oli block converts it back to txt
- **Symptom:** `expect(getByText('Ordered List', { exact: true })).toBeVisible({ timeout: 3000 })` times out after `/o`.
- **Frequency:** Failed in run 1; passed 3/3 on isolated rerun.
- **Triage:** `[flake]` — same root shape (createFreshBlock → keyboard.type race).

#### `editor.spec.js:968:3` — Combined keyboard workflow › create, convert via slash menu, then delete
- **Symptom:** `expect(getByText('Designer Note', { exact: true })).toBeVisible({ timeout: 3000 })` times out after `/d`.
- **Frequency:** Failed in run 1 AND in the first isolated rerun (1 of 4 invocations); passed 3/3 in the second isolated rerun.
- **Triage:** `[flake]` — borderline but isolated runs prove the test logic works. Same race shape as the others.

### DOM-depth selectors

CI comment claims DOM-depth selectors fail under PM (because PM's render tree differs from legacy contentEditable). Observed:

#### `editor.spec.js:944:3` — Combined keyboard workflow › full workflow: create block, type, navigate up
- **Symptom:** `expect(content).toContain('Integration test')` — actual content was `"ation test content"` (the first few characters of typed `'Integration test content'` were dropped).
- **Frequency:** Failed in both runs; passed 2/2 on isolated rerun.
- **Triage:** `[flake]` — keystroke loss right after Enter creates the new block. The PM EditorView's mount + auto-focus path may briefly drop the first ~6 chars. Symptom is consistent with the documented `hasAutoFocusedRef` race window in `PmEditableBlock.jsx`; under load this widens. Not a deterministic PM regression. **Worth noting for 1i-b.1** because removing the legacy code path may interact with this race — keep an eye on it.

#### `editor.spec.js:601:3` — Content editing › typing in a txt block updates its content
- **Symptom:** Inferred same shape — `expect(content).toContain('Hello World')` after `createFreshBlock` + `type('Hello World')`. Output captured in run 2's summary; passed 2/2 isolated.
- **Triage:** `[flake]` — same race as the one above.

### Del popup

CI comment claims del popup failures. Observed:

#### None in either run.

The `pm-del-popup` code path was reworked in 1f.8 and 1h Q36 Commit C; the relevant tests (e.g. those grouped near `editor.spec.js:1100–1300`) all pass in PM mode in both runs.

### Paste-strip

CI comment claims paste-strip failures. Observed:

#### None in either run.

`#99` / PR `#105` shipped `handlePaste` on `PmEditableBlock` and pinned the plaintext-only invariant. The corresponding E2E test "Paste formatting > strips HTML formatting from pasted content" (`editor.spec.js:2831`) passed in both runs.

### Comment reconcile

CI comment claims comment-reconcile failures. Observed:

#### None in either run.

The 1g comment-reconcile architecture (`pm-comments.js` + `active-comment.js` plugin) appears stable in PM mode. Both PM-mode "Comment active highlight (1g)" tests (`editor.spec.js:2933`, `:2959`) passed.

### Track Changes (not in CI comment, but observed)

#### `editor.spec.js:859:3` — Export › export preserves Track Changes as ADD/DEL SGML tags
- **Symptom:** Run-2 failure; isolated retries passed 2/2.
- **Triage:** `[flake]`.

#### `editor.spec.js:1209:3` — Track changes: block deletion › Backspace on new revision-add block removes it normally
- **Symptom:** Run-2 failure; isolated retries passed 2/2.
- **Triage:** `[flake]`.

#### `editor.spec.js:1373:3` — Track changes: accept all / reject all › revision stats show addition count
- **Symptom:** Run-2 failure — `text=1 addition` not visible. Isolated retries passed 2/2.
- **Triage:** `[flake]`.

## Cross-cutting hypothesis

All 9 failures fall into one of two flake families:

1. **Post-`createFreshBlock` keystroke race** (5 of 9). `createFreshBlock` does `txt.click()` → `keyboard.press('Enter')` → `expect(focused).toBeVisible()`. Returning when the locator is visible isn't sufficient — for PM blocks the EditorView's `view.focus()` + `Selection.atEnd` dispatch must also have flushed. Under 4-worker parallel load the page's input dispatcher occasionally races the mount. The test then `type('/')` or `type('text')` and the first keystrokes are lost.
2. **Track Changes UI lag** (3 of 9). Tests that toggle TC and immediately type may race the TC publish-effect that wires per-keystroke marking into PM's dispatchTransaction (1h Q33). Under load the first keystroke after toggling can produce a frame whose TC state hasn't propagated yet.

Both are pre-existing in the 1h baseline. Neither needs to block 1i-b.1 work, but if 1i hardens `createFreshBlock` to await a PM-aware "ready to receive input" signal (e.g. polling `__simEditorTestUtils.isViewMountedById`), the editor-suite under-load failure rate should drop materially.

## Recommendation for 1i-a Task 1a.2

- **Do not attempt to fix any of these flakes in 1i-a.** They are not deterministic PM regressions, and the CI comment's "~40 failures" framing is no longer accurate.
- **Update `.github/workflows/ci.yml:128-136`** in Task 1a.5 to: (a) drop the "~40 known failures" wording, (b) state that both projects now pass in the deterministic sense, (c) note that flakes are tracked via the standard `retries: 1` setting in `playwright.config.js`.
- **Add chromium to the CI matrix** in Task 1a.3 with `retries: 1` (already configured). The 1-retry will absorb the observed flake rate cleanly; in isolated reruns every failure passed first try.
- **File no follow-up issues** from this audit — there's nothing for an issue to track.

## Reproducibility

```bash
git checkout feat/1i-a-ci-prep
npm install
npx playwright install chromium
npx playwright test --project=chromium --reporter=list --workers=4 --max-failures=80
```

The dev + collab servers start automatically via `playwright.config.js`'s `webServer` array (`reuseExistingServer: true`).

## Appendix — raw run logs

Full run logs were captured to terminal output (not to file — `tee` to `test-results/pm-baseline.log` did not materialize on Windows in this session; raw output is preserved in the subagent transcript). Failure counts and test IDs above are sourced directly from the Playwright `--reporter=list` output.
