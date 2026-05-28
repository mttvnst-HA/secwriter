// Unit tests for blocks.convertBlockType + composeRevision + levelDelta.
// Mirrors the mock pattern from blocks.test.js (block-html-store +
// block-registry stubs).

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../block-html-store.js', () => ({
  setBlockHtml: vi.fn(),
  setBlockHtmlSilent: vi.fn(),
  getBlockHtml: vi.fn(),
  seedBlockArray: vi.fn(),
  resetBlockArray: vi.fn(),
}));

vi.mock('../block-registry.js', () => ({
  flushPendingUpdateById: vi.fn(),
  flushAllPendingUpdates: vi.fn(),
  focusBlockById: vi.fn(),
  getBlockHandle: vi.fn(),
  getBlockView: vi.fn(),
}));

vi.mock('../../components/SearchBar.jsx', () => ({
  replaceMatchInHtml: (h) => h,
  default: () => null,
}));

import { convertBlockType, composeRevision, levelDelta } from '../blocks.js';

const FAMILY_A = ['txt', 'note', 'oli', 'item', 'lst'];
const tcOff = { enabled: false, publishSeq: 0 };
const tcOn = { enabled: true, publishSeq: 0 };

function blk(overrides = {}) {
  return {
    id: 'b1',
    type: 'txt',
    part: 1,
    depth: 0,
    section: 'n0',
    html: '<p>hello</p>',
    ...overrides,
  };
}

describe('convertBlockType', () => {
  describe('preconditions', () => {
    it('returns null when blockId not found', () => {
      expect(convertBlockType([blk()], 'missing', 'note', { tcState: tcOff })).toBeNull();
    });
    it('returns null when newType not in Family A', () => {
      expect(convertBlockType([blk()], 'b1', 'title', { tcState: tcOff })).toBeNull();
      expect(convertBlockType([blk()], 'b1', 'table', { tcState: tcOff })).toBeNull();
      expect(convertBlockType([blk()], 'b1', 'ref', { tcState: tcOff })).toBeNull();
      expect(convertBlockType([blk()], 'b1', 'pagebreak', { tcState: tcOff })).toBeNull();
    });
    it('returns null when source block type not in Family A', () => {
      const b = blk({ type: 'title', depth: 1 });
      expect(convertBlockType([b], 'b1', 'note', { tcState: tcOff })).toBeNull();
    });
    it('returns null when newType equals current type', () => {
      expect(convertBlockType([blk({ type: 'note' })], 'b1', 'note', { tcState: tcOff })).toBeNull();
    });
  });

  describe('preserves html across all 20 ordered Family A pairs', () => {
    const html = '<p>preserve me <span class="mark-comment" data-comment-id="c1">word</span></p>';
    for (const from of FAMILY_A) {
      for (const to of FAMILY_A) {
        if (from === to) continue;
        it(`${from} -> ${to}`, () => {
          const b = blk({ type: from, html, ...(from === 'oli' ? { level: 2 } : {}) });
          const result = convertBlockType([b], 'b1', to, { tcState: tcOff });
          expect(result).not.toBeNull();
          expect(result.state[0].type).toBe(to);
          expect(result.state[0].html).toBe(html);
        });
      }
    }
  });

  describe('level delta', () => {
    it('entering oli with no prior level sets level=1', () => {
      const result = convertBlockType([blk({ type: 'txt' })], 'b1', 'oli', { tcState: tcOff });
      expect(result.state[0].level).toBe(1);
    });
    it('entering oli with stashed level restores it', () => {
      const result = convertBlockType([blk({ type: 'txt', level: 3 })], 'b1', 'oli', { tcState: tcOff });
      expect(result.state[0].level).toBe(3);
    });
    it('leaving oli preserves level on the block (stash)', () => {
      const result = convertBlockType([blk({ type: 'oli', level: 4 })], 'b1', 'txt', { tcState: tcOff });
      expect(result.state[0].level).toBe(4);
    });
    it('non-oli pair does not touch level', () => {
      const result = convertBlockType([blk({ type: 'txt' })], 'b1', 'note', { tcState: tcOff });
      expect(result.state[0]).not.toHaveProperty('level');
    });
  });

  describe('TC composition', () => {
    it('undefined revision under TC ON -> chg', () => {
      const result = convertBlockType([blk()], 'b1', 'note', { tcState: tcOn });
      expect(result.state[0].revision).toBe('chg');
    });
    it("'add' revision under TC ON preserved", () => {
      const result = convertBlockType([blk({ revision: 'add' })], 'b1', 'note', { tcState: tcOn });
      expect(result.state[0].revision).toBe('add');
    });
    it("'del' revision under TC ON preserved", () => {
      const result = convertBlockType([blk({ revision: 'del' })], 'b1', 'note', { tcState: tcOn });
      expect(result.state[0].revision).toBe('del');
    });
    it("'chg' revision under TC ON idempotent", () => {
      const result = convertBlockType([blk({ revision: 'chg' })], 'b1', 'note', { tcState: tcOn });
      expect(result.state[0].revision).toBe('chg');
    });
    it('TC OFF leaves revision unchanged (undefined stays undefined)', () => {
      const result = convertBlockType([blk()], 'b1', 'note', { tcState: tcOff });
      expect(result.state[0].revision).toBeUndefined();
    });
    it("TC OFF leaves 'chg' unchanged", () => {
      const result = convertBlockType([blk({ revision: 'chg' })], 'b1', 'note', { tcState: tcOff });
      expect(result.state[0].revision).toBe('chg');
    });
  });

  describe('__convertedFrom transient field', () => {
    it('sets __convertedFrom when TC ON and convert introduces chg', () => {
      const result = convertBlockType([blk({ type: 'txt' })], 'b1', 'note', { tcState: tcOn });
      expect(result.state[0].__convertedFrom).toBe('txt');
    });
    it('does not set __convertedFrom when TC OFF', () => {
      const result = convertBlockType([blk({ type: 'txt' })], 'b1', 'note', { tcState: tcOff });
      expect(result.state[0]).not.toHaveProperty('__convertedFrom');
    });
    it("does not set __convertedFrom when prev revision is 'add' (chg masked)", () => {
      const result = convertBlockType([blk({ revision: 'add' })], 'b1', 'note', { tcState: tcOn });
      expect(result.state[0]).not.toHaveProperty('__convertedFrom');
    });
    it("does not set __convertedFrom when prev revision is 'del' (chg masked)", () => {
      const result = convertBlockType([blk({ revision: 'del' })], 'b1', 'note', { tcState: tcOn });
      expect(result.state[0]).not.toHaveProperty('__convertedFrom');
    });
    it("does not set __convertedFrom when prev revision is already 'chg'", () => {
      // This convert isn't the source of 'chg' — a prior edit was.
      const result = convertBlockType([blk({ revision: 'chg' })], 'b1', 'note', { tcState: tcOn });
      expect(result.state[0]).not.toHaveProperty('__convertedFrom');
    });
  });

  describe('effects', () => {
    it('framing is newFrame', () => {
      const result = convertBlockType([blk()], 'b1', 'note', { tcState: tcOff });
      expect(result.effects.framing).toEqual({ kind: 'newFrame' });
    });
    it('substrateWrites is empty (type rides scalar publish)', () => {
      const result = convertBlockType([blk()], 'b1', 'note', { tcState: tcOff });
      expect(result.effects.substrateWrites).toEqual([]);
    });
    it('flush is null and focus is null (UI components own caret)', () => {
      const result = convertBlockType([blk()], 'b1', 'note', { tcState: tcOff });
      expect(result.effects.flush).toBeNull();
      expect(result.effects.focus).toBeNull();
    });
  });
});

