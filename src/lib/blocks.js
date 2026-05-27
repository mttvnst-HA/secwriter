// Pure-reducer module for the blocks array (Q2 of the 2026-05-19 architecture
// review — extends the playbook from track-changes.js / comments.js /
// linting.js / compliance.js to the blocks array itself).
//
// State shape: `Block[]`. No wrapper struct — the other reducers carry
// coordination fields (publishSeq, seenRemoteIds, suspended, ai) that
// blocks does not need. Yjs is the coordination layer.
//
// ── Verb shape ──────────────────────────────────────────────────────────────
//
// Every verb returns a `VerbResult` (or `null` for no-op):
//
//   VerbResult = {
//     state: Block[],
//     effects: {
//       framing: { kind: 'newFrame' }
//              | { kind: 'wrappedFrame', writes: SubstrateWrite[] }
//              | null,
//       substrateWrites: SubstrateWrite[],   // empty when framing=wrappedFrame
//       flush: { kind: 'all' } | { kind: 'block', blockId } | null,
//       focus: { kind: 'setFocused' | 'imperative', blockId, atEnd? } | null,
//     }
//   }
//
//   SubstrateWrite = { blockId, html, origin? }   // origin defaults to 'local-publish'
//
// Two structurally distinct framing modes:
//   - `newFrame`: dispatcher calls `framing.forceFrame()` once, then writes
//     `substrateWrites` afterwards. Each write becomes its own UndoManager
//     entry (coalesced by captureTimeout).
//   - `wrappedFrame`: dispatcher calls `framing.withUndoFrame(() => writes.forEach(...))`.
//     The wrap OWNS the writes — `substrateWrites` at top level is empty.
//     This is the shape used by multi-write gestures (acceptAll, rejectAll,
//     complianceAcceptGroup): N writes form ONE Yjs UndoManager frame.
//
// Structural changes (insert / delete / reorder) are NOT in the descriptor.
// They flow through the implicit `setBlocks(state) → applyBlocksToYDoc`
// path: applyBlocksToYDoc diffs the new vs prior blocks array and emits
// yOrder.splice / yStore.delete / yStore.set as needed. The descriptor
// models the html slot only — that is the asymmetry between html (PM
// substrate) and structural data (publish effect).
//
// ── Dispatcher protocol ─────────────────────────────────────────────────────
//
// `dispatchBlocksVerb({...deps}, compute, opts)` runs:
//   1. Optional preFlush (`opts.preFlush`) — flushes PM debounces BEFORE
//      reading state. Required by acceptAll/rejectAll: they read
//      `blocksRef.current` for the compute, which must reflect post-debounce
//      html (post-#109 M4).
//   2. `compute(blocksRef.current)` → VerbResult | null. Null = no-op.
//   3. `effects.framing.kind === 'newFrame'` → `framing.forceFrame()`.
//   4. `effects.framing.kind === 'wrappedFrame'` → if yStore,
//      `framing.withUndoFrame(() => writes.forEach(setBlockHtml))`.
//      Else `effects.substrateWrites.forEach(setBlockHtml)`.
//   5. `setBlocks(state)` (always, even when substrateWrites=[]).
//   6. `effects.flush` → `flushPendingUpdateById` / `flushAllPendingUpdates`.
//   7. `effects.focus` → `setFocusedBlockId` or `focusBlock` (queued via
//      setTimeout for `'imperative'`).
//
// Substrate writes go BEFORE setBlocks per the handleAcceptAll comment
// ("setBlockHtml is a side effect that must not run inside a (potentially-
// reinvoked-in-StrictMode) updater"). Order is irrelevant for the in-place
// case (substrate writes do not feed back into React state), but the
// invariant is uniform across all verbs.
//
// The dispatcher does NOT call `getBlockHandle(id).setHtml(html)` —
// PmEditableBlock's setHtml handle is documented as a no-op (block-registry.js
// line 30-33), and TitleBlock does not register a handle. The pre-1i-b.2
// callsites that did this (handleBlockUpdateWithSync, handleSearchReplace)
// were updating the legacy contentEditable DOM; PM owns its DOM now. If a
// future non-PM editor surface re-introduces imperative html push, add the
// mirror to the dispatcher.

