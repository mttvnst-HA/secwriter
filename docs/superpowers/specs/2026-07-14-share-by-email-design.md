# Share-by-email room sharing (issue #267) — design

**Date:** 2026-07-14
**Issue:** [#267](https://github.com/mttvnst-HA/secwriter/issues/267) — user-directory / share-by-email discovery, out-of-scope follow-up from [#239](https://github.com/mttvnst-HA/secwriter/issues/239).
**Depends on:** [ADR-0017](../../adr/0017-room-authorization-model.md) (room authorization, `.acl.json` sidecar, uniform-404 no-leak discipline, single-instance precondition).

## Problem

Room sharing grants access by opaque subject id (JWT `sub`/`oid`). An owner has
no way to resolve or discover another user's identity — they must obtain the raw
subject id out of band. #239 deferred a human-resolvable share affordance to this
issue.

## Locked decisions (from brainstorming)

1. **No tenant-wide user directory.** The owner types a full email; there is no
   typeahead/autocomplete of colleagues. This deliberately drops the "self-built
   directory" idea — pending-invite (below) covers every case autocomplete would,
   and a tenant-wide `email→sub` index is all cost (storage-layer misfit, per-login
   write amplification, a within-tenant PII/enumeration oracle) with no correctness
   benefit here. If autocomplete ever becomes a hard requirement it is a separate,
   deliberately-built follow-up (append-only, deletion-aware, CAS-written, gated
   read endpoint) — explicitly **out of scope** for #267.
2. **Share-by-email creates a pending invite** bound to the subject id at that
   user's **first login after the invite**, not rejected. Binding resolves to the
   **sub that actually authenticates** under that email — it self-corrects *which
   sub* it writes, NOT *which human* gets in. Under the email-reuse hazard it binds
   whoever currently holds the email at the IdP (see decision #5 + the rejected-
   alternative section); it does not clean up a departed sub's stale `roles` entry.
   "Self-correcting" is scoped to sub-resolution only; do not read it as reuse-safe.
3. **Email is never an ACL grant key.** `roles` stays keyed by stable subject id;
   `roleOf` is unchanged. Email appears only transiently in `pending` and as
   display metadata.
5. **Email is an authorization INPUT — this reverses ADR-0017 decision 6, and is
   safe only under a hard precondition.** ADR-0017 kept email out of identity/authz
   because email is not reliable identity. This feature puts email back into the
   *grant* decision (`resolveRole` matches on `user.email` before any bind persists),
   so it is safe **only** when the IdP issues `email` as a **verified, immutable,
   unique-per-subject** claim in the signed token. That is the "typical enterprise
   IdP / no email reassignment" assumption locked in brainstorming — stated here as
   a HARD PRECONDITION, not an aside. Enforcement: `resolveRole` and `onAuthenticate`
   treat a **missing/empty `user.email`** as "no pending match" (never bind on a
   blank email); the token signature is already validated upstream (`auth-jwt.cjs`).
   If a tenant's IdP does NOT guarantee verified-unique-immutable email, share-by-
   email is a same-tenant privilege-escalation vector and MUST be disabled for that
   deployment. The ADR amendment documents why this reversal is acceptable and under
   what IdP guarantee.
4. **Pending invites expire.** A pending entry older than a TTL is treated as
   absent (never binds) and pruned opportunistically. This is hygiene, not a
   reuse-guard (email reuse is out of the threat model per the IdP assumption) —
   a mistyped or forgotten invite must not linger forever. TTL is configurable via
   `SIM_PENDING_INVITE_TTL_MS` (default 30 days). Enforcement is **lazy**:
   `resolveRole` / `promotePending` compare `now - Date.parse(invitedAt)` against
   the TTL; expired entries do not resolve and are dropped on the next ACL write
   that touches the room. No dedicated sweep is required (the existing revoke sweep
   MAY prune them as a backstop — see Testing/out-of-scope).

## Why the rejected alternative (per-tenant directory + immediate grant) is wrong

Recorded so a future reader does not re-propose it.

- **Security defect on email reuse.** A self-built `email→sub` directory has no
  IdP authority. If `alice@x.com` is reassigned from a departed employee (sub A)
  to a new hire (sub B), the directory still maps `alice@x.com → A` until B logs
  in. An "immediate grant on directory hit" writes `roles[A]=role` — granting the
  departed identity and NOT the new hire. Pending-bind-at-login avoids this by
  binding to the sub that actually authenticates.
- **Storage-layer misfit.** Storage keys strictly on `(tenant, roomId, kind)`
  (`_keyForArtifact` in each adapter). A per-tenant, no-roomId `_directory.json`
  cannot be an `ARTIFACT_CATALOG` kind (that would make every room write/delete/
  archive fan out a directory sidecar) and needs bespoke `readDirectory`/
  `writeDirectory` plumbing across all three backends + the 3-backend contract
  test. It also has no lifecycle owner (grows unbounded).
- **Write amplification / lost updates.** Merge-writing one shared per-tenant blob
  on authed requests is a read-modify-write with no compare-and-set; concurrent
  logins lose entries (`writeAcl`/`_putBytes` is a full-object overwrite).
- **Layering violation.** Writing storage inside `authorize()` breaks its
  pure-read contract, runs on read-only routes, misses the WS path entirely
  (`onAuthenticate` never calls `authorize()`), and races the owner's ACL writes.

## Design — pending-only, per-room, bind-at-connect

No new storage artifact. Everything rides the existing per-room `.acl.json`, so
the crash-order invariant (`.acl.json` before `.ydoc`), the `writeAclIfAbsent`
atomic create-claim, and the delete/archive/migrate catalog fan-out are all
unchanged.

### `.acl.json` shape

```jsonc
{
  "ownerId": "<sub>",
  "roles":   { "<sub>": "viewer" | "editor" },        // unchanged; roleOf() untouched
  "pending": {                                         // NEW — invites not yet bound
    "<lowercased-email>": {
      "role": "viewer" | "editor",
      "invitedBy": "<owner-sub>",
      "invitedAt": "<iso-8601>"
    }
  },
  "display": {                                         // NEW — cosmetic name cache, room-scoped
    "<sub>": { "name": "<display name>", "email": "<lowercased-email>" }
  }
}
```

- `roles` semantics and `roleOf()` are byte-for-byte unchanged, BUT **the
  `GET /rooms` listing filter moves from `roleOf`/`aclAllowsRead` to `resolveRole`
  (seam 5)** — so a room a caller is PENDING-invited to (matching their token
  email) DOES appear in their own listing, badged "invited". There is **no
  listing/authorize asymmetry**: WS connect, per-room `authorize()`, AND the tenant
  listing all use the one `resolveRole` decision (pending included). This is the
  option-1 fix for the discoverability dead-end (an invitee had no in-app path to
  the room they were invited to). It costs ZERO extra I/O — `GET /rooms` already
  reads every room's `.acl.json` per call for the #239 member filter
  (`http-handler.cjs`), so the caller's ACL is already deserialized in memory and
  `req.user.email` is already present; the change is a one-predicate swap on data
  in hand, NOT a per-tenant email index (the rejected directory stays rejected). It
  does NOT weaken the per-room 404 for genuine non-members: no pending entry AND no
  `roles` entry → `resolveRole` returns null → excluded from the listing and 404 on
  direct access, exactly as before. The only rows added are the caller's OWN invites,
  which `resolveRole` already grants that caller — no cross-principal leak.
- `pending` and `display` only ever contain principals relevant to THIS room —
  no tenant-wide index, no cross-room aggregation, no `seenAt` activity trail.
- `display[sub]` is **cosmetic and self-asserted** — its `name`/`email` come from
  the connecting user's own validated token and NEVER feed authorization (`roles`
  is sub-keyed, `resolveRole` reads `pending`+`roles` only). A user can only write
  their OWN `display[user.id]` (promote writes that key alone), so no cross-user
  poisoning; worst case is a misleading name the owner sees in the dialog. Do not
  let `display` influence any access decision.