describe('composeRevision', () => {
  it('TC ON, undefined -> chg', () => {
    expect(composeRevision(undefined, tcOn)).toBe('chg');
  });
  it('TC ON, add -> add', () => {
    expect(composeRevision('add', tcOn)).toBe('add');
  });
  it('TC ON, del -> del', () => {
    expect(composeRevision('del', tcOn)).toBe('del');
  });
  it('TC ON, chg -> chg', () => {
    expect(composeRevision('chg', tcOn)).toBe('chg');
  });
  it('TC OFF leaves all values unchanged', () => {
    expect(composeRevision(undefined, tcOff)).toBeUndefined();
    expect(composeRevision('add', tcOff)).toBe('add');
    expect(composeRevision('del', tcOff)).toBe('del');
    expect(composeRevision('chg', tcOff)).toBe('chg');
  });
});

describe('levelDelta', () => {
  it('entering oli with no prior level => { level: 1 }', () => {
    expect(levelDelta('txt', 'oli', undefined)).toEqual({ level: 1 });
  });
  it('entering oli with prior level => { level: priorLevel }', () => {
    expect(levelDelta('txt', 'oli', 3)).toEqual({ level: 3 });
  });
  it('leaving oli preserves level on block (returns {})', () => {
    expect(levelDelta('oli', 'txt', 4)).toEqual({});
  });
  it('non-oli pair returns {}', () => {
    expect(levelDelta('txt', 'note', undefined)).toEqual({});
  });
});
