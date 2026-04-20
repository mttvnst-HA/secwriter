# Server-Owned Documents — Design

**Date:** 2026-04-11
**Branch:** `multi-user`
**Status:** Design draft, pending review
**Prerequisite:** Shared TC + Shared Comments (landed)

## Goal

Give the collab server authoritative ownership of `.SEC` files and `.comments.json` sidecars so that (1) work is never lost if no client happened to Ctrl+S, and (2) all clients share a single consistent document state — eliminating the sidecar-divergence problem flagged in the shared-TC-comments spec.

## Problems this solves

From `2026-04-09-shared-tc-comments-design.md` deployment implications:

1. **No server-side `.SEC` of record.** The relay stores a binary CRDT blob (`Y.encodeStateAsUpdate`). If the server restarts and nobody saved locally, the human-readable document is gone.
2. **Sidecar divergence.** Each client writes its own `.comments.json` on Ctrl+S. Two clients saving at different times produce different sidecars — reopening either single-user shows a different comment state.

## Design decisions

### D1: Server generates `.SEC` + sidecar on every persist

When the relay's debounced persistence fires (currently every 500ms after the last edit), the server:

1. Encodes the `Y.Doc` to its binary snapshot (existing behavior).
2. Materializes a `.SEC` file by reading `yOrder`, `yStore`, and `yMeta` from the `Y.Doc`, converting blocks to SEC XML.
3. Materializes a `.comments.json` by reading `yComments` from the same `Y.Doc`.
4. Writes all three artifacts atomically (temp files + rename) to Azure Blob Storage (or local disk for dev).

**Why server-side serialization:** The client already has `serializeSEC()` and comment export logic. Extracting that to run on Node.js (the relay is already Node) avoids duplicating the logic in a different language. The serializer is pure — it takes a blocks array and metadata object, returns a string. No DOM dependency.

**Why on every persist (not on-demand):** The `.SEC` file is the deliverable. It must always be current. If the server crashes between a Yjs persist and an on-demand export request, the `.SEC` is stale. Coupling the two writes eliminates that window.

### D2: Storage backend abstraction

A `StorageBackend` interface with two implementations:

- **`LocalStorageBackend`** — writes to `server/collab-db/` (existing directory). Used for local dev. Drop-in replacement for the current `writeSnapshotAtomic`.
- **`AzureBlobStorageBackend`** — writes to an Azure Blob Storage container. Used in production.

Both expose the same interface:

```
writeRoom(roomId, { ydocBytes, secXml, commentsJson }) → Promise<void>
readRoom(roomId) → Promise<{ ydocBytes, secXml?, commentsJson? } | null>
deleteRoom(roomId) → Promise<void>
listRooms() → Promise<string[]>
```

Selection via environment variable: `STORAGE_BACKEND=local|azure`. Azure backend reads `AZURE_STORAGE_CONNECTION_STRING` and `AZURE_STORAGE_CONTAINER` (defaults to `sim-rooms`).

**Why not S3 / GCS:** The user's deployment target is Azure. Adding multi-cloud support is YAGNI.

### D3: Room open/save HTTP endpoints

The relay server adds three HTTP endpoints alongside the existing WebSocket handler:

#### `GET /rooms/:roomId/sec`
Returns the latest `.SEC` file as `application/octet-stream` with `Content-Disposition: attachment; filename="<sectionNumber>.SEC"` and `Content-Type: application/xml; charset=windows-1252`.

**Use case:** Download the authoritative `.SEC` without joining the room via WebSocket.

#### `GET /rooms/:roomId/comments`
Returns the latest `.comments.json` as `application/json`.

**Use case:** Download comments alongside the `.SEC`.

#### `POST /rooms/:roomId/upload`
Accepts a `.SEC` file upload (`multipart/form-data`). Parses it into blocks + metadata using `parseSEC()`, seeds a new or existing room's `Y.Doc`, and persists.

**Use case:** Import a `.SEC` from disk into a collaborative room without opening the editor first.

**Guard:** Rejects files larger than `MAX_DOC_BYTES` (8 MB). Returns 413 if exceeded.

### D4: Client Ctrl+S behavior change (in-room)

Currently Ctrl+S in a room exports to the user's local disk via the File System Access API. With server-owned documents:

