# ADR-0016: Persisted lint cache is GC'd against the live-block fingerprint set

**Status:** Accepted
**Date:** 2026-06-10

## Context

The block-granular lint cache ([ADR-0015](0015-linting-stays-block-granular.md), issue #138) persists into the collab document as a top-level `Y.Map` named `lint` (`yLint`, [`src/lib/collab.js`](../../src/lib/collab.js)). Each entry is keyed by the SHA-fingerprint of a block's html ([`fingerprintBlock`](../../src/lib/lint-sidecar.js)) and records whether that content state is clean (`{ kind: 'good' }`) or carries findings (`{ kind: 'bad', g, n, c }`).

`publishLintToDoc` was originally **set-only** — explicitly documented as "phase 1: never delete; phase 3 future ticket." The stated reason for deferring deletion: a naive absence-based prune races peers. Each peer encodes a payload from its *own* locally-linted `byBlock` subset, so a fingerprint absent from one peer's payload may still be valid for another peer's block; pruning on per-peer-absence would race the union away.

[Issue #214](https://github.com/mttvnst-HA/secwriter/issues/214) showed the cost of the deferral. Every distinct content state a block passes through leaves a permanent ~92-byte entry that is never reclaimed. `yLint` is a top-level type, so it ships in `Y.encodeStateAsUpdate` → the persisted `.ydoc`, every joiner's initial sync, and the lint sidecar. A long-lived, heavily-edited room trends toward `MAX_DOC_BYTES` (8 MB), at which point `flushRoom` logs `flush.refused` and silently stops persisting **all** edits — recoverable only by operator intervention.

## Decision

`publishLintToDoc` accepts an optional `liveFingerprints: Set<fp>` — the fingerprints of every **current live block**, computed by [`computeLiveFingerprints(blocks)`](../../src/lib/lint-sidecar.js) from the shared block array. When supplied, the same transaction that sets new entries also **deletes every `yLint` entry whose fingerprint is in neither the live set nor the just-published target**.

An entry is dead the moment its fingerprint matches no live block: the cache is only ever consulted at load time by `projectDecoded`, which fingerprints the *current* html of each live block. A non-live fingerprint can never be hit again.

The race the original deferral worried about is dissolved by anchoring the prune to the **shared** live set rather than a per-peer payload. The block array is CRDT-shared — every peer converges on the same set — so a fingerprint absent from the live document is dead for *every* peer, not just the pruning one. The publish effect in [`useCollabSession.js`](../../src/hooks/useCollabSession.js) computes `liveFingerprints` from `blocks` and threads it through `session.publishLint(payload, liveFingerprints)`. Deletes carry origin `local-lint` (filtered by `handleAfterTx`, absent from both UndoManagers' `trackedOrigins`), so GC never enters an undo stack.

When `liveFingerprints` is omitted, behavior is the legacy set-only path — preserved for direct unit-test callers.

## Consequences

- **Positive:** Persisted `yLint` is bounded to the live-block count instead of growing per content state. Removes the silent flush-refusal failure mode at its root. One-transaction prune, no separate sweep, no server change (deletes propagate via the normal CRDT path).
- **Negative / cost:** A cross-peer lag — a peer pruning before its `blocks` snapshot has synced another peer's just-typed html — can delete a still-live entry. The cost is bounded to a **benign cache miss**: the engines re-run on that block at next load, exactly as for any un-cached block. Never edit loss. The entry returns the next time any peer lints that block.
- **Re-litigation risk:** "Why not tombstones?" Tombstones solve absence-based pruning of *per-peer* state; they are unnecessary here because the live-block set is shared, so absence is globally authoritative. Tombstones would themselves accumulate (the same unbounded-growth shape, one level removed).

## Alternatives considered

- **Tombstone-with-author/ts prune** (the issue's repair sketch). Rejected — needed only if pruning per-peer-absence; the shared live set makes it moot, and tombstones reintroduce unbounded growth.
- **Server-side prune on flush.** Race-free (single authority) but requires the CJS server to import the async Web-Crypto fingerprint path and mutate the doc on flush. More surface and risk than a client-side prune in the existing publish seam; deferred unless the client prune proves insufficient.
- **Bounded-size heuristic (prune only when `yLint.size > k × liveCount`).** Adds a tuning knob and a history window with no correctness benefit over pruning to the live set directly.

## When to revisit

1. If the benign cross-peer cache miss proves frequent enough to matter (measurable load-time engine churn in multi-peer rooms), add a short time-window grace to entries before they become prunable, or move the prune server-side.
2. If `estimatePublishBytes` ([`src/lib/collab.js`](../../src/lib/collab.js)) needs to predict the flush cap precisely, it should begin counting `yLint`; today the GC keeps `yLint` small enough that the estimate's omission of it is no longer the dominant risk.