import { setBlockHtml } from './block-html-store.js';
import {
  flushPendingUpdateById,
  flushAllPendingUpdates,
  focusBlockById,
} from './block-registry.js';
import { reorderSection as reorderSectionFn } from './block-reorder.js';
import { replaceMatchInHtml } from '../components/SearchBar.jsx';
import {
  acceptAllRevisions,
  rejectAllRevisions,
  acceptAllInline,
  rejectAllInline,
} from './revisions.js';
import * as tc from './track-changes.js';

// ── Internal helpers ────────────────────────────────────────────────────────

function noop() {
  return null;
}

function unchanged(state) {
  return { state, effects: { framing: null, substrateWrites: [], flush: null, focus: null } };
}

function withForceFrame(state) {
  return {
    state,
    effects: { framing: { kind: 'newFrame' }, substrateWrites: [], flush: null, focus: null },
  };
}

function htmlWrite(blockId, html) {
  return { blockId, html };
}

// ── Verbs ───────────────────────────────────────────────────────────────────

// updateBlockHtml — the debounced-typing path. PM-driven keystrokes already
// wrote the substrate via ySyncPlugin; the explicit setBlockHtml write here
// is a byte-stable echo op the UndoManager merges into the same frame. Title
// edits + MarkSuggestions-style imperative writes need the substrate mirror
// outright (no ySyncPlugin behind them).
//
// No framing. The Yjs UndoManager's captureTimeout coalesces typing-grain
// frames; click-path callers use updateBlockHtmlPmSync (with framing) instead.
export function updateBlockHtml(blocks, blockId, html) {
  const idx = blocks.findIndex(b => b.id === blockId);
  if (idx < 0) return null;
  if (blocks[idx].html === html) return unchanged(blocks);
  const next = blocks.slice();
  next[idx] = { ...blocks[idx], html };
  return {
    state: next,
    effects: { framing: null, substrateWrites: [htmlWrite(blockId, html)], flush: null, focus: null },
  };
}

// updateBlockHtmlPmSync — the click path. PM dispatch already wrote the
// substrate, so substrateWrites is empty; framing.forceFrame closes the
// active capture window so the next typing burst opens a fresh frame.
export function updateBlockHtmlPmSync(blocks, blockId, html) {
  const idx = blocks.findIndex(b => b.id === blockId);
  if (idx < 0) return null;
  if (blocks[idx].html === html) return unchanged(blocks);
  const next = blocks.slice();
  next[idx] = { ...blocks[idx], html };
  return {
    state: next,
    effects: { framing: { kind: 'newFrame' }, substrateWrites: [], flush: null, focus: null },
  };
}

// searchReplaceAt — search/replace single match. Mutates html in place.
export function searchReplaceAt(blocks, blockId, offset, length, replacement) {
  const idx = blocks.findIndex(b => b.id === blockId);
  if (idx < 0) return null;
  const block = blocks[idx];
  if (!block.html) return null;
  const newHtml = replaceMatchInHtml(block.html, offset, length, replacement);
  if (newHtml === block.html) return unchanged(blocks);
  const next = blocks.slice();
  next[idx] = { ...block, html: newHtml };
  return {
    state: next,
    effects: {
      framing: { kind: 'newFrame' },
      substrateWrites: [htmlWrite(blockId, newHtml)],
      flush: null,
      focus: null,
    },
  };
}

// applyInlineFix — single block html replacement from compliance auto-fix.
// Same shape as updateBlockHtml but click-path (framing).
export function applyInlineFix(blocks, blockId, fixedText) {
  const idx = blocks.findIndex(b => b.id === blockId);
  if (idx < 0) return null;
  if (blocks[idx].html === fixedText) return unchanged(blocks);
  const next = blocks.slice();
  next[idx] = { ...blocks[idx], html: fixedText };
  return {
    state: next,
    effects: {
      framing: { kind: 'newFrame' },
      substrateWrites: [htmlWrite(blockId, fixedText)],
      flush: null,
      focus: null,
    },
  };
}

