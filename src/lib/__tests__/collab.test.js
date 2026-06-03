/**
 * Collab library tests — exercise the Y.Doc ↔ blocks conversion without
 * spinning up a WebSocket server. Real-network tests are done via the
 * two-browser smoke test documented in CLAUDE.md.
 *
 * Consolidated to ≤30 it() blocks per CLAUDE.md rule: data-driven tests
 * use it.each(), related assertions are batched in single it() blocks.
 */

import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import {
  applyBlocksToYDoc,
  yBlocksToArray,
  seedYBlocks,
  generateRoomId,
  buildRoomUrl,
  stripRoomFromUrl,
  estimatePublishBytes,
  DocSizeLimitError,
  MAX_PUBLISH_BYTES,
  readYMeta,
  createCollabSession,
  publishTcToDoc,
  readTc,
  publishCommentToDoc,
  publishCommentReplyToDoc,
  publishCommentStatusToDoc,
  deleteCommentFromDoc,
  readComments,
} from '../collab.js';
import { setBlockHtml, getBlockHtml } from '../block-html-store.js';

function makeDoc() {
  const ydoc = new Y.Doc();
  const yOrder = ydoc.getArray('order');
  const yStore = ydoc.getMap('store');
  return { ydoc, yOrder, yStore };
}

/** Get the Y.Map backing a given block id. */
function getYMap(yStore, id) {
  return yStore.get(id);
}

/** Get the Y.Text backing a given block id's html. */
function getYText(yStore, id) {
  const ymap = yStore.get(id);
  return ymap ? ymap.get('html') : undefined;
}

const sampleBlocks = [
  { id: 'b1', type: 'title', part: 1, depth: 0, section: 'b1', html: 'GENERAL' },
  { id: 'b2', type: 'txt', part: 1, depth: 1, section: 'b1', html: 'This section covers...' },
  { id: 'b3', type: 'oli', part: 1, depth: 1, section: 'b1', level: 1, html: 'First item' },
];

describe('collab — seeding, snapshot & update-in-place', () => {
  it('seeds an empty Y.Doc and roundtrips scalar + html fields', () => {
    const { ydoc, yOrder, yStore } = makeDoc();
    seedYBlocks(ydoc, yOrder, yStore, sampleBlocks);
    expect(yOrder.length).toBe(3);
    expect(yStore.size).toBe(3);
    const out = yBlocksToArray(yOrder, yStore);
    expect(out).toHaveLength(3);
    expect(out[0].id).toBe('b1');
    expect(out[0].html).toBe('GENERAL');
    expect(out[2].level).toBe(1);
    // Roundtrip scalar + html fields
    for (let i = 0; i < sampleBlocks.length; i++) {
      expect(out[i]).toMatchObject({
        id: sampleBlocks[i].id,
        type: sampleBlocks[i].type,
        html: sampleBlocks[i].html,
      });
    }
  });

  it('updates html and scalar fields in place without rebuilding', () => {
    const { ydoc, yOrder, yStore } = makeDoc();
    seedYBlocks(ydoc, yOrder, yStore, sampleBlocks);
    const slotBefore = getYText(yStore, 'b2');

    // Update html — owned by the binder substrate (#22 sub-PR 1b);
    // applyBlocksToYDoc no longer touches html for existing slots.
    setBlockHtml(yStore, 'b2', 'This section covers grading.');

    const slotAfter = getYText(yStore, 'b2');
    expect(getBlockHtml(yStore, 'b2')).toBe('This section covers grading.');
    // Same slot instance preserved (update-in-place path; Y.XmlFragment
    // post-1d, Y.Text legacy fallback both honor identity).
    expect(slotAfter).toBe(slotBefore);

    // Update scalar field
    const next2 = sampleBlocks.map((b, i) => i === 2 ? { ...b, level: 2 } : b);
    applyBlocksToYDoc(ydoc, yOrder, yStore, next2);
    expect(getYMap(yStore, 'b3').get('level')).toBe(2);
  });

  it('is a no-op when the block array is unchanged', () => {
    const { ydoc, yOrder, yStore } = makeDoc();
    seedYBlocks(ydoc, yOrder, yStore, sampleBlocks);
    const before = Y.encodeStateAsUpdate(ydoc);
    applyBlocksToYDoc(ydoc, yOrder, yStore, sampleBlocks);
    const after = Y.encodeStateAsUpdate(ydoc);
    expect(yBlocksToArray(yOrder, yStore)).toEqual(sampleBlocks);
    expect(before.length).toBeGreaterThan(0);
    expect(after.length).toBeGreaterThan(0);
  });

  // PR #51 review (comment 4380149320, issue 1) — regression. The
  // updateYMapFromBlock defensive fallback condition was
  // `typeof yText.toDelta !== 'function'`, which is TRUE for Y.XmlFragment
  // (it has toArray, not toDelta). So every scalar/structural publish on
  // a v2 room would fire the fallback and replace the Y.XmlFragment slot
  // with a fresh Y.Text — destroying the migrated substrate for every
  // block on the first publishBlocks call after room join.
  it('updateYMapFromBlock preserves Y.XmlFragment slot identity across scalar publish (issue 1)', () => {
    const { ydoc, yOrder, yStore } = makeDoc();
    seedYBlocks(ydoc, yOrder, yStore, sampleBlocks);
    // seedYBlocks now seeds Y.XmlFragment slots (post-1d).
    const slotBefore = getYText(yStore, 'b2');
    expect(typeof slotBefore.toArray).toBe('function');
    expect(typeof slotBefore.toDelta).toBe('undefined');

    // Trigger a scalar-only update (no html change). The publish-effect
    // path flows through applyBlocksToYDoc → updateYMapFromBlock.
    const next = sampleBlocks.map((b) => b.id === 'b2' ? { ...b, depth: 2 } : b);
    applyBlocksToYDoc(ydoc, yOrder, yStore, next);

    const slotAfter = getYText(yStore, 'b2');
    // Slot identity is preserved AND the slot is still Y.XmlFragment —
    // the defensive fallback must not have replaced it with Y.Text.
    expect(slotAfter).toBe(slotBefore);
    expect(typeof slotAfter.toArray).toBe('function');
    expect(typeof slotAfter.toDelta).toBe('undefined');
    // Scalar field updated as expected.
    expect(getYMap(yStore, 'b2').get('depth')).toBe(2);
  });

  // PR #51 review (issue 2) — regression. blockToYMap previously seeded
  // a fresh Y.Text for the html slot; new blocks created via Enter / slash
  // menu in a v2 room would land as Y.Text in an otherwise-Y.XmlFragment
  // doc. The migration broker can't re-run (needsMigration short-circuits
  // on schemaVersion=2), so the new block is stranded on legacy substrate.
  it('new blocks created via applyBlocksToYDoc seed Y.XmlFragment, not Y.Text (issue 2)', () => {
    const { ydoc, yOrder, yStore } = makeDoc();
    seedYBlocks(ydoc, yOrder, yStore, sampleBlocks);

    const next = [
      ...sampleBlocks,
      { id: 'b-fresh', type: 'txt', part: 1, depth: 1, section: 'b1', html: '<b>fresh block</b>' },
    ];
    applyBlocksToYDoc(ydoc, yOrder, yStore, next);

    const slot = getYText(yStore, 'b-fresh');
    expect(typeof slot.toArray).toBe('function');
    expect(typeof slot.toDelta).toBe('undefined');
    // Round-trips through the v2 serializer (1c).
    expect(getBlockHtml(yStore, 'b-fresh')).toBe('<b>fresh block</b>');
  });

  it('seedYBlocks itself produces Y.XmlFragment slots for fresh rooms (issue 2 — initial seed path)', () => {
    const { ydoc, yOrder, yStore } = makeDoc();
    seedYBlocks(ydoc, yOrder, yStore, sampleBlocks);
    for (const b of sampleBlocks) {
      const slot = getYText(yStore, b.id);
      expect(typeof slot.toArray).toBe('function');
      expect(typeof slot.toDelta).toBe('undefined');
      expect(getBlockHtml(yStore, b.id)).toBe(b.html);
    }
  });
});

