/**
 * Collaborative editing layer (prototype).
 *
 * Uses Yjs CRDT + y-websocket to sync the block array across clients in a
 * shared room. The Y.Doc is the source of truth when `inRoom` is true; the
 * React `blocks` state becomes a derived view.
 *
 * Data layout (one Y.Doc per room):
 *   yOrder:    Y.Array<string>        ordered block IDs (the document outline)
 *   yStore:    Y.Map<string, Y.Map>   block data, keyed by block ID
 *                                     each value Y.Map has { id, type, part,
 *                                     depth, section, level?, html: Y.Text,
 *                                     table?, ref?, revision? }
 *   yMeta:     Y.Map                  { sectionNumber, sectionTitle, date, fileName }
 *   yTc:       Y.Map                  { enabled: boolean,
 *                                       snapshots: Y.Map<blockId, string> }
 *                                     Room-wide Track Changes state. When
 *                                     `enabled` flips on, `snapshots` is
 *                                     populated with the plaintext of every
 *                                     block at that moment (the baseline
 *                                     everyone diffs against). Flipping off
 *                                     clears `snapshots` in the same
 *                                     transaction.
 *   yComments: Y.Map<id, Y.Map>       Shared comment metadata. Each comment
 *                                     Y.Map has { blockId, status,
 *                                     highlightText, createdAt, authorId,
 *                                     authorName, authorColor,
 *                                     entries: Y.Array<Y.Map> } where each
 *                                     entry is { id, type, authorId,
 *                                     authorName, authorColor, text, ts }.
 *                                     Using Y.Array for entries lets
 *                                     concurrent replies from different
 *                                     clients merge without loss.
 *   awareness: { user: {id,name,color}, cursor: {blockId, index} }
 *
 * Transaction origins used by this module (all must begin with 'local-' so
 * handleAfterTx's prefix filter suppresses local echo):
 *   'local-publish'   — block structure + html changes (yOrder + yStore)
 *   'local-meta'      — section metadata (yMeta)
 *   'local-tc'        — Track Changes toggle + snapshot updates (yTc)
 *   'local-comments'  — comment create/reply/status/delete (yComments)
 *   'seed'            — initial room seeding (not a local edit)
 *   'local-apply'     — internal: applyBlocksToYDoc inner transaction (always
 *                        nested inside 'local-publish'; outer origin wins)
 *
 * Why split ordering from storage:
 *   Yjs shared types (Y.Map/Y.Text) cannot be moved between positions in a
 *   Y.Array — a "move" requires delete+reinsert, which creates a fresh
 *   instance and DESTROYS any concurrent edits another client is making to
 *   the original Y.Text. See the "CRDT identity invariant" note in
 *   CLAUDE.md. By storing blocks in a keyed Y.Map and keeping only string
 *   IDs in the ordering Y.Array, reorders become cheap (reorder strings)
 *   and Y.Text identity is preserved across any structural change —
 *   insert, delete, or reorder.
 *
 * Prototype limitations (see CLAUDE.md roadmap):
 *   - Server persists .ydoc + .SEC + .comments.json to disk (or Azure Blob Storage)
 *     via debounced flush. See server/collab-server.cjs.
 */

import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { applyHtmlToYText, yTextToHtml, htmlToAttrList, seedYTextFromHtml } from './ytext-html.js';
import { tableToYStructure, yStructureToTable, diffTableForPublish, applyTableCellEdits } from './ytable-crdt.js';
import { refToYStructure, yStructureToRef, applyRefEdits } from './yref-crdt.js';

// Collab server URLs — App.jsx imports DEFAULT_HTTP_URL from here.
// Port defaults must match server/collab-server.cjs (PORT / HTTP_PORT).
// For production behind a reverse proxy, set VITE_COLLAB_WS_URL and
// VITE_COLLAB_HTTP_URL at build time (e.g. wss://collab.example.com/ws).
const DEFAULT_WS_URL = import.meta.env?.VITE_COLLAB_WS_URL || 'ws://127.0.0.1:1234';
export const DEFAULT_HTTP_URL = import.meta.env?.VITE_COLLAB_HTTP_URL || 'http://127.0.0.1:1235';

/**
 * Read `?room=...` from the current URL. Returns null if not in a room.
 */
export function getRoomFromUrl() {
  if (typeof window === 'undefined') return null;
  try {
    const params = new URLSearchParams(window.location.search);
    const room = params.get('room');
    if (!room) return null;
    // Mirror server-side sanitization.
    return room.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64) || null;
  } catch {
    return null;
  }
}