- Both keys are additive and optional; a #211/#239 sidecar with neither reads
  identically to today.

### Load-bearing invariant: every ACL writer is a full-object read-modify-write

`writeAcl` is a **full-object overwrite** (`room-storage.cjs`: `JSON.stringify(acl)`).
There is no partial/merge write. Therefore EVERY site that writes `.acl.json` —
the existing raw-sub share branch, the new email branch, and `promotePending` —
MUST read the current ACL and write back the COMPLETE object (`ownerId` + `roles` +
`pending` + `display`), never a freshly-constructed `{ ownerId, roles }`.
**`GET /:id/acl` stays strictly READ-ONLY (no normalization write-back)** — any
write there would be a fourth, unserialized RMW site that could lose an update
racing share/promote. Normalize in-memory for the response only; never persist from
the read path. The two content writers (share, promote) are the only ACL RMW
writers and both run under the shared mutex (seam 4); `writeAclIfAbsent` (create-
claim) and the delete path (tombstone) are separate, as noted in seam 4. The current raw-sub branch in
`PATCH /:id/share` rebuilds `{ ownerId: acl.ownerId, roles }` from scratch; left
as-is it would silently delete all pending invites and cached display names on
every add/remove/role-change. **This branch must be changed** to preserve
`acl.pending` and `acl.display`. (The rejected "additive, needs no code change"
reading was wrong — additive to the *shape*, but every writer must be made
`pending`/`display`-aware.) Pinned by a regression test (see Testing).

