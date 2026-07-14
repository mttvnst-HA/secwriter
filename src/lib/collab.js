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
 *   yTc:       Y.Map                  { enabled: boolean }
 *                                     Room-wide Track Changes state. Post-1h
 *                                     (Q35/Q37) writes only `enabled`; per-
 *                                     keystroke marking is performed by
 *                                     PmEditableBlock's dispatchTransaction
 *                                     intercept, so the snapshot Y.Map is
 *                                     retired. Pre-1h rooms may still carry
 *                                     a 'snapshots' Y.Map written by older
 *                                     clients — readTc surfaces it for
 *                                     backward compat but post-1h clients
 *                                     leave it untouched. No schemaVersion
 *                                     bump in 1h; 1i bumps to 3 when
 *                                     legacy mode goes away.
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
 *   'local-publish'   — block structure + html changes (yOrder + yStore).
 *                       Carries both setBlockHtml writes AND structural
 *                       publishBlocks / applyBlocksToYDoc writes. Tracked
 *                       by the in-room and out-of-room UndoManagers.
 *   'local-reconcile' — mechanical substrate mirrors (setBlockHtmlSilent),
 *                       e.g. comment-status reclassify, orphan span unwrap.
 *                       NOT in either UndoManager's trackedOrigins — a
 *                       reconcile must never enter the user's undo stack.
 *   'local-meta'      — section metadata (yMeta)
 *   'local-tc'        — Track Changes enabled-flag updates (yTc)
 *   'local-comments'  — comment create/reply/status/delete (yComments)
 *   'seed'            — initial room seeding (not a local edit)
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
import { HocuspocusProvider } from '@hocuspocus/provider';
import { prosemirrorToYXmlFragment } from 'y-prosemirror';
import { applyHtmlToYText, htmlToAttrList, seedYTextFromHtml } from './ytext-html.js';
import { htmlToPmFragment } from './pmdoc-html.js';
import { getCachedHtml } from './pm-fragment-cache.js';
import { tableToYStructure, yStructureToTable, diffTableForPublish, applyTableCellEdits } from './ytable-crdt.js';
import { refToYStructure, yStructureToRef, applyRefEdits } from './yref-crdt.js';
import { makeUndoHelpers } from './undo-helpers.js';
import { createSubstrateUndoManager } from './substrate-protocol.js';
import { isReadableSlot } from './slot-shape.js';

// Collab server URLs — App.jsx imports DEFAULT_HTTP_URL from here.
// Port defaults must match server/collab-server.cjs (PORT / HTTP_PORT).
// For production behind a reverse proxy, set VITE_COLLAB_WS_URL and
// VITE_COLLAB_HTTP_URL at build time (e.g. wss://collab.example.com/ws).
const DEFAULT_WS_URL = import.meta.env?.VITE_COLLAB_WS_URL || 'ws://127.0.0.1:1234';
export const DEFAULT_HTTP_URL = import.meta.env?.VITE_COLLAB_HTTP_URL || 'http://127.0.0.1:1234';

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
 * Return the current URL with the `room` query param removed. Used by the
 * IdentityModal Cancel path to drop back into single-user (local) mode — on
 * the subsequent reload, getRoomFromUrl() returns null so inRoom is false and
 * the autosave restore-on-mount effect rehydrates the pre-Share document.
 * Accepts an optional explicit href so it can be unit-tested without touching
 * window.location.
 */
