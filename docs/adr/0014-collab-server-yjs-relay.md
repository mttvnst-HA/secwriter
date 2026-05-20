# ADR-0014: Collab server — Yjs + y-websocket relay, CJS, four non-obvious patterns

**Status:** Accepted
**Date:** 2026-05-20

## Context

SecWriter's real-time multi-user editing rides Yjs + y-websocket. The server is a thin relay — it terminates WebSocket connections, hosts the per-room `Y.Doc`, persists via a pluggable storage backend ([ADR-0013](0013-storage-backends.md)), and exposes a small HTTP surface for non-WS operations (room listing, .SEC export/upload, comments).

Two foundational decisions sit upstream — [ADR-0001](0001-server-uses-commonjs.md) (server stays CommonJS to keep yjs single-instance) and [ADR-0002](0002-pin-y-websocket-v1.md) (y-websocket pinned at v1). This ADR documents the server's structure and the four non-obvious runtime patterns that have bitten the project enough times to need an authoritative writedown.

## Decision

Server lives in `server/`:

- **`server/collab-server.cjs`** — y-websocket relay. Exposes `createCollabServer({ storage })` factory; CLI entry-point gated by `if (require.main === module)` so tests can `require()` without binding a port.
- **`server/http-handler.cjs`** — HTTP endpoints (`/rooms`, `/rooms/:id`, `/rooms/:id/sec`, `/rooms/:id/comments`, `/health`, `/rooms/:id/upload`).
- **`server/room-serializer.cjs`** — extracts .SEC + .comments.json from a Y.Doc on flush.
- **`server/storage-{local,azure,s3}.cjs`** — pluggable persistence ([ADR-0013](0013-storage-backends.md)).
- **`server/migrate-pm-substrate.cjs`** — sub-PR 1d ([#47](https://github.com/mttvnst-HA/secwriter/issues/47), [ADR-0006](0006-pm-substrate-migration.md)) v1 → v2 substrate broker (Y.Text → Y.XmlFragment). Hooked into `collab-server.cjs`'s upgrade handler after the preload + eviction-guard re-install; the broker awaits `storage.archiveRoom` (Q23/B2) before mutating the doc, runs migration under a per-room async lock (Q22/B1), and stamps either `yMeta.schemaVersion = 2` or `yMeta.migrationPartial = true` (mutually exclusive). The Y.Text-delta → Y.XmlFragment adapter is hand-coded (no `prosemirrorToYXmlFragment` import) to avoid compounding the dual-package "Yjs was already imported" warning.
- **`server/auth/auth-provider.cjs`** — JWT auth (optional via env).
- **`server/__tests__/`** — `node --test` integration suite. Run via `npm run test:server`.

### Four non-obvious patterns (load-bearing)

1. **`extractDocName` strips a leading `/ws/`.** `VITE_COLLAB_WS_URL` in production deploys is `wss://host/ws`; WebsocketProvider then connects to `wss://host/ws/<room>`. y-websocket's default extraction (`req.url.slice(1).split('?')[0]`) yields `"ws/<room>"` — sanitized to `ws_<room>.ydoc` in storage. Without `extractDocName`, you get parallel rooms (one HTTP-managed, one WS-managed). See `server/collab-server.cjs:67`.

2. **Stale-close eviction guard.** y-websocket's `closeConn` (`node_modules/y-websocket/bin/utils.js:208`) does `docs.delete(doc.name)` keyed by name when a doc's last conn drops. If a previous WS connection's TCP close drains during a new connection's preload `await`, the stale close evicts our just-loaded doc and `setupWSConnection` creates a fresh empty replacement that bypasses preload — sync step 1 fires with empty state, the client seeds, persisted state CRDT-unions on top, yOrder doubles. Mitigated by re-installing the preloaded doc into `ywsDocs` after the await but before `handleUpgrade`. See `server/collab-server.cjs` (~line 360, the preload re-install block in the upgrade handler) and the deterministic regression test in `server/__tests__/collab-server.test.mjs`. The guard is re-installed a SECOND time after the broker await (1d) for the same reason.

3. **Migration broker invariants (1d).** The broker between preload and `handleUpgrade` adds another await window — same eviction risk, same re-install pattern. Three things are load-bearing: (a) `yMeta.schemaVersion` and `yMeta.migrationPartial` are mutually exclusive — broker code must never write both in the same migration; (b) `archiveRoom` MUST happen before any mutation, archive failure aborts (room stays v1); (c) per-block conversion catches every throw and tracks it as `migrationPartial` rather than rolling back the whole migration — half-converted rooms remain editable for both v1 and v2 clients. See [ADR-0006](0006-pm-substrate-migration.md).

4. **`GET /rooms` iteration yields the event loop (PR [#112](https://github.com/mttvnst-HA/secwriter/pull/112), issue [#100](https://github.com/mttvnst-HA/secwriter/issues/100)).** The handler iterates every persisted room and calls `Y.applyUpdate` synchronously to extract section metadata from the `.ydoc` bytes. With the OS file cache warm, the surrounding `await storage.readRoom(id)` resolves without releasing the loop, so listing N rooms freezes the event loop for `N * decode_ms` — observed up to 2.7s with 100 rooms, enough to starve WS handshakes and other HTTP handlers for any concurrent client. Mitigated by `await new Promise(resolve => setImmediate(resolve))` at the top of every iteration in `server/http-handler.cjs`. Looks like a no-op but is load-bearing — the regression test (`server/__tests__/http-list-rooms-event-loop.test.mjs`) installs a 25ms ticker, fires `GET /rooms` against 40 seeded rooms, asserts `maxGap < 200ms`, and fails ~500ms without the yield.

### Inspecting / cleaning up production rooms

```bash
curl https://secwriter-collab.onrender.com/health
curl https://secwriter-collab.onrender.com/rooms
curl https://secwriter-collab.onrender.com/rooms/<id>/sec       # SEC export
curl -X DELETE https://secwriter-collab.onrender.com/rooms/<id> # delete corrupted room
```

## Consequences

- **Positive:**
  - **Single-process relay.** Yjs + y-websocket + HTTP share one Node process; storage backends are polymorphic ([ADR-0013](0013-storage-backends.md)).
  - **Four non-obvious patterns pinned by deterministic regression tests.** Each lived as a heisenbug for at least one release cycle; the regression tests prevent re-introduction.
  - **CJS isolation.** Single Yjs instance across server + room-serializer per [ADR-0001](0001-server-uses-commonjs.md) — `instanceof` checks for `Y.Text`, `Y.XmlFragment`, `Y.Map` work uniformly.
- **Negative / cost:**
  - **y-websocket v1 internals are load-bearing.** The `closeConn` eviction guard depends on the docs-Map-keyed-by-name behavior; v3 changes this. Pinning per [ADR-0002](0002-pin-y-websocket-v1.md).
  - **`setImmediate` yield in `GET /rooms` looks like a no-op.** A drive-by cleanup that removes it will re-introduce the event-loop starvation. The regression test exists; reviewers must check both.
  - **Dual `Y.Doc` mutation gates** (preload re-install + broker re-install) add complexity to the upgrade handler. The code comment in `collab-server.cjs` explains the second re-install; without context it looks redundant.
- **Re-litigation risk:**
  - **"Why CJS?"** Yjs single-instance — see [ADR-0001](0001-server-uses-commonjs.md). Mixing ESM and CJS loads two copies and breaks `instanceof`.
  - **"Why pin y-websocket v1?"** Eviction-guard logic depends on v1 internals. See [ADR-0002](0002-pin-y-websocket-v1.md).
  - **"Why doesn't `GET /rooms` use a worker thread?"** The `setImmediate` yield is sufficient — the test asserts `maxGap < 200ms`. Worker IPC would be more code and more complexity for the same observable outcome.

## Alternatives considered

- **ESM server.** Rejected per [ADR-0001](0001-server-uses-commonjs.md) — yjs dual-package hazard breaks `instanceof`.
- **y-websocket v3.** Deferred per [ADR-0002](0002-pin-y-websocket-v1.md). Eviction-guard semantics need re-validation against v3 internals.
- **Worker thread for `GET /rooms` decoding.** Rejected — `setImmediate` yield meets the latency target with less complexity.
- **Separate microservice per concern (WS / HTTP / serializer).** Rejected — adds IPC + ops surface for no functional gain at current scale.
