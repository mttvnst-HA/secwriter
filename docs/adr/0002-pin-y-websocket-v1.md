# ADR-0002: Pin y-websocket at v1

**Status:** Superseded by [ADR-0018](0018-collab-relay-hocuspocus.md) (2026-06-22)
**Date:** 2026-05-01

> **Superseded.** The y-websocket v1 pin's gating migration happened in [#128](https://github.com/mttvnst-HA/secwriter/issues/128) (ADR-0018). The eviction race (yOrder doubles after stale-close) is no longer handled by the upgrade-handler re-install guard described below; instead it is closed by: the client seed being re-gated on `onSynced` (so an empty-at-synced observation is genuinely new — a load-ordering contract Hocuspocus `onSynced` guarantees after `onLoadDocument` has applied), the module-level `seededRooms` per-room guard against reconnect/StrictMode re-seeds, and `unloadImmediately: false` warm-doc (a provider remount re-syncs from memory rather than reloading an empty doc before the seed flushed). The original body below is retained as the historical record.

## Context

`y-websocket` is the WebSocket transport for the collab server. Dependabot has proposed v3 upgrades repeatedly. The upgrade has been deliberately deferred.

The fix for issue #17 (the "yOrder doubles after stale-close eviction" pathology) is built around y-websocket **v1** internals. Specifically:

- y-websocket v1's `closeConn` (`node_modules/y-websocket/bin/utils.js`) does `docs.delete(doc.name)` keyed by **name**, not by instance. When a stale TCP close drains during a new connection's preload `await`, the stale close evicts our just-loaded doc and `setupWSConnection` creates a fresh empty replacement that bypasses preload.
- The **eviction guard** in `server/collab-server.cjs` re-installs the preloaded doc into y-websocket's `docs` Map after the preload `await` but before `handleUpgrade`.
- A deterministic regression test for the race lives at `server/__tests__/collab-server.test.mjs` — it manually deletes the docs Map entry mid-await to force the eviction.

v3 has different internals. The same eviction race may not exist, may be fixed differently, or may exist with a different signature. Upgrading without re-validating would put issue #17 at risk.

## Decision

`y-websocket` is pinned at v1.x in `package.json`. Dependabot upgrades to v2/v3 are declined until a deliberate upgrade exercise re-validates the eviction guard against the new internals.

## Consequences

- **Positive:** Issue #17 stays fixed. The deterministic regression test continues to exercise a real race.
- **Negative / cost:** No security or performance fixes from y-websocket v2/v3. ESM-only future is blocked (see ADR-0001).
- **Re-litigation risk:** Without this ADR, every Dependabot bump looks like a routine patch. The eviction-race history is invisible from the v1→v3 diff.

## Alternatives considered

- **Upgrade and re-test the eviction race** — viable, but requires a focused exercise: re-read `server/collab-server.cjs:67` (extractDocName), `server/collab-server.cjs:350` (eviction guard), and `server/__tests__/collab-server.test.mjs`; re-derive whether v3 has equivalent name-keyed deletion semantics; either confirm the guard still works or write a new one.
- **Fork y-websocket** — disproportionate maintenance cost.

## When to revisit

When any of the following is true:

1. A focused y-websocket v3 upgrade exercise is scheduled, with the eviction-race regression test as its acceptance criterion.
2. y-websocket upstream documents (or a maintainer confirms) that v3 no longer evicts by name when a doc's last conn drops.
3. SecWriter migrates off y-websocket to a different transport.

Until then, `y-websocket@^1` stays.
