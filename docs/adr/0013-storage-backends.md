# ADR-0013: Pluggable storage backends — local, Azure Blob, S3-compatible

**Status:** Accepted
**Date:** 2026-05-20

## Context

SecWriter's collab server persists Yjs rooms to durable storage. The product needs to run in three deployment shapes: (1) local dev (laptop disk), (2) Render web service backed by Azure Blob (production), (3) S3-compatible object stores (R2, MinIO) for self-hosters. Each backend has different atomicity primitives — filesystem `rename` is atomic, Azure Blob has lease-based exclusivity, S3/R2 has none. The room-write path must produce a consistent `.ydoc` artifact under crash and concurrent-flush conditions for each.

[ADR-0005](0005-storage-adapter-atomicity-per-backend.md) decided that atomicity stays per-backend — the base class enforces ordering but not the cross-artifact transaction. This ADR documents the concrete adapters that implement that decision.

## Decision

Three storage backends are wired and selectable via `SIM_STORAGE_BACKEND`:

1. **`local`** (default) — disk under `server/collab-db/`. Implementation: `server/storage-local.cjs`. Atomicity via filesystem stage-rename-rollback.
2. **`azure`** — Azure Blob storage. Implementation: `server/storage-azure.cjs`. Atomicity via `.ydoc` blob lease (multi-instance safety on Render).
3. **`s3`** — S3-compatible (Cloudflare R2, AWS S3, MinIO). Implementation: `server/storage-s3.cjs`. Configured via `SIM_S3_*` env vars. Inherits the default sequential `.ydoc`-LAST write (R2 has no transaction primitives).

**Inheritance and atomicity:**

All three extend `RoomStorageBase` (`server/room-storage.cjs`). The base owns the public methodset (`writeRoom / readRoom / deleteRoom / listRooms / statRoom / quarantineRoom / archiveRoom / restoreRoom / listArchivedRooms / deleteArchivedRoom`) by composing seven adapter primitives (`_putBytes / _getBytes / _deleteKey / _listKeys / _statKey / _copyKey / _keyForArtifact`) plus three name-parsing hooks. Shared `sanitize()` and the `ARTIFACT_CATALOG` (`.ydoc` LAST = source of truth) live in `server/storage-shared.cjs`. **Adding a fourth artifact is a one-line catalog edit; adapters never decide write order.**

Local overrides `writeRoom` for stage-rename-rollback atomicity. Azure overrides it for `.ydoc` blob lease. S3 inherits the default sequential `.ydoc`-LAST write.

**Local backend dir override (PR #113):**

`SIM_LOCAL_STORAGE_DIR` overrides the default `server/collab-db/` for the local backend. Playwright's `webServer.env` sets it to `server/collab-db-e2e/` so E2E and dev storage never share state; `tests/e2e/global-setup.js` wipes that dir before each suite with a hard guard that refuses any path not ending in `-e2e` — a typo cannot destroy dev rooms.

**Cross-backend contract:**

Verified by `server/__tests__/storage-contract.test.mjs` (19 assertions × 3 backends = 57 tests; grew from 12 with the ACL round-trip + delete-order checks added by [ADR-0017](0017-room-authorization-model.md)). The contract pins shared behavior — `listArchivedRooms` returns `{ id, archivedAt }` uniformly with ISO-8601 timestamps; both fields are required by the collab-server sweep.

## Consequences

- **Positive:**
  - **Single shared methodset.** Tests and the collab server target one API; backend choice is operational, not code-shape.
  - **Atomicity per-backend, not per-artifact.** Each adapter uses the best primitive its substrate offers (filesystem rename / blob lease / `.ydoc`-LAST). The base class enforces no shape it can't deliver everywhere.
  - **Adding artifacts is one catalog edit.** Write order is a property of the catalog, not of any adapter.
  - **E2E storage isolation guard.** Hard `-e2e` path check in `global-setup.js` prevents the dev-room destruction footgun.
- **Negative / cost:**
  - **Three adapters to maintain.** Storage-contract test catches divergence but doesn't free anyone from running it after a base-class change.
  - **S3 has no cross-artifact transaction.** R2-backed deployments accept the `.ydoc`-LAST best-effort guarantee per [ADR-0005](0005-storage-adapter-atomicity-per-backend.md); there is no path to true atomic multi-artifact writes there.
- **Re-litigation risk:**
  - **"Why not one backend (just S3)?"** Render's stock plan ships Azure Blob; switching to S3 means paying an external provider + an egress hop. Local dev needs disk. The cost of three adapters is a one-time write per primitive, not an ongoing tax.
  - **"Why not a single transactional layer in the base class?"** S3/R2 doesn't have one — there's nothing to transact against. See [ADR-0005](0005-storage-adapter-atomicity-per-backend.md).

## Amendment (2026-06-11, ADR-0017): composite key + `.acl.json` artifact

Room authorization ([ADR-0017](0017-room-authorization-model.md), [#211](https://github.com/mttvnst-HA/secwriter/issues/211)) changes the storage key from a bare `roomId` to a composite `(tenant, roomId)` and adds a fourth artifact:

- **Composite key.** Every adapter primitive now takes `(tenant, roomId, kind)`. `_keyForArtifact` namespaces under the tenant — local: `<dir>/<tenant>/<id><ext>`; S3/Azure: `<tenant>/<id>.<ext>` object prefix. Under auth=none everything lives under the reserved `_public` tenant, so there is no flat-vs-prefixed fork.
- **`.acl.json` artifact** = `{ ownerId, sharedWith[] }`, catalogued BEFORE `.ydoc` (see the [ADR-0005](0005-storage-adapter-atomicity-per-backend.md) amendment for the crash-order rationale). Read cheaply via `readAcl(tenant, roomId)` before any doc load; written by `writeAcl`. Still a one-line catalog edit — adapters never decide order.
- **Per-backend tenant enumeration (three shapes).** `listRooms(tenant)` lists one tenant; `listAllRooms()` returns `[{ tenant, roomId }]` cross-tenant for the server sweep.
  - **Local** readdir is non-recursive, so it overrides `listAllRooms` / `listAllArchivedRooms` / `_listTenants` / `_listArchivedTenants` to walk tenant subdirectories.
  - **S3 / Azure** inherit the base `listAllRooms`, which parses the `<tenant>/<id>.<ext>` flat key space via `_parseActiveKey` — no per-tenant directory walk needed.

## Alternatives considered

- **One backend (S3 everywhere).** Rejected — Render's Azure Blob is already provisioned and free; switching would add a paid hop and break local dev's no-credentials onboarding.
- **Atomicity in the base class.** Rejected per [ADR-0005](0005-storage-adapter-atomicity-per-backend.md) — S3/R2 lacks the primitive.
- **Separate process per backend.** Rejected — adapter polymorphism is cheaper than IPC.