describe('collab — structural changes', () => {
  it('handles block insertion and preserves Y.Text identity for existing blocks', () => {
    const { ydoc, yOrder, yStore } = makeDoc();
    seedYBlocks(ydoc, yOrder, yStore, sampleBlocks);

    const b1Before = getYText(yStore, 'b1');
    const b2Before = getYText(yStore, 'b2');
    const b3Before = getYText(yStore, 'b3');

    const next = [
      sampleBlocks[0],
      { id: 'b-new', type: 'txt', part: 1, depth: 1, section: 'b1', html: 'Inserted' },
      sampleBlocks[1],
      sampleBlocks[2],
    ];
    applyBlocksToYDoc(ydoc, yOrder, yStore, next);
    expect(yOrder.length).toBe(4);
    expect(yBlocksToArray(yOrder, yStore).map((b) => b.id)).toEqual(['b1', 'b-new', 'b2', 'b3']);
    // Y.Text identity preserved for all existing blocks
    expect(getYText(yStore, 'b1')).toBe(b1Before);
    expect(getYText(yStore, 'b2')).toBe(b2Before);
    expect(getYText(yStore, 'b3')).toBe(b3Before);
  });

  it('handles block deletion and preserves Y.Text identity for remaining blocks', () => {
    const { ydoc, yOrder, yStore } = makeDoc();
    seedYBlocks(ydoc, yOrder, yStore, sampleBlocks);

    const b1Before = getYText(yStore, 'b1');
    const b3Before = getYText(yStore, 'b3');

    applyBlocksToYDoc(ydoc, yOrder, yStore, [sampleBlocks[0], sampleBlocks[2]]);

    expect(yOrder.length).toBe(2);
    expect(yBlocksToArray(yOrder, yStore).map((b) => b.id)).toEqual(['b1', 'b3']);
    expect(getYText(yStore, 'b1')).toBe(b1Before);
    expect(getYText(yStore, 'b3')).toBe(b3Before);
    expect(yStore.has('b2')).toBe(false);
  });

  it('same-transaction delete+reinsert of same ID updates in place (N6)', () => {
    const { ydoc, yOrder, yStore } = makeDoc();
    seedYBlocks(ydoc, yOrder, yStore, sampleBlocks);

    const b2MapBefore = getYMap(yStore, 'b2');
    const b2SlotBefore = getYText(yStore, 'b2');

    // Two-step under the post-1b contract: structural pass leaves html
    // alone, then setBlockHtml updates the binder-owned slot in place.
    applyBlocksToYDoc(ydoc, yOrder, yStore, sampleBlocks);
    setBlockHtml(yStore, 'b2', 'Brand new body for b2.');

    expect(getYMap(yStore, 'b2')).toBe(b2MapBefore);
    expect(getYText(yStore, 'b2')).toBe(b2SlotBefore);
    expect(getBlockHtml(yStore, 'b2')).toBe('Brand new body for b2.');
  });

  it('handles reorder and preserves all Y.Text + Y.Map identity (C1 regression)', () => {
    const { ydoc, yOrder, yStore } = makeDoc();
    seedYBlocks(ydoc, yOrder, yStore, sampleBlocks);

    const b1Before = getYText(yStore, 'b1');
    const b2Before = getYText(yStore, 'b2');
    const b3Before = getYText(yStore, 'b3');
    const b1MapBefore = getYMap(yStore, 'b1');
    const b2MapBefore = getYMap(yStore, 'b2');
    const b3MapBefore = getYMap(yStore, 'b3');

    applyBlocksToYDoc(ydoc, yOrder, yStore, [sampleBlocks[2], sampleBlocks[0], sampleBlocks[1]]);

    expect(yBlocksToArray(yOrder, yStore).map((b) => b.id)).toEqual(['b3', 'b1', 'b2']);
    // Y.Text identity preserved for every block
    expect(getYText(yStore, 'b1')).toBe(b1Before);
    expect(getYText(yStore, 'b2')).toBe(b2Before);
    expect(getYText(yStore, 'b3')).toBe(b3Before);
    // Y.Map identity preserved too
    expect(getYMap(yStore, 'b1')).toBe(b1MapBefore);
    expect(getYMap(yStore, 'b2')).toBe(b2MapBefore);
    expect(getYMap(yStore, 'b3')).toBe(b3MapBefore);
  });

  it('preserves a concurrent remote html edit across a local reorder', () => {
    const docA = makeDoc();
    const docB = makeDoc();
    seedYBlocks(docA.ydoc, docA.yOrder, docA.yStore, sampleBlocks);
    Y.applyUpdate(docB.ydoc, Y.encodeStateAsUpdate(docA.ydoc));

    // B writes to b2 via the binder substrate (post-1d Y.XmlFragment).
    setBlockHtml(docB.yStore, 'b2', 'B typed new body content.');

    // Concurrently, A reorders without touching b2's content.
    applyBlocksToYDoc(docA.ydoc, docA.yOrder, docA.yStore, [
      sampleBlocks[2], sampleBlocks[0], sampleBlocks[1],
    ]);

    // Cross-sync
    Y.applyUpdate(docB.ydoc, Y.encodeStateAsUpdate(docA.ydoc, Y.encodeStateVector(docB.ydoc)));
    Y.applyUpdate(docA.ydoc, Y.encodeStateAsUpdate(docB.ydoc, Y.encodeStateVector(docA.ydoc)));

    const finalA = yBlocksToArray(docA.yOrder, docA.yStore);
    const finalB = yBlocksToArray(docB.yOrder, docB.yStore);
    expect(finalA).toEqual(finalB);
    expect(finalA.map((b) => b.id)).toEqual(['b3', 'b1', 'b2']);
    // B's concurrent edit to b2 survived the reorder.
    const b2 = finalA.find((b) => b.id === 'b2');
    expect(b2.html).toBe('B typed new body content.');
  });
});

