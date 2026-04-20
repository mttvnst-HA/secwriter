// src/lib/__tests__/yref-crdt.test.js
import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import { refToYStructure, yStructureToRef, applyRefEdits } from '../yref-crdt.js';

function makeRefYMap() {
  const ydoc = new Y.Doc();
  const yMap = ydoc.getMap('ref');
  return { ydoc, yMap };
}

const sampleRef = {
  org: 'ASTM INTERNATIONAL',
  entries: [
    { rid: 'ASTM C33', rtl: 'Standard Specification for Concrete Aggregates' },
    { rid: 'ASTM D2487', rtl: 'Classification of Soils' },
  ],
};

describe('refToYStructure + yStructureToRef roundtrip', () => {
  it('roundtrips a ref block', () => {
    const { ydoc, yMap } = makeRefYMap();
    ydoc.transact(() => refToYStructure(yMap, sampleRef));
    const result = yStructureToRef(yMap);
    expect(result.org).toBe('ASTM INTERNATIONAL');
    expect(result.entries.length).toBe(2);
    expect(result.entries[0].rid).toBe('ASTM C33');
    expect(result.entries[1].rtl).toBe('Classification of Soils');
  });

  it('handles empty entries array', () => {
    const ref = { org: 'TEST ORG', entries: [] };
    const { ydoc, yMap } = makeRefYMap();
    ydoc.transact(() => refToYStructure(yMap, ref));
    const result = yStructureToRef(yMap);
    expect(result.org).toBe('TEST ORG');
    expect(result.entries).toEqual([]);
  });
});

describe('applyRefEdits', () => {
  it('updates org text', () => {
    const { ydoc, yMap } = makeRefYMap();
    ydoc.transact(() => refToYStructure(yMap, sampleRef));
    const nextRef = { ...sampleRef, org: 'AASHTO' };
    applyRefEdits(yMap, sampleRef, nextRef);
    const result = yStructureToRef(yMap);
    expect(result.org).toBe('AASHTO');
  });

  it('updates entry rid text', () => {
    const { ydoc, yMap } = makeRefYMap();
    ydoc.transact(() => refToYStructure(yMap, sampleRef));
    const nextRef = {
      ...sampleRef,
      entries: [
        { rid: 'ASTM C33/C33M', rtl: sampleRef.entries[0].rtl },
        sampleRef.entries[1],
      ],
    };
    applyRefEdits(yMap, sampleRef, nextRef);
    const result = yStructureToRef(yMap);
    expect(result.entries[0].rid).toBe('ASTM C33/C33M');
    expect(result.entries[1].rid).toBe('ASTM D2487');
  });

  it('appends new entry', () => {
    const { ydoc, yMap } = makeRefYMap();
    ydoc.transact(() => refToYStructure(yMap, sampleRef));
    const nextRef = {
      ...sampleRef,
      entries: [...sampleRef.entries, { rid: 'ASTM D698', rtl: 'Lab Compaction' }],
    };
    applyRefEdits(yMap, sampleRef, nextRef);
    const result = yStructureToRef(yMap);
    expect(result.entries.length).toBe(3);
    expect(result.entries[2].rid).toBe('ASTM D698');
  });

  it('removes an entry', () => {
    const { ydoc, yMap } = makeRefYMap();
    ydoc.transact(() => refToYStructure(yMap, sampleRef));
    const nextRef = { ...sampleRef, entries: [sampleRef.entries[0]] };
    applyRefEdits(yMap, sampleRef, nextRef);
    const result = yStructureToRef(yMap);
    expect(result.entries.length).toBe(1);
    expect(result.entries[0].rid).toBe('ASTM C33');
  });
});

describe('two-doc ref merge', () => {
  it('concurrent entry additions merge', () => {
    const doc1 = new Y.Doc(); const doc2 = new Y.Doc();
    const m1 = doc1.getMap('r'); const m2 = doc2.getMap('r');

    doc1.transact(() => refToYStructure(m1, sampleRef));
    Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1, Y.encodeStateVector(doc2)));

    applyRefEdits(m1, sampleRef, {
      ...sampleRef,
      entries: [...sampleRef.entries, { rid: 'ASTM D698', rtl: 'Lab Compaction' }],
    });
    applyRefEdits(m2, sampleRef, {
      ...sampleRef,
      entries: [...sampleRef.entries, { rid: 'AASHTO T99', rtl: 'Moisture-Density' }],
    });

    const u1 = Y.encodeStateAsUpdate(doc1, Y.encodeStateVector(doc2));
    const u2 = Y.encodeStateAsUpdate(doc2, Y.encodeStateVector(doc1));
    Y.applyUpdate(doc1, u2);
    Y.applyUpdate(doc2, u1);

    const r1 = yStructureToRef(m1);
    const r2 = yStructureToRef(m2);
    expect(r1.entries.length).toBe(4);
    expect(r1.entries.length).toBe(r2.entries.length);
  });
});
