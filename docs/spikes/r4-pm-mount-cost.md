# R4 spike: per-block PM EditorView mount cost

**Status:** Resolved — mount-on-render proceeds.
**Date:** 2026-05-05
**Issue:** [#47](https://github.com/mttvnst-HA/secwriter/issues/47), Q29 in [revised plan v2](https://github.com/mttvnst-HA/secwriter/issues/47#issuecomment-4374671950).

## Question

Does mounting one ProseMirror `EditorView` per editable block scale to a typical UFGS section (~300 blocks) inside a single React render pass, or does the migration need to lazy-mount editors on first focus?

## Decision thresholds (from Q29b)

P50 across 5 runs of mounting 300 EditorViews:

- **< 200ms** → mount-on-render proceeds as planned.
- **200-500ms** → mount-on-render with a "rendering editor…" skeleton state for not-yet-mounted blocks.
- **> 500ms** → lazy-mount mandatory. Reshapes 1e: editable blocks render static html until first focus, lazy mount handles remote updates against unfocused blocks. Pushes 1e from 4-6 days to 7-10 days.

## Result

| metric | ms |
|---|--:|
| P50 | **83.2** |
| P95 | 96.7 |
| min | 66.2 |
| max | 99.9 |
| runs | 83.7, 99.9, 66.2, 83.2, 67.0 |

**Decision: mount-on-render.** P50 is 60% under the 200ms threshold; even P95 leaves > 100ms of headroom. No skeleton state, no lazy-mount.

## Method

- 300 `Y.XmlFragment`s in one `Y.Doc`, each seeded via `prosemirrorToYXmlFragment(sampleDoc, yXml)`.
- Sample doc per block: 2 paragraphs, ~80 words, 4 inline marks (RID/SUB/bold). Programmatic node creation — bench measures EditorView mount, not html parsing.
- Each run: clear DOM, allocate 300 target divs, `await rAF`, mark `t0`, mount 300 EditorViews each with `[ySyncPlugin(yXml)]`, `await rAF` for paint, mark `t1`. `elapsed = t1 - t0`.
- 1 warm-up run (discarded — pays JIT + module-graph cost), then 5 timed runs.
- Headless Chromium (147.0.7727.15) on Windows, viewport 1280×800, foregrounded via Playwright.
- Schema for the bench: minimal — paragraph, text, b/i/u, single `inlineMark` mark with `kind` attr. Enough to exercise mark application during `ySyncPlugin`'s initial render.

## Caveats

- **Headless Chromium is not the lowest-spec deploy target.** Q29b mentioned benching on the deploy-target hardware (Render dyno). The frontend runs in users' browsers, not on Render — the deploy target *is* a developer/engineer machine. The headless Chromium number is the right proxy. If user telemetry post-1e shows P50 > 200ms in the wild, revisit.
- **Bench excludes React render cost.** Each block in the real app mounts inside an `EditableBlock` React component with siblings (gutter, comment popup, FloatingToolbar trigger). React's per-component cost is linear and small relative to PM mount; the headroom (>100ms vs threshold) accommodates it.
- **Bench excludes other one-time costs at first paint:** initial Yjs sync, file-load, slash-menu mount, App-level state hydration. All of these exist today and are unchanged by the PM migration.
- **Single-browser bench.** Q29b suggested Chrome + Firefox. For a P0 binary decision with this much headroom (60% under threshold), Chromium alone is adequate. If the result had been borderline (180-220ms), Firefox would have been required.

## Re-run

```bash
npm run dev                                # vite at :5173
node tools/run-bench-pm-mount.mjs          # prints JSON to stdout
```

Bench page: `bench-pm-mount.html` at repo root. Bench module: `tools/bench-pm-mount/bench.js`. Playwright runner: `tools/run-bench-pm-mount.mjs`.

## Implications for sub-PR 1e

- EditorView mount happens during the React render pass for editable blocks. No lazy-mount path.
- No "rendering editor…" skeleton state needed.
- 1e effort estimate stays at the 4-6 day baseline (not 7-10 days).
- One follow-up: add a perf regression test in `tests/e2e/editor.spec.js` that loads a long fixture (e.g. `01 11 00.SEC`) and asserts first-paint time stays under a regression budget. Threshold suggestion: 300ms (3.5× current spike P50, generous for noisy CI).
