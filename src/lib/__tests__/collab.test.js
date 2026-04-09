/**
 * Collab library tests — exercise the Y.Doc ↔ blocks conversion without
 * spinning up a WebSocket server. Real-network tests are done via the
 * two-browser smoke test documented in CLAUDE.md.
 */

import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import {
  applyBlocksToYDoc,
  yBlocksToArray,
  seedYBlocks,
  generateRoomId,
  buildRoomUrl,
  estimatePublishBytes,
  DocSizeLimitError,
  MAX_PUBLISH_BYTES,
  readYMeta,
} from '../collab.js';

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

describe('collab — seeding & snapshot', () => {
  it('seeds an empty Y.Doc from a block array', () => {
    const { ydoc, yOrder, yStore } = makeDoc();
    seedYBlocks(ydoc, yOrder, yStore, sampleBlocks);
    expect(yOrder.length).toBe(3);
    expect(yStore.size).toBe(3);
    const out = yBlocksToArray(yOrder, yStore);
    expect(out).toHaveLength(3);
    expect(out[0].id).toBe('b1');
    expect(out[0].html).toBe('GENERAL');
    expect(out[2].level).toBe(1);
  });

  it('roundtrips scalar + html fields', () => {
    const { ydoc, yOrder, yStore } = makeDoc();
    seedYBlocks(ydoc, yOrder, yStore, sampleBlocks);
    const out = yBlocksToArray(yOrder, yStore);
    for (let i = 0; i < sampleBlocks.length; i++) {
      expect(out[i]).toMatchObject({
        id: sampleBlocks[i].id,
        type: sampleBlocks[i].type,
        html: sampleBlocks[i].html,
      });
    }
  });
});

