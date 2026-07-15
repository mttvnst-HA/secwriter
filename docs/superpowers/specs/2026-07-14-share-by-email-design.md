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

- `roles` semantics and `roleOf()` are byte-for-byte unchanged — the read/list/
  authorize plane keeps working over sub keys, so a pending (unbound) invitee is
  correctly NOT yet a member (`aclAllowsRead`, `GET /rooms` member-filtering, the
  per-room 404 all hold with no change).
- `pending` and `display` only ever contain principals relevant to THIS room —
  no tenant-wide index, no cross-room aggregation, no `seenAt` activity trail.
- Both keys are additive and optional; a #211/#239 sidecar with neither reads
  identically to today.

### Seams (where the code goes)

1. **Share route — `PATCH /rooms/:roomId/share` (`server/http-handler.cjs`).**
   Body extends to accept an email variant alongside the existing
   `{ userId, action, role }`:
   - `{ email, action: 'add', role? }` → normalize `lower(trim(email))`, write
     `pending[email] = { role: role || 'editor', invitedBy: req.user.id, invitedAt }`.
     Reject a malformed email (basic shape check) with 400. `role` restricted to
     `viewer`/`editor` (reuse `GRANTABLE_ROLES`).
   - `{ email, action: 'remove' }` → delete `pending[email]`.
   - The existing `{ userId, ... }` (raw-sub) branch is unchanged.
   - Still owner-only (`ACTION.SHARE`), still the low-frequency single writer.
   - Email `add` ALWAYS succeeds (stored pending) regardless of whether the email
     is a real org member → no lookup oracle, no existence leak. Matches
     ADR-0017's 404/no-leak posture.

2. **Pure decision — `resolveRole(acl, user)` in `server/auth/authorize.cjs`.**
   Returns `{ role, viaPending }`:
   - `role = roleOf(acl, user.id)`. If non-null → `{ role, viaPending: false }`.
   - Else if `user.email && acl.pending?.[lower(user.email)]` →
     `{ role: acl.pending[lower(user.email)].role, viaPending: true }`.
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
   it back once:
   - If `pending[lower(user.email)]` exists and `user.id` is not already in
     `roles`: move it → `roles[user.id] = pending[email].role`; delete the pending
     entry. (Bind resolves to the authenticating sub → self-correcting.)
   - Refresh `display[user.id] = { name: user.name, email: lower(user.email) }`
     whenever it differs from what's stored — so every authed member (whether
     bound via pending or added by raw sub) gets a human name cached, gated on
     "changed" to avoid a rewrite every session.
   - If neither the promotion nor the display refresh changes anything, write
     nothing (no-op — avoids per-session ACL churn).

4. **Serialize ACL read-modify-write.** `promotePending` and the share route both
   do read-modify-write on one `.acl.json` with no cross-backend CAS. Guard both
   behind a per-composite-key in-process async mutex (a `Map<compositeKey,
   Promise>` chain, same shape as `SecWriterDatabase._storeChains`), so the
   promote-vs-share and concurrent-connect binds can't lose an update. This is
   **single-instance-bound** — the same precondition ADR-0017 already documents
   for the `documents` map, the revoke sweep, and store re-entrancy. Document it
   with the same footnote; a multi-instance move needs a distributed lock here too.

5. **Owner UI — `GET /rooms/:roomId/acl` + `ShareDialog.jsx`.**
   - `GET /:id/acl` (owner-only, already exists) returns `pending` and `display`
     alongside the normalized `roles`.
   - `ShareDialog`: the add-collaborator input accepts an **email** (route to the
     email branch of the share route). Pending invites render as their email
     string with role + a remove control, visually distinguished from bound
     collaborators (e.g. an "invited" tag). Bound collaborators render their
     `display[sub].name` (falling back to the raw sub id when `display` is absent).
     The existing raw-subject-id add path stays available (additive, not a
     replacement — acceptance criterion).

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
- **auth=none demo** → unchanged; `authorize` early-returns allow, no pending path
  exercised (`_public`, `requiresAuth` false).

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
  now accepts email; `resolveRole` seam; `.acl.json` gains `pending`/`display`.
- Close **#267** referencing this spec.

## Out of scope

- Tenant-wide directory / email autocomplete (locked decision #1).
- Pending-invite expiry / email-reuse guards (locked decision #4).
- Ownership transfer (already out of scope per ADR-0017).
- Cross-instance immediate bind (single-instance precondition).
- Email deliverability / notification ("you've been invited" email) — the invite
  is silent; the sharee gains access on next login.
