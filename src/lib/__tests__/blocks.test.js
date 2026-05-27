// Unit tests for src/lib/blocks.js — pure verb transformations + dispatcher
// protocol. Mirrors the patterns in pm-toolbar-dispatch.test.js (mocked
// substrate + registry imports) and comments.test.js / linting.test.js
// (verb-purity assertions + small property loop).

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock block-html-store BEFORE importing blocks.js so substrate writes are
// observable. setBlockHtml is the only export we care about; surfacing the
// other exports keeps the module shape intact for unrelated imports.
vi.mock('../block-html-store.js', () => ({
  setBlockHtml: vi.fn(),
  setBlockHtmlSilent: vi.fn(),
  getBlockHtml: vi.fn(),
  seedBlockArray: vi.fn(),
  resetBlockArray: vi.fn(),
}));

// Mock block-registry — flushPendingUpdateById, flushAllPendingUpdates,
// focusBlockById. The verbs themselves don't call these; the dispatcher
// does.
vi.mock('../block-registry.js', () => ({
  flushPendingUpdateById: vi.fn(),
  flushAllPendingUpdates: vi.fn(),
  focusBlockById: vi.fn(),
  getBlockHandle: vi.fn(),
  getBlockView: vi.fn(),
}));

// Mock SearchBar's replaceMatchInHtml (jsx file; mock the module export).
vi.mock('../../components/SearchBar.jsx', () => ({
  replaceMatchInHtml: (html, offset, length, replacement) => {
    // Trivial implementation: byte-substitution at `offset` ignoring html
    // tags. Tests only assert the verb wires the helper through, not its
    // text-walking behavior.
    return html.slice(0, offset) + replacement + html.slice(offset + length);
  },
  default: () => null,
}));

import * as blocks from '../blocks.js';
import { setBlockHtml } from '../block-html-store.js';
import {
  flushPendingUpdateById,
  flushAllPendingUpdates,
} from '../block-registry.js';

beforeEach(() => {
  vi.clearAllMocks();
});

// ── Fixture builders ────────────────────────────────────────────────────────

const tcOff = { enabled: false, publishSeq: 0 };
const tcOn = { enabled: true, publishSeq: 1 };

function b(id, type, html = '', extra = {}) {
  return { id, type, part: 1, depth: 1, html, ...extra };
}

function refBlock(id, org, entries) {
  return { id, type: 'ref', part: 1, depth: 1, ref: { org, entries } };
}

// ── Verb tests ──────────────────────────────────────────────────────────────

describe('updateBlockHtml', () => {
  it('returns null when block not found', () => {
    expect(blocks.updateBlockHtml([b('a', 'txt')], 'missing', 'x')).toBeNull();
  });

  it('returns unchanged when html identical', () => {
    const arr = [b('a', 'txt', 'hello')];
    const r = blocks.updateBlockHtml(arr, 'a', 'hello');
    expect(r.state).toBe(arr);
    expect(r.effects.substrateWrites).toEqual([]);
  });

  it('replaces html and emits substrateWrite (no framing)', () => {
    const arr = [b('a', 'txt', 'hello'), b('b', 'txt', 'world')];
    const r = blocks.updateBlockHtml(arr, 'a', 'hi');
    expect(r.state[0].html).toBe('hi');
    expect(r.state[1]).toBe(arr[1]); // unchanged blocks preserved by ref
    expect(r.effects.framing).toBeNull();
    expect(r.effects.substrateWrites).toEqual([{ blockId: 'a', html: 'hi' }]);
  });
});

describe('updateBlockHtmlPmSync', () => {
  it('emits framing=newFrame but NO substrateWrite (PM already wrote)', () => {
    const arr = [b('a', 'txt', 'hello')];
    const r = blocks.updateBlockHtmlPmSync(arr, 'a', 'hi');
    expect(r.state[0].html).toBe('hi');
    expect(r.effects.framing).toEqual({ kind: 'newFrame' });
    expect(r.effects.substrateWrites).toEqual([]);
  });
});