/**
 * Build a shareable URL for a given room ID.
 */
export function buildRoomUrl(roomId) {
  if (typeof window === 'undefined') return `?room=${roomId}`;
  const url = new URL(window.location.href);
  url.searchParams.set('room', roomId);
  return url.toString();
}

/**
 * Generate a short random room ID.
 *
 * Note: the room ID is NOT a secret. Anyone who can guess an 8-char
 * base-36 ID can join the room with full read/write. Auth + TLS is a
 * roadmap item — see CLAUDE.md "Multi-user collaboration (prototype)".
 */
export function generateRoomId() {
  const bytes = new Uint8Array(6);
  (globalThis.crypto || window.crypto).getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(36).padStart(2, '0')).join('').slice(0, 8);
}

// ── Block ↔ Y.Doc conversion ────────────────────────────────────────────────
//
// Plain block:  { id, type, html: string, ... }
// Y block:      Y.Map where html is a Y.Text and all other scalars are plain

const SCALAR_KEYS = ['id', 'type', 'part', 'depth', 'section', 'level', 'revision'];
// Table/REF blocks now use nested CRDT structures (ytable-crdt.js / yref-crdt.js)
// instead of the former JSON_KEYS JSON-stringify approach.

// M7 — client-side doc size guard.
//
// The server persists each room as a Yjs state snapshot, capped at 8 MB
// (server/collab-server.cjs MAX_DOC_BYTES). Yjs wire overhead — item
// IDs, clocks, client IDs, CRDT metadata per inserted fragment — runs
// roughly 1.5–2× the plain text for a steady-state document, and higher
// for docs with lots of edit history.
//
// A naive 8 MB *plain-text* cap on the client would let a document pass
// the client check and then fail the server's 8 MB *snapshot* cap. We
// bake a 2× safety factor into the client guard so the effective client
// cap is 4 MB plain text — the client rejects *before* the server does,
// which is the only way to surface a useful error to the user.
//
// Publishes exceeding the cap are rejected with a thrown
// DocSizeLimitError; callers should catch and surface it.
const SERVER_SNAPSHOT_CAP_BYTES = 8 * 1024 * 1024;
const WIRE_OVERHEAD_FACTOR = 2;
export const MAX_PUBLISH_BYTES = Math.floor(SERVER_SNAPSHOT_CAP_BYTES / WIRE_OVERHEAD_FACTOR);

export class DocSizeLimitError extends Error {
  constructor(actualBytes, maxBytes) {
    super(`Document exceeds size limit: ${actualBytes} > ${maxBytes} bytes`);
    this.name = 'DocSizeLimitError';
    this.actualBytes = actualBytes;
    this.maxBytes = maxBytes;
  }
}

/**
 * Estimate the byte footprint of a block array. Uses UTF-8 byte counts of
 * id, type, html, and the serialized table/ref JSON — an overestimate vs
 * the Yjs wire format, which is fine: we want this guard to fire BEFORE
 * the server-side cap, not after.
 */
export function estimatePublishBytes(blocks) {
  if (!Array.isArray(blocks)) return 0;
  let total = 0;
  const enc = (s) => (typeof s === 'string' ? new TextEncoder().encode(s).length : 0);
  for (const b of blocks) {
    if (!b) continue;
    total += enc(b.id) + enc(b.type) + enc(b.html || '');
    if (b.table) total += enc(JSON.stringify(b.table));
    if (b.ref) total += enc(JSON.stringify(b.ref));
    // Rough per-block scalar overhead.
    total += 32;
  }
  return total;
}


/** Build a Y.Map from a plain block object. */
function blockToYMap(block) {
  const yMap = new Y.Map();
  for (const k of SCALAR_KEYS) {
    if (block[k] !== undefined) yMap.set(k, block[k]);
  }
  const yText = new Y.Text();
  seedYTextFromHtml(yText, block.html || '');
  yMap.set('html', yText);
  // Table/REF: nested CRDT structures
  if (block.table) {
    const yTable = new Y.Map();
    tableToYStructure(yTable, block.table);
    yMap.set('table', yTable);
  }
  if (block.ref) {
    const yRef = new Y.Map();
    refToYStructure(yRef, block.ref);
    yMap.set('ref', yRef);
  }
  return yMap;
}