describe('collab — two-doc sync (CRDT merge)', () => {
  it('propagates updates and merges concurrent edits on different blocks', () => {
    // Propagation test
    const docA = makeDoc();
    const docB = makeDoc();
    seedYBlocks(docA.ydoc, docA.yOrder, docA.yStore, sampleBlocks);
    const updateSeed = Y.encodeStateAsUpdate(docA.ydoc);
    Y.applyUpdate(docB.ydoc, updateSeed);

    // Post-1b: html updates on existing blocks go through setBlockHtml,
    // not applyBlocksToYDoc.
    setBlockHtml(docA.yStore, 'b2', 'A typed this.');
    const update = Y.encodeStateAsUpdate(docA.ydoc, Y.encodeStateVector(docB.ydoc));
    Y.applyUpdate(docB.ydoc, update);
    const mirrorB = yBlocksToArray(docB.yOrder, docB.yStore);
    expect(mirrorB[1].html).toBe('A typed this.');
    expect(mirrorB.map((b) => b.id)).toEqual(['b1', 'b2', 'b3']);

    // Concurrent merge test — reset docs
    const docC = makeDoc();
    const docD = makeDoc();
    seedYBlocks(docC.ydoc, docC.yOrder, docC.yStore, sampleBlocks);
    Y.applyUpdate(docD.ydoc, Y.encodeStateAsUpdate(docC.ydoc));

    setBlockHtml(docC.yStore, 'b1', 'EARTHWORK');
    setBlockHtml(docD.yStore, 'b3', 'B edited item.');
    Y.applyUpdate(docD.ydoc, Y.encodeStateAsUpdate(docC.ydoc, Y.encodeStateVector(docD.ydoc)));
    Y.applyUpdate(docC.ydoc, Y.encodeStateAsUpdate(docD.ydoc, Y.encodeStateVector(docC.ydoc)));

    const finalC = yBlocksToArray(docC.yOrder, docC.yStore);
    const finalD = yBlocksToArray(docD.yOrder, docD.yStore);
    expect(finalC).toEqual(finalD);
    expect(finalC[0].html).toBe('EARTHWORK');
    expect(finalC[2].html).toBe('B edited item.');
  });

  it('no-op publish does not grow Y.UndoManager stack (I2, I-2)', () => {
    // Test 1: content-equal blocks via applyBlocksToYDoc
    const { ydoc, yOrder, yStore } = makeDoc();
    seedYBlocks(ydoc, yOrder, yStore, sampleBlocks);

    const undoManager = new Y.UndoManager([yOrder, yStore], {
      trackedOrigins: new Set(['local-publish']),
    });
    expect(undoManager.undoStack.length).toBe(0);

    const clonedContentEqual = sampleBlocks.map((b) => ({ ...b }));
    ydoc.transact(() => {
      applyBlocksToYDoc(ydoc, yOrder, yStore, clonedContentEqual);
    }, 'local-publish');
    expect(undoManager.undoStack.length).toBe(0);

    // Sanity: a genuine local edit DOES grow the stack. Post-1b, html
    // edits go through setBlockHtml (which uses 'local-publish' origin).
    setBlockHtml(yStore, 'b1', 'CHANGED');
    expect(undoManager.undoStack.length).toBe(1);

    // Test 2: zero-change publish after remote-applied clone (I-2)
    const doc2 = new Y.Doc();
    const yOrder2 = doc2.getArray('order');
    const yStore2 = doc2.getMap('store');
    const undoMgr2 = new Y.UndoManager([yOrder2, yStore2], {
      trackedOrigins: new Set(['local-publish']),
    });
    const initial = [{ id: 'n1', type: 'txt', html: 'hello' }];
    seedYBlocks(doc2, yOrder2, yStore2, initial);
    const remoteClone = yBlocksToArray(yOrder2, yStore2).map((b) => ({ ...b }));
    doc2.transact(() => {
      applyBlocksToYDoc(doc2, yOrder2, yStore2, remoteClone);
    }, 'local-publish');
    expect(undoMgr2.undoStack.length).toBe(0);
  });

  it('Y.UndoManager scoped to local origin does not revert remote edits (M2)', () => {
    const docA = makeDoc();
    const docB = makeDoc();
    seedYBlocks(docA.ydoc, docA.yOrder, docA.yStore, sampleBlocks);
    Y.applyUpdate(docB.ydoc, Y.encodeStateAsUpdate(docA.ydoc));

    const undoA = new Y.UndoManager([docA.yOrder, docA.yStore], {
      trackedOrigins: new Set(['local-publish']),
    });

    // A publishes a local edit on b1 (via the binder substrate path).
    setBlockHtml(docA.yStore, 'b1', 'Alice edit.');

    // B edits b2 locally and sync A←B
    setBlockHtml(docB.yStore, 'b2', 'Bob edit.');
    Y.applyUpdate(docA.ydoc, Y.encodeStateAsUpdate(docB.ydoc, Y.encodeStateVector(docA.ydoc)));

    const beforeUndo = yBlocksToArray(docA.yOrder, docA.yStore);
    expect(beforeUndo.find((b) => b.id === 'b1').html).toBe('Alice edit.');
    expect(beforeUndo.find((b) => b.id === 'b2').html).toBe('Bob edit.');

    // Alice hits Ctrl+Z
    undoA.undo();

    const afterUndo = yBlocksToArray(docA.yOrder, docA.yStore);
    expect(afterUndo.find((b) => b.id === 'b1').html).toBe('GENERAL');
    // Bob's edit is PRESERVED
    expect(afterUndo.find((b) => b.id === 'b2').html).toBe('Bob edit.');
  });
});