export function stripRoomFromUrl(href) {
  const base = href || (typeof window !== 'undefined' ? window.location.href : null);
  if (!base) return '/';
  const url = new URL(base);
  url.searchParams.delete('room');
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

// #17 / option A: a room is seeded at most once per browser session, keyed by
// canonical room id. Guards the reconnect/StrictMode re-seed window — a provider
// remount that observes the room empty (because the seed was evicted before its
// store flushed) must NOT seed a second time. Module scope persists across
// provider remounts within the session; a different room id is a different key,
// so entering a DIFFERENT room still seeds correctly.
const seededRooms = new Set();

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


/**
 * Build a Y.Map skeleton with scalars + empty html/table/ref slots. All
 * nested CRDT slots (Y.XmlFragment for html, Y.Map for table/ref) are
 * intentionally LEFT EMPTY — the caller must attach the yMap to its
 * parent (yStore) and then call `populateBlockHtml` for html and
 * `populateBlockTableRef` for table/ref. Doing the populate before
 * attachment works functionally but triggers a flood of "Invalid access:
 * Add Yjs type to a document before reading data." warnings whenever the
 * populate path needs to read the parent type's children (e.g.
 * y-prosemirror's `updateYFragment` calls `toArray` on the fragment;
 * `tableToYStructure` calls `[...yMap.keys()]` to clear existing keys).
 * Under CI's slower runners that flood overwhelms the Chromium →
 * Playwright IPC channel and the test page stops responding to keyboard
 * input — the symptom that took down the "two-tab text sync" test in
 * `collab.spec.js` on PR #51 (issue #77, fixed by PR #81 for html only; the
 * table/ref slots were missed and fixed for #83).
 */
export function blockToYMapSkeleton(block) {
  const yMap = new Y.Map();
  for (const k of SCALAR_KEYS) {
    if (block[k] !== undefined) yMap.set(k, block[k]);
  }
  yMap.set('html', new Y.XmlFragment());
  // Table/REF: empty nested CRDT slots. Populated AFTER yMap is attached
  // (see populateBlockTableRef + the CLAUDE.md "Nine non-obvious
  // invariants" sixth bullet for why the order is load-bearing).
  if (block.table) yMap.set('table', new Y.Map());
  if (block.ref) yMap.set('ref', new Y.Map());
  return yMap;
}

/**
 * Populate an attached Y.XmlFragment from a block.html string. Caller
 * MUST have already attached the parent yMap to yStore (so the fragment
 * is reachable from the doc). Calling on a detached fragment is the
 * warning-flood path documented above.
 */
export function populateBlockHtml(yXml, html) {
  const pmNode = htmlToPmFragment(typeof html === 'string' ? html : '');
  prosemirrorToYXmlFragment(pmNode, yXml);
}

/**
 * Populate the empty `table` / `ref` Y.Map slots created by
 * `blockToYMapSkeleton`. Caller MUST have already attached the parent
 * yMap to yStore — the inner `tableToYStructure` / `refToYStructure`
 * calls iterate the slot's keys, which fires the "Invalid access"
 * warning when the slot is detached (#83).
 */
export function populateBlockTableRef(yMap, block) {
  if (block.table) {
    const yTable = yMap.get('table');
    if (yTable && typeof yTable.get === 'function') {
      tableToYStructure(yTable, block.table);
    }
  }
  if (block.ref) {
    const yRef = yMap.get('ref');
    if (yRef && typeof yRef.get === 'function') {
      refToYStructure(yRef, block.ref);
    }
  }
}

/** Build a plain block object from a Y.Map. */
function yMapToBlock(yMap) {
  const block = {};
  for (const k of SCALAR_KEYS) {
    const v = yMap.get(k);
    if (v !== undefined) block[k] = v;
  }
  const yHtml = yMap.get('html');
  // Sub-PR 1d (#47, ADR-0006): the html slot can be either Y.XmlFragment
  // (post-broker-migration, post-1d) or Y.Text (legacy v1, or migrationPartial
  // leftover when per-block conversion threw during the broker run).
  // `getCachedHtml` branches on the same duck-type as the legacy inline code
  // (Y.XmlFragment → pmFragmentToHtml, Y.Text → yTextToHtml) so .SEC flush
  // still handles both shapes — without it, the serializer would coerce
  // String(yXmlFragment) into the export and produce "[object Object]" in
  // every migrated block (Q24/B3).
  //
  // #222: route through the SHARED per-slot cache (pm-fragment-cache.js, the
  // same WeakMap block-html-store reads). `yBlocksToArray` is called per
  // keystroke by handleAfterTx for ySyncPluginKey-origin transactions; the
  // cache makes every UNCHANGED block a hit, so a single keystroke re-derives
  // only the one mutated slot instead of all N (was 18.8 ms at 1200 blocks).
  if (isReadableSlot(yHtml)) {
    block.html = getCachedHtml(yHtml);
  } else {
    block.html = (typeof yHtml === 'string') ? yHtml : '';
  }
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
 *
 * `snapshots` is retained for backward compat with pre-1h schemas (Q37,
 * #47 sub-PR 1h). Pre-1h clients wrote a nested 'snapshots' Y.Map; 1h
 * clients ignore the field on read. The shape is preserved so a 1h client
 * inspecting a mixed-version room can still see whatever the pre-1h peers
 * wrote — useful for diagnostics. App-level applyRemote drops the field.
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
 * Apply a TC state update to yTc inside a 'local-tc' transaction.
 *
 * Q37 (#47 sub-PR 1h): writes ONLY the `enabled` flag. Any `snapshots`
 * field on the payload is ignored, and any pre-existing nested 'snapshots'
 * Y.Map (left over from a pre-1h client) is left untouched so the pre-1h
 * peer's data round-trips cleanly. Post-1h-only rooms never grow a
 * 'snapshots' key. No schemaVersion bump in 1h — pre-1h clients editing
 * post-1h rooms degrade in edit fidelity only; 1i bumps schemaVersion to
 * 3 when legacy goes away.
 */
export function publishTcToDoc(ydoc, yTc, { enabled }) {
  ydoc.transact(() => {
    if (yTc.get('enabled') !== enabled) yTc.set('enabled', !!enabled);
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
 * Snapshot `yLint` as a v1 lint-sidecar payload `{ v, good, bad }`. Each
 * entry in `yLint` is stored as `{ kind: 'good' }` (clean block) or
 * `{ kind: 'bad', g, n, c }` (per-tier finding arrays). Keys are block-html
 * fingerprints (24-char SHA-256 prefix from `lint-sidecar.fingerprintBlock`).
 *
 * The decoded payload feeds straight into `lint-sidecar.decodeSidecar` +
 * `projectDecoded`, so the in-room load path mirrors file-mode drag-drop.
 */
export function readLint(yLint) {
  const goodParts = [];
  const bad = {};
  if (!yLint || typeof yLint.forEach !== 'function') {
    return { v: 1, good: '', bad };
  }
  yLint.forEach((val, fp) => {
    if (!val || typeof val !== 'object') return;
    if (val.kind === 'good') {
      goodParts.push(fp);
    } else if (val.kind === 'bad') {
      bad[fp] = {
        g: Array.isArray(val.g) ? val.g : [],
        n: Array.isArray(val.n) ? val.n : [],
        c: Array.isArray(val.c) ? val.c : [],
      };
    }
  });
  return { v: 1, good: goodParts.join(''), bad };
}

/**
 * Publish a v1 lint-sidecar payload to `yLint`, writing only the diff against
 * the current Y.Map state. The diff is per-fingerprint:
 *   - new / changed-kind entries → set
 *   - missing entries (present in yLint, absent in payload) → delete
 *
 * Diffing keeps two peers linting different blocks from clobbering each
 * other (Y.Map is LWW per key — a per-key set is cheap; an unconditional
 * clear-and-replace would race). The 'local-lint' origin is not in either
 * UndoManager's trackedOrigins, so peer-driven cache updates stay off the
 * undo stack.
 *
 * GC (#214): pass `liveFingerprints` — a Set<fp> of every CURRENT live block's
 * html fingerprint (from `computeLiveFingerprints(blocks)`) — to prune dead
 * entries in the same transaction. An entry is dead when its fingerprint
 * matches no live block: `projectDecoded` only ever consults fingerprints of
 * current blocks, so a non-live fingerprint can never be hit again. Without
 * GC, every distinct content state a block passes through leaves a permanent
 * entry, and the persisted `.ydoc` trends toward the 8 MB flush cap → silent
 * persistence refusal. Pruning to the *shared* live set (not a single peer's
 * payload) is race-safe: a fingerprint absent from the live document is dead
 * for every peer. A cross-peer lag (a block whose html the pruning peer hasn't
 * synced yet) costs at most a benign cache miss — the engines re-run on load,
 * exactly as for any un-cached block — never edit loss. When `liveFingerprints`
 * is omitted (undefined), behavior is the legacy phase-1 set-only path.
 */
export function publishLintToDoc(ydoc, yLint, payload, liveFingerprints) {
  if (!payload || typeof payload !== 'object') return;
  if (payload.v !== 1) return;
  const goodStr = typeof payload.good === 'string' ? payload.good : '';
  const bad = payload.bad && typeof payload.bad === 'object' ? payload.bad : {};
  const FP_LEN = 24;

  // Walk the v1 payload into a flat target map keyed by fingerprint.
  const target = new Map();
  if (goodStr.length % FP_LEN === 0) {
    for (let i = 0; i < goodStr.length; i += FP_LEN) {
      target.set(goodStr.slice(i, i + FP_LEN), { kind: 'good' });
    }
  }
  for (const [fp, entry] of Object.entries(bad)) {
    if (typeof fp !== 'string' || fp.length !== FP_LEN) continue;
    if (!entry || typeof entry !== 'object') continue;
    target.set(fp, {
      kind: 'bad',
      g: Array.isArray(entry.g) ? entry.g : [],
      n: Array.isArray(entry.n) ? entry.n : [],
      c: Array.isArray(entry.c) ? entry.c : [],
    });
  }

  // GC: an entry survives iff its fingerprint is live — present in the shared
  // live-block set OR in this publish's own target (a just-linted block is
  // always live even if a stale `blocks` snapshot lagged it). Skip the prune
  // entirely when no live set is supplied (legacy set-only callers + direct
  // unit tests). `keep === null` means "never delete".
  const hasLiveSet = liveFingerprints instanceof Set;
  const keep = hasLiveSet ? new Set(liveFingerprints) : null;
  if (keep) for (const fp of target.keys()) keep.add(fp);

  ydoc.transact(() => {
    for (const [fp, next] of target) {
      const cur = yLint.get(fp);
      if (!lintEntryEqual(cur, next)) yLint.set(fp, next);
    }
    if (keep) {
      for (const fp of [...yLint.keys()]) {
        if (!keep.has(fp)) yLint.delete(fp);
      }
    }
  }, 'local-lint');
}

function lintEntryEqual(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.kind !== b.kind) return false;
  if (a.kind === 'good') return true;
  // 'bad': compare per-tier arrays by length + JSON.
  return (
    JSON.stringify(a.g) === JSON.stringify(b.g) &&
    JSON.stringify(a.n) === JSON.stringify(b.n) &&
    JSON.stringify(a.c) === JSON.stringify(b.c)
  );
}

/** Read yLintIgnored into a JS Map<ignoreKey, IgnoreEntry>. */
export function readLintIgnored(yLintIgnored) {
  const out = new Map();
  if (!yLintIgnored || typeof yLintIgnored.forEach !== 'function') return out;
  yLintIgnored.forEach((val, key) => {
    if (!val || typeof val !== 'object') return;
    out.set(key, val);
  });
  return out;
}

/**
 * Publish a Map<ignoreKey, IgnoreEntry> to yLintIgnored. Diffs against current
 * state — never deletes (set-only per never-delete tombstone discipline).
 * Origin 'local-lint-ignored' is caught by handleAfterTx's 'local-' prefix
 * filter and NOT in UndoManager.trackedOrigins (Ctrl+Z does not un-dismiss).
 */
export function publishLintIgnoredToDoc(ydoc, yLintIgnored, entries) {
  if (!(entries instanceof Map)) return;
  ydoc.transact(() => {
    for (const [key, next] of entries) {
      const cur = yLintIgnored.get(key);
      if (!ignoredEntryEqual(cur, next)) yLintIgnored.set(key, next);
    }
  }, 'local-lint-ignored');
}

function ignoredEntryEqual(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Read yLintMutedNlp into a Map<ruleId, MuteEntry>. */
export function readLintMutedNlp(yLintMutedNlp) {
  const out = new Map();
  if (!yLintMutedNlp || typeof yLintMutedNlp.forEach !== 'function') return out;
  yLintMutedNlp.forEach((val, key) => {
    if (!val || typeof val !== 'object') return;
    out.set(key, val);
  });
  return out;
}

/** Publish a Map<ruleId, MuteEntry> to yLintMutedNlp. Same semantics as ignored. */
export function publishLintMutedNlpToDoc(ydoc, yLintMutedNlp, entries) {
  if (!(entries instanceof Map)) return;
  ydoc.transact(() => {
    for (const [key, next] of entries) {
      const cur = yLintMutedNlp.get(key);
      if (!ignoredEntryEqual(cur, next)) yLintMutedNlp.set(key, next);
    }
  }, 'local-lint-muted-nlp');
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
      const yMap = blockToYMapSkeleton(b);
      yStore.set(b.id, yMap);
      yOrder.push([b.id]);
      // Populate AFTER attachment so prosemirrorToYXmlFragment + the
      // table/ref CRDT builders run on slots with a live `.doc` and don't
      // fire the "Invalid access" warning flood (#77, #83).
      populateBlockHtml(yMap.get('html'), b.html);
      populateBlockTableRef(yMap, b);
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
      // Legacy or new: create fresh CRDT structure.
      // ATTACH yTable to ymap BEFORE populating — tableToYStructure calls
      // `[...yMap.keys()]` to clear existing keys, and Yjs's createMapIterator
      // gates on `parent.doc` (warns when detached). Same skeleton-then-
      // populate invariant as the html slot. (#83, CLAUDE.md sixth bullet.)
      const yTable = new Y.Map();
      ymap.set('table', yTable);
      tableToYStructure(yTable, block.table);
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
      // ATTACH yRef BEFORE populating, mirroring the table branch above.
      const yRef = new Y.Map();
      ymap.set('ref', yRef);
      refToYStructure(yRef, block.ref);
    } else {
      const prevRef = yStructureToRef(curRefYMap);
      applyRefEdits(curRefYMap, prevRef, block.ref);
    }
  } else if (curRefYMap) {
    ymap.delete('ref');
  }

  // HTML lives in the per-block CRDT slot. Per-keystroke writes flow
  // through y-prosemirror's ySyncPlugin (ySyncPluginKey origin);
  // React-state-driven publishes (handleRevisionAction, search/replace,
  // MarkSuggestions, etc.) call setBlockHtml in addition to setBlocks.
  // This path skips html for any existing slot — re-applying a stale
  // React block.html would clobber typing in flight.
  //
  // Sub-PR 1d (#47, ADR-0006): the slot can be Y.XmlFragment (post-broker)
  // OR Y.Text (legacy / migrationPartial). Both shapes are valid; the
  // defensive fallback below ONLY fires when the slot is missing or an
  // unrecognized shape. Without the dual-shape detection, the fallback
  // would re-seed Y.XmlFragment slots as fresh Y.Text on every scalar/
  // structural publish, destroying the migrated substrate for every block
  // (the issue flagged in the PR #51 review, comment 4380149320).
  const yHtml = ymap.get('html');
  if (!isReadableSlot(yHtml)) {
    // Truly missing or malformed slot — defensive recovery. Use the v2
    // shape (Y.XmlFragment) so we don't drop the doc back to v1.
    //
    // ATTACH the fragment to the parent yMap BEFORE prosemirrorToYXmlFragment
    // populates it. y-prosemirror's diff-and-merge calls toArray() during
    // populate; on a detached fragment that fires the "Invalid access: Add
    // Yjs type to a document before reading data" warning (issue #77,
    // CLAUDE.md "Nine non-obvious invariants"). The other Y.XmlFragment
    // construction sites in this file (blockToYMapSkeleton + populateBlockHtml
    // in seedYBlocks/applyBlocksToYDoc) already enforce this order; this
    // defensive branch was missed when the original fix landed.
    const yXml = new Y.XmlFragment();
    ymap.set('html', yXml);
    const pmNode = htmlToPmFragment(typeof block.html === 'string' ? block.html : '');
    prosemirrorToYXmlFragment(pmNode, yXml);
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
        const yMap = blockToYMapSkeleton(block);
        yStore.set(block.id, yMap);
        // Populate AFTER attachment — see blockToYMapSkeleton for why.
        populateBlockHtml(yMap.get('html'), block.html);
        populateBlockTableRef(yMap, block);
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
  }, 'local-publish');
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
  wsPolyfill = undefined,  // optional WebSocket impl for Node unit tests (browser passes nothing)
  tenant = '_public',  // tenant half of the canonical documentName; '_public' under auth=none

  identity,
  initialBlocks,
  initialMeta,
  onRemoteBlocks,
  onRemoteMeta,
  onRemoteTc,
  onRemoteComments,
  onRemoteLint,
  onRemoteLintIgnored,
  onRemoteLintMutedNlp,
  onPresenceChange,
  onStatusChange,
  onAuthScope,  // #239: (scope:'readonly'|'read-write') => void — provider auth scope
}) {
  const ydoc = new Y.Doc();
  const yOrder = ydoc.getArray('order');
  const yStore = ydoc.getMap('store');
  const yMeta = ydoc.getMap('meta');
  const yTc = ydoc.getMap('tc');
  const yComments = ydoc.getMap('comments');
  // Issue #150: block-fingerprint-keyed lint cache. Empty Y.Map — populated
  // on first local lint publish. Not in UndoManager (cache, not user edits).
  const yLint = ydoc.getMap('lint');
  // Issue #140: persistent rule ignores + NLP mutes. Empty Y.Maps — populated
  // on first dismiss/mute action. Not in UndoManager (dismissals are not undoable).
  const yLintIgnored = ydoc.getMap('lintIgnored');
  const yLintMutedNlp = ydoc.getMap('lintMutedNlp');

  let currentToken = token;  // mutable — last known token (fallback for the token callback)

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
      // The empty-check becomes RELIABLE once the provider is HocuspocusProvider
      // (Phase 8): its onSynced fires only AFTER onLoadDocument's state is applied
      // (proven, Gate A2), so an empty observation is a genuinely-new room, not a
      // pre-sync timing artifact. The per-room guard additionally stops a
      // reconnect/StrictMode remount from re-seeding a room whose seed was evicted
      // before it flushed (server warm-doc, unloadImmediately:false, prevents the
      // loss; this guard prevents the doubling).
      const empty = yOrder.length === 0 && yStore.size === 0;
      if (empty && !seededRooms.has(room) && Array.isArray(initialBlocks) && initialBlocks.length > 0) {
        seededRooms.add(room);
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
      // Seeding 'enabled' in two independent docs creates a Yjs Y.Map LWW
      // conflict: after cross-doc sync, whichever doc has the higher random
      // clientID wins, regardless of which client called publishTcToDoc.
      // A seed of `enabled: false` could clobber a subsequent
      // `publishTc({ enabled: true })` from the other client.
      //
      // The fix: leave 'enabled' absent until publishTcToDoc first writes
      // it. readTc coerces an absent 'enabled' key to false via `!!`.
      //
      // Q37 (#47 sub-PR 1h): the legacy 'snapshots' Y.Map is no longer
      // written by post-1h clients. If a pre-1h peer populated it, it
      // survives untouched (publishTcToDoc never reads/writes the key).
      //
      // yComments is an empty Y.Map — no seeding needed; populated on
      // first comment create.
      // yLint (#150) is also empty until the first lint publish.
      // Emit the current (possibly remote) state once to initialize React.
      onRemoteBlocks?.(yBlocksToArray(yOrder, yStore), { initial: true });
      onRemoteMeta?.(readYMeta(yMeta), { initial: true });
      onRemoteTc?.(readTc(yTc), { initial: true });
      onRemoteComments?.(readComments(yComments), { initial: true });
      onRemoteLint?.(readLint(yLint), { initial: true });
      onRemoteLintIgnored?.(readLintIgnored(yLintIgnored), { initial: true });
      onRemoteLintMutedNlp?.(readLintMutedNlp(yLintMutedNlp), { initial: true });
    }
    // Single source of truth for the 'connected' status. handleSync is now
    // invoked ONLY via HocuspocusProvider's onSynced callback, which always
    // fires with state===true (the first server handshake completed), so this
    // tail always resolves to 'connected'. The connecting / syncing /
    // disconnected transitions come from handleStatus (onStatus) below.
    onStatusChange?.(isSynced ? 'connected' : 'syncing', { reconnectIn: 0 });
  };

  // Map HocuspocusProvider status events to SecWriter's four-state model.
  // HocuspocusProvider re-emits its websocket's 'status' with
  // { status: 'connecting'|'connected'|'disconnected' } (WebSocketStatus enum).
  // We deliberately map a raw 'connected' (WebSocket open, PRE-sync) to 'syncing'
  // and NEVER surface 'connected' here — onSynced (handleSync above) owns the
  // 'connected' transition, which fires only after the Yjs sync handshake.
  //
  // HocuspocusProvider does not expose a y-websocket-style unsuccessful-reconnect
  // counter (no wsUnsuccessfulReconnects / maxBackoffTime). Its websocket layer
  // owns the @lifeomic/attempt backoff internally and surfaces no public attempt
  // count, so the reconnect countdown drops to a generic 'reconnecting' state
  // (reconnectIn: 0).
  //
  // Token rotation is handled by the async token callback passed to the provider
  // (see construction below): HocuspocusProvider re-invokes getToken() inside
  // sendToken() on every WebSocket open (onOpen → sendToken → getToken,
  // hocuspocus-provider.cjs:826/772/832), so a fresh token is sent on every
  // reconnect. No provider.url mutation is needed (the token travels in an
  // AuthenticationMessage, not the URL).
  const handleStatus = ({ status }) => {
    if (status === 'connecting') {
      onStatusChange?.('connecting', { reconnectIn: 0 });
    } else if (status === 'connected') {
      // WebSocket open but Yjs sync not yet complete — surface as 'syncing'.
      // onSynced will transition to 'connected'.
      onStatusChange?.('syncing', { reconnectIn: 0 });
    } else if (status === 'disconnected') {
      onStatusChange?.('disconnected', { reconnectIn: 0 });
    }
  };

  // documentName on the wire is the canonical composite room id `<tenant>/<roomId>`
  // (no /ws/ prefix, no token in the URL). The server's onAuthenticate REJECTS any
  // non-canonical name (no slash → malformed) and keys its in-memory documents Map,
  // the SecWriterDatabase fetch/store, and the ACL read on this exact string — so a
  // bare room id would auth-fail AND mismatch the composite key the HTTP upload /
  // getActiveUsers routes look up. Callers pass a bare `room` (the URL `?room=` id,
  // sanitized free of slashes); we prefix the tenant here. Under auth=none that is
  // '_public'; auth=jwt must pass the token's tenant (future — the client has no
  // tenant plumbing yet). An already-composite `room` (a test passing
  // '<tenant>/<roomId>') passes through unchanged.
  const documentName = room.includes('/') ? room : `${tenant}/${room}`;
  // The token travels in an AuthenticationMessage, not the URL — so it never lands
  // in server access / reverse-proxy logs (the y-websocket v1 limitation that
  // forced the token-in-room-name hack is gone).
  //
  // token: an async callback when getTokenFn is supplied so HocuspocusProvider
  // re-fetches a fresh token on every reconnect (issue #566 — the provider
  // re-invokes getToken() per WebSocket open via sendToken()); falls back to the
  // last known currentToken if the callback yields nothing.
  const provider = new HocuspocusProvider({
    url: wsUrl,
    name: documentName,
    document: ydoc,
    token: getTokenFn
      ? (async () => {
          try {
            const fresh = await getTokenFn();
            if (fresh) currentToken = fresh;
          } catch { /* token refresh failed — fall back to last known token */ }
          return currentToken;
        })
      : currentToken,
    onSynced: () => handleSync(true),
    onStatus: ({ status }) => handleStatus({ status }),
    onAuthenticationFailed: () => onStatusChange?.('incompatible', { reconnectIn: 0 }),
    ...(wsPolyfill ? { WebSocketPolyfill: wsPolyfill } : {}),
  });
  const awareness = provider.awareness;

  // #239: HocuspocusProvider emits 'authenticated' with the server-assigned
  // scope after onAuthenticate resolves. A viewer role sets
  // data.connectionConfig.readOnly server-side → scope 'readonly'; editor/owner →
  // 'read-write'. Surface it so App can reflect a read-only editor for viewers
  // (the server already REJECTS a viewer's ops — this is the UX mirror, not
  // the enforcement). Fires on every (re)connect, so a mid-session role change
  // takes effect on reconnect. Guarded: only present on HocuspocusProvider.
  if (typeof provider.on === 'function') {
    provider.on('authenticated', (payload) => {
      const scope = payload && payload.scope ? payload.scope : provider.authorizedScope;
      onAuthScope?.(scope);
    });
  }

  // Publish our identity + empty cursor
  awareness.setLocalStateField('user', identity);
  awareness.setLocalStateField('cursor', null);

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
    const lintChanged = cpt.has(yLint) || ch.has(yLint);
    const lintIgnoredChanged = cpt.has(yLintIgnored) || ch.has(yLintIgnored);
    const lintMutedNlpChanged = cpt.has(yLintMutedNlp) || ch.has(yLintMutedNlp);

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
    if (lintChanged) {
      onRemoteLint?.(readLint(yLint), { initial: false });
    }
    if (lintIgnoredChanged) {
      onRemoteLintIgnored?.(readLintIgnored(yLintIgnored), { initial: false });
    }
    if (lintMutedNlpChanged) {
      onRemoteLintMutedNlp?.(readLintMutedNlp(yLintMutedNlp), { initial: false });
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
  // undoable. The tracked origins ('local-publish' + ySyncPluginKey),
  // captureTimeout, and captureTransaction filter all live in
  // `substrate-protocol.js` — the SAME factory builds the out-of-room manager
  // in `useLocalSubstrateUndoManager`, so the two can't drift into different
  // Ctrl+Z semantics. See that module for the origin rationale (why remote
  // ops enter neither stack, why addToHistory:false opts out).
  const undoManager = createSubstrateUndoManager([yOrder, yStore]);
  const { withUndoFrame, forceFrame } = makeUndoHelpers(ydoc, undoManager);

  return {
    ydoc,
    yOrder,
    yStore,
    yMeta,
    yTc,
    yComments,
    yLint,
    yLintIgnored,
    yLintMutedNlp,
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
    publishLint(payload, liveFingerprints) {
      // Issue #150: publish a v1 lint-sidecar payload to yLint. Diffs
      // against current state so two peers linting different blocks don't
      // clobber each other. Origin 'local-lint' is filtered by handleAfterTx
      // (startsWith 'local-') so the writer doesn't re-emit to itself.
      // Issue #214: `liveFingerprints` (Set<fp> of current live blocks) drives
      // GC of dead cache entries in the same transaction.
      publishLintToDoc(ydoc, yLint, payload, liveFingerprints);
    },
    publishLintIgnored(entries) {
      // Issue #140: publish a Map<ignoreKey, IgnoreEntry> to yLintIgnored.
      // Origin 'local-lint-ignored' is filtered by handleAfterTx so the
      // writer doesn't re-emit to itself. Dismissals are not undoable.
      publishLintIgnoredToDoc(ydoc, yLintIgnored, entries);
    },
    publishLintMutedNlp(entries) {
      // Issue #140: publish a Map<ruleId, MuteEntry> to yLintMutedNlp.
      // Origin 'local-lint-muted-nlp' is filtered by handleAfterTx so
      // the writer doesn't re-emit to itself.
      publishLintMutedNlpToDoc(ydoc, yLintMutedNlp, entries);
    },
    dispatchComment(envelope) {
      // Single entry point for the comments module's PublishEnvelope union.
      // Underlying *ToDoc functions are unchanged — they are still tested
      // directly by collab.test.js. This dispatcher is the only seam App.jsx
      // uses, so the four legacy session methods are gone.
      if (!envelope || typeof envelope !== 'object') return;
      switch (envelope.kind) {
        case 'create':
          publishCommentToDoc(ydoc, yComments, envelope.commentId, envelope.payload);
          return;
        case 'reply':
          publishCommentReplyToDoc(ydoc, yComments, envelope.commentId, envelope.reply);
          return;
        case 'status':
          publishCommentStatusToDoc(ydoc, yComments, envelope.commentId, envelope.status, envelope.meta);
          return;
        case 'delete':
          deleteCommentFromDoc(ydoc, yComments, envelope.commentId);
          return;
        default:
          return;
      }
    },
    setCursor(cursor) {
      awareness.setLocalStateField('cursor', cursor);
    },
    undo() { undoManager.undo(); },
    redo() { undoManager.redo(); },
    canUndo() { return undoManager.undoStack.length > 0; },
    canRedo() { return undoManager.redoStack.length > 0; },
    // 1h Q36 — undo helpers exposed on the session API. `forceFrame` is
    // wired through useCollabSession + PmEditableBlock into the
    // word-boundary-undo plugin, which calls it on every word-boundary
    // keydown. Commit B adds `ySyncPluginKey` to trackedOrigins, so
    // forceFrame splits typing bursts into per-word undo frames in
    // production (matching Word/Notion convention). `withUndoFrame`
    // wraps multi-write gestures (handleAcceptAll, handleRejectAll,
    // handleComplianceAcceptGroup) into a single frame. See
    // src/lib/undo-helpers.js for full semantics (including the
    // partial-write-on-exception contract).
    withUndoFrame,
    forceFrame,
    // 1i-b.2 — App's file-import handler calls this through useCollabSession
    // so Ctrl+Z cannot cross the file boundary into the previous file's
    // content. Y.UndoManager's clear() drops both stacks atomically.
    clearStack() {
      undoManager.clear();
    },
    destroy() {
      ydoc.off('afterTransaction', handleAfterTx);
      awareness.off('change', handleAwareness);
      // HocuspocusProvider's status/sync handlers are constructor callbacks,
      // not .on() subscriptions — provider.destroy() detaches them. destroy()
      // is a clean teardown with NO zombie reconnect (#803): it calls the
      // websocket layer's destroy() → disconnect() sets shouldConnect=false
      // BEFORE the socket close fires, and onClose only schedules a reconnect
      // when shouldConnect is still true (hocuspocus-provider.cjs:445/397/441).
      try { provider.destroy(); } catch { /* ignore */ }
      try { ydoc.destroy(); } catch { /* ignore */ }
    },
  };
}
