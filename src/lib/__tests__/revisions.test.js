import { describe, it, expect } from 'vitest';
import {
  acceptInlineAdd,
  acceptInlineDel,
  rejectInlineAdd,
  rejectInlineDel,
  acceptAllInline,
  rejectAllInline,
  acceptBlockRevision,
  rejectBlockRevision,
  acceptAllRevisions,
  rejectAllRevisions,
  countRevisions,
} from '../revisions.js';

// ─── Inline operations ──────────────────────────────────────────────────────

describe('acceptInlineAdd', () => {
  it('strips ins tags, keeps content', () => {
    expect(acceptInlineAdd('Hello <ins class="mark-add">world</ins>!'))
      .toBe('Hello world!');
  });
  it('handles multiple adds', () => {
    expect(acceptInlineAdd('<ins class="mark-add">A</ins> and <ins class="mark-add">B</ins>'))
      .toBe('A and B');
  });
  it('returns null/empty unchanged', () => {
    expect(acceptInlineAdd(null)).toBe(null);
    expect(acceptInlineAdd('')).toBe('');
  });
});

describe('acceptInlineDel', () => {
  it('removes del tags AND content', () => {
    expect(acceptInlineDel('Keep <del class="mark-del">remove this</del> text'))
      .toBe('Keep  text');
  });
  it('handles nested content in del', () => {
    expect(acceptInlineDel('<del class="mark-del"><b>bold deleted</b></del>'))
      .toBe('');
  });
});

describe('rejectInlineAdd', () => {
  it('removes ins tags AND content', () => {
    expect(rejectInlineAdd('Keep <ins class="mark-add">reject this</ins> text'))
      .toBe('Keep  text');
  });
});

describe('rejectInlineDel', () => {
  it('strips del tags, keeps content (restore)', () => {
    expect(rejectInlineDel('Hello <del class="mark-del">restored</del> text'))
      .toBe('Hello restored text');
  });
});

describe('acceptAllInline', () => {
  it('accepts all inline revisions (ADD stays, DEL removed)', () => {
    const html = '<ins class="mark-add">new</ins> text <del class="mark-del">old</del>';
    expect(acceptAllInline(html)).toBe('new text ');
  });
});

describe('rejectAllInline', () => {
  it('rejects all inline revisions (ADD removed, DEL restored)', () => {
    const html = '<ins class="mark-add">new</ins> text <del class="mark-del">old</del>';
    expect(rejectAllInline(html)).toBe(' text old');
  });
});

// ─── Block operations ────────────────────────────────────────────────────────

describe('acceptBlockRevision', () => {
  const blocks = [
    { id: 'a', type: 'txt', html: 'hello' },
    { id: 'b', type: 'txt', html: 'added', revision: 'add' },
    { id: 'c', type: 'txt', html: 'deleted', revision: 'del' },
    { id: 'd', type: 'txt', html: 'changed', revision: 'chg' },
  ];

  it('accept ADD: clears revision, keeps block', () => {
    const result = acceptBlockRevision(blocks, 'b');
    const found = result.find(b => b.id === 'b');
    expect(found).toBeTruthy();
    expect(found.revision).toBeUndefined();
  });

  it('accept DEL: removes block', () => {
    const result = acceptBlockRevision(blocks, 'c');
    expect(result.find(b => b.id === 'c')).toBeUndefined();
    expect(result.length).toBe(3);
  });

  it('accept CHG: clears revision, keeps block', () => {
    const result = acceptBlockRevision(blocks, 'd');
    const found = result.find(b => b.id === 'd');
    expect(found).toBeTruthy();
    expect(found.revision).toBeUndefined();
  });

  it('non-matching block is unchanged', () => {
    const result = acceptBlockRevision(blocks, 'b');
    expect(result.find(b => b.id === 'a')).toEqual(blocks[0]);
  });
});