describe('collab — document size guard (M7)', () => {
  it('estimatePublishBytes + DocSizeLimitError + MAX_PUBLISH_BYTES', () => {
    // estimatePublishBytes counts ids, types, html, and serialized table/ref
    const blocks = [
      { id: 'b1', type: 'txt', html: 'hello world' },
      { id: 'b2', type: 'table', html: '', table: { rows: [['a', 'b'], ['c', 'd']] } },
    ];
    const bytes = estimatePublishBytes(blocks);
    expect(bytes).toBeGreaterThan(0);
    expect(bytes).toBeLessThan(1024);

    // Returns 0 for non-array input
    expect(estimatePublishBytes(null)).toBe(0);
    expect(estimatePublishBytes(undefined)).toBe(0);
    expect(estimatePublishBytes({})).toBe(0);

    // DocSizeLimitError carries the actual and max byte counts
    const err = new DocSizeLimitError(12345, 8 * 1024 * 1024);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('DocSizeLimitError');
    expect(err.actualBytes).toBe(12345);
    expect(err.maxBytes).toBe(8 * 1024 * 1024);

    // MAX_PUBLISH_BYTES is half of the server snapshot cap (A6 wire overhead)
    const SERVER_CAP = 8 * 1024 * 1024;
    expect(MAX_PUBLISH_BYTES).toBe(SERVER_CAP / 2);
  });
});

describe('collab — yMeta (M3)', () => {
  it('readYMeta returns empty object for empty map and snapshots scalar keys', () => {
    const ydoc = new Y.Doc();
    expect(readYMeta(ydoc.getMap('meta'))).toEqual({});

    const yMeta = ydoc.getMap('meta');
    yMeta.set('sectionNumber', '31 00 00');
    yMeta.set('sectionTitle', 'EARTHWORK');
    yMeta.set('date', '08/23');
    expect(readYMeta(yMeta)).toEqual({
      sectionNumber: '31 00 00',
      sectionTitle: 'EARTHWORK',
      date: '08/23',
    });
  });

  it('local meta edit after remote update propagates + first-join guard (A1, I-3)', () => {
    // A1 regression: local meta edits after remote snapshot must propagate
    const docA = new Y.Doc();
    const docB = new Y.Doc();
    const metaA = docA.getMap('meta');
    const metaB = docB.getMap('meta');

    docB.transact(() => {
      metaB.set('sectionNumber', '31 00 00');
      metaB.set('sectionTitle', 'EARTHWORK');
      metaB.set('date', '08/23');
      metaB.set('fileName', '31_00_00.SEC');
    });

    Y.applyUpdate(docA, Y.encodeStateAsUpdate(docB));
    expect(readYMeta(metaA)).toEqual({
      sectionNumber: '31 00 00',
      sectionTitle: 'EARTHWORK',
      date: '08/23',
      fileName: '31_00_00.SEC',
    });

    docA.transact(() => { metaA.set('sectionTitle', 'STRUCTURAL STEEL'); }, 'local-meta');
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA, Y.encodeStateVector(docB)));

    expect(metaB.get('sectionTitle')).toBe('STRUCTURAL STEEL');
    expect(metaB.get('sectionNumber')).toBe('31 00 00');
    expect(metaB.get('fileName')).toBe('31_00_00.SEC');

    // I-3: publishMeta does not overwrite existing remote meta on first join
    const docC = new Y.Doc();
    const metaC = docC.getMap('meta');
    docC.transact(() => { metaC.set('sectionNumber', '03 30 00'); }, 'seed');

    const docD = new Y.Doc();
    Y.applyUpdate(docD, Y.encodeStateAsUpdate(docC));
    expect(docD.getMap('meta').get('sectionNumber')).toBe('03 30 00');

    Y.applyUpdate(docC, Y.encodeStateAsUpdate(docD));
    expect(metaC.get('sectionNumber')).toBe('03 30 00');
  });

  it('yMeta updates propagate across two docs (CRDT merge)', () => {
    const docA = new Y.Doc();
    const docB = new Y.Doc();
    const metaA = docA.getMap('meta');
    const metaB = docB.getMap('meta');

    metaA.set('sectionTitle', 'EARTHWORK');
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));
    expect(readYMeta(metaB)).toEqual({ sectionTitle: 'EARTHWORK' });

    metaB.set('sectionTitle', 'STRUCTURAL STEEL');
    Y.applyUpdate(docA, Y.encodeStateAsUpdate(docB, Y.encodeStateVector(docA)));
    expect(readYMeta(metaA)).toEqual({ sectionTitle: 'STRUCTURAL STEEL' });
  });
});

describe('collab — I-1 roadmap', () => {
  it.skip('same-block concurrent typing merges character-by-character (I-1 roadmap)', () => {
    const docA = new Y.Doc();
    const orderA = docA.getArray('order');
    const storeA = docA.getMap('store');

    const docB = new Y.Doc();
    const orderB = docB.getArray('order');
    const storeB = docB.getMap('store');

    seedYBlocks(docA, orderA, storeA, [{ id: 'n1', type: 'txt', html: 'hello' }]);
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));

    const aliceText = storeA.get('n1').get('html');
    aliceText.insert(aliceText.length, ' world');

    const bobText = storeB.get('n1').get('html');
    bobText.insert(0, 'HI ');

    Y.applyUpdate(docA, Y.encodeStateAsUpdate(docB));
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));

    expect(storeA.get('n1').get('html').toString()).toBe('HI hello world');
    expect(storeB.get('n1').get('html').toString()).toBe('HI hello world');
  });
});

