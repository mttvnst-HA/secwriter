import { describe, it, expect } from 'vitest';
import { extractInlineRids, extractRefRids, validateRids, extractInlineSrfs, validateSrfs } from '../cross-ref-validation.js';

describe('extractInlineRids', () => {
  it('finds mark-rid spans in body blocks', () => {
    const blocks = [
      { id: 'b1', type: 'txt', html: 'See <span class="mark-rid">ASTM D2487</span> and <span class="mark-rid">ASTM D698</span>' },
      { id: 'b2', type: 'oli', html: 'Per <span class="mark-rid">ASTM D2487</span>' },
    ];
    const map = extractInlineRids(blocks);
    expect(map.get('ASTM D2487')).toEqual(['b1', 'b2']);
    expect(map.get('ASTM D698')).toEqual(['b1']);
  });

  it('ignores ref blocks', () => {
    const blocks = [
      { id: 'r1', type: 'ref', html: '<span class="mark-rid">ASTM D2487</span>', ref: { org: 'ASTM', entries: [] } },
    ];
    const map = extractInlineRids(blocks);
    expect(map.size).toBe(0);
  });

  it('ignores blocks without html', () => {
    const blocks = [
      { id: 'b1', type: 'txt', html: null },
      { id: 'b2', type: 'table', table: {} },
    ];
    const map = extractInlineRids(blocks);
    expect(map.size).toBe(0);
  });

  it('trims whitespace in RID text', () => {
    const blocks = [
      { id: 'b1', type: 'txt', html: '<span class="mark-rid"> ASTM D2487 </span>' },
    ];
    const map = extractInlineRids(blocks);
    expect(map.has('ASTM D2487')).toBe(true);
  });
});

describe('extractRefRids', () => {
  it('extracts RIDs from ref block entries', () => {
    const blocks = [
      {
        id: 'r1', type: 'ref',
        ref: { org: 'ASTM', entries: [{ rid: 'ASTM D2487', rtl: 'Classification' }, { rid: 'ASTM D698', rtl: 'Compaction' }] },
      },
    ];
    const map = extractRefRids(blocks);
    expect(map.get('ASTM D2487')).toBe('r1');
    expect(map.get('ASTM D698')).toBe('r1');
  });

  it('ignores non-ref blocks', () => {
    const blocks = [
      { id: 'b1', type: 'txt', html: 'text' },
    ];
    const map = extractRefRids(blocks);
    expect(map.size).toBe(0);
  });

  it('handles ref blocks with no entries', () => {
    const blocks = [
      { id: 'r1', type: 'ref', ref: { org: 'ASTM', entries: [] } },
    ];
    const map = extractRefRids(blocks);
    expect(map.size).toBe(0);
  });

  it('trims whitespace in entry RID text', () => {
    const blocks = [
      { id: 'r1', type: 'ref', ref: { org: 'ASTM', entries: [{ rid: ' ASTM D2487 ', rtl: 'test' }] } },
    ];
    const map = extractRefRids(blocks);
    expect(map.has('ASTM D2487')).toBe(true);
  });
});

describe('validateRids', () => {
  it('returns empty arrays when all matched', () => {
    const blocks = [
      { id: 'b1', type: 'txt', html: '<span class="mark-rid">ASTM D2487</span>' },
      { id: 'r1', type: 'ref', ref: { org: 'ASTM', entries: [{ rid: 'ASTM D2487', rtl: 'test' }] } },
    ];
    const { unlinked, orphaned } = validateRids(blocks);
    expect(unlinked).toEqual([]);
    expect(orphaned).toEqual([]);
  });

  it('detects unlinked citations (in body, not in refs)', () => {
    const blocks = [
      { id: 'b1', type: 'txt', html: '<span class="mark-rid">ASTM D2487</span>' },
    ];
    const { unlinked, orphaned } = validateRids(blocks);
    expect(unlinked).toEqual(['ASTM D2487']);
    expect(orphaned).toEqual([]);
  });

  it('detects orphaned entries (in refs, not in body)', () => {
    const blocks = [
      { id: 'r1', type: 'ref', ref: { org: 'ASTM', entries: [{ rid: 'ASTM D2487', rtl: 'test' }] } },
    ];
    const { unlinked, orphaned } = validateRids(blocks);
    expect(unlinked).toEqual([]);
    expect(orphaned).toEqual(['ASTM D2487']);
  });

  it('handles mixed results', () => {
    const blocks = [
      { id: 'b1', type: 'txt', html: '<span class="mark-rid">ASTM D2487</span> and <span class="mark-rid">AWS D1.1</span>' },
      { id: 'r1', type: 'ref', ref: { org: 'ASTM', entries: [{ rid: 'ASTM D2487', rtl: 'Soils' }, { rid: 'ASTM D698', rtl: 'Compaction' }] } },
    ];
    const { unlinked, orphaned } = validateRids(blocks);
    expect(unlinked).toEqual(['AWS D1.1']);
    expect(orphaned).toEqual(['ASTM D698']);
  });

  it('returns empty for empty blocks array', () => {
    const { unlinked, orphaned } = validateRids([]);
    expect(unlinked).toEqual([]);
    expect(orphaned).toEqual([]);
  });
});

