# ADR-0015: Linting state stays block-granular, not sentence-granular

**Status:** Accepted
**Date:** 2026-05-20

## Context

[Issue #139](https://github.com/mttvnst-HA/secwriter/issues/139) proposed moving the linting reducer ([`src/lib/linting.js`](../../src/lib/linting.js)) from `byBlock: Map<blockId, BlockFindings>` to a sentence-granular keying — `bySentence`, keyed by a sentence fingerprint. The motivation drew from WriterAgent's sentence-fingerprint architecture (LLM-per-sentence cache) and from the hypothesis that re-linting a "50-sentence narrative block" on every keystroke causes noticeable lag.

The decision is load-bearing because the proposed reshape would ripple through every consumer of the reducer: `dedupNlpAgainstCompliance` and `dedupGrammarAgainstFindings` (both offset-keyed), `getRangesByTier` (block-iteration), `useBlockLinting` (block-lifecycle hook), the App-level CSS.highlights effect, and the persistence story for #138 (`.lint.json` sidecar fingerprint shape). It would also force an alignment decision against the Comments reducer ([ADR-0010](0010-comments-reducer-dual-reconcile.md)) and Track Changes ([ADR-0009](0009-track-changes-per-keystroke.md)).

A measurement pass gated the decision. The corpus distribution script ([`tools/lint-block-distribution.mjs`](../../tools/lint-block-distribution.mjs)) walked **2,583 calibration-corpus blocks** (raw UFGS master text from 5 sections) and computed sentence-count per block using `Intl.Segmenter`:

| Metric | Value |
|---|---|
| p50 sentences/block | 1 |
| p75 | 3 |
| p90 | 5 |
| p95 | **6** |
| p99 | **12** |
| max across the entire corpus | **20** |
| Blocks > 20 sentences | 0 (0.00%) |
| Blocks > 50 sentences | 0 (0.00%) |
| Single-sentence blocks | 54.4% |

Per-block-type breakdown: `txt` (n=924, p95=10, max=20), `oli` (n=796, p95=4, max=8), `note` (n=643, p95=5, max=19), `item` (n=183, max=2). The `dirty` corpus is uninformative for this question (~98% of its blocks are empty placeholders awaiting injected violations — it is not a distribution of authored text).

The "50-sentence narrative block" premise is not present in real UFGS text. The longest authored block in 2,583 samples is 20 sentences.

## Decision

**The linting reducer stays block-granular.** `linting.byBlock: Map<blockId, BlockFindings>` is the canonical keying. Sentence-granular state is **not** introduced — neither in the in-memory reducer nor in the [#138](https://github.com/mttvnst-HA/secwriter/issues/138) `.lint.json` sidecar (which proceeds with block-fingerprint as designed).

The decision is independent of:

- [#148](https://github.com/mttvnst-HA/secwriter/issues/148) — block-deletion leak in `byBlock`. Real bug surfaced during red-team review; fix at the dispatch site, not by reshape.
- [#149](https://github.com/mttvnst-HA/secwriter/issues/149) — sentence-boundary source for `DEFERRED_TO_PANEL` rules and inline tooltips. Independent design question; resolving it does not motivate sentence-granular state.

## Consequences

- **Positive:**
  - **No architectural reshape.** `linting.js`, `useBlockLinting.js`, the dedup pipeline, `getRangesByTier`, the App-level CSS.highlights effect, and the #138 sidecar fingerprint shape all stay as designed in [ADR-0012](0012-inline-linting-css-highlights.md).
  - **No forced alignment with Comments / TC reducers.** Comments key by `commentId`, TC has no per-block state (`{ enabled, publishSeq }` only) — there was never a cross-reducer precedent to preserve.
  - **Block-fingerprint sidecar (#138) lands cleanly.** Sentence-fingerprint would have been a more complex migration target with no measurable upside.
- **Negative / cost:**
  - **None measurable.** With p95 = 6 sentences and max = 20, the hot-path cost of re-linting a whole block on every debounce is bounded at ~5-50ms wall-clock for the static + NLP tiers combined — well under the 50ms long-task threshold, and behind a 500ms input debounce so it is not in the keystroke critical path.
  - **Re-opens the question if engineer-corpus distribution diverges materially from master text.** We are extrapolating from master templates; engineer-edited specs could in principle have longer narrative blocks. The "when to revisit" section below names the trigger.
- **Re-litigation risk:**
  - **"WriterAgent does sentence-granular, why don't we?"** WriterAgent runs LLM-per-sentence; the per-sentence cost there is hundreds of milliseconds plus an API call, and sentence-fingerprinting amortizes that across edits. SecWriter's three engines (static regex, compromise NLP, Harper WASM Worker) are local and bounded; the cost model does not justify the same reshape.
  - **"Wouldn't sentence-granular reduce invalidation on edits?"** Yes, by ~6× at p95. But the absolute saving is microseconds — the per-block lint cost is already small. The reshape cost (state shape, dedup, projection, sidecar fingerprint) outweighs the savings by orders of magnitude.
  - **"Should we adopt sentence-granular state for future-proofing in case engineer specs are longer?"** No: this ADR's "when to revisit" trigger covers that case. Premature reshape on a fictional pain point would carry a real maintenance cost today.

## Alternatives considered

- **Sentence-granular state (the issue's proposal).** Rejected on the distribution data — no measurable hot-path pain at the actual block-size distribution, and the reshape touches every linting consumer plus forces alignment decisions with two unrelated reducers.
- **Defer the decision (the red-team's "fifth outcome").** Rejected — Comments keys by `commentId`, TC has no per-block state, so there is no architectural-precedent argument for keeping the question open. Deferred issues rot.
- **Run browser-side LoAF instrumentation before deciding** (the original measurement plan's full sequence). Considered, but the distribution data alone is decisive: even worst-case (20 sentences) is within the long-task budget. Instrumentation would confirm what's already evident and burn dev time.
- **Adopt sentence-granular only in the #138 sidecar** (split the decision — block in memory, sentence on disk). Rejected — the sidecar's fingerprint shape is load-bearing for cache invalidation, and a mismatch between in-memory and on-disk keys would require translation on every load/save. Not worth the complexity for a hypothetical future need.

## When to revisit

Revisit this ADR if:

1. **Real engineer-edited spec distribution diverges from master text.** If we ever collect an engineer-corpus (anonymized, post-edit `.SEC` files) and the p95 block size exceeds 20 sentences or the p99 exceeds 50, re-run [`tools/lint-block-distribution.mjs`](../../tools/lint-block-distribution.mjs) against it. If the distribution shifts substantially, re-open #139 with the new data.
2. **Engine cost shifts substantially.** If Harper.js or compromise.js adopts a much slower processing model (e.g. an order-of-magnitude regression), the per-block cost could push into the long-task budget at the existing block-size distribution. Recompute against the new engine cost.
3. **A new engine is added that scales worse than linear in block size.** If a future tier (e.g. an LLM-based reviewer) makes per-block cost expensive, sentence-granular caching becomes warranted — but as a sidecar / engine-local optimization, not necessarily a reducer-shape change.
4. **The `getRangesByTier` global projection cost becomes the bottleneck.** This is a separate concern from per-block lint cost (see #148 — leaked `byBlock` entries amplify it). If after #148 lands the projection cost is still measurable, the right fix is incremental dirty-tracking on `byBlock`, not sentence-granular keying.

The distribution script in `tools/lint-block-distribution.mjs` is reproducible — re-run it against new data before re-opening #139.
