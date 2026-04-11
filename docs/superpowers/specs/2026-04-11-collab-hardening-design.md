# Multi-User Collaboration Hardening — Design Spec

**Date:** 2026-04-11
**Status:** Design approved, pending implementation plan
**Scope:** Full design for 5 features; Phase 1 implementation covers features 1 + 2

## Overview

This spec covers the remaining work to make SIM's multi-user collaboration production-ready. The prototype (landed on `multi-user` branch) provides Yjs CRDT with room persistence, shared Track Changes, shared Comments, server-owned document generation, and HTTP download/upload. Six features remain (the original five roadmap items plus a Room Management Panel identified during design):

1. **Intra-block character-level CRDT merge** — replace whole-text replacement with per-character Y.Text operations
2. **Fine-grained table/REF sync** — replace JSON last-write-wins with nested CRDT structures
3. **Reconnect/offline UX** — connection status UI + read-only lock on disconnect
4. **Auth + TLS** — pluggable authentication interface with JWT provider
5. **Azure Blob Storage backend** — drop-in cloud storage for room persistence
6. **Room Management Panel** — sidebar UI for browsing, creating, and managing collab rooms

**Implementation order:** 1 → 2 → 3 → 6 → 4 → 5 (editing quality first, then UX, then infrastructure). Room panel (6) is sequenced before auth (4) because it provides the UI surface that auth protects.

**Phase 1 scope:** Features 1 + 2 (character-level CRDT + fine-grained table/REF). These are tightly coupled and together make concurrent editing actually usable.

---

## Feature 1: Character-Level CRDT Merge

### Problem

Currently, `collab.js` stores block HTML in `Y.Text` but uses whole-text replacement (`yText.delete(0, len)` + `yText.insert(0, newHtml)`) on every publish. This means concurrent edits to the same block are last-write-wins — the second user's edit overwrites the first.

### Approach: Y.Text with Formatting Attributes

Use Yjs's built-in formatting attribute system. Each character position in Y.Text carries key-value attributes that map to SIM's inline marks. The Y.Text stores **plain text only** — formatting is expressed as attribute ranges, not HTML tags.

This is the same pattern used by Quill + y-quill and ProseMirror + y-prosemirror. It's proven and handles concurrent formatting edits correctly.

### Y.Text Attribute Schema

| Attribute Key | Type | HTML Equivalent | SGML Tag |
|---|---|---|---|
| `bold` | `true` | `<b>` | `<BLD>` |
| `italic` | `true` | `<i>` / `<em>` | `<ITA>` |
| `underline` | `true` | `<u>` | `<UND>` |
| `mark` | `"rid"\|"srf"\|"sub"\|"eng"\|"met"\|"tai"\|"tst"\|"url"\|"att"\|"hls"` | `<span class="mark-XXX">` | `<RID>` etc. |
| `markOption` | `string` | `data-opt` on mark-tai | `<TAI OPT=...>` |
| `revision` | `"add"\|"del"\|"chg"` | `<ins class="mark-add">` / `<del>` / `<span class="mark-chg">` | `<ADD>/<DEL>/<CHG>` |
| `revisionAuthor` | `string` | `data-author-id` | — |
| `revisionAuthorColor` | `string` | `--author-color` CSS var | — |
| `comment` | `string` (comment ID) | `<span class="mark-comment" data-comment-id>` | stripped on export |
| `commentResolved` | `true` | `.mark-comment-resolved` | stripped on export |

Attributes are independent and stackable — a character can be simultaneously bold + mark-rid + inside a comment.

### New Module: `src/lib/ytext-html.js` (~350 lines)

Two core functions:

**`applyHtmlToYText(yText, newHtml)`** — Publish direction (local edit → CRDT)