describe('rejectBlockRevision', () => {
  const blocks = [
    { id: 'a', type: 'txt', html: 'hello' },
    { id: 'b', type: 'txt', html: 'added', revision: 'add' },
    { id: 'c', type: 'txt', html: 'deleted', revision: 'del' },
    { id: 'd', type: 'txt', html: 'changed', revision: 'chg' },
  ];

  it('reject ADD: removes block', () => {
    const result = rejectBlockRevision(blocks, 'b');
    expect(result.find(b => b.id === 'b')).toBeUndefined();
    expect(result.length).toBe(3);
  });

  it('reject DEL: clears revision, keeps block (restore)', () => {
    const result = rejectBlockRevision(blocks, 'c');
    const found = result.find(b => b.id === 'c');
    expect(found).toBeTruthy();
    expect(found.revision).toBeUndefined();
  });

  it('reject CHG: clears revision, keeps block', () => {
    const result = rejectBlockRevision(blocks, 'd');
    const found = result.find(b => b.id === 'd');
    expect(found).toBeTruthy();
    expect(found.revision).toBeUndefined();
  });
});

// ─── Batch operations ────────────────────────────────────────────────────────

describe('acceptAllRevisions', () => {
  it('accepts all block and inline revisions', () => {
    const blocks = [
      { id: 'a', type: 'txt', html: 'normal' },
      { id: 'b', type: 'txt', html: '<ins class="mark-add">inline add</ins>', revision: 'add' },
      { id: 'c', type: 'txt', html: 'deleted block', revision: 'del' },
      { id: 'd', type: 'txt', html: 'text <del class="mark-del">removed</del> rest', revision: 'chg' },
    ];
    const result = acceptAllRevisions(blocks);
    // Block 'c' (del) should be removed
    expect(result.length).toBe(3);
    expect(result.find(b => b.id === 'c')).toBeUndefined();
    // Block 'b' (add) should have revision cleared and ins tags stripped
    const blockB = result.find(b => b.id === 'b');
    expect(blockB.revision).toBeUndefined();
    expect(blockB.html).toBe('inline add');
    // Block 'd' (chg) should have revision cleared and del content removed
    const blockD = result.find(b => b.id === 'd');
    expect(blockD.revision).toBeUndefined();
    expect(blockD.html).toBe('text  rest');
  });
});

describe('rejectAllRevisions', () => {
  it('rejects all block and inline revisions', () => {
    const blocks = [
      { id: 'a', type: 'txt', html: 'normal' },
      { id: 'b', type: 'txt', html: '<ins class="mark-add">inline add</ins>', revision: 'add' },
      { id: 'c', type: 'txt', html: 'deleted block', revision: 'del' },
      { id: 'd', type: 'txt', html: 'text <del class="mark-del">restored</del> rest' },
    ];
    const result = rejectAllRevisions(blocks);
    // Block 'b' (add) should be removed
    expect(result.find(b => b.id === 'b')).toBeUndefined();
    // Block 'c' (del) should have revision cleared (restored)
    const blockC = result.find(b => b.id === 'c');
    expect(blockC).toBeTruthy();
    expect(blockC.revision).toBeUndefined();
    // Block 'd' should have del content restored
    const blockD = result.find(b => b.id === 'd');
    expect(blockD.html).toBe('text restored rest');
  });
});

// ─── Stats ───────────────────────────────────────────────────────────────────

describe('countRevisions', () => {
  it('counts block-level revisions', () => {
    const blocks = [
      { id: 'a', type: 'txt', html: '' },
      { id: 'b', type: 'txt', html: '', revision: 'add' },
      { id: 'c', type: 'txt', html: '', revision: 'del' },
      { id: 'd', type: 'txt', html: '', revision: 'chg' },
    ];
    expect(countRevisions(blocks)).toEqual({ adds: 1, dels: 1, chgs: 1 });
  });

  it('counts inline revisions', () => {
    const blocks = [
      { id: 'a', type: 'txt', html: '<ins class="mark-add">A</ins> <ins class="mark-add">B</ins> <del class="mark-del">C</del>' },
    ];
    expect(countRevisions(blocks)).toEqual({ adds: 2, dels: 1, chgs: 0 });
  });

  it('counts both block and inline revisions', () => {
    const blocks = [
      { id: 'a', type: 'txt', html: '<ins class="mark-add">inline</ins>', revision: 'add' },
      { id: 'b', type: 'txt', html: '<span class="mark-chg">changed</span>' },
    ];
    expect(countRevisions(blocks)).toEqual({ adds: 2, dels: 0, chgs: 1 });
  });

  it('returns zeros for no revisions', () => {
    const blocks = [
      { id: 'a', type: 'txt', html: 'normal text' },
    ];
    expect(countRevisions(blocks)).toEqual({ adds: 0, dels: 0, chgs: 0 });
  });
});
