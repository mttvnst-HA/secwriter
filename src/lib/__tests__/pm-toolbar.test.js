// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import { schema } from '../pm-schema.js';
import {
  findFirstMatchingMark,
  rangeAllHaveMarkWithAttrs,
  findMarkRangeAt,
} from '../pm-toolbar.js';

// Test fixture: build a tiny single-paragraph doc.
function docOf(...children) {
  return schema.node('doc', null, [schema.node('paragraph', null, children)]);
}
function txt(text, ...marks) {
  return schema.text(text, marks);
}
function stateOf(doc, from = 0, to = from) {
  const sel = TextSelection.create(doc, from, to);
  return EditorState.create({ doc, selection: sel });
}

describe('findFirstMatchingMark', () => {
  it('returns the matching Mark instance when present', () => {
    const rid = schema.marks.inlineMark.create({ kind: 'rid', option: null });
    const doc = docOf(txt('foo ', rid), txt('plain'));
    // 'foo ' occupies positions 1..5; 'plain' occupies 5..10.
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
    const add = schema.marks.revision.create({ kind: 'add', authorId: 'A' });
    const doc = docOf(txt('hello', add));
    const all = rangeAllHaveMarkWithAttrs(
      doc, 1, 6, schema.marks.revision,
      (a) => a.kind === 'add' && a.authorId === 'A',
    );
    expect(all).toBe(true);
  });

  it('returns false when a portion of range has a different author', () => {
    const addA = schema.marks.revision.create({ kind: 'add', authorId: 'A' });
    const addB = schema.marks.revision.create({ kind: 'add', authorId: 'B' });
    const doc = docOf(txt('hi', addA), txt('there', addB));
    // 'hi' = positions 1..3; 'there' = 3..8.
    const all = rangeAllHaveMarkWithAttrs(
      doc, 1, 8, schema.marks.revision,
      (a) => a.kind === 'add' && a.authorId === 'A',
    );
    expect(all).toBe(false);
  });

  it('returns false for empty range (no text traversed)', () => {
    const doc = docOf(txt('hello'));
    expect(rangeAllHaveMarkWithAttrs(doc, 3, 3, schema.marks.revision, () => true)).toBe(false);
  });
});

describe('findMarkRangeAt', () => {
  it('returns the contiguous range over which the mark extends', () => {
    const add = schema.marks.revision.create({ kind: 'add', authorId: 'A' });
    const doc = docOf(txt('xx'), txt('marked', add), txt('yy'));
    // 'xx'=1..3, 'marked'=3..9, 'yy'=9..11.
    const r = findMarkRangeAt(doc, 5, schema.marks.revision, () => true);
    expect(r).not.toBeNull();
    expect(r.from).toBe(3);
    expect(r.to).toBe(9);
    expect(r.mark.attrs.kind).toBe('add');
  });

  it('finds the mark at the immediate right boundary (inclusive: true default)', () => {
    // pm-schema does NOT set inclusive: false on revision, so a cursor exactly
    // at the end of the marked text still sees the mark via the prior child.
    const add = schema.marks.revision.create({ kind: 'add', authorId: 'A' });
    const doc = docOf(txt('marked', add), txt('after'));
    // 'marked' = 1..7. Cursor at 7 = immediate right boundary.
    const r = findMarkRangeAt(doc, 7, schema.marks.revision, () => true);
    // The mark is on the LEFT child of the boundary, so we should find it.
    expect(r).not.toBeNull();
    expect(r.from).toBe(1);
    expect(r.to).toBe(7);
  });

  it('returns null when cursor is one position past the mark', () => {
    const add = schema.marks.revision.create({ kind: 'add', authorId: 'A' });
    const doc = docOf(txt('marked', add), txt('after'));
    // 'after' starts at 7; position 8 is one char into 'after', clearly no mark.
    const r = findMarkRangeAt(doc, 8, schema.marks.revision, () => true);
    expect(r).toBeNull();
  });

  it('does not span adjacent marks with different attrs', () => {
    // [A-add][B-add] — cursor inside B's range should return only B's range.
    const addA = schema.marks.revision.create({ kind: 'add', authorId: 'A' });
    const addB = schema.marks.revision.create({ kind: 'add', authorId: 'B' });
    const doc = docOf(txt('aa', addA), txt('bb', addB));
    // 'aa'=1..3 (mark A), 'bb'=3..5 (mark B). Cursor at 4 = inside B.
    const r = findMarkRangeAt(doc, 4, schema.marks.revision, () => true);
    expect(r).not.toBeNull();
    expect(r.from).toBe(3);
    expect(r.to).toBe(5);
    expect(r.mark.attrs.authorId).toBe('B');
  });

  it('cursor at parentOffset 0 inside unmarked first child returns null (no-throw)', () => {
    // Defensive pin: cursor at the very start of an unmarked first child
    // hits the re-anchor branch with cursorChildIdx === 0 → no prior child
    // to look back at → must return null without throwing.
    const add = schema.marks.revision.create({ kind: 'add', authorId: 'A' });
    const doc = docOf(txt('unmarked'), txt('marked', add));
    // 'unmarked' = 1..9 (no mark); cursor at position 1 = parentOffset 0.
    const r = findMarkRangeAt(doc, 1, schema.marks.revision, () => true);
    expect(r).toBeNull();
  });

  it('also works for inlineMark (RID) — not just revision marks', () => {
    const rid = schema.marks.inlineMark.create({ kind: 'rid', option: null });
    const doc = docOf(txt('xx'), txt('rid-marked', rid), txt('yy'));
    // 'xx'=1..3, 'rid-marked'=3..13, 'yy'=13..15. Cursor at 8 = inside rid.
    const r = findMarkRangeAt(doc, 8, schema.marks.inlineMark, (a) => a.kind === 'rid');
    expect(r).not.toBeNull();
    expect(r.from).toBe(3);
    expect(r.to).toBe(13);
  });
});