describe('collab — createCollabSession + URL helpers', () => {
  it('handleAfterTx treats any "local-" origin as local (M-1)', async () => {
    const events = [];
    const session = createCollabSession({
      room: 'test-m1',
      wsUrl: 'ws://127.0.0.1:9',
      identity: { id: 'u', name: 'U', color: '#000' },
      initialBlocks: [{ id: 'n1', type: 'txt', html: 'x' }],
      onRemoteBlocks: () => events.push('blocks'),
      onRemoteMeta: () => events.push('meta'),
    });

    session.ydoc.transact(() => {
      session.yStore.set('n1', (() => {
        const m = new Y.Map();
        m.set('id', 'n1');
        m.set('type', 'txt');
        const t = new Y.Text();
        t.insert(0, 'x');
        m.set('html', t);
        return m;
      })());
      session.yOrder.push(['n1']);
    }, 'local-custom-path');

    session.ydoc.transact(() => {
      const t = session.yStore.get('n1').get('html');
      t.delete(0, t.length);
      t.insert(0, 'y');
    }, 'local-custom-path');

    expect(events).not.toContain('blocks');
    session.destroy();
  });

  it('publishBlocks throws DocSizeLimitError and recovers + publishMeta echo guard (M-7, M-8)', () => {
    // M-7: size limit
    const session = createCollabSession({
      room: 'test-m7',
      wsUrl: 'ws://127.0.0.1:9',
      identity: { id: 'u', name: 'U', color: '#000' },
      initialBlocks: [],
      onRemoteBlocks: () => {},
      onRemoteMeta: () => {},
    });
    const big = 'x'.repeat(MAX_PUBLISH_BYTES + 1024);
    const over = [{ id: 'n1', type: 'txt', html: big }];
    expect(() => session.publishBlocks(over)).toThrow(DocSizeLimitError);
    const under = [{ id: 'n1', type: 'txt', html: 'small' }];
    expect(() => session.publishBlocks(under)).not.toThrow();
    expect(getBlockHtml(session.yStore, 'n1')).toBe('small');
    session.destroy();

    // M-8: publishMeta does not echo through onRemoteMeta
    let metaCalls = 0;
    const session2 = createCollabSession({
      room: 'test-m8',
      wsUrl: 'ws://127.0.0.1:9',
      identity: { id: 'u', name: 'U', color: '#000' },
      initialBlocks: [],
      initialMeta: { sectionNumber: '01 00 00' },
      onRemoteBlocks: () => {},
      onRemoteMeta: (_m, meta) => { if (!meta?.initial) metaCalls++; },
    });
    session2.publishMeta({ sectionNumber: '02 00 00' });
    expect(metaCalls).toBe(0);
    expect(session2.yMeta.get('sectionNumber')).toBe('02 00 00');
    session2.destroy();
  });

  it('URL helpers: generateRoomId + buildRoomUrl', () => {
    for (let i = 0; i < 10; i++) {
      const id = generateRoomId();
      expect(id).toMatch(/^[a-z0-9]+$/);
      expect(id.length).toBeGreaterThan(0);
      expect(id.length).toBeLessThanOrEqual(8);
    }
    const url = buildRoomUrl('abc123');
    expect(url).toContain('room=abc123');

    // stripRoomFromUrl removes ?room and preserves other query params.
    expect(stripRoomFromUrl('https://x.test/?room=abc123')).toBe('https://x.test/');
    expect(stripRoomFromUrl('https://x.test/?room=abc&foo=1')).toBe('https://x.test/?foo=1');
    expect(stripRoomFromUrl('https://x.test/?foo=1')).toBe('https://x.test/?foo=1'); // no room param: unchanged
  });
});