- **Ctrl+S** triggers a "save" indicator but does **not** prompt for a local file. The server already has the authoritative copy.
- **"Download .SEC"** button (new) explicitly downloads via `GET /rooms/:roomId/sec`. This replaces the current Ctrl+S-to-disk flow for users who want a local copy.
- **"Download Comments"** button (new) downloads via `GET /rooms/:roomId/comments`.
- **Single-user mode** (no `?room=` param) is **unchanged** — Ctrl+S still uses File System Access API to local disk.

### D5: Server-side serialization reuse

`sec-serializer.js` and `sec-parser.js` are pure ESM modules with no browser DOM dependency (they use string manipulation, not `document.createElement`). The collab server is CJS (required for y-websocket compatibility).

**Approach:** Dynamic `import()` of the ESM modules from the CJS server. Node.js supports this since v12. The server calls:

```js
const { serializeSEC } = await import('../src/lib/sec-serializer.js');
const { parseSEC } = await import('../src/lib/sec-parser.js');
```

**Browser dependency found:** Both `sec-serializer.js` (line 88) and `sec-parser.js` (line 241) use `DOMParser` for XML parsing. This is the only browser API they depend on. Solution: polyfill `globalThis.DOMParser` from `linkedom` (already a dev dependency, moved to production) at server startup — the same pattern used in the Vitest test setup (`src/lib/__tests__/setup.js`). No code changes needed in the serializer/parser themselves.

### D6: Comments extraction from Y.Doc

The server needs to read `yComments` and produce the same JSON format that the client writes. The `readComments()` function in `collab.js` already does this — it returns a plain object. The server will:

1. Call `readComments(yComments)` to get the comments object.
2. Wrap it as `{ version: 1, comments: Object.values(commentsObj) }` to match the existing sidecar format.

### D7: Blocks extraction from Y.Doc

The server needs to convert `yOrder` + `yStore` into a blocks array for `serializeSEC()`. The `yBlocksToArray()` function in `collab.js` already does this. The server calls:

```js
const blocks = yBlocksToArray(yOrder, yStore);
const meta = readYMeta(yMeta);
const secXml = serializeSEC(blocks, meta);
```

### D8: Encoding

`serializeSEC()` returns a UTF-8 string. The `.SEC` file format requires Windows-1252 encoding. The server applies `encodeWindows1252()` from `src/lib/encoding.js` before writing.

The HTTP endpoint returns the Windows-1252–encoded bytes with `Content-Type: application/xml; charset=windows-1252`.

### D9: Atomic multi-artifact writes

All three files (`.ydoc`, `.SEC`, `.comments.json`) must be written atomically — if any write fails, none should be committed. The current temp-file-then-rename pattern extends:

**Local backend:**
1. Write `<room>.ydoc.tmp`, `<room>.SEC.tmp`, `<room>.comments.json.tmp`.
2. Rename all three in sequence.
3. If any rename fails, delete all `.tmp` files and log the error.

**Azure backend:**
1. Write all three blobs.
2. Azure Blob Storage doesn't support multi-blob transactions natively. Mitigation: write the `.ydoc` blob last (it's the source of truth — the other two can be regenerated from it). If the `.SEC` or `.comments.json` write fails, a background repair job can regenerate them from the `.ydoc` blob.

### D10: Idle room cleanup

Rooms with no connected clients for longer than `IDLE_ROOM_TTL` (default: 7 days, configurable via env var) are eligible for cleanup. The server:

1. Marks the room as idle when the last client disconnects (timestamp in a `roomIdleTimers` Map).
2. A periodic sweep (every hour) checks idle timestamps and archives rooms past TTL.
3. "Archive" means: move the `.ydoc`, `.SEC`, and `.comments.json` to an `archived/` prefix (local) or a separate container (Azure). **Not deleted** — can be restored.

**Why archive, not delete:** Spec work has long dormant periods. An engineer might return to a room after weeks. Permanent deletion risks losing work.

## Data flow

### Edit → Persist (happy path)

