# Collab Tier 2: Room UX, Hardening, E2E Tests — Design Spec

**Date:** 2026-04-11
**Branch:** `multi-user`
**Status:** Design approved, pending implementation plan
**Scope:** Three workstreams — Room Management UX polish, Operational Hardening, and Comprehensive Collab E2E Tests.

---

## Context

SIM's multi-user collaboration is functional: Yjs CRDT editing, ConnectionBanner, RoomPanel (browse/create/delete), PresenceBar, RemoteCursors, IdentityModal, LoginGate, pluggable JWT auth, Azure Blob Storage backend. All 107 commits on `multi-user`, gated on `?room=` URL param (zero single-user regression).

**What's missing for production readiness:**
- Room Management UX: lock/unlock toggle, inline rename, active users in room list, room TTL/expiry
- Operational Hardening: rate limiting, health endpoint, multi-instance blob leases, structured logging
- Collab E2E Tests: zero coverage today — need comprehensive Playwright tests

---

## Section 1: Room Management UX

### 1a. Lock/Unlock Toggle

**Current state:** Server PATCH endpoint supports `locked`/`lockedBy` fields. RoomPanel displays a lock icon when `room.locked === true`. No UI to toggle the lock.

**Design:**
- Add a lock/unlock button to each room row in RoomPanel, next to the delete button.
- Click sends `PATCH /rooms/:roomId { locked: !current, lockedBy: identity.id }`.
- When a room is locked by another user, the editor enforces `collabReadOnly=true` — all contentEditable surfaces become non-editable, FloatingToolbar is suppressed, and a subtle "Locked by {name}" indicator appears below the toolbar (display name resolved from `lockedBy` ID via awareness states or a `lockedByName` field stored alongside).
- The lock owner can still edit (checked via `yMeta.lockedBy === currentUser.id`).
- Lock state is stored in `yMeta` (already implemented server-side) and propagated via Yjs CRDT sync to all connected clients.

**Files to modify:**
- `src/components/RoomPanel.jsx` — add lock toggle button
- `src/App.jsx` — read `yMeta.locked`/`yMeta.lockedBy`, derive `collabReadOnly`, pass to editing components
- `src/styles/editor.css` — "Locked by" indicator styles

### 1b. Inline Rename

**Current state:** Server PATCH endpoint supports `displayName` updates. No UI exists.

**Design:**
- Double-click the room name in RoomPanel to switch the `<span>` to an `<input>` (same pattern as the create form).
- On Enter or blur, send `PATCH /rooms/:roomId { displayName: newValue }`.
- On Escape, revert to the original name without sending a request.
- Sanitize input: trim whitespace, reject empty strings.
- The `displayName` field is stored in `yMeta` and synced to all clients.

**Files to modify:**
- `src/components/RoomPanel.jsx` — add inline edit state per room, double-click handler, input rendering

### 1c. Active Users in Room List

**Current state:** `GET /rooms` returns `activeUsers: []` for every room. The awareness data from live WebSocket connections is never read by the HTTP handler.

**Design:**
- In `collab-server.cjs`, expose a function `getActiveUsers(docName)` that reads awareness states from the y-websocket `docs` map. Each awareness state contains `{ id, name, color }` (set by the client in `collab.js`).
- Pass this function to the HTTP handler factory. The `GET /rooms` endpoint calls it for each room with a live doc, populating the `activeUsers` array.
- For rooms without a live doc (only on disk), `activeUsers` remains `[]`.
- RoomPanel already renders user avatars from this array — no client changes needed.

**Files to modify:**
- `server/collab-server.cjs` — add `getActiveUsers()`, pass to HTTP handler factory
- `server/http-handler.cjs` — call `getActiveUsers()` in GET /rooms handler

### 1d. Room TTL/Expiry

**Current state:** No lifecycle management. Rooms persist indefinitely.

**Design — two-stage lifecycle:**