describe('shared Track Changes (M-shared-tc)', () => {
  function makeDocWithTc() {
    const ydoc = new Y.Doc();
    const yOrder = ydoc.getArray('order');
    const yStore = ydoc.getMap('store');
    const yTc = ydoc.getMap('tc');
    return { ydoc, yOrder, yStore, yTc };
  }

  // ── Q37 (#47 sub-PR 1h) — wire payload shrink ──────────────────────────
  //
  // publishTcToDoc writes only `enabled`. The legacy `snapshots` Y.Map is
  // left UNTOUCHED so pre-1h peers' data round-trips cleanly through a 1h
  // client. readTc still emits { enabled, snapshots } for backward compat
  // with pre-1h schemas, but `snapshots` is ignored by post-1h App code
  // (the reducer's applyRemote drops it).
  //
  // No schemaVersion bump in 1h — pre-1h clients can join post-1h rooms
  // in degraded edit-fidelity mode. 1i bumps schemaVersion to 3.

  // Helper: seed a pre-1h-shaped yTc (snapshots Y.Map present) directly,
  // bypassing publishTcToDoc — used to assert that 1h clients don't touch
  // legacy snapshots data they encounter in mixed-version rooms.
  function seedPre1hSnapshots(ydoc, yTc, snaps) {
    ydoc.transact(() => {
      const m = new Y.Map();
      for (const [k, v] of Object.entries(snaps)) m.set(k, v);
      yTc.set('snapshots', m);
      yTc.set('enabled', true);
    }, 'pre-1h-write');
  }

  it('publishTc writes ONLY the enabled flag — under local-tc origin, ignores snapshots arg, leaves pre-existing snapshots Y.Map untouched', () => {
    // Single-doc behavior bundle: origin, enabled-only write, payload tolerance, pre-1h survival.
    const { ydoc, yTc } = makeDocWithTc();
    const origins = [];
    ydoc.on('afterTransaction', (tx) => { origins.push(tx.origin); });

    // (1) Fresh doc — publishTc writes enabled and nothing else.
    publishTcToDoc(ydoc, yTc, { enabled: true });
    expect(yTc.get('enabled')).toBe(true);
    expect(origins).toContain('local-tc');
    expect(yTc.get('snapshots')).toBeUndefined();

    // (2) Tolerates a stray snapshots field in the payload (defensive: a
    // wrongly-wired getPublishableState must not corrupt the wire).
    publishTcToDoc(ydoc, yTc, { enabled: true, snapshots: { n1: 'should-not-write' } });
    expect(yTc.get('snapshots')).toBeUndefined();

    // (3) Pre-1h-populated snapshots survive a 1h client's disable.
    const { ydoc: ydoc2, yTc: yTc2 } = makeDocWithTc();
    seedPre1hSnapshots(ydoc2, yTc2, { n1: 'pre-1h text', n2: 'more pre-1h text' });
    publishTcToDoc(ydoc2, yTc2, { enabled: false });
    expect(yTc2.get('enabled')).toBe(false);
    const snaps = yTc2.get('snapshots');
    expect(snaps.size).toBe(2);
    expect(snaps.get('n1')).toBe('pre-1h text');
    expect(snaps.get('n2')).toBe('more pre-1h text');
  });

  it('readTc emits { enabled, snapshots } for pre-1h backward compat — surfaces pre-1h snapshots, returns empty {} when absent', () => {
    // Pre-1h-shaped state — readTc surfaces the snapshots map.
    const { ydoc, yTc } = makeDocWithTc();
    seedPre1hSnapshots(ydoc, yTc, { n1: 'Hello', n2: 'World' });
    expect(readTc(yTc)).toEqual({ enabled: true, snapshots: { n1: 'Hello', n2: 'World' } });

    // Post-1h-only room — readTc emits the same shape with empty snapshots.
    const { ydoc: ydoc2, yTc: yTc2 } = makeDocWithTc();
    publishTcToDoc(ydoc2, yTc2, { enabled: true });
    expect(readTc(yTc2)).toEqual({ enabled: true, snapshots: {} });
  });

  it('two-doc merge: enabled flag propagates between 1h peers AND a 1h-side disable does not delete a pre-1h peer\'s snapshots', () => {
    // (1) Plain enabled propagation between two 1h peers.
    const { ydoc: docA, yTc: tcA } = makeDocWithTc();
    const { ydoc: docB, yTc: tcB } = makeDocWithTc();
    publishTcToDoc(docA, tcA, { enabled: true });
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));
    expect(readTc(tcB).enabled).toBe(true);
    publishTcToDoc(docB, tcB, { enabled: false });
    Y.applyUpdate(docA, Y.encodeStateAsUpdate(docB));
    expect(readTc(tcA).enabled).toBe(false);

    // (2) Mixed-version: pre-1h peer has snapshots; 1h peer disables.
    // Snapshots must survive on both sides post-merge.
    const { ydoc: docC, yTc: tcC } = makeDocWithTc();
    const { ydoc: docD, yTc: tcD } = makeDocWithTc();
    seedPre1hSnapshots(docC, tcC, { n1: 'pre-1h' });
    Y.applyUpdate(docD, Y.encodeStateAsUpdate(docC));
    expect(readTc(tcD).snapshots).toEqual({ n1: 'pre-1h' });
    publishTcToDoc(docD, tcD, { enabled: false });
    Y.applyUpdate(docC, Y.encodeStateAsUpdate(docD));
    Y.applyUpdate(docD, Y.encodeStateAsUpdate(docC));
    expect(readTc(tcC)).toEqual({ enabled: false, snapshots: { n1: 'pre-1h' } });
    expect(readTc(tcD)).toEqual({ enabled: false, snapshots: { n1: 'pre-1h' } });
  });

  it('handleAfterTx routes pure-TC transactions through onRemoteTc (not onRemoteBlocks)', async () => {
    const ydoc = new Y.Doc();
    const yOrder = ydoc.getArray('order');
    const yStore = ydoc.getMap('store');
    const yMeta = ydoc.getMap('meta');
    const yTc = ydoc.getMap('tc');
    const yComments = ydoc.getMap('comments');

    const calls = { blocks: 0, meta: 0, tc: 0, comments: 0 };
    ydoc.on('afterTransaction', (tx) => {
      const origin = tx.origin;
      if (typeof origin === 'string' && origin.startsWith('local-')) return;
      if (origin === 'seed') return;
      if (tx.changed.size === 0 && tx.changedParentTypes.size === 0) return;
      const cpt = tx.changedParentTypes;
      const ch = tx.changed;
      if (cpt.has(yOrder) || cpt.has(yStore) || ch.has(yOrder) || ch.has(yStore)) calls.blocks++;
      if (cpt.has(yMeta) || ch.has(yMeta)) calls.meta++;
      if (cpt.has(yTc) || ch.has(yTc)) calls.tc++;
      if (cpt.has(yComments) || ch.has(yComments)) calls.comments++;
    });

    const peer = new Y.Doc();
    const peerTc = peer.getMap('tc');
    peer.transact(() => {
      peerTc.set('enabled', true);
    }, 'local-tc');
    Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(peer));

    expect(calls.tc).toBeGreaterThan(0);
    expect(calls.blocks).toBe(0);
    expect(calls.meta).toBe(0);
    expect(calls.comments).toBe(0);
  });
});