describe('searchReplaceAt', () => {
  it('replaces a substring + emits substrate write + framing', () => {
    const arr = [b('a', 'txt', 'hello world')];
    const r = blocks.searchReplaceAt(arr, 'a', 6, 5, 'there');
    expect(r.state[0].html).toBe('hello there');
    expect(r.effects.framing).toEqual({ kind: 'newFrame' });
    expect(r.effects.substrateWrites).toEqual([{ blockId: 'a', html: 'hello there' }]);
  });

  it('returns null when block not found or has no html', () => {
    expect(blocks.searchReplaceAt([], 'a', 0, 1, 'x')).toBeNull();
    expect(blocks.searchReplaceAt([{ id: 'a', type: 'pagebreak' }], 'a', 0, 1, 'x')).toBeNull();
  });
});

describe('applyInlineFix', () => {
  it('mirrors updateBlockHtml shape but adds framing', () => {
    const arr = [b('a', 'txt', 'hello')];
    const r = blocks.applyInlineFix(arr, 'a', 'fixed');
    expect(r.state[0].html).toBe('fixed');
    expect(r.effects.framing).toEqual({ kind: 'newFrame' });
    expect(r.effects.substrateWrites).toEqual([{ blockId: 'a', html: 'fixed' }]);
  });
});

describe('complianceAcceptGroup', () => {
  it('wraps N substrate writes in framing=wrappedFrame, leaves substrateWrites empty', () => {
    const arr = [
      b('a', 'txt', 'old-a'),
      b('b', 'txt', 'old-b'),
      b('c', 'txt', 'old-c'), // not in fixesByBlock
    ];
    const fixes = new Map([['a', 'new-a'], ['b', 'new-b']]);
    const r = blocks.complianceAcceptGroup(arr, fixes);
    expect(r.state[0].html).toBe('new-a');
    expect(r.state[1].html).toBe('new-b');
    expect(r.state[2]).toBe(arr[2]);
    expect(r.effects.framing.kind).toBe('wrappedFrame');
    expect(r.effects.framing.writes).toEqual([
      { blockId: 'a', html: 'new-a' },
      { blockId: 'b', html: 'new-b' },
    ]);
    expect(r.effects.substrateWrites).toEqual([]);
  });

  it('returns unchanged when no block matches a fix', () => {
    const arr = [b('a', 'txt', 'x')];
    const r = blocks.complianceAcceptGroup(arr, new Map([['z', 'y']]));
    expect(r.state).toBe(arr);
    expect(r.effects.framing).toBeNull();
  });
});

describe('removeOrphanedRid', () => {
  it('filters the matching rid out of ref.entries', () => {
    const arr = [refBlock('r1', 'ASTM', [{ rid: 'ASTM A36', rtl: '' }, { rid: 'ASTM B100', rtl: '' }])];
    const r = blocks.removeOrphanedRid(arr, 'r1', 'ASTM A36');
    expect(r.state[0].ref.entries).toEqual([{ rid: 'ASTM B100', rtl: '' }]);
    expect(r.effects.framing).toEqual({ kind: 'newFrame' });
  });

  it('removes the whole ref block when filtering empties it', () => {
    const arr = [b('p1', 'txt'), refBlock('r1', 'ASTM', [{ rid: 'ASTM A36', rtl: '' }])];
    const r = blocks.removeOrphanedRid(arr, 'r1', 'ASTM A36');
    expect(r.state.length).toBe(1);
    expect(r.state[0].id).toBe('p1');
  });

  it('returns unchanged when rid not present', () => {
    const arr = [refBlock('r1', 'ASTM', [{ rid: 'ASTM A36', rtl: '' }])];
    const r = blocks.removeOrphanedRid(arr, 'r1', 'ASTM Z9');
    expect(r.state).toBe(arr);
  });
});

describe('addReference', () => {
  it('appends to an existing org block in sorted order', () => {
    const arr = [refBlock('r1', 'ASTM', [{ rid: 'ASTM A36', rtl: '36' }])];
    const r = blocks.addReference(arr, { org: 'ASTM', rid: 'ASTM A1', rtl: '1', newId: 'new' });
    expect(r.state.length).toBe(1);
    expect(r.state[0].ref.entries[0].rid).toBe('ASTM A1');
    expect(r.state[0].ref.entries[1].rid).toBe('ASTM A36');
  });

  it('creates a new ref block in alphabetical org order', () => {
    const arr = [refBlock('r1', 'ASTM', [{ rid: 'ASTM A36', rtl: '' }])];
    const r = blocks.addReference(arr, { org: 'ASCE', rid: 'ASCE 7', rtl: '', newId: 'r-new' });
    expect(r.state.length).toBe(2);
    // ASCE < ASTM → inserted before
    expect(r.state[0].ref.org).toBe('ASCE');
    expect(r.state[1].ref.org).toBe('ASTM');
  });
});

