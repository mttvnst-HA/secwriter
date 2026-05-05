/**
 * Room serializer — extracts .SEC + .comments.json from a Yjs Y.Doc.
 *
 * Orchestrates the ESM serializer/encoder/collab modules from a CJS context.
 * dom-polyfill.cjs MUST be required before this module is first used.
 *
 * CJS on purpose (see collab-server.cjs header comment).
 */
'use strict';

const Y = require('yjs');
const { SCHEMA_VERSION_KEY, MIGRATION_PARTIAL_KEY } = require('./migrate-pm-substrate.cjs');

// Lazy-loaded ESM module references (cached after first import)
let _serializeSEC = null;
let _encodeWindows1252 = null;
let _yBlocksToArray = null;
let _readYMeta = null;
let _readComments = null;

async function loadModules() {
  if (_serializeSEC) return;
  const [serMod, encMod, collabMod] = await Promise.all([
    import('../src/lib/sec-serializer.js'),
    import('../src/lib/encoding.js'),
    import('../src/lib/collab.js'),
  ]);
  _serializeSEC = serMod.serializeSEC;
  _encodeWindows1252 = encMod.encodeWindows1252;
  _yBlocksToArray = collabMod.yBlocksToArray;
  _readYMeta = collabMod.readYMeta;
  _readComments = collabMod.readComments;
}

/**
 * Serialize a room's Y.Doc into all persistence artifacts.
 *
 * @param {import('yjs').Doc} ydoc
 * @returns {Promise<{ ydocBytes: Uint8Array, secBytes: Uint8Array, commentsJson: string }>}
 */
async function serializeRoom(ydoc) {
  await loadModules();

  const yOrder = ydoc.getArray('order');
  const yStore = ydoc.getMap('store');
  const yMeta = ydoc.getMap('meta');
  const yComments = ydoc.getMap('comments');

  // 1. Binary CRDT snapshot
  const ydocBytes = Y.encodeStateAsUpdate(ydoc);

  // 2. .SEC file
  const blocks = _yBlocksToArray(yOrder, yStore);
  // Dual-package hazard: CJS require('yjs') and ESM import('yjs') may load
  // separate copies. yMapToBlock now uses duck-type checks (toDelta) instead
  // of instanceof Y.Text, so formatting attributes are preserved even when
  // called from CJS context. The coercion below is a safety net for any
  // unexpected edge case where html is still an object (rarely needed now).
  for (const b of blocks) {
    if (b.html && typeof b.html !== 'string') b.html = String(b.html);
  }
  const meta = _readYMeta(yMeta);
  const secXml = _serializeSEC(blocks, meta);
  const secBytes = _encodeWindows1252(secXml);

  // 3. Comments sidecar
  const commentsObj = _readComments(yComments);
  const commentsArray = Object.values(commentsObj);
  const commentsJson = JSON.stringify({ version: 1, comments: commentsArray });

  return { ydocBytes, secBytes, commentsJson };
}

// ── Server-side block seeding (CJS Yjs) ──────────────────────────────────
// Using ESM collab.js's applyBlocksToYDoc/seedYBlocks from CJS creates
// Y.Map/Y.Text via the ESM Yjs copy, which fails instanceof checks against
// the CJS Y.Doc. This CJS implementation uses the same require('yjs') copy
// as the server's Y.Docs.

// Mirrors SCALAR_KEYS / JSON_KEYS in src/lib/collab.js — duplicated here
// because importing from the ESM module would trigger the dual-package hazard.
// `isNew` is intentionally excluded: it's a transient UI flag, never persisted.
const SCALAR_KEYS = ['id', 'type', 'part', 'depth', 'section', 'level', 'revision'];
const JSON_KEYS = ['table', 'ref'];

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

/**
 * Seed a Y.Doc with parsed blocks, using CJS Yjs to avoid dual-package hazard.
 * Clears existing content and replaces with the provided blocks.
 *
 * NOTE: Seeds with plain text Y.Text (no formatting attributes) and JSON
 * strings for table/ref. The ESM client's updateYMapFromBlock() will upgrade
 * these to attribute-based shapes and nested CRDT structures on first publish.
 * This is acceptable because seeding is a one-time operation with no
 * concurrent edits.
 *
 * Sub-PR 1d (#47, ADR-0006), issue (d) re-fix. The seed continues to use
 * Y.Text; instead, we clear `schemaVersion` and `migrationPartial` so the
 * server-side broker re-evaluates the room on the next WS upgrade and
 * migrates the seeded Y.Text slots to Y.XmlFragment. Without this clear, a
 * room that already had `schemaVersion=2` from a prior broker run would
 * keep the sentinel after the seed wipes its blocks, and `needsMigration`
 * would short-circuit so the freshly-uploaded Y.Text blocks would never
 * get promoted to v2 substrate.
 *
 * (Why not seed Y.XmlFragment directly? The hand-coded
 * populateYXmlFragmentFromDelta path produced an intermittent client-side
 * "Invalid access: Add Yjs type to a document before reading data." flood
 * that surfaced as a `t.html.startsWith is not a function` ErrorBoundary
 * crash on CI runners — the substrate post-decode behaved as if a child
 * was detached during render. The Y.Text + clear-sentinel approach
 * achieves the same end state, lets the broker do all v1→v2 work, and
 * keeps E2E green.)
 */
function seedRoomFromBlocks(ydoc, blocks) {
  const yOrder = ydoc.getArray('order');
  const yStore = ydoc.getMap('store');
  const yMeta = ydoc.getMap('meta');
  ydoc.transact(() => {
    yOrder.delete(0, yOrder.length);
    for (const id of Array.from(yStore.keys())) yStore.delete(id);
    for (const b of blocks) {
      yStore.set(b.id, blockToYMap(b));
      yOrder.push([b.id]);
    }
    // Clear migration sentinels so the broker re-runs and converts the
    // newly-seeded Y.Text slots to Y.XmlFragment on the next WS upgrade.
    yMeta.delete(SCHEMA_VERSION_KEY);
    yMeta.delete(MIGRATION_PARTIAL_KEY);
  }, 'seed');
}

module.exports = { serializeRoom, seedRoomFromBlocks };
