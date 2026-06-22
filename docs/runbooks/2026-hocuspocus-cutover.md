# Runbook — Hocuspocus relay flag-day cutover (#128)

**Status:** Ready
**Date:** 2026-06-22
**Scope:** Production cutover of the realtime collaboration data plane from the y-websocket v1 relay to Hocuspocus v4. See [ADR-0018](../adr/0018-collab-relay-hocuspocus.md).

This is a **flag-day** cutover: the y-websocket v1 client is NOT wire-compatible with a Hocuspocus v4 server (it connects but never syncs), so the server (`secwriter-collab`) and the frontend (`secwriter-frontend`, which now ships `HocuspocusProvider`) must move together. Render deploys the two services non-atomically, so the order below matters.

## Pre-deploy checklist

1. **All four gates green** (CI + the migration branch):
   - A1 (UndoManager origin) — peer edits stay off the local undo stack.
   - A2 (seed safety) — load-ordering, load-once-from-memory, warm-doc, client re-seed guard.
   - Shutdown drain — completes within the SIGTERM grace (measured ~272ms at N=50 rooms × ~200 blocks × 200ms write latency; well under the ~20s margin).
   - Rollback byte-compare (Phase 9) — **GREEN**: a v2 `Y.XmlFragment` `.ydoc` round-trips through a bare `Y.applyUpdate` to byte-identical `.SEC`.
2. **Single-Yjs CI assertion passing** (`unit-tests` job) — protects the Hocuspocus peer-dep pin.
3. **Reverse-proxy WS route reviewed.** The client now connects to the bare `VITE_COLLAB_WS_URL` with the room name in-band (`<tenant>/<roomId>`), NOT a `/ws/<room>` URL path. If `VITE_COLLAB_WS_URL` keeps the `…/ws` suffix the existing proxy `/ws/*` block still works; if it is changed to the bare host, update the proxy WS location. See the banners in `deploy/nginx.conf` / `deploy/Caddyfile`.
4. **Node 22** on both services (Hocuspocus `engines >=22`).

## Mandated deploy order + drain

1. **Active drain BEFORE cutover** (not just "low traffic"): flip rooms read-only via the existing lock mechanism (or broadcast a "saving, reconnecting shortly" notice); confirm all bound rooms have flushed; confirm `/health` shows 0 active connections (or force-flush). Un-flushed debounced edits at the moment of cutover are otherwise at risk.
2. **Pre-deploy migration scan:** ensure no room is mid-migration across the cutover. A room left in `migrationPartial` stays editable and re-evaluates safely; the cross-stack rollback gate confirms the old broker no-ops a Hocuspocus-migrated room.
3. **Deploy `secwriter-collab` (server) FIRST.** While the new server is authoritative, old `WebsocketProvider` clients fail to sync — they are locked out but recoverable (no data corruption). The reverse — frontend first — is the worst case (every client locked out AND new edits stranded unsynced against a still-old server), so never deploy the frontend first.
4. **Confirm `/health` green on the new server** (process up, storage reachable) **BEFORE** triggering the frontend deploy.
5. **Deploy `secwriter-frontend`** (`HocuspocusProvider`, Vite-inlined `VITE_COLLAB_WS_URL`). Clients recover cleanly as the new bundle rolls out.

## HTTP surface during the cutover window

The HTTP surface (`POST /rooms/:id/upload`, `PATCH`, `DELETE`, `/sec`, `/comments`, `/rooms`, `/health`) is NOT version-gated and is served by the same `http-handler.cjs` on both stacks.

- **`POST /rooms/:id/upload`** is unchanged by #128. The create-room flow does NOT use it (that design was rejected — see ADR-0018); it remains the external-tooling re-upload path and still requires a **live bound Y.Doc** (409 "no active session" otherwise — `http-handler.cjs`). Its windows-1252 decode + `seedRoomFromBlocks` + awaited `flushRoom` behave identically under the Hocuspocus server (`flushRoom` now routes through `SecWriterDatabase.store`). The doc is bound under the canonical composite `<tenant>/<roomId>` (the client's provider `name`); the upload route looks up the same composite, so a caller must have a WS client connected to the canonical room first.
- No HTTP route accepts a body that bypasses the server's authoritative doc state.
- The client seed-on-empty still exists (option A) but is gated on `onSynced` (fires only after server state is applied) + the `seededRooms` guard, so a client that failed to WS-sync never reaches the seed with stale local state, and an existing room never observes false-empty.

## Rollback

Phase 9 gate is **GREEN**, so rollback is clean: **revert the merge commit**; both services rebuild from the prior commit. A reverted (pre-#128) server reading the post-migration v2 `Y.XmlFragment` `.ydoc` produces byte-identical `.SEC` (verified by `tests/cross-stack-rollback.node-test.mjs`), so no manual `.ydoc` re-export is required.

(If a future change turns that gate RED, this section must be rewritten: rollback would then require exporting each room's `.SEC` from the new stack and re-importing into the old.)

## SIGKILL honesty

The graceful shutdown drain (`closeConnections()` → `flushPendingStores()` → `await database.drain()`) covers **SIGTERM only**. A hard **SIGKILL** (or process crash) loses any edit still inside the debounce window that has not flushed — the same exposure as the pre-#128 `unref()`'d flush timer. Render sends SIGTERM with a grace period before SIGKILL; the drain is measured to complete well within it, but a platform hard-kill is still data loss for in-flight un-flushed edits. Do not represent the cutover as eliminating crash-loss.

## Operational limits carried from ADR-0018

- **Single-instance only.** Hocuspocus holds each room's authoritative `Y.Doc` in one instance's memory; the seed safety and the per-key store re-entrancy guard are correct ONLY on a single instance (Render `plan: free`). Autoscaling to >1 instance requires `@hocuspocus/extension-redis` + a distributed `.ydoc` write lock — revisit before scaling.
- **Revocation latency** = "until the socket drops" (per-connect re-auth only). A revoked user keeps editing an open session until it reconnects.