**Archive stage:**
- Configurable via `SIM_ROOM_ARCHIVE_DAYS` (default: 30).
- A periodic sweep runs on server startup and every 24 hours thereafter.
- For each room on disk, check `lastModified` timestamp from the room's metadata. If older than the archive threshold, move the room's directory from `collab-db/{roomId}/` to `collab-db/archive/{roomId}/`.
- Archived rooms are excluded from `GET /rooms` by default.
- `GET /rooms?includeArchived=true` returns archived rooms with an `archived: true` flag.
- An archived room can be restored by joining it (`?room=archivedId`), which moves it back from archive to active.

**Delete stage:**
- Configurable via `SIM_ROOM_DELETE_DAYS` (default: 90, counted from archive date).
- Same periodic sweep checks archived rooms. If archived longer than the delete threshold, hard-delete the directory.
- A `archivedAt` timestamp file is written when a room is archived to track the archive date.

**Idle clock:** `lastModified` is already tracked per room (set on every persist). Any CRDT update resets it via the persist debounce path.

**Files to modify:**
- `server/collab-server.cjs` — add `sweepRooms()` function, schedule on startup + 24h interval
- `server/storage-local.cjs` — add `archiveRoom()`, `deleteArchivedRoom()`, `listArchivedRooms()`, `restoreRoom()` methods
- `server/storage-azure.cjs` — same interface additions (archive = move blobs to `archive/` prefix)

---

## Section 2: Operational Hardening

### 2a. Rate Limiting

**Deployment model:** Single-instance now, pluggable interface for future multi-instance (Redis).

**Design:**
- New module `server/rate-limiter.cjs` with a clean interface:
  ```
  createRateLimiter(options) → { checkLimit(key, bucket) → { allowed, retryAfter } }
  ```
- Default implementation: in-memory sliding window counters with automatic cleanup of expired entries every 60 seconds.
- Two layers:

**WebSocket rate limiting:**
- Per-IP limit on new connections: `SIM_RATE_LIMIT_WS_PER_MIN` (default: 10).
- Applied in `handleUpgrade` before the WebSocket handshake completes.
- Rejected connections get HTTP 429 with `Retry-After` header.

**HTTP rate limiting:**
- Per-IP limit on read endpoints (GET): `SIM_RATE_LIMIT_HTTP_READ_PER_MIN` (default: 60).
- Per-IP limit on write endpoints (POST/PATCH/DELETE): `SIM_RATE_LIMIT_HTTP_WRITE_PER_MIN` (default: 20).
- Applied as the first check in the HTTP handler, before auth.
- 429 response with `Retry-After` header and JSON error body.

**Pluggability:** The `createRateLimiter` factory accepts a `backend` option. Default is `'memory'`. A future `'redis'` backend would implement the same `checkLimit` interface with Redis INCR + EXPIRE.

**Files to create:**
- `server/rate-limiter.cjs` — rate limiter module

**Files to modify:**
- `server/collab-server.cjs` — apply WS rate limiting in `handleUpgrade`
- `server/http-handler.cjs` — apply HTTP rate limiting as first middleware check

### 2b. Health Endpoint

**Design:**
- `GET /health` returns JSON with server status:
  ```json
  {
    "status": "ok" | "degraded",
    "uptime": 3600,
    "rooms": { "active": 5, "connections": 12 },
    "unhealthyRooms": ["room-x"]
  }
  ```
- `status` is `"ok"` when no rooms have `persistFailures >= 3`, `"degraded"` otherwise.
- `unhealthyRooms` lists rooms from the existing `roomHealth` map with critical failures.
- HTTP status: 200 for `"ok"`, 503 for `"degraded"`.
- No auth required (health probes must work without tokens).
- Connection count is derived from y-websocket's `docs` map (sum of awareness states across all rooms).

**Files to modify:**
- `server/http-handler.cjs` — add `/health` route (before auth middleware check)