/** Build a plain block object from a Y.Map. */
function yMapToBlock(yMap) {
  const block = {};
  for (const k of SCALAR_KEYS) {
    const v = yMap.get(k);
    if (v !== undefined) block[k] = v;
  }
  const yText = yMap.get('html');
  // Duck-type check instead of instanceof to handle CJS/ESM dual-package hazard.
  // Y.Text has toDelta(), plain strings don't.
  block.html = (yText && typeof yText.toDelta === 'function') ? yTextToHtml(yText) : (yText || '');
  // Table: nested CRDT or legacy JSON string
  const rawTable = yMap.get('table');
  if (rawTable) {
    if (typeof rawTable === 'string') {
      try { block.table = JSON.parse(rawTable); } catch { /* ignore */ }
    } else if (typeof rawTable.get === 'function') {
      block.table = yStructureToTable(rawTable);
    }
  }
  // REF: nested CRDT or legacy JSON string
  const rawRef = yMap.get('ref');
  if (rawRef) {
    if (typeof rawRef === 'string') {
      try { block.ref = JSON.parse(rawRef); } catch { /* ignore */ }
    } else if (typeof rawRef.get === 'function') {
      block.ref = yStructureToRef(rawRef);
    }
  }
  return block;
}

/** Snapshot a Y.Map<string, scalar> as a plain object. */
export function readYMeta(yMeta) {
  const out = {};
  yMeta.forEach((value, key) => { out[key] = value; });
  return out;
}

/**
 * Snapshot the yTc Y.Map as a plain `{ enabled, snapshots }` object.
 *
 * `enabled` is read directly from yTc; absent key coerces to false via `!!`.
 * Snapshot data lives in the nested 'snapshots' Y.Map keyed by block ID.
 */
export function readTc(yTc) {
  const enabled = !!yTc.get('enabled');
  const snapsMap = yTc.get('snapshots');
  const snapshots = {};
  if (snapsMap && typeof snapsMap.forEach === 'function') {
    snapsMap.forEach((value, key) => { snapshots[key] = value; });
  }
  return { enabled, snapshots };
}

/**
 * Apply a TC state update to yTc inside a 'local-tc' transaction. Writes
 * `enabled` and rewrites the `snapshots` Y.Map to match `snapshots` exactly
 * (deletes entries missing from the input). When enabled is false, callers
 * are expected to pass an empty snapshots object — this function does NOT
 * auto-clear snapshots, so the invariant lives in the caller.
 */
export function publishTcToDoc(ydoc, yTc, { enabled, snapshots }) {
  ydoc.transact(() => {
    if (yTc.get('enabled') !== enabled) yTc.set('enabled', !!enabled);
    let snapsMap = yTc.get('snapshots');
    if (!(snapsMap instanceof Y.Map)) {
      snapsMap = new Y.Map();
      yTc.set('snapshots', snapsMap);
    }
    const next = snapshots && typeof snapshots === 'object' ? snapshots : {};
    const nextKeys = new Set(Object.keys(next));
    for (const k of Array.from(snapsMap.keys())) {
      if (!nextKeys.has(k)) snapsMap.delete(k);
    }
    for (const [k, v] of Object.entries(next)) {
      if (snapsMap.get(k) !== v) snapsMap.set(k, v);
    }
  }, 'local-tc');
}

/**
 * Snapshot yComments as a plain object keyed by comment ID. Each comment
 * is a plain object with scalar fields + `entries: Array<plainEntry>`.
 *
 * The shape matches the React `comments` Map value used elsewhere in the
 * app, so callers can do `new Map(Object.entries(readComments(yComments)))`.
 */
export function readComments(yComments) {
  const out = {};
  if (!yComments || typeof yComments.forEach !== 'function') return out;
  yComments.forEach((cMap, id) => {
    if (!cMap || typeof cMap.get !== 'function') return;
    const entry = {
      id,
      blockId: cMap.get('blockId'),
      status: cMap.get('status') || 'open',
      highlightText: cMap.get('highlightText') || '',
      createdAt: cMap.get('createdAt') || 0,
      authorId: cMap.get('authorId') || '',
      authorName: cMap.get('authorName') || '',
      authorColor: cMap.get('authorColor') || '',
      entries: [],
    };
    const entries = cMap.get('entries');
    if (entries && typeof entries.forEach === 'function') {
      entries.forEach((eMap) => {
        if (!eMap || typeof eMap.get !== 'function') return;
        entry.entries.push({
          id: eMap.get('id') || '',
          type: eMap.get('type') || 'reply',
          authorId: eMap.get('authorId') || '',
          authorName: eMap.get('authorName') || '',
          authorColor: eMap.get('authorColor') || '',
          text: eMap.get('text') || '',
          ts: eMap.get('ts') || 0,
        });
      });
    }
    out[id] = entry;
  });
  return out;
}

