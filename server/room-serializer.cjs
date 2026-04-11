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
  // separate copies, making `instanceof Y.Text` fail in yMapToBlock. Coerce
  // any non-string html to string so the serializer gets plain strings.
  for (const b of blocks) {
    if (b.html && typeof b.html !== 'string') b.html = b.html.toString();
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
 */
function seedRoomFromBlocks(ydoc, blocks) {
  const yOrder = ydoc.getArray('order');
  const yStore = ydoc.getMap('store');
  ydoc.transact(() => {
    yOrder.delete(0, yOrder.length);
    for (const id of Array.from(yStore.keys())) yStore.delete(id);
    for (const b of blocks) {
      yStore.set(b.id, blockToYMap(b));
      yOrder.push([b.id]);
    }
  }, 'seed');
}

module.exports = { serializeRoom, seedRoomFromBlocks };
