# Room Authorization — Multi-Tenant Isolation + Private-by-Default

**Issue:** [#211](https://github.com/mttvnst-HA/secwriter/issues/211)
**Date:** 2026-06-11
**Status:** Design approved, pending spec review (2nd revision after two independent reviews)

## Problem

When `SIM_AUTH_PROVIDER=jwt` is enabled, the collab server **authenticates but does not authorize**. The gate at `server/http-handler.cjs:142-163` verifies the bearer token and sets `req.user`, then every room route runs with no further check. `server/auth/auth-jwt.cjs:22-27` returns only an identity (`id`/`name`/`email`/`color`) — no room-scoped claim — and no caller maps a user to the rooms they may touch. Any valid token reaches any room: enumerate (`GET /rooms`), read (`GET /rooms/:id/sec`, `/comments`), overwrite (`POST /rooms/:id/upload`), mutate (`PATCH`), delete (`DELETE`).

The public Render deployment (`render.yaml`, `SIM_AUTH_PROVIDER=none`) is a **demo only with no CUI** and stays intentionally open. This design targets a **real production deployment** with the decided shape: **SaaS, many separate orgs**, **private-by-default within an org**.

The room **lock** (`isLockBlocked`, `http-handler.cjs:76`) is not authorization: reads bypass it, it is advisory/write-only, and ownership is first-come, not a durable ACL.

## Scope

**In scope (this issue):**
- Tenant isolation between orgs.
- Private-by-default: a room is accessible only to its creator (owner) and an explicit share-set.
- Binary collaborator model: owner + shared users. Shared users get read+write; owner additionally gets delete + share-grant.

**Deferred to a separate issue:**
- Graded roles (viewer / editor / owner lattice). The binary owner + share-set is the security floor; graded permissions are a feature, not a security requirement, and must not block the fix.

## Keystone decision: one always-namespaced composite room key

Authorization data lives **outside the CRDT**, and tenant is threaded by making the **internal room key composite** — `(tenant, roomId)` — and **always namespaced**, including under `auth=none` via a sentinel tenant `_public`. There is exactly one key shape in the system; no flat-vs-prefixed fork.

This composite is the single key used by **every** subsystem that currently keys by the flat docName: the storage adapters, the WS docname, `boundDocs`, `ywsDocs`/`getYDoc`, `docLoadPromises`, `roomHealth`, and the migration coordinator (`migrate-pm-substrate.cjs`). Threading tenant through the persistence hooks (`bindState`/`flushRoom`/`readRoom`, which receive only a docName) is solved by carrying tenant *inside* the docName.

### Key representation

- **Logical identity:** the server holds `(tenant, roomId)` as two separately-sanitized fields. The client only ever sends/sees the bare `roomId`; the server attaches tenant from the validated token (or `_public` under `auth=none`).
- **Internal docName:** `<tenant>/<roomId>` (a structural `/` joining two already-sanitized halves). `extractDocName` builds this at WS upgrade from the stripped flat id plus the token tenant.
- **Storage key:** adapters take `(tenant, roomId, kind)` as first-class arguments. The structural `/` is a real path separator on local (`<dir>/<tenant>/<roomId>.<kind>`) and a virtual prefix on S3/Azure (`<tenant>/<roomId>/...`). Each half is sanitized independently with the existing `sanitize()`; the join is structural, so no `/` ever enters a sanitized half.
- **Sanitization of tenant:** `sanitize(tenant)` is applied at the boundary where tenant enters any key (Major 7 fix) — a hostile claim like `../` or `a/b` collapses to `_`-safe characters and cannot traverse or escape its namespace.

### Required code changes (this is the core of the work, not a "touch point")

- `server/storage-shared.cjs`: `sanitize()` unchanged (still strips `/`); key builders gain a tenant argument.
- `server/storage-local.cjs`, `storage-s3.cjs`, `storage-azure.cjs`: `_keyForArtifact(tenant, roomId, kind)`; `_parseActiveKey` returns `{ tenant, roomId }`; `_listKeys`/list gains a tenant-scoped primitive — **note the local backend's `_listKeys({prefix})` is `readdirSync` (a directory), not a string prefix** (Blocker 2), so the tenant-list primitive must be implemented per backend, not assumed uniform.
- `room-storage.cjs`: `readRoom`/`writeRoom`/`deleteRoom`/`listRooms`/`flushRoom`/`bindState` thread `(tenant, roomId)`; `listRooms` returns bare `roomId` (tenant stripped) and is filtered to the caller's tenant.
- `server/collab-server.cjs`: `extractDocName` produces the composite; all five in-memory maps + the migration coordinator key on the composite; the WS upgrade derives tenant from the token before any keying.
- `server/migrate-tenant-namespace.cjs`: one-time relocation of legacy flat artifacts under `<SIM_DEFAULT_TENANT>/<id>` + ACL sidecar (see Legacy).

## Decided architecture

### 1. Tenant + stable subject from the validated token

- `auth-jwt.cjs` extracts a tenant claim: `payload.tenant || payload.org || payload.tid` (Azure AD uses `tid`) and adds it to the returned identity (`req.user.tenant`).
- **Stable subject required (Major 8 fix):** the owner key derives from `payload.sub || payload.oid` only. Under `requiresAuth`, a token with no stable subject (would fall back to `email` or `'unknown'`) → **403**. The `email`/`'unknown'` fallback in `auth-jwt.cjs:23` must NOT reach the authz/owner path — otherwise distinct users collapse to one `ownerId`. (`name`/`email` may still populate display identity.)
- Auth on (`requiresAuth`) **and no tenant claim → 403** at both gates (HTTP `:142` and WS upgrade `collab-server.cjs:334`).
- Token issuance stays the deployer's IdP — out of scope. The required claims (tenant + stable subject) are documented.
- Tenant and owner are read **only** from `req.user` (the validated token), never from `X-Actor-Id` / `?actorId=` / request body. The `getActorId` header/query fallback (`http-handler.cjs:64-71`) must not be copied into the authz path.

### 2. ACL sidecar artifact

- New artifact in `ARTIFACT_CATALOG` (`storage-shared.cjs:44-49`): `<tenant>/<roomId>.acl.json` = `{ "ownerId": "<sub>", "sharedWith": ["<sub>", ...] }`.
- Read cheaply (small JSON, no Y.Doc decode) before loading/binding the room — no decode-DoS, no WS eviction-race ordering paradox.
- **Crash-order (Major 5 fix, amends ADR-0005):** `.acl.json` is positioned in `ARTIFACT_CATALOG` **before** `.ydoc` so `.ydoc` remains the catalog tail / source-of-truth. A crash between writes leaves the room **absent** (no `.ydoc` → `readRoom` null → 404) rather than an ownerless/hijackable room. `deleteRoom`/`archiveRoom`/`quarantineRoom`/`restoreRoom` already iterate the catalog, so the sidecar rides along automatically; the S3 quarantine path (`storage-s3.cjs:144`, currently `.ydoc`-only) must be extended to include the sidecar.
- **Not** stored in `yMeta` (avoids the `yMeta.size===0` seed-gate break at `collab.js:962` and the per-request 8MB decode).

### 3. `authorize(user, tenant, roomId, action)` hook

Runs after authentication on every `/rooms*` route, and at WS upgrade.

- **Gate on `requiresAuth`:** when `!authProvider.requiresAuth`, `authorize()` early-returns allow — the demo (`auth=none`) stays fully open under the `_public` sentinel tenant. Mirrors the existing `if (authProvider?.requiresAuth)` gate at `:142`.
- Resolve the ACL sidecar for `(user.tenant, roomId)`. **Cross-tenant access is structural:** the key is built from the caller's own tenant, so a caller can only ever address rooms in their own namespace.
- **Missing ACL/room → 404** (hide existence; never 403 on a room the caller can't see).
- **Within tenant:**
  - read + write (open via WS, `GET /sec`, `GET /comments`, `POST /upload`, content `PATCH`): `ownerId === user.id` OR `user.id ∈ sharedWith`.
  - delete, share-grant, lock-admin: `ownerId === user.id` only.
  - Not owner and not shared → 404.
- **Live-session revocation (Moderate 10):** `authorize()` runs at every WS upgrade unconditionally (not skipped when the doc is already resident). Share-removal takes effect on the sharee's **next connect**; an already-open WS session is not force-disconnected. This is an accepted limitation, documented in ADR-0015.

### 4. Room create + share

- `POST /rooms` (`http-handler.cjs:287`): under `requiresAuth`, key the room under `(req.user.tenant, roomId)` and write the ACL sidecar `{ ownerId: req.user.id, sharedWith: [] }` **before** the `.ydoc` (crash-order above). The Y.Doc / `yMeta` create path is otherwise unchanged (tenant is NOT written into `yMeta`). The existing `409 already exists` check is now per-tenant, so it no longer leaks cross-tenant existence.
- **Share route (floor, in scope):** `PATCH /rooms/:id/share`, body `{ userId, action: 'add' | 'remove' }`, **owner-only**. Mutates `sharedWith` in the sidecar.
  - **Same-tenant is enforced structurally, not by the route (Major 9 resolution):** the room lives under the owner's tenant namespace; a sharee can only reach it if their own token's tenant matches, so a cross-tenant `userId` is inert — it can never resolve the room. The route therefore stores the opaque `userId` as-is and does not attempt a tenant check it cannot perform.
  - **Discovery limitation (documented):** there is no user-directory endpoint, so an owner must already know the sharee's subject id. Share-by-email and an email→subject directory are **out of scope** for the floor and noted as a follow-up. This makes the floor's sharing usable only with known subject ids — acceptable for the security fix, flagged in ADR-0015.

### 5. Enforcement points (all required, or it leaks)

- HTTP: every `/rooms*` route — explicitly including `GET /rooms/:id/sec`, `GET /rooms/:id/comments`, `POST /rooms/:id/upload`, `DELETE`, `PATCH`, and the new share route.
- WS upgrade (`collab-server.cjs:333-407`): authorize from the cheap sidecar **before** `getYDoc`/preload, so an unauthorized caller never triggers a doc load — sidesteps the eviction-guard await windows (ADR-0014 pattern #2). authorize is unconditional, never skipped because the doc is already resident.
- `GET /rooms` (`:441-506`): filtered to the caller's tenant via the per-backend tenant-list primitive. **Also enumerates live in-memory `boundDocs`** — those are now keyed by the composite docName, so the same tenant filter applies; verify both the storage list and the live-doc list are tenant-filtered (no leak via resident docs).
- `PATCH /rooms/:id` lock fields and the share route derive the actor from `req.user`, never the request body (`http-handler.cjs:405` currently trusts body `lockedBy`).
- `/health` (`http-handler.cjs:111-138`): stays unauthenticated, but **redact `unhealthyRooms` names** (the `unhealthyRooms.push` is in `http-handler.cjs:115`) when `requiresAuth` — room ids are cross-tenant data. Return counts only, or omit names. (`rooms.active`/`rooms.connections` are counts and are fine.)

### 6. Errors

- Unauthenticated → 401 (resource exists, you need a token).
- Authenticated but unauthorized (cross-tenant by construction, not-shared, missing ACL) → 404 (no existence leak).
- Missing tenant claim or missing stable subject under `requiresAuth` → 403.
- Lock conflict → existing 423.

### 7. Legacy / migration

- **Demo (`auth=none`):** unaffected — runs under the `_public` sentinel tenant; `authorize()` is inert. Existing demo/dev rooms must be relocated under `_public/` by the migration (or the migration treats unprefixed legacy keys as `_public` implicitly).
- **A deploy turning auth on with pre-existing rooms:** rooms without a tenant namespace / ACL sidecar are unreachable (404) by design. `server/migrate-tenant-namespace.cjs`, gated by `SIM_DEFAULT_TENANT` + `SIM_DEFAULT_OWNER`, relocates `<id>.*` artifacts under `<tenant>/<id>.*` and writes an ACL sidecar with the default owner. Document that auth-on deployments either start fresh or run this migration once.

## Testing

Verified current counts: `http-endpoints.test.mjs` is at **25** `it()` (cap 30 — 5 slots, but batch where natural); `storage-contract.test.mjs` is **17 `it()` × 3 backends**.

- `http-endpoints.test.mjs`: cross-tenant `GET/DELETE/PATCH` → 404; owner `DELETE` → 200; non-owner same-tenant `DELETE` → 404; `GET /rooms` returns only the caller's tenant (storage + live-doc); missing-tenant-claim → 403; missing-stable-subject → 403; hostile tenant claim (`../`) is sanitized and cannot escape; share route owner-only; shared user can read+write but not delete.
- `collab-server.test.mjs`: WS upgrade rejects cross-tenant / unshared before doc load; missing-claim → 403; composite docName keys all in-memory maps; eviction guard still holds with the new pre-load authz read.
- `storage-contract.test.mjs` (17 → +1 × 3): the `.acl.json` artifact round-trips; composite `(tenant, roomId)` keys list/read/write/delete uniformly; `listRooms` strips tenant and returns bare ids; crash-order (acl-before-ydoc) leaves a partial create as absent.
- Demo regression: with `auth=none`, all routes stay open under `_public`.

## Docs

- New **ADR-0015 — Room authorization model**: composite always-namespaced key + `_public` sentinel, ACL sidecar substrate (and why not `yMeta`), private-by-default, 404-not-403 existence semantics, structural cross-tenant isolation, live-session revocation limitation, required JWT claims (tenant + stable subject), share-discovery limitation, demo `auth=none` intentionally open, deferred graded-roles boundary.
- Amend **ADR-0005** (per-backend atomicity): `.acl.json` write-order (before `.ydoc`) and the crash-consistency outcome — this is the "sidecar becomes a source of truth that must agree with `.ydoc`" revisit-trigger ADR-0005 names.
- Amend **ADR-0013** (storage backends): the `.acl.json` artifact and the composite `(tenant, roomId)` key scheme + per-backend tenant-list primitive.
- Amend **ADR-0014** (collab relay): composite docName across the in-memory maps + coordinator; WS-upgrade authz ordering relative to the eviction guard.
- `csp.test.js` (`:37-42`) gates the frontend origin allowlist, not server authz — no change; do not conflate.

## Out of scope

- Token issuance / IdP integration (deployer-owned).
- Graded viewer/editor/owner roles (separate issue).
- User-directory / share-by-email discovery (follow-up).
- Live-session force-revocation on share-removal.
- Any change to the demo's open posture.