/**
 * Build a Y.Map entry suitable for insertion into a comment's `entries`
 * Y.Array. Scalar fields only — no nested shared types, so replies merge
 * by position (Y.Array concurrent-insert semantics).
 */
// Collision-resistant entry id. Prefers crypto.randomUUID() when
// available (all modern browsers + Node 19+); falls back to a
// time-prefixed random suffix for exotic environments. Used when the
// caller doesn't supply an `id` on buildEntryYMap.
function generateEntryId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `e-${crypto.randomUUID()}`;
  }
  return `e-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function buildEntryYMap({ type, author, text, ts, id }) {
  const m = new Y.Map();
  m.set('id', id || generateEntryId());
  m.set('type', type);
  m.set('authorId', author?.id || '');
  m.set('authorName', author?.name || '');
  m.set('authorColor', author?.color || '');
  m.set('text', text || '');
  m.set('ts', typeof ts === 'number' ? ts : Date.now());
  return m;
}

/**
 * Create a new shared comment in yComments. `payload` is:
 *   { blockId, status, highlightText, createdAt, author, initialText }
 * The initial 'create' entry is added to the entries Y.Array in the same
 * transaction.
 */
export function publishCommentToDoc(ydoc, yComments, id, payload) {
  ydoc.transact(() => {
    const cMap = new Y.Map();
    cMap.set('blockId', payload.blockId);
    cMap.set('status', payload.status || 'open');
    cMap.set('highlightText', payload.highlightText || '');
    cMap.set('createdAt', payload.createdAt || Date.now());
    cMap.set('authorId', payload.author?.id || '');
    cMap.set('authorName', payload.author?.name || '');
    cMap.set('authorColor', payload.author?.color || '');
    const entries = new Y.Array();
    entries.push([buildEntryYMap({
      type: 'create',
      author: payload.author,
      text: payload.initialText || '',
      ts: payload.createdAt || Date.now(),
    })]);
    cMap.set('entries', entries);
    yComments.set(id, cMap);
  }, 'local-comments');
}

/**
 * Append a reply entry to an existing comment's entries Y.Array. No-op if
 * the comment does not exist (could happen if a concurrent delete beat us).
 */
export function publishCommentReplyToDoc(ydoc, yComments, id, { author, text, ts }) {
  ydoc.transact(() => {
    const cMap = yComments.get(id);
    if (!cMap) return;
    const entries = cMap.get('entries');
    if (!(entries instanceof Y.Array)) return;
    entries.push([buildEntryYMap({ type: 'reply', author, text, ts })]);
  }, 'local-comments');
}

/**
 * Change a comment's status ('open' | 'resolved') and append a status-event
 * entry to its entries Y.Array.
 */
export function publishCommentStatusToDoc(ydoc, yComments, id, status, { author, ts } = {}) {
  ydoc.transact(() => {
    const cMap = yComments.get(id);
    if (!cMap) return;
    cMap.set('status', status);
    const entries = cMap.get('entries');
    if (entries instanceof Y.Array) {
      entries.push([buildEntryYMap({
        type: status === 'resolved' ? 'resolve' : 'reopen',
        author,
        text: '',
        ts,
      })]);
    }
  }, 'local-comments');
}

/**
 * Remove a comment entirely. Local UI is responsible for stripping the
 * `mark-comment` span from the block HTML (that change flows through the
 * existing blocks → yStore pathway).
 */
export function deleteCommentFromDoc(ydoc, yComments, id) {
  ydoc.transact(() => {
    if (yComments.has(id)) yComments.delete(id);
  }, 'local-comments');
}

/**
 * Snapshot the current document state as a plain block array by walking
 * the ordering in `yOrder` and resolving each ID against `yStore`.
 */
export function yBlocksToArray(yOrder, yStore) {
  const out = [];
  for (let i = 0; i < yOrder.length; i++) {
    const id = yOrder.get(i);
    const ymap = yStore.get(id);
    if (ymap) out.push(yMapToBlock(ymap));
  }
  return out;
}

/**
 * Initial seed: push a plain block array into an empty room. Called when
 * a client opens a fresh (empty) room.
 */
export function seedYBlocks(ydoc, yOrder, yStore, blocks) {
  ydoc.transact(() => {
    // Clear anything that may be there (paranoid — callers gate on empty).
    yOrder.delete(0, yOrder.length);
    for (const id of Array.from(yStore.keys())) yStore.delete(id);
    for (const b of blocks) {
      yStore.set(b.id, blockToYMap(b));
      yOrder.push([b.id]);
    }
  }, 'seed');
}

/**
 * Update an existing Y.Map in place from a plain block object. Preserves
 * the Y.Text instance so CRDT identity / history / concurrent edits on
 * unchanged blocks are not disturbed.
 */
function updateYMapFromBlock(ymap, block) {
  for (const k of SCALAR_KEYS) {
    const cur = ymap.get(k);
    if (cur !== block[k]) {
      if (block[k] === undefined) ymap.delete(k);
      else ymap.set(k, block[k]);
    }
  }
  // Table CRDT update
  const curTableYMap = ymap.get('table');
  if (block.table) {
    if (!curTableYMap || typeof curTableYMap === 'string') {
      // Legacy or new: create fresh CRDT structure
      const yTable = new Y.Map();
      tableToYStructure(yTable, block.table);
      ymap.set('table', yTable);
    } else {
      // Existing CRDT structure: diff for cell-only vs structural
      const prevTable = yStructureToTable(curTableYMap);
      const diff = diffTableForPublish(prevTable, block.table);
      if (diff.type === 'structural') {
        tableToYStructure(curTableYMap, block.table);
      } else if (diff.changes.length > 0) {
        applyTableCellEdits(curTableYMap, diff.changes);
      }
    }
  } else if (curTableYMap) {
    ymap.delete('table');
  }

  // REF CRDT update
  const curRefYMap = ymap.get('ref');
  if (block.ref) {
    if (!curRefYMap || typeof curRefYMap === 'string') {
      const yRef = new Y.Map();
      refToYStructure(yRef, block.ref);
      ymap.set('ref', yRef);
    } else {
      const prevRef = yStructureToRef(curRefYMap);
      applyRefEdits(curRefYMap, prevRef, block.ref);
    }
  } else if (curRefYMap) {
    ymap.delete('ref');
  }

  const yText = ymap.get('html');
  // Duck-type check: see yMapToBlock comment above.
  if (yText && typeof yText.toDelta === 'function') {
    applyHtmlToYText(yText, typeof block.html === 'string' ? block.html : '');
  } else {
    const t = new Y.Text();
    seedYTextFromHtml(t, typeof block.html === 'string' ? block.html : '');
    ymap.set('html', t);
  }
}

/**
 * Apply a plain block array to the Y.Doc with an incremental diff that
 * PRESERVES Y.Map / Y.Text identity for every block that exists in both
 * the before and after state — including blocks that were reordered.
 *
 * Preserving identity is critical:
 *   - Remote clients editing an unchanged block must not lose their Y.Text
 *     edits when another client publishes a structural change.
 *   - Y.UndoManager's inverse of a structural change must not drag
 *     unrelated blocks with it. If structural updates replace every
 *     Y.Text, a later Ctrl+Z will recreate the OLD Y.Texts and orphan
 *     everything that was typed into the new ones. That's the bug that
 *     caused Alice's Ctrl+Z to wipe out Bob's subsequent edits.
 *
 * Algorithm:
 *   1. Compute the set of target IDs. Delete any ID present in yStore but
 *      not in the target (also removed from yOrder below). This tears
 *      down Y.Maps for genuinely deleted blocks only.
 *   2. For each target block in order, update its yStore entry in place
 *      (creating a new Y.Map only if the ID is brand new). Reorders and
 *      moves do NOT touch yStore.
 *   3. Reconcile yOrder against the target sequence with a minimal
 *      delete/insert diff on string IDs. Strings have no identity, so
 *      reorder churn in yOrder is harmless — no Y.Text is ever destroyed.
 */
export function applyBlocksToYDoc(ydoc, yOrder, yStore, blocks) {
  ydoc.transact(() => {
    const nextIds = blocks.map((b) => b.id);
    const nextIdSet = new Set(nextIds);

    // ─── Pass 1: remove Y.Maps for blocks that no longer exist ─────────
    for (const id of Array.from(yStore.keys())) {
      if (!nextIdSet.has(id)) yStore.delete(id);
    }

    // ─── Pass 2: in-place update or create Y.Map per target ────────────
    for (const block of blocks) {
      const existing = yStore.get(block.id);
      if (existing) {
        updateYMapFromBlock(existing, block);
      } else {
        yStore.set(block.id, blockToYMap(block));
      }
    }

    // ─── Pass 3: reconcile yOrder to match nextIds ─────────────────────
    // First drop any IDs from yOrder that aren't in the target.
    for (let i = yOrder.length - 1; i >= 0; i--) {
      if (!nextIdSet.has(yOrder.get(i))) yOrder.delete(i, 1);
    }
    // Then walk nextIds with a cursor into yOrder, deleting+inserting as
    // needed to realign. This only touches string IDs — no shared types
    // are created or destroyed, so Y.Text identity is fully preserved.
    let cursor = 0;
    for (const id of nextIds) {
      if (cursor < yOrder.length && yOrder.get(cursor) === id) {
        cursor++;
        continue;
      }
      // Is this ID already further down? If so, delete it from there.
      let foundAt = -1;
      for (let j = cursor + 1; j < yOrder.length; j++) {
        if (yOrder.get(j) === id) { foundAt = j; break; }
      }
      if (foundAt >= 0) {
        yOrder.delete(foundAt, 1);
      }
      yOrder.insert(cursor, [id]);
      cursor++;
    }
  }, 'local-apply');
}

/**
 * Create a CollabSession for a given room. Returns handles React code uses
 * to observe remote changes, publish local changes, and manage presence.
 *
 * Usage (inside App.jsx when inRoom === true):
 *   const session = createCollabSession({ room, identity, initialBlocks, onRemoteBlocks, onPresenceChange });
 *   // on local edit:
 *   session.publishBlocks(newBlocks)
 *   // on teardown:
 *   session.destroy()
 */
export function createCollabSession({
  room,
  wsUrl = DEFAULT_WS_URL,
  token = null,
  getTokenFn = null,  // async () => string|null — called on reconnect for fresh token
  identity,
  initialBlocks,
  initialMeta,
  onRemoteBlocks,
  onRemoteMeta,
  onRemoteTc,
  onRemoteComments,
  onPresenceChange,
  onStatusChange,
}) {
  const ydoc = new Y.Doc();
  const yOrder = ydoc.getArray('order');
  const yStore = ydoc.getMap('store');
  const yMeta = ydoc.getMap('meta');
  const yTc = ydoc.getMap('tc');
  const yComments = ydoc.getMap('comments');

  // y-websocket builds the URL as `${wsUrl}/${roomName}`.
  // Append token as query param by encoding it into the room name.
  // DEPLOYMENT NOTE: Tokens appear in server access logs and reverse proxy logs.
  // This is a y-websocket v1 limitation (no custom header support). Production
  // deployments behind reverse proxies must sanitize access logs to strip tokens.
  let currentToken = token;  // mutable — updated on reconnect via getTokenFn
  const effectiveRoom = currentToken ? `${room}?token=${encodeURIComponent(currentToken)}` : room;
  const provider = new WebsocketProvider(wsUrl, effectiveRoom, ydoc);
  const awareness = provider.awareness;

  // Publish our identity + empty cursor
  awareness.setLocalStateField('user', identity);
  awareness.setLocalStateField('cursor', null);

  let seeded = false;

  const handleSync = (isSynced) => {
    if (isSynced && !seeded) {
      seeded = true;
      // Only seed if the room is empty. Otherwise the existing remote
      // state wins.
      //
      // N5 — TOCTOU note: there is a technical window between the
      // `empty` check and the `seedYBlocks` transaction where a remote
      // sync-step-2 could arrive and populate the doc. In practice
      // y-websocket serializes sync messages on a single WebSocket
      // connection so this cannot interleave — the 'sync' event fires
      // only after the initial sync round-trip is complete. If a future
      // transport (e.g. WebTransport, multiple connections) breaks that
      // ordering assumption, move the empty check inside the transact
      // block and have seedYBlocks itself re-check before mutating.
      const empty = yOrder.length === 0 && yStore.size === 0;
      if (empty && Array.isArray(initialBlocks) && initialBlocks.length > 0) {
        seedYBlocks(ydoc, yOrder, yStore, initialBlocks);
      }
      // M3 — seed meta only if the room's yMeta is empty AND we have a
      // local initialMeta. The first client to join writes the initial
      // section number / title / date; subsequent joiners see what's
      // already there.
      if (yMeta.size === 0 && initialMeta && typeof initialMeta === 'object') {
        ydoc.transact(() => {
          for (const [k, v] of Object.entries(initialMeta)) {
            if (v !== undefined) yMeta.set(k, v);
          }
        }, 'seed');
      }
      // yTc requires NO seeding.
      //
      // Seeding 'enabled' OR 'snapshots' in two independent docs creates a
      // Yjs Y.Map LWW conflict: after cross-doc sync, whichever doc has the
      // higher random clientID wins each key, regardless of which client
      // actually called publishTcToDoc. This means:
      //   - A seed of `enabled: false` can clobber a subsequent
      //     `publishTc({ enabled: true })` from the other client.
      //   - A seed of `snapshots: new Y.Map()` creates two independent
      //     Y.Map instances for the same key; after merge only one wins
      //     LWW — any data written into the losing instance is silently
      //     discarded.
      //
      // The fix: leave BOTH keys absent until publishTcToDoc first writes
      // them. publishTcToDoc creates the 'snapshots' Y.Map if absent, making
      // it the sole creator of the instance — no LWW conflict is possible.
      // readTc coerces an absent 'enabled' key to false via `!!`.
      //
      // yComments is an empty Y.Map — no seeding needed; populated on
      // first comment create.
      // Emit the current (possibly remote) state once to initialize React.
      onRemoteBlocks?.(yBlocksToArray(yOrder, yStore), { initial: true });
      onRemoteMeta?.(readYMeta(yMeta), { initial: true });
      onRemoteTc?.(readTc(yTc), { initial: true });
      onRemoteComments?.(readComments(yComments), { initial: true });
    }
    // Single source of truth for connection status (see onStatusChange
    // duplication fix — we only fire from the sync handler).
    onStatusChange?.(isSynced ? 'connected' : 'syncing', { reconnectIn: 0 });
  };

  // Map y-websocket status events to SIM's four-state model.
  // y-websocket fires 'status' with { status: 'connecting'|'disconnected'|'connected' }
  // on WebSocket lifecycle events. We deliberately ignore 'connected' here because
  // it fires when the WebSocket opens (before Yjs sync completes); the 'sync'
  // handler above already transitions to 'connected'/'syncing' after the handshake.
  //
  // Reconnect delay mirrors y-websocket's actual formula:
  //   Math.pow(2, wsUnsuccessfulReconnects) * 100  (ms, capped at maxBackoffTime)
  const computeReconnectIn = () => {
    const attempts = provider.wsUnsuccessfulReconnects || 0;
    if (attempts === 0) return 0;
    const maxMs = provider.maxBackoffTime || 2500;
    return Math.ceil(Math.min(Math.pow(2, attempts) * 100, maxMs) / 1000);
  };

  const handleStatus = ({ status }) => {
    // Token refresh on reconnect. Note: this updates provider.url for the NEXT
    // reconnect attempt — the current attempt already opened a WebSocket with the
    // old URL. If the stale token is rejected, the server closes with 4401 and
    // y-websocket retries with the now-updated URL. One-attempt lag is acceptable.
    if (status === 'connecting' && getTokenFn) {
      getTokenFn().then(freshToken => {
        if (freshToken && freshToken !== currentToken) {
          currentToken = freshToken;
          provider.url = `${wsUrl}/${room}?token=${encodeURIComponent(freshToken)}`;
        }
      }).catch(() => { /* token refresh failed — reconnect with existing token */ });
    }
    if (status === 'connecting') {
      onStatusChange?.('connecting', { reconnectIn: computeReconnectIn() });
    } else if (status === 'disconnected') {
      onStatusChange?.('disconnected', { reconnectIn: computeReconnectIn() });
    }
  };

  provider.on('sync', handleSync);
  provider.on('status', handleStatus);

  // Observe ydoc-level afterTransaction so we get one notification per
  // transaction regardless of whether yOrder, yStore, or a nested Y.Text
  // was the thing that changed.
  const handleAfterTx = (transaction) => {
    // M-1: treat any origin beginning with 'local-' as a local transaction.
    // Any future publish path that introduces a new origin string MUST
    // prefix it with 'local-' (e.g. 'local-publish', 'local-meta',
    // 'local-autosave'). This guards against a nested `ydoc.transact(...,
    // 'outer')` accidentally dropping the inner local origin.
    const origin = transaction.origin;
    if (typeof origin === 'string' && origin.startsWith('local-')) return;
    if (origin === 'seed') return; // initial emit handled in handleSync
    // Only fire if yOrder / yStore / yMeta / a nested Y.Map or Y.Text
    // actually changed.
    if (transaction.changed.size === 0 && transaction.changedParentTypes.size === 0) return;

    // Detect whether this transaction touched blocks, meta, or both.
    //
    // `transaction.changedParentTypes` is a Map<AbstractType, YEvent[]>
    // populated with EVERY ancestor of every modified type, up to the
    // Y.Doc root. That makes it the authoritative signal for "did the
    // blocks subtree change" or "did the meta subtree change" — we
    // don't have to fall back to a "default-to-blocks" guess based on
    // the shape of `transaction.changed`.
    //
    // `transaction.changed` is used as a fallback so a mutation that
    // only touches a top-level shared type's key set (without affecting
    // any nested type's parent chain) still classifies correctly.
    const cpt = transaction.changedParentTypes;
    const ch = transaction.changed;
    const blocksChanged =
      cpt.has(yOrder) || cpt.has(yStore) || ch.has(yOrder) || ch.has(yStore);
    const metaChanged = cpt.has(yMeta) || ch.has(yMeta);
    const tcChanged = cpt.has(yTc) || ch.has(yTc);
    const commentsChanged = cpt.has(yComments) || ch.has(yComments);

    if (blocksChanged) {
      onRemoteBlocks?.(yBlocksToArray(yOrder, yStore), { initial: false });
    }
    if (metaChanged) {
      onRemoteMeta?.(readYMeta(yMeta), { initial: false });
    }
    if (tcChanged) {
      onRemoteTc?.(readTc(yTc), { initial: false });
    }
    if (commentsChanged) {
      onRemoteComments?.(readComments(yComments), { initial: false });
    }
  };
  ydoc.on('afterTransaction', handleAfterTx);

  // Awareness changes → presence bar
  const handleAwareness = () => {
    const states = [];
    awareness.getStates().forEach((state, clientId) => {
      if (state.user) states.push({ clientId, ...state });
    });
    onPresenceChange?.(states);
  };
  awareness.on('change', handleAwareness);

  // Undo manager scoped to our own edits. Track both yOrder and yStore so
  // structural changes (insert/delete/reorder) and field changes are both
  // undoable, and both are scoped to the local-publish origin so Ctrl+Z
  // never reverts a remote user's edits.
  const undoManager = new Y.UndoManager([yOrder, yStore], {
    trackedOrigins: new Set(['local-publish']),
  });

  return {
    ydoc,
    yOrder,
    yStore,
    yMeta,
    yTc,
    yComments,
    awareness,
    provider,
    undoManager,
    publishBlocks(blocks) {
      // M7 — guard against runaway publishes. Throw rather than silently
      // truncating so the caller can surface the error.
      const bytes = estimatePublishBytes(blocks);
      if (bytes > MAX_PUBLISH_BYTES) {
        throw new DocSizeLimitError(bytes, MAX_PUBLISH_BYTES);
      }
      ydoc.transact(() => {
        applyBlocksToYDoc(ydoc, yOrder, yStore, blocks);
      }, 'local-publish');
    },
    publishMeta(meta) {
      // M3 — publish section metadata changes (sectionNumber, sectionTitle,
      // date, fileName). Only writes keys whose value actually changed to
      // avoid noisy empty transactions.
      if (!meta || typeof meta !== 'object') return;
      ydoc.transact(() => {
        for (const [k, v] of Object.entries(meta)) {
          const cur = yMeta.get(k);
          if (v === undefined) {
            if (cur !== undefined) yMeta.delete(k);
          } else if (cur !== v) {
            yMeta.set(k, v);
          }
        }
      }, 'local-meta');
    },
    publishTc(tc) {
      // M-shared-tc — room-wide Track Changes state. `tc` is
      // { enabled: boolean, snapshots: { [blockId]: string } }. When
      // disabling, callers pass an empty snapshots object so the baseline
      // is cleared in the same transaction as the flag flip.
      publishTcToDoc(ydoc, yTc, tc);
    },
    publishComment(id, payload) {
      publishCommentToDoc(ydoc, yComments, id, payload);
    },
    publishCommentReply(id, reply) {
      publishCommentReplyToDoc(ydoc, yComments, id, reply);
    },
    publishCommentStatus(id, status, meta) {
      publishCommentStatusToDoc(ydoc, yComments, id, status, meta);
    },
    deleteComment(id) {
      deleteCommentFromDoc(ydoc, yComments, id);
    },
    setCursor(cursor) {
      awareness.setLocalStateField('cursor', cursor);
    },
    undo() { undoManager.undo(); },
    redo() { undoManager.redo(); },
    canUndo() { return undoManager.undoStack.length > 0; },
    canRedo() { return undoManager.redoStack.length > 0; },
    destroy() {
      ydoc.off('afterTransaction', handleAfterTx);
      awareness.off('change', handleAwareness);
      provider.off('sync', handleSync);
      provider.off('status', handleStatus);
      try { provider.destroy(); } catch { /* ignore */ }
      try { ydoc.destroy(); } catch { /* ignore */ }
    },
  };
}
