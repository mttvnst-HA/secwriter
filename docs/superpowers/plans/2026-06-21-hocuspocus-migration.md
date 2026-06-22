# Collab Transport Migration — y-websocket v1 → Hocuspocus Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the y-websocket v1 collab relay (server + client) with Hocuspocus v4, preserving every current behavior 1:1, so #239 can later set `connectionConfig.readOnly` per connection for a viewer role.

**Architecture:** A `Hocuspocus` instance (required from CommonJS) is mounted on the existing `http.createServer` via a manual `upgrade` handler that keeps the per-IP rate-limit + malformed-token DoS guards in front of `server.handleConnection(ws, req, context)`. JWT validation, the validate-AND-reject-non-canonical tenant keying, and `.acl.json` authorization run inside `onAuthenticate`. Persistence is a `SecWriterDatabase extends @hocuspocus/extension-database` subclass wrapping the unchanged `RoomStorageBase` adapters and running the full `serializeRoom`. The v1→v2 migration broker moves to `onLoadDocument`. The client swaps `WebsocketProvider` → `HocuspocusProvider`.

**Tech Stack:** `@hocuspocus/server@4.3.0`, `@hocuspocus/provider@4.3.0`, Yjs 13 (single hoisted copy via peerDeps), Node 22, CommonJS server (ADR-0001), Vitest + `node --test` server suite, Playwright E2E.

**Reference spec:** [docs/superpowers/specs/2026-06-21-hocuspocus-migration-design.md](../specs/2026-06-21-hocuspocus-migration-design.md). Read it before starting — this plan implements it section by section.

---

## How to read this plan

The four **Gating** items from the spec (A1 undo origin, A2 seed correctness, shutdown-flush within grace, cross-stack rollback) are front-loaded. Each gate needs a thin slice of infrastructure to run against, so the order is: Node bump → minimal server skeleton → **Gate A1** → tenant security → persistence → **Gate shutdown-flush** → broker → **Gate A2** → full client → **Gate cross-stack rollback** → E2E/docs/deploy.