```
Client A types → local Y.Doc update
  → y-websocket broadcasts to Client B + relay server
  → relay debounce timer resets (500ms)
  → timer fires:
      1. Y.encodeStateAsUpdate(ydoc) → ydocBytes
      2. yBlocksToArray(yOrder, yStore) → blocks
      3. readYMeta(yMeta) → meta
      4. serializeSEC(blocks, meta) → secXml (UTF-8)
      5. encodeWindows1252(secXml) → secBytes
      6. readComments(yComments) → commentsObj
      7. JSON.stringify({ version: 1, comments: [...] }) → commentsJson
      8. storageBackend.writeRoom(roomId, { ydocBytes, secBytes, commentsJson })
```

### Download (happy path)

```
User clicks "Download .SEC"
  → GET /rooms/:roomId/sec
  → storageBackend reads <room>.SEC (or regenerates from .ydoc if missing)
  → 200 OK with Content-Disposition: attachment
  → browser downloads file
```

### Upload / Import (happy path)

```
User uploads .SEC via POST /rooms/:roomId/upload
  → server reads multipart body
  → parseSEC(secContent) → { blocks, metadata }
  → seedYBlocks(ydoc, yOrder, yStore, blocks)
  → write yMeta from metadata
  → persist all artifacts
  → 200 OK
  → connected clients receive remote update via Y.Doc sync
```

## File changes

### New files
- `server/storage-local.js` — `LocalStorageBackend` implementation
- `server/storage-azure.js` — `AzureBlobStorageBackend` implementation (deferred until Azure deployment)
- `server/room-serializer.js` — server-side orchestrator: reads Y.Doc → calls serializer + encoder → calls storage backend

### Modified files
- `server/collab-server.cjs` — integrate `room-serializer.js` into the persist path; add HTTP endpoints; add idle cleanup timer
- `src/App.jsx` — in-room Ctrl+S behavior change; add "Download .SEC" / "Download Comments" buttons
- `src/lib/collab.js` — export `yBlocksToArray` and `readYMeta` and `readComments` (currently module-private)

### Unchanged files
- `src/lib/sec-serializer.js` — reused as-is (pure ESM, no changes)
- `src/lib/sec-parser.js` — reused as-is
- `src/lib/encoding.js` — reused as-is

## Verification plan

### Unit tests (Vitest or Node runner)

1. `room-serializer.js`: given a Y.Doc with known blocks/meta/comments, produces correct `.SEC` XML and `.comments.json`.
2. `storage-local.js`: writeRoom/readRoom/deleteRoom/listRooms round-trip with temp files.
3. Idle room cleanup: mock timers, verify archive after TTL.

### Integration tests

4. Full persist cycle: create Y.Doc → apply edits → trigger persist → verify `.ydoc` + `.SEC` + `.comments.json` all exist and are consistent.
5. HTTP endpoints: `GET /rooms/:roomId/sec` returns valid Windows-1252 `.SEC`; `POST /rooms/:roomId/upload` seeds room and connected clients see updates.
6. Atomic write failure: simulate write failure on one artifact → verify no partial state.

### Manual QA

7. Two-browser test: edit in browser A, verify browser B sees changes, then `GET /rooms/:roomId/sec` returns the latest content including B's edits.
8. Server restart: edit → wait for persist → restart relay → rejoin room → verify state survived.
9. Download .SEC: verify the downloaded file opens in legacy SIEditor.

## Non-goals (explicitly out of scope)

- **Auth / TLS / rate limiting** — orthogonal; tracked separately. The HTTP endpoints will need auth before production, but this spec focuses on the persistence model.
- **Conflict resolution UI for concurrent .SEC uploads** — POST /upload overwrites. First version is simple seed-or-replace.
- **Version history / undo at the document level** — the Yjs CRDT already tracks history internally. Exposing a "previous versions" UI is a separate feature.
- **Azure Blob Storage implementation** — `storage-azure.js` is designed but deferred. Local backend is sufficient for the prototype. The interface is locked down so the Azure implementation is a drop-in.
- **Multi-file project management** — this spec handles one room = one section. Project-level document management is a separate roadmap item.

## Migration

No migration needed. Existing `server/collab-db/<room>.ydoc` files continue to work. On first persist after the upgrade, the server generates `.SEC` and `.comments.json` alongside the existing `.ydoc` file. Rooms that were persisted before the upgrade simply gain the two new artifacts on next edit.

## Rollout

Land on the `multi-user` branch. Single-user behavior is unchanged — all new code paths are gated on server-side persistence triggers and in-room UI changes. The `multi-user` branch is not yet merged to `main`.