describe('extractInlineSrfs', () => {
  it('returns empty map for blocks with no SRF marks', () => {
    const blocks = [
      { id: 'b1', type: 'txt', html: 'No section refs here' },
    ];
    expect(extractInlineSrfs(blocks).size).toBe(0);
  });

  it('extracts SRFs from body blocks', () => {
    const blocks = [
      { id: 'b1', type: 'txt', html: 'See <span class="mark-srf">01 33 00</span> and <span class="mark-srf">31 11 00</span>' },
    ];
    const map = extractInlineSrfs(blocks);
    expect(map.get('01 33 00')).toEqual(['b1']);
    expect(map.get('31 11 00')).toEqual(['b1']);
  });

  it('skips ref-type blocks', () => {
    const blocks = [
      { id: 'r1', type: 'ref', html: '<span class="mark-srf">01 33 00</span>', ref: { org: 'TEST', entries: [] } },
    ];
    expect(extractInlineSrfs(blocks).size).toBe(0);
  });

  it('collects multiple block IDs for same SRF', () => {
    const blocks = [
      { id: 'b1', type: 'txt', html: 'See <span class="mark-srf">32 92 19</span>' },
      { id: 'b2', type: 'oli', html: 'Per <span class="mark-srf">32 92 19</span>' },
    ];
    const map = extractInlineSrfs(blocks);
    expect(map.get('32 92 19')).toEqual(['b1', 'b2']);
  });
});

describe('validateSrfs', () => {
  it('detects self-referencing section number', () => {
    const blocks = [
      { id: 'b1', type: 'txt', html: 'See <span class="mark-srf">31 00 00</span>' },
    ];
    const { selfReferences } = validateSrfs(blocks, '31 00 00');
    expect(selfReferences).toEqual(['31 00 00']);
  });

  it('returns empty selfReferences when no self-ref', () => {
    const blocks = [
      { id: 'b1', type: 'txt', html: 'See <span class="mark-srf">01 33 00</span>' },
    ];
    const { selfReferences } = validateSrfs(blocks, '31 00 00');
    expect(selfReferences).toEqual([]);
  });

  it('builds allSrfs inventory with counts sorted by section number', () => {
    const blocks = [
      { id: 'b1', type: 'txt', html: '<span class="mark-srf">32 92 19</span> and <span class="mark-srf">01 33 00</span>' },
      { id: 'b2', type: 'txt', html: '<span class="mark-srf">32 92 19</span>' },
    ];
    const { allSrfs } = validateSrfs(blocks, '31 00 00');
    expect(allSrfs).toEqual([
      { srf: '01 33 00', count: 1, blockIds: ['b1'] },
      { srf: '32 92 19', count: 2, blockIds: ['b1', 'b2'] },
    ]);
  });

  it('handles blocks with no SRFs', () => {
    const blocks = [
      { id: 'b1', type: 'txt', html: 'No refs' },
    ];
    const { selfReferences, allSrfs } = validateSrfs(blocks, '31 00 00');
    expect(selfReferences).toEqual([]);
    expect(allSrfs).toEqual([]);
  });
});
