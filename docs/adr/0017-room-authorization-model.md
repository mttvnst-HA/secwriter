# ADR-0017: Room authorization model — multi-tenant isolation + private-by-default

**Status:** Accepted
**Date:** 2026-06-11

Implements issue [#211](https://github.com/mttvnst-HA/secwriter/issues/211) (security floor). Graded roles (viewer/editor/owner) added by [#239](https://github.com/mttvnst-HA/secwriter/issues/239) — see the "Graded roles" section below, which supersedes the binary collaborator model of decision 7.

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
2. **Reserved namespaces: `_public` and `archive`.** A token whose tenant
   sanitizes to `_public` is rejected (403) under `requiresAuth`, so the demo
   namespace is reachable only via the auth=none path. `archive` is likewise
   rejected — it is every adapter's archive-prefix sibling of the tenant
   namespaces, and a token landing there would create rooms inside the
   archive tree (joinable, but invisible to active listings and the sweep
   parsers: orphaned and unswept).
3. **ACL sidecar artifact** `<tenant>/<roomId>.acl.json`. Floor shape (#211) was
   `{ ownerId, sharedWith[] }`; #239 evolves it to `{ ownerId, roles: { "<sub>":
   "viewer"|"editor" } }`. NOT stored in yMeta (avoids the `yMeta.size === 0`
   seed-gate break and a per-request multi-MB decode). Read cheaply before any
   doc load. `roleOf()` read-compat's BOTH shapes (a legacy `sharedWith` entry
   → `editor`) so no data-migration script is needed — see Graded roles.
4. **Crash-order: `.acl.json` BEFORE `.ydoc`** in `ARTIFACT_CATALOG` (write
   order); on delete, sidecars first, then `.ydoc`, then `.acl.json` LAST
   (sidecars-before-ydoc prevents a half-deleted room from being re-created
   over stale `.SEC`/`.comments` that would be served to the new owner). A crash
   mid-create or mid-delete leaves the room absent (404, reclaimable), never
   ownerless/hijackable. See ADR-0005.
   The create-side ACL write is an **atomic claim** —
   `storage.writeAclIfAbsent` (conditional put: local `wx` open, S3
   `If-None-Match: *`, Azure `ifNoneMatch: '*'`) — so two concurrent
   `POST /rooms` of the same id resolve to exactly one 201; the loser 409s
   instead of overwriting the winner's ACL (the check-then-write shape let
   the LAST writer silently take ownership of a room another caller held a
   201 receipt for).
5. **`authorize(user, tenant, roomId, action)`.** read = owner OR shared;
   delete/share/lock-admin = owner only; gated on `requiresAuth` (demo open,
   early-returns allow before any storage read); missing tenant/stable-subject/
   sentinel → 403; not-owner/not-shared/missing ACL → 404 (no existence leak).
   Runs on every `/rooms*` route AND at WS upgrade, before `getYDoc`/preload.
   `GET /rooms` is **member-filtered** under auth via the same predicate
   (`aclAllowsRead`, exported from `authorize.cjs`): the tenant listing only
   includes rooms the caller owns or is shared into — non-members must not
   see private rooms' titles, lock state, or active-user rosters, and rooms
   with no ACL (legacy/orphan) are hidden, matching the per-room 404.
6. **Required JWT claims:** a tenant claim (`tenant | org | tid`) and a stable
   subject (`sub | oid`). No email/`'unknown'` fallback for the owner id.
7. **Binary collaborator model** (owner + share-set) — **superseded by Graded
   roles below** ([#239](https://github.com/mttvnst-HA/secwriter/issues/239)).

## Graded roles (#239)

Replaces the binary owner/shared model with a role lattice per room, within a
tenant. `owner ⊃ editor ⊃ viewer`.

- **Roles.** `viewer` = read-only (open room, `GET /sec`, `GET /comments`);
  `editor` = read + write content (the old `sharedWith` capability);
  `owner` = editor + delete + role-grant + lock-admin. Owner is implicit from
  `acl.ownerId`; viewer/editor live in `acl.roles`.
- **Permission table** (`ROLE_ACTIONS` in `authorize.cjs`, single source of
  truth): the `READ` action gates viewer+editor+owner; a new `WRITE` action
  gates editor+owner. #211 collapsed these because every sharee could write;
  `POST /:id/upload` and the non-lock `PATCH /:id` are now `WRITE`-gated (a
  viewer is denied), `GET /sec` + `/comments` stay `READ` (a viewer is allowed).
- **Lazy migration (no script).** `roleOf(acl, userId)` reads both sidecar
  shapes: `roles` wins when present, else each `sharedWith` entry resolves to
  `editor`. New writes (create, share, legacy-relocation) emit the `roles`
  shape; a #211 room is upgraded in place the next time it is shared. This is
  the "sidecar-shape migration defined and tested" acceptance item.
- **WS viewer read-only gate (the hard part).** On Hocuspocus (#128,
  [ADR-0018](0018-collab-relay-hocuspocus.md)) `onAuthenticate` resolves the
  role and returns `readOnly: role === 'viewer'`; the collab-server wrapper sets
  `data.connectionConfig.readOnly = true`, after which Hocuspocus **rejects and
  does not sync** that connection's document updates. `connectionConfig` (NOT
  `connection`) is the onAuthenticate-payload key Hocuspocus's `Connection`
  constructor and its Authenticated-scope message both read; the payload has no
  `connection` key, so mutating `data.connection.readOnly` is a silent no-op
  (the initial implementation had this bug — a viewer stayed read-write and the
  client always saw `read-write` scope). Pinned by `hocuspocus-server.test.mjs`
  Test 3b, which drives a real viewer/editor through the production wrapper.
  This is the acceptance's "viewer cannot write, verified at the WS layer, not
  just UI". y-websocket v1 had no per-connection write gate — this is why the
  viewer role rode the #128 migration rather than shipping on the #211 floor.
- **Share route** `PATCH /:id/share` gains an optional graded `role`; body stays
  `{ userId, action: 'add' | 'remove', role? }`. `add` is an idempotent upsert
  defaulting to `editor` when `role` is omitted (backward-compatible with #211
  callers); `remove` drops the grant. `role` must be `viewer` or `editor` —
  owner is not grantable here (ownership transfer is out of scope). New
  owner-only `GET /:id/acl` returns the normalized `{ ownerId, roles }` for the
  client share dialog. `GET /rooms` entries carry the caller's `role`.
- **Client.** `HocuspocusProvider` surfaces the server scope via its
  `authenticated` event (`{ scope: 'readonly' | 'read-write' }`);
  `useCollabSession`'s `onAuthScope` feeds App's `collabScope`, and
  `isViewerScope` folds into `collabReadOnly` (read-only editor + a viewer
  banner). The server rejection is the enforcement; this is the UX mirror.
  Owner-only `RoomPanel` share affordance opens `ShareDialog`.
- **Uniform 404 denials preserved.** A viewer's HTTP `WRITE`/`DELETE`/`SHARE`
  attempt returns 404 (not 403), matching #211's no-existence-leak posture and
  its tests (editor DELETE → 404). The read-vs-write boundary is enforced by
  the action gate + the WS `readOnly` flag, not by re-statusing denials.

## Consequences

- **Live-session revocation limitation:** authorize runs at every WS upgrade
  (unconditional), so share-removal takes effect on the sharee's NEXT connect;
  an already-open session is not force-disconnected. Accepted.
- **Delete-resurrection race (FIXED).** Under Hocuspocus `unloadImmediately:
  false` (warm-doc, [ADR-0018](0018-collab-relay-hocuspocus.md)) a room's live
  Y.Doc lingers in memory after `DELETE /rooms/:id`. A debounced
  `onStoreDocument` armed by prior edits (SecWriterDatabase 500ms/10s) could
  fire AFTER `storage.deleteRoom` and re-persist — silently resurrecting the
  just-deleted room; a disconnect leaves any such pending store armed rather
  than firing it (WS close under `unloadImmediately:false` does not itself
  store). Hocuspocus exposes no awaitable per-doc cancel (`unloadDocument`
  early-returns while a store is pending, and the debouncer only exposes
  `executeNow`, which *fires* the store), so the DELETE route calls
  `evictRoom(composite)` (collab-server) BEFORE `storage.deleteRoom`:
  `SecWriterDatabase.markDeleted` tombstones the composite key so any
  pending/queued `store()` no-ops, the doc is dropped from
  `hocuspocus.documents` so `store()`'s identity guard (resident-doc check via
  the threaded `instance`) no-ops a stale/recreate-replaced doc, and any
  in-flight store is awaited so `deleteRoom` is the last writer. `fetch()`
  lifts the tombstone when the same id is loaded fresh (recreate). Pinned by
  `server/__tests__/room-delete-resurrection.test.mjs` (real debounce timer)
  and the `secwriter-database.test.mjs` resurrection-guard unit tests.
- **Within-tenant room-id enumeration:** `POST /rooms` returns 409 on a taken
  id, so a same-tenant caller can probe which ids exist. Out of threat model —
  the boundary this ADR defends is cross-tenant, and ids are not secrets within
  an org (bare existence only; metadata is member-filtered per decision 5).
  Accepted.
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
  The migration covers legacy flat ARCHIVES too (pre-tenant sweeps archived
  under un-namespaced keys the tenant-scoped parsers never match —
  unrestorable and never purged): they relocate into the tenant's archive
  namespace carrying `archivedAt` forward (falling back to the ydoc mtime so
  the sweep can age them out), and they count toward
  `countLegacyFlatRooms` for the boot guard.
- **Demo unchanged:** auth=none runs under `_public`, authorize is inert.

## Cross-references

[ADR-0005](0005-storage-adapter-atomicity-per-backend.md) (acl write/delete
order amendment), [ADR-0013](0013-storage-backends.md) (artifact + composite
key), [ADR-0014](0014-collab-server-yjs-relay.md) (composite docName + WS authz
ordering), [#239](https://github.com/mttvnst-HA/secwriter/issues/239) (graded
roles).