describe('createBlockAfter (Enter key)', () => {
  it('inserts a txt block after the current with isNew=true', () => {
    const arr = [b('a', 'txt', 'hello')];
    const r = blocks.createBlockAfter(arr, 'a', { newId: 'new1', tcState: tcOff });
    expect(r.state.length).toBe(2);
    expect(r.state[1].id).toBe('new1');
    expect(r.state[1].isNew).toBe(true);
    expect(r.state[1].type).toBe('txt');
    expect(r.effects.focus).toEqual({ kind: 'setFocused', blockId: 'new1' });
  });

  it('propagates oli/item type for non-empty blocks', () => {
    const arr = [b('a', 'oli', 'item one', { level: 1 })];
    const r = blocks.createBlockAfter(arr, 'a', { newId: 'new1', tcState: tcOff });
    expect(r.state[1].type).toBe('oli');
    expect(r.state[1].level).toBe(1);
  });

  it('exits to txt when Enter on empty oli/item (no insert)', () => {
    const arr = [b('a', 'oli', '', { level: 2 })];
    const r = blocks.createBlockAfter(arr, 'a', { newId: 'new1', tcState: tcOff });
    expect(r.state.length).toBe(1);
    expect(r.state[0].type).toBe('txt');
    expect(r.state[0].id).toBe('new1'); // current block adopts the new id
    expect(r.state[0].isNew).toBe(true);
  });

  it('adds revision="add" when TC enabled (insert path)', () => {
    const arr = [b('a', 'txt', 'hello')];
    const r = blocks.createBlockAfter(arr, 'a', { newId: 'new1', tcState: tcOn });
    expect(r.state[1].revision).toBe('add');
  });
});

describe('deleteBlock', () => {
  it('removes the block (TC off) and emits focus to previous', () => {
    const arr = [b('a', 'txt'), b('b', 'txt'), b('c', 'txt')];
    const r = blocks.deleteBlock(arr, 'b', tcOff);
    expect(r.state.map(x => x.id)).toEqual(['a', 'c']);
    expect(r.effects.focus).toEqual({ kind: 'imperative', blockId: 'a', atEnd: true });
  });

  it('marks revision="del" instead of removing (TC on, not a pending add)', () => {
    const arr = [b('a', 'txt'), b('b', 'txt')];
    const r = blocks.deleteBlock(arr, 'b', tcOn);
    expect(r.state.length).toBe(2);
    expect(r.state[1].revision).toBe('del');
  });

  it('removes a pending-add block outright even with TC on', () => {
    const arr = [b('a', 'txt'), b('b', 'txt', '', { revision: 'add' })];
    const r = blocks.deleteBlock(arr, 'b', tcOn);
    expect(r.state.length).toBe(1);
  });

  it('returns null on first block (no previous to focus)', () => {
    expect(blocks.deleteBlock([b('a', 'txt')], 'a', tcOff)).toBeNull();
  });
});

describe('changeOliLevel', () => {
  it('clamps to [1, 4]', () => {
    const arr = [b('a', 'oli', 'x', { level: 4 })];
    expect(blocks.changeOliLevel(arr, 'a', 1).state).toBe(arr); // unchanged at max
    const r2 = blocks.changeOliLevel([b('a', 'oli', 'x', { level: 1 })], 'a', -1);
    expect(r2.state).toEqual([b('a', 'oli', 'x', { level: 1 })]);
  });

  it('returns null when block is not an oli', () => {
    expect(blocks.changeOliLevel([b('a', 'txt')], 'a', 1)).toBeNull();
  });
});

