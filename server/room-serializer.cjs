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
  const meta = _readYMeta(yMeta);
  const secXml = _serializeSEC(blocks, meta);
  const secBytes = _encodeWindows1252(secXml);

  // 3. Comments sidecar
  const commentsObj = _readComments(yComments);
  const commentsArray = Object.values(commentsObj);
  const commentsJson = JSON.stringify({ version: 1, comments: commentsArray });

  return { ydocBytes, secBytes, commentsJson };
}

module.exports = { serializeRoom };