### 2c. Multi-Instance Blob Leases (Azure Only)

**Design:**
- Before writing a `.ydoc` snapshot to Azure, acquire a 30-second blob lease on the `.ydoc` blob.
- Write all artifacts (`.ydoc`, `.sec`, `.comments.json`) while holding the lease.
- Release the lease after successful write, or let it expire on failure.
- If lease acquisition fails (another instance holds it), retry 3 times with exponential backoff (1s, 2s, 4s).
- After 3 failures, log a warning and skip the persist cycle (the next debounce will retry).
- Local storage backend: no change (single process by definition).

**Files to modify:**
- `server/storage-azure.cjs` — add lease acquisition/release around `writeRoom()`

### 2d. Structured Logging

**Design:**
- New module `server/logger.cjs` — thin wrapper over `console.log`/`warn`/`error`.
- When `SIM_LOG_FORMAT=json` env var is set, outputs JSON lines:
  ```json
  {"ts":"2026-04-11T...","level":"info","event":"room.persist","roomId":"demo","ms":42}
  ```
- When unset or `SIM_LOG_FORMAT=text` (default), outputs the current plain-text format (no behavior change).
- Structured fields: `ts`, `level`, `event`, `roomId` (optional), `ip` (optional), `err` (optional).
- No external dependencies. Just a function `log(level, event, fields)`.
- Replace existing `console.log`/`console.warn`/`console.error` calls in `collab-server.cjs` and `http-handler.cjs` with `log()` calls.

**Files to create:**
- `server/logger.cjs`

**Files to modify:**
- `server/collab-server.cjs` — replace console calls with logger
- `server/http-handler.cjs` — replace console calls with logger

---

## Section 3: Collab E2E Tests

### 3a. Test Infrastructure

**Playwright config changes:**
- Add `collab-server.cjs` as a second `webServer` entry (port 1234). Playwright supports `webServer` as an array.
- Both servers must be running before tests start.

**Test helpers** (in `tests/e2e/collab-helpers.js`):
- `createRoom(name)` — POST to `/rooms` to create a room, returns room ID.
- `deleteRoom(name)` — DELETE to `/rooms/:id` for cleanup.
- `joinRoom(context, roomName)` — creates a new page, navigates to `/?room=<name>`, waits for ConnectionBanner to disappear (connection established).
- `waitForSync(page)` — waits for the "Syncing..." banner to disappear.
- `getBlockText(page, index)` — reads the text content of the nth editable block.

**Test isolation:** Each test creates a uniquely-named room (`test-${test.info().testId}`) and deletes it in `afterEach` via the HTTP API.

### 3b. Test Suite

New file: `tests/e2e/collab.spec.js` (~30-40 tests)

**Room CRUD (~6 tests):**
- Create room via RoomPanel and verify it appears in room list
- Join existing room and verify editor loads with room content
- Delete room and verify removal from list
- Room list shows correct displayName
- Rename room inline (double-click, type, Enter)
- Create room with duplicate name is handled gracefully

**Connection States (~5 tests):**
- "Connecting..." banner appears on initial load with `?room=`
- Banner disappears after successful sync
- "Disconnected" banner appears when server is stopped
- Editor becomes read-only when disconnected
- Reconnect recovery: restart server, verify editing resumes

**Presence (~4 tests):**
- PresenceBar shows second user's initials when they join
- RemoteCursors shows caret at second user's cursor position
- User leaves room, avatar disappears from PresenceBar
- Multiple users (3+) all visible in PresenceBar

**Two-Tab Editing (~6 tests):**
- User A types text, User B sees it appear
- User A creates a new block (Enter), block appears in User B's editor
- User A deletes a block, block disappears in User B's editor
- User A reorders a section (drag or cut/paste), User B sees new order
- Both users type in different blocks simultaneously, both edits persist
- Table cell edit in User A syncs to User B

