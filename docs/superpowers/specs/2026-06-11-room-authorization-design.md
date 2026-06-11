# Room Authorization — Multi-Tenant Isolation + Private-by-Default

**Issue:** [#211](https://github.com/mttvnst-HA/secwriter/issues/211)
**Date:** 2026-06-11
**Status:** Design approved, pending spec review

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

## Decided architecture

Approach A, revised after independent review. The keystone correction: **authorization data lives outside the CRDT**, in cheap storage-layer artifacts read before the `.ydoc` is decoded.

### 1. Tenant from the validated token

- `auth-jwt.cjs` extracts a tenant claim: `payload.tenant || payload.org || payload.tid` (Azure AD uses `tid`) and adds it to the returned identity (`req.user.tenant`).
- Auth on (`requiresAuth`) **and no tenant claim → 403** at both gates (HTTP `:142` and WS upgrade `collab-server.cjs:334`). A tenantless token cannot be scoped.
- Token issuance stays the deployer's IdP — out of scope. The required claim is documented.
- Tenant and owner are read **only** from `req.user` (the validated token), never from `X-Actor-Id` / `?actorId=` / request body. The `getActorId` header/query fallback (`http-handler.cjs:64-71`) must not be copied into the authz path.

### 2. Tenant-namespaced storage keys

- Storage key for a room becomes `<tenant>/<roomId>` when `requiresAuth`; legacy flat `<roomId>` when `!requiresAuth` (preserves the demo and existing dev rooms).
- Fixes cross-tenant id collision and overwrite: two orgs may both name a room `spec1` without colliding.
- Eliminates the `POST /rooms` 409 cross-tenant existence leak — existence is now per-tenant.
- `GET /rooms` filters cheaply via the existing prefix-capable list (`room-storage.cjs:98-106`, `_listKeys({prefix: tenant + '/'})`) — no decode of other tenants' rooms.
- Touch points: `sanitize` / key derivation in the storage adapters, `extractDocName` and the `/ws/` strip + `getYDoc` name in `collab-server.cjs`, `_parseActiveKey` (`storage-local.cjs:150`). The room id the client sees stays unprefixed; the prefix is applied server-side from the authenticated tenant.

### 3. ACL sidecar artifact

- New artifact in `ARTIFACT_CATALOG` (`storage-shared.cjs`): `<tenant>/<roomId>.acl.json` = `{ "ownerId": "<sub>", "sharedWith": ["<sub>", ...] }`.
- Read cheaply (small JSON, no Y.Doc decode) before loading/binding the room — no decode-DoS, no WS eviction-race ordering paradox.
- Written in one funnel on room create; updated by the share route. **Not** stored in `yMeta` (avoids breaking the `yMeta.size===0` seed gate at `collab.js:962` and the per-request 8MB decode).

### 4. `authorize(user, roomId, action)` hook

Runs after authentication on every `/rooms*` route, and at WS upgrade.

- **Gate on `requiresAuth`:** when `!authProvider.requiresAuth`, `authorize()` early-returns allow — the demo (`auth=none`, anonymous identity, no tenant) stays fully open. Mirrors the existing `if (authProvider?.requiresAuth)` gate.
- Resolve the ACL sidecar for `<user.tenant>/<roomId>`.
- **Cross-tenant or missing ACL/room → 404** (hide existence; never 403 on a room the caller can't see).
- **Within tenant:**
  - read + write (open via WS, `GET /sec`, `GET /comments`, `POST /upload`, content `PATCH`): `ownerId === user.id` OR `user.id ∈ sharedWith`.
  - delete, share-grant, lock-admin: `ownerId === user.id` only.
  - Not owner and not shared → 404.

### 5. Room create + share

- `POST /rooms` (`http-handler.cjs:287`): under `requiresAuth`, stamp the storage key with the tenant prefix and write the ACL sidecar `{ ownerId: req.user.id, sharedWith: [] }`. The Y.Doc / `yMeta` create path is unchanged (tenant is NOT written into `yMeta`).
- **Share route (floor, in scope):** `PATCH /rooms/:id/share`, body `{ userId, action: 'add' | 'remove' }`, **owner-only**, target must be same tenant. Mutates `sharedWith` in the sidecar. This is the minimal grant mechanism that keeps collaboration working under private-by-default — without it, only the creator could ever open a room.

### 6. Enforcement points (all required, or it leaks)

- HTTP: every `/rooms*` route — explicitly including `GET /rooms/:id/sec`, `GET /rooms/:id/comments`, `POST /rooms/:id/upload`, `DELETE`, `PATCH`, and the new share route.
- WS upgrade (`collab-server.cjs:334-340`): authorize from the cheap sidecar **before** `getYDoc`/preload, so an unauthorized caller never triggers a doc load. This is why the ACL must be a cheap read (decision 3) — it sidesteps the eviction-guard await windows (ADR-0014 pattern #2).
- `GET /rooms`: filtered to the caller's tenant via key prefix (decision 2).
- `PATCH /rooms/:id` lock fields and the share route derive the actor from `req.user`, never the request body (`http-handler.cjs:405` currently trusts body `lockedBy`).
- `/health`: stays unauthenticated, but **redact `unhealthyRooms` names** (`collab-server.cjs:115`) when `requiresAuth` — room ids are cross-tenant data. Return counts only, or omit names.

### 7. Errors

- Unauthenticated → 401 (resource exists, you need a token).
- Authenticated but unauthorized (cross-tenant, not-shared, missing ACL) → 404 (no existence leak).
- Missing tenant claim under `requiresAuth` → 403.
- Lock conflict → existing 423.

### 8. Legacy / migration

- **Demo (`auth=none`):** unaffected — `authorize()` is inert, keys stay flat.
- **A deploy turning auth on with pre-existing flat-key rooms:** rooms without a tenant prefix / ACL sidecar are unreachable (404) by design. Provide a one-time migration: `server/migrate-tenant-namespace.cjs` gated by `SIM_DEFAULT_TENANT` + `SIM_DEFAULT_OWNER` env, relocating `<id>.*` artifacts under `<tenant>/<id>.*` and writing an ACL sidecar with the default owner. Document that auth-on deployments either start fresh or run this migration once. Without it, enabling auth silently bricks existing rooms (the reviewer's M3).

## Testing

- `server/__tests__/http-endpoints.test.mjs` (currently 27 `it()`, cap 30 — batch): cross-tenant `GET/DELETE/PATCH` → 404; owner `DELETE` → 200; non-owner same-tenant `DELETE` → 404; `GET /rooms` returns only the caller's tenant; missing-tenant-claim → 403; share route owner-only + same-tenant; shared user can read+write but not delete.
- `server/__tests__/collab-server.test.mjs`: WS upgrade rejects cross-tenant / unshared before doc load; missing-claim → 403; eviction guard still holds with the new pre-load authz read.
- `server/__tests__/storage-contract.test.mjs` (12 × 3 backends): the new `.acl.json` artifact round-trips and tenant-prefixed keys list/read/write/delete uniformly across local/azure/s3.
- Demo regression: with `auth=none`, all routes stay open and keys stay flat.

## Docs

- New **ADR-0015 — Room authorization model**: tenant-namespaced keys, ACL sidecar substrate (and why not `yMeta`), private-by-default, 404-not-403 existence semantics, required JWT tenant claim, demo `auth=none` intentionally open, deferred graded-roles boundary.
- Amend **ADR-0013** (storage backends): the `.acl.json` artifact in `ARTIFACT_CATALOG` and tenant-prefixed keys.
- Amend **ADR-0014** (collab relay): WS-upgrade authz ordering relative to the eviction guard.
- `csp.test.js` (`:37-42`) gates the frontend origin allowlist, not server authz — no change needed; do not conflate with this work.

## Out of scope

- Token issuance / IdP integration (deployer-owned).
- Graded viewer/editor/owner roles (separate issue).
- Any change to the demo's open posture.
