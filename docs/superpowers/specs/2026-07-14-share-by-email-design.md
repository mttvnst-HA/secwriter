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
   user's **first login after the invite**, not rejected. Binding resolves to
   whoever actually authenticates under that email, which is self-correcting on
   the email-reuse hazard (see below).
3. **Email is never an ACL grant key.** `roles` stays keyed by stable subject id;
   `roleOf` is unchanged. Email appears only transiently in `pending` and as
   display metadata.
4. **No pending-invite expiry.** The target IdP does not reassign an email to a
   new subject (typical enterprise), so a stale pending invite claimed by the
   wrong person is not in the threat model. (If that assumption ever changes,
   add expiry + first-ever-login binding in `promotePending` — noted, not built.)

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

- `roles` semantics and `roleOf()` are byte-for-byte unchanged. **`aclAllowsRead`
  and `GET /rooms` member-filtering stay `roleOf`-based** — a pending (unbound)
  invitee is deliberately NOT listed as a member and the room does NOT appear in
  their `GET /rooms` listing until they bind. This is an intentional **asymmetry**
  with seam 2: per-room `authorize()` and the WS connect become `resolveRole`-based
  (pending included, so an invitee CAN open the room they were invited to), while
  the tenant listing stays membership-based (pending excluded). A pending invitee
  can therefore reach a room by its id but does not see it enumerated — which is
  correct, and does NOT weaken the per-room 404 for genuine non-members (no
  pending entry → `resolveRole` returns null → 404 unchanged).
- `pending` and `display` only ever contain principals relevant to THIS room —
  no tenant-wide index, no cross-room aggregation, no `seenAt` activity trail.
- Both keys are additive and optional; a #211/#239 sidecar with neither reads
  identically to today.

### Load-bearing invariant: every ACL writer is a full-object read-modify-write

`writeAcl` is a **full-object overwrite** (`room-storage.cjs`: `JSON.stringify(acl)`).
There is no partial/merge write. Therefore EVERY site that writes `.acl.json` —
the existing raw-sub share branch, the new email branch, `promotePending`, and
`GET /:id/acl`'s normalization write-back if any — MUST read the current ACL and
write back the COMPLETE object (`ownerId` + `roles` + `pending` + `display`),
never a freshly-constructed `{ ownerId, roles }`. The current raw-sub branch in
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
     `viewer`/`editor` (reuse `GRANTABLE_ROLES`).
   - `{ email, action: 'remove' }` → delete `pending[email]`.
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

2. **Pure decision — `resolveRole(acl, user)` in `server/auth/authorize.cjs`.**
   Returns `{ role, viaPending }`:
   - `role = roleOf(acl, user.id)`. If non-null → `{ role, viaPending: false }`.
   - Else if `user.email && acl.pending?.[normalizeEmail(user.email)]` →
     `{ role: <that entry>.role, viaPending: true }`.
   - Else `{ role: null, viaPending: false }`.
   Pure (no storage writes). `authorize()` uses `resolveRole` in place of the bare
   `roleOf` call for its capability check, so a pending invitee passes READ/WRITE
   over HTTP immediately (before the connect-time bind persists). `hocuspocus-auth.cjs`
   `onAuthenticate` calls the same `resolveRole` for its role/`readOnly` decision —
   one code path for both transports, closing the WS gap the rejected design had.

3. **Connect-time persist — `promotePending(storage, tenant, roomId, user, lock)`
   (new helper; called ONLY from `onAuthenticate` in `server/collab-server.cjs`).**
   Once per session per room — not per keystroke, not per HTTP request. Under the
   per-composite-key mutex (seam 4), read the ACL and, if anything changed, write
   the COMPLETE object back once (full-object-RMW invariant):
   - **Null-guard first:** if `readAcl` returns null, write NOTHING and return.
     The room may have been deleted concurrently (delete removes `.acl.json` LAST,
     `room-storage.cjs`); a blind write-back would re-create an ownerless
     `.acl.json` after the `.ydoc` is gone — the exact crash-order resurrection
     ADR-0017 decision 4 defends against. (Same TOCTOU the share route already
     null-checks.) Note the delete path uses its own tombstone (`markDeleted` /
     `deleteRoomTransactionally`), NOT this ACL mutex, so the null-guard — not the
     mutex — is what closes the promote-vs-delete race; state this explicitly.
   - If `pending[normalizeEmail(user.email)]` exists and `user.id` is not already
     in `roles`: move it → `roles[user.id] = <that entry>.role`; delete the
     pending entry. (Bind resolves to the authenticating sub → self-correcting.)
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