**Track Changes Sync (~5 tests):**
- Enable TC in tab A, tab B sees TC toggle activate
- Edit in TC mode produces ADD/DEL marks visible to both users
- Accept revision in tab A, mark disappears in tab B
- Reject revision syncs across tabs
- TC snapshots stay consistent (no phantom marks after accept/reject)

**Comment Sync (~4 tests):**
- Create comment in tab A, highlight and thread appear in tab B
- Reply to comment in tab A, reply appears in tab B
- Resolve comment in tab A, status updates in tab B
- Delete comment syncs across tabs

**Auth Flow (~3 tests):**
- LoginGate shown when auth is required but no token present
- IdentityModal shown in stub mode for display name entry
- Session expiry banner appears when token expires

**Lock/Unlock (~3 tests):**
- Lock room in tab A, tab B becomes read-only with "Locked by" indicator
- Unlock room in tab A, tab B editing is restored
- Lock icon appears in room list for locked rooms

**Reconnect (~3 tests):**
- Kill collab server, banner appears, restart, editing resumes
- Edits made while disconnected do not sync (read-only prevents them)
- Reconnected client receives edits made by others during disconnect

### 3c. Test File Organization

Single file `tests/e2e/collab.spec.js` with `describe` blocks per area. If it exceeds ~3000 lines, split into `collab-rooms.spec.js`, `collab-editing.spec.js`, `collab-features.spec.js`.

**Files to create:**
- `tests/e2e/collab.spec.js`
- `tests/e2e/collab-helpers.js`

**Files to modify:**
- `playwright.config.js` — add second webServer entry

---

## File Map Summary

### Create
| File | Purpose |
|------|---------|
| `server/rate-limiter.cjs` | Pluggable rate limiting module |
| `server/logger.cjs` | Structured logging wrapper |
| `tests/e2e/collab.spec.js` | Comprehensive collab E2E tests |
| `tests/e2e/collab-helpers.js` | Shared test utilities |

### Modify
| File | Changes |
|------|---------|
| `src/components/RoomPanel.jsx` | Lock toggle, inline rename |
| `src/App.jsx` | `collabReadOnly` derivation from lock state |
| `src/styles/editor.css` | "Locked by" indicator styles |
| `server/collab-server.cjs` | `getActiveUsers()`, `sweepRooms()`, WS rate limiting, logger integration |
| `server/http-handler.cjs` | `/health` endpoint, HTTP rate limiting, active users in GET /rooms, logger integration |
| `server/storage-local.cjs` | `archiveRoom()`, `deleteArchivedRoom()`, `listArchivedRooms()`, `restoreRoom()` |
| `server/storage-azure.cjs` | Same archive interface + blob lease acquisition |
| `playwright.config.js` | Second webServer for collab server |

---

## Implementation Order

Recommended sequence (dependencies flow downward):

1. **Structured logging** (2d) — touch server files first so subsequent changes use the logger
2. **Active users in room list** (1c) — server plumbing needed by E2E presence tests
3. **Lock/unlock toggle** (1a) — depends on nothing, enables lock E2E tests
4. **Inline rename** (1b) — depends on nothing, enables rename E2E tests
5. **Rate limiting** (2a) — independent server module
6. **Health endpoint** (2b) — depends on rate limiter being wired (for connection counting)
7. **Room TTL/expiry** (1d) — most complex server feature, benefits from logger
8. **Multi-instance blob leases** (2c) — Azure-only, independent
9. **E2E test infrastructure** (3a) — Playwright config + helpers
10. **E2E test suite** (3b) — depends on all UI features being implemented

---

## Non-Goals

- Redis-backed rate limiting (future — interface is pluggable)
- Room-level authorization / ACLs (deferred per roadmap)
- Metrics export (Prometheus, StatsD) — structured JSON logging is sufficient for now
- Deployment configs (nginx/Caddy TLS termination) — separate workstream
