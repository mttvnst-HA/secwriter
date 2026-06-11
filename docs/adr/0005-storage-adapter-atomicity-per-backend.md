# ADR-0005: Room storage uses a base class + adapters; multi-artifact atomicity stays per-backend

**Status:** Accepted
**Date:** 2026-05-02

## Context

Each SecWriter room is persisted as three artifacts (see `CONTEXT.md` → "Room artifacts"): `.ydoc` (the binary Y.Doc state — source of truth), `.SEC` (windows-1252 spec export), and `.comments.json` (sidecar metadata). The collab server flushes them via `storage.writeRoom(roomId, { ydocBytes, secBytes, commentsJson })` against one of three backends (`local`, `azure`, `s3`) selected by `SIM_STORAGE_BACKEND`.

Before this refactor, each backend (~250–340 lines) re-implemented the entire methodset (10 methods) from scratch, including:

- Three identical copies of `sanitize()` — the S3 copy carried an apologetic comment ("Duplicated to keep the three backends aligned without introducing a shared util module").
- The `['.ydoc', '.SEC', '.comments.json']` artifact catalog hard-coded across every method of every backend (10 methods × 3 backends ≈ 30 places).
- Parallel re-derivations of the "`.ydoc` is written LAST" ordering protocol.
- Parallel implementations of `archiveRoom` / `restoreRoom` / `quarantineRoom` / `listArchivedRooms` / `deleteArchivedRoom`.

Adding a fourth artifact (e.g. a `.tailoring.json` sidecar) would have required editing all three backends plus the room-serializer plus all three test files — a sign that the interface (`writeRoom({ … })`) was barely smaller than the implementation.

The architecture-review entry framed this as "three near-identical 80-line atomicity loops," but only the Local backend has a true atomicity loop (stage to `.tmp` → rename in order → rollback from in-memory backup). Azure has a `.ydoc` blob lease for multi-instance safety. S3 has no atomicity at all — Cloudflare R2 (the production target) doesn't support multi-object transactions.

## Decision

Room storage is structured as a base class + thin adapters:

- **`server/storage-shared.cjs`** owns `sanitize()`, the `ARTIFACT_CATALOG` (with kind, optional flag, content type, and write order), and the `planArtifactWrites()` normalizer that turns the public `{ ydocBytes, secBytes, commentsJson }` argument into a catalog-ordered `[{ kind, bytes }]` plan.
- **`server/room-storage.cjs`** exports `RoomStorageBase`, which implements the entire public methodset (`writeRoom / readRoom / deleteRoom / listRooms / statRoom / quarantineRoom / archiveRoom / backupRoom / restoreRoom / listArchivedRooms / deleteArchivedRoom / migrateLegacyFlatRooms`) by composing seven adapter primitives plus a few naming hooks. The base class is the single source of truth for ordering, sidecar optionality, archive marker timing, and partial-failure handling.
- **`server/storage-{local,azure,s3}.cjs`** each extend `RoomStorageBase` and implement `_putBytes / _getBytes / _deleteKey / _listKeys / _statKey / _copyKey / _keyForArtifact` plus `_parseActiveKey / _parseArchiveKey`. They override the optional archive-marker hooks (Local writes a sidecar file; Azure/S3 use blob/object metadata).

**Atomicity is a per-backend concern, not unified at the base class.** The base class writes artifacts sequentially with `.ydoc` LAST. That sequential-with-`.ydoc`-LAST ordering is the honest cross-backend contract: if a sidecar write fails, `.ydoc` is left at the older consistent state rather than ahead of stale sidecars.

- **Local** overrides `writeRoom` to wrap the writes in a stage-rename-rollback loop. Filesystem rename is atomic per file; the wrapping rollback gives true multi-file atomicity.
- **Azure** overrides `writeRoom` to acquire a `.ydoc` blob lease for multi-instance safety, then issues sequential uploads.
- **S3** inherits the base class's plain sequential write — Cloudflare R2 has no transaction primitives, and the `.ydoc`-LAST ordering is the strongest cross-object guarantee available.

## Consequences

- **Positive:**
  - Adding a fourth artifact (e.g. `.tailoring.json`) is a one-line edit in `ARTIFACT_CATALOG`.
  - `sanitize()` lives in one file; the apologetic triple-copy is gone.
  - Archive/restore/quarantine semantics live in one place, including the `.ydoc`-LAST ordering for archive copies and the per-call timestamp threading for quarantine suffix-grouping.
  - A single contract test (`server/__tests__/storage-contract.test.mjs`) runs 19 assertions × 3 backends (57 total — grew from 12 with the `.acl.json` round-trip + delete-order checks), so adding a fourth backend would automatically be checked against the same contract.
  - **Two latent production bugs were fixed** as a side effect of unification:
    - S3's `listArchivedRooms` returned `{ name, archivedAt }`, but `server/collab-server.cjs:534` reads `room.id` — the S3 sweep was silently a no-op, leaving archived rooms in R2 indefinitely.
    - Azure stored `archivedat` metadata as `String(Date.now())` (a numeric string), which `new Date(...)` parses as Invalid Date in Node. The Azure sweep's `archivedDays = (now - getTime()) / day` was always `NaN`, so `NaN >= DELETE_DAYS` was always false, and the Azure sweep also never deleted anything.
    - Both backends now return `{ id, archivedAt }` uniformly with ISO-8601 timestamps.