describe('shared Comments (M-shared-comments)', () => {
  function makeDocWithComments() {
    const ydoc = new Y.Doc();
    const yComments = ydoc.getMap('comments');
    return { ydoc, yComments };
  }

  const ALICE = { id: 'u-alice', name: 'Alice', color: '#7a3' };
  const BOB = { id: 'u-bob', name: 'Bob', color: '#37a' };

  function sampleCommentPayload(overrides = {}) {
    return {
      blockId: 'n1',
      status: 'open',
      highlightText: 'the quick fox',
      createdAt: 1712600000000,
      author: ALICE,
      initialText: 'Please rewrite',
      ...overrides,
    };
  }

  it('CRUD: publish, reply, status change, delete, and readComments', () => {
    const { ydoc, yComments } = makeDocWithComments();

    // Create
    publishCommentToDoc(ydoc, yComments, 'c-1', sampleCommentPayload());
    const cMap = yComments.get('c-1');
    expect(cMap.get('blockId')).toBe('n1');
    expect(cMap.get('status')).toBe('open');
    expect(cMap.get('highlightText')).toBe('the quick fox');
    expect(cMap.get('authorId')).toBe('u-alice');
    expect(cMap.get('authorName')).toBe('Alice');
    expect(cMap.get('authorColor')).toBe('#7a3');
    const entries = cMap.get('entries');
    expect(entries.length).toBe(1);
    expect(entries.get(0).get('type')).toBe('create');
    expect(entries.get(0).get('text')).toBe('Please rewrite');
    expect(entries.get(0).get('authorId')).toBe('u-alice');

    // Reply
    publishCommentReplyToDoc(ydoc, yComments, 'c-1', {
      author: BOB, text: 'Agreed', ts: 1712600001000,
    });
    const entries2 = yComments.get('c-1').get('entries');
    expect(entries2.length).toBe(2);
    expect(entries2.get(1).get('type')).toBe('reply');
    expect(entries2.get(1).get('text')).toBe('Agreed');
    expect(entries2.get(1).get('authorName')).toBe('Bob');

    // Status change
    publishCommentStatusToDoc(ydoc, yComments, 'c-1', 'resolved', { author: BOB, ts: 100 });
    expect(yComments.get('c-1').get('status')).toBe('resolved');
    const entries3 = yComments.get('c-1').get('entries');
    expect(entries3.get(entries3.length - 1).get('type')).toBe('resolve');
    expect(entries3.get(entries3.length - 1).get('authorName')).toBe('Bob');

    // readComments
    const out = readComments(yComments);
    expect(out['c-1']).toMatchObject({
      blockId: 'n1',
      status: 'resolved',
      authorName: 'Alice',
    });
    expect(Array.isArray(out['c-1'].entries)).toBe(true);
    expect(out['c-1'].entries.length).toBe(3);

    // Delete
    deleteCommentFromDoc(ydoc, yComments, 'c-1');
    expect(yComments.has('c-1')).toBe(false);
  });

  it('two-doc merge: replies, concurrent replies, resolve+reply, and delete propagate', () => {
    // Reply from B appears in A
    const { ydoc: docA, yComments: cA } = makeDocWithComments();
    const { ydoc: docB, yComments: cB } = makeDocWithComments();
    publishCommentToDoc(docA, cA, 'c-1', sampleCommentPayload());
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));
    publishCommentReplyToDoc(docB, cB, 'c-1', {
      author: BOB, text: 'From Bob', ts: 100,
    });
    Y.applyUpdate(docA, Y.encodeStateAsUpdate(docB));
    const readA = readComments(cA);
    expect(readA['c-1'].entries.length).toBe(2);
    expect(readA['c-1'].entries[1].text).toBe('From Bob');

    // Concurrent replies from A and B both land
    const { ydoc: docC, yComments: cC } = makeDocWithComments();
    const { ydoc: docD, yComments: cD } = makeDocWithComments();
    publishCommentToDoc(docC, cC, 'c-1', sampleCommentPayload());
    Y.applyUpdate(docD, Y.encodeStateAsUpdate(docC));
    publishCommentReplyToDoc(docC, cC, 'c-1', { author: ALICE, text: 'From Alice', ts: 1 });
    publishCommentReplyToDoc(docD, cD, 'c-1', { author: BOB, text: 'From Bob', ts: 2 });
    Y.applyUpdate(docD, Y.encodeStateAsUpdate(docC));
    Y.applyUpdate(docC, Y.encodeStateAsUpdate(docD));
    const outC = readComments(cC);
    const outD = readComments(cD);
    expect(outC['c-1'].entries.length).toBe(3);
    expect(outD['c-1'].entries.length).toBe(3);
    const textsC = outC['c-1'].entries.map((e) => e.text).sort();
    expect(textsC).toContain('From Alice');
    expect(textsC).toContain('From Bob');

    // A resolves while B replies — both effects survive
    const { ydoc: docE, yComments: cE } = makeDocWithComments();
    const { ydoc: docF, yComments: cF } = makeDocWithComments();
    publishCommentToDoc(docE, cE, 'c-1', sampleCommentPayload());
    Y.applyUpdate(docF, Y.encodeStateAsUpdate(docE));
    publishCommentStatusToDoc(docE, cE, 'c-1', 'resolved', { author: ALICE, ts: 1 });
    publishCommentReplyToDoc(docF, cF, 'c-1', { author: BOB, text: 'Wait', ts: 2 });
    Y.applyUpdate(docF, Y.encodeStateAsUpdate(docE));
    Y.applyUpdate(docE, Y.encodeStateAsUpdate(docF));
    const outE = readComments(cE);
    expect(outE['c-1'].status).toBe('resolved');
    expect(outE['c-1'].entries.map((e) => e.text)).toContain('Wait');

    // Delete on A removes entry on B after sync
    const { ydoc: docG, yComments: cG } = makeDocWithComments();
    const { ydoc: docH, yComments: cH } = makeDocWithComments();
    publishCommentToDoc(docG, cG, 'c-1', sampleCommentPayload());
    Y.applyUpdate(docH, Y.encodeStateAsUpdate(docG));
    expect(cH.has('c-1')).toBe(true);
    deleteCommentFromDoc(docG, cG, 'c-1');
    Y.applyUpdate(docH, Y.encodeStateAsUpdate(docG));
    expect(cH.has('c-1')).toBe(false);
  });

  it('publishCommentReplyToDoc uses local-comments origin', () => {
    const { ydoc, yComments } = makeDocWithComments();
    publishCommentToDoc(ydoc, yComments, 'c-1', sampleCommentPayload());
    const origins = [];
    ydoc.on('afterTransaction', (tx) => { origins.push(tx.origin); });
    publishCommentReplyToDoc(ydoc, yComments, 'c-1', { author: BOB, text: 'hi', ts: 1 });
    expect(origins).toContain('local-comments');
  });
});

