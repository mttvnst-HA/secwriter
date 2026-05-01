# ADR-0004: Collab publish path uses snapshot diff, not live Y.Text binding

**Status:** Accepted (deferred refactor tracked at issue #22)
**Date:** 2026-05-01

## Context

SecWriter's collaborative editing uses Yjs. Block content reaches the Y.Doc via the **publish path**:

1. `EditableBlock.handleInput` fires `onUpdate(blockId, html)` (debounced 400ms) and `handleBlur` fires it unconditionally (cancelling any pending input debounce).
2. `App.handleBlockUpdate` updates React state.
3. A `useEffect([blocks, inRoom])` in `src/App.jsx` calls `session.publishBlocks(blocks)`.
4. `applyBlocksToYDoc` walks the block array; per block, `applyHtmlToYText(yText, html)` **diffs the new HTML string against the existing Y.Text** and synthesizes Yjs ops to match.

This is a **snapshot diff** at publish time, not a character-level CRDT binding. The "snapshot" here is the previous Y.Text state, not the TC snapshot — see `CONTEXT.md` for the disambiguation.

The architecturally correct alternative is a live `Y.Text ↔ DOM` binding (e.g., a custom binding analogous to `y-prosemirror` or `y-tiptap`) that emits character-level Yjs ops as the user types. That is a substantial refactor — the editor's contentEditable focus management, mark rendering, tag-label injection, and revision-mark handling all assume mutable HTML strings, not a Y.Text-backed DOM. The work is tracked at issue #22.

The shipped snapshot-diff approach is workable for single-user rooms and for low-contention multi-user rooms where two users rarely type into the same paragraph within one debounce window. Concurrent same-paragraph typing relies on the diff resolving sensibly at publish time — sometimes it does, sometimes it produces visible glitches.

## Decision

The publish path stays as a snapshot-diff into Y.Text for now. The full live-binding refactor is deferred and tracked at issue #22. A smaller, independent improvement — extracting publish coordination (the `lastRemoteBlocksRef` guard, ready ref, `DocSizeLimitError` handling) into a dedicated module — is in scope without superseding this ADR; it would localize the surface that the live-binding refactor eventually replaces.

## Consequences

- **Positive:** Editor mutation logic stays HTML-string-based, which is what every other subsystem (Track Changes, comments, marks, tag labels) assumes. Implementation cost was low.
- **Negative / cost:** Concurrent same-paragraph editing is glitchy. The string-level diff is 100+ lines of delta synthesis (`applyHtmlToYText` in `src/lib/ytext-html.js`) that's hard to reason about under contention. The publish effect's coordination logic (guards, ready ref) leaks into App.jsx, making the seam thin.
- **Re-litigation risk:** Without this ADR, every architecture review will surface "switch to a live Y.Text binding" as a top-priority candidate. With it, the candidate is explicit and the deferral has a citation.

## Alternatives considered

- **Live `Y.Text ↔ DOM` binding** — the architecturally correct shape; deferred to issue #22 because it disturbs every editor subsystem at once.
- **Per-block Y.Text, with `EditableBlock` directly bound** — partial form of the above; same cost.
- **Per-character debounce + char-level diff** — strictly worse than the current word-level snapshot diff for the contention scenarios that actually happen.

## When to revisit

When any of the following is true:

1. Multi-user same-paragraph editing becomes a frequent user complaint or a regression in a paying-customer scenario.
2. A maintainer has the bandwidth to land issue #22 with full E2E coverage of TC + comments + marks under live binding.
3. The publish-path coordination logic is extracted into a hook (the smaller in-scope improvement) — at which point the surface for the larger refactor is much narrower.

Until then, snapshot diff stays.