### Seams (where the code goes)

1. **Share route — `PATCH /rooms/:roomId/share` (`server/http-handler.cjs`).**
   Body extends to accept an email variant alongside the existing
   `{ userId, action, role }`:
   - `{ email, action: 'add', role? }` → normalize `lower(trim(email))`, write
     `pending[email] = { role: role || 'editor', invitedBy: req.user.id, invitedAt }`.
     Reject a malformed email (basic shape check) with 400. `role` restricted to
     `viewer`/`editor` (reuse `GRANTABLE_ROLES`). **Cap (major #6):** reject with
     429/400 when `Object.keys(acl.pending).length >= MAX_PENDING_INVITES`
     (constant in `authorize.cjs`, default 200) — a per-room bound so an owner can't
     grow `.acl.json` without limit. Prune expired entries first (so the cap counts
     only live invites). See also the ACL-size guard below.
   - `{ email, action: 'remove' }` → delete `pending[email]`, then **kick any live
     session that email currently grants (major #4).** A pending invite is not a
     `roles` subject, so the existing `#268` remove path does NOT revoke it. Because
     the sub the email is bound to is unknown until connect, the removal calls
     `revokeLiveSessions(tenant, roomId, { emails: [email] })` — a new selector
     alongside the existing `{ subjects }`: it closes any live connection whose
     `conn.context.user.email` (normalized) matches, forcing a reconnect →
     re-`onAuthenticate` → `resolveRole` now finds no pending → 404. Without this,
     an owner has no handle to revoke a `viaPending`-granted session (see the
     unrevocable-session hazard the design review raised).
   - The existing `{ userId, ... }` (raw-sub) branch keeps its behavior but MUST
     be changed to preserve `acl.pending` + `acl.display` on write-back (see the
     full-object-RMW invariant above) — it currently rebuilds a partial
     `{ ownerId, roles }` that would wipe them.
   - All email/sub normalization goes through a single `normalizeEmail(s)` helper
     (`lower(trim(s))`) exported from `authorize.cjs`, reused by the share write,
     `resolveRole`, and `promotePending`, so a casing mismatch can't silently
     break binding (`auth-jwt.cjs` does NOT lowercase `email`).
   - Still owner-only (`ACTION.SHARE`), still the low-frequency single writer.
   - Email `add` ALWAYS succeeds (stored pending) regardless of whether the email
     is a real org member → no lookup oracle, no existence leak. Matches
     ADR-0017's 404/no-leak posture.

2. **Pure decision — `resolveRole(acl, user, now, ttlMs)` in `server/auth/authorize.cjs`.**
   Returns `{ role, viaPending }`. Let `bound = roleOf(acl, user.id)` (may be null)
   and `pend = <non-expired pending entry matching normalizeEmail(user.email)>`
   (null if no email, no match, or expired):
   - **Email-presence guard (blocker #1 enforcement):** if `user.email` is missing
     or empty, `pend` is null unconditionally — never bind on a blank email.
   - If both null → `{ role: null, viaPending: false }`.
   - If `bound` non-null and `pend` null → `{ role: bound, viaPending: false }`.
   - If `pend` non-null → take the **higher of `bound` and `pend.role`** on the
     `editor > viewer` lattice (reuse the `ROLE_ACTIONS`/lattice ordering). If the
     pending role wins (invitee unbound, OR bound lower than the invite) →
     `{ role: <higher>, viaPending: true }`. If `bound` is ≥ the pending role →
     `{ role: bound, viaPending: false }` (pending is redundant; `promotePending`
     drops it). This closes major #5 (silent no-upgrade): an owner who invites an
     already-bound viewer as editor actually upgrades them.
   - Expiry: `pend` requires `now - Date.parse(invitedAt) < ttlMs`. A missing or
     unparseable `invitedAt`, or a **non-finite `now - invitedAt`**, is treated as
     expired (fail-closed); a **future `invitedAt`** (`age < 0`) is ALSO treated as
     expired (defensive against a backward clock step).
   `resolveRole` takes `now` + `ttlMs` as params (kept pure/testable — no clock or
   env read inside). **`ttlMs` sourcing:** a single `pendingInviteTtlMs()` reader in
   `authorize.cjs` parses `SIM_PENDING_INVITE_TTL_MS` once, **validates at boot**
   (non-finite / ≤ 0 → log a loud error and fall back to the 30-day default, never
   silently disable sharing — closes the TTL=0/NaN silent-failure minor), and is
   called by both HTTP and WS callers. `authorize()` (HTTP) reads `Date.now()` +
   `pendingInviteTtlMs()` internally and feeds them to `resolveRole` — routes do NOT
   thread them (the purity boundary stays at `resolveRole`; `authorize()` is the
   impure adapter). Pure (no storage writes). `authorize()` uses `resolveRole` in
   place of the bare `roleOf` call for its capability check, so a pending invitee
   passes READ/WRITE over HTTP immediately (before the connect-time bind persists).
   **`hocuspocus-auth.cjs` `onAuthenticate` must switch BOTH the `aclAllowsRead`
   admit-gate AND the `role`/`readOnly` computation to `resolveRole`** — a pending
   invitee has no `roles` entry, so the current `aclAllowsRead(acl, user.id)` gate
   (roleOf-based, throws 404 `not-shared`) rejects them *before* the role logic runs.
   One code path for both transports, closing the WS gap the rejected design had.

3. **Connect-time persist — `promotePending(storage, tenant, roomId, user, lock)`
   (new helper; called ONLY from `onAuthenticate` in `server/collab-server.cjs`).**
   Once per session per room — not per keystroke, not per HTTP request. Under the
   per-composite-key mutex (seam 4), read the ACL and, if anything changed, write
   the COMPLETE object back once (full-object-RMW invariant):
   - **Delete-race guard — tombstone check, NOT just a read-time null-guard
     (blocker #2 fix).** The read-time null-guard ("if `readAcl` null, write nothing")
     is necessary but **does NOT close the race** — the earlier spec claim that it
     did was wrong. The dangerous interleave is write-time: promote reads a LIVE ACL
     (non-null) → `deleteRoomTransactionally` runs `storage.deleteRoom` (removes
     `.acl.json` LAST, `room-storage.cjs`) → promote writes the object back →
     **orphan `.acl.json` resurrected after `.ydoc` is gone**, the exact crash-order
     violation ADR-0017 decision 4 defends against, and it blocks room-id recreation
     (`POST /rooms` 409s on the existing-ACL check). The `markDeleted` tombstone only
     no-ops `SecWriterDatabase.store` (the ydoc path) — it does NOT guard `writeAcl`.
     **Fix:** the promote write-back is gated on the delete tombstone the SAME way
     `store()` is — `promotePending` (and any acl write it does) checks
     `isDeleted(compositeKey)` (the `SecWriterDatabase` tombstone predicate, threaded
     in) immediately before `writeAcl`, INSIDE the mutex, and skips the write if the
     room is tombstoned. Because `beginRoomDeletion` sets the tombstone BEFORE
     `storage.deleteRoom`, a promote that acquires the mutex after `beginRoomDeletion`
     sees the tombstone and no-ops; a promote already past the check races only the
     narrow window before `beginRoomDeletion`, and the read-time null-guard covers
     the delete-then-read ordering. Keep the null-guard too (cheap, covers the other
     ordering). State plainly: **tombstone check + null-guard together** close the
     race; the mutex alone does not (delete is not under the ACL mutex).
   - **Prune expired pending entries** (`now - Date.parse(invitedAt) >= ttlMs`, or
     unparseable `invitedAt`) — delete them; count as a change that triggers the
     write-back. This is the opportunistic garbage collection for stale invites.
   - If `pending[normalizeEmail(user.email)]` exists and is **not expired**: bind
     OR upgrade, then delete the pending entry. Bind: if `user.id` not in `roles`,
     `roles[user.id] = <entry>.role`. Upgrade (major #5): if `user.id` IS in `roles`
     but the pending role is HIGHER on the `editor > viewer` lattice,
     `roles[user.id] = <entry>.role`. If the bound role already ≥ the pending role,
     just drop the redundant pending entry (no role change). (Bind resolves to the
     authenticating sub → self-correcting on the sub, per decision #2.) An expired
     entry for THIS user is dropped by the prune step above, not bound.
   - Refresh `display[user.id] = { name: user.name, email: normalizeEmail(user.email) }`
     whenever it differs from what's stored — so every authed member (whether
     bound via pending or added by raw sub) gets a human name cached, gated on
     "changed" to avoid a rewrite every session.
   - If neither the promotion nor the display refresh changes anything, write
     nothing (no-op — avoids per-session ACL churn).
   - **Fire-and-forget:** `promotePending` MUST NOT block the `onAuthenticate`
     decision — the role/`readOnly` verdict comes from `resolveRole` (seam 2),
     which already covers the pending invitee. Run the persist detached (log on
     failure); a revoke-sweep reconnect storm then serializes the write-backs
     under the mutex without stalling connects. The bind is idempotent, so a
     dropped/retried persist re-converges on the next connect.

4. **Serialize ACL read-modify-write via ONE shared mutex.** `promotePending`
   (in `collab-server.cjs`) and the share route (in `http-handler.cjs`) both do
   read-modify-write on one `.acl.json` with no cross-backend CAS. They must share
   a SINGLE `Map<compositeKey, Promise>` chain (same shape as
   `SecWriterDatabase._storeChains`) — two separate Maps in two modules is not a
   mutex. **Ownership + wiring:** create the Map in `collab-server.cjs` and thread
   it into `createHttpHandler(...)` exactly like `flushRoom`, `revokeLiveSessions`,
   and `deleteRoomTransactionally` already are; the share route acquires the same
   `withAclLock(compositeKey, fn)` seam `promotePending` uses. Scope note: this
   mutex serializes ACL *content* writers (share + promote); it does NOT cover
   `writeAclIfAbsent` (the create-claim is atomic at the backend already) nor the
   delete path (tombstone-based — see the null-guard in seam 3). This is
   **single-instance-bound** — the same precondition ADR-0017 already documents
   for the `documents` map, the revoke sweep, and store re-entrancy. Document it
   with the same footnote; a multi-instance move needs a distributed lock here too.

5. **Owner UI + room listing — `GET /rooms`, `GET /rooms/:roomId/acl`,
   `ShareDialog.jsx`.**
   - **`GET /rooms` listing filter → `resolveRole` (option-1 discoverability fix).**
     The listing loop already does a per-room `readAcl` + `aclAllowsRead(acl,
     user.id)` member filter (`http-handler.cjs`); swap that predicate to
     `resolveRole(acl, req.user, Date.now(), pendingInviteTtlMs()).role !== null`
     and derive each row's `role` + a `viaPending`/"invited" flag from the same
     call (in place of the separate `roleOf` role read). A caller's PENDING-invited
     rooms now appear in their own listing badged "invited"; genuine non-members
     stay excluded (null role). No extra I/O (ACL already loaded in the loop), no
     directory. This retires the listing/authorize asymmetry — one `resolveRole`
     decision across WS connect, `authorize()`, and the listing.
   - `GET /:id/acl` (owner-only, already exists) returns `pending` and `display`
     alongside the normalized `roles`.
   - `ShareDialog`: widen the component's `acl` state + `loadAcl` contract from
     `{ ownerId, roles }` to `{ ownerId, roles, pending, display }`. The
     add-collaborator input accepts an **email** (route to the email branch of the
     share route). Because an email `add` produces NO `roles` delta, the current
     `mutate()` optimistic `setAcl(roles)` update does not surface it — the email
     path must `refresh()` (re-fetch `GET /:id/acl`) after a successful mutation
     so the new pending entry appears. Pending invites render as their email string
     with role + a remove control, visually distinguished from bound collaborators
     (e.g. an "invited" tag). Bound collaborators render their `display[sub].name`
     (falling back to the raw sub id when `display` is absent). The existing
     raw-subject-id add path stays available (additive, not a replacement —
     acceptance criterion).
   - **"Copy room link" control (option-2 polish).** A button in `ShareDialog` that
     copies the current room's URL to the clipboard, so the owner can deliver it via
     whatever channel they already use (Teams/email/chat). Complementary to the
     listing fix — it eases owner-side delivery but is NOT what closes the invitee's
     in-app discovery (the listing swap does that). Near-zero cost; no token minting
     (a pending invitee is already reachable by room id via `resolveRole`, so the
     link is just the plain room URL).

6. **Revoke sweep is a THIRD role reader and MUST switch to `resolveRole`
   (major #3).** The periodic revoke sweep (`collab-server.cjs`, ~`revokeSweep`)
   currently computes `role = roleOf(acl, uid)` and hard-closes any socket whose
   role/`readOnly` disagrees with the current ACL. Under fire-and-forget promote a
   pending invitee connects (admitted via `resolveRole` in `onAuthenticate`) but has
   NO `roles` entry until the detached `promotePending` write lands — so `roleOf`
   returns null → the sweep sees them as stale → **hard-closes their socket every
   ~60s during the connect->persist window**, repeatedly if promote is slow/dropped.
   The sweep MUST use `resolveRole(acl, connUser, Date.now(), pendingInviteTtlMs())`
   (same signature as the other two readers) so a validly-pending session is not
   evicted. This makes a sweep change **required for correctness**, correcting the
   earlier out-of-scope framing. The sweep reads `conn.context.user` (id + email)
   per the `#268` reach already pinned by `hocuspocus-server.test.mjs`.

7. **Bound the ACL blob size (major #6, storage side).** `.ydoc` has an 8 MB
   pre-serialize cap; `.acl.json` has none. Beyond the per-room `MAX_PENDING_INVITES`
   count cap (seam 1), any `.acl.json` write (`writeAcl`) that would exceed a byte
   ceiling (`MAX_ACL_BYTES`, default 256 KB) is rejected — a defense against `display`
   accumulation + large pending sets degrading the hot connect path (every connect
   `JSON.stringify`s and RMWs the whole blob). A rejected promote write logs and
   no-ops (access still correct via `resolveRole`); a rejected share write returns
   400. `display` entries for removed members are pruned in the raw-sub remove branch
   to bound growth.

### Data flow (happy path)

1. Owner opens `ShareDialog`, types `bob@corp.com`, picks Editor, Add.
2. `PATCH /:id/share { email:'bob@corp.com', action:'add', role:'editor' }` →
   `pending['bob@corp.com'] = { role:'editor', invitedBy:<owner>, invitedAt }`.
3. Bob logs in. `GET /rooms` runs `resolveRole` over each room's ACL and finds
   `pending['bob@corp.com']` matching his token email → the room appears in Bob's
   listing badged "invited" (option-1 fix — no out-of-band link needed). Bob clicks
   it. `onAuthenticate`: `resolveRole` returns
   `{ role:'editor', viaPending:true }` → Bob connects read-write immediately.
   `promotePending` moves `pending['bob@corp.com']` → `roles[<bob-sub>]='editor'`,
   writes `display[<bob-sub>]={name:'Bob …', email:'bob@corp.com'}`.
4. Owner reopens the dialog: Bob now shows as a bound Editor with his name; the
   pending entry is gone.

## Error handling & edge cases

- **Malformed email** on share → 400 (basic shape check only; no MX/deliverability).
- **Unknown / never-logging-in email** → invite sits in `pending` until it
  expires (TTL, decision #4) or the owner revokes it manually. After expiry it
  resolves as absent (invitee would get 404) and is pruned on the next ACL write.
- **Invitee logs in AFTER expiry** → `resolveRole` returns null (expired), so they
  are NOT bound and see the room as a non-member (404). The owner must re-invite.
- **Cross-tenant email** → the pending entry is inert; it only binds when a token
  whose tenant matches the room authenticates with that email. Both transports gate
  tenant BEFORE `resolveRole` runs (`onAuthenticate` rejects a `documentName` whose
  tenant-half ≠ token tenant; HTTP derives tenant from the token, never the URL), so
  the same email in two tenants lives in two separately-keyed rooms and cannot
  collide. No cross-tenant leak, no signal to the owner that the email exists
  elsewhere. **Caveat:** the email key carries no tenant qualifier — it is safe only
  because of that pre-existing gate. This inherits and slightly widens ADR-0017's
  accepted `sanitize()` tenant-collision risk (two raw tenant strings collapsing to
  one namespace): if two orgs collide to one sanitized tenant, an email invite in
  org1's room could bind an org2 user sharing that email. Documented as an inherited,
  already-accepted risk, not a new one.
- **Already-bound user invited at a higher role by email** → `resolveRole` returns
  the higher of bound/pending (major #5); `promotePending` upgrades `roles[sub]` and
  drops the pending entry. An invite at an equal/lower role than the bound role is a
  redundant no-op pending entry, cleaned on next connect.
- **Perpetual `viaPending` (promote never persists)** → access role stays correct
  (`resolveRole` re-grants every connect) AND the room still appears in the user's
  `GET /rooms` listing (the listing filter is `resolveRole`-based too, seam 5), so
  discovery is unaffected; only `display[sub]` stays uncached (the owner sees the
  raw email/sub fallback instead of a name). The pending-remove kick (seam 1) is the
  owner's revoke handle; the fire-and-forget bind is idempotent and re-converges on
  any later connect, and the ACL-size/pending caps bound the un-pruned state.
- **Blank / missing email token claim** → `resolveRole` never matches pending
  (email-presence guard, decision #5); the principal gets only its `roles`-based
  role (or 404). auth=none demo has no email → pending path no-ops.
- **Email already bound** (sub already in `roles`) → `resolveRole` returns the
  real role first; `promotePending` skips the promotion (the `user.id not in
  roles` guard). A leftover pending entry for an already-bound user is cleaned on
  next connect.
- **Owner shares by email then by raw sub for the same person** → two entries
  (one `pending[email]`, one `roles[sub]`); the `roles` entry wins in
  `resolveRole`, and `promotePending` drops the redundant pending on connect.
- **Concurrent owner remove vs invitee connect-bind** → the two WRITE-backs are
  serialized by the mutex (seam 4); last serialized write wins deterministically (no
  lost update). Separately, if the invitee is ALREADY connected (granted via the
  lock-free `resolveRole` read) when the owner removes the pending entry, the
  pending-remove kick (`revokeLiveSessions({ emails })`, seam 1) forces their
  reconnect → re-`onAuthenticate` → no pending → 404. The lock-free read grant is
  thus revocable, not permanent.
- **HTTP-before-WS** → an invitee who only hits HTTP routes (e.g. `GET /sec`)
  passes `authorize` via the pending entry but is NOT promoted (promote runs only
  at WS connect), so `display` isn't cached and the pending entry lingers. Harmless
  and idempotent — opening a room always WS-connects, which binds — but binding is
  NOT guaranteed on first HTTP access; it's guaranteed on first WS connect.
- **auth=none demo** → unchanged; `onAuthenticate` early-returns allow with no
  `user.email`, so the pending path no-ops; `authorize` early-returns allow
  (`_public`, `requiresAuth` false).

## Testing

- **`authorize.cjs` unit** — `resolveRole`: roles-hit, pending-hit (`viaPending`),
  pending-miss, **both-present bound≥pending (bound wins, viaPending false)**,
  **both-present pending-higher (upgrade, viaPending true — major #5)**,
  **blank/missing email never matches pending (decision #5 guard)**, **expired
  pending resolves as absent**, **unparseable/missing `invitedAt` treated as
  expired**, **future `invitedAt` (age<0) treated as expired** (all fail-closed).
  Pure with injected `now`/`ttlMs` — table-testable, no real clock. Plus
  `pendingInviteTtlMs()`: valid env parses; **0 / negative / NaN env → default +
  loud log, never disables sharing**.
- **`promotePending` unit** — promote-on-hit, no-op when already bound, display
  refresh only when changed, no write when nothing changed, **expired-entry prune
  triggers a write and does NOT bind**, **expired entry for the connecting user is
  dropped not promoted**.
- **Mutex** — a deterministic promote-vs-share interleave that would lose an
  update without serialization (force the race by resolving the read mid-`await`,
  the pattern in `server/__tests__/hocuspocus-server.test.mjs`).
- **HTTP endpoints (`http-endpoints.test.mjs`)** — share-by-email add/remove;
  email `add` succeeds for a not-yet-registered email; `GET /:id/acl` returns
  `pending` + `display`; malformed email → 400; a viewer/editor `PATCH /share`
  → 404 (owner-only preserved).
- **Full-object-RMW regression (blocker #1)** — after a raw-sub add/remove/
  role-change on a room that has `pending` + `display`, both survive the write
  (the partial `{ ownerId, roles }` rebuild is fixed). This is the most likely
  silent breakage; pin it explicitly.
- **Listing includes own pending (option-1)** — a pending invitee's `GET /rooms`
  DOES list the invited room, badged `viaPending`/"invited", AND `GET /sec` + the WS
  connect succeed for the same principal (one `resolveRole` decision everywhere). A
  genuine non-member (no pending, no roles) sees neither the listing row nor access
  (null role → excluded + 404). This inverts the earlier asymmetry assertion — the
  listing is no longer `roleOf`-only.
- **Promote-vs-delete guard (blocker #2)** — two cases: (a) `readAcl` → null writes
  nothing (delete-then-read); (b) `readAcl` returns a LIVE acl but the room is
  tombstoned (`isDeleted` true) before the write-back → promote no-ops (write-time
  race). Both assert no `.acl.json` resurrection. Deterministic: stub `readAcl` +
  the tombstone predicate.
- **Revoke sweep uses `resolveRole` (major #3)** — a connected pending invitee
  (no `roles` entry) is NOT swept-closed; a genuinely-stale session still is. Force
  the connect->persist window by withholding the promote write.
- **Pending-remove kick (major #4)** — `PATCH /share { email, action:'remove' }`
  calls `revokeLiveSessions({ emails:[email] })`; a live session matching that email
  is closed. Stub the sessions map, assert the raw-WS close on the email-matched
  connection only.
- **Caps (major #6)** — email `add` at `MAX_PENDING_INVITES` → rejected; a write
  exceeding `MAX_ACL_BYTES` → rejected (share) / no-op+log (promote).
- **`hocuspocus-auth` / WS** — a pending invitee connects read-write (editor) or
  read-only (viewer) via `resolveRole`; verify the bind persists after connect.
- **`ShareDialog.test.jsx`** — email input routes to the email branch; pending
  invites listed + revocable; bound collaborators show `display` name with raw-sub
  fallback; raw-sub add still works; "Copy room link" copies the room URL (option-2).
- **Contract** — no change (no new artifact); `.acl.json` shape additions are
  read-compatible, so `storage-contract.test.mjs` is untouched.

## ADR / docs updates

- Amend **ADR-0017**: replace the "Share discovery limitation" consequence with
  the pending-invite model; document `pending`/`display` in the sidecar shape,
  the `SIM_PENDING_INVITE_TTL_MS` lazy expiry (default 30 days), `resolveRole` as
  the shared decision across HTTP `authorize()` + WS connect + revoke **sweep** +
  **`GET /rooms` listing** (so a caller's own pending-invited rooms appear in their
  listing, no asymmetry), `promotePending` at connect, and the
  per-composite-key mutex (single-instance-bound). **Explicitly record the reversal
  of decision 6:** email is now an authz INPUT, safe only under the verified-
  immutable-unique-per-sub IdP precondition (decision #5); state the precondition
  and the "disable share-by-email if the IdP can't guarantee it" fallback.
  **New PII-at-rest surface:** `.acl.json` now persists email addresses (pending +
  `display`) on the storage backend (local/S3/Azure), including lingering
  expired-but-unpruned invites — ADR-0017 previously persisted only subs. Note it
  for CUI/retention review (owner-only via `GET /:id/acl`; the at-rest storage is
  the new part). Record the `MAX_PENDING_INVITES` / `MAX_ACL_BYTES` caps and the
  pending-remove live-session kick (`revokeLiveSessions({ emails })`).
- Update **CLAUDE.md** "Collaboration Server" / authorization section: share route
  now accepts email (with `MAX_PENDING_INVITES` cap + pending-remove live-session
  kick via `revokeLiveSessions({ emails })`); `resolveRole` as the shared
  HTTP+WS+**revoke-sweep**+**`GET /rooms` listing** decision (takes the higher of
  bound/pending role; caller's own pending-invited rooms show badged "invited");
  a "Copy room link" control in `ShareDialog`;
  `promotePending` at connect (fire-and-forget, null-guard + delete-**tombstone**
  guarded, prunes expired, upgrades bound-lower); `.acl.json` gains `pending`/
  `display` (+ `MAX_ACL_BYTES` guard, new email PII-at-rest surface); lazy
  `SIM_PENDING_INVITE_TTL_MS` expiry (default 30 days, boot-validated); the shared
  per-composite-key ACL mutex (single-instance-bound); and the decision-6 reversal
  (email as authz input, verified-IdP precondition). Add the invariant:
  **`writeAcl` is a full-object overwrite, so every ACL writer must read-modify-write
  the COMPLETE object (`ownerId` + `roles` + `pending` + `display`) — never
  construct a partial `{ ownerId, roles }`.**
- Close **#267** referencing this spec.

## Out of scope

- Tenant-wide directory / email autocomplete (locked decision #1).
- A dedicated pending-invite expiry **sweep** — expiry is lazy (decision #4);
  extending the existing revoke sweep to also PRUNE expired invites is an optional
  backstop, not required for correctness. (Distinct from major #3: the revoke sweep
  MUST switch its role READ to `resolveRole` so it stops evicting valid pending
  sessions — that is required and in scope, seam 6. Adding pruning on top is the
  optional part.) Email-reuse guards remain out of scope (IdP does not reassign
  emails — decision #5 hard precondition).
- Ownership transfer (already out of scope per ADR-0017).
- Cross-instance immediate bind (single-instance precondition).
- Email deliverability / notification ("you've been invited" email) — the invite
  is silent; the sharee gains access on next login.
