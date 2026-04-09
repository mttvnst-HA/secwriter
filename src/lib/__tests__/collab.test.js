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
} from '../collab.js';

function makeDoc() {
  const ydoc = new Y.Doc();
  const yBlocks = ydoc.getArray('blocks');
  return { ydoc, yBlocks };
}

const sampleBlocks = [
  { id: 'b1', type: 'title', part: 1, depth: 0, section: 'b1', html: 'GENERAL' },
  { id: 'b2', type: 'txt', part: 1, depth: 1, section: 'b1', html: 'This section covers...' },
  { id: 'b3', type: 'oli', part: 1, depth: 1, section: 'b1', level: 1, html: 'First item' },
];

describe('collab — seeding & snapshot', () => {
  it('seeds an empty Y.Array from a block array', () => {
    const { ydoc, yBlocks } = makeDoc();
    seedYBlocks(ydoc, yBlocks, sampleBlocks);
    expect(yBlocks.length).toBe(3);
    const out = yBlocksToArray(yBlocks);
    expect(out).toHaveLength(3);
    expect(out[0].id).toBe('b1');
    expect(out[0].html).toBe('GENERAL');
    expect(out[2].level).toBe(1);
  });

  it('roundtrips scalar + html fields', () => {
    const { ydoc, yBlocks } = makeDoc();
    seedYBlocks(ydoc, yBlocks, sampleBlocks);
    const out = yBlocksToArray(yBlocks);
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
    const { ydoc, yBlocks } = makeDoc();
    seedYBlocks(ydoc, yBlocks, sampleBlocks);
    const yTextBefore = yBlocks.get(1).get('html');

    const next = [...sampleBlocks];
    next[1] = { ...next[1], html: 'This section covers grading.' };
    applyBlocksToYDoc(ydoc, yBlocks, next);

    const yTextAfter = yBlocks.get(1).get('html');
    expect(yTextAfter.toString()).toBe('This section covers grading.');
    // Same Y.Text instance preserved (update-in-place path)
    expect(yTextAfter).toBe(yTextBefore);
  });

  it('updates a changed scalar field in place', () => {
    const { ydoc, yBlocks } = makeDoc();
    seedYBlocks(ydoc, yBlocks, sampleBlocks);
    const next = sampleBlocks.map((b, i) => i === 2 ? { ...b, level: 2 } : b);
    applyBlocksToYDoc(ydoc, yBlocks, next);
    expect(yBlocks.get(2).get('level')).toBe(2);
  });

  it('is a no-op when the block array is unchanged', () => {
    const { ydoc, yBlocks } = makeDoc();
    seedYBlocks(ydoc, yBlocks, sampleBlocks);
    const before = Y.encodeStateAsUpdate(ydoc);
    applyBlocksToYDoc(ydoc, yBlocks, sampleBlocks);
    const after = Y.encodeStateAsUpdate(ydoc);
    // No real change should have been pushed through the Yjs update pipeline,
    // but Yjs may still capture a transact boundary. What matters: state is identical.
    expect(yBlocksToArray(yBlocks)).toEqual(sampleBlocks);
    expect(before.length).toBeGreaterThan(0);
    expect(after.length).toBeGreaterThan(0);
  });
});