> **Design change since the first draft (2026-06-21, after a verification spike + FOUR independent reviews — the fourth read the live Hocuspocus docs/source and checked the repo line by line).** Read these before the phases:
> 1. **Seed stays CLIENT-side, re-gated on Hocuspocus's proven `synced` contract (option A).** The fourth review found that the earlier "server-authoritative seed via `POST /rooms/:id/upload` before connecting" design could not work: that endpoint returns **409 if the room has no live bound Y.Doc** ([http-handler.cjs:238](../../../server/http-handler.cjs)), and a brand-new room nobody has WS-connected to yet is not bound — so create-room could never upload. It also produces **v1 Y.Text**, not the v2 substrate ([room-serializer.cjs:196](../../../server/room-serializer.cjs)). And its one advantage over the client seed — concurrent-create safety via `writeAclIfAbsent` — **only exists under auth=jwt** ([http-handler.cjs:377](../../../server/http-handler.cjs)); under the default auth=none (the demo/prod config) there is no atomic claim, so it bought nothing there. So the client `handleSync` seed-on-empty is KEPT, moved onto Hocuspocus's `onSynced` event, which the spike PROVED fires only after the server-loaded state is applied to the client doc. On a single instance (Render free plan — `render.yaml` `plan: free`, no autoscaling) every client to a room shares ONE in-memory Y.Doc and `onLoadDocument` runs once, so the classic two-client doubling cannot happen (the second client syncs the first's seed from memory). The residual risk is NOT concurrent-create — it is a **reconnect/StrictMode re-seed** (a provider remount that sees the room empty because the seed was evicted before it flushed). Gate A2 closes that with a client-side per-room seed guard + a server warm-doc config, and pins the whole thing with the load-ordering + never-doubles tests. The fragile `_serverMeta.newRoom` doc-attribute signal is still gone (it would have persisted into `.ydoc` and resurfaced on reload).
> 2. **API surface is now CONFIRMED, not guessed** (installed `@hocuspocus/server@4.3.0`, `@hocuspocus/provider@4.3.0`, `@hocuspocus/extension-database@4.3.0` — confirmed the CURRENT latest; see Task 1.2 for the recorded surface). The server uses the **bare `Hocuspocus` class** (`new Hocuspocus({…})`), NOT `Server.configure` (that is pre-v2) and NOT the HTTP-wrapping `Server` (which would create its own `httpServer` and fight ours). The bare class has **no `destroy()`** — the shutdown drain is `closeConnections()` + `flushPendingStores()` + awaiting `SecWriterDatabase`'s own store-chain promises (Phase 5).
> 3. **Known Hocuspocus integration hazards (fourth review, from docs + GitHub issues), each addressed in the noted phase:** (a) **multi-instance split-brain** — Hocuspocus holds each room's authoritative doc in ONE instance's memory; >1 instance without `@hocuspocus/extension-redis` splits rooms and races the `.ydoc` key. NOT a risk on the free single-instance plan; recorded as an explicit deployment assumption in ADR-0018 (Phase 11) — revisit before any autoscale. (b) **`debounce` default is 2000ms, not 500** — Phase 4.2 sets it deliberately after measuring serialize cost. (c) **revocation is per-connect only** (issue [#752](https://github.com/ueberdosis/hocuspocus/issues/752)) — an already-connected user keeps editing until the socket drops; Phase 3.3's test asserts only fresh-reconnect rejection and the ADR states the latency honestly. (d) **provider teardown/reconnect quirks** ([#803](https://github.com/ueberdosis/hocuspocus/issues/803) destroy-reopens, [#782](https://github.com/ueberdosis/hocuspocus/issues/782) disconnect/connect drops edits, [#566](https://github.com/ueberdosis/hocuspocus/issues/566) token-not-resent after server-initiated close) — Phase 8.2 handles a server-initiated close, not just clean reconnect. (e) the unload-during-debounce / memory-leak races ([#832](https://github.com/ueberdosis/hocuspocus/issues/832)/[#846](https://github.com/ueberdosis/hocuspocus/issues/846)) are **`DirectConnection`-only** — this design uses WebSocket connections exclusively, so they do NOT apply; Phase 6 notes this rather than guarding.

**Gate failure protocol.** Each gate task ends with an explicit pass/fail criterion. If a gate FAILS, stop and revisit the spec section it pins (do NOT build the dependent phase on a red gate). The spec calls these out as "assumptions currently dressed as design" — a red gate means the design needs rework, not a workaround.

**API-confirmation steps.** The 2026-06-21 spike installed the packages and recorded the exact API surface (Task 1.2). Where this plan shows a Hocuspocus call, it uses a confirmed name. A few names are still marked "confirm against the type defs" because the spike did not exercise that exact path (e.g. `connectionConfig.readOnly` write-gating for #239, the `storePayload.state` vs re-encode question); read `node_modules/@hocuspocus/server/dist/index.d.ts`, `node_modules/@hocuspocus/extension-database/dist/index.d.ts`, and `node_modules/@hocuspocus/provider/dist/index.d.ts` for those. The PM/Yjs authoritative-source rule in CLAUDE.md applies equally to Hocuspocus.

**Node-test provider rule (load-bearing).** EVERY `new HocuspocusProvider({…})` constructed in a Node/Vitest context (every gate + server test below) MUST pass `WebSocketPolyfill: ws` (the `ws` package) or it silently never connects and the test hangs to timeout. The snippets that follow include it; if you copy a provider construction elsewhere, add it. (The browser build needs no polyfill — `window.WebSocket` is present.)

**Dual-package Yjs rule for new test files.** New ESM test files (`.test.js` Vitest, `.node-test.mjs`) that need to construct Yjs types AND call into a CJS server module (`room-serializer.cjs`, `collab-server.cjs`, `secwriter-database.cjs`) must obtain `Y` from the SAME copy the CJS side uses. Use `createRequire(import.meta.url)` to `require('yjs')` and `require(...cjs)` together, OR assert `Y === require('yjs')` at the top of the test, so `instanceof`/`toArray` checks don't fail across two copies. The cross-stack test (Phase 9) shows the pattern.

---

## File structure

**Phase 0 — Node bump (separate prior commit/PR):**
- Modify: `.github/workflows/ci.yml` (3 jobs: `node-version: 20` → `22`)
- Modify: `package.json` (add `"engines": { "node": ">=22" }`)

**New files:**
- Create: `server/secwriter-database.cjs` — `SecWriterDatabase extends Database`; `fetch`/`store` over `RoomStorageBase`.
- Create: `server/hocuspocus-auth.cjs` — `buildOnAuthenticate({ authProvider, storage })`: the validate-AND-reject-non-canonical `onAuthenticate` (§3), unit-testable in isolation.
- Create: `server/__tests__/hocuspocus-auth.test.mjs` — onAuthenticate unit tests (canonical rejection, checkPrincipal, opaque-close parity).
- Create: `server/__tests__/secwriter-database.test.mjs` — fetch/store round-trip, 8 MB refusal, roomHealth, re-entrancy.
- Create: `src/lib/__tests__/hocuspocus-undo-origin.test.js` — **Gate A1** two-provider loopback (positive control + peer-edit-ignored).
- Create: `tests/cross-stack-rollback.node-test.mjs` — **Gate cross-stack rollback** byte-compare.
- Create: `server/__tests__/hocuspocus-server.test.mjs` — **all** new Hocuspocus server-level tests: cross-tenant/non-canonical WS rejection + fetch-gating (Phase 3.3), readOnly write-frame-dropped #239-readiness (Phase 3.3), store→load gc survival (Phase 4.3), shutdown-flush + measured-within-grace (Phase 5.2), and **Gate A2** server-side properties — load-ordering + load-once-from-memory + warm-doc-across-reconnect (Phase 7.2). This is a NEW file because `collab-server.test.mjs` sits at ~17 tests and these additions would breach the 30-test cap (review B3 / CLAUDE.md rule #3). `http-endpoints.test.mjs` is ALSO at the 30-cap, so no new HTTP-route tests can land there either. Keep this file ≤30 — the rejection-name matrix is ONE `it()` with an internal `for` loop over the malicious names (fewer `it()` calls than `it.each`, same coverage).

**Modified files:**
- Modify: `server/collab-server.cjs` — replace y-websocket relay with a bare `Hocuspocus` instance + upgrade handler; rewrite `getActiveUsers`; SIGTERM → `closeConnections()` + `flushPendingStores()` + `database.drain()`.
- Modify: `server/migrate-pm-substrate.cjs` — broker entry adapted for `onLoadDocument` (catch-and-return, enqueue-store).
- Modify: `src/lib/collab.js` — `WebsocketProvider` → `HocuspocusProvider`; KEEP the client `handleSync` seed-on-empty, re-gated on Hocuspocus's `onSynced` and protected by a module-level per-room seed guard against reconnect/StrictMode re-seed (Phase 7); status/sync/reconnect/token re-wiring; `window.__collab`.
  (NOTE: `src/App.jsx` is NOT modified for seeding — the earlier "create-room uploads the .SEC" design was dropped after the fourth review showed `/upload` 409s on a cold room. The create-room flow is unchanged.)
- Modify: `src/hooks/useCollabSession.js` — `effectiveStatus` + sticky-status filter re-proven against Hocuspocus events; `getInitialBlocks` still feeds the client seed (unchanged role).
- Modify: `server/__tests__/migrate-pm-substrate.test.mjs` — batch broker-under-`onLoadDocument` + end-to-end assertions into existing `it()` (AT 30-test cap — do NOT add test #31).
  (Note: `collab-server.test.mjs` is NOT modified for new tests — see the new `hocuspocus-server.test.mjs` above. It changes only if Phase 8.3's y-websocket-path deletion removes tests that referenced the old relay.)
- Modify: `server/__tests__/storage-contract.test.mjs` — `SecWriterDatabase` round-trip (or place in the new database test if cap pressure).
- Modify: `package.json` — add hocuspocus deps; add `server/__tests__/*` new files to `test:server` script.
- Modify: ADRs + CLAUDE.md (Phase 11).

---

## Phase 0 — Node 20 → 22 (lands as its own commit BEFORE the migration PR)

Per spec §9: a native-dep ABI or `engines` failure must not strand the transport deploy. This phase is green-on-its-own.

### Task 0.1: Bump CI runners to Node 22

**Files:**
- Modify: `.github/workflows/ci.yml` (lines 17, 40, 122 — the three `node-version: 20`)

- [ ] **Step 1: Edit all three jobs**

In `.github/workflows/ci.yml`, change every `node-version: 20` to `node-version: 22` (three occurrences: `unit-tests`, `azure-integration`, `e2e-tests`).

- [ ] **Step 2: Pin Node via package.json engines (committed, so CI + Render cannot drift)**

In `package.json`, add a top-level `engines` block after `"license": "MIT",`:

```json
  "engines": {
    "node": ">=22"
  },
```

- [ ] **Step 3: Verify the full server + unit suite locally under Node 22**

Run: `node --version` (expect `v22.x`; if not, install/switch first), then:
```
npm ci
npm test
npm run test:server
npm run test:compliance
npm run test:interop:encoding
```
Expected: all green. The windows-1252 path uses the pure-JS `decodeWindows1252` (ICU-independent) per the memory note — confirm `test:interop:encoding` passes and that no test asserts Node-20 small-ICU C1-control behavior.

- [ ] **Step 4: Confirm native deps install + load under Node 22**

Run: `node -e "require('@aws-sdk/client-s3'); require('@azure/storage-blob'); console.log('native deps OK')"`
Expected: `native deps OK` (no ABI/load error). harper.js WASM is exercised by `npm test`.

- [ ] **Step 5: Commit (separate PR, merge + confirm CI green before starting Phase 1)**

```bash
git add .github/workflows/ci.yml package.json
git commit -F- <<'EOF'
chore(ci): bump Node 20 -> 22 for Hocuspocus engines (#128)

Hocuspocus requires engines node >=22. Land the runtime bump as its own
commit before the transport swap so a native-dep ABI or engines failure
can't strand the migration deploy. Pin via package.json engines so CI and
Render cannot drift.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
```

> **STOP after Phase 0.** Open this as its own PR, merge it, and confirm all CI jobs are green on Node 22 before beginning Phase 1. The rest of this plan assumes Node 22 is live.

---

## Phase 1 — Dependencies + minimal Hocuspocus server skeleton

Goal: a Hocuspocus instance that loads/syncs an in-memory room, with the pre-auth DoS seam preserved — enough to run **Gate A1**. Persistence and security are stubbed minimally here and completed in later phases.

### Task 1.1: Add Hocuspocus dependencies

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install the two packages at the spiked versions**

Run:
```
npm install --save-exact @hocuspocus/server@4.3.0 @hocuspocus/provider@4.3.0 @hocuspocus/extension-database@4.3.0
```
Expected: added to `dependencies` (pinned exact — the PM-version-pin discipline in CLAUDE.md applies; a Hocuspocus minor can drag a skewed `y-protocols`/`lib0` peer). `yjs`/`y-protocols` stay as our direct deps; Hocuspocus declares them as peerDeps so npm keeps our single hoisted copy. (The 2026-06-21 spike installed all three at 4.3.0 to confirm the API surface in Task 1.2, then reverted them so the planning branch stayed docs-only — THIS step performs the committed install. Land it AFTER Phase 0's Node bump per the plan ordering.)

- [ ] **Step 1b: Move `ws` from devDependencies to dependencies**

The manual upgrade handler (Task 1.3) constructs `new WebSocketServer({ noServer: true })` from `ws` on the server at RUNTIME (not just in tests), so `ws` is now a production server dependency. Move it from `devDependencies` → `dependencies` in `package.json`. (It is currently a devDep because only tests used it.)

- [ ] **Step 2: Confirm CommonJS require resolves to the .cjs build with our hoisted Yjs**

Run:
```
node -e "const {Server,Hocuspocus}=require('@hocuspocus/server'); const Y=require('yjs'); const d=new Y.Doc(); console.log(typeof Hocuspocus, d.getText() instanceof Y.Text)"
```
Expected: `function true` (Hocuspocus required from CJS; `instanceof Y.Text` holds across the shared copy — spike fact 1).

- [ ] **Step 3: Confirm single-Yjs-instance invariant (the version-pin gate from §Gating)**

Run:
```
node -e "const a=require('yjs'); const b=require('@hocuspocus/server'); /* force load */ require('@hocuspocus/extension-database'); console.log(require.resolve('yjs'))"
```
Expected: exactly one resolved `yjs` path. Note the path; Task 11.x adds a CI assertion that `npm ls yjs` shows a single deduped copy so a future Hocuspocus bump dragging a skewed `y-protocols`/`lib0` peer can't reintroduce a second copy.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "feat(server): add Hocuspocus deps (CJS-safe, peer Yjs) (#128)"
```

### Task 1.2: Confirmed Hocuspocus API surface (recorded 2026-06-21 spike)

The 2026-06-21 spike read the installed `index.d.ts` for all three packages and ran a loopback experiment. The surface below is CONFIRMED against `@4.3.0` — use these names directly. Re-verify only if a version bump changes the lockfile.

**`@hocuspocus/server` (CJS-requireable via the `require` export condition):**
- Exports `Hocuspocus`, `Server`, `Document`, `Connection`, `MessageType`, … . **Use the bare `Hocuspocus` class** (we mount on our own `http.createServer`): `const { Hocuspocus } = require('@hocuspocus/server'); const hocuspocus = new Hocuspocus({ …config });`. The constructor takes `Partial<Configuration>` directly. `.configure(config)` also exists (chainable) but is not needed. **`Server.configure` does NOT exist in v4** (pre-v2 API) — do not use it.
- `Configuration` options confirmed: `name`, `onAuthenticate`, `onLoadDocument`, `onStoreDocument`, `extensions`, `debounce`, `maxDebounce`, `unloadImmediately`, `quiet`, `yDocOptions: { gc, gcFilter }` (so the document **`gc` flag IS settable** via `yDocOptions.gc`), `timeout`.
- `handleConnection(incoming: WebSocket | WebSocketLike, request, defaultContext?): ClientConnection` — confirmed signature; `defaultContext` is the third arg (we pass `{ remoteAddress }`). Hooks receive the `context` returned by `onAuthenticate` merged over this.
- `documents: Map<string, Document>` (confirmed — used by `getActiveUsers`). `Document` extends `Y.Doc` and carries `.awareness`.
- **Shutdown primitives on the bare class:** `flushPendingStores(): void` ("Immediately execute all pending debounced onStoreDocument calls. Useful during shutdown") and `closeConnections(documentName?): void`. There is **NO `destroy()` on `Hocuspocus`** — `destroy(): Promise<void>` is only on the `Server` HTTP wrapper. Phase 5 therefore drains via `closeConnections()` + `flushPendingStores()` + awaiting `SecWriterDatabase`'s own store-chain promises.
- `onLoadDocumentPayload` = `{ context, document, documentName, instance, requestHeaders, requestParameters, socketId, connectionConfig }`. **`connectionConfig.readOnly` is the per-connection read-only flag** (the #239 viewer lever — set it in `onAuthenticate`'s returned context or mutate `connectionConfig`; confirm the write-gating path in Task 3.3's #239-readiness test).

**`@hocuspocus/extension-database`:** exports `Database` (`implements Extension`). `constructor(configuration: Partial<{ fetch: (data: fetchPayload) => Promise<Uint8Array | null>, store: (data: storePayload) => Promise<void> }>)`. So **pass callbacks to `super({ fetch, store })`** (subclass-with-bound-methods is valid — the base just stores the callbacks and wires the `onLoadDocument`/`onStoreDocument` hooks to call them). The Database extension's `store` callback receives a `storePayload` that DOES carry a precomputed `state: Buffer` (`= Buffer.from(Y.encodeStateAsUpdate(document))`); the RAW `onStoreDocument` HOOK payload does NOT (it has `lastContext`/`lastTransactionOrigin`/`clientsCount`, no `state`) — don't conflate them. **`SecWriterDatabase.store` deliberately IGNORES the precomputed `state`** and runs the full `serializeRoom(document)` instead, because it must regenerate the .SEC/.comments/.lint sidecars, not just persist the ydoc bytes. Confirm `serializeRoom` emits a whole-doc `encodeStateAsUpdate` (not a diff) so `fetch`→`Y.applyUpdate` reconstructs the complete doc (Phase 4.3 round-trip pins this).

**`@hocuspocus/provider`:** exports `HocuspocusProvider`, `HocuspocusProviderWebsocket`, `WebSocketStatus`. Constructor options confirmed: `url`, `name`, `document`, `token`, `onSynced`, `onStatus`, `onAuthenticationFailed`, **`WebSocketPolyfill`** (REQUIRED in Node — pass `ws`). Instance: `isSynced: boolean`, `synced` getter, `forceSync()`, `.awareness`, EventEmitter (`.on('synced'|'status'|…)`). `onAuthenticationFailed` is a real event/option.

**Confirmed ordering fact (the basis for Gate A2):** with a 1500 ms artificial delay inside `onLoadDocument`, the client's `onSynced`/`synced` fired at ~1564 ms with the server-loaded state ALREADY applied to the client doc. So `synced` does not fire until `onLoadDocument` resolves and its state is delivered — Hocuspocus's `synced` is a strictly stronger contract than y-websocket v1's `sync`. (See `project-hocuspocus-migration-findings` memory.)

- [ ] **Step 1: Re-confirm the surface after Phase 1.1 installs the packages (only if versions differ)**

The spike reverted the install to keep this branch docs-only, so the surface above was recorded against `@4.3.0` but the lockfile does not yet carry it. After Phase 1.1 installs the three packages, if the lockfile resolves anything other than `@4.3.0`, re-read the three `index.d.ts` files (`node_modules/@hocuspocus/{server,extension-database,provider}/dist/index.d.ts`) and reconcile the names above before proceeding. If it is `@4.3.0`, this task is informational — no commit.

### Task 1.3: Stand up a minimal Hocuspocus instance behind the existing HTTP server

This task builds the skeleton with a **no-op auth** and an **in-memory-only** database so Gate A1 can run. Real auth = Phase 3; real persistence = Phase 4.

**Files:**
- Modify: `server/collab-server.cjs`

- [ ] **Step 1: Add a factory flag to construct the Hocuspocus relay alongside the existing one (temporary parallel path)**

At the top of `server/collab-server.cjs`, add the require (after the existing requires, ~line 44). Use the **bare `Hocuspocus` class** (we mount on the existing `httpServer`), and `WebSocketServer` from `ws` for the manual upgrade:

```js
const { Hocuspocus } = require('@hocuspocus/server');
// `ws` is already imported for the y-websocket path; reuse that WebSocketServer.
```

- [ ] **Step 2: Inside `createCollabServer`, build a Hocuspocus instance gated behind `config.useHocuspocus`**

This lets the existing y-websocket path keep running for tests during the migration; the flag flips to default-on in Phase 8 and the old path is deleted then. Add near the top of `createCollabServer`, after the config destructure:

```js
  // Migration scaffolding (#128): when useHocuspocus is set, the relay is a
  // Hocuspocus instance instead of the y-websocket setupWSConnection path.
  // Phase 1 wires a minimal instance (no auth, in-memory) so Gate A1 can run;
  // Phase 3/4 fill in onAuthenticate + SecWriterDatabase.
  const useHocuspocus = config.useHocuspocus === true;
```

- [ ] **Step 3: Construct the instance (minimal) and a noServer WebSocketServer that delegates to it**

Define a `buildHocuspocus()` helper inside `createCollabServer`. It references `httpServer`, so it MUST be **called after `httpServer` is constructed** (the `http.createServer(...)` at ~line 286), NOT "after the config destructure" — calling it at the top would throw `Cannot read properties of undefined (reading 'on')` because `httpServer` is not yet assigned. Define the helper anywhere (closure), but place the `if (useHocuspocus) { … }` CALL immediately AFTER the `httpServer` assignment.

```js
  function buildHocuspocus() {
    const hocuspocus = new Hocuspocus({
      name: 'secwriter',
      quiet: true,
      // Phase 1: no auth, no persistence. Filled in Phase 3 (onAuthenticate)
      // and Phase 4 (SecWriterDatabase extension).
      async onAuthenticate() { return {}; },
    });
    const hwss = new WebSocketServer({ noServer: true });
    httpServer.on('upgrade', (req, socket, head) => {
      // Pre-auth DoS seam (§1): per-IP WS rate-limit BEFORE handleConnection.
      const ip = socket.remoteAddress || 'unknown';
      const wsCheck = rateLimiter.checkLimit(ip, 'ws', wsRatePerMin);
      if (!wsCheck.allowed) {
        log.warn('ws.rate-limited', { ip, retryAfter: wsCheck.retryAfter });
        socket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n');
        socket.destroy();
        return;
      }
      hwss.handleUpgrade(req, socket, head, (conn) => {
        // documentName + token travel in-band (provider `name`/`token`); auth
        // runs in onAuthenticate. The 3rd arg is the defaultContext.
        // CRITICAL (verified against @hocuspocus/server@4.3.0 source): v4
        // `handleConnection` only CONSTRUCTS the ClientConnection — it attaches
        // NO socket listeners. The integration MUST pump messages in, exactly
        // as the bundled Server's open/message/close hooks do
        // (hocuspocus-server.cjs ~5600). Without this the relay accepts the
        // upgrade but never syncs (onAuthenticate/onLoadDocument never fire).
        const clientConnection = hocuspocus.handleConnection(conn, req, { remoteAddress: ip });
        conn.on('message', (data) => {
          const bytes = Array.isArray(data) ? Buffer.concat(data) : data;
          clientConnection.handleMessage(new Uint8Array(bytes));
        });
        conn.on('close', (code, reason) => {
          clientConnection.handleClose({ code, reason: reason ? reason.toString() : '' });
        });
      });
    });
    return { hocuspocus, hwss };
  }

  let hocuspocusInstance = null;
  let hocuspocusWss = null;
  // CALL SITE: this line goes immediately AFTER the `const httpServer =
  // http.createServer(...)` assignment (~line 286), not at the top of the
  // factory. buildHocuspocus() dereferences httpServer.
  if (useHocuspocus) {
    const built = buildHocuspocus();
    hocuspocusInstance = built.hocuspocus;
    hocuspocusWss = built.hwss;
  }
```

> Note: the y-websocket `setPersistence`/`httpServer.on('upgrade', …)` block below this must NOT also bind when `useHocuspocus` is true (two `upgrade` listeners would both fire). Guard the existing y-websocket `httpServer.on('upgrade', …)` registration with `if (!useHocuspocus)`.

- [ ] **Step 4: Export the Hocuspocus instance from the factory return**

Add `hocuspocus: hocuspocusInstance` to the returned object (near `httpServer, wss, …`).

- [ ] **Step 5: Guard the existing upgrade handler so only one path binds**

Wrap the existing `httpServer.on('upgrade', async (req, socket, head) => { … })` (line 317) registration in `if (!useHocuspocus) { … }`. Likewise wrap the `setPersistence({ … })` call (line 216) in `if (!useHocuspocus)` — y-websocket's global `setPersistence` must not run in the Hocuspocus path.

- [ ] **Step 6: Smoke-test the skeleton manually**

Write a throwaway script `server/__tests__/_scratch-hpsmoke.mjs` (delete after):
```js
import { createCollabServer } from '../collab-server.cjs';
import { createLocalStorage } from '../storage-local.cjs';
// minimal in-memory-ish storage stub is fine here; just assert listen works
const srv = createCollabServer({ storage: { readRoom: async () => null, writeRoom: async () => {}, readAcl: async () => ({ ownerId: 'x', sharedWith: [] }) }, useHocuspocus: true, authProvider: { requiresAuth: false, validateToken: async () => null } });
srv.httpServer.listen(0, '127.0.0.1', () => { console.log('listening', srv.httpServer.address().port, !!srv.hocuspocus); srv.cleanup?.(); srv.httpServer.close(); });
```
Run: `node server/__tests__/_scratch-hpsmoke.mjs`
Expected: `listening <port> true`. Delete the scratch file.

- [ ] **Step 7: Commit**

```bash
git add server/collab-server.cjs
git commit -m "feat(server): minimal Hocuspocus relay behind useHocuspocus flag (#128)"
```

---

## Phase 2 — GATE A1: HocuspocusProvider remote-update origin keeps peer edits off the undo stack

Spec §7 / §Gating item 1. **Blocks all client work.** This is the single highest-risk assumption.

### Task 2.1: Two-provider loopback test pinning undo-rejects-remote-edits

**Files:**
- Create: `src/lib/__tests__/hocuspocus-undo-origin.test.js`

- [ ] **Step 1: Write the failing test (real two-provider loopback, with a positive control)**

The test boots a real (minimal) Hocuspocus server, connects two `HocuspocusProvider`s to the same room, wires a `Y.UndoManager` with the production `trackedOrigins` on provider A's doc, and asserts two distinct things in ONE `it()`:
  1. **Positive control** — a LOCAL `'local-publish'` write on docA IS captured (`undoStack.length === 1`). Without this, a passing peer-edit assertion is multiply-explainable: `length === 0` also results from the scope not intersecting, the manager being dead, or the write never landing. The review (grounded in `UndoManager.js:213-219`: capture requires `captureTransaction` AND scope-intersection AND tracked-origin) flagged that the original test could not tell "peer edit correctly ignored" from "manager never worked."
  2. **Peer edit ignored** — provider B's remote edit does NOT grow A's undo stack. This is TWO distinct properties, asserted separately so the test cannot pass for the wrong reason (review M3, which flagged that the original bundled them into one `startsWith` check):
     - **Undo property (the load-bearing one):** the observed remote origin is NOT a member of the production `trackedOrigins` set (`['local-publish', ySyncPluginKey]`). This is WHY the stack doesn't grow — assert it explicitly, don't infer it from the stack length alone.
     - **Re-emit property (a different concern):** the remote origin is neither `null` nor a `'local-'` string, so `handleAfterTx`'s `origin.startsWith('local-')` early-return is NOT taken and React still receives the block. NOTE: if the provider applies remote updates with the **provider instance** (an object) as the origin — the way y-websocket does — then `typeof origin === 'string'` is false, the `local-` filter is skipped entirely, and that is fine for the re-emit path; the undo property above is what actually protects the stack. `null` is the documented-dangerous case (the UndoManager default `trackedOrigins` is `new Set([null])`), so we assert non-`null` positively.

The listener that records the remote origin is registered BEFORE B's write (the original Step-3 wording said "place the listener before the write" while the snippet put the write inline — that contradiction made the assertion vacuous; here it is one coherent sequence).

```js
import { describe, it, expect, afterEach } from 'vitest';
import * as Y from 'yjs';
import { HocuspocusProvider } from '@hocuspocus/provider';
import WS from 'ws';
import { createCollabServer } from '../../../server/collab-server.cjs';
import { ySyncPluginKey } from 'y-prosemirror';

// Minimal storage stub: no persistence, ACL always allows (auth=none path).
const stubStorage = {
  readRoom: async () => null,
  writeRoom: async () => {},
  readAcl: async () => ({ ownerId: '_public', sharedWith: [] }),
};

let srv;
afterEach(() => { try { srv?.cleanup?.(); srv?.httpServer?.close(); } catch {} });

function waitFor(predicate, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error('waitFor timeout'));
      setTimeout(tick, 20);
    };
    tick();
  });
}

describe('Gate A1: HocuspocusProvider remote-update origin', () => {
  it('local edit IS captured; peer edit is NOT (and arrives with a non-local, non-null origin)', async () => {
    srv = createCollabServer({
      storage: stubStorage,
      useHocuspocus: true,
      authProvider: { requiresAuth: false, validateToken: async () => null },
    });
    await new Promise(r => srv.httpServer.listen(0, '127.0.0.1', r));
    const url = `ws://127.0.0.1:${srv.httpServer.address().port}`;
    const room = '_public/gate-a1';

    const docA = new Y.Doc();
    const docB = new Y.Doc();
    // WebSocketPolyfill is REQUIRED in Node or the providers never connect.
    const provA = new HocuspocusProvider({ url, name: room, document: docA, WebSocketPolyfill: WS });
    const provB = new HocuspocusProvider({ url, name: room, document: docB, WebSocketPolyfill: WS });

    // Production trackedOrigins from collab.js:1152-1156.
    const undo = new Y.UndoManager([docA.getArray('order'), docA.getMap('store')], {
      trackedOrigins: new Set(['local-publish', ySyncPluginKey]),
      captureTimeout: 500,
    });

    await waitFor(() => provA.synced && provB.synced);

    // ── Positive control: a tracked LOCAL write IS captured. ──────────────
    docA.transact(() => {
      docA.getArray('order').push(['a1']);
      docA.getMap('store').set('a1', new Y.Map());
    }, 'local-publish');
    expect(undo.undoStack.length).toBe(1); // manager is live + scope intersects
    const stackAfterControl = undo.undoStack.length;

    // ── Record the origin of the NEXT remote-applied transaction on A. ────
    let remoteOrigin = 'UNSEEN';
    const onTx = (tr) => {
      if (tr.origin !== 'local-publish' && tr.changedParentTypes.size > 0) remoteOrigin = tr.origin;
    };
    docA.on('afterTransaction', onTx); // registered BEFORE B writes

    // B's LOCAL edit (tracked on B) arrives on A as a REMOTE update.
    docB.transact(() => {
      docB.getArray('order').push(['b1']);
      docB.getMap('store').set('b1', new Y.Map());
    }, 'local-publish');

    await waitFor(() => docA.getArray('order').length === 2); // a1 + b1
    docA.off('afterTransaction', onTx);

    // ── Undo property: peer edit did NOT grow A's stack, AND the reason is
    //    that its origin is NOT in trackedOrigins (assert the cause, not just
    //    the effect — review M3). ───────────────────────────────────────────
    expect(undo.undoStack.length).toBe(stackAfterControl);
    expect(remoteOrigin).not.toBe('UNSEEN'); // we actually observed a remote tx
    const trackedOrigins = new Set(['local-publish', ySyncPluginKey]);
    expect(trackedOrigins.has(remoteOrigin)).toBe(false); // <-- WHY the stack didn't grow

    // ── Re-emit property (separate concern): not null, not a 'local-' string,
    //    so handleAfterTx does NOT early-return and React still gets the block.
    //    (An object origin — provider instance — is fine here; the undo
    //    property above is the real guarantee.) ─────────────────────────────
    expect(remoteOrigin).not.toBe(null);
    expect(typeof remoteOrigin === 'string' && remoteOrigin.startsWith('local-')).toBe(false);

    provA.destroy(); provB.destroy(); docA.destroy(); docB.destroy();
  });
});
```

- [ ] **Step 2: Run it — this is the gate**

Run: `npm test -- src/lib/__tests__/hocuspocus-undo-origin.test.js`
Expected (PASS): positive control captured 1 frame; peer edit added 0; remote origin is non-null and non-`local-`. **GATE A1 GREEN.**

> **RESULT (2026-06-21, this branch): GATE A1 GREEN.** Confirmed: the observed remote origin is the **`HocuspocusProvider` instance itself** (an object, `constructor.name === 'HocuspocusProvider'`) — exactly the prediction at the §309 note. It is not in `trackedOrigins`, not `null`, and not a `'local-'` string, so peer edits stay off the undo stack and the `handleAfterTx` re-emit path still fires. The verbatim test passed once the Task 1.3 skeleton's missing message-pump was added (commit `ccb4712`). No `trackedOrigins` rework, no UndoManager allowlist change, no `@vitest-environment` directive, and no yjs alias were needed — the client (ESM yjs) and server (CJS yjs) sync over the wire, so the dual-load warning is benign for this test.
If the positive control FAILS (`length !== 1`): the test harness is wrong (scope/manager), fix that before reading the peer-edit result — a green peer-edit assertion under a dead manager is meaningless.
If the peer-edit assertion FAILS (stack grew, or origin is `null`/`local-`): HocuspocusProvider applies remote updates with an origin that IS tracked (or `null`, which the default manager captures). **STOP.** Record the actual `remoteOrigin` value and revisit spec §7: the `trackedOrigins` set and/or `handleAfterTx`'s `origin.startsWith('local-')` echo filter must be reworked (e.g. switch the UndoManager to an allowlist anchored on the provider instance, and update `handleAfterTx` to treat the provider-instance origin as remote) before any client work proceeds.

- [ ] **Step 4: Commit**

```bash
git add src/lib/__tests__/hocuspocus-undo-origin.test.js
git commit -m "test(collab): GATE A1 — HocuspocusProvider remote origin off undo stack (#128)"
```

---

## Phase 3 — Tenant isolation: validate-AND-reject-non-canonical `onAuthenticate` (security keystone)

Spec §3. Pure string + ACL logic, fully unit-testable in isolation.

### Task 3.1: Extract the onAuthenticate builder into its own module (TDD)

**Files:**
- Create: `server/hocuspocus-auth.cjs`
- Create: `server/__tests__/hocuspocus-auth.test.mjs`

- [ ] **Step 1: Write the failing unit test for the canonical-name + checkPrincipal + authorize logic**

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { buildOnAuthenticate, AuthReject } = require('../hocuspocus-auth.cjs');

// Auth provider that requires auth and trusts a fake token map.
function makeAuthProvider(validUsers) {
  return {
    requiresAuth: true,
    validateToken: async (tok) => validUsers[tok] || null,
  };
}
// Storage stub with an ACL map keyed `<tenant>/<roomId>`.
function makeStorage(acls) {
  return { readAcl: async (tenant, roomId) => acls[`${tenant}/${roomId}`] || null };
}

const userA = { id: 'sub-a', tenant: 'tenantA' };

test('rejects a non-canonical documentName with a slash in the room half', async () => {
  const onAuth = buildOnAuthenticate({
    authProvider: makeAuthProvider({ tokA: userA }),
    storage: makeStorage({ 'tenantA/room_1': { ownerId: 'sub-a', sharedWith: [] } }),
  });
  await assert.rejects(
    () => onAuth({ documentName: 'tenantA/room/1', token: 'tokA' }),
    (e) => e instanceof AuthReject && e.status === 404
  );
});

test('rejects a documentName whose room half is not already sanitize-stable', async () => {
  const onAuth = buildOnAuthenticate({
    authProvider: makeAuthProvider({ tokA: userA }),
    storage: makeStorage({}),
  });
  await assert.rejects(() => onAuth({ documentName: 'tenantA/room.1', token: 'tokA' }),
    (e) => e instanceof AuthReject && e.status === 404);
});

test('rejects a cross-tenant documentName (tenant-A token naming victimTenant)', async () => {
  const onAuth = buildOnAuthenticate({
    authProvider: makeAuthProvider({ tokA: userA }),
    storage: makeStorage({ 'victimTenant/room': { ownerId: 'someone', sharedWith: [] } }),
  });
  await assert.rejects(() => onAuth({ documentName: 'victimTenant/room', token: 'tokA' }),
    (e) => e instanceof AuthReject && e.status === 404);
});

test('rejects a no-slash documentName explicitly (no lenient _public fallback)', async () => {
  const onAuth = buildOnAuthenticate({
    authProvider: makeAuthProvider({ tokA: userA }),
    storage: makeStorage({}),
  });
  await assert.rejects(() => onAuth({ documentName: 'justaroom', token: 'tokA' }),
    (e) => e instanceof AuthReject && e.status === 404);
});

test('rejects missing tenant / subject / reserved sentinel via checkPrincipal (403)', async () => {
  const onAuth = buildOnAuthenticate({
    authProvider: makeAuthProvider({ noTenant: { id: 's' }, pub: { id: 's', tenant: '_public' } }),
    storage: makeStorage({}),
  });
  await assert.rejects(() => onAuth({ documentName: 'x/y', token: 'noTenant' }),
    (e) => e instanceof AuthReject && e.status === 403);
  await assert.rejects(() => onAuth({ documentName: '_public/y', token: 'pub' }),
    (e) => e instanceof AuthReject && e.status === 403);
});

test('accepts a canonical owner connection and returns the user context', async () => {
  const onAuth = buildOnAuthenticate({
    authProvider: makeAuthProvider({ tokA: userA }),
    storage: makeStorage({ 'tenantA/room1': { ownerId: 'sub-a', sharedWith: [] } }),
  });
  const ctx = await onAuth({ documentName: 'tenantA/room1', token: 'tokA' });
  assert.equal(ctx.user.id, 'sub-a');
});

test('rejects a canonical room the caller cannot read (not owner/sharee) with 404', async () => {
  const onAuth = buildOnAuthenticate({
    authProvider: makeAuthProvider({ tokA: userA }),
    storage: makeStorage({ 'tenantA/room1': { ownerId: 'other', sharedWith: [] } }),
  });
  await assert.rejects(() => onAuth({ documentName: 'tenantA/room1', token: 'tokA' }),
    (e) => e instanceof AuthReject && e.status === 404);
});

test('auth=none: canonical _public name accepted; non-canonical STILL rejected', async () => {
  const onAuth = buildOnAuthenticate({
    authProvider: { requiresAuth: false, validateToken: async () => null },
    storage: makeStorage({}),
  });
  // Canonical _public room → accepted, consistent context shape.
  const ctx = await onAuth({ documentName: '_public/anything', token: null });
  assert.equal(ctx.tenant, '_public');
  assert.equal(ctx.roomId, 'anything');
  assert.equal(ctx.acl, null); // no ACL gate under auth=none
  // The canonical gate runs in BOTH modes (review S4): a no-slash name, a
  // non-_public tenant half, and a non-sanitize-stable room all reject.
  await assert.rejects(() => onAuth({ documentName: 'justaroom', token: null }),
    (e) => e instanceof AuthReject && e.status === 404);
  await assert.rejects(() => onAuth({ documentName: 'tenantX/room', token: null }),
    (e) => e instanceof AuthReject && e.status === 404); // tenant must be _public
  await assert.rejects(() => onAuth({ documentName: '_public/room.1', token: null }),
    (e) => e instanceof AuthReject && e.status === 404); // non-canonical room
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test server/__tests__/hocuspocus-auth.test.mjs`
Expected: FAIL — `Cannot find module '../hocuspocus-auth.cjs'`.

- [ ] **Step 3: Implement `server/hocuspocus-auth.cjs`**

```js
/**
 * Hocuspocus onAuthenticate builder — the validate-AND-reject-non-canonical
 * tenant keying chokepoint (#128, spec §3). Because documentName is
 * client-supplied AND Hocuspocus keys its in-memory documents Map on the raw
 * client name, isolation cannot rewrite the name: it must REJECT any raw name
 * not already in canonical `<tenant>/<roomId>` form, so the Map key, the
 * SecWriterDatabase fetch/store key, the ACL-read key, and the broker key are
 * provably the same string.
 *
 * Throws AuthReject (carrying an HTTP-ish status for logging) to reject; the
 * client always sees the SAME opaque close (no tenant-mismatch vs
 * can't-see-room distinction) — preserving the 404-not-403 no-existence-leak
 * posture. Bad-principal stays 403; no-token stays 401.
 *
 * CJS on purpose (ADR-0001).
 */
'use strict';

const { sanitize, PUBLIC_TENANT } = require('./storage-shared.cjs');
const { checkPrincipal, aclAllowsRead } = require('./auth/authorize.cjs');

class AuthReject extends Error {
  constructor(status, reason) {
    super(`auth-reject:${status}`);
    this.name = 'AuthReject';
    this.status = status;
    this.reason = reason; // internal only — never surfaced to the client
  }
}

function buildOnAuthenticate({ authProvider, storage }) {
  const authRequired = !!(authProvider && authProvider.requiresAuth);

  // The canonical-name parse + sanitize check is PURE STRING LOGIC and runs in
  // BOTH modes. Under auth=none it still matters: the demo/prod config keys the
  // Hocuspocus documents Map, the storage key, and the ACL key on the raw
  // client `name`, so a non-canonical name (`foo`, `_public/room.1`) would
  // split-brain a room exactly as under auth. Only the token/principal/ACL
  // steps are auth-mode-specific. (Review S4.)
  function parseCanonical(documentName, tenant) {
    const raw = String(documentName);
    const i = raw.indexOf('/');
    if (i <= 0 || i === raw.length - 1) throw new AuthReject(404, 'malformed-name');
    const rawTenant = raw.slice(0, i);
    const rawRoom = raw.slice(i + 1);
    if (!rawTenant || !rawRoom) throw new AuthReject(404, 'malformed-name');
    // Anti-split-brain: the raw name must ALREADY equal `${tenant}/${sanitize(rawRoom)}`.
    // `tenantA/room/1` (rawRoom has an inner slash → sanitize replaces it) and
    // `tenantA/room.1` (rawRoom !== sanitize(rawRoom)) both fail here.
    if (rawTenant !== tenant) throw new AuthReject(404, 'cross-tenant');
    if (rawRoom !== sanitize(rawRoom)) throw new AuthReject(404, 'non-canonical-room');
    return rawRoom;
  }

  return async function onAuthenticate({ documentName, token }) {
    // ── auth=none demo: every room is _public; NO token/principal/ACL, but
    //    the canonical gate STILL runs (tenant pinned to _public). ──────────
    if (!authRequired) {
      const roomId = parseCanonical(documentName, PUBLIC_TENANT);
      return { user: { id: PUBLIC_TENANT, tenant: PUBLIC_TENANT }, tenant: PUBLIC_TENANT, roomId, acl: null };
    }

    if (!token) throw new AuthReject(401, 'no-token');
    const user = await authProvider.validateToken(token);
    if (!user) throw new AuthReject(401, 'bad-token');

    // 1. Principal checks (missing tenant/subject, reserved _public/archive).
    const pre = checkPrincipal(authProvider, user);
    if (!pre.ok) throw new AuthReject(pre.status, 'principal');

    // 2. Tenant from the VALIDATED token only; 3-4. canonical gate.
    const tenant = sanitize(user.tenant);
    const roomId = parseCanonical(documentName, tenant);

    // 5. Authorize READ off the cheap .acl.json sidecar.
    const acl = await storage.readAcl(tenant, roomId);
    if (!acl) throw new AuthReject(404, 'no-acl');
    if (!aclAllowsRead(acl, user.id)) throw new AuthReject(404, 'not-shared');

    // Context threaded to onLoadDocument / store. SAME shape in both modes:
    // { user, tenant, roomId, acl }. readOnly stays false for #128 (all
    // authorized connections are read-write); #239 sets connectionConfig.readOnly
    // true for the viewer role.
    return { user, tenant, roomId, acl };
  };
}

module.exports = { buildOnAuthenticate, AuthReject };
```

> Note on step 4: a `rawRoom` containing a `/` (e.g. `tenantA/room/1` → rawTenant=`tenantA`, rawRoom=`room/1`) is caught by `rawRoom !== sanitize(rawRoom)` because `sanitize` replaces the inner `/` with `_`. Verify this in the test from step 1 (the `room/1` case asserts 404).

- [ ] **Step 4: Run the test — verify PASS**

Run: `node --test server/__tests__/hocuspocus-auth.test.mjs`
Expected: all PASS.

- [ ] **Step 5: Add the new test file to the `test:server` script**

In `package.json`, append `server/__tests__/hocuspocus-auth.test.mjs` to the `test:server` command's file list.

- [ ] **Step 6: Commit**

```bash
git add server/hocuspocus-auth.cjs server/__tests__/hocuspocus-auth.test.mjs package.json
git commit -m "feat(server): validate-AND-reject-non-canonical onAuthenticate (#128)"
```

### Task 3.2: Wire `onAuthenticate` into the Hocuspocus instance + map AuthReject to an opaque close

**Files:**
- Modify: `server/collab-server.cjs`

- [ ] **Step 1: Replace the Phase-1 no-op onAuthenticate with the real builder**

In `buildHocuspocus()`, require and use the builder:

```js
const { buildOnAuthenticate, AuthReject } = require('./hocuspocus-auth.cjs');
// …
const onAuthenticate = buildOnAuthenticate({ authProvider, storage });
const hocuspocus = new Hocuspocus({
  async onAuthenticate(data) {
    try {
      return await onAuthenticate(data);
    } catch (err) {
      if (err instanceof AuthReject) {
        log.warn('ws.auth-reject', { status: err.status, reason: err.reason });
        // Throw a plain Error so Hocuspocus closes the connection with the
        // SAME opaque close for every rejection (no tenant-mismatch vs
        // can't-see-room signal). Confirm against type defs that throwing in
        // onAuthenticate closes BEFORE onLoadDocument AND before fetch.
        throw new Error('Unauthorized');
      }
      // Storage I/O fault in readAcl: fail CLOSED.
      log.error('ws.authorize-failed', { err: err && err.message });
      throw new Error('Unauthorized');
    }
  },
  // onLoadDocument + extensions filled in Phase 4/6.
});
```

- [ ] **Step 2: Confirm fetch-is-gated (spec §3 step 5 caveat) — instrument and assert in the security test (Phase 3.3)**

No code here; the gate is pinned by the test in Task 3.3 step 2.

- [ ] **Step 3: Commit**

```bash
git add server/collab-server.cjs
git commit -m "feat(server): wire onAuthenticate with opaque-close parity (#128)"
```

### Task 3.3: Server-level security tests driven through the provider `name`

**Files:**
- Create: `server/__tests__/hocuspocus-server.test.mjs` (NEW file — see File structure; do NOT add these to `collab-server.test.mjs`)

This file's header must import `ws` and pass it as `WebSocketPolyfill` to every provider (Node rule). Boot helper + `waitFor` shared across tests.

- [ ] **Step 1: Cross-tenant + non-canonical rejection (matrix via `it.each`, driven by provider `name`)**

Use `it.each` so the four malicious names are ONE test entry against the 30-cap. Construct the malicious `name` directly (the client's room sanitizer strips `/`, so building via the provider `name` option is the only way to exercise the server gate — testing the URL would test a path Hocuspocus ignores):

```js
import WS from 'ws';
// … boot helper that returns { srv, url } …

it('rejects cross-tenant + non-canonical names via provider name, before load (zero fetch)', async () => {
  let fetchCalls = 0;
  const storage = {
    readRoom: async () => { fetchCalls++; return null; },
    writeRoom: async () => {},
    readAcl: async () => ({ ownerId: 'sub-a', sharedWith: [] }),
  };
  const srv = createCollabServer({
    storage, useHocuspocus: true,
    authProvider: { requiresAuth: true, validateToken: async (t) => t === 'tokA' ? { id: 'sub-a', tenant: 'tenantA' } : null },
  });
  await new Promise(r => srv.httpServer.listen(0, '127.0.0.1', r));
  const url = `ws://127.0.0.1:${srv.httpServer.address().port}`;
  for (const name of ['victimTenant/room', 'tenantA/room/1', 'tenantA/room.1', 'justaroom']) {
    const doc = new Y.Doc();
    let failed = false;
    const prov = new HocuspocusProvider({ url, name, document: doc, token: 'tokA', WebSocketPolyfill: WS, onAuthenticationFailed: () => { failed = true; } });
    await waitFor(() => failed, 4000).catch(() => {});
    expect(failed).toBe(true);
    prov.destroy(); doc.destroy();
  }
  // §3 step 5: a rejected onAuthenticate yields ZERO storage reads. readRoom IS
  // the path SecWriterDatabase.fetch calls, so counting it here proves the load
  // path is gated, not just the canonical parse. (Review S6.)
  expect(fetchCalls).toBe(0);
  srv.cleanup?.(); srv.httpServer.close();
});
```

- [ ] **Step 2: Revocation parity — re-auth on every FRESH connect (per-connect only)**

One `it()`: an authorized owner connects (synced), the ACL is mutated to remove them, a FRESH reconnect (new provider) is rejected. This pins spec §3 revocation parity at its true strength: **per-connect only.** Hocuspocus has no periodic re-authentication — issue [#752](https://github.com/ueberdosis/hocuspocus/issues/752) confirms an already-connected user keeps editing until the socket actually drops. So this test asserts fresh-reconnect rejection, NOT that an open session is severed on revocation (it isn't). ADR-0018 must state the revocation latency = "until the socket drops" honestly; do not let the test imply more. (Also note [#566](https://github.com/ueberdosis/hocuspocus/issues/566): after a server-initiated close the provider may not re-send the token — Phase 8.2 covers that path so revocation actually takes effect on the next reconnect rather than silently reusing a stale auth.)

- [ ] **Step 3: readOnly write-frame-dropped (#239-readiness — FIRM, not "if headroom")**

This is a spec §3 MUST and the entire reason #128 precedes #239 — it does not get demoted. One `it()`: boot with an `onAuthenticate` that returns a context flagging the connection read-only (set `connectionConfig.readOnly = true`, or return `{ …, readOnly: true }` — confirm the exact write-gating field against the type defs; `connectionConfig.readOnly` is the recorded candidate). Connect a provider, attempt a local `doc.transact(..., 'local-publish')`, and assert the server does NOT broadcast/persist that frame (a second observer provider never sees it; `writeRoom` is not called for it). If the field name turns out wrong, this test is where it surfaces BEFORE #239 depends on it.

```js
it('a read-only connection cannot write: its frame is dropped server-side', async () => {
  // onAuthenticate marks every connection read-only for this test.
  // … boot srv with authProvider returning readOnly context …
  // writer (read-only) + observer (read-only is fine; just watching)
  // writer.transact(() => writer.getArray('order').push(['x']), 'local-publish');
  // await a short settle; assert observer.getArray('order').length === 0
  //   AND the storage writeRoom spy was not called with that block.
});
```

> If the recorded `connectionConfig.readOnly` does not gate writes as expected, STOP and read `Connection`/`ClientConnection` in the type defs — do not hand-roll a write filter; the whole point of the migration is that Hocuspocus owns this. Record the working field in ADR-0018.
>
> **RESOLVED (2026-06-21, verified against @hocuspocus/server@4.3.0 source + index.d.ts; test passing, commit `50efcb7`):** the working lever is to **MUTATE `data.connectionConfig.readOnly = true` inside `onAuthenticate`** — NOT to return `{ readOnly: true }`. The hook's return value merges only into `context` (hocuspocus-server.cjs ~843-847), which is a different object from `connectionConfig`; the write-gate reads `connection.readOnly`, constructed from `connectionConfig.readOnly` (lines 851, 971). With `readOnly` true the server drops incoming `messageYjsUpdate`/syncStep2 frames and replies `writeSyncStatus(false)` (lines 297, 316) — confirmed end-to-end: a read-only writer's push never reaches an observer (observer array length 0). `onAuthenticatePayload` has NO `connection` field (only `connectionConfig`); the `connection` field exists only on `connectedPayload`. ADR-0018 must record `data.connectionConfig.readOnly = true` (mutation) as the #239 viewer lever.

- [ ] **Step 4: Add the new file to `test:server`, run, commit**

In `package.json`, append `server/__tests__/hocuspocus-server.test.mjs` to the `test:server` file list.
Run: `node --test server/__tests__/hocuspocus-server.test.mjs` → PASS. **Confirms onAuthenticate rejects before fetch AND read-only write-gating works (the §3 step-5 gap + #239 lever).**
```bash
git add server/__tests__/hocuspocus-server.test.mjs package.json
git commit -m "test(server): WS rejection + fetch-gating + readOnly write-drop (#128)"
```

---

## Phase 4 — Persistence: `SecWriterDatabase extends Database`

Spec §2. Wraps the unchanged `RoomStorageBase` adapters; runs the FULL `serializeRoom`.

### Task 4.1: Implement SecWriterDatabase (TDD)

**Files:**
- Create: `server/secwriter-database.cjs`
- Create: `server/__tests__/secwriter-database.test.mjs`

- [ ] **Step 1: Write the failing round-trip test (all four artifacts regenerate; 8 MB refusal; roomHealth)**

```js
const { test } = require('node:test');
const assert = require('node:assert');
const Y = require('yjs');
require('../dom-polyfill.cjs');
const { SecWriterDatabase } = require('../secwriter-database.cjs');
const { seedRoomFromBlocks } = require('../room-serializer.cjs');

function makeStorage() {
  const rooms = new Map();
  return {
    written: [],
    readRoom: async (t, r) => rooms.get(`${t}/${r}`) || null,
    writeRoom: async (t, r, artifacts) => {
      rooms.set(`${t}/${r}`, { ydocBytes: artifacts.ydocBytes });
      // record which artifact kinds were produced
      return artifacts;
    },
  };
}

test('store runs full serializeRoom (all four artifacts) and writeRoom', async () => {
  const storage = makeStorage();
  const captured = [];
  storage.writeRoom = async (t, r, a) => { captured.push({ t, r, a }); };
  const roomHealth = new Map();
  const db = new SecWriterDatabase({ storage, roomHealth, maxDocBytes: 8 * 1024 * 1024, log: { warn() {}, error() {} } });

  const ydoc = new Y.Doc();
  seedRoomFromBlocks(ydoc, [{ id: 'b1', type: 'txt', part: 1, depth: 0, html: 'Hello' }]);

  await db.store({ documentName: 'tenantA/room1', document: ydoc, state: Y.encodeStateAsUpdate(ydoc) });

  assert.equal(captured.length, 1);
  assert.equal(captured[0].t, 'tenantA');
  assert.equal(captured[0].r, 'room1');
  const a = captured[0].a;
  assert.ok(a.ydocBytes instanceof Uint8Array);
  assert.ok(a.secBytes instanceof Uint8Array);    // .SEC regenerated, NOT bare encodeStateAsUpdate
  assert.equal(typeof a.commentsJson, 'string');
});

test('store carries sidecar CONTENT (comment + block text), not just presence', async () => {
  // Presence-only assertions (above) can pass while serializeRoom silently
  // drops sidecar data. Seed a comment + a block with distinctive text and
  // assert the produced artifacts actually contain them. (Review S8.)
  //
  // CORRECTED (2026-06-21, commit 5cc4c99) — the original seed over-reached and
  // could never pass against the real contract:
  //  1. readComments (src/lib/collab.js) SKIPS any comment value without a
  //     `.get` method, so the comment MUST be a real Y.Map, not a plain object.
  //  2. seedRoomFromBlocks stores html in a LEGACY Y.Text slot (the broker
  //     converts it to a v2 Y.XmlFragment only on a later WS upgrade), so
  //     serializeRoom alone HTML-ESCAPES inline markup — it does NOT convert
  //     `<ins class="mark-add">` to `<ADD>`. Mark→SGML conversion is the
  //     room-serializer + substrate's job (its own tests cover it), NOT
  //     SecWriterDatabase's. Pin real block TEXT reaching the .SEC instead.
  const storage = makeStorage();
  let captured;
  storage.writeRoom = async (t, r, a) => { captured = a; };
  const db = new SecWriterDatabase({ storage, roomHealth: new Map(), maxDocBytes: 8 * 1024 * 1024, log: { warn() {}, error() {} } });
  const ydoc = new Y.Doc();
  seedRoomFromBlocks(ydoc, [{ id: 'b1', type: 'txt', part: 1, depth: 0, html: 'UNIQUEMARKER content' }]);
  const cMap = new Y.Map();
  cMap.set('blockId', 'b1'); cMap.set('status', 'open'); cMap.set('authorName', 'tester');
  ydoc.getMap('comments').set('c1', cMap); // MUST be a Y.Map — readComments skips plain objects
  await db.store({ documentName: 'tenantA/room1', document: ydoc });
  assert.ok(captured.commentsJson.includes('c1'), 'comment id must reach the comments sidecar');
  const sec = Buffer.from(captured.secBytes).toString('latin1');
  assert.ok(sec.includes('UNIQUEMARKER'), 'block text must serialize into the .SEC');
});

test('fetch splits the canonical documentName and returns ydoc bytes (or null)', async () => {
  const storage = makeStorage();
  storage.readRoom = async (t, r) => (t === 'tenantA' && r === 'room1') ? { ydocBytes: new Uint8Array([1, 2, 3]) } : null;
  const db = new SecWriterDatabase({ storage, roomHealth: new Map(), maxDocBytes: 8 * 1024 * 1024, log: { warn() {}, error() {} } });
  const bytes = await db.fetch({ documentName: 'tenantA/room1' });
  assert.deepEqual([...bytes], [1, 2, 3]);
  const none = await db.fetch({ documentName: 'tenantA/missing' });
  assert.equal(none, null);
});

test('store refuses an over-8MB doc and does NOT call writeRoom', async () => {
  const storage = makeStorage();
  let wrote = false;
  storage.writeRoom = async () => { wrote = true; };
  const roomHealth = new Map();
  const db = new SecWriterDatabase({ storage, roomHealth, maxDocBytes: 8, log: { warn() {}, error() {} } }); // tiny cap
  const ydoc = new Y.Doc();
  seedRoomFromBlocks(ydoc, [{ id: 'b1', type: 'txt', part: 1, depth: 0, html: 'Hello world this exceeds eight bytes' }]);
  await db.store({ documentName: 'tenantA/big', document: ydoc, state: Y.encodeStateAsUpdate(ydoc) });
  assert.equal(wrote, false);
});

test('store increments roomHealth.persistFailures on writeRoom error', async () => {
  const storage = makeStorage();
  storage.writeRoom = async () => { throw new Error('S3 down'); };
  const roomHealth = new Map();
  const db = new SecWriterDatabase({ storage, roomHealth, maxDocBytes: 8 * 1024 * 1024, log: { warn() {}, error() {} } });
  const ydoc = new Y.Doc();
  seedRoomFromBlocks(ydoc, [{ id: 'b1', type: 'txt', part: 1, depth: 0, html: 'x' }]);
  await db.store({ documentName: 'tenantA/room1', document: ydoc, state: Y.encodeStateAsUpdate(ydoc) });
  assert.equal(roomHealth.get('tenantA/room1').persistFailures, 1);
});

test('store is re-entrancy-safe per key: overlapping stores serialize, last write is the latest doc', async () => {
  const storage = makeStorage();
  const order = [];
  storage.writeRoom = async (t, r, a) => {
    order.push('start');
    await new Promise(res => setTimeout(res, 30));
    order.push('end');
  };
  const db = new SecWriterDatabase({ storage, roomHealth: new Map(), maxDocBytes: 8 * 1024 * 1024, log: { warn() {}, error() {} } });
  const ydoc = new Y.Doc();
  seedRoomFromBlocks(ydoc, [{ id: 'b1', type: 'txt', part: 1, depth: 0, html: 'x' }]);
  const p1 = db.store({ documentName: 'tenantA/room1', document: ydoc, state: Y.encodeStateAsUpdate(ydoc) });
  const p2 = db.store({ documentName: 'tenantA/room1', document: ydoc, state: Y.encodeStateAsUpdate(ydoc) });
  await Promise.all([p1, p2]);
  // Serialized: no interleave (start,end,start,end — never start,start).
  assert.deepEqual(order, ['start', 'end', 'start', 'end']);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test server/__tests__/secwriter-database.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `server/secwriter-database.cjs`**

The `Database` base-class shape is CONFIRMED (Task 1.2): `constructor(Partial<{ fetch: (data) => Promise<Uint8Array|null>, store: (data) => Promise<void> }>)`. The subclass below passes bound methods to `super({ fetch, store })` — the base stores the callbacks and wires the `onLoadDocument`/`onStoreDocument` hooks to call them. This is the verified pattern, not a guess.

```js
/**
 * SecWriterDatabase — Hocuspocus persistence extension (#128, spec §2).
 *
 * Wraps the existing RoomStorageBase adapters UNCHANGED. store() runs the FULL
 * room-serializer.serializeRoom (NOT a bare encodeStateAsUpdate), so the
 * .SEC/.comments/.lint sidecars keep regenerating. Write order (.ydoc last) is
 * owned by ARTIFACT_CATALOG/planArtifactWrites in the storage layer.
 *
 * Carries over from the old flushRoom: the 8 MB MAX_DOC_BYTES pre-serialize
 * refusal, roomHealth.persistFailures tracking, the deferred ESM serializer
 * import (first store pays the latency), and per-key store re-entrancy safety
 * (§2/§8 — no two overlapping stores race the same .ydoc into S3/Azure).
 *
 * CJS on purpose (ADR-0001).
 */
'use strict';

const Y = require('yjs');
const { Database } = require('@hocuspocus/extension-database');
const { splitCompositeDocName } = require('./storage-shared.cjs');

class SecWriterDatabase extends Database {
  constructor({ storage, roomHealth, maxDocBytes, log }) {
    // CONFIRMED (Task 1.2): Database takes { fetch, store } callbacks. Pass
    // bound methods so the hook wiring in the base calls our impls.
    super({
      fetch: (data) => this.fetch(data),
      store: (data) => this.store(data),
    });
    this.storage = storage;
    this.roomHealth = roomHealth;
    this.maxDocBytes = maxDocBytes;
    this.log = log;
    this._serializeRoom = null;
    // Per-key promise chain for store re-entrancy (§2/§8).
    this._storeChains = new Map();
  }

  _getHealth(docName) {
    let h = this.roomHealth.get(docName);
    if (!h) { h = { persistFailures: 0, lastPersistSuccess: null }; this.roomHealth.set(docName, h); }
    return h;
  }

  async _getSerializeRoom() {
    if (!this._serializeRoom) {
      // Deferred ESM-bridging require (heavy ESM modules load on first store).
      this._serializeRoom = require('./room-serializer.cjs').serializeRoom;
    }
    return this._serializeRoom;
  }

  async fetch({ documentName }) {
    const { tenant, roomId } = splitCompositeDocName(documentName);
    const roomData = await this.storage.readRoom(tenant, roomId);
    if (!roomData || !roomData.ydocBytes) return null; // new room
    return roomData.ydocBytes instanceof Uint8Array
      ? roomData.ydocBytes
      : new Uint8Array(roomData.ydocBytes);
  }

  async store({ documentName, document }) {
    // Serialize stores for the same key so two overlapping flushes can't race
    // a stale .ydoc into S3/Azure (no transaction primitive there).
    const prev = this._storeChains.get(documentName) || Promise.resolve();
    const next = prev.then(() => this._doStore(documentName, document)).catch(() => {});
    this._storeChains.set(documentName, next);
    await next;
    if (this._storeChains.get(documentName) === next) this._storeChains.delete(documentName);
  }

  async _doStore(documentName, document) {
    const health = this._getHealth(documentName);
    try {
      // 8 MB pre-serialize refusal (carried from flushRoom).
      const snapshot = Y.encodeStateAsUpdate(document);
      if (snapshot.byteLength > this.maxDocBytes) {
        this.log.warn('flush.refused', { roomId: documentName, bytes: snapshot.byteLength, cap: this.maxDocBytes });
        return;
      }
      const serializeRoom = await this._getSerializeRoom();
      const artifacts = await serializeRoom(document); // full .SEC/.comments/.lint
      const { tenant, roomId } = splitCompositeDocName(documentName);
      await this.storage.writeRoom(tenant, roomId, artifacts);
      health.persistFailures = 0;
      health.lastPersistSuccess = Date.now();
    } catch (err) {
      health.persistFailures = (health.persistFailures || 0) + 1;
      this.log.warn('persist.failed', { roomId: documentName, failures: health.persistFailures, err: err.message });
      if (health.persistFailures >= 3) this.log.error('persist.alert', { roomId: documentName, failures: health.persistFailures });
    }
  }

  /**
   * Await all in-flight per-key store chains. The shutdown path (Phase 5)
   * calls hocuspocus.flushPendingStores() (which kicks off the debounced
   * onStoreDocument → our store() for every dirty room) then awaits this, since
   * the bare Hocuspocus class has no awaitable destroy(). flushPendingStores()
   * returns void, so this is how we know every store actually completed.
   */
  async drain() {
    // Snapshot then await; a store() may chain a new promise as we drain, so
    // loop until the map is quiescent (bounded — stores don't self-trigger).
    for (let i = 0; i < 5 && this._storeChains.size > 0; i++) {
      await Promise.allSettled([...this._storeChains.values()]);
    }
  }
}

module.exports = { SecWriterDatabase };
```

- [ ] **Step 4: Run — verify PASS**

Run: `node --test server/__tests__/secwriter-database.test.mjs`
Expected: all PASS.

- [ ] **Step 5: Add the test to `test:server` and commit**

```bash
git add server/secwriter-database.cjs server/__tests__/secwriter-database.test.mjs package.json
git commit -m "feat(server): SecWriterDatabase persistence extension (full serializeRoom) (#128)"
```

### Task 4.2: Wire SecWriterDatabase + debounce/maxDebounce + gc into the instance

**Files:**
- Modify: `server/collab-server.cjs`

- [ ] **Step 1: Construct the extension and pass it + debounce options**

In `buildHocuspocus()`:

```js
const { SecWriterDatabase } = require('./secwriter-database.cjs');
const database = new SecWriterDatabase({ storage, roomHealth, maxDocBytes: MAX_DOC_BYTES, log });
const hocuspocus = new Hocuspocus({
  name: 'secwriter',
  quiet: true,
  extensions: [database],
  // Flush cadence is a DIFFERENT mechanism (§2): debounce replaces the
  // hand-rolled 500ms ydoc.on('update') timer; maxDebounce adds a starvation
  // ceiling the old timer lacked. (Confirmed option names, Task 1.2.)
  // CAUTION (review): the Hocuspocus DEFAULT debounce is 2000ms, NOT 500. We
  // set 500 to match the old timer, but store() runs the FULL serializeRoom
  // over every block + an S3/Azure write — at 500ms that can fire up to twice
  // a second per active room. Measure serialize+write cost in Phase 5.2 Step 3
  // and RAISE this if a realistic room saturates I/O; do not keep 500 by inertia.
  debounce: DEBOUNCE_MS,         // 500 — re-evaluate against the Phase 5.2 measurement
  maxDebounce: 10000,            // starvation ceiling — tune per §8 measurement
  // gc IS settable (Task 1.2: yDocOptions.gc). Pin true to match the v2
  // substrate's production gc and the cross-stack rollback gate (Phase 9).
  yDocOptions: { gc: true },
  // SEED DURABILITY (Phase 7 / option A companion): keep a room's doc warm
  // briefly after the last client disconnects, instead of unloading it
  // immediately. This does two things for the client seed: (1) a provider
  // remount (React StrictMode, tab background→foreground, network blip)
  // re-syncs the seeded content from MEMORY rather than reloading an empty
  // doc from storage before the seed's store flushed — so it never observes
  // false-empty and never re-seeds; (2) it guarantees the seed's debounced
  // store (500ms above) completes well before unload. Pairs with the
  // client-side per-room seed guard (Task 7.1) as belt-and-suspenders.
  unloadImmediately: false,      // confirm the unload-timeout field name in the type defs
  async onAuthenticate(data) { /* from Task 3.2 */ },
});
// Return `database` from buildHocuspocus() alongside { hocuspocus, hwss } —
// Phase 5's shutdown drain awaits its store-chain promises (the bare Hocuspocus
// class has no destroy()).
```

- [ ] **Step 2: Keep the roomHealth Map shared (HTTP `/health` reads it)**

`roomHealth` is already created in `createCollabServer`. Pass the same Map into both `SecWriterDatabase` and `createHttpHandler` so `/health` reporting is unchanged.

- [ ] **Step 3: Commit**

```bash
git add server/collab-server.cjs
git commit -m "feat(server): wire SecWriterDatabase + debounce/maxDebounce (#128)"
```

### Task 4.3: store → load gc round-trip test (Y.XmlFragment substrate survives)

**Files:**
- Modify: `server/__tests__/hocuspocus-server.test.mjs`

- [ ] **Step 1: Drive the broker to a REAL v2 substrate, then assert it survives store→load**

The review flagged the original version as vacuous: `seedRoomFromBlocks` seeds **Y.Text**, not the `Y.XmlFragment` v2 substrate that carries the gc hazard, so a Y.Text round-trip proves nothing about the thing we ship. This test MUST drive the v1→v2 broker first and assert the slot is actually a `Y.XmlFragment`, both before store and after reload:

```js
it('Y.XmlFragment substrate survives store -> fetch -> reload under gc', async () => {
  const Y = require('yjs');               // same CJS copy as the server modules
  require('../dom-polyfill.cjs');
  const { seedRoomFromBlocks } = require('../room-serializer.cjs');
  // M2 FIX: there is NO free `ensureMigrated` export. The broker entry is
  // `createMigrationCoordinator({ storage, log, migrateImpl }).ensureMigrated`
  // (migrate-pm-substrate.cjs). It AWAITS `storage.backupRoom` before mutating,
  // so the storage stub MUST implement backupRoom or migration silently SKIPS
  // (returns { skipped: true }) and the instanceof precondition below fails —
  // turning the gate falsely red.
  const { createMigrationCoordinator, migrateRoom } = require('../migrate-pm-substrate.cjs');
  const { getBlockHtml } = require('../../src/lib/...'); // pmFragmentToHtml-backed reader (confirm path; ESM — see dual-package rule)
  const coord = createMigrationCoordinator({
    storage: { backupRoom: async () => {}, /* + any reads the broker performs */ },
    log: { info() {}, warn() {}, error() {} },
    migrateImpl: migrateRoom,
  });

  // 1. Seed Y.Text, then DRIVE THE BROKER to convert to Y.XmlFragment.
  const doc = new Y.Doc({ gc: true });
  seedRoomFromBlocks(doc, [{ id: 'a', type: 'txt', part: 1, depth: 0, html: '<b>bold</b> text' }]);
  await coord.ensureMigrated('tenantA/room1', doc);
  const slot = doc.getMap('store').get('a').get('html');
  assert.ok(slot instanceof Y.XmlFragment, 'broker must produce Y.XmlFragment, not Y.Text');
  const htmlBefore = getBlockHtml(doc.getMap('store'), 'a'); // pmFragmentToHtml branch

  // 2. store via the database, fetch the bytes back into a FRESH gc doc.
  const captured = {};
  const db = new SecWriterDatabase({ storage: { writeRoom: async (t,r,a)=>{captured.bytes=a.ydocBytes;}, readRoom: async ()=>({ydocBytes:captured.bytes}) }, roomHealth: new Map(), maxDocBytes: 8*1024*1024, log:{warn(){},error(){}} });
  await db.store({ documentName: 'tenantA/room1', document: doc });
  const bytes = await db.fetch({ documentName: 'tenantA/room1' });
  const reloaded = new Y.Doc({ gc: true });
  Y.applyUpdate(reloaded, bytes);

  // 3. The reloaded slot is STILL a Y.XmlFragment and reads back identical HTML.
  const reSlot = reloaded.getMap('store').get('a').get('html');
  assert.ok(reSlot instanceof Y.XmlFragment, 'reloaded slot must remain Y.XmlFragment (gc must not collapse it)');
  assert.equal(getBlockHtml(reloaded.getMap('store'), 'a'), htmlBefore);
});
```

> Confirm the coordinator's exact constructor args (`createMigrationCoordinator({ storage, log, migrateImpl })`) and which `storage` reads the broker performs beyond `backupRoom`, against the current `migrate-pm-substrate.cjs` (Task 6.1 step 1 reads the broker). The `getBlockHtml`/`pmFragmentToHtml` reader lives in ESM (`src/lib/collab.js` / `pmdoc-html.js`); reaching it from this CJS-required `.mjs` test crosses the dual-package boundary — `require('../../src/lib/pmdoc-html.js')` may not resolve cleanly from CJS. If it does not, import `pmFragmentToHtml` via the dual-package `createRequire` pattern (How-to-read rule) or assert the slot shape directly instead of the rendered HTML. `Y.RelativePosition` selection state is client-only, never persisted — do NOT conflate it with this.

- [ ] **Step 2: Run + commit**

Run: `node --test server/__tests__/hocuspocus-server.test.mjs` → PASS.
```bash
git add server/__tests__/hocuspocus-server.test.mjs
git commit -m "test(server): Y.XmlFragment substrate survives store->load gc (#128)"
```

---

## Phase 5 — GATE: shutdown flushes ALL dirty rooms within Render's grace

Spec §8 / §Gating item 3. Measured, with a concrete threshold.

### Task 5.1: Wire SIGTERM/SIGINT → close + flushPendingStores + drain

**Files:**
- Modify: `server/collab-server.cjs` (the `startFromEnv` shutdown block, ~lines 631-642; expose `database` on the factory return)

- [ ] **Step 1: Expose `database` from the factory return**

`buildHocuspocus()` (Task 4.2) returns `{ hocuspocus, hwss, database }`. Set `hocuspocusDatabase = built.database` and add `database: hocuspocusDatabase` to `createCollabServer`'s returned object, so the shutdown path can drain it.

- [ ] **Step 2: Replace `destroy()` with the verified drain (the bare class has no destroy())**

In `startFromEnv`'s `shutdown(signal)`, when running the Hocuspocus instance:

```js
  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info('server.shutdown', { signal, docs: server.hocuspocus ? server.hocuspocus.getDocumentsCount() : 'n/a' });
    if (server.hocuspocus) {
      // The bare Hocuspocus class has NO destroy() (Task 1.2). Drain in 3 steps:
      //   1. closeConnections()   — stop accepting new edits.
      //   2. flushPendingStores() — kick the debounced onStoreDocument for every
      //      dirty room. Returns void; does NOT await.
      //   3. await database.drain() — await our own per-key store-chain promises
      //      (SecWriterDatabase._storeChains). This is how we KNOW every store
      //      completed, and it inherits the per-key re-entrancy guard so no two
      //      overlapping stores race the same .ydoc into S3/Azure (§2/§8).
      server.hocuspocus.closeConnections();
      server.hocuspocus.flushPendingStores();
      await server.database.drain();
    } else {
      await server.flushAllRooms();
    }
    try { server.httpServer.close(); } catch { /* ignore */ }
    setTimeout(() => process.exit(0), 50);
  }
```

- [ ] **Step 3: Commit**

```bash
git add server/collab-server.cjs
git commit -m "feat(server): SIGTERM -> close + flushPendingStores + drain on shutdown (#128)"
```

### Task 5.2: Flush-all-dirty-rooms test (≥3 rooms) + measured-within-grace assertion

**Files:**
- Modify: `server/__tests__/hocuspocus-server.test.mjs`

All providers pass `WebSocketPolyfill: WS`. Drain via the SAME sequence the shutdown path uses (`closeConnections()` + `flushPendingStores()` + `await srv.database.drain()`) — NOT a nonexistent `destroy()`.

- [ ] **Step 1: Write the failing test — seed ≥3 rooms, edit, do NOT wait for debounce, drain, assert EVERY edit persisted**

```js
it('shutdown drain flushes ALL dirty rooms, not just the first', async () => {
  const persisted = new Map();
  const storage = {
    readRoom: async () => null,
    writeRoom: async (t, r, a) => { persisted.set(`${t}/${r}`, a.ydocBytes); },
    readAcl: async () => ({ ownerId: '_public', sharedWith: [] }),
  };
  const srv = createCollabServer({ storage, useHocuspocus: true, authProvider: { requiresAuth: false, validateToken: async () => null } });
  await new Promise(r => srv.httpServer.listen(0, '127.0.0.1', r));
  const url = `ws://127.0.0.1:${srv.httpServer.address().port}`;
  const providers = [];
  for (const id of ['r1', 'r2', 'r3']) {
    const doc = new Y.Doc();
    const prov = new HocuspocusProvider({ url, name: `_public/${id}`, document: doc, WebSocketPolyfill: WS });
    await waitFor(() => prov.synced);
    doc.transact(() => { doc.getArray('order').push([id]); }, 'local-publish');
    providers.push({ prov, doc, id });
  }
  // Do NOT wait for the debounce window — exercise the shutdown drain.
  srv.hocuspocus.closeConnections();
  srv.hocuspocus.flushPendingStores();
  await srv.database.drain();
  for (const id of ['r1', 'r2', 'r3']) expect(persisted.has(`_public/${id}`)).toBe(true);
  for (const { prov, doc } of providers) { prov.destroy(); doc.destroy(); }
  srv.httpServer.close();
});
```

- [ ] **Step 2: Run — verify the flush guarantee**

Run: `node --test server/__tests__/hocuspocus-server.test.mjs`
Expected: PASS — all three rooms persisted. If only `r1` persists, `flushPendingStores()` + `drain()` are not covering all dirty rooms → revisit the drain loop in `SecWriterDatabase.drain()` (Task 4.1) and whether `flushPendingStores()` enqueued every room.

- [ ] **Step 3: Source the realistic room count + room size BEFORE the timing assertion**

The N and per-room cost are NOT free parameters — guessing them makes the gate meaningless (review B5/S2). Before writing the timing test:
  1. **N (active dirty rooms at shutdown):** read it from production. Hit the live `/health` (or its logs) for the p99 concurrent-active-room count. If production has no traffic history yet, state that explicitly and use a deliberately pessimistic N (e.g. 50) with a TODO to re-confirm post-launch — do NOT silently use a convenient number.
  2. **Per-room serialize cost:** `serializeRoom` cost scales with block count, so seed rooms with a REALISTIC block count (use a real sample .SEC's block count, ~100-300 blocks, not a 1-element array). A 1-block room hides the real serialize time.
  3. **writeRoom latency:** model worst-case S3/Azure with an artificial `await sleep(latency)` (200ms is a defensible upper bound; cite the basis).

Record all three chosen values + their basis in the commit message and ADR-0018.

- [ ] **Step 4: Add the measured-within-grace assertion (concrete threshold)**

```js
it('shutdown drain completes within the SIGTERM grace at realistic room count + size + latency', async () => {
  const WRITE_LATENCY_MS = 200;          // worst-case S3/Azure (cite basis)
  const N = /* from Step 3.1 — p99 prod count, or pessimistic w/ TODO */ 50;
  const BLOCKS = makeRealisticBlocks(/* ~200, from a sample .SEC */);
  const storage = { readRoom: async () => null, writeRoom: async () => { await new Promise(r => setTimeout(r, WRITE_LATENCY_MS)); }, readAcl: async () => ({ ownerId: '_public', sharedWith: [] }) };
  const srv = createCollabServer({ storage, useHocuspocus: true, authProvider: { requiresAuth: false, validateToken: async () => null } });
  await new Promise(r => srv.httpServer.listen(0, '127.0.0.1', r));
  const url = `ws://127.0.0.1:${srv.httpServer.address().port}`;
  const ps = [];
  for (let i = 0; i < N; i++) {
    const doc = new Y.Doc();
    const prov = new HocuspocusProvider({ url, name: `_public/m${i}`, document: doc, WebSocketPolyfill: WS });
    await waitFor(() => prov.synced);
    doc.transact(() => { for (const b of BLOCKS) doc.getArray('order').push([b.id]); /* + store entries */ }, 'local-publish');
    ps.push({ prov, doc });
  }
  const t0 = Date.now();
  srv.hocuspocus.closeConnections();
  srv.hocuspocus.flushPendingStores();
  await srv.database.drain();
  const elapsed = Date.now() - t0;
  expect(elapsed).toBeLessThan(20000); // grace (25s on Render) - safety
  for (const { prov, doc } of ps) { prov.destroy(); doc.destroy(); }
  srv.httpServer.close();
});
```

- [ ] **Step 5: Run — record the measured number**

Run: `node --test server/__tests__/hocuspocus-server.test.mjs`
Expected: PASS with `elapsed` < 20s. **GATE GREEN.** Record the measured elapsed AND the chosen N/block-count/latency in the commit message. If a realistic prod count would breach 20s under serial flush, add concurrent flushing in `SecWriterDatabase.drain()` (bounded concurrency) NOW and re-measure.

- [ ] **Step 6: Note the store re-entrancy coverage**

Two-overlapping-stores-per-key is pinned at the unit level in Task 4.1 step 1 (last test) and inherited by the drain. No server-level duplicate needed (headroom).

- [ ] **Step 7: Commit**

```bash
git add server/__tests__/hocuspocus-server.test.mjs
git commit -F- <<'EOF'
test(server): GATE — shutdown drain flushes ALL dirty rooms within grace (#128)

Measured drain wall-time at N=<count> rooms x ~<blocks> blocks x 200ms write
latency: ~Xms (record actual). N sourced from <prod p99 | pessimistic+TODO>.
Asserts < 20s (grace - safety). Flush-all asserts >=3 rooms persist.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
```

---

## Phase 6 — Migration broker in `onLoadDocument`

Spec §6. The v1→v2 substrate broker rehomes from the upgrade handler to `onLoadDocument`, with invariants preserved.

> **Not a concern here (fourth review):** the Hocuspocus unload-during-debounce and document memory-leak races ([#832](https://github.com/ueberdosis/hocuspocus/issues/832)/[#846](https://github.com/ueberdosis/hocuspocus/issues/846)) are specific to `DirectConnection` (server-side `openDirectConnection`), which this design never uses — the broker runs inside `onLoadDocument` on the normal WebSocket load path. So the broker does not need to guard against them; the only ordering hazard that applies is backup-before-mutate (Step 4).

### Task 6.1: Adapt the broker entry for onLoadDocument (catch-and-return, enqueue-store)

**Files:**
- Modify: `server/migrate-pm-substrate.cjs`
- Modify: `server/collab-server.cjs`

- [ ] **Step 1: Read the current broker to confirm `ensureMigrated`'s contract**

Read `server/migrate-pm-substrate.cjs` end to end. Confirm: `ensureMigrated(docName, doc)` resolves with `{ skipped }` or a partial, catches per-step errors, `backupRoom` runs before mutation, `needsMigration` short-circuits v2/partial, `migrationCoordinator.forget(compositeKey)` is wired on DELETE, and the per-room async lock exists. Record `SCHEMA_VERSION_KEY`/`MIGRATION_PARTIAL_KEY` mutual-exclusion handling.

- [ ] **Step 2: Wire `onLoadDocument` to run the broker on the validated canonical key**

In `buildHocuspocus()`:

```js
const onLoadDocument = async ({ documentName, document }) => {
  // documentName is the validated canonical key (onAuthenticate rejected any
  // non-canonical/cross-tenant name BEFORE this runs — §3/§6). Never an
  // attacker-supplied name here.
  if (migrationCoordinator) {
    try {
      await migrationCoordinator.ensureMigrated(documentName, document);
    } catch (err) {
      // §6: an onLoadDocument THROW has different semantics under Hocuspocus
      // (retry, doc stays in memory) than the current "log and continue, room
      // stays v1". The broker must CATCH its own errors and RETURN the
      // document, preserving the editable-room + migration-partial-banner
      // failure mode. This catch is the backstop.
      log.warn('migrate.coordinator-failed', { documentName, err: err && err.message });
    }
  }
  return document;
};
```
Add `onLoadDocument` to the `new Hocuspocus({ … })` options.

- [ ] **Step 3: Ensure the broker's mutations enqueue a store (§6 zero-edit persistence)**

A freshly-migrated room with zero subsequent human edits must still persist. Confirm (via type defs / behavior) that mutating `document` inside `onLoadDocument` enqueues a debounced store. If it does NOT, the broker must persist explicitly (call the database `store` or set a dirty flag). Pin this with the end-to-end test in Task 6.2.

- [ ] **Step 4: Prove backup-before-return ordering (§6 hazard)**

Confirm `backupRoom` fully completes before `onLoadDocument` returns the migrated document, AND that Hocuspocus does not enqueue a `store` for the broker's in-`onLoadDocument` mutations before the backup settles (a crash before backup completes would leave a migrated `.ydoc` with no backup). If the store can fire mid-load, gate the broker so backup completes first (await backup before any mutation — the current coordinator already awaits `backupRoom` before mutating; confirm that ordering survives the rehome). Backup failure must abort migration leaving the room v1.

- [ ] **Step 5: Commit**

```bash
git add server/collab-server.cjs server/migrate-pm-substrate.cjs
git commit -m "feat(server): rehome v1->v2 broker to onLoadDocument (catch-and-return) (#128)"
```

### Task 6.2: Broker end-to-end + mutual-exclusion tests (batched into the at-cap file)

**Files:**
- Modify: `server/__tests__/migrate-pm-substrate.test.mjs` (**AT the 30-test cap — batch into existing `it()`/`it.each`, do NOT add test #31** per CLAUDE.md rule #13)

- [ ] **Step 1: Add a broker → `onLoadDocument` → client-sync → `pmFragmentToHtml` end-to-end assertion into an existing `it()`**

Per CLAUDE.md collab pattern #3, per-side unit pins can stay green while the pipe is broken — the end-to-end test is required. Seed a v1 room (Y.Text html), drive it through `onLoadDocument`, sync a `HocuspocusProvider`, and assert the client reads correct HTML via `pmFragmentToHtml`. Also assert the broker output attr keys (`revisionAdd|revisionDel|revisionChg: { authorId, authorColor }`) round-trip (the #220 silent-drop hazard).

- [ ] **Step 2: Add the `schemaVersion`/`migrationPartial` mutual-exclusion-under-catch-and-return assertion**

Force a per-block migration failure and assert the room is stamped `migrationPartial` and NOT `schemaVersion=2` (the new "catch-and-return the document" failure mode must hold the same invariant as the old "throw and stay v1").

- [ ] **Step 3: Run + commit**

Run: `node --test server/__tests__/migrate-pm-substrate.test.mjs` → PASS (still ≤30 tests).
```bash
git add server/__tests__/migrate-pm-substrate.test.mjs
git commit -m "test(server): broker-under-onLoadDocument end-to-end + mutual-exclusion (#128)"
```

---

## Phase 7 — GATE A2: client seed re-gated on the proven `synced` contract (option A)

Spec §5 / §Gating item 2. **Design (2026-06-21, fourth review):** the client `handleSync` seed-on-empty is KEPT, moved onto Hocuspocus's `onSynced` event, and hardened against reconnect/StrictMode re-seed. The fragile `_serverMeta.newRoom` doc-attribute signal stays gone (it would have persisted into `.ydoc` via whole-doc `encodeStateAsUpdate` and resurfaced `newRoom:true` on every reload, reintroducing #17).

**Why client-side, not the server upload.** The earlier "server-authoritative seed" design routed create-room through `POST /rooms/:id/upload` before connecting. The fourth review showed it cannot work: that endpoint returns **409 if the room has no live bound Y.Doc** ([http-handler.cjs:238](../../../server/http-handler.cjs)) and a cold never-connected room is not bound; it also seeds **v1 Y.Text** ([room-serializer.cjs:196](../../../server/room-serializer.cjs)), not the v2 substrate; and its only edge over the client seed — `writeAclIfAbsent` concurrent-create safety — exists **only under auth=jwt** ([http-handler.cjs:377](../../../server/http-handler.cjs)), not the default auth=none. So it added a 409 failure mode and a data-loss window (seed clears the store, wiping anything typed in the connect→upload gap) for no real gain.

**Why the client seed is now safe (the reframed #17).** What makes the seed correct is Hocuspocus's `synced` contract — proven by the spike to fire only AFTER `onLoadDocument`'s state is applied to the client doc. So `empty` observed at `synced` is a genuinely-new room, not a timing artifact. On the single-instance free plan (`render.yaml` `plan: free`), every client to a room shares ONE in-memory Y.Doc and `onLoadDocument` runs once — the classic two-client doubling cannot happen (the second client syncs the first's seed from memory). The residual risk is NOT concurrent-create; it is a **reconnect/StrictMode re-seed**: a provider remount that observes the room empty because the seed was evicted from memory before its store flushed. Two defenses, both in Task 7.1:
  1. **Client-side per-room seed guard** — a module-level `Set` keyed by canonical room id, so a remount in the same browser session seeds a given room at most once.
  2. **Server warm-doc** — `unloadImmediately: false` (Task 4.2) keeps the doc in memory briefly after the last client leaves, so a remount re-syncs the seed from memory (no false-empty) AND the seed's 500ms store always flushes before unload.

Gate A2 (Task 7.2) is (a) the load-ordering characterization test that PROVES the `synced` contract, (b) a load-once-from-memory test, (c) a warm-doc-across-reconnect test, and (d) a client-side re-seed-guard test that drives the actual seed path through two provider mounts.

### Task 7.1: Re-gate the client seed on `onSynced`; add the per-room re-seed guard

**Files:**
- Modify: `src/lib/collab.js` (re-gate `handleSync` seed-on-empty; add the seed guard)

(`src/App.jsx` is NOT touched — the create-room upload design was dropped.)

- [ ] **Step 1: Add a module-level per-room seed guard**

Near the top of `src/lib/collab.js`, add a session-lifetime guard:

```js
// #17 / option A: a room is seeded at most once per browser session, keyed by
// canonical room id. Guards the reconnect/StrictMode re-seed window — a
// provider remount that observes the room empty (because the seed was evicted
// before its store flushed) must NOT seed a second time. Module scope persists
// across provider remounts within the session; different room id = different
// key, so re-entering a DIFFERENT room still seeds correctly.
const seededRooms = new Set();
```

- [ ] **Step 2: Re-gate the seed on `onSynced`, guarded by `seededRooms`**

In `src/lib/collab.js` `handleSync` (~line 954 — re-locate by content; it is the `if (isSynced && !seeded)` block with `empty = yOrder.length === 0 && yStore.size === 0`), keep the blocks seed but gate it on the per-room guard and rely on the `onSynced`-driven `isSynced`:

```js
  const handleSync = (isSynced) => {
    if (isSynced && !seeded) {
      seeded = true;
      // The empty-check is now RELIABLE: Hocuspocus's onSynced fires only after
      // onLoadDocument's state is applied (proven, Task 7.2), so an empty
      // observation here is a genuinely-new room, not a pre-sync timing
      // artifact. The per-room guard stops a reconnect/StrictMode remount from
      // re-seeding a room whose seed was evicted before it flushed.
      const empty = yOrder.length === 0 && yStore.size === 0;
      if (empty && !seededRooms.has(room) && Array.isArray(initialBlocks) && initialBlocks.length > 0) {
        seededRooms.add(room);
        seedYBlocks(ydoc, initialBlocks);   // existing helper — unchanged
      }

      // META seed (RETAINED, LWW): yMeta is a Y.Map written via set(), not an
      // array append, so a concurrent double-seed converges — no doubling.
      if (yMeta.size === 0 && initialMeta && typeof initialMeta === 'object') {
        ydoc.transact(() => {
          for (const [k, v] of Object.entries(initialMeta)) {
            if (v !== undefined) yMeta.set(k, v);
          }
        }, 'seed');
      }
      // … initial onRemote* emits unchanged …
    }
    onStatusChange?.(isSynced ? 'connected' : 'syncing', { reconnectIn: 0 });
  };
```

`seedYBlocks` and `initialBlocks` STAY (unlike the dropped option-1 plan). `room` here is the canonical composite id the provider is named with (Task 8.1) — confirm it is in scope in `handleSync`; if not, thread it in.

> The seed guard + warm-doc together close the re-seed window. Note the tradeoff the guard alone makes: if the server lost the seed (evicted before flush) AND the warm-doc window expired, the guard prevents a re-seed — the room stays empty rather than doubling. The warm-doc config (`unloadImmediately: false`, Task 4.2) is what prevents that loss; the guard prevents the doubling. Both are needed. This is why Task 7.2 tests warm-doc-across-reconnect explicitly.

- [ ] **Step 3: Commit**

```bash
git add src/lib/collab.js
git commit -m "feat(collab): re-gate client seed on onSynced + per-room re-seed guard (#17/#128)"
```

### Task 7.2: GATE A2 — load-ordering + load-once + warm-doc + client re-seed guard

**Files:**
- Modify: `server/__tests__/hocuspocus-server.test.mjs` (Steps 1-3: server-side properties)
- Modify: a client collab test (Step 4: the actual seed path through two mounts — see Step 4 for the file)

All Node providers pass `WebSocketPolyfill: WS`.

- [ ] **Step 1: Load-ordering characterization (the contract the seed relies on)**

This is the gate the spike validated, now run through the REAL `SecWriterDatabase.fetch` → `storage.readRoom` path with an injected delay to widen any window. It proves `synced` does not fire until the server-loaded state is applied — so an empty observation at `synced` is a genuinely-new room.

```js
it('GATE A2: synced fires only AFTER onLoadDocument state is applied', async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  // Existing 5-block room, persisted; readRoom is SLOW (widen the window).
  const persisted = new Y.Doc();
  seedRoomFromBlocks(persisted, [0,1,2,3,4].map(i => ({ id: `b${i}`, type: 'txt', part: 1, depth: 0, html: `B${i}` })));
  const bytes = Y.encodeStateAsUpdate(persisted);
  const storage = {
    readRoom: async (t, r) => { await sleep(800); return r === 'existing' ? { ydocBytes: bytes } : null; },
    writeRoom: async () => {},
    readAcl: async () => ({ ownerId: '_public', sharedWith: [] }),
  };
  const srv = createCollabServer({ storage, useHocuspocus: true, authProvider: { requiresAuth: false, validateToken: async () => null } });
  await new Promise(r => srv.httpServer.listen(0, '127.0.0.1', r));
  const url = `ws://127.0.0.1:${srv.httpServer.address().port}`;

  // Existing room: at synced, all 5 blocks already present (no false-empty).
  const dExist = new Y.Doc();
  let lenAtSynced = -1;
  const pExist = new HocuspocusProvider({ url, name: '_public/existing', document: dExist, WebSocketPolyfill: WS, onSynced: () => { lenAtSynced = dExist.getArray('order').length; } });
  await waitFor(() => pExist.synced);
  expect(lenAtSynced).toBe(5);   // server state applied BEFORE synced — the contract

  // Genuinely new room: empty at synced (this is when create-room would have
  // uploaded server-side; the client never seeds).
  const dNew = new Y.Doc();
  let newLenAtSynced = -1;
  const pNew = new HocuspocusProvider({ url, name: '_public/newroom', document: dNew, WebSocketPolyfill: WS, onSynced: () => { newLenAtSynced = dNew.getArray('order').length; } });
  await waitFor(() => pNew.synced);
  expect(newLenAtSynced).toBe(0);

  pExist.destroy(); pNew.destroy(); dExist.destroy(); dNew.destroy(); srv.httpServer.close();
});
```

- [ ] **Step 2: Load-once-from-memory (the property that kills two-client doubling)**

On a single instance, a SECOND client to a room must sync the first client's content from the shared in-memory doc WITHOUT a second `onLoadDocument`/`readRoom`. This is the property that makes "first client seeds, second client never sees empty" hold. Count the storage reads to prove load-once:

```js
it('GATE A2: second concurrent client loads from memory (one onLoadDocument, sees content)', async () => {
  let reads = 0;
  const persisted = new Y.Doc();
  seedRoomFromBlocks(persisted, [{ id: 'a', type: 'txt', part: 1, depth: 0, html: 'A' }]);
  const bytes = Y.encodeStateAsUpdate(persisted);
  const storage = { readRoom: async () => { reads++; return { ydocBytes: bytes }; }, writeRoom: async () => {}, readAcl: async () => ({ ownerId: '_public', sharedWith: [] }) };
  const srv = createCollabServer({ storage, useHocuspocus: true, authProvider: { requiresAuth: false, validateToken: async () => null } });
  await new Promise(r => srv.httpServer.listen(0, '127.0.0.1', r));
  const url = `ws://127.0.0.1:${srv.httpServer.address().port}`;
  const dA = new Y.Doc(); const pA = new HocuspocusProvider({ url, name: '_public/shared', document: dA, WebSocketPolyfill: WS });
  await waitFor(() => pA.synced);
  const dB = new Y.Doc(); const pB = new HocuspocusProvider({ url, name: '_public/shared', document: dB, WebSocketPolyfill: WS });
  await waitFor(() => pB.synced);
  expect(dB.getArray('order').length).toBe(1); // B saw A's content
  expect(reads).toBe(1);                        // load-once: B did NOT re-read storage
  pA.destroy(); pB.destroy(); dA.destroy(); dB.destroy(); srv.httpServer.close();
});
```

- [ ] **Step 3: Warm-doc-across-reconnect (the property that prevents re-seed AND seed loss)**

A provider remount within the warm window must re-sync the existing content from MEMORY even if storage would return empty — so the client observes non-empty at `synced` and does NOT re-seed. With `unloadImmediately: false` (Task 4.2), make `readRoom` return `null` (as if the seed never flushed) and assert the reconnecting client still sees the in-memory content:

```js
it('GATE A2: reconnect within the warm window syncs from memory (no false-empty, no re-seed)', async () => {
  const storage = { readRoom: async () => null /* storage is empty — memory must win */, writeRoom: async () => {}, readAcl: async () => ({ ownerId: '_public', sharedWith: [] }) };
  const srv = createCollabServer({ storage, useHocuspocus: true, authProvider: { requiresAuth: false, validateToken: async () => null } });
  await new Promise(r => srv.httpServer.listen(0, '127.0.0.1', r));
  const url = `ws://127.0.0.1:${srv.httpServer.address().port}`;
  // First client seeds content into the (storage-empty) room, then disconnects.
  const d1 = new Y.Doc(); const p1 = new HocuspocusProvider({ url, name: '_public/warm', document: d1, WebSocketPolyfill: WS });
  await waitFor(() => p1.synced);
  d1.transact(() => { d1.getArray('order').push(['seeded']); }, 'local-publish');
  p1.destroy(); // socket closes; with unloadImmediately:false the doc stays warm
  // Immediate remount (the StrictMode/reconnect shape) — must see the seed from memory.
  const d2 = new Y.Doc(); const p2 = new HocuspocusProvider({ url, name: '_public/warm', document: d2, WebSocketPolyfill: WS });
  await waitFor(() => p2.synced);
  expect(d2.getArray('order').length).toBe(1);   // memory retained the seed; NOT false-empty
  p2.destroy(); d1.destroy(); d2.destroy(); srv.httpServer.close();
});
```

> If this FAILS (`length === 0` on the remount), `unloadImmediately: false` is not keeping the doc warm in this version — confirm the field name + the unload-timeout option in the type defs (Task 4.2), or the client seed guard becomes the SOLE re-seed defense and the seed-loss tradeoff (Task 7.1 Step 2 note) is real. Record the resolution in ADR-0018.

- [ ] **Step 4: Client re-seed-guard test (drives the ACTUAL seed path through two mounts)**

Steps 1-3 pin server properties; this pins the client `handleSync` seed + `seededRooms` guard directly — the server tests can't, because they use raw `Y.Doc`s and never run `collab.js`'s seed logic. Add ONE test to an existing client collab test file (e.g. `src/lib/__tests__/collab-*.test.js` — pick the one that already builds a session against a loopback Hocuspocus, or the undo-origin file's harness). Boot a loopback Hocuspocus, create a session for a NEW room with non-empty `initialBlocks`, await synced (asserts it seeds once), then build a SECOND session for the SAME room id with the same module instance (simulating a StrictMode/reconnect remount) and assert the block count does NOT double (the `seededRooms` guard + warm-doc both hold the line). This is the regression that guards the re-seed window the reframed #17 is actually about.

- [ ] **Step 5: Run — the A2 gate**

Run: `node --test server/__tests__/hocuspocus-server.test.mjs` (Steps 1-3) and the client test (Step 4).
Expected: ALL pass. Ordering: existing = 5 at synced, new = 0. Load-once: B sees content, `reads === 1`. Warm-doc: remount sees the seed from memory. Re-seed guard: no doubling across two mounts. **GATE A2 GREEN.**
If the ordering test FAILS (existing room < 5 at synced): Hocuspocus's `synced` does NOT wait for `onLoadDocument` in this configuration — the whole option-A premise (an empty observation at synced is genuinely new) is broken. **STOP** and revisit §5 before any client seed ships.

- [ ] **Step 6: Eviction-guard disposition + concurrent-create note**

Record in ADR-0018: the v1 eviction-race guard (re-install the preloaded doc after every await window) is superseded by `onLoadDocument` (single authoritative load) + `unloadImmediately: false` (warm doc) + the client `seededRooms` guard. The old v1-specific eviction-race test (manual `ywsDocs.delete` mid-await) is unrunnable and is replaced by Steps 2-4. Concurrent-create-SAME-id is NOT a seed concern under option A: room ids are server-assigned-unique (`POST /rooms` mints the id), so two clients independently creating the same id essentially cannot happen; and even the pre-existing empty-room create race is unprotected under auth=none today (`writeAclIfAbsent` is auth-only — [http-handler.cjs:377](../../../server/http-handler.cjs)), a benign last-writer-wins on an identical empty doc. State this honestly; do NOT claim `writeAclIfAbsent` protects the seed under the default config.

- [ ] **Step 7: Commit**

```bash
git add server/__tests__/hocuspocus-server.test.mjs src/lib/__tests__/
git commit -m "test(collab): GATE A2 — load-ordering + load-once + warm-doc + re-seed guard (#128)"
```

---

## Phase 8 — Client provider migration (`WebsocketProvider` → `HocuspocusProvider`)

Spec §7. Flag-day change. Gate A1 must be green before this phase.

### Task 8.1: Swap the provider construction + token + binding

**Files:**
- Modify: `src/lib/collab.js` (provider construction ~lines 923-935)

- [ ] **Step 1: Replace `WebsocketProvider` with `HocuspocusProvider`**

Replace the import and construction. Token moves from the room-name hack to the real `token` option (may be an async callback for refresh-on-reconnect):

```js
import { HocuspocusProvider } from '@hocuspocus/provider';
// …
// documentName on the wire is the BARE canonical composite room id with NO
// path prefix (no /ws/ parallel-room split under the new stack). `room` here
// must already be the canonical `<tenant>/<roomId>`.
// No WebSocketPolyfill here — the browser build has window.WebSocket. (Node
// tests MUST pass WebSocketPolyfill: ws; see the Node-test provider rule.)
const provider = new HocuspocusProvider({
  url: wsUrl,                       // bare ws origin, no room/token in the URL
  name: room,                       // canonical composite; in-band, not URL
  document: ydoc,
  token: getTokenFn ? (async () => (await getTokenFn()) || currentToken) : currentToken,
  onSynced: () => handleSync(true),
  onStatus: ({ status }) => handleStatus({ status }),
  onAuthenticationFailed: () => onStatusChange?.('incompatible', { reconnectIn: 0 }),
});
const awareness = provider.awareness;
```

> The `provider.url` mutation on reconnect (old token-refresh hack, lines 1021-1027) is REMOVED — the `token` async callback handles rotation without URL mutation. Delete the `handleStatus` `provider.url = …` block.

- [ ] **Step 2: Confirm awareness + ydoc binding for ySyncPlugin still hold**

`HocuspocusProvider` exposes `.awareness` and binds `.document`. Confirm y-prosemirror's `ySyncPlugin` (which binds to the Y.XmlFragment, not the provider) is unaffected — the provider only owns transport + awareness. No PM code changes expected; pin with the existing PM mount test under the new provider if feasible.

- [ ] **Step 3: Commit**

```bash
git add src/lib/collab.js
git commit -m "feat(collab): swap WebsocketProvider -> HocuspocusProvider (#128)"
```

### Task 8.2: Re-prove status/sync mapping + sticky-status filter against Hocuspocus events

**Files:**
- Modify: `src/lib/collab.js` (status mapping ~lines 996-1034)
- Modify: `src/hooks/useCollabSession.js` (effectiveStatus + sticky filter ~lines 359-389)

- [ ] **Step 1: Re-derive the four-state `effectiveStatus` mapping**

y-websocket fired `sync` separately from `status`; Hocuspocus has `onSynced`/`synced` + `onStatus` (`connecting|connected|disconnected`) + a separate `onAuthenticationFailed`. The sticky-status filter (never flash "connected" over "incompatible"/"migration-partial") is a real correctness property tightly coupled to the old event timing. Re-map:
  - `onStatus connecting` → `connecting`
  - `onStatus connected` (WS open, pre-sync) → `syncing` (do NOT surface `connected` yet)
  - `onSynced` → `connected`
  - `onStatus disconnected` → `disconnected`
  - `onAuthenticationFailed` → `incompatible` (sticky)

- [ ] **Step 2: Re-derive reconnect backoff (or drop the countdown) + handle server-initiated close**

The banner countdown read y-websocket's `provider.wsUnsuccessfulReconnects`/`maxBackoffTime` (lines 1009-1014). These don't exist on HocuspocusProvider. Either map to Hocuspocus's reconnect model (confirm property names) or drop the countdown to a generic "reconnecting…". Choose the simpler option (generic message) unless the type defs expose a clean attempt counter.

> **Provider lifecycle hazards (fourth review — confirm against the installed provider source/issues, do not assume clean teardown):**
> - [#803](https://github.com/ueberdosis/hocuspocus/issues/803): `provider.destroy()` can trigger an auto-reconnect because the close reason isn't checked. The session-cleanup path (and React StrictMode's mount→destroy→mount) must leave NO zombie reconnect loop — verify the provider is actually gone after teardown (e.g. assert no further `status` events fire post-destroy in a unit test).
> - [#782](https://github.com/ueberdosis/hocuspocus/issues/782): `provider.disconnect()` then `provider.connect()` has failed to re-send buffered edits in past releases. If any code path (tab background/foreground) uses disconnect/connect rather than a fresh provider, verify edits survive the round-trip.
> - [#566](https://github.com/ueberdosis/hocuspocus/issues/566): after a SERVER-initiated close (e.g. `messageReconnectTimeout`), the provider may believe it is still authenticated and NOT re-send the token on reconnect. The status mapping must treat a server-initiated close as a full re-auth, not a silent resume — otherwise a revoked user reconnects with stale auth (ties to Phase 3.3 Step 2). Confirm the token callback (Task 8.1) is re-invoked on reconnect.
> Pin whatever you can in a unit test; at minimum, manually verify the background-tab disconnect/reconnect path against a production build (StrictMode masks single-invoke ordering — CLAUDE.md rule #12).

- [ ] **Step 3: Re-prove the sticky filter in useCollabSession**

Confirm the `migrationPartial`/`incompatible` sticky pins survive Hocuspocus's event ordering (a trailing `onSynced` must not clobber an `incompatible` banner). Adjust the sticky-filter predicate to the new event sources.

- [ ] **Step 4: Update `window.__collab` DEV surface**

Replace the y-websocket provider object fields with the HocuspocusProvider equivalents (`provider.wsconnected` → the Hocuspocus status; keep `ydoc, yOrder, …, provider, undoManager, …`).

- [ ] **Step 5: Update the trackedOrigins comment block (lines 1130-1138)**

The comment asserts "the WebsocketProvider applies remote updates with the provider INSTANCE as the Yjs origin." Update it to reference HocuspocusProvider and cite the Gate A1 test (`hocuspocus-undo-origin.test.js`) as the pin. The `trackedOrigins` set itself does NOT change UNLESS Gate A1 found a different origin (in which case it was already reworked in Phase 2).

- [ ] **Step 6: Run client unit tests + commit**

Run: `npm test -- src/lib/__tests__/ src/hooks/`
Expected: PASS (status mapping + undo tests green).
```bash
git add src/lib/collab.js src/hooks/useCollabSession.js
git commit -m "feat(collab): re-prove status/sync/sticky mapping for Hocuspocus events (#128)"
```

### Task 8.3: Client `name` assertion + getActiveUsers rewrite + flip useHocuspocus default-on

**Files:**
- Modify: `server/collab-server.cjs` (`getActiveUsers` rewrite; default `useHocuspocus` on; delete y-websocket path)
- Modify: `src/lib/collab.js` test (assert provider name is bare canonical)

- [ ] **Step 1: Add a client test asserting `HocuspocusProvider.name` is the bare canonical composite (no `/ws/` prefix)**

In a client test, construct the session and assert `provider.name` equals the canonical `<tenant>/<roomId>` with no path prefix (spec §7 — no reintroduction of the `/ws/` parallel-room split).

- [ ] **Step 2: Rewrite `getActiveUsers` against `hocuspocus.documents`**

Replace the `ywsUtils.docs.get(docName).awareness` read (lines 138-154) with `hocuspocus.documents.get(docName)` and read its awareness states. CONFIRMED (Task 1.2): `hocuspocus.documents` is a `Map<string, Document>` and `Document` carries `.awareness`. `Map.get` is a plain read — it does NOT materialize/load a document, so calling `getActiveUsers` for an unknown room returns `[]` without creating a phantom room (the key must be the canonical composite name, matching the provider `name`). Keep the same return shape `{ id, name, color }`.

```js
function getActiveUsers(docName) {
  if (!hocuspocusInstance) return [];
  try {
    const hpDoc = hocuspocusInstance.documents.get(docName);
    if (!hpDoc || !hpDoc.awareness) return [];
    const users = [];
    hpDoc.awareness.getStates().forEach((state) => {
      if (state.user && state.user.id && state.user.name) {
        users.push({ id: state.user.id, name: state.user.name, color: state.user.color || '#888' });
      }
    });
    return users;
  } catch { return []; }
}
```

- [ ] **Step 3: Flip `useHocuspocus` default-on and delete the y-websocket relay path**

Change `const useHocuspocus = config.useHocuspocus === true;` to default true (`config.useHocuspocus !== false`), then delete the now-dead y-websocket blocks: the `setPersistence({...})` call, the old `httpServer.on('upgrade', async …)` handler, `extractDocName`'s use in that handler, `flushRoom`/`flushAllRooms`/`writeTimers`/`docLoadPromises` if no longer referenced (keep `extractDocName` exported + tested if §Patterns #1 says it still matters for routing — re-derive). Update the factory return to drop dead fields. Remove the `y-websocket`, `ws`-as-server-import lines that are now unused.

> Caution: do this deletion carefully — `getYDoc`, `setupWSConnection`, `ywsDocs` all go away. Run `npm run test:server` after each deletion chunk.

- [ ] **Step 4: Remove `y-websocket` from dependencies (ADR-0002 superseded)**

Once no code imports `y-websocket`, remove it from `package.json` dependencies. Run `npm install` to update the lockfile.

- [ ] **Step 5: Run the full server suite + commit**

Run: `npm run test:server`
Expected: PASS.
```bash
git add server/collab-server.cjs src/lib/collab.js package.json package-lock.json
git commit -m "feat(collab): Hocuspocus default-on, remove y-websocket relay path (#128)"
```

---

## Phase 9 — GATE: cross-stack rollback byte-compare

Spec §Deploy / §Gating item 4. Until green, the runbook states rollback may require manual `.ydoc` re-export.

### Task 9.1: Hocuspocus-write → y-websocket-read → byte-compare `.SEC`

**Files:**
- Create: `tests/cross-stack-rollback.node-test.mjs`

> No y-websocket dependency: this test never boots either relay. It exercises the SHARED, stack-agnostic `room-serializer.serializeRoom` — the same module both the old y-websocket server and the new Hocuspocus server call. So it can run at ANY point (the earlier draft's "run before the y-websocket removal" note was wrong — there is nothing stack-specific to install). What it actually proves: a `.ydoc` carrying the **v2 `Y.XmlFragment` substrate** (what production will hold after migration) round-trips through a bare `Y.applyUpdate` into a fresh gc doc and yields byte-identical `.SEC`. That is the real rollback risk — a reverted server reading v2 bytes — and it is independent of which relay is running.

- [ ] **Step 1: Write the byte-compare test — DRIVE THE BROKER to a real Y.XmlFragment**

The review flagged the earlier draft as vacuous: `seedRoomFromBlocks` yields **Y.Text**, and the broker drive-through was "optional", so it byte-compared a Y.Text round-trip — never exercising the `Y.XmlFragment` gc hazard that is the whole point. The broker drive-through is now MANDATORY, with an `instanceof Y.XmlFragment` assertion gating the comparison.

```js
import { test } from 'node:test';
import assert from 'node:assert';
import '../server/dom-polyfill.cjs';
// Dual-package rule: get Y from the SAME copy the CJS serializer uses.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const Y = require('yjs');
const { serializeRoom, seedRoomFromBlocks } = require('../server/room-serializer.cjs');
// M2 FIX: no free `ensureMigrated` export — use the coordinator, and give it a
// storage stub with backupRoom (it awaits backupRoom before mutating, else SKIPS).
const { createMigrationCoordinator, migrateRoom } = require('../server/migrate-pm-substrate.cjs');

test('cross-stack rollback: v2 Y.XmlFragment .ydoc -> bare applyUpdate -> identical .SEC', async () => {
  // 1. Build a realistic room and DRIVE THE BROKER so the html slots are real
  //    Y.XmlFragment (v2), with TC marks + a note block.
  const hpDoc = new Y.Doc({ gc: true });
  seedRoomFromBlocks(hpDoc, [
    { id: 'a', type: 'txt', part: 1, depth: 0, html: '<ins class="mark-add" data-author-id="u1">added</ins> text' },
    { id: 'b', type: 'note', part: 1, depth: 0, html: 'A note' },
  ]);
  const coord = createMigrationCoordinator({
    storage: { backupRoom: async () => {} },
    log: { info() {}, warn() {}, error() {} },
    migrateImpl: migrateRoom,
  });
  await coord.ensureMigrated('tenantA/rollback', hpDoc);
  const slot = hpDoc.getMap('store').get('a').get('html');
  assert.ok(slot instanceof Y.XmlFragment, 'precondition: broker must yield Y.XmlFragment, not Y.Text');
  const { secBytes: hpSec } = await serializeRoom(hpDoc);
  const ydocBytes = Y.encodeStateAsUpdate(hpDoc);

  // 2. Reverted server: decode the SAME bytes into a fresh gc doc (bare applyUpdate).
  const wsDoc = new Y.Doc({ gc: true });
  Y.applyUpdate(wsDoc, new Uint8Array(ydocBytes));
  const reSlot = wsDoc.getMap('store').get('a').get('html');
  assert.ok(reSlot instanceof Y.XmlFragment, 'reloaded slot must remain Y.XmlFragment after applyUpdate under gc');
  const { secBytes: wsSec } = await serializeRoom(wsDoc);

  // 3. Byte-compare .SEC. A gc-driven structural difference in the XmlFragment
  //    must NOT silently change .SEC content.
  assert.deepEqual([...wsSec], [...hpSec], 'rollback .SEC must be byte-identical');
});
```

- [ ] **Step 2: Run — the rollback gate**

Run: `node --test tests/cross-stack-rollback.node-test.mjs`
Expected: PASS — both `instanceof Y.XmlFragment` preconditions hold AND `.SEC` is byte-identical. **GATE GREEN → rollback is verified; the runbook can state "revert the merge commit" as a clean path.**
If the `instanceof` precondition FAILS: the broker entry/drive-through is wrong — fix that first (a Y.Text round-trip would "pass" the byte-compare while proving nothing). If the byte-compare FAILS: gc-driven structural differences yield different `.SEC`. **Do NOT claim clean rollback.** The runbook (Phase 12) must state rollback requires manual `.ydoc` re-export.

- [ ] **Step 3: Add to a test script + commit**

Add the file to an appropriate runner (or `test:server`'s list / a new `test:rollback` script).
```bash
git add tests/cross-stack-rollback.node-test.mjs package.json
git commit -m "test(collab): GATE — cross-stack rollback byte-compare .SEC (#128)"
```

---

## Phase 10 — E2E + full CI under Node 22

### Task 10.1: Run the full E2E suite against the Hocuspocus server

**Files:** none (verification).

- [ ] **Step 1: Run the full editor + collab specs under chromium (CLAUDE.md rule #10)**

Run: `npx playwright test --project=chromium`
Expected: results compared to the #194 parallel-load flake baseline (NOT a clean run). Per the memory note, 9-15 baseline failures are expected under full parallel load; verify any NEW failure by isolated re-run (`git stash` + `--grep` under `--project=chromium`), not by the full-suite diff. `collab.spec.js:230` fails ~20% even isolated — not a regression.

- [ ] **Step 2: Distinguish regression from baseline flake**

For any failure not in the #194 baseline: re-run it isolated 3× under `--project=chromium`. If it fails at baseline too (stash the migration), it's a flake. Trust isolated runs over the full-suite diff.

- [ ] **Step 3: Verify undo invariants against a PRODUCTION build (CLAUDE.md rule #12)**

React.StrictMode double-invokes effects in dev + E2E, masking single-invoke production ordering bugs. Run `npm run build` + `npm run preview` and manually verify Ctrl+Z does not capture peer edits in a two-tab session (the production-ordering check for Gate A1's invariant). A passing E2E run is NOT evidence this holds.

### Task 10.2: Add the single-Yjs-instance CI assertion

**Files:**
- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1: Add a CI step asserting a single deduped Yjs copy (the version-pin gate)**

In the `unit-tests` job, after `npm ci`, add:
```yaml
      - name: Assert single Yjs instance (Hocuspocus peer-dep pin)
        run: node -e "const {execSync}=require('child_process'); const out=execSync('npm ls yjs --all',{encoding:'utf8'}); const n=(out.match(/yjs@/g)||[]).length; if (out.includes('deduped')===false && n>1) { console.error(out); process.exit(1);} console.log('single yjs OK');"
```
(Adjust the assertion to your `npm ls` output shape — the intent: fail CI if a second non-deduped `yjs` appears, so a future Hocuspocus bump dragging a skewed peer can't reintroduce a second copy.)

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: assert single Yjs instance to protect Hocuspocus peer-dep pin (#128)"
```

---

## Phase 11 — Docs (ADRs + CLAUDE.md)

### Task 11.1: New ADR + supersede/amend existing ones

**Files:**
- Create: `docs/adr/0018-collab-relay-hocuspocus.md`
- Modify: `docs/adr/0002-pin-y-websocket-v1.md` (mark superseded)
- Modify: `docs/adr/0014-collab-server-yjs-relay.md` (amend patterns)
- Modify: `docs/adr/0001-server-uses-commonjs.md` (note Hocuspocus .cjs build)
- Modify: `CLAUDE.md`

- [ ] **Step 1: Write the new ADR-0018**

Cover: the Hocuspocus architecture (bare `Hocuspocus` class mounted on our `http.createServer`, NOT the `Server` HTTP wrapper), the validate-AND-reject-non-canonical tenant keying chokepoint (runs in BOTH auth modes), `SecWriterDatabase` persistence (size-cap + roomHealth + per-key re-entrancy + `drain()`), the **client seed re-gated on `onSynced`** (option A — the create-room upload design was rejected: `/upload` 409s on a cold room, seeds v1 Y.Text, and `writeAclIfAbsent` is auth-only) plus its two re-seed defenses (the `seededRooms` per-room guard + `unloadImmediately: false` warm-doc) and why the reframed #17 is a reconnect/StrictMode re-seed, not concurrent-create, the load-ordering contract that makes the seed safe, the server-first flag-day deploy posture, the shutdown drain (`closeConnections` + `flushPendingStores` + `database.drain()` — there is no `destroy()` on the bare class), and the four gate results (record A1's actual remote origin + that it is not in `trackedOrigins`, the A2 ordering/load-once/warm-doc numbers + that the eviction guard is superseded, the measured shutdown-drain time + the N/block-count/latency basis, the rollback byte-compare result + that it asserted `instanceof Y.XmlFragment`).

Also record two explicit operational assumptions/limits surfaced by the fourth review:
  - **Single-instance assumption.** Hocuspocus holds each room's authoritative Y.Doc in ONE instance's memory. The whole load-once-from-memory + warm-doc seed safety, and the per-key store-chain guard, are correct ONLY on a single instance (Render free plan, `render.yaml` `plan: free`, no autoscaling). Moving to >1 instance REQUIRES `@hocuspocus/extension-redis` for cross-instance sync AND a distributed lock on the `.ydoc` write (the in-process re-entrancy guard does not protect against cross-instance write races). State this as a hard precondition — revisit before any autoscale.
  - **Revocation latency** = "until the socket drops" (per-connect only, issue #752) — not immediate.
  - **`debounce`** is set to 500ms against a default of 2000ms; record the Phase 5.2 serialize-cost measurement that justified the chosen value.

- [ ] **Step 2: Mark ADR-0002 superseded**

Add a header note: the y-websocket v1 pin's gating migration happened (#128); record how the eviction race is now handled (the client seed-on-empty is re-gated on Hocuspocus's `onSynced` and protected by the `seededRooms` guard + `unloadImmediately: false` warm-doc; the load-ordering contract proves an empty-at-synced observation is genuinely new — see ADR-0018).

- [ ] **Step 3: Amend ADR-0014**

Rewrite pattern #2 (eviction guard → client-seed-hardening + Hocuspocus lifecycle), update pattern #3 (broker in `onLoadDocument` + backup-ordering proof), note patterns #1 (`extractDocName`/`/ws/` status) and #4 (`GET /rooms` `setImmediate` — untouched) status.

- [ ] **Step 4: Amend ADR-0001**

Note Hocuspocus is required via its `.cjs` build with peer Yjs, preserving the single-instance guarantee (cite the Phase 1.1 step 3 + Phase 10.2 CI assertion).

- [ ] **Step 5: Update CLAUDE.md**

Update the "Collaboration Server" + "Collab Publish Path" sections to the Hocuspocus model (hook mapping, `SecWriterDatabase`, `onAuthenticate` keying, the client seed re-gated on `onSynced` + the `seededRooms` guard + `unloadImmediately: false` warm-doc + the single-instance assumption). Update the "Pinned PM versions" / dependency notes (add the three `@hocuspocus/*` pins + the single-Yjs CI assertion; note `ws` is now a runtime dep). Replace stale y-websocket-specific invariants (the eviction-guard re-install dance, `ywsDocs`) with their Hocuspocus equivalents; the client `handleSync` seed-on-empty STAYS but is documented under its new `onSynced`/guard/warm-doc form.

- [ ] **Step 6: Commit**

```bash
git add docs/adr/ CLAUDE.md
git commit -m "docs: ADR-0018 Hocuspocus relay; supersede ADR-0002, amend 0014/0001 (#128)"
```

---

## Phase 12 — Deploy runbook & cutover

Spec §Deploy. No code — produce the runbook and the pre-deploy checklist. This is a flag-day cutover of the live production data plane.

### Task 12.1: Write the cutover runbook

**Files:**
- Create: `docs/runbooks/2026-hocuspocus-cutover.md`

- [ ] **Step 1: Document the mandated deploy order + drain**

1. **Active drain BEFORE cutover** (not just "low traffic"): broadcast a "saving, reconnecting shortly" notice or flip rooms read-only via the existing lock mechanism; confirm all bound rooms flushed; confirm `/health` shows 0 active connections (or force-flush).
2. **Pre-deploy scan:** drain any room in `migrationPartial` state (or rely on the cross-stack test that the old broker no-ops a Hocuspocus-migrated room) — no room mid-migration across the cutover.
3. **Deploy `secwriter-collab` (server) FIRST.** Old `WebsocketProvider` clients fail to sync (locked out, recoverable) while the new server is authoritative. Client-first is the worst case (lockout + stranded unsynced edits).
4. **Confirm `/health` green on the new server BEFORE triggering the frontend deploy.**
5. **Deploy `secwriter-frontend` (HocuspocusProvider, Vite-inlined `VITE_COLLAB_WS_URL`).** Clients recover cleanly as it rolls.

- [ ] **Step 2: Document the HTTP-surface split-brain enumeration**

The HTTP surface is NOT version-gated (`POST /rooms/:id/upload`, `PATCH`, `DELETE`, `/sec`). `/upload` is unchanged by #128 (the create-room flow does NOT use it — that design was dropped); it remains the external-tooling re-upload path that requires a live bound Y.Doc (409s otherwise — [http-handler.cjs:238](../../../server/http-handler.cjs)). Confirm its windows-1252 decode + `seedRoomFromBlocks` + awaited `flushRoom` behave identically under the Hocuspocus server. Enumerate behavior during the cutover window; confirm no HTTP route accepts a body that bypasses the server's authoritative doc state. Note the client seed-on-empty STILL exists (option A) but is gated on `onSynced` (fires only after server state is applied) + the `seededRooms` guard, so a client that failed to WS-sync never reaches the seed path with stale local state — and an existing room never observes false-empty.

- [ ] **Step 3: Document rollback per the Gate (Phase 9) result**

If Phase 9 gate was GREEN: rollback = revert the merge commit, both services rebuild from the prior commit (verified clean). If RED: rollback requires manual `.ydoc` re-export — document the procedure.

- [ ] **Step 4: State SIGKILL honesty**

The shutdown drain (`closeConnections` + `flushPendingStores` + `database.drain()`) covers SIGTERM only. SIGKILL (un-flushed debounce on hard kill) is still data loss — same as today's `unref()`'d timer. State this honestly in the runbook.

- [ ] **Step 5: Commit**

```bash
git add docs/runbooks/2026-hocuspocus-cutover.md
git commit -m "docs: Hocuspocus flag-day cutover runbook (#128)"
```

---

## Self-review checklist (completed during authoring)

1. **Spec coverage:** §1 upgrade-handler seam → Task 1.3/3.2; §2 SecWriterDatabase → Phase 4; §3 onAuthenticate → Phase 3; §4 hook mapping → distributed across Phases 1/3/4/6/8; §5 seed → Phase 7 (CLIENT seed re-gated on `onSynced` + `seededRooms` guard + warm-doc — option A); §6 broker → Phase 6; §7 client → Phase 8 + Gate A1 (Phase 2); §8 shutdown → Phase 5; §9 Node bump → Phase 0; §Patterns → Phases 6/8/11; §Deploy → Phase 9 + 12; §Testing → embedded per phase; §Docs → Phase 11; §Gating items 1-4 → Phases 2/7/5/9 respectively. The "confirm readOnly is per-connection + threaded" gating sub-item → Task 3.1 (`readOnly` stays false for #128, context returned) + a FIRM `readOnly` write-frame-dropped #239-readiness test in Task 3.3 Step 3 (NOT "if headroom" — it is a spec MUST). Single-Yjs CI pin → Task 10.2.
2. **Placeholder scan:** no TBD/TODO; code blocks present for all code steps. The Hocuspocus API surface is CONFIRMED (Task 1.2, 2026-06-21 spike) — remaining "confirm against type defs" notes are narrow (the `connectionConfig.readOnly` write-gating field for #239; the `unloadImmediately`/unload-timeout field name for warm-doc; the `pmFragmentToHtml` reader path across the dual-package boundary), each naming the exact file to read. The broker entry is pinned (`createMigrationCoordinator(...).ensureMigrated` with a `backupRoom`-bearing storage stub).
3. **Type consistency:** `buildOnAuthenticate`/`AuthReject` (Task 3.1) reused in Task 3.2; the canonical-gate runs in BOTH auth modes (Task 3.1) and returns a consistent `{ user, tenant, roomId, acl }` context shape; `SecWriterDatabase({ storage, roomHealth, maxDocBytes, log })` constructor + `drain()` consistent across Task 4.1/4.2/5; the CLIENT seed (re-gated on `onSynced` + `seededRooms` guard, meta retained) is consistent across Task 7.1/7.2 (no `_serverMeta.newRoom` signal anywhere — removed; no App.jsx upload — dropped); the broker entry is `createMigrationCoordinator(...).ensureMigrated` (not a free `ensureMigrated`) consistently across Task 4.3/6.1/9.1; `useHocuspocus` flag consistent across Task 1.3/8.3; `new Hocuspocus(...)` (not `Server.configure`) consistent across Tasks 1.3/3.2/4.2/6.1.
4. **Ambiguity:** the §3 step-4 `room/1` rejection mechanism (caught by `rawRoom !== sanitize(rawRoom)`) is called out explicitly in Task 3.1 with a verifying test case. The cross-stack rollback gate (Phase 9) is stack-INDEPENDENT (it exercises the shared `serializeRoom`, imports no relay), so it has no ordering constraint against the y-websocket removal in Task 8.3 Step 4 — it can run any time. New server-level tests live in `hocuspocus-server.test.mjs` (not the near-cap `collab-server.test.mjs`).
5. **Post-review revision (2026-06-21):** this plan incorporates a verification spike (installed `@hocuspocus/*@4.3.0`, proved the synced/onLoadDocument ordering) and FOUR independent reviews (the fourth read the live Hocuspocus docs/source + checked the repo line by line). Key changes across drafts: (draft 2) the `_serverMeta.newRoom` signal removed; Gate A1 gains a positive control; the shutdown gate uses `flushPendingStores` + `drain()`; the `buildHocuspocus()` call moved after `httpServer` construction; the canonical gate runs under auth=none; new server tests avoid the test-cap breach; `ws` moves to runtime deps. (draft 3 → THIS draft, fourth review) the **server-authoritative seed was REVERSED back to a client seed re-gated on `onSynced`** because `/upload` 409s on a cold room, seeds v1 Y.Text, and `writeAclIfAbsent` is auth-only — the App.jsx upload work is dropped and the client `seededRooms` guard + `unloadImmediately: false` warm-doc are added; Gate A2 becomes load-ordering + load-once + warm-doc + a client re-seed-guard test; Gate A1's assertion is split into the trackedOrigins-membership property and the re-emit property (review M3); the broker test harnesses (Phase 4.3/9.1) use `createMigrationCoordinator` with a `backupRoom` stub (review M2, the free `ensureMigrated` import did not exist); `debounce` is flagged against its 2000ms default; revocation parity is stated as per-connect-only (#752); provider teardown/reconnect hazards (#803/#782/#566) are handled in Phase 8.2; the DirectConnection-only races (#832/#846) are noted as not-applicable; the single-instance/Redis assumption is recorded in ADR-0018.