5. **Owner UI — `GET /rooms/:roomId/acl` + `ShareDialog.jsx`.**
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

### Data flow (happy path)

1. Owner opens `ShareDialog`, types `bob@corp.com`, picks Editor, Add.
2. `PATCH /:id/share { email:'bob@corp.com', action:'add', role:'editor' }` →
   `pending['bob@corp.com'] = { role:'editor', invitedBy:<owner>, invitedAt }`.
3. Bob logs in and opens the room. `onAuthenticate`: `resolveRole` returns
   `{ role:'editor', viaPending:true }` → Bob connects read-write immediately.
   `promotePending` moves `pending['bob@corp.com']` → `roles[<bob-sub>]='editor'`,
   writes `display[<bob-sub>]={name:'Bob …', email:'bob@corp.com'}`.
4. Owner reopens the dialog: Bob now shows as a bound Editor with his name; the
   pending entry is gone.

## Error handling & edge cases

- **Malformed email** on share → 400 (basic shape check only; no MX/deliverability).
- **Unknown / never-logging-in email** → invite sits in `pending` indefinitely
  (no expiry, decision #4). Owner can revoke it manually.
- **Cross-tenant email** → the pending entry is inert; it only binds when a token
  whose tenant matches the room authenticates with that email. No cross-tenant
  leak, no signal to the owner that the email exists elsewhere.
- **Email already bound** (sub already in `roles`) → `resolveRole` returns the
  real role first; `promotePending` skips the promotion (the `user.id not in
  roles` guard). A leftover pending entry for an already-bound user is cleaned on
  next connect.
- **Owner shares by email then by raw sub for the same person** → two entries
  (one `pending[email]`, one `roles[sub]`); the `roles` entry wins in
  `resolveRole`, and `promotePending` drops the redundant pending on connect.
- **Concurrent owner remove vs invitee connect-bind** → serialized by the mutex
  (seam 4); last serialized write wins deterministically (no lost update).
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
  pending-miss, both-present (roles wins), null-email. Pure, table-testable.
- **`promotePending` unit** — promote-on-hit, no-op when already bound, display
  refresh only when changed, no write when nothing changed.
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
- **Listing/authorize asymmetry (blocker #2)** — a pending invitee's `GET /rooms`
  does NOT list the room, while `GET /sec` and the WS connect succeed for the
  same principal.
- **Promote-vs-delete null-guard** — `promotePending` invoked when `readAcl`
  returns null writes nothing (no ownerless `.acl.json` resurrection). Deterministic:
  stub `readAcl` → null.
- **`hocuspocus-auth` / WS** — a pending invitee connects read-write (editor) or
  read-only (viewer) via `resolveRole`; verify the bind persists after connect.
- **`ShareDialog.test.jsx`** — email input routes to the email branch; pending
  invites listed + revocable; bound collaborators show `display` name with raw-sub
  fallback; raw-sub add still works.
- **Contract** — no change (no new artifact); `.acl.json` shape additions are
  read-compatible, so `storage-contract.test.mjs` is untouched.

## ADR / docs updates

- Amend **ADR-0017**: replace the "Share discovery limitation" consequence with
  the pending-invite model; document `pending`/`display` in the sidecar shape,
  `resolveRole` as the shared HTTP+WS decision, `promotePending` at connect, and
  the per-composite-key mutex (single-instance-bound).
- Update **CLAUDE.md** "Collaboration Server" / authorization section: share route
  now accepts email; `resolveRole` as the shared HTTP+WS decision; `promotePending`
  at connect (fire-and-forget, null-guarded); `.acl.json` gains `pending`/`display`;
  the shared per-composite-key ACL mutex (single-instance-bound). Add the invariant:
  **`writeAcl` is a full-object overwrite, so every ACL writer must read-modify-write
  the COMPLETE object (`ownerId` + `roles` + `pending` + `display`) — never
  construct a partial `{ ownerId, roles }`.**
- Close **#267** referencing this spec.

## Out of scope

- Tenant-wide directory / email autocomplete (locked decision #1).
- Pending-invite expiry / email-reuse guards (locked decision #4).
- Ownership transfer (already out of scope per ADR-0017).
- Cross-instance immediate bind (single-instance precondition).
- Email deliverability / notification ("you've been invited" email) — the invite
  is silent; the sharee gains access on next login.