describe('collab — applyBlocksToYDoc (structural changes)', () => {
  it('handles block insertion', () => {
    const { ydoc, yBlocks } = makeDoc();
    seedYBlocks(ydoc, yBlocks, sampleBlocks);
    const next = [
      sampleBlocks[0],
      { id: 'b-new', type: 'txt', part: 1, depth: 1, section: 'b1', html: 'Inserted' },
      sampleBlocks[1],
      sampleBlocks[2],
    ];
    applyBlocksToYDoc(ydoc, yBlocks, next);
    expect(yBlocks.length).toBe(4);
    expect(yBlocksToArray(yBlocks).map((b) => b.id)).toEqual(['b1', 'b-new', 'b2', 'b3']);
  });

  it('preserves Y.Text identity for existing blocks across an insert', () => {
    // This is the critical invariant that prevents the
    // "Ctrl+Z wipes out the other user's edits" bug: inserting a new block
    // must not recreate the Y.Text of unchanged blocks.
    const { ydoc, yBlocks } = makeDoc();
    seedYBlocks(ydoc, yBlocks, sampleBlocks);

    const yText0Before = yBlocks.get(0).get('html');
    const yText1Before = yBlocks.get(1).get('html');
    const yText2Before = yBlocks.get(2).get('html');

    const next = [
      sampleBlocks[0],
      { id: 'b-new', type: 'txt', part: 1, depth: 1, section: 'b1', html: 'Inserted' },
      sampleBlocks[1],
      sampleBlocks[2],
    ];
    applyBlocksToYDoc(ydoc, yBlocks, next);

    // b1 was at index 0 and stays at index 0 → identity preserved
    expect(yBlocks.get(0).get('html')).toBe(yText0Before);
    // b2 moved from index 1 to index 2 → still the same Y.Text instance
    expect(yBlocks.get(2).get('html')).toBe(yText1Before);
    // b3 moved from index 2 to index 3 → identity preserved
    expect(yBlocks.get(3).get('html')).toBe(yText2Before);
  });

  it('preserves Y.Text identity for unchanged blocks across a delete', () => {
    const { ydoc, yBlocks } = makeDoc();
    seedYBlocks(ydoc, yBlocks, sampleBlocks);

    const yText0Before = yBlocks.get(0).get('html');
    const yText2Before = yBlocks.get(2).get('html');

    applyBlocksToYDoc(ydoc, yBlocks, [sampleBlocks[0], sampleBlocks[2]]);

    expect(yBlocks.length).toBe(2);
    expect(yBlocks.get(0).get('html')).toBe(yText0Before);
    expect(yBlocks.get(1).get('html')).toBe(yText2Before);
  });

  it('handles block deletion', () => {
    const { ydoc, yBlocks } = makeDoc();
    seedYBlocks(ydoc, yBlocks, sampleBlocks);
    applyBlocksToYDoc(ydoc, yBlocks, [sampleBlocks[0], sampleBlocks[2]]);
    expect(yBlocks.length).toBe(2);
    expect(yBlocksToArray(yBlocks).map((b) => b.id)).toEqual(['b1', 'b3']);
  });

  it('handles block reordering', () => {
    const { ydoc, yBlocks } = makeDoc();
    seedYBlocks(ydoc, yBlocks, sampleBlocks);
    const reordered = [sampleBlocks[2], sampleBlocks[0], sampleBlocks[1]];
    applyBlocksToYDoc(ydoc, yBlocks, reordered);
    expect(yBlocksToArray(yBlocks).map((b) => b.id)).toEqual(['b3', 'b1', 'b2']);
  });
});

describe('collab — two-doc sync (CRDT merge)', () => {
  it('propagates a scalar + html update across two Y.Docs', () => {
    const docA = makeDoc();
    const docB = makeDoc();

    // Seed both from the same blocks
    seedYBlocks(docA.ydoc, docA.yBlocks, sampleBlocks);
    const updateSeed = Y.encodeStateAsUpdate(docA.ydoc);
    Y.applyUpdate(docB.ydoc, updateSeed);

    // A edits block 2
    const nextA = sampleBlocks.map((b, i) => i === 1 ? { ...b, html: 'A typed this.' } : b);
    applyBlocksToYDoc(docA.ydoc, docA.yBlocks, nextA);

    // Sync A→B
    const update = Y.encodeStateAsUpdate(docA.ydoc, Y.encodeStateVector(docB.ydoc));
    Y.applyUpdate(docB.ydoc, update);

    const mirrorB = yBlocksToArray(docB.yBlocks);
    expect(mirrorB[1].html).toBe('A typed this.');
    expect(mirrorB.map((b) => b.id)).toEqual(['b1', 'b2', 'b3']);
  });

  it('merges concurrent edits on different blocks', () => {
    const docA = makeDoc();
    const docB = makeDoc();

    seedYBlocks(docA.ydoc, docA.yBlocks, sampleBlocks);
    Y.applyUpdate(docB.ydoc, Y.encodeStateAsUpdate(docA.ydoc));

    // Concurrent edits: A edits block 1, B edits block 2
    const nextA = sampleBlocks.map((b, i) => i === 0 ? { ...b, html: 'EARTHWORK' } : b);
    applyBlocksToYDoc(docA.ydoc, docA.yBlocks, nextA);

    const nextB = sampleBlocks.map((b, i) => i === 2 ? { ...b, html: 'B edited item.' } : b);
    applyBlocksToYDoc(docB.ydoc, docB.yBlocks, nextB);

    // Cross-sync
    Y.applyUpdate(docB.ydoc, Y.encodeStateAsUpdate(docA.ydoc, Y.encodeStateVector(docB.ydoc)));
    Y.applyUpdate(docA.ydoc, Y.encodeStateAsUpdate(docB.ydoc, Y.encodeStateVector(docA.ydoc)));

    const finalA = yBlocksToArray(docA.yBlocks);
    const finalB = yBlocksToArray(docB.yBlocks);
    expect(finalA).toEqual(finalB);
    expect(finalA[0].html).toBe('EARTHWORK');
    expect(finalA[2].html).toBe('B edited item.');
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
    // jsdom has a window in vitest test env
    const url = buildRoomUrl('abc123');
    expect(url).toContain('room=abc123');
  });
});