// complianceAcceptGroup — N blocks updated atomically. wrappedFrame so all
// N substrate writes form ONE undo frame regardless of captureTimeout.
export function complianceAcceptGroup(blocks, fixesByBlock) {
  const writes = [];
  const next = blocks.map(b => {
    const fix = fixesByBlock.get(b.id);
    if (typeof fix === 'string' && fix !== b.html) {
      writes.push(htmlWrite(b.id, fix));
      return { ...b, html: fix };
    }
    return b;
  });
  if (writes.length === 0) return unchanged(blocks);
  return {
    state: next,
    effects: {
      framing: { kind: 'wrappedFrame', writes },
      substrateWrites: [],
      flush: null,
      focus: null,
    },
  };
}

// removeOrphanedRid — strip a RID entry from a ref block. If the last
// entry, the ref block itself is removed (structural change → publish
// effect handles substrate reconciliation).
export function removeOrphanedRid(blocks, blockId, rid) {
  const idx = blocks.findIndex(b => b.id === blockId);
  if (idx < 0) return null;
  const block = blocks[idx];
  if (block.type !== 'ref' || !block.ref?.entries) return null;
  const filtered = block.ref.entries.filter(e => (e.rid || '').trim() !== rid);
  if (filtered.length === block.ref.entries.length) return unchanged(blocks);
  let next;
  if (filtered.length === 0) {
    next = blocks.filter(b => b.id !== blockId);
  } else {
    next = blocks.slice();
    next[idx] = { ...block, ref: { ...block.ref, entries: filtered } };
  }
  return withForceFrame(next);
}

// addReference — find-or-create the org's REF block, sorted insertion.
// Pure: takes an explicit `newId` so callers can keep id generation in the
// callsite (App uses `ref-${Date.now()}`). Pass null and we fabricate one.
export function addReference(blocks, { org, rid, rtl, newId }) {
  const refBlock = blocks.find(b => b.type === 'ref' && b.ref?.org === org);
  if (refBlock) {
    const next = blocks.map(b => {
      if (b.id !== refBlock.id) return b;
      const entries = [...b.ref.entries, { rid, rtl }].sort(ridCompare);
      return { ...b, ref: { ...b.ref, entries } };
    });
    return withForceFrame(next);
  }
  const refBlocks = blocks.map((b, i) => ({ b, i }))
    .filter(x => x.b.type === 'ref' && x.b.part === 1);
  let insertIdx;
  if (refBlocks.length === 0) {
    insertIdx = blocks.length;
  } else {
    const afterIdx = refBlocks.reduce((acc, x) => {
      if ((x.b.ref?.org || '').localeCompare(org) < 0) return x.i;
      return acc;
    }, -1);
    insertIdx = afterIdx >= 0 ? afterIdx + 1 : refBlocks[0].i;
  }
  const newBlock = {
    id: newId || `ref-${Date.now()}`,
    type: 'ref',
    part: 1,
    depth: 1,
    ref: { org, entries: [{ rid, rtl }] },
  };
  const next = [...blocks];
  next.splice(insertIdx, 0, newBlock);
  return withForceFrame(next);
}

// Alphanumeric sort for RIDs: letters first, then numbers within designation.
function ridCompare(a, b) {
  const pa = (a.rid || '').replace(/^[A-Z/]+\s*/i, '');
  const pb = (b.rid || '').replace(/^[A-Z/]+\s*/i, '');
  const na = parseFloat(pa) || 0;
  const nb = parseFloat(pb) || 0;
  if (pa[0] !== pb[0]) return pa.localeCompare(pb);
  if (na !== nb) return na - nb;
  return pa.localeCompare(pb);
}