describe('convertToTitle', () => {
  it('inherits depth from the closest preceding title', () => {
    const arr = [
      b('s1', 'title', 'Section 1', { depth: 1 }),
      b('s2', 'title', 'Sub', { depth: 2 }),
      b('p', 'txt', 'paragraph'),
    ];
    const r = blocks.convertToTitle(arr, 'p');
    expect(r.state[2].type).toBe('title');
    expect(r.state[2].depth).toBe(2);
    expect(r.effects.focus).toEqual({ kind: 'imperative', blockId: 'p', atEnd: true });
  });

  it('clears html so the slash-menu trigger does not persist into the heading', () => {
    const arr = [b('p', 'txt', '/h')];
    const r = blocks.convertToTitle(arr, 'p');
    expect(r.state[0].html).toBe('');
    expect(r.effects.substrateWrites).toEqual([{ blockId: 'p', html: '' }]);
  });
});

describe('convertBlock', () => {
  it('delegates to convertToTitle for newType=title', () => {
    const arr = [b('s1', 'title', '', { depth: 1 }), b('p', 'txt', 'hello')];
    const r = blocks.convertBlock(arr, 'p', 'title', { newId: 'unused' });
    expect(r.state[1].type).toBe('title');
  });

  it('replaces block with a new id (slash-menu shape)', () => {
    const arr = [b('p', 'txt', 'hello')];
    const r = blocks.convertBlock(arr, 'p', 'oli', { newId: 'new-oli' });
    expect(r.state[0].id).toBe('new-oli');
    expect(r.state[0].type).toBe('oli');
    expect(r.state[0].isNew).toBe(true);
    expect(r.effects.focus).toEqual({ kind: 'setFocused', blockId: 'new-oli' });
  });

  it('produces structured data for type=ref / type=table / type=pagebreak', () => {
    const arr = [b('p', 'txt')];
    const rRef = blocks.convertBlock(arr, 'p', 'ref', { newId: 'r' });
    expect(rRef.state[0].ref).toEqual({ org: '', entries: [{ rid: '', rtl: '' }] });
    expect(rRef.state[0].html).toBeUndefined();
    const rTable = blocks.convertBlock(arr, 'p', 'table', { newId: 't' });
    expect(rTable.state[0].table.columns).toBe(2);
    expect(rTable.state[0].isNew).toBeUndefined();
    const rPB = blocks.convertBlock(arr, 'p', 'pagebreak', { newId: 'pb' });
    expect(rPB.state[0].html).toBeUndefined();
    expect(rPB.state[0].isNew).toBeUndefined();
  });
});

describe('promoteTitle / demoteTitle', () => {
  it('promoteTitle decreases depth by 1, clamps at 1', () => {
    const r = blocks.promoteTitle([b('t', 'title', '', { depth: 3 })], 't');
    expect(r.state[0].depth).toBe(2);
    const stay = blocks.promoteTitle([b('t', 'title', '', { depth: 1 })], 't');
    expect(stay.state[0].depth).toBe(1);
  });

  it('demoteTitle increases depth by 1, clamps at 6', () => {
    const r = blocks.demoteTitle([b('t', 'title', '', { depth: 5 })], 't');
    expect(r.state[0].depth).toBe(6);
    const stay = blocks.demoteTitle([b('t', 'title', '', { depth: 6 })], 't');
    expect(stay.state[0].depth).toBe(6);
  });

  it('returns null when not a title', () => {
    expect(blocks.promoteTitle([b('t', 'txt')], 't')).toBeNull();
  });
});

describe('acceptBlockRevision / rejectBlockRevision', () => {
  it('acceptBlockRevision on revision=del removes the block', () => {
    const arr = [b('a', 'txt'), b('b', 'txt', '', { revision: 'del' })];
    const r = blocks.acceptBlockRevision(arr, 'b');
    expect(r.state.length).toBe(1);
  });

  it('rejectBlockRevision on revision=add removes the block', () => {
    const arr = [b('a', 'txt'), b('b', 'txt', '', { revision: 'add' })];
    const r = blocks.rejectBlockRevision(arr, 'b');
    expect(r.state.length).toBe(1);
  });

  it('acceptBlockRevision on revision=add clears the flag (keeps html)', () => {
    const arr = [b('a', 'txt', 'hello', { revision: 'add' })];
    const r = blocks.acceptBlockRevision(arr, 'a');
    expect(r.state[0].revision).toBeUndefined();
  });

  it('emits a substrateWrite only when acceptAllInline mutated the html', () => {
    const arr = [b('a', 'txt', 'plain', { revision: 'chg' })];
    const r = blocks.acceptBlockRevision(arr, 'a');
    // html had no inline marks → unchanged → no substrate write
    expect(r.effects.substrateWrites).toEqual([]);
  });
});

