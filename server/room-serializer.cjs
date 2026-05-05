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
// Sub-PR 1d (#47, ADR-0006): the substrate is Y.XmlFragment. The seed
// path uses the broker's hand-coded delta→fragment helper instead of the
// ESM y-prosemirror module to keep the dual-package boundary clean
// (see ADR-0001 / Q22).
const { populateYXmlFragmentFromDelta } = require('./migrate-pm-substrate.cjs');

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

// Noop logger for the seed path — populateYXmlFragmentFromDelta only logs
// for unknown mark / revision kinds, and the seed delta has no attrs, so
// in practice this never fires. Defensive against future shape changes.
const SEED_LOG = { info: () => {}, warn: () => {}, error: () => {} };

/**
 * Seed a Y.Doc with parsed blocks, using CJS Yjs to avoid the dual-package
 * hazard. Clears existing content and replaces with the provided blocks.
 *
 * Each block's html is seeded as a single paragraph holding the raw HTML
 * string in a Y.XmlText (no marks). The first ESM client publish will
 * diff-and-merge against this via `prosemirrorToYXmlFragment` and replace
 * with the properly-marked PM doc — same handoff pattern the v1 seed
 * relied on. Acceptable because seeding is a one-time operation with no
 * concurrent edits.
 *
 * Sub-PR 1d (#47, ADR-0006): seed Y.XmlFragment, NOT Y.Text. After the
 * broker has migrated a room to v2, every new block must use the v2
 * substrate — otherwise an upload via HTTP strands its blocks as Y.Text
 * in an otherwise-v2 room and `needsMigration` short-circuits on the
 * schemaVersion=2 sentinel so the broker never re-runs.
 *
 * The order is load-bearing: Y.Map.set rejects a Y.XmlFragment value while
 * the parent map is detached ("Unexpected content type"). We therefore
 * (1) build a yMap with only scalars, (2) attach it via yStore.set, and
 * (3) set the Y.XmlFragment + populate it once the parent is part of the
 * doc tree. JSON_KEYS (table/ref) sit alongside as plain strings.
 */
function seedRoomFromBlocks(ydoc, blocks) {
  const yOrder = ydoc.getArray('order');
  const yStore = ydoc.getMap('store');
  ydoc.transact(() => {
    yOrder.delete(0, yOrder.length);
    for (const id of Array.from(yStore.keys())) yStore.delete(id);
    for (const b of blocks) {
      const yMap = new Y.Map();
      for (const k of SCALAR_KEYS) {
        if (b[k] !== undefined) yMap.set(k, b[k]);
      }
      for (const k of JSON_KEYS) {
        if (b[k] !== undefined) yMap.set(k, JSON.stringify(b[k]));
      }
      yStore.set(b.id, yMap);
      yOrder.push([b.id]);

      // yMap is now attached — Y.XmlFragment can be set as a value, and
      // its children integrate into the live doc.
      const yXml = new Y.XmlFragment();
      yMap.set('html', yXml);
      if (typeof b.html === 'string' && b.html.length > 0) {
        populateYXmlFragmentFromDelta(
          yXml,
          [{ insert: b.html }],
          { blockId: b.id, log: SEED_LOG },
        );
      }
    }
  }, 'seed');
}

module.exports = { serializeRoom, seedRoomFromBlocks };
