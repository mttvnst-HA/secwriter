// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { schema } from '../pm-schema.js';
import * as pmToolbar from '../pm-toolbar.js';
import {
  findFirstMatchingMark,
  rangeAllHaveMarkWithAttrs,
  findMarkRangeAt,
} from '../pm-toolbar.js';

function docOf(...children) {
  return schema.node('doc', null, [schema.node('paragraph', null, children)]);
}
function txt(text, ...marks) {
  return schema.text(text, marks);
}

describe('findFirstMatchingMark', () => {
  it('returns the matching Mark instance when present', () => {
    const rid = schema.marks.inlineMark.create({ kind: 'rid', option: null });
    const doc = docOf(txt('foo ', rid), txt('plain'));
    const mark = findFirstMatchingMark(doc, 1, 4, schema.marks.inlineMark, (a) => a.kind === 'rid');
    expect(mark).not.toBeNull();
    expect(mark.attrs.kind).toBe('rid');
  });

  it('returns null when no text node in range carries a matching mark', () => {
    const srf = schema.marks.inlineMark.create({ kind: 'srf', option: null });
    const doc = docOf(txt('foo ', srf), txt('plain'));
    const mark = findFirstMatchingMark(doc, 1, 4, schema.marks.inlineMark, (a) => a.kind === 'rid');
    expect(mark).toBeNull();
  });
});

describe('rangeAllHaveMarkWithAttrs', () => {
  it('returns true when every text node in range has matching mark', () => {
    const add = schema.marks.revisionAdd.create({ authorId: 'A' });
    const doc = docOf(txt('hello', add));
    const all = rangeAllHaveMarkWithAttrs(
      doc, 1, 6, schema.marks.revisionAdd,
      (a) => a.authorId === 'A',
    );
    expect(all).toBe(true);
  });

  it('returns false when a portion of range has a different author', () => {
    const addA = schema.marks.revisionAdd.create({ authorId: 'A' });
    const addB = schema.marks.revisionAdd.create({ authorId: 'B' });
    const doc = docOf(txt('hi', addA), txt('there', addB));
    const all = rangeAllHaveMarkWithAttrs(
      doc, 1, 8, schema.marks.revisionAdd,
      (a) => a.authorId === 'A',
    );
    expect(all).toBe(false);
  });

  it('returns false for empty range (no text traversed)', () => {
    const doc = docOf(txt('hello'));
    expect(rangeAllHaveMarkWithAttrs(doc, 3, 3, schema.marks.revisionAdd, () => true)).toBe(false);
  });
});

describe('findMarkRangeAt', () => {
  it('returns the contiguous range over which the mark extends', () => {
    const add = schema.marks.revisionAdd.create({ authorId: 'A' });
    const doc = docOf(txt('xx'), txt('marked', add), txt('yy'));
    const r = findMarkRangeAt(doc, 5, schema.marks.revisionAdd, () => true);
    expect(r).not.toBeNull();
    expect(r.from).toBe(3);
    expect(r.to).toBe(9);
    expect(r.mark.type.name).toBe('revisionAdd');
  });

  it('finds the mark at the immediate right boundary (inclusive: true default)', () => {
    // pm-schema does NOT set inclusive: false on revisionAdd, so a cursor
    // exactly at the end of the marked text still sees the mark via the
    // prior child.
    const add = schema.marks.revisionAdd.create({ authorId: 'A' });
    const doc = docOf(txt('marked', add), txt('after'));
    const r = findMarkRangeAt(doc, 7, schema.marks.revisionAdd, () => true);
    expect(r).not.toBeNull();
    expect(r.from).toBe(1);
    expect(r.to).toBe(7);
  });

  it('returns null when cursor is one position past the mark', () => {
    const add = schema.marks.revisionAdd.create({ authorId: 'A' });
    const doc = docOf(txt('marked', add), txt('after'));
    const r = findMarkRangeAt(doc, 8, schema.marks.revisionAdd, () => true);
    expect(r).toBeNull();
  });

  it('does not span adjacent marks with different attrs', () => {
    const addA = schema.marks.revisionAdd.create({ authorId: 'A' });
    const addB = schema.marks.revisionAdd.create({ authorId: 'B' });
    const doc = docOf(txt('aa', addA), txt('bb', addB));
    const r = findMarkRangeAt(doc, 4, schema.marks.revisionAdd, () => true);
    expect(r).not.toBeNull();
    expect(r.from).toBe(3);
    expect(r.to).toBe(5);
    expect(r.mark.attrs.authorId).toBe('B');
  });

  it('cursor at parentOffset 0 inside unmarked first child returns null (no-throw)', () => {
    const add = schema.marks.revisionAdd.create({ authorId: 'A' });
    const doc = docOf(txt('unmarked'), txt('marked', add));
    const r = findMarkRangeAt(doc, 1, schema.marks.revisionAdd, () => true);
    expect(r).toBeNull();
  });

  it('also works for inlineMark (RID) — not just revision marks', () => {
    const rid = schema.marks.inlineMark.create({ kind: 'rid', option: null });
    const doc = docOf(txt('xx'), txt('rid-marked', rid), txt('yy'));
    const r = findMarkRangeAt(doc, 8, schema.marks.inlineMark, (a) => a.kind === 'rid');
    expect(r).not.toBeNull();
    expect(r.from).toBe(3);
    expect(r.to).toBe(13);
  });

  it('1g.6: distinguishes revisionAdd from revisionDel at the same position', () => {
    // With the schema split, both marks can coexist on one character. The
    // resolver must lookup by specific MarkType to get the right range.
    const add = schema.marks.revisionAdd.create({ authorId: 'A' });
    const del = schema.marks.revisionDel.create({ authorId: 'B' });
    const doc = docOf(txt('xx'), txt('overlap', add, del), txt('yy'));
    // Find revisionAdd at position 5 (inside 'overlap')
    const rAdd = findMarkRangeAt(doc, 5, schema.marks.revisionAdd, () => true);
    expect(rAdd).not.toBeNull();
    expect(rAdd.mark.type.name).toBe('revisionAdd');
    expect(rAdd.mark.attrs.authorId).toBe('A');
    // Find revisionDel at the same position
    const rDel = findMarkRangeAt(doc, 5, schema.marks.revisionDel, () => true);
    expect(rDel).not.toBeNull();
    expect(rDel.mark.type.name).toBe('revisionDel');
    expect(rDel.mark.attrs.authorId).toBe('B');
    // Both range over the same span
    expect(rAdd.from).toBe(rDel.from);
    expect(rAdd.to).toBe(rDel.to);
  });
});

describe('pm-toolbar API surface', () => {
  it('exports the eight expected functions (U16)', () => {
    const names = [
      'applyFormatTr',
      'applyInlineMarkTr',
      'applyRevisionTr',
      'applyInlineRevisionResolveTr',
      'applyChangeCaseTr',
      'findFirstMatchingMark',
      'rangeAllHaveMarkWithAttrs',
      'findMarkRangeAt',
    ];
    for (const n of names) {
      expect(typeof pmToolbar[n]).toBe('function');
    }
  });
});
