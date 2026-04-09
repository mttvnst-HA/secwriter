/**
 * Collaborative editing layer (prototype).
 *
 * Uses Yjs CRDT + y-websocket to sync the block array across clients in a
 * shared room. The Y.Doc is the source of truth when `inRoom` is true; the
 * React `blocks` state becomes a derived view.
 *
 * Data layout (one Y.Doc per room):
 *   yBlocks: Y.Array<Y.Map>   each Y.Map has { id, type, part, depth,
 *                             section, level?, html: Y.Text, table?, ref?,
 *                             revision? }
 *   yMeta:   Y.Map            { sectionNumber, sectionTitle, date, fileName }
 *   awareness: { user: {id,name,color}, cursor: {blockId, index} }
 *
 * Prototype limitations (see CLAUDE.md roadmap):
 *   - html sync uses whole-text replacement (no per-character CRDT merge)
 *   - table/ref blocks sync as whole-value replacements (coarse)
 *   - no shared Track Changes or shared Comments yet
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

/** Snapshot the entire Y.Array<Y.Map> as a plain block array. */
export function yBlocksToArray(yBlocks) {
  const out = new Array(yBlocks.length);
  for (let i = 0; i < yBlocks.length; i++) {
    out[i] = yMapToBlock(yBlocks.get(i));
  }
  return out;
}

/**
 * Initial seed: push a plain block array into an empty Y.Array<Y.Map>.
 * Called when a client opens a fresh (empty) room.
 */
export function seedYBlocks(ydoc, yBlocks, blocks) {
  ydoc.transact(() => {
    yBlocks.delete(0, yBlocks.length);
    for (const b of blocks) yBlocks.push([blockToYMap(b)]);
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
 * PRESERVES Y.Map / Y.Text identity for blocks that exist in both states.
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
 * Algorithm (two passes):
 *   1. Delete any Y.Map whose ID is not in the next block array, walking
 *      from the end so indices stay valid.
 *   2. Walk the next blocks in order with a cursor into yBlocks. For each
 *      target block:
 *        a. If the cursor already points at the matching ID → update its
 *           fields in place, advance.
 *        b. Else, check if the target ID exists further down in yBlocks.
 *           If yes, that's a reorder: delete it from its current spot and
 *           insert a fresh Y.Map at the cursor position. (Y.Map instances
 *           can't be moved between positions in a Y.Array, so a move
 *           always means delete+insert.)
 *        c. Else this is a newly-created block → insert a fresh Y.Map at
 *           the cursor position.
 *
 * This guarantees that insert/delete operations only create the minimal
 * number of new Y.Map / Y.Text instances. Pure text edits to existing
 * blocks go through the in-place path in step 2a.
 */
export function applyBlocksToYDoc(ydoc, yBlocks, blocks) {
  ydoc.transact(() => {
    // ─── Pass 1: delete IDs that no longer exist ────────────────────────
    const nextIdSet = new Set();
    for (const b of blocks) nextIdSet.add(b.id);
    for (let i = yBlocks.length - 1; i >= 0; i--) {
      const id = yBlocks.get(i).get('id');
      if (!nextIdSet.has(id)) {
        yBlocks.delete(i, 1);
      }
    }

    // ─── Pass 2: walk `blocks` in order, inserting or updating ──────────
    let cursor = 0;
    for (let i = 0; i < blocks.length; i++) {
      const target = blocks[i];

      if (cursor < yBlocks.length && yBlocks.get(cursor).get('id') === target.id) {
        // In-place update — this is the hot path for text edits.
        updateYMapFromBlock(yBlocks.get(cursor), target);
        cursor++;
        continue;
      }

      // Does this ID exist further down in yBlocks? If so, it's a reorder.
      let foundAt = -1;
      for (let j = cursor + 1; j < yBlocks.length; j++) {
        if (yBlocks.get(j).get('id') === target.id) { foundAt = j; break; }
      }

      if (foundAt >= 0) {
        // Reorder: Y.Map instances can't be moved within a Y.Array, so we
        // delete the old position and insert a fresh Y.Map at the cursor.
        // This loses Y.Text history for moved blocks — acceptable for the
        // prototype, and drag-and-drop reorder is not a hot path.
        yBlocks.delete(foundAt, 1);
        yBlocks.insert(cursor, [blockToYMap(target)]);
        cursor++;
      } else {
        // Newly-created block (e.g. Enter key).
        yBlocks.insert(cursor, [blockToYMap(target)]);
        cursor++;
      }
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
  onRemoteBlocks,
  onPresenceChange,
  onStatusChange,
}) {
  const ydoc = new Y.Doc();
  const yBlocks = ydoc.getArray('blocks');
  const yMeta = ydoc.getMap('meta');

  const provider = new WebsocketProvider(wsUrl, room, ydoc);
  const awareness = provider.awareness;

  // Publish our identity + empty cursor
  awareness.setLocalStateField('user', identity);
  awareness.setLocalStateField('cursor', null);

  let suppressNext = false;
  let seeded = false;

  const handleSync = (isSynced) => {
    onStatusChange?.(isSynced ? 'connected' : 'syncing');
    if (isSynced && !seeded) {
      seeded = true;
      // Only seed if the room is empty. Otherwise the existing remote state wins.
      if (yBlocks.length === 0 && Array.isArray(initialBlocks) && initialBlocks.length > 0) {
        seedYBlocks(ydoc, yBlocks, initialBlocks);
      }
      // Emit the current (possibly remote) state once to initialize React.
      onRemoteBlocks?.(yBlocksToArray(yBlocks), { initial: true });
    }
  };

  provider.on('sync', handleSync);
  provider.on('status', (evt) => onStatusChange?.(evt.status));

  // Observe all deep changes to yBlocks and publish to React.
  const handleDeep = (events, transaction) => {
    // Don't echo our own local publishBlocks calls.
    if (transaction.origin === 'local-publish') return;
    onRemoteBlocks?.(yBlocksToArray(yBlocks), { initial: false });
  };
  yBlocks.observeDeep(handleDeep);

  // Awareness changes → presence bar
  const handleAwareness = () => {
    const states = [];
    awareness.getStates().forEach((state, clientId) => {
      if (state.user) states.push({ clientId, ...state });
    });
    onPresenceChange?.(states);
  };
  awareness.on('change', handleAwareness);

  // Undo manager scoped to our own edits (Yjs tracks by client ID via transact origin)
  const undoManager = new Y.UndoManager(yBlocks, {
    trackedOrigins: new Set(['local-publish']),
  });

  return {
    ydoc,
    yBlocks,
    yMeta,
    awareness,
    provider,
    undoManager,
    publishBlocks(blocks) {
      suppressNext = true;
      ydoc.transact(() => {
        applyBlocksToYDoc(ydoc, yBlocks, blocks);
      }, 'local-publish');
      suppressNext = false;
    },
    setCursor(cursor) {
      awareness.setLocalStateField('cursor', cursor);
    },
    undo() { undoManager.undo(); },
    redo() { undoManager.redo(); },
    canUndo() { return undoManager.undoStack.length > 0; },
    canRedo() { return undoManager.redoStack.length > 0; },
    destroy() {
      yBlocks.unobserveDeep(handleDeep);
      awareness.off('change', handleAwareness);
      provider.off('sync', handleSync);
      try { provider.destroy(); } catch { /* ignore */ }
      try { ydoc.destroy(); } catch { /* ignore */ }
    },
  };
}