// createBlockAfter (Enter key). On an empty oli/item, exits to txt instead
// of inserting a sibling. On non-empty, inserts a new block of propagated
// type below the current one. Caller supplies `newId` so the focus side
// effect can target it.
export function createBlockAfter(blocks, afterId, { newId, tcState }) {
  const idx = blocks.findIndex(b => b.id === afterId);
  if (idx < 0) return null;
  const current = blocks[idx];
  const isEmpty = !(current.html || '').replace(/\u200B/g, '').trim();

  if (isEmpty && (current.type === 'oli' || current.type === 'item')) {
    const next = blocks.slice();
    next[idx] = { ...current, type: 'txt', isNew: true, id: newId };
    return {
      state: next,
      effects: {
        framing: { kind: 'newFrame' },
        substrateWrites: [],
        flush: null,
        focus: { kind: 'setFocused', blockId: newId },
      },
    };
  }

  const propagateTypes = { oli: 'oli', item: 'item' };
  const newType = propagateTypes[current.type] || 'txt';
  const revisionFlag = tc.revisionFlagForCreate(tcState);
  const newBlock = {
    id: newId,
    type: newType,
    part: current.part,
    depth: current.depth,
    section: current.section,
    level: current.level,
    html: '',
    isNew: true,
    ...(revisionFlag ? { revision: revisionFlag } : {}),
  };
  const next = blocks.slice();
  next.splice(idx + 1, 0, newBlock);
  return {
    state: next,
    effects: {
      framing: { kind: 'newFrame' },
      substrateWrites: [],
      flush: null,
      focus: { kind: 'setFocused', blockId: newId },
    },
  };
}

// deleteBlock — TC-aware delete. With TC enabled and the block is not a
// pending add, marks revision='del'. Otherwise removes outright. Never
// deletes the first block (idx === 0 bails).
export function deleteBlock(blocks, blockId, tcState) {
  const idx = blocks.findIndex(b => b.id === blockId);
  if (idx <= 0) return null;
  const block = blocks[idx];
  const flag = tc.revisionFlagForDelete(tcState, block);
  const prevBlock = blocks[idx - 1];

  if (flag === 'del') {
    const next = blocks.slice();
    next[idx] = { ...block, revision: 'del' };
    return {
      state: next,
      effects: {
        framing: { kind: 'newFrame' },
        substrateWrites: [],
        flush: null,
        focus: { kind: 'imperative', blockId: prevBlock.id, atEnd: true },
      },
    };
  }

  const next = blocks.filter(b => b.id !== blockId);
  return {
    state: next,
    effects: {
      framing: { kind: 'newFrame' },
      substrateWrites: [],
      flush: null,
      focus: { kind: 'imperative', blockId: prevBlock.id, atEnd: true },
    },
  };
}

// changeOliLevel — clamps to 1..4 per UFS Figure A-1.
export function changeOliLevel(blocks, blockId, delta) {
  const idx = blocks.findIndex(b => b.id === blockId);
  if (idx < 0) return null;
  const current = blocks[idx];
  if (current.type !== 'oli') return null;
  const currentLevel = current.level || 1;
  const nextLevel = Math.max(1, Math.min(currentLevel + delta, 4));
  if (nextLevel === currentLevel) return unchanged(blocks);
  const next = blocks.slice();
  next[idx] = { ...current, level: nextLevel };
  return withForceFrame(next);
}

// convertToTitle — type flip + depth inference from surrounding titles.
// Clears html because the only caller is convertBlock from the slash menu,
// whose trigger requires the doc to start with "/" (slash-menu.js readLeadingText).
// The slash + filter is always the entire block content at conversion time, so
// preserving it would leave the new title showing "/h" until the user manually
// deletes it. Mirror via substrateWrites so collab peers reading the
// Y.XmlFragment see the cleared content (updateYMapFromBlock skips html for
// existing slots, so without this peers would still observe "/h").
export function convertToTitle(blocks, blockId) {
  const idx = blocks.findIndex(b => b.id === blockId);
  if (idx < 0) return null;
  const block = blocks[idx];
  let depth = 1;
  for (let i = idx - 1; i >= 0; i--) {
    if (blocks[i].type === 'title') {
      depth = blocks[i].depth;
      break;
    }
  }
  const next = blocks.slice();
  next[idx] = { ...block, type: 'title', depth, html: '', isNew: false };
  return {
    state: next,
    effects: {
      framing: { kind: 'newFrame' },
      substrateWrites: [{ blockId, html: '' }],
      flush: null,
      focus: { kind: 'imperative', blockId, atEnd: true },
    },
  };
}

