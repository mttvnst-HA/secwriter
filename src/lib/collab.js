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
 *   - html sync uses whole-text replacement (no per-character CRDT merge)
 *   - table/ref blocks sync as whole-value replacements (coarse)
 *   - no server-side .SEC persistence — Y.Doc on relay is in-memory CRDT;
 *     .SEC + sidecar .comments.json live on each user's local disk
 */

import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';

const DEFAULT_WS_URL = 'ws://127.0.0.1:1234';

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
const JSON_KEYS = ['table', 'ref']; // stored as JSON strings for prototype simplicity

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
  if (typeof block.html === 'string' && block.html.length > 0) {
    yText.insert(0, block.html);
  }
  yMap.set('html', yText);
  for (const k of JSON_KEYS) {
    if (block[k] !== undefined) yMap.set(k, JSON.stringify(block[k]));
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
  block.html = yText instanceof Y.Text ? yText.toString() : (yText || '');
  for (const k of JSON_KEYS) {
    const raw = yMap.get(k);
    if (raw !== undefined) {
      try { block[k] = typeof raw === 'string' ? JSON.parse(raw) : raw; }
      catch { /* ignore */ }
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
 * Snapshot data is stored as individual `snap:<blockId>` keys directly on
 * yTc (avoiding nested Y.Map identity issues that arise when two docs each
 * independently create their own nested Y.Map for the same key — after
 * merge only one nested Y.Map wins LWW, but both clients may have written
 * into their own, losing each other's writes). The nested 'snapshots' Y.Map
 * is kept in sync by publishTcToDoc for API consumers that inspect it
 * directly (e.g. tests checking `.size`).
 */
export function readTc(yTc) {
  const enabled = !!yTc.get('enabled');
  const snapshots = {};
  yTc.forEach((value, key) => {
    if (key.startsWith('snap:')) {
      snapshots[key.slice(5)] = value;
    }
  });
  return { enabled, snapshots };
}

/**
 * Apply a TC state update to yTc inside a 'local-tc' transaction.
 *
 * Snapshots are stored in two places:
 *   1. As `snap:<blockId>` prefixed keys directly on yTc — these are
 *      top-level keys in the shared-root Y.Map and merge per-key across
 *      clients without the nested-type identity problem.
 *   2. Mirrored into the nested 'snapshots' Y.Map (seeded at room creation)
 *      for API consumers that inspect its `.size` or individual entries.
 *      The nested map is written into (not replaced) so that after the first
 *      sync both clients share the same canonical nested Y.Map instance and
 *      their independent writes converge.
 */
export function publishTcToDoc(ydoc, yTc, { enabled, snapshots }) {
  ydoc.transact(() => {
    if (yTc.get('enabled') !== enabled) yTc.set('enabled', !!enabled);
    const next = snapshots && typeof snapshots === 'object' ? snapshots : {};
    const nextKeys = new Set(Object.keys(next));

    // ── Primary storage: prefixed keys on yTc ──────────────────────────
    // These keys merge per-key across concurrent clients (no nested-type
    // identity issue — yTc itself is the same shared root in all docs).
    for (const k of Array.from(yTc.keys())) {
      if (k.startsWith('snap:') && !nextKeys.has(k.slice(5))) yTc.delete(k);
    }
    for (const [blockId, v] of Object.entries(next)) {
      const key = `snap:${blockId}`;
      if (yTc.get(key) !== v) yTc.set(key, v);
    }

    // ── Mirror: nested 'snapshots' Y.Map for .size / direct access ─────
    // Write into (not replace) the existing nested map so that after the
    // first cross-doc sync both clients operate on the same map instance.
    let snapsMap = yTc.get('snapshots');
    if (!(snapsMap instanceof Y.Map)) {
      snapsMap = new Y.Map();
      yTc.set('snapshots', snapsMap);
    }
    for (const k of Array.from(snapsMap.keys())) {
      if (!nextKeys.has(k)) snapsMap.delete(k);
    }
    for (const [k, v] of Object.entries(next)) {
      if (snapsMap.get(k) !== v) snapsMap.set(k, v);
    }
  }, 'local-tc');
}

// Temporary shim — replaced by the full implementation in Task 3.
export function readComments(yComments) {
  const out = {};
  if (!yComments || typeof yComments.forEach !== 'function') return out;
  return out;
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
  for (const k of JSON_KEYS) {
    const cur = ymap.get(k);
    const nextEnc = block[k] !== undefined ? JSON.stringify(block[k]) : undefined;
    if (cur !== nextEnc) {
      if (nextEnc === undefined) ymap.delete(k);
      else ymap.set(k, nextEnc);
    }
  }
  const yText = ymap.get('html');
  const curText = yText instanceof Y.Text ? yText.toString() : '';
  const nextText = typeof block.html === 'string' ? block.html : '';
  if (curText !== nextText) {
    if (yText instanceof Y.Text) {
      yText.delete(0, yText.length);
      if (nextText.length > 0) yText.insert(0, nextText);
    } else {
      const t = new Y.Text();
      if (nextText.length > 0) t.insert(0, nextText);
      ymap.set('html', t);
    }
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
  }, 'apply');
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

  const provider = new WebsocketProvider(wsUrl, room, ydoc);
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
      // Seed yTc on first join if empty. Use a nested Y.Map for snapshots so
      // individual snapshot updates can happen without rewriting the whole
      // tc state. 'enabled' is intentionally NOT seeded here: seeding it
      // in two independent docs creates a Yjs Y.Map LWW conflict where the
      // doc with the higher clientID wins regardless of which client later
      // calls publishTcToDoc. Omitting 'enabled' from the seed means
      // publishTcToDoc is the sole writer, so its write always propagates.
      // readTc treats a missing 'enabled' key as false (disabled).
      // yComments is an empty Y.Map — no seeding needed; populated on
      // first comment create.
      if (yTc.size === 0) {
        ydoc.transact(() => {
          yTc.set('snapshots', new Y.Map());
        }, 'seed');
      }
      // Emit the current (possibly remote) state once to initialize React.
      onRemoteBlocks?.(yBlocksToArray(yOrder, yStore), { initial: true });
      onRemoteMeta?.(readYMeta(yMeta), { initial: true });
      onRemoteTc?.(readTc(yTc), { initial: true });
      onRemoteComments?.(readComments(yComments), { initial: true });
    }
    // Single source of truth for connection status (see onStatusChange
    // duplication fix — we only fire from the sync handler).
    onStatusChange?.(isSynced ? 'connected' : 'syncing');
  };

  provider.on('sync', handleSync);

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

    if (blocksChanged) {
      onRemoteBlocks?.(yBlocksToArray(yOrder, yStore), { initial: false });
    }
    if (metaChanged) {
      onRemoteMeta?.(readYMeta(yMeta), { initial: false });
    }
    if (tcChanged) {
      onRemoteTc?.(readTc(yTc), { initial: false });
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
      try { provider.destroy(); } catch { /* ignore */ }
      try { ydoc.destroy(); } catch { /* ignore */ }
    },
  };
}
