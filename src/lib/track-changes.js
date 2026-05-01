import { getVisibleTextFromHtml } from './text-diff.js';

// Pure reducer + selectors for Track Changes state.
//
// State shape: { enabled, snapshots: Map<blockId, plainText>, publishSeq }
//
// `publishSeq` is bumped by every user-driven verb but NOT by `applyRemote`,
// so the publish effect can detect "do we need to push this to peers?" by
// comparing against the last published seq — replacing the imperative
// `tcDirtyRef` flag.
//
// Invariant the verbs maintain when enabled:
//   snapshots.get(id) === getVisibleTextFromHtml(blocks[id].html)
// for every id the verb touched. Direct mutation of `snapshots` is not
// part of the contract.

export function createInitial() {
  return { enabled: false, snapshots: new Map(), publishSeq: 0 };
}

function snapshotsFromBlocks(blocks) {
  const out = new Map();
  for (const b of blocks) {
    if (b && b.html != null) out.set(b.id, getVisibleTextFromHtml(b.html));
  }
  return out;
}

export function enable(state, blocks) {
  return {
    enabled: true,
    snapshots: snapshotsFromBlocks(blocks || []),
    publishSeq: state.publishSeq + 1,
  };
}

export function disable(state) {
  return { enabled: false, snapshots: new Map(), publishSeq: state.publishSeq + 1 };
}

function refreshSnapshot(state, blockId, newHtml) {
  if (!state.enabled) return state;
  const next = new Map(state.snapshots);
  next.set(blockId, getVisibleTextFromHtml(newHtml || ''));
  return { ...state, snapshots: next, publishSeq: state.publishSeq + 1 };
}

export function acceptInline(state, blockId, newHtml) {
  return refreshSnapshot(state, blockId, newHtml);
}

export function rejectInline(state, blockId, newHtml) {
  return refreshSnapshot(state, blockId, newHtml);
}

export function applyResolveAtBlock(state, blockId, newHtml) {
  return refreshSnapshot(state, blockId, newHtml);
}

export function acceptAll(state, blocks) {
  if (!state.enabled) return state;
  return {
    ...state,
    snapshots: snapshotsFromBlocks(blocks || []),
    publishSeq: state.publishSeq + 1,
  };
}

export function rejectAll(state, blocks) {
  if (!state.enabled) return state;
  return {
    ...state,
    snapshots: snapshotsFromBlocks(blocks || []),
    publishSeq: state.publishSeq + 1,
  };
}

export function markBlockCreated(state, blockId) {
  if (!state.enabled) return state;
  const next = new Map(state.snapshots);
  next.set(blockId, '');
  return { ...state, snapshots: next, publishSeq: state.publishSeq + 1 };
}

// Reserved for symmetry. Today the call site reads `revisionFlagForDelete`
// and either filters the block out or sets `revision: 'del'`; no snapshot
// change is needed. Kept here so a future caller (e.g. tombstone cleanup)
// has a single seam to mutate state through.
export function markBlockDeleted(state /*, blockId */) {
  return state;
}

export function applyRemote(state, payload) {
  const enabled = !!(payload && payload.enabled);
  const snapshots = new Map();
  if (payload && payload.snapshots && typeof payload.snapshots === 'object') {
    for (const [k, v] of Object.entries(payload.snapshots)) snapshots.set(k, v);
  }
  return { enabled, snapshots, publishSeq: state.publishSeq };
}

// ─── Selectors ──────────────────────────────────────────────────────────────

export function isEnabled(state) {
  return !!state.enabled;
}

export function getSnapshot(state, blockId) {
  return state.snapshots.get(blockId);
}

export function getPublishableState(state) {
  const snapshots = {};
  if (state.enabled) {
    for (const [id, txt] of state.snapshots.entries()) snapshots[id] = txt;
  }
  return { enabled: state.enabled, snapshots };
}

export function revisionFlagForCreate(state) {
  return state.enabled ? 'add' : undefined;
}

// Returns 'del' when the block should be marked as a pending deletion,
// or null when the block should be removed outright (TC off, or it was
// itself a pending add).
export function revisionFlagForDelete(state, block) {
  if (!state.enabled) return null;
  if (block && block.revision === 'add') return null;
  return 'del';
}