// convertBlock — slash menu type conversion. Allocates a new id so the
// component remounts via the ref-callback path (see CLAUDE.md "Slash Menu
// → Block Conversion"). For type='title', delegates to convertToTitle.
export function convertBlock(blocks, blockId, newType, { newId }) {
  if (newType === 'title') return convertToTitle(blocks, blockId);
  const idx = blocks.findIndex(b => b.id === blockId);
  if (idx < 0) return null;
  const block = blocks[idx];
  const newBlock = {
    id: newId,
    type: newType,
    part: block.part,
    depth: block.depth,
    section: block.section,
    html: '',
    isNew: true,
  };
  if (newType === 'ref') {
    newBlock.ref = { org: '', entries: [{ rid: '', rtl: '' }] };
    delete newBlock.html;
  }
  if (newType === 'pagebreak') {
    delete newBlock.html;
    delete newBlock.isNew;
  }
  if (newType === 'table') {
    newBlock.table = {
      columns: 2,
      rows: [
        [{ text: '', colspan: 1 }, { text: '', colspan: 1 }],
        [{ text: '', colspan: 1 }, { text: '', colspan: 1 }],
      ],
    };
    delete newBlock.html;
    delete newBlock.isNew;
  }
  const next = blocks.slice();
  next[idx] = newBlock;
  return {
    state: next,
    effects: {
      framing: { kind: 'newFrame' },
      substrateWrites: [],
      flush: null,
      focus: { kind: 'setFocused', blockId: newId },
    },
  };
}

// promoteTitle / demoteTitle — depth ±1, clamped 1..6. Returns null for
// non-title blocks (no semantically valid promote/demote outside titles);
// returns unchanged for at-bound titles (no-op).
export function promoteTitle(blocks, blockId) {
  const idx = blocks.findIndex(b => b.id === blockId);
  if (idx < 0) return null;
  const block = blocks[idx];
  if (block.type !== 'title') return null;
  if (block.depth <= 1) return unchanged(blocks);
  const next = blocks.slice();
  next[idx] = { ...block, depth: block.depth - 1 };
  return withForceFrame(next);
}

export function demoteTitle(blocks, blockId) {
  const idx = blocks.findIndex(b => b.id === blockId);
  if (idx < 0) return null;
  const block = blocks[idx];
  if (block.type !== 'title') return null;
  if (block.depth >= 6) return unchanged(blocks);
  const next = blocks.slice();
  next[idx] = { ...block, depth: block.depth + 1 };
  return withForceFrame(next);
}

// reorderSectionVerb — wraps the pure reorderSection helper.
export function reorderSectionVerb(blocks, dragId, dropId, position) {
  const next = reorderSectionFn(blocks, dragId, dropId, position);
  if (next === blocks) return unchanged(blocks);
  return withForceFrame(next);
}

// acceptBlockRevision — single block-level revision accept.
//   revision='del' → block is removed
//   revision='add' or 'chg' → revision cleared, inline marks resolved
//
// For PmEditableBlock callers, the inline html mutation runs through
// acceptAllInline (existing pure helper). RefBlock has no html field, so
// the html mutation is skipped (the verb produces no substrateWrite for
// ref blocks; the block's revision flip rides the publish effect).
export function acceptBlockRevision(blocks, blockId) {
  const idx = blocks.findIndex(b => b.id === blockId);
  if (idx < 0) return null;
  const block = blocks[idx];
  if (block.revision === 'del') {
    const next = blocks.filter(b => b.id !== blockId);
    return withForceFrame(next);
  }
  const next = blocks.slice();
  if (typeof block.html === 'string') {
    const html = acceptAllInline(block.html);
    next[idx] = { ...block, revision: undefined, html };
    const writes = block.html !== html ? [htmlWrite(blockId, html)] : [];
    return {
      state: next,
      effects: {
        framing: { kind: 'newFrame' },
        substrateWrites: writes,
        flush: null,
        focus: null,
      },
    };
  }
  next[idx] = { ...block, revision: undefined };
  return withForceFrame(next);
}

