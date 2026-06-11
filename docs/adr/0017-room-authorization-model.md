# ADR-0017: Room authorization model — multi-tenant isolation + private-by-default

**Status:** Accepted
**Date:** 2026-06-11

Implements issue [#211](https://github.com/mttvnst-HA/secwriter/issues/211). Graded roles deferred to [#239](https://github.com/mttvnst-HA/secwriter/issues/239).

## Context

With `SIM_AUTH_PROVIDER=jwt` the collab server authenticated but did not
authorize: any valid token reached any room. The public Render demo
(auth=none) is intentionally open with no CUI; this ADR targets a real
production deployment (SaaS, many orgs, private-by-default within an org).

The fix had to land without forking the storage layout into a flat-vs-prefixed
pair, without breaking the auth=none demo, and without paying a per-request
multi-MB Y.Doc decode just to read an owner id.

## Decision

1. **One always-namespaced composite room key `(tenant, roomId)`.** Internal
   docName = `<tenant>/<roomId>`; storage adapters take `(tenant, roomId, kind)`.
   Under auth=none everything runs under a reserved `_public` sentinel tenant —
   no flat-vs-prefixed fork.
2. **`_public` sentinel reservation.** A token whose tenant sanitizes to
   `_public` is rejected (403) under `requiresAuth`, so the demo namespace is
   reachable only via the auth=none path.
3. **ACL sidecar artifact** `<tenant>/<roomId>.acl.json` = `{ ownerId, sharedWith[] }`,
   NOT stored in yMeta (avoids the `yMeta.size === 0` seed-gate break and a
   per-request multi-MB decode). Read cheaply before any doc load.
4. **Crash-order: `.acl.json` BEFORE `.ydoc`** in `ARTIFACT_CATALOG` (write
   order); on delete, sidecars first, then `.ydoc`, then `.acl.json` LAST
   (sidecars-before-ydoc prevents a half-deleted room from being re-created
   over stale `.SEC`/`.comments` that would be served to the new owner). A crash
   mid-create or mid-delete leaves the room absent (404, reclaimable), never
   ownerless/hijackable. See ADR-0005.
5. **`authorize(user, tenant, roomId, action)`.** read = owner OR shared;
   delete/share/lock-admin = owner only; gated on `requiresAuth` (demo open,
   early-returns allow before any storage read); missing tenant/stable-subject/
   sentinel → 403; not-owner/not-shared/missing ACL → 404 (no existence leak).
   Runs on every `/rooms*` route AND at WS upgrade, before `getYDoc`/preload.
6. **Required JWT claims:** a tenant claim (`tenant | org | tid`) and a stable
   subject (`sub | oid`). No email/`'unknown'` fallback for the owner id.
7. **Binary collaborator model** (owner + share-set). Graded viewer/editor/owner
   is [#239](https://github.com/mttvnst-HA/secwriter/issues/239).

## Consequences

- **Live-session revocation limitation:** authorize runs at every WS upgrade
  (unconditional), so share-removal takes effect on the sharee's NEXT connect;
  an already-open session is not force-disconnected. Accepted.
- **Within-tenant room-id enumeration:** `POST /rooms` returns 409 on a taken
  id, so a same-tenant caller can probe which ids exist. Out of threat model —
  the boundary this ADR defends is cross-tenant, and ids are not secrets within
  an org. Accepted.
- **Pre-authorize upload buffering:** `POST /rooms/:id/upload` buffers the
  request body (bounded ~8 MB, token-gated) before authorize runs. A bounded,
  authenticated allocation. Accepted.
- **`sanitize` tenant collision:** two distinct raw tenant strings that
  sanitize to the same value share a namespace. Only reachable via a hostile or
  misconfigured IdP issuing adversarial tenant claims; the tenant always comes
  from the authenticated principal, never the URL. Accepted.
- **Share discovery limitation:** no user-directory endpoint; an owner must know
  the sharee's subject id. Share-by-email is a follow-up.
- **Legacy:** auth-on deploys with pre-existing rooms either start fresh or run
  `server/migrate-tenant-namespace.cjs` (`SIM_DEFAULT_TENANT` + `SIM_DEFAULT_OWNER`).
  The script supports all three backends via `storage-factory.cjs` +
  `RoomStorageBase.migrateLegacyFlatRooms`; under auth=none the server boot
  path relocates flat rooms into `_public` automatically (startFromEnv), and
  under auth it refuses to guess and logs `startup.legacy-rooms-detected`.
  S3/Azure relocation follows the same
  shape as an operator-run follow-up.
- **Demo unchanged:** auth=none runs under `_public`, authorize is inert.

## Cross-references

[ADR-0005](0005-storage-adapter-atomicity-per-backend.md) (acl write/delete
order amendment), [ADR-0013](0013-storage-backends.md) (artifact + composite
key), [ADR-0014](0014-collab-server-yjs-relay.md) (composite docName + WS authz
ordering), [#239](https://github.com/mttvnst-HA/secwriter/issues/239) (graded
roles).
