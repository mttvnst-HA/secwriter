# ADR-0001: Server uses CommonJS, not ESM

**Status:** Accepted
**Date:** 2026-05-01

## Context

The frontend is ESM (Vite + React). The collab server (`server/collab-server.cjs`, `server/http-handler.cjs`, `server/storage-*.cjs`, `server/room-serializer.cjs`) is CommonJS. There is regular pressure — from Dependabot bumps, from style consistency arguments, and from periodic "modernize the server" proposals — to convert the server to ESM.

Two constraints make the conversion unsafe:

1. **y-websocket v1 ships its server utils as CommonJS** and `require`s `yjs` directly. See ADR-0002 for why we are pinned at v1.
2. **Mixing ESM and CJS loads two copies of `yjs`**, and `instanceof` checks against shared types (Y.Doc, Y.Text, Y.Array, Y.Map) fail across instance boundaries. This is yjs/yjs#438 and is not fixable without a single module realm.

The room serializer additionally does a dynamic `import('../src/lib/sec-serializer.js')` to reuse the frontend serializer in the server's flush path. This emits a "Yjs was already imported" warning during tests; that warning is **expected** and must not be treated as a defect to "fix" by switching the server to ESM.

## Decision

Server-side code remains CommonJS for as long as `yjs` is loaded into the server process. New server modules use `.cjs` and `require()`. The dynamic `import()` of the shared serializer stays as-is.

## Consequences

- **Positive:** `instanceof` checks across yjs types work reliably. y-websocket v1 internals are usable without shimming. Single-instance yjs invariant is preserved.
- **Negative / cost:** Server cannot use top-level `await`, named imports, or `import.meta`. Test harness uses `node --test` with CJS-compatible patterns (see `server/__tests__/`). Some ergonomic friction when sharing code with the ESM frontend.
- **Re-litigation risk:** Without this ADR, the "modernize to ESM" proposal recurs every 6–12 months. The Yjs-warning-during-tests is a frequent trigger.

## Alternatives considered

- **Server as ESM with `createRequire()` to load yjs as CJS** — does not work; the require'd yjs and any transitively-imported ESM yjs are still two instances.
- **Server as ESM and upgrade y-websocket to v3** — v3 ships ESM, but its internals differ from v1, and the eviction guard described in ADR-0002 would need re-validation. This is a viable future path but requires that ADR's revisit conditions to be met first.

## When to revisit

When y-websocket v3 (or successor) is adopted (see ADR-0002), and the eviction-guard race is either fixed upstream or independently re-verified, the CJS constraint can be re-evaluated. Until then, this ADR stands.