export function rejectBlockRevision(blocks, blockId) {
  const idx = blocks.findIndex(b => b.id === blockId);
  if (idx < 0) return null;
  const block = blocks[idx];
  if (block.revision === 'add') {
    const next = blocks.filter(b => b.id !== blockId);
    return withForceFrame(next);
  }
  const next = blocks.slice();
  if (typeof block.html === 'string') {
    const html = rejectAllInline(block.html);
    next[idx] = { ...block, revision: undefined, html };
    const writes = block.html !== html ? [htmlWrite(blockId, html)] : [];
    return {
      state: next,
      effects: {
        framing: { kind: 'newFrame' },
        substrateWrites: writes,
        flush: null,
        focus: null,
      },
    };
  }
  next[idx] = { ...block, revision: undefined };
  return withForceFrame(next);
}

// acceptAllRevisionsVerb / rejectAllRevisionsVerb — wrappedFrame so the N
// per-block substrate writes form ONE Yjs undo frame regardless of
// captureTimeout. Callers must precede the dispatch with preFlush='all'
// (#109 M4) so the compute reads post-debounce html.
export function acceptAllRevisionsVerb(blocks) {
  const next = acceptAllRevisions(blocks);
  return buildBatchHtmlVerb(blocks, next);
}

export function rejectAllRevisionsVerb(blocks) {
  const next = rejectAllRevisions(blocks);
  return buildBatchHtmlVerb(blocks, next);
}

function buildBatchHtmlVerb(prev, next) {
  if (next === prev) return unchanged(prev);
  const writes = [];
  for (let i = 0; i < next.length; i++) {
    const b = next[i];
    const before = prev.find(p => p.id === b.id);
    if (before && typeof b.html === 'string' && before.html !== b.html) {
      writes.push(htmlWrite(b.id, b.html));
    }
  }
  // No html writes AND no semantic structural change → bail to keep React
  // state stable. acceptAllRevisions / rejectAllRevisions always return a
  // fresh array (every block gets re-allocated with revision:undefined),
  // so ref-equality alone misses the "nothing to do" case.
  if (writes.length === 0 && prev.length === next.length) {
    let identical = true;
    for (let i = 0; i < next.length; i++) {
      const a = prev[i];
      const c = next[i];
      if (a.id !== c.id || (a.revision || null) !== (c.revision || null)) {
        identical = false;
        break;
      }
    }
    if (identical) return unchanged(prev);
  }
  if (writes.length === 0) {
    return withForceFrame(next);
  }
  return {
    state: next,
    effects: {
      framing: { kind: 'wrappedFrame', writes },
      substrateWrites: [],
      flush: null,
      focus: null,
    },
  };
}

// mergeBlockData — generic shallow-merge into a block's fields. Used by
// PreformattedBlock/TableBlock onUpdate (tbl/table data is opaque to this
// reducer; mutations are spread-merged in). No substrate write — the
// publish effect's applyBlocksToYDoc reconciles scalar/struct slots from
// the new blocks array.
export function mergeBlockData(blocks, blockId, data) {
  const idx = blocks.findIndex(b => b.id === blockId);
  if (idx < 0) return null;
  const next = blocks.slice();
  next[idx] = { ...blocks[idx], ...data };
  return withForceFrame(next);
}

// updateRefScalar — RefBlock onUpdate. Only `data.ref` is honored; the
// rest of the data object is ignored to match the existing handler shape.
// Unlike mergeBlockData, no forceFrame — RefBlock org/entry edits are
// keystroke-grain inputs that coalesce naturally with their typing
// captureTimeout.
export function updateRefScalar(blocks, blockId, data) {
  const idx = blocks.findIndex(b => b.id === blockId);
  if (idx < 0) return null;
  const next = blocks.slice();
  next[idx] = { ...blocks[idx], ref: data.ref };
  return {
    state: next,
    effects: { framing: null, substrateWrites: [], flush: null, focus: null },
  };
}

// ── Dispatcher ──────────────────────────────────────────────────────────────