describe('acceptAllRevisionsVerb / rejectAllRevisionsVerb', () => {
  it('returns unchanged when no revisions to apply', () => {
    const arr = [b('a', 'txt', 'plain')];
    const r = blocks.acceptAllRevisionsVerb(arr);
    expect(r.state).toBe(arr);
    expect(r.effects.framing).toBeNull();
  });

  it('uses framing=wrappedFrame with N writes when revisions exist', () => {
    // arr has a block with an <ins> mark — acceptAllRevisions will strip it
    const arr = [b('a', 'txt', 'plain <ins class="mark-add">added</ins>')];
    const r = blocks.acceptAllRevisionsVerb(arr);
    expect(r.effects.framing.kind).toBe('wrappedFrame');
    expect(r.effects.framing.writes.length).toBeGreaterThan(0);
    expect(r.effects.substrateWrites).toEqual([]);
  });
});

describe('mergeBlockData / updateRefScalar', () => {
  it('mergeBlockData spread-merges the data into the block', () => {
    const arr = [b('a', 'table')];
    const r = blocks.mergeBlockData(arr, 'a', { table: { columns: 3, rows: [] } });
    expect(r.state[0].table.columns).toBe(3);
    expect(r.effects.framing).toEqual({ kind: 'newFrame' });
  });

  it('updateRefScalar only sets the .ref field, no framing', () => {
    const arr = [refBlock('r', 'ASTM', [{ rid: 'A1', rtl: '' }])];
    const newRef = { org: 'ASTM', entries: [{ rid: 'B2', rtl: 'x' }] };
    const r = blocks.updateRefScalar(arr, 'r', { ref: newRef, ignored: 'field' });
    expect(r.state[0].ref).toBe(newRef);
    expect(r.effects.framing).toBeNull();
  });
});

// ── Property tests (small loops; invariants only) ──────────────────────────

describe('property invariants', () => {
  it('P1: every verb result has the canonical effects shape', () => {
    const arr = [b('a', 'txt', 'hello'), b('b', 'oli', 'x', { level: 2 })];
    const samples = [
      blocks.updateBlockHtml(arr, 'a', 'hi'),
      blocks.updateBlockHtmlPmSync(arr, 'a', 'hi'),
      blocks.changeOliLevel(arr, 'b', 1),
      blocks.deleteBlock(arr, 'b', tcOff),
      blocks.createBlockAfter(arr, 'a', { newId: 'n', tcState: tcOff }),
      blocks.promoteTitle([b('t', 'title', '', { depth: 2 })], 't'),
      blocks.applyInlineFix(arr, 'a', 'fixed'),
      blocks.complianceAcceptGroup(arr, new Map([['a', 'fixed']])),
    ];
    for (const s of samples) {
      expect(s).not.toBeNull();
      expect(Array.isArray(s.state)).toBe(true);
      expect(s.effects).toBeDefined();
      // framing is null OR an object with .kind ∈ {newFrame, wrappedFrame}
      if (s.effects.framing !== null) {
        expect(['newFrame', 'wrappedFrame']).toContain(s.effects.framing.kind);
      }
      // substrateWrites is always an array; wrappedFrame implies empty top-level
      expect(Array.isArray(s.effects.substrateWrites)).toBe(true);
      if (s.effects.framing?.kind === 'wrappedFrame') {
        expect(s.effects.substrateWrites).toEqual([]);
        expect(Array.isArray(s.effects.framing.writes)).toBe(true);
      }
    }
  });

  it('P2: pure verbs never mutate input arrays', () => {
    const arr = [b('a', 'txt', 'hello'), b('b', 'txt', 'world')];
    const snap = JSON.parse(JSON.stringify(arr));
    blocks.updateBlockHtml(arr, 'a', 'hi');
    blocks.searchReplaceAt(arr, 'a', 0, 5, 'XYZ');
    blocks.deleteBlock(arr, 'b', tcOff);
    blocks.createBlockAfter(arr, 'a', { newId: 'n', tcState: tcOn });
    blocks.complianceAcceptGroup(arr, new Map([['a', 'fixed']]));
    blocks.acceptAllRevisionsVerb(arr);
    expect(arr).toEqual(snap);
  });

  it('P3: substrate writes reference only blocks that survive in state', () => {
    const arr = [b('a', 'txt', 'hello'), b('b', 'txt', 'world')];
    const samples = [
      blocks.updateBlockHtml(arr, 'a', 'hi'),
      blocks.searchReplaceAt(arr, 'a', 0, 5, 'HI'),
      blocks.applyInlineFix(arr, 'a', 'fix'),
      blocks.complianceAcceptGroup(arr, new Map([['a', 'fix']])),
    ];
    for (const s of samples) {
      const ids = new Set(s.state.map(x => x.id));
      const sources = [
        ...s.effects.substrateWrites,
        ...(s.effects.framing?.kind === 'wrappedFrame' ? s.effects.framing.writes : []),
      ];
      for (const w of sources) {
        expect(ids.has(w.blockId)).toBe(true);
      }
    }
  });

  it('P4: focus.blockId always references a block that exists in state (when not removed)', () => {
    const arr = [b('a', 'txt'), b('b', 'txt')];
    const r = blocks.createBlockAfter(arr, 'a', { newId: 'new1', tcState: tcOff });
    const ids = new Set(r.state.map(x => x.id));
    expect(ids.has(r.effects.focus.blockId)).toBe(true);
    // deleteBlock focus targets the PRIOR block (preserved in state)
    const rDel = blocks.deleteBlock(arr, 'b', tcOff);
    const idsDel = new Set(rDel.state.map(x => x.id));
    expect(idsDel.has(rDel.effects.focus.blockId)).toBe(true);
  });
});