- **Negative / cost:**
  - Three backends now share a common parent class, so a base-class change affects all three. Mitigated by the contract test enforcing identical behavior.
  - The base class adds an extra `_statKey` existence check before each archive/quarantine copy (matching the prior Local/Azure behavior; the prior S3 implementation skipped this check). Negligible runtime cost; safer semantics.
  - A reader navigating from `writeRoom` in one of the backends has to read both the adapter and the base class to understand the full flow. The trade is "navigate two short files instead of one long file."
- **Re-litigation risk:**
  - Without this ADR, a future contributor seeing "Local has rollback but Azure/S3 don't" may try to invent a generic atomicity protocol that fits all three. It can't be done cheaply — R2 has no multi-object transaction. The `.ydoc`-LAST ordering is the strongest contract available.
  - Without this ADR, someone may also try to "uniformize" Azure's lowercase `.sec` blob naming with Local/S3's uppercase `.SEC`. That would change the storage layout and break readback for existing Azure-persisted rooms.

## Amendment (2026-06-11, ADR-0017): `.acl.json` write/delete order

The room-authorization work ([ADR-0017](0017-room-authorization-model.md), [#211](https://github.com/mttvnst-HA/secwriter/issues/211)) adds a fourth artifact, `.acl.json` = `{ ownerId, sharedWith[] }`, positioned in `ARTIFACT_CATALOG` BEFORE `.ydoc`. This extends the `.ydoc`-LAST ordering into a crash-consistency invariant for ownership:

- **Write order: `.acl` before `.ydoc`.** A crash mid-create leaves an orphan ACL with no `.ydoc` — the room reads as absent (`readRoom` returns null → 404) and is reclaimable. It NEVER leaves a `.ydoc` with no ACL (an ownerless, un-shareable, un-deletable room).
- **Delete order: sidecars, then `.ydoc`, then `.acl` LAST.** `deleteRoom` removes the optional sidecars first (while any stale `.SEC`/`.comments` exists the `.ydoc` does too, so the create route 409s — a crash mid-delete can never let a re-created room serve the previous owner's sidecars), then the source-of-truth `.ydoc`, then the ACL. A crash between `.ydoc` and `.acl` leaves the same reclaimable orphan-ACL state a crashed create produces, recovered by the same owner-DELETE reclaim path.

The delete-order is enforced by the base class (`server/room-storage.cjs` `deleteRoom`) and pinned by a `_deleteKey` ordering spy in the contract suite (asserts sidecars before `.ydoc` and `.ydoc` before `.acl` across all three backends).

## Alternatives considered

- **Surgical extraction (Option A in the design discussion):** lift only `sanitize()` and the artifact catalog into a shared module, leave the three parallel implementations of every method. Smaller change, lower risk, but leaves all the parallel implementations and doesn't address the "adding a fourth artifact is a 3+ file edit" friction.
- **Defer with ADR (Option C):** document that the duplication is real but cheap to maintain because the artifact set is stable. Rejected because the duplication came with two latent production bugs (Azure + S3 sweeps both broken), suggesting that "cheap to maintain" was paying its price in subtle behavioral drift, not just LOC.
- **Unify atomicity at the base class:** rejected — Cloudflare R2 has no multi-object transactions, Azure has only single-blob leases, and any "fake" generic atomicity protocol (e.g. write-marker-then-commit) would mislead callers about the actual durability guarantees.
- **Abstract the storage layout (e.g. force all three backends to use the same key-naming convention):** rejected — would require changing on-disk/on-blob layouts of existing rooms, which the refactor scope explicitly ruled out. Backends still control their own naming via `_keyForArtifact`.

## When to revisit

- A fourth backend (e.g. GCS, Azure Files, FUSE-mounted S3) lands and the adapter primitives turn out to be too narrow or too broad. At that point, evaluate whether the primitive set needs adjustment.
- A multi-object transaction primitive becomes available across all three production backends (unlikely — would require Cloudflare R2 to add transaction support). At that point, atomicity could plausibly be unified at the base class.
- The `.ydoc`-LAST ordering stops being sufficient (e.g. a new sidecar artifact becomes a source of truth that must agree with `.ydoc` byte-for-byte). At that point, a new ADR should explicitly downgrade or replace this one.

Until then, the base + adapter shape stays.
