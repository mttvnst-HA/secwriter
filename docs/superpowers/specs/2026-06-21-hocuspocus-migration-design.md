# Collab Transport Migration — y-websocket v1 → Hocuspocus (full cutover)

**Issue:** [#128](https://github.com/mttvnst-HA/secwriter/issues/128)
**Date:** 2026-06-21
**Status:** Revised after three independent review rounds (security / Yjs-technical / deploy). Direction approved. **Two empirical facts are NOT yet spiked and gate implementation** — undo-rejects-remote-origin (§7) and no-empty-seed-under-churn (§5) — plus two deploy guarantees must become pre-merge tested gates (destroy()-within-grace §8, cross-stack rollback §Deploy). See §Gating below.
**Prerequisite for:** [#239](https://github.com/mttvnst-HA/secwriter/issues/239) (graded viewer/editor/owner roles)

## Why

#239 needs a per-connection write gate so a **viewer** can read a live room but not write to it. y-websocket v1 (pinned by [ADR-0002](../../adr/0002-pin-y-websocket-v1.md)) has no such gate — the only options are refusing the WebSocket upgrade entirely (binary, no read-only) or hand-filtering the frozen v1 sync protocol (fragile). Hocuspocus exposes the gate for free: `onAuthenticate` can set `connectionConfig.readOnly = true`, after which the server accepts that connection's reads but rejects its document writes. This spec covers **only** the transport migration (#128); the role lattice itself (#239) is a separate spec that rides on top afterward.

This is a migration of the **live production collab data plane**. It supersedes [ADR-0002](../../adr/0002-pin-y-websocket-v1.md) and reworks [ADR-0014](../../adr/0014-collab-server-yjs-relay.md).

## What the spikes established vs. what is still assumed

Two isolated spikes (2026-06-21) against `@hocuspocus/server@4.3.0` + `@hocuspocus/provider@4.3.0`, stress-tested by three independent reviews. **Be precise about which claims are spike-verified and which are still design assumptions** — earlier drafts conflated the two.

**Spike-verified (load-bearing, proven):**
1. **CommonJS survives.** Hocuspocus ships a dual build (`exports.default.require` → a `.cjs` bundle) and declares `yjs`/`y-protocols` as **peerDependencies**, so a CJS `require('@hocuspocus/server')` uses our single hoisted Yjs copy. `instanceof Y.Text / Y.XmlFragment / Y.Map` keeps working across `collab.js`, `room-serializer.cjs`, and the migration broker. [ADR-0001](../../adr/0001-server-uses-commonjs.md) is preserved.
2. **`documentName` is client-supplied, not from the URL.** Hocuspocus reads the document name from the provider's `name` (in-band sync messages), *not* `request.url`. A "rewrite `req.url` to inject tenant" scheme does **not** work and would be a cross-tenant break. The correct pattern is **validate-don't-rewrite** (§3).
3. **Rejecting in `onAuthenticate` happens before document load.** A connection rejected in `onAuthenticate` never reaches `onLoadDocument`. Verified directly. **Caveat:** this proved `onLoadDocument` is gated; it did NOT independently prove `SecWriterDatabase.fetch` (the storage read) is gated. §3 step 5 + a test close that gap.
4. **`onLoadDocument` populates before clients sync** — the migration broker fits there. (Does *not* by itself prove the eviction guard is removable — see §5.)
5. **`onStoreDocument` fires debounced with the full latest Y.Doc**, and `Server.destroy()` flushes pending stores on shutdown. **Caveat:** verified at single-room spike scale only — NOT at production room count within Render's SIGTERM grace. §8 makes that a measured pre-merge gate.
6. **y-websocket v1 clients are NOT wire-compatible with a Hocuspocus v4 server** (connect, never sync — clean single-Yjs test). This is a **flag-day cutover**: server and client provider must ship together. No server-only shortcut.

**Still ASSUMED (must be empirically pinned — see §Gating):**
- **A1. HocuspocusProvider applies remote updates with the provider instance as the Yjs transaction origin** (so the UndoManager `trackedOrigins` keeps peer edits off the local undo stack). This is the single highest-risk item; it was *not* spiked. §7 + Gating.
- **A2. Hardening the client seed-on-empty eliminates the #17 yOrder-doubling race** under Hocuspocus's `synced` semantics. §5 + Gating.

## Scope

**In scope:**
- Replace the y-websocket v1 relay in `server/collab-server.cjs` with a Hocuspocus instance, required from CommonJS, mounted on our existing HTTP server via a manual `upgrade` handler that delegates to `server.handleConnection(ws, req, context)`.
- Persistence as a first-class `@hocuspocus/extension-database` subclass (`SecWriterDatabase`) wrapping the existing `RoomStorageBase` adapters unchanged.
- Client: migrate `WebsocketProvider` → `HocuspocusProvider` in `src/lib/collab.js` / `src/hooks/useCollabSession.js`.
- Preserve all current behavior 1:1: tenant authorization (binary #211 model), the v1→v2 substrate migration broker, room lock enforcement, .SEC/.comments/.lint serialization, awareness/presence, undo correctness, **the per-IP WS rate limit, the malformed-token-decode guard, the 8 MB doc-size refusal, and `roomHealth` persist-failure tracking**.
- Node 20→22 across CI and Render (landed as a separate prior commit — §9).

**Out of scope (explicitly):**
- The #239 role lattice (viewer/editor/owner). This spec only ensures the `connectionConfig.readOnly` seam exists and is server-controlled, ready for #239.
- Multi-instance / Redis / horizontal scaling. Current deploy is single-instance Render. The Database-extension shape leaves this as a future extension point but implements nothing for it (YAGNI).
- Any change to the auth model, ACL shape, or the HTTP route surface beyond what the transport swap requires.

## Decided architecture

### 1. Hocuspocus instance, our HTTP server keeps ownership

`collab-server.cjs` constructs a `Hocuspocus` instance (CJS `require`). We keep the existing `http.createServer` + manual `server.on('upgrade', …)` handler (we own the HTTP routes and need a pre-auth seam). The upgrade handler, in order: (a) per-IP WS **rate-limit** check, (b) extract + decode the token, surfacing a malformed token as a clean auth failure rather than an unhandled rejection, then (c) calls `hocuspocus.handleConnection(ws, req, context)`. JWT validation + tenant/ACL authorization run inside `onAuthenticate` (§3). The eviction-guard / preload re-install dance is removed from the upgrade handler (its replacement story is §5).

The rate-limit and token-decode-failure guards are load-bearing DoS defenses in the current code and MUST run **before** `handleConnection` so that neither a connection flood nor a garbage token can reach `SecWriterDatabase.fetch` / `onLoadDocument`.

### 2. Persistence: `SecWriterDatabase extends Database`

A `@hocuspocus/extension-database` subclass with two hooks:
- **`fetch({ documentName })`** → `Uint8Array | null`. Splits the **already-canonical** `documentName` into `(tenant, roomId)` (canonical form is guaranteed by §3 — the connection was rejected otherwise), calls `storage.readRoom(tenant, roomId)`, returns the `.ydoc` bytes (or null for a new room). Replaces `bindState`.
- **`store({ documentName, state, document })`** → runs the **full** `room-serializer.serializeRoom(document)` (which itself does `Y.encodeStateAsUpdate` *and* derives the sidecars) to produce all four artifacts `{ ydocBytes, secBytes, commentsJson, lintJson }`, then calls `storage.writeRoom(tenant, roomId, …)`. Write order (`.ydoc` last) is owned by `ARTIFACT_CATALOG` / `planArtifactWrites` in the storage layer, not the caller. **This must NOT be a bare `Y.encodeStateAsUpdate → writeRoom`** — that would stop regenerating the .SEC/.comments/.lint sidecars and serve stale exports.

Carried over from the current `flushRoom` (do NOT silently drop):
- The **8 MB `MAX_DOC_BYTES` pre-serialize refusal** (refuse to persist an over-size doc; surface as today).
- **`roomHealth.persistFailures` tracking** on a failed `writeRoom`.
- The serializer's **ESM dynamic-import** is deferred to first store (as today); the first `store` for a room pays that import latency inside the store hook — acceptable, but note it so it isn't mistaken for a regression.

**Flush cadence is a *different mechanism*, not a 1:1 swap.** Hocuspocus's `debounce` + `maxDebounce` options replace the hand-rolled `ydoc.on('update')` 500 ms timer. `maxDebounce` adds a starvation ceiling the old timer lacked (continuous typing eventually flushes) — an improvement, but the cadence changes, so any "flush within ~500 ms of last edit" assertion must be **re-derived**, not copied. `store` must be **re-entrancy-safe per `(tenant, roomId)` key** (no two overlapping `store` calls racing the same `.ydoc` into S3/Azure, which have no transaction primitive — §8).

**gc flag.** Current production runs `{ gc: true }` and the substrate survives store→load today. Pin Hocuspocus's document `gc` to match — but first **confirm Hocuspocus lets us set `gc` at all** (some versions construct the doc internally). Add a store→load round-trip test asserting the Y.XmlFragment substrate survives. (Note: `Y.RelativePosition` selection state in `relpos-selection.js` is client-only and never persisted, so it is not a store→load gc concern — don't conflate the two.)

### 3. Tenant isolation: validate-AND-reject-non-canonical (security keystone)

Because `documentName` is client-supplied (§spikes/2) **and Hocuspocus keys its in-memory `documents` Map on the raw client name**, tenant isolation cannot rely on rewriting the name, and it cannot assume the validated key and the Map key agree. The keystone is: **reject any connection whose raw `documentName` is not already in canonical `<tenant>/<roomId>` form**, so the Hocuspocus Map key, `SecWriterDatabase.fetch`/`store` key, the ACL-read key, and the migration-broker key are provably the same string. Enforced in `onAuthenticate`:

1. Run `checkPrincipal(authProvider, user)` first — missing tenant claim / missing stable subject / a tenant that sanitizes to the reserved `_public` or `archive` sentinel → reject (same 403 semantics as today's `authorize.cjs`).
2. Derive `tenant = sanitize(user.tenant)` from the **validated token only**.
3. Parse the raw client `documentName`: split on the **first** `/` into `rawTenant` / `rawRoom`. Reject if there is no `/`, if `rawTenant` is empty, or if `rawRoom` is empty. **Do not depend on `splitCompositeDocName`'s lenient `_public` fallback** for a missing separator — reject explicitly.
4. **Canonicality check (the anti-split-brain rule):** reject unless `rawTenant === tenant` (sanitized-vs-sanitized) **and** `rawRoom === sanitize(rawRoom)` (the raw room is already in safe form). This guarantees `documentName === buildCompositeDocName(tenant, sanitize(rawRoom))` exactly, so two distinct raw names can never sanitize-collide onto one storage room while occupying two Map entries. (`tenantA/room/1` and `tenantA/room.1` both fail step 4 because they aren't already canonical.)
5. Run `authorize()` (read action) off the cheap `.acl.json` sidecar via `readAcl(tenant, rawRoom)` — owner-or-shared, same binary #211 logic. Reject → throw (Hocuspocus closes the connection before `onLoadDocument` **and** before `SecWriterDatabase.fetch`).

**Reject status parity.** Every rejection in steps 3–5 (malformed name, cross-tenant, unreadable room, missing ACL) must surface the **same opaque close** to the client — never a distinguishable "tenant mismatch" vs "room you can't see" signal — preserving today's 404-not-403 no-existence-leak posture. Bad-principal (step 1) stays 403; no-token stays 401.

A cross-tenant WS test must drive the attack through the provider **`name`** (set `name = "victimTenant/room"` under a tenant-A token) and assert rejection before load — testing the URL would test a path Hocuspocus ignores. Note the client's own `getRoomFromUrl` sanitizer strips `/`, so the test must construct the malicious `name` directly, bypassing that sanitizer, or it is accidentally defanged.

`connectionConfig.readOnly` is set only by the server in `onAuthenticate` (no client override path — must be pinned by a test that a write frame on a `readOnly` connection is dropped server-side, not merely that the flag is set). For #128 it stays `false` for all authorized connections; #239 will set it `true` for the viewer role. **Revocation parity:** `readOnly`/ACL changes re-evaluate only on the **next** connect (per-connection `onAuthenticate`), exactly as today — an already-open session is not force-re-gated. State this so #239 doesn't assume live downgrade. Confirm `onAuthenticate` runs on every reconnect (incl. transparent socket reconnects), and pin it (revoke ACL, force reconnect, assert rejection).

### 4. Hook mapping (where each current behavior lands)

| Today (`collab-server.cjs` upgrade handler) | Hocuspocus hook |
|---|---|
| Per-IP WS rate-limit | manual `upgrade` handler, before `handleConnection` (§1) |
| Token extract + malformed-decode guard | manual `upgrade` handler, before `handleConnection` (§1) |
| JWT validate + canonical-name reject + `authorize(...,'read')` off `.acl.json` | `onAuthenticate` (§3) |
| `bindState` preload (`storage.readRoom`) | `SecWriterDatabase.fetch` |
| v1→v2 substrate migration broker (`migrate-pm-substrate.cjs`) | `onLoadDocument` (§6) |
| `flushRoom` (serialize + write, debounced) + 8 MB refusal + `roomHealth` | `SecWriterDatabase.store` + `debounce`/`maxDebounce` (§2) |
| `getActiveUsers` reads `ywsUtils.docs.get(name).awareness` | rewrite against `hocuspocus.documents.get(name)` (§7) |
| SIGTERM → `await flushAllRooms()` | SIGTERM → `await hocuspocus.destroy()` (§8, measured gate) |

### 5. Eviction guard: keep until proven removable + harden the client seed (with the CORRECT remedy)

The spike proved load-before-sync for one fresh connection. It did **not** prove safety under SecWriter's pattern: last-connection-close → debounced store + document unload → immediate reconnect (reconnect storms, React.StrictMode double-mount, Render cold-restart floods). Hocuspocus has its own unload-during-debounce race class (upstream issues #832/#846). Therefore:

- **Do not delete the no-empty-seed protection on the spike's evidence alone.** First write a deterministic churn-reproduction test at the Hocuspocus level (persist a non-empty room; force last-conn-close with a store pending; reconnect mid-unload; assert `yOrder.length` equals the persisted block count and never doubles). If it doubles, retain an equivalent guard (e.g. `unloadImmediately: false` tuning or a re-install shim) — the guard is not "obsolete," it moves.
- **Harden the client seed-on-empty — and do it the way that actually works.** The trigger for the #17 yOrder-doubling pathology is the client seeding `initialBlocks` when it observes `yOrder.length === 0 && yStore.size === 0` in `collab.js` `handleSync`. Today this is safe **only because y-websocket serializes sync on a single connection and fires `'sync'` after the round-trip** — an ordering guarantee we are discarding. **The race is cross-tick** (`synced` firing before remote state is fully applied), so the previously-proposed "move the empty-check inside the seed transaction" is a **no-op** — a synchronous Yjs transaction cannot observe state that hasn't arrived yet. The only correct fix is an **explicit "server says this is a new room" signal**: the seed fires only on that signal, never on an observed-empty heuristic. Source of the signal (to decide in the plan, both server-derived): either `SecWriterDatabase.fetch` returning null surfaced to the client via an `onLoadDocument`-set document attribute the client reads before seeding, or a cheap HTTP precheck. This removes the trigger transport-independently and makes the whole race class non-fatal. (Pinning that the chosen signal actually closes the doubling under Hocuspocus's `synced` semantics is assumption **A2** — see §Gating.)

### 6. Migration broker in `onLoadDocument`

The v1→v2 substrate broker (`migrate-pm-substrate.cjs`) moves from the upgrade handler to `onLoadDocument`, running **only on the validated server-derived canonical key** (never an attacker-supplied name — guaranteed by §3 rejecting before load). Preserved invariants:

- **`backupRoom` must fully complete before the migrated document is returned from `onLoadDocument`** — and we must *prove*, not assume, that Hocuspocus does not enqueue a `store` for mutations made *inside* `onLoadDocument` before the backup settles. The hazard: the broker's own mutations are doc updates; if Hocuspocus's store-debounce observes them and a crash lands before `backupRoom` completes, the migrated `.ydoc` exists with no backup. Backup failure must abort migration leaving the room v1.
- A **freshly-migrated room with zero subsequent human edits must still persist.** If `destroy()` only flushes *pending* stores (§8) and the broker's mutations did not enqueue one, the migrated state is never written. The broker must ensure its mutations enqueue a store (or persist explicitly).
- `schemaVersion` and `migrationPartial` stay **mutually exclusive** — verify this holds under the new "catch-and-return the document" failure mode (not just the old "throw and stay v1"); a partial conversion must never also stamp `schemaVersion=2`. Add this assertion to the end-to-end test.
- An `onLoadDocument` throw has different semantics under Hocuspocus (retry, doc stays in memory) than the current "log and continue, room stays v1" — the broker must **catch its own errors and return the document** rather than throwing, preserving the current failure mode (editable room + `migration-partial` banner).
- `migrationCoordinator.forget(compositeKey)` stays wired on `DELETE` (load-bearing for re-upload-same-id).
- The per-room async lock may be partially redundant (Hocuspocus dedupes concurrent loads of the same name) but is kept — it also guards sequential reload, which load-dedup does not.
- A broker → `onLoadDocument` → client-sync → `pmFragmentToHtml` **end-to-end** test is required (per CLAUDE.md collab pattern #3; per-side unit pins can stay green while the pipe is broken).

### 7. Client provider migration (`WebsocketProvider` → `HocuspocusProvider`)

This is a flag-day change shipped with the server. `src/lib/collab.js` + `src/hooks/useCollabSession.js` migrate to `HocuspocusProvider`. Surface deltas to handle:

- **Undo correctness — assumption A1, the gating item.** The load-bearing claim is that `HocuspocusProvider` applies *remote* updates with the provider instance (or any origin that is neither `ySyncPluginKey` nor a string starting `local-`) as the Yjs transaction origin, so the UndoManager `trackedOrigins` (`ySyncPluginKey`, `'local-publish'`) still rejects peer edits AND `handleAfterTx`'s `origin.startsWith('local-')` echo filter still re-emits remote blocks. **This is unproven and must be pinned FIRST**, before any other client work, against a real two-provider HocuspocusProvider loopback (not a mocked origin), using the `word-boundary-undo.test.js` pattern (a peer edit must not enter the local undo stack). If the origin turns out to be `null` or otherwise unexpected, the trackedOrigins set and/or the echo filter must be revisited before proceeding.
- **Auth token** moves from the room-name hack (`name?token=…`) to `HocuspocusProvider`'s real `token` option (may be an async callback for refresh-on-reconnect), replacing the `provider.url` mutation on reconnect. This is *stronger* than today (rotation without URL mutation).
- **Status/sync events**: `provider.on('sync')` / `provider.on('status')` (y-websocket shapes) → Hocuspocus's `onSynced`/`synced` + `onStatus` (`connecting|connected|disconnected`) + a separate `onAuthenticationFailed`. The four-state `effectiveStatus` mapping and the **sticky-status filter** (incl. `migration-partial`/`incompatible` — a real correctness property: never flash "connected" over "incompatible") are tightly coupled to y-websocket firing `sync` separately from `status`. They must be **re-proven against Hocuspocus's event model**, not merely re-wired.
- **Reconnect backoff**: the banner's countdown reads y-websocket-specific `provider.wsUnsuccessfulReconnects` / `maxBackoffTime`. Re-derive against Hocuspocus's reconnect model (or drop the countdown to a generic "reconnecting…").
- **Awareness** and the `ydoc` binding for `ySyncPlugin`: `HocuspocusProvider` exposes `.awareness` and binds `.document`; y-prosemirror compatibility holds.
- **`documentName` on the wire:** assert in a client test that `HocuspocusProvider`'s `name` is the bare canonical composite room id with **no path prefix** (no reintroduction of the `/ws/` parallel-room split under the new stack).
- `window.__collab` DEV surface updates to the new provider object.

### 8. Shutdown flush (data-loss guard — measured pre-merge gate)

Render sends SIGTERM then SIGKILL (~30 s grace) on every redeploy. Wire SIGTERM/SIGINT → `await hocuspocus.destroy()`, mirroring today's `shutdown()` → `flushAllRooms()`. But this is **not** a free 1:1 swap:

- **`destroy()` must flush ALL dirty rooms within the grace window — measured, not assumed.** `store` runs the full `serializeRoom` + a network `writeRoom` per room; serial at production room count this can exceed ~30 s → SIGKILL drops un-flushed rooms. **Pre-merge gate (concrete number):** measure `destroy()` wall-time at p99 production room count + worst-case S3/Azure latency and assert completion within `grace − safety_margin` (e.g. < 20 s). If it can't, the plan must add concurrent flushing and/or a `closeConnections()`-then-flush ordering.
- **The flush test must assert ALL dirty rooms persist, not one.** The naive single-room "seed, edit, destroy, assert persisted" test passes even if `destroy()` flushed only the first doc. Test ≥3 dirty rooms.
- **In-flight `store` on shutdown.** Confirm `destroy()` awaits an already-running `onStoreDocument` and does not start a second concurrent `store` for the same key (re-entrancy, §2) — two stores racing the same `.ydoc` into S3 (no transaction primitive) can land a stale write last.
- **SIGKILL is still data loss** (un-flushed debounce on hard kill) — same as today's `unref()`'d timer. The guard covers SIGTERM only; state this honestly.

### 9. Node 20 → 22 (land as a SEPARATE prior commit)

Hocuspocus requires `engines: node >=22`. **Bump CI to Node 22 and confirm fully green as its own landed commit BEFORE the transport-swap PR** — do not bundle the Node bump with the migration, or a native-dep ABI / `engines` failure strands the transport deploy. Pin Render's Node via **`package.json` `engines`** (committed, so CI and prod cannot drift) rather than `render.yaml` env alone. Re-verify under Node 22 + windows-latest:
- The windows-1252 path. The server already uses a pure-JS `decodeWindows1252` (ICU-independent by design), so the decode is safe; confirm no test asserts the old Node-20 small-ICU C1-control behavior, and that nothing regressed to `TextDecoder` for windows-1252.
- Native deps (`@aws-sdk`, `@azure/storage-blob`, `harper.js` WASM) install and pass cleanly under Node 22 on all CI runners.

## The four ADR-0014 patterns post-migration

1. **`extractDocName` strips `/ws/`** — under Hocuspocus the *docName* comes in-band (spike 2), so the `/ws/` strip no longer derives the document identity; it may still matter for routing the `upgrade`. Re-derive and keep a test.
2. **Stale-close eviction guard** — see §5: keep until the churn-repro test proves Hocuspocus safe; the v1-specific test (manual `ywsDocs.delete` mid-await) becomes unrunnable and is replaced by the Hocuspocus-level no-empty-seed-under-churn test.
3. **Migration broker invariants** — rehomed to `onLoadDocument` (§6) with invariants preserved + the backup-ordering proof.
4. **`GET /rooms` `setImmediate` yield** — HTTP-side, untouched. Must survive any drive-by cleanup (regression test stays).

## Deploy strategy & rollback

Flag-day cutover, two independently-deploying Render services (`secwriter-collab`, `secwriter-frontend` with Vite-inlined `VITE_COLLAB_WS_URL`). The two services rebuild independently, so a split-brain window is unavoidable — but its *shape* depends on order, so the order is **mandated, not left to chance**:

- **Deploy server first, then frontend.** Given not-wire-compatible (spike 6): server-first means old `WebsocketProvider` clients fail to sync against the new Hocuspocus server (locked out, recoverable) while the new server is already authoritative and persisting correctly; as the frontend rolls, clients recover cleanly. Client-first is the worst case (new clients lock out against the old server AND strand unsynced local edits). **Confirm the new server is healthy (`/health`) before triggering the frontend deploy.**
- **Active drain before cutover (not just "low traffic").** A live data plane with possibly-unsynced local edits needs an active gate: broadcast a "saving, reconnecting shortly" notice (or flip rooms read-only via the existing lock mechanism), confirm all bound rooms flushed, and confirm `/health` shows 0 active connections (or force-flush) before deploying. "Prefer a quiet window" alone can lose an editor's unsynced changes if they close the tab during the window.
- **Split-brain failure mode is reconnect failure for the WS path** (old/new not wire-compatible → clients see a reconnect error, not silent CRDT corruption). **But the HTTP surface is NOT version-gated** (`POST /rooms/:id/upload`, `PATCH`, `DELETE`, `/sec`): enumerate its behavior during the window and confirm no HTTP route accepts a body that bypasses the server's authoritative doc state, and that a client which failed to WS-sync cannot later seed from stale local state (ties to §5).
- **Rollback (claim downgraded to UNVERIFIED until tested).** Rollback = revert the merge commit; both services rebuild from the prior commit. The story hinges on a Hocuspocus-written `.ydoc` reading back on the reverted y-websocket server. Both encode via `Y.encodeStateAsUpdate` over the same hoisted Yjs, so the *update format* is compatible — **but gc-driven structural differences could decode without throwing yet yield silently different `.SEC` content.** This is **not** proven. **Pre-merge gate:** a cross-stack rollback test — write a real migrated room (TC marks, comments, Y.XmlFragment substrate) with Hocuspocus, read it back with the y-websocket server, `serializeRoom`, byte-compare `.SEC` against the pre-migration export. Until green, the runbook states rollback may require manual `.ydoc` re-export.
- **No room mid-migration across the cutover.** A v1→v2 migration half-done during the window (or re-examined by the reverted broker) can double-migrate or strand partial. Pre-deploy: scan for and drain any room in `migrationPartial` state, or add a cross-stack test that the old broker no-ops a Hocuspocus-migrated room.

## Testing

Placed to respect the test caps (`migrate-pm-substrate.test.mjs` and `http-endpoints.test.mjs` are both at the 30-test cap; `collab-server.test.mjs` has headroom at ~17):

- **`collab-server.test.mjs`** (new tests here):
  - No-empty-seed-under-churn (replaces the dead eviction-race test's intent): persisted room + reconnect-mid-unload → `yOrder` never doubles (§5, assumption A2).
  - Shutdown flush / data-loss guard: seed **≥3 rooms**, dispatch edits, do NOT wait for debounce, `await hocuspocus.destroy()`, assert **every** edit persisted; plus a measured `destroy()`-within-grace assertion (§8).
  - `store` re-entrancy: two overlapping stores for one key do not land a stale `.ydoc` (§2/§8).
  - Hocuspocus lifecycle smoke: load → edit → store → reconnect sees N blocks.
  - Cross-tenant + non-canonical rejection driven via provider `name` (§3): tenant-A token naming `victimTenant/room`, `tenantA/room/1`, `tenantA/room.1`, and a no-slash name are each rejected before load — and with the same opaque close.
  - `onAuthenticate` runs `checkPrincipal` (missing tenant/subject + `_public`/`archive` sentinel → reject).
  - `fetch` is gated: a rejected `onAuthenticate` yields **zero** `SecWriterDatabase.fetch` calls for the attacker-named room (§3 step 5).
  - `readOnly` connection: a write frame is dropped server-side (§3, #239 readiness).
  - Reconnect re-auth: revoke ACL, force reconnect, assert rejection (§3 revocation parity).
- **`migrate-pm-substrate.test.mjs`** (at cap): batch broker-under-`onLoadDocument` assertions into existing `it()`/`it.each`. Add the broker→`pmFragmentToHtml` end-to-end test + the `schemaVersion`/`migrationPartial` mutual-exclusion-under-catch-and-return assertion (§6).
- **`storage-contract.test.mjs`**: unchanged (adapters untouched). Add a `SecWriterDatabase` fetch/store round-trip test asserting all four artifacts regenerate on store, the 8 MB refusal fires, and `roomHealth` increments on write failure (§2).
- **Cross-stack rollback** (new, pre-merge gate): Hocuspocus-write → y-websocket-read → `serializeRoom` → byte-compare `.SEC` (§Deploy).
- **Client unit/integration**: pin undo-rejects-remote-edits against a real two-provider `HocuspocusProvider` loopback (§7, A1) via the `word-boundary-undo.test.js` pattern; assert `HocuspocusProvider.name` is the bare canonical composite.
- **E2E**: full `editor.spec.js` + `collab.spec.js` under `--project=chromium` against the Hocuspocus server; compare to the #194 parallel-load flake baseline (not a clean run). Per CLAUDE.md rule #10.
- **CI**: confirm `npm run test:server`, interop encoding tests, and the full Vitest suite pass under Node 22 on all runners — as the separate Node-bump commit, before the migration PR (§9).

## Docs

- **New ADR — Collab relay on Hocuspocus**: the Hocuspocus architecture, the validate-AND-reject-non-canonical tenant keying chokepoint, `SecWriterDatabase` persistence (incl. size-cap + roomHealth + re-entrancy), the eviction-guard replacement + explicit new-room seed signal, the server-first flag-day deploy posture, the measured shutdown-flush gate.
- **Supersede [ADR-0002](../../adr/0002-pin-y-websocket-v1.md)** (y-websocket v1 pin): record that the migration it gated on has happened, and how the eviction race is now handled.
- **Amend [ADR-0014](../../adr/0014-collab-server-yjs-relay.md)**: rewrite pattern #2 (eviction guard → client-seed-hardening + Hocuspocus lifecycle), update pattern #3 (broker in `onLoadDocument` + backup-ordering proof), note patterns #1/#4 status.
- **Amend [ADR-0001](../../adr/0001-server-uses-commonjs.md)**: note Hocuspocus is required via its `.cjs` build with peer Yjs, preserving the single-instance guarantee.
- **CLAUDE.md**: update the "Collaboration Server" + "Collab Publish Path" sections to the Hocuspocus model.

## Gating — validate FIRST, in this order, before building on them

The implementation plan validates each before building on it. The first two are *assumptions currently dressed as design*; the last two are deploy guarantees that must become green tests before merge:

1. **A1 — `HocuspocusProvider` remote-update origin keeps peer edits off the undo stack** (§7). Two-provider loopback + `word-boundary-undo.test.js` pattern. Blocks all client work.
2. **A2 — the explicit new-room seed signal closes the #17 doubling under Hocuspocus `synced` semantics** (§5). No-empty-seed-under-churn test. Decides whether/which eviction guard stays.
3. **`hocuspocus.destroy()` flushes all dirty rooms within Render's SIGTERM grace at realistic room count** (§8). Measured, with a concrete threshold.
4. **Cross-stack rollback: a Hocuspocus-written `.ydoc` round-trips to identical `.SEC` on the reverted y-websocket server** (§Deploy). Byte-compare gate.

Also confirm: `connectionConfig.readOnly` set in `onAuthenticate` is per-connection and threaded to the connection (for #239), and pin the Hocuspocus version with a single-Yjs-instance CI assertion so a future bump dragging a skewed `y-protocols`/`lib0` peer can't reintroduce a second copy.

## Out of scope

- #239 role lattice, user-directory / share-by-email, live-session force-revocation, multi-instance/Redis, any auth-model or ACL-shape change.