/**
 * Apply a verb's VerbResult side effects in canonical order.
 *
 * `deps`:
 *   - `blocksRef`: { current: Block[] } — for preFlush-then-compute path
 *   - `setBlocks`: React setter
 *   - `yStore`: active Y.Map (nullable; substrate writes skipped when null)
 *   - `framing`: { forceFrame, withUndoFrame } — from collab or localUndo
 *   - `setFocusedBlockId`: optional, for focus.kind === 'setFocused'
 *   - `focusBlock`: optional, for focus.kind === 'imperative'
 *
 * `compute`: (blocks) => VerbResult | null.
 *
 * `opts`:
 *   - `preFlush`: 'all' | { blockId } | null — flush PM debounces BEFORE
 *     compute reads blocksRef.current.
 *
 * Returns { dispatched: boolean, state?: Block[] } so callers that need
 * follow-on actions (rare — most are encoded in effects) can short-circuit
 * on no-op.
 */
export function dispatchBlocksVerb(deps, compute, opts) {
  const { blocksRef, setBlocks, yStore, framing, setFocusedBlockId, focusBlock } = deps;
  const preFlush = opts?.preFlush || null;

  // 1. preFlush
  if (preFlush === 'all') {
    flushAllPendingUpdates();
  } else if (preFlush && typeof preFlush === 'object' && preFlush.blockId) {
    flushPendingUpdateById(preFlush.blockId);
  }

  // 2. compute
  const cur = blocksRef.current;
  const result = compute(cur);
  if (!result) return { dispatched: false };
  const { state, effects } = result;

  // No structural change AND no side effects → no-op dispatch.
  if (state === cur
      && (!effects || (
        effects.framing === null
        && effects.substrateWrites.length === 0
        && effects.flush === null
        && effects.focus === null
      ))) {
    return { dispatched: false };
  }

  // 3. framing.forceFrame (newFrame case)
  if (effects.framing?.kind === 'newFrame' && framing) {
    framing.forceFrame();
  }

  // 4. substrate writes
  if (yStore) {
    if (effects.framing?.kind === 'wrappedFrame') {
      const writes = effects.framing.writes;
      if (writes.length > 0 && framing && typeof framing.withUndoFrame === 'function') {
        framing.withUndoFrame(() => {
          for (const w of writes) {
            setBlockHtml(yStore, w.blockId, w.html, w.origin || 'local-publish');
          }
        });
      } else {
        // No framing helper — write inline (test/edge case).
        for (const w of writes) {
          setBlockHtml(yStore, w.blockId, w.html, w.origin || 'local-publish');
        }
      }
    } else if (effects.substrateWrites.length > 0) {
      for (const w of effects.substrateWrites) {
        setBlockHtml(yStore, w.blockId, w.html, w.origin || 'local-publish');
      }
    }
  }

  // 5. setBlocks — also mutate blocksRef.current synchronously so a
  //    sequential dispatch loop (Replace All, Remove All Orphaned, etc.)
  //    sees the post-mutation state instead of the pre-loop snapshot.
  //    React will overwrite blocksRef.current on the next render commit
  //    with whatever React state ends up holding; the synchronous mutation
  //    here just bridges the gap between setBlocks (async) and the next
  //    compute call in the same event loop turn.
  setBlocks(state);
  blocksRef.current = state;

  // 6. flush
  if (effects.flush?.kind === 'all') {
    flushAllPendingUpdates();
  } else if (effects.flush?.kind === 'block') {
    flushPendingUpdateById(effects.flush.blockId);
  }

  // 7. focus
  if (effects.focus) {
    if (effects.focus.kind === 'setFocused' && setFocusedBlockId) {
      setFocusedBlockId(effects.focus.blockId);
    } else if (effects.focus.kind === 'imperative' && focusBlock) {
      setTimeout(() => focusBlock(effects.focus.blockId, effects.focus.atEnd), 0);
    }
  }

  return { dispatched: true, state };
}

// Exported for ergonomics — callers that want focus side effects without
// going through a verb (rare) can use focusBlockById directly.
export { focusBlockById };

// Silence the unused-import lint for the placeholder.
void noop;