// ── Dispatcher tests ────────────────────────────────────────────────────────

function makeDeps(initialBlocks, overrides = {}) {
  const ref = { current: initialBlocks };
  const setBlocks = vi.fn(next => { ref.current = next; });
  const framing = {
    forceFrame: vi.fn(),
    withUndoFrame: vi.fn(fn => fn()),
  };
  const setFocusedBlockId = vi.fn();
  const focusBlock = vi.fn();
  return {
    blocksRef: ref,
    setBlocks,
    yStore: overrides.yStore !== undefined ? overrides.yStore : { __fake: true },
    framing,
    setFocusedBlockId,
    focusBlock,
  };
}

describe('dispatchBlocksVerb', () => {
  it('bails on null compute result', () => {
    const deps = makeDeps([b('a', 'txt')]);
    const r = blocks.dispatchBlocksVerb(deps, () => null);
    expect(r).toEqual({ dispatched: false });
    expect(deps.setBlocks).not.toHaveBeenCalled();
    expect(deps.framing.forceFrame).not.toHaveBeenCalled();
  });

  it('bails on no-op (state unchanged, no effects)', () => {
    const arr = [b('a', 'txt', 'hello')];
    const deps = makeDeps(arr);
    const r = blocks.dispatchBlocksVerb(deps, (b) => blocks.updateBlockHtml(b, 'a', 'hello'));
    expect(r.dispatched).toBe(false);
    expect(deps.setBlocks).not.toHaveBeenCalled();
  });

  it('applies forceFrame BEFORE substrate writes BEFORE setBlocks', () => {
    const arr = [b('a', 'txt', 'old')];
    const deps = makeDeps(arr);
    const order = [];
    deps.framing.forceFrame.mockImplementation(() => order.push('forceFrame'));
    deps.setBlocks.mockImplementation(next => { order.push('setBlocks'); deps.blocksRef.current = next; });
    setBlockHtml.mockImplementation(() => order.push('setBlockHtml'));
    blocks.dispatchBlocksVerb(deps, (b) => blocks.applyInlineFix(b, 'a', 'new'));
    expect(order).toEqual(['forceFrame', 'setBlockHtml', 'setBlocks']);
  });

  it('uses withUndoFrame for framing=wrappedFrame', () => {
    const arr = [b('a', 'txt', 'old-a'), b('b', 'txt', 'old-b')];
    const deps = makeDeps(arr);
    const fixes = new Map([['a', 'new-a'], ['b', 'new-b']]);
    blocks.dispatchBlocksVerb(deps, (b) => blocks.complianceAcceptGroup(b, fixes));
    expect(deps.framing.withUndoFrame).toHaveBeenCalledTimes(1);
    expect(setBlockHtml).toHaveBeenCalledTimes(2);
    // No forceFrame for wrappedFrame branch
    expect(deps.framing.forceFrame).not.toHaveBeenCalled();
  });

  it('skips substrate writes when yStore is null', () => {
    const arr = [b('a', 'txt', 'old')];
    const deps = makeDeps(arr, { yStore: null });
    blocks.dispatchBlocksVerb(deps, (b) => blocks.applyInlineFix(b, 'a', 'new'));
    expect(setBlockHtml).not.toHaveBeenCalled();
    expect(deps.setBlocks).toHaveBeenCalledTimes(1);
    expect(deps.framing.forceFrame).toHaveBeenCalledTimes(1);
  });

  it('preFlush=all runs flushAllPendingUpdates BEFORE compute', () => {
    const arr = [b('a', 'txt', 'plain <ins>x</ins>')];
    const deps = makeDeps(arr);
    let computeCalledAfterFlush = false;
    flushAllPendingUpdates.mockImplementation(() => { computeCalledAfterFlush = false; });
    const compute = vi.fn(b => {
      computeCalledAfterFlush = flushAllPendingUpdates.mock.calls.length === 1;
      return blocks.acceptAllRevisionsVerb(b);
    });
    blocks.dispatchBlocksVerb(deps, compute, { preFlush: 'all' });
    expect(flushAllPendingUpdates).toHaveBeenCalledTimes(1);
    expect(computeCalledAfterFlush).toBe(true);
  });

  it('focus.kind=setFocused calls setFocusedBlockId synchronously', () => {
    const arr = [b('a', 'txt', 'hello')];
    const deps = makeDeps(arr);
    blocks.dispatchBlocksVerb(deps, (b) => blocks.createBlockAfter(b, 'a', { newId: 'n', tcState: tcOff }));
    expect(deps.setFocusedBlockId).toHaveBeenCalledWith('n');
  });

  it('focus.kind=imperative queues focusBlock via setTimeout(...,0)', async () => {
    const arr = [b('a', 'txt'), b('b', 'txt')];
    const deps = makeDeps(arr);
    blocks.dispatchBlocksVerb(deps, (b) => blocks.deleteBlock(b, 'b', tcOff));
    // synchronous part: setBlocks already called
    expect(deps.setBlocks).toHaveBeenCalledTimes(1);
    // imperative focus deferred — yield once
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(deps.focusBlock).toHaveBeenCalledWith('a', true);
  });

  it('returns {dispatched: true, state} for successful dispatch', () => {
    const arr = [b('a', 'txt', 'hello')];
    const deps = makeDeps(arr);
    const r = blocks.dispatchBlocksVerb(deps, (b) => blocks.updateBlockHtml(b, 'a', 'hi'));
    expect(r.dispatched).toBe(true);
    expect(r.state[0].html).toBe('hi');
  });
});

describe('blocks API surface', () => {
  it('exports the expected functions', () => {
    const names = [
      // Verbs
      'updateBlockHtml',
      'updateBlockHtmlPmSync',
      'searchReplaceAt',
      'applyInlineFix',
      'complianceAcceptGroup',
      'removeOrphanedRid',
      'addReference',
      'createBlockAfter',
      'deleteBlock',
      'changeOliLevel',
      'convertToTitle',
      'convertBlock',
      'promoteTitle',
      'demoteTitle',
      'reorderSectionVerb',
      'acceptBlockRevision',
      'rejectBlockRevision',
      'acceptAllRevisionsVerb',
      'rejectAllRevisionsVerb',
      'mergeBlockData',
      'updateRefScalar',
      // Dispatcher
      'dispatchBlocksVerb',
      // Re-export
      'focusBlockById',
    ];
    for (const n of names) {
      expect(typeof blocks[n]).toBe('function');
    }
  });
});