describe('character-level CRDT merge (attribute-aware)', () => {
  it('concurrent text edits + mark additions on same block merge via Y.Text attributes', () => {
    const { ydoc: doc1, yOrder: o1, yStore: s1 } = makeDoc();
    const { ydoc: doc2, yOrder: o2, yStore: s2 } = makeDoc();

    // Test 1: concurrent text edit + formatting
    const blocks = [
      { id: 'b1', type: 'txt', part: 1, depth: 1, section: 's1', html: 'Hello world' },
    ];
    seedYBlocks(doc1, o1, s1, blocks);
    Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1, Y.encodeStateVector(doc2)));

    // Post-1b: html updates on existing blocks go through setBlockHtml.
    setBlockHtml(s1, 'b1', 'Hello <b>world</b>');
    setBlockHtml(s2, 'b1', 'Hello world today');

    let update1 = Y.encodeStateAsUpdate(doc1, Y.encodeStateVector(doc2));
    let update2 = Y.encodeStateAsUpdate(doc2, Y.encodeStateVector(doc1));
    Y.applyUpdate(doc1, update2);
    Y.applyUpdate(doc2, update1);

    const result1 = yBlocksToArray(o1, s1);
    const result2 = yBlocksToArray(o2, s2);
    expect(result1[0].html).toBe(result2[0].html);
    const plainText = result1[0].html.replace(/<[^>]+>/g, '');
    expect(result1[0].html).toContain('<b>');
    expect(plainText).toContain('world');
    expect(plainText).toContain('today');

    // Test 2: concurrent mark addition on different words
    const { ydoc: doc3, yOrder: o3, yStore: s3 } = makeDoc();
    const { ydoc: doc4, yOrder: o4, yStore: s4 } = makeDoc();

    const blocks2 = [
      { id: 'b1', type: 'txt', part: 1, depth: 1, section: 's1', html: 'See ASTM C33 and 01 33 00' },
    ];
    seedYBlocks(doc3, o3, s3, blocks2);
    Y.applyUpdate(doc4, Y.encodeStateAsUpdate(doc3, Y.encodeStateVector(doc4)));

    setBlockHtml(s3, 'b1', 'See <span class="mark-rid">ASTM C33</span> and 01 33 00');
    setBlockHtml(s4, 'b1', 'See ASTM C33 and <span class="mark-srf">01 33 00</span>');

    update1 = Y.encodeStateAsUpdate(doc3, Y.encodeStateVector(doc4));
    update2 = Y.encodeStateAsUpdate(doc4, Y.encodeStateVector(doc3));
    Y.applyUpdate(doc3, update2);
    Y.applyUpdate(doc4, update1);

    const result3 = yBlocksToArray(o3, s3);
    const result4 = yBlocksToArray(o4, s4);
    expect(result3[0].html).toBe(result4[0].html);
    expect(result3[0].html).toContain('mark-rid');
    expect(result3[0].html).toContain('mark-srf');
  });
});

describe('fine-grained table/REF sync', () => {
  it('concurrent cell edits, ref entry additions, and legacy JSON compat', () => {
    // Concurrent cell edits merge
    const { ydoc: doc1, yOrder: o1, yStore: s1 } = makeDoc();
    const { ydoc: doc2, yOrder: o2, yStore: s2 } = makeDoc();

    const table = {
      columns: 2,
      rows: [
        [{ text: 'A1', colspan: 1 }, { text: 'B1', colspan: 1 }],
        [{ text: 'A2', colspan: 1 }, { text: 'B2', colspan: 1 }],
      ],
    };
    const blocks = [{ id: 't1', type: 'table', part: 1, depth: 1, section: 's1', html: '', table }];

    seedYBlocks(doc1, o1, s1, blocks);
    Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1, Y.encodeStateVector(doc2)));

    const t1 = { ...table, rows: [[{ text: 'Doc1', colspan: 1 }, { text: 'B1', colspan: 1 }], table.rows[1]] };
    applyBlocksToYDoc(doc1, o1, s1, [{ ...blocks[0], table: t1 }]);

    const t2 = { ...table, rows: [table.rows[0], [{ text: 'A2', colspan: 1 }, { text: 'Doc2', colspan: 1 }]] };
    applyBlocksToYDoc(doc2, o2, s2, [{ ...blocks[0], table: t2 }]);

    const u1 = Y.encodeStateAsUpdate(doc1, Y.encodeStateVector(doc2));
    const u2 = Y.encodeStateAsUpdate(doc2, Y.encodeStateVector(doc1));
    Y.applyUpdate(doc1, u2);
    Y.applyUpdate(doc2, u1);

    const r1 = yBlocksToArray(o1, s1);
    const r2 = yBlocksToArray(o2, s2);
    expect(r1[0].table.rows[0][0].text).toBe('Doc1');
    expect(r1[0].table.rows[1][1].text).toBe('Doc2');
    expect(JSON.stringify(r1[0].table)).toBe(JSON.stringify(r2[0].table));

    // Concurrent ref entry additions merge
    const { ydoc: doc3, yOrder: o3, yStore: s3 } = makeDoc();
    const { ydoc: doc4, yOrder: o4, yStore: s4 } = makeDoc();

    const ref = { org: 'ASTM', entries: [{ rid: 'C33', rtl: 'Aggregates' }] };
    const refBlocks = [{ id: 'r1', type: 'ref', part: 1, depth: 1, section: 's1', html: '', ref }];

    seedYBlocks(doc3, o3, s3, refBlocks);
    Y.applyUpdate(doc4, Y.encodeStateAsUpdate(doc3, Y.encodeStateVector(doc4)));

    const ref1 = { ...ref, entries: [...ref.entries, { rid: 'D698', rtl: 'Compaction' }] };
    applyBlocksToYDoc(doc3, o3, s3, [{ ...refBlocks[0], ref: ref1 }]);

    const ref2 = { ...ref, entries: [...ref.entries, { rid: 'D2487', rtl: 'Soils' }] };
    applyBlocksToYDoc(doc4, o4, s4, [{ ...refBlocks[0], ref: ref2 }]);

    const u3 = Y.encodeStateAsUpdate(doc3, Y.encodeStateVector(doc4));
    const u4 = Y.encodeStateAsUpdate(doc4, Y.encodeStateVector(doc3));
    Y.applyUpdate(doc3, u4);
    Y.applyUpdate(doc4, u3);

    const r3 = yBlocksToArray(o3, s3);
    const r4 = yBlocksToArray(o4, s4);
    expect(r3[0].ref.entries.length).toBe(3);
    expect(r3[0].ref.entries.length).toBe(r4[0].ref.entries.length);

    // Backward compat: reads legacy JSON-string table as plain data
    const { ydoc: doc5, yOrder: o5, yStore: s5 } = makeDoc();
    const legacyTable = { columns: 1, rows: [[{ text: 'cell', colspan: 1 }]] };
    doc5.transact(() => {
      const yMap = new Y.Map();
      yMap.set('id', 'legacy');
      yMap.set('type', 'table');
      yMap.set('table', JSON.stringify(legacyTable));
      const yText = new Y.Text();
      yText.insert(0, '');
      yMap.set('html', yText);
      s5.set('legacy', yMap);
      o5.push(['legacy']);
    });
    const legacyBlocks = yBlocksToArray(o5, s5);
    expect(legacyBlocks[0].table).toEqual(legacyTable);
  });
});