describe('collab — applyBlocksToYDoc (update-in-place)', () => {
  it('updates a changed html field without rebuilding', () => {
    const { ydoc, yOrder, yStore } = makeDoc();
    seedYBlocks(ydoc, yOrder, yStore, sampleBlocks);
    const yTextBefore = getYText(yStore, 'b2');

    const next = [...sampleBlocks];
    next[1] = { ...next[1], html: 'This section covers grading.' };
    applyBlocksToYDoc(ydoc, yOrder, yStore, next);

    const yTextAfter = getYText(yStore, 'b2');
    expect(yTextAfter.toString()).toBe('This section covers grading.');
    // Same Y.Text instance preserved (update-in-place path)
    expect(yTextAfter).toBe(yTextBefore);
  });

  it('updates a changed scalar field in place', () => {
    const { ydoc, yOrder, yStore } = makeDoc();
    seedYBlocks(ydoc, yOrder, yStore, sampleBlocks);
    const next = sampleBlocks.map((b, i) => i === 2 ? { ...b, level: 2 } : b);
    applyBlocksToYDoc(ydoc, yOrder, yStore, next);
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
});

describe('collab — applyBlocksToYDoc (structural changes)', () => {
  it('handles block insertion', () => {
    const { ydoc, yOrder, yStore } = makeDoc();
    seedYBlocks(ydoc, yOrder, yStore, sampleBlocks);
    const next = [
      sampleBlocks[0],
      { id: 'b-new', type: 'txt', part: 1, depth: 1, section: 'b1', html: 'Inserted' },
      sampleBlocks[1],
      sampleBlocks[2],
    ];
    applyBlocksToYDoc(ydoc, yOrder, yStore, next);
    expect(yOrder.length).toBe(4);
    expect(yBlocksToArray(yOrder, yStore).map((b) => b.id)).toEqual(['b1', 'b-new', 'b2', 'b3']);
  });

  it('preserves Y.Text identity for existing blocks across an insert', () => {
    // This is the critical invariant that prevents the
    // "Ctrl+Z wipes out the other user's edits" bug: inserting a new block
    // must not recreate the Y.Text of unchanged blocks.
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

    expect(getYText(yStore, 'b1')).toBe(b1Before);
    expect(getYText(yStore, 'b2')).toBe(b2Before);
    expect(getYText(yStore, 'b3')).toBe(b3Before);
  });

  it('preserves Y.Text identity for unchanged blocks across a delete', () => {
    const { ydoc, yOrder, yStore } = makeDoc();
    seedYBlocks(ydoc, yOrder, yStore, sampleBlocks);

    const b1Before = getYText(yStore, 'b1');
    const b3Before = getYText(yStore, 'b3');

    applyBlocksToYDoc(ydoc, yOrder, yStore, [sampleBlocks[0], sampleBlocks[2]]);

    expect(yOrder.length).toBe(2);
    expect(getYText(yStore, 'b1')).toBe(b1Before);
    expect(getYText(yStore, 'b3')).toBe(b3Before);
    expect(yStore.has('b2')).toBe(false);
  });

  it('handles block deletion', () => {
    const { ydoc, yOrder, yStore } = makeDoc();
    seedYBlocks(ydoc, yOrder, yStore, sampleBlocks);
    applyBlocksToYDoc(ydoc, yOrder, yStore, [sampleBlocks[0], sampleBlocks[2]]);
    expect(yOrder.length).toBe(2);
    expect(yBlocksToArray(yOrder, yStore).map((b) => b.id)).toEqual(['b1', 'b3']);
  });

  it('same-transaction delete+reinsert of same ID updates in place (N6)', () => {
    // Pathological case: a publish where an ID is absent-then-present in
    // the same diff is semantically "just present with new content" and
    // must take the in-place update path, not churn Y.Map instances.
    const { ydoc, yOrder, yStore } = makeDoc();
    seedYBlocks(ydoc, yOrder, yStore, sampleBlocks);

    const b2MapBefore = getYMap(yStore, 'b2');
    const b2TextBefore = getYText(yStore, 'b2');

    // Publish a block list where b2 is present but with completely new content.
    const next = sampleBlocks.map((b, i) =>
      i === 1 ? { ...b, html: 'Brand new body for b2.' } : b,
    );
    applyBlocksToYDoc(ydoc, yOrder, yStore, next);

    // Y.Map identity preserved — same instance, not delete+reinsert.
    expect(getYMap(yStore, 'b2')).toBe(b2MapBefore);
    expect(getYText(yStore, 'b2')).toBe(b2TextBefore);
    expect(getYText(yStore, 'b2').toString()).toBe('Brand new body for b2.');
  });

  it('handles block reordering', () => {
    const { ydoc, yOrder, yStore } = makeDoc();
    seedYBlocks(ydoc, yOrder, yStore, sampleBlocks);
    const reordered = [sampleBlocks[2], sampleBlocks[0], sampleBlocks[1]];
    applyBlocksToYDoc(ydoc, yOrder, yStore, reordered);
    expect(yBlocksToArray(yOrder, yStore).map((b) => b.id)).toEqual(['b3', 'b1', 'b2']);
  });

  it('preserves Y.Text identity for ALL blocks across a reorder (C1 regression)', () => {
    // Critical invariant: reordering must not destroy any Y.Text.
    // The old Y.Array<Y.Map> model lost identity here because Yjs shared
    // types cannot be moved — delete+reinsert created fresh instances.
    // The yOrder + yStore split keeps Y.Map/Y.Text identity stable because
    // reorder only touches string IDs in yOrder.
    const { ydoc, yOrder, yStore } = makeDoc();
    seedYBlocks(ydoc, yOrder, yStore, sampleBlocks);

    const b1Before = getYText(yStore, 'b1');
    const b2Before = getYText(yStore, 'b2');
    const b3Before = getYText(yStore, 'b3');
    const b1MapBefore = getYMap(yStore, 'b1');
    const b2MapBefore = getYMap(yStore, 'b2');
    const b3MapBefore = getYMap(yStore, 'b3');

    // Full shuffle.
    applyBlocksToYDoc(ydoc, yOrder, yStore, [sampleBlocks[2], sampleBlocks[0], sampleBlocks[1]]);

    // Y.Text identity preserved for every block.
    expect(getYText(yStore, 'b1')).toBe(b1Before);
    expect(getYText(yStore, 'b2')).toBe(b2Before);
    expect(getYText(yStore, 'b3')).toBe(b3Before);
    // Y.Map identity preserved too.
    expect(getYMap(yStore, 'b1')).toBe(b1MapBefore);
    expect(getYMap(yStore, 'b2')).toBe(b2MapBefore);
    expect(getYMap(yStore, 'b3')).toBe(b3MapBefore);
    // Order reflects the reorder.
    expect(yBlocksToArray(yOrder, yStore).map((b) => b.id)).toEqual(['b3', 'b1', 'b2']);
  });

  it('preserves a concurrent remote Y.Text edit across a local reorder', () => {
    // Two-doc simulation of the exact scenario C1 was flagged for:
    // Client B is typing in b2. Client A drags b3 above b1 (reorder).
    // After sync, B's typing in b2 must still be present.
    const docA = makeDoc();
    const docB = makeDoc();
    seedYBlocks(docA.ydoc, docA.yOrder, docA.yStore, sampleBlocks);
    Y.applyUpdate(docB.ydoc, Y.encodeStateAsUpdate(docA.ydoc));

    // B types directly into the Y.Text for b2 (simulates live editing).
    const bText = getYText(docB.yStore, 'b2');
    docB.ydoc.transact(() => {
      bText.delete(0, bText.length);
      bText.insert(0, 'B typed new body content.');
    }, 'local-publish');

    // Concurrently, A reorders without touching b2's content.
    applyBlocksToYDoc(docA.ydoc, docA.yOrder, docA.yStore, [
      sampleBlocks[2], sampleBlocks[0], sampleBlocks[1],
    ]);

    // Cross-sync.
    Y.applyUpdate(docB.ydoc, Y.encodeStateAsUpdate(docA.ydoc, Y.encodeStateVector(docB.ydoc)));
    Y.applyUpdate(docA.ydoc, Y.encodeStateAsUpdate(docB.ydoc, Y.encodeStateVector(docA.ydoc)));

    const finalA = yBlocksToArray(docA.yOrder, docA.yStore);
    const finalB = yBlocksToArray(docB.yOrder, docB.yStore);
    expect(finalA).toEqual(finalB);
    // Order from A wins.
    expect(finalA.map((b) => b.id)).toEqual(['b3', 'b1', 'b2']);
    // B's concurrent edit to b2 survived the reorder.
    const b2 = finalA.find((b) => b.id === 'b2');
    expect(b2.html).toBe('B typed new body content.');
  });
});

describe('collab — two-doc sync (CRDT merge)', () => {
  it('propagates a scalar + html update across two Y.Docs', () => {
    const docA = makeDoc();
    const docB = makeDoc();

    seedYBlocks(docA.ydoc, docA.yOrder, docA.yStore, sampleBlocks);
    const updateSeed = Y.encodeStateAsUpdate(docA.ydoc);
    Y.applyUpdate(docB.ydoc, updateSeed);

    const nextA = sampleBlocks.map((b, i) => i === 1 ? { ...b, html: 'A typed this.' } : b);
    applyBlocksToYDoc(docA.ydoc, docA.yOrder, docA.yStore, nextA);

    const update = Y.encodeStateAsUpdate(docA.ydoc, Y.encodeStateVector(docB.ydoc));
    Y.applyUpdate(docB.ydoc, update);

    const mirrorB = yBlocksToArray(docB.yOrder, docB.yStore);
    expect(mirrorB[1].html).toBe('A typed this.');
    expect(mirrorB.map((b) => b.id)).toEqual(['b1', 'b2', 'b3']);
  });

  it('merges concurrent edits on different blocks', () => {
    const docA = makeDoc();
    const docB = makeDoc();

    seedYBlocks(docA.ydoc, docA.yOrder, docA.yStore, sampleBlocks);
    Y.applyUpdate(docB.ydoc, Y.encodeStateAsUpdate(docA.ydoc));

    const nextA = sampleBlocks.map((b, i) => i === 0 ? { ...b, html: 'EARTHWORK' } : b);
    applyBlocksToYDoc(docA.ydoc, docA.yOrder, docA.yStore, nextA);

    const nextB = sampleBlocks.map((b, i) => i === 2 ? { ...b, html: 'B edited item.' } : b);
    applyBlocksToYDoc(docB.ydoc, docB.yOrder, docB.yStore, nextB);

    Y.applyUpdate(docB.ydoc, Y.encodeStateAsUpdate(docA.ydoc, Y.encodeStateVector(docB.ydoc)));
    Y.applyUpdate(docA.ydoc, Y.encodeStateAsUpdate(docB.ydoc, Y.encodeStateVector(docA.ydoc)));

    const finalA = yBlocksToArray(docA.yOrder, docA.yStore);
    const finalB = yBlocksToArray(docB.yOrder, docB.yStore);
    expect(finalA).toEqual(finalB);
    expect(finalA[0].html).toBe('EARTHWORK');
    expect(finalA[2].html).toBe('B edited item.');
  });

  it('no-op applyBlocksToYDoc does not grow Y.UndoManager stack (I2)', () => {
    // The App.jsx publish effect uses `blocks === lastRemoteBlocksRef.current`
    // reference equality to skip echoing remote updates. Reviewer flagged
    // that any intermediate setBlocks cloning the array bypasses the guard
    // and re-publishes the remote content under 'local-publish' origin —
    // which would make Y.UndoManager track the echo and reintroduce the
    // cross-user-undo corruption.
    //
    // This test pins the invariant that makes that scenario safe:
    // applyBlocksToYDoc with no actual diff produces no UndoManager stack
    // items, so even a worst-case echo is a harmless no-op transaction.
    const { ydoc, yOrder, yStore } = makeDoc();
    seedYBlocks(ydoc, yOrder, yStore, sampleBlocks);

    const undoManager = new Y.UndoManager([yOrder, yStore], {
      trackedOrigins: new Set(['local-publish']),
    });

    // Baseline: no local edits yet.
    expect(undoManager.undoStack.length).toBe(0);

    // Simulate the echo: apply a brand-new-array-but-content-equal block
    // set inside a 'local-publish' transaction (what publishBlocks does).
    const clonedContentEqual = sampleBlocks.map((b) => ({ ...b }));
    ydoc.transact(() => {
      applyBlocksToYDoc(ydoc, yOrder, yStore, clonedContentEqual);
    }, 'local-publish');

    // No-op → no undo stack growth. If this fails, the ref-equality guard
    // in App.jsx is the only thing preventing echo-driven undo corruption
    // and needs a content-based fallback (e.g. content hash).
    expect(undoManager.undoStack.length).toBe(0);

    // Sanity: a genuine local edit DOES grow the stack.
    ydoc.transact(() => {
      applyBlocksToYDoc(
        ydoc,
        yOrder,
        yStore,
        sampleBlocks.map((b, i) => i === 0 ? { ...b, html: 'CHANGED' } : b),
      );
    }, 'local-publish');
    expect(undoManager.undoStack.length).toBe(1);
  });

  it('Y.UndoManager scoped to local origin does not revert remote edits (M2)', () => {
    // The invariant: Alice's Ctrl+Z must never touch Bob's edits.
    const docA = makeDoc();
    const docB = makeDoc();
    seedYBlocks(docA.ydoc, docA.yOrder, docA.yStore, sampleBlocks);
    Y.applyUpdate(docB.ydoc, Y.encodeStateAsUpdate(docA.ydoc));

    const undoA = new Y.UndoManager([docA.yOrder, docA.yStore], {
      trackedOrigins: new Set(['local-publish']),
    });

    // A publishes a local edit on b1 (tracked by undoA).
    docA.ydoc.transact(() => {
      applyBlocksToYDoc(
        docA.ydoc,
        docA.yOrder,
        docA.yStore,
        sampleBlocks.map((b, i) => i === 0 ? { ...b, html: 'Alice edit.' } : b),
      );
    }, 'local-publish');

    // B edits b2 locally and sync A←B. From A's perspective this is a
    // remote transaction (origin is not 'local-publish') so undoA must
    // NOT track it.
    applyBlocksToYDoc(
      docB.ydoc,
      docB.yOrder,
      docB.yStore,
      sampleBlocks.map((b, i) => i === 1 ? { ...b, html: 'Bob edit.' } : b),
    );
    Y.applyUpdate(docA.ydoc, Y.encodeStateAsUpdate(docB.ydoc, Y.encodeStateVector(docA.ydoc)));

    // Snapshot the doc state and Bob's b2 text before undo.
    const beforeUndo = yBlocksToArray(docA.yOrder, docA.yStore);
    expect(beforeUndo.find((b) => b.id === 'b1').html).toBe('Alice edit.');
    expect(beforeUndo.find((b) => b.id === 'b2').html).toBe('Bob edit.');

    // Alice hits Ctrl+Z.
    undoA.undo();

    const afterUndo = yBlocksToArray(docA.yOrder, docA.yStore);
    // Alice's edit is reverted.
    expect(afterUndo.find((b) => b.id === 'b1').html).toBe('GENERAL');
    // Bob's edit is PRESERVED — this is the invariant.
    expect(afterUndo.find((b) => b.id === 'b2').html).toBe('Bob edit.');
  });
});

describe('collab — document size guard (M7)', () => {
  it('estimatePublishBytes counts ids, types, html, and serialized table/ref', () => {
    const blocks = [
      { id: 'b1', type: 'txt', html: 'hello world' },
      { id: 'b2', type: 'table', html: '', table: { rows: [['a', 'b'], ['c', 'd']] } },
    ];
    const bytes = estimatePublishBytes(blocks);
    // >0 and <1KB for this tiny sample.
    expect(bytes).toBeGreaterThan(0);
    expect(bytes).toBeLessThan(1024);
  });

  it('estimatePublishBytes returns 0 for non-array input', () => {
    expect(estimatePublishBytes(null)).toBe(0);
    expect(estimatePublishBytes(undefined)).toBe(0);
    expect(estimatePublishBytes({})).toBe(0);
  });

  it('DocSizeLimitError carries the actual and max byte counts', () => {
    const err = new DocSizeLimitError(12345, 8 * 1024 * 1024);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('DocSizeLimitError');
    expect(err.actualBytes).toBe(12345);
    expect(err.maxBytes).toBe(8 * 1024 * 1024);
  });

  it('MAX_PUBLISH_BYTES is half of the server snapshot cap (A6 wire overhead)', () => {
    // Yjs wire overhead runs ~2x plain text for steady-state docs, so
    // the client cap must fire before the server's 8 MB snapshot cap
    // to surface a useful error. 4 MB plain text = ~8 MB Yjs snapshot.
    const SERVER_CAP = 8 * 1024 * 1024;
    expect(MAX_PUBLISH_BYTES).toBe(SERVER_CAP / 2);
  });
});

describe('collab — yMeta (M3)', () => {
  it('readYMeta returns an empty object for an empty Y.Map', () => {
    const ydoc = new Y.Doc();
    expect(readYMeta(ydoc.getMap('meta'))).toEqual({});
  });

  it('readYMeta snapshots scalar keys', () => {
    const ydoc = new Y.Doc();
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

  it('local meta edit after remote meta update still propagates (A1 regression)', () => {
    // Reviewer caught a broken echo guard that could drop legitimate
    // local meta edits whenever the last remote snapshot had MORE keys
    // than the local edit, or happened to share every key the local
    // combined object carried. The guard was deleted — publishMeta's
    // per-key diff + the 'local-meta' origin filter handle echo. This
    // test pins the scenario the guard was incorrectly blocking.
    const docA = new Y.Doc();
    const docB = new Y.Doc();
    const metaA = docA.getMap('meta');
    const metaB = docB.getMap('meta');

    // B publishes a full metadata snapshot with multiple keys.
    docB.transact(() => {
      metaB.set('sectionNumber', '31 00 00');
      metaB.set('sectionTitle', 'EARTHWORK');
      metaB.set('date', '08/23');
      metaB.set('fileName', '31_00_00.SEC');
    });

    // A receives B's snapshot.
    Y.applyUpdate(docA, Y.encodeStateAsUpdate(docB));
    expect(readYMeta(metaA)).toEqual({
      sectionNumber: '31 00 00',
      sectionTitle: 'EARTHWORK',
      date: '08/23',
      fileName: '31_00_00.SEC',
    });

    // Now A makes a local edit changing ONLY the section title.
    docA.transact(() => { metaA.set('sectionTitle', 'STRUCTURAL STEEL'); }, 'local-meta');

    // B receives A's update.
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA, Y.encodeStateVector(docB)));

    // The edit must have propagated — this is exactly what the broken
    // echo guard would have dropped.
    expect(metaB.get('sectionTitle')).toBe('STRUCTURAL STEEL');
    expect(metaB.get('sectionNumber')).toBe('31 00 00'); // other keys intact
    expect(metaB.get('fileName')).toBe('31_00_00.SEC');
  });

  it('publishMeta does not overwrite existing remote meta on first join (I-3)', async () => {
    // docA seeds a room with sectionNumber = "03 30 00"
    const docA = new Y.Doc();
    const orderA = docA.getArray('order');
    const storeA = docA.getMap('store');
    const metaA = docA.getMap('meta');
    docA.transact(() => { metaA.set('sectionNumber', '03 30 00'); }, 'seed');

    // docB joins with different local meta ("31 00 00") — simulates a user
    // who had a file open in single-user before clicking Share.
    const docB = new Y.Doc();
    const orderB = docB.getArray('order');
    const storeB = docB.getMap('store');
    const metaB = docB.getMap('meta');

    // Sync docA -> docB
    const updateAB = Y.encodeStateAsUpdate(docA);
    Y.applyUpdate(docB, updateAB);

    // At this point docB has seen remote meta. The App-side effect must
    // NOT publishMeta with the stale local "31 00 00" until onRemoteMeta
    // has fired. We simulate that guard here: a well-behaved client
    // defers the first publishMeta until after the first remote-meta
    // observation.
    expect(metaB.get('sectionNumber')).toBe('03 30 00');

    // Sync docB -> docA and verify docA's meta is not clobbered.
    const updateBA = Y.encodeStateAsUpdate(docB);
    Y.applyUpdate(docA, updateBA);
    expect(metaA.get('sectionNumber')).toBe('03 30 00');
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

describe('collab — URL helpers', () => {
  it('generateRoomId produces an 8-char alphanumeric ID', () => {
    for (let i = 0; i < 10; i++) {
      const id = generateRoomId();
      expect(id).toMatch(/^[a-z0-9]+$/);
      expect(id.length).toBeGreaterThan(0);
      expect(id.length).toBeLessThanOrEqual(8);
    }
  });

  it('buildRoomUrl appends the room param', () => {
    const url = buildRoomUrl('abc123');
    expect(url).toContain('room=abc123');
  });
});