1. Parse `newHtml` into a flat list of `{char, attrs}` tuples by walking DOM nodes and accumulating formatting context from parent elements
2. Read current Y.Text content + attributes into the same flat format
3. Run LCS diff on the plain-text characters
4. Emit minimal Y.Text operations: `delete(pos, len)`, `insert(pos, text, attrs)`, `format(pos, len, attrs)`
5. All operations happen inside the caller's `ydoc.transact()`

**`yTextToHtml(yText)`** — Receive direction (CRDT → local render)

1. Iterate Y.Text deltas (each delta: `{insert: string, attributes: {}}`)
2. Track active attribute state, emit open/close HTML tags on transitions
3. Output order for nested tags: revision → mark → format (outermost → innermost), matching SIM's existing nesting convention
4. Return an HTML string ready for `block.html`

**Edge cases:**

- Empty Y.Text → empty string (not `\u200B` — the zero-width space is injected by EditableBlock's ref callback, not stored)
- Tag labels (`<span class="tag-label">`) are not in Y.Text — they're injected/stripped by `syncTagLabels()`/`stripTagLabels()` at the DOM level
- `mark-comment` spans with no matching comment metadata → stripped (ghost-span recovery handles this separately)

**DOM environment:** `applyHtmlToYText` needs a DOM parser to walk the HTML. On the client this is the native `DOMParser`. On the server (CJS), this uses the linkedom polyfill already in `server/dom-polyfill.cjs`. `yTextToHtml` is pure string construction — no DOM needed.

### Integration Points

Changes to `collab.js` only — no changes to EditableBlock, FloatingToolbar, sec-parser, or sec-serializer:

- **`blockToYMap()`**: Replace `yText.insert(0, html)` with `applyHtmlToYText(yText, block.html)` to seed with attributes
- **`updateYMapFromBlock()`**: Replace `yText.delete(0, len)` + `yText.insert(0, nextText)` (whole-replacement) with `applyHtmlToYText(yText, nextHtml)` (minimal diff)
- **`yMapToBlock()`**: Replace `yText.toString()` with `yTextToHtml(yText)` to reconstruct HTML from attributes

### Conflict Resolution Semantics

- **Adjacent text edits:** Merge perfectly (Yjs character-level CRDT)
- **Overlapping text edits:** Both insertions preserved, positioned by Yjs ordering
- **Concurrent formatting:** Both applied (attributes are independent). User A bolds "foo" while user B marks it as RID → result is bold + RID.
- **Concurrent formatting removal:** Last operation wins per attribute (Yjs attribute semantics)

---

## Feature 2: Fine-Grained Table/REF Sync

### Problem

Table and REF blocks store their data as JSON-encoded strings in Y.Map (`JSON_KEYS` in collab.js). Any edit replaces the entire JSON string — concurrent edits to different cells in the same table are last-write-wins.

### Approach: Hybrid Granularity

Cell text edits use per-cell Y.Text CRDT (same attribute schema as Feature 1). Structural operations (add/delete column, merge/split cells) use whole-table replacement (LWW). This is the 80/20 approach — concurrent cell edits (common) merge perfectly; concurrent structural edits (rare) use LWW.

Row additions/deletions are fine-grained via Y.Array insert/delete.

### Table CRDT Model

```
Y.Map (per table block, key "table" in yStore)
├── columns: number (scalar, LWW)
├── colWidths: string (JSON-encoded array, LWW)
├── rowHeights: string (JSON-encoded array, LWW)
├── styles: string (JSON-encoded object, LWW)
└── rows: Y.Array
    ├── [0]: Y.Array (row 0)
    │   ├── [0]: Y.Map (cell)
    │   │   ├── text: Y.Text (with attributes — same schema as block html)
    │   │   ├── colspan: number (scalar)
    │   │   └── styleId: string (optional)
    │   ├── [1]: Y.Map (cell) ...
    ├── [1]: Y.Array (row 1) ...
```

### Operation Classification

| Operation | Granularity | Merge Strategy |
|---|---|---|
| Cell text edit | Per-cell Y.Text | Character CRDT (reuses `applyHtmlToYText`) |
| Cell colspan change | Per-cell scalar | LWW |
| Cell styleId change | Per-cell scalar | LWW |
| Add row | Y.Array insert | CRDT (position-based merge) |
| Delete row | Y.Array delete | CRDT |
| Add column | Structural | LWW (replace entire rows) |
| Delete column | Structural | LWW (replace entire rows) |
| Merge cells | Structural | LWW |
| Split cells | Structural | LWW |

**Why row ops are fine-grained but column ops are LWW:** Adding a row is a single Y.Array insert — it doesn't touch other rows. Adding a column requires modifying every row (appending a cell to each) — a cross-cutting structural change that's hard to auto-merge.

### Structural Operation Protocol

When a structural op occurs (add/delete column, merge, split):

1. App builds the new `TableData` object via `table-ops.js` (unchanged)
2. Publish detects structural change (row count changed, or any cell's colspan changed, or column count changed)
3. Replaces the entire `rows` Y.Array + `columns` scalar in one transaction
4. Y.Text instances are recreated for all cells (structural ops are rare)

When a cell-text-only edit occurs:

1. Publish walks existing Y.Array/Y.Map structure
2. Finds the target cell by row/cell index
3. Calls `applyHtmlToYText(cellYText, newCellHtml)` — only that cell's Y.Text is touched
4. All other cells' Y.Text instances preserved (concurrent edits on other cells merge)

### Change Detection

New helper `diffTableForPublish(prevTable, nextTable)`:

- If `columns`, row count, any colspan, or colWidths/rowHeights changed → structural (full replace)
- If only cell `text` values differ → cell-text-only (targeted Y.Text updates)
- Returns `{ type: 'structural', table }` or `{ type: 'cells', changes: [{row, cell, html}] }`

### REF CRDT Model

```
Y.Map (per ref block, key "ref" in yStore)
├── org: Y.Text (organization name — supports concurrent edits)
└── entries: Y.Array
    ├── [0]: Y.Map
    │   ├── rid: Y.Text (e.g., "ASTM C33")
    │   └── rtl: Y.Text (e.g., "Standard Specification for Concrete Aggregates")
    ├── [1]: Y.Map ...
```

**Merge semantics:**

- Concurrent org text edits → character CRDT merge
- Concurrent entry additions → both entries appear (Y.Array position merge)
- Concurrent edits to same entry's rid/rtl → character CRDT merge
- Concurrent entry deletion + edit → deletion wins (Yjs semantics)

### New Modules

**`src/lib/ytable-crdt.js` (~200 lines):**

- `tableToYStructure(yMap, tableData)` — Creates nested Y.Array/Y.Map/Y.Text from plain TableData
- `applyTableCellEdits(yMap, changes)` — Applies targeted cell text updates
- `yStructureToTable(yMap)` — Reads nested Yjs types → plain TableData

**`src/lib/yref-crdt.js` (~100 lines):**

- `refToYStructure(yMap, refData)` — Creates Y.Text + Y.Array structure from plain RefData
- `applyRefEdits(yMap, prevRef, nextRef)` — Diffs org text + entry list, applies targeted updates
- `yStructureToRef(yMap)` — Reads Yjs types → plain RefData

### Integration with `collab.js`

The `JSON_KEYS` approach is removed. Instead:

- `blockToYMap()`: For table blocks, calls `tableToYStructure()`. For ref blocks, calls `refToYStructure()`.
- `updateYMapFromBlock()`: Detects table/ref blocks. For tables, calls `diffTableForPublish()`. For refs, calls `applyRefEdits()`.
- `yMapToBlock()`: For table blocks, calls `yStructureToTable()`. For ref blocks, calls `yStructureToRef()`.

### Backward Compatibility

Existing rooms stored as JSON strings in `.ydoc` files:

- `yMapToBlock()` checks `typeof yMap.get('table')` — if string, parse as JSON (legacy). If Y.Map, use `yStructureToTable()`.
- On next publish, the legacy string is replaced with the new CRDT structure.
- One-time migration, transparent to the user.

---

## Feature 3: Reconnect/Offline UX

### Connection States

| State | Trigger | UI Behavior |
|---|---|---|
| `connected` | WebSocket open + initial sync complete | Normal editing, green status dot |
| `connecting` | WebSocket opening (first load or reconnect attempt) | Read-only, pulsing amber banner |
| `disconnected` | WebSocket closed unexpectedly | Read-only, red banner with retry countdown |
| `syncing` | WebSocket reconnected, Yjs sync in progress | Read-only, amber "Syncing..." banner |

Transition: `connected → disconnected → connecting → syncing → connected`

### Read-Only Lock

When state is anything other than `connected`:

1. React state flag `collabReadOnly: true`
2. All `contentEditable` blocks receive `contentEditable="false"`
3. FloatingToolbar, SlashMenu, and mutation handlers check the flag and no-op
4. Keyboard shortcuts that mutate (Enter, Tab, Backspace, paste) are suppressed
5. Non-mutating actions still work: scrolling, tree navigation, find (Ctrl+F), copy, sidebar search

On reconnect + sync complete → `collabReadOnly: false`, editing resumes.

### Banner Component: `src/components/ConnectionBanner.jsx` (~80 lines)

Fixed position bar at top of editor area (below toolbar, above blocks):

- **Connecting:** "Connecting to room..." with spinner
- **Disconnected:** "Connection lost — edits are paused. Reconnecting in {countdown}s..." with red left border
- **Syncing:** "Reconnected — syncing changes..." with amber left border
- **Connected:** Banner unmounts

Countdown mirrors y-websocket's exponential backoff (1s, 2s, 4s, 8s... capped at 30s). Read from `provider.wsUnsuccessfulReconnects` to compute interval.

### Integration

New callback in `createCollabSession()`:

```javascript
onConnectionChange: (state: 'connected'|'connecting'|'disconnected'|'syncing') => void
```

Listens to `provider.on('status')` and `provider.on('synced')`, maps to the four states.

In `App.jsx`:

- `const [connState, setConnState] = useState('connecting')`
- `const collabReadOnly = inRoom && connState !== 'connected'`
- Render `<ConnectionBanner state={connState} />` when `inRoom && connState !== 'connected'`

### Edge Cases

- **Mid-keystroke disconnect:** In-flight input event completes locally but `handleInput` skips publishing. On reconnect, Y.Text state (without the orphaned edit) overwrites local state. Acceptable for read-only-on-disconnect.
- **Disconnect during structural op:** Same — local state may diverge briefly, resync overwrites.
- **Rapid disconnect/reconnect cycles:** State machine handles cleanly. No debouncing needed — y-websocket already debounces reconnection.

---

## Feature 4: Auth + TLS

### Auth Interface

Pluggable provider contract:

```javascript
// server/auth/auth-provider.js
{
  validateToken(token: string): Promise<{ id, name, email, color? } | null>
  getLoginUrl(returnUrl: string): string | null
  extractToken(req: IncomingMessage): string | null
}
```

### Shipped Providers

**`auth-none.cjs`** — Current behavior. Returns stub identity. Zero config. For local development.

**`auth-jwt.cjs`** — Validates JWT tokens (HS256 shared secret or RS256 public key). Extracts `sub`, `name`, `email` from standard claims. Covers Azure AD / Entra ID, any OIDC provider, custom token servers.

Configuration via environment variables:

```
SIM_AUTH_JWT_SECRET=<shared-secret>       # for HS256
SIM_AUTH_JWT_PUBLIC_KEY=<path-to-pem>     # for RS256
SIM_AUTH_JWT_ISSUER=<expected-issuer>     # optional
SIM_AUTH_JWT_AUDIENCE=<expected-aud>      # optional
```

**Future (designed, not built):** `auth-cac.cjs` (client certificate / mutual TLS), `auth-apikey.cjs` (room-level passwords).

### WebSocket Auth

Token sent as URL query parameter on WebSocket upgrade:

```
ws://host:1234/room-name?token=<jwt>
```

Server wraps `setupWSConnection` with auth middleware:

```javascript
wss.on('connection', async (ws, req) => {
  const token = new URL(req.url, 'http://localhost').searchParams.get('token');
  const user = await authProvider.validateToken(token);
  if (!user) { ws.close(4401, 'Unauthorized'); return; }
  ws.user = user;
  setupWSConnection(ws, req, { docName: roomName });
});
```

### HTTP Auth

HTTP endpoints check `Authorization: Bearer <token>` header via same `authProvider.validateToken()`. Returns 401 on failure.

### Client-Side Flow

1. Check `sessionStorage['sim-auth-token']`
2. If missing + login URL configured → redirect
3. If missing + no login URL → stub identity (auth-none)
4. Token passed to `createCollabSession({ token })` → appended to WebSocket URL
5. Token included as `Authorization: Bearer` header on HTTP requests

The client does not implement OAuth flows — it expects a token from an external login page or SSO redirect.

### TLS

SIM does not terminate TLS. Handled by deployment layer (nginx, Caddy, Azure App Service). Server binds to `127.0.0.1` by default. `SIM_COLLAB_BIND=0.0.0.0` for non-loopback binding behind a proxy.

### Room Authorization (Future-Ready)

Auth validates identity but doesn't authorize room access. Any authenticated user can join any room. Interface designed so `authorizeRoom(user, roomId, action)` can be added later.

---

## Feature 5: Azure Blob Storage Backend

### Storage Interface

Already defined by `storage-local.cjs`:

```javascript
{
  readRoom(roomId): Promise<{ ydocBytes, secBytes, commentsJson }>
  writeRoom(roomId, { ydocBytes, secBytes, commentsJson }): Promise<void>
  deleteRoom(roomId): Promise<void>
  listRooms(): Promise<string[]>
  quarantineRoom(roomId, reason): Promise<void>
}
```

### `storage-azure.cjs`

Uses `@azure/storage-blob` SDK. Each room is a virtual directory in a single blob container:

```
Container: sim-collab-rooms/
├── demo/
│   ├── room.ydoc
│   ├── room.sec
│   └── room.comments.json
├── project-alpha/
│   └── ...
```

**Atomic writes:** Azure doesn't support multi-blob transactions. Strategy:

1. Write all three blobs with a generation tag (`meta.generation = timestamp`)
2. On read, verify all three share the same generation
3. If mismatched (crash during write), fall back to `.ydoc` as source of truth — re-derive `.sec` and `.comments.json`

**Configuration:**

```
SIM_STORAGE_BACKEND=azure              # "local" (default) or "azure"
SIM_AZURE_STORAGE_CONNECTION_STRING=   # or use managed identity
SIM_AZURE_STORAGE_CONTAINER=sim-collab-rooms
```

### Backend Selection

```javascript
const storage = process.env.SIM_STORAGE_BACKEND === 'azure'
  ? require('./storage-azure.cjs')({ /* azure config */ })
  : require('./storage-local.cjs')({ dataDir: './collab-db' });
```

All existing code references `storage.readRoom()` etc. — no changes beyond the selection line.

### Azure Considerations

- **Managed Identity:** Prefer `DefaultAzureCredential` over connection strings in Azure App Service.
- **Blob leases:** For multi-instance deployment, blob leases prevent concurrent writes. Single-instance sufficient for Phase 1.
- **Cost:** ~$0.02/GB/month. A large room (~750KB total) costs fractions of a cent.
- **Latency:** Blob reads add ~20-50ms vs. local filesystem. Acceptable — room loading happens once on first connect.

---

## Feature 6: Room Management Panel

### New Component: `src/components/RoomPanel.jsx` (~350 lines)

Right sidebar panel (same position as Compliance/Cross-Ref panels), toggled via toolbar button (Users icon). Only visible when collab server is reachable.

### Layout

**Header bar:** Title "Rooms", "+" create button, close (X) button.

**Room list:** Cards showing:

- Section number + title (from yMeta)
- Last edited timestamp
- Active user avatars (colored initials from awareness)
- Blue left border on currently joined room
- Click to join (updates URL to `?room=id`)
- Kebab menu → Rename, Lock, Delete

**Room actions (bottom):**

- Download .SEC / Download Comments buttons
- Upload .SEC button (seeds room from file)
- Room settings: rename, lock toggle

### Server Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET /rooms` | Exists — extend | Return room list with metadata (title, lastModified, activeUsers, locked, sizeBytes) |
| `POST /rooms` | New | Create a named room (empty or from .SEC upload) |
| `DELETE /rooms/:roomId` | New | Delete room and all artifacts |
| `PATCH /rooms/:roomId` | New | Update room settings (rename, lock) |

### `GET /rooms` Enhanced Response

```json
[
  {
    "id": "demo",
    "displayName": "31 00 00 EARTHWORK",
    "sectionNumber": "31 00 00",
    "lastModified": "2026-04-11T14:30:00Z",
    "activeUsers": [
      {"id": "u1", "name": "Matt V", "color": "#34d399"}
    ],
    "locked": false,
    "sizeBytes": 245000
  }
]
```

### Room Lock

Stored in yMeta: `locked: true`, `lockedBy: userId`. Clients check on join and set `collabReadOnly: true` if locked. Same read-only mechanism as disconnect UX.

### Collab Detection

Toolbar button only appears when collab server is reachable:

1. Ping `GET /rooms` at configured HTTP URL on app load
2. 200 → show Rooms button, enable collab
3. Network error → hide button, standalone single-user mode
4. Re-check on visibility change (tab focus) with 30s cooldown

Zero regression risk — no server means no collab UI.

---

## Implementation Phases

**Phase 1 (next implementation plan):** Features 1 + 2 — Character-level CRDT merge + fine-grained table/REF sync. Core editing quality. No infrastructure changes. New modules: `ytext-html.js`, `ytable-crdt.js`, `yref-crdt.js`. Changes to `collab.js`.

**Phase 2:** Feature 3 — Reconnect/offline UX. New component: `ConnectionBanner.jsx`. Small changes to `collab.js` and `App.jsx`.

**Phase 3:** Feature 6 — Room Management Panel. New component: `RoomPanel.jsx`. New server endpoints. Extends `http-handler.cjs`.

**Phase 4:** Feature 4 — Auth + TLS. New modules: `server/auth/auth-none.cjs`, `server/auth/auth-jwt.cjs`. Auth middleware wrapping WebSocket + HTTP. Client token management.

**Phase 5:** Feature 5 — Azure Blob Storage. New module: `server/storage-azure.cjs`. Drop-in backend swap. Requires Azure environment for testing.

---

## Testing Strategy

Each feature adds tests to the appropriate runner:

- **Features 1-2 (CRDT):** Vitest unit tests for `ytext-html.js`, `ytable-crdt.js`, `yref-crdt.js`. Extend `collab.test.js` with two-doc merge scenarios for attribute preservation, cell-level merge, ref entry merge.
- **Feature 3 (reconnect):** Vitest tests for state machine transitions. E2E test for banner appearance (Playwright — simulate WebSocket drop via network intercept).
- **Feature 4 (auth):** Node runner tests for JWT validation, token extraction, 401 rejection. Extend `http-endpoints.test.mjs`.
- **Feature 5 (Azure storage):** Node runner tests with mocked `@azure/storage-blob` SDK. Interface compatibility tests shared with `storage-local` tests.
- **Feature 6 (room panel):** E2E tests for room creation, joining, deletion. Extend server tests for new endpoints.
