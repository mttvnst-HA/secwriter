// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import { schema } from '../pm-schema.js';
import {
  findFirstMatchingMark,
  rangeAllHaveMarkWithAttrs,
  findMarkRangeAt,
  applyFormatTr,
  applyInlineMarkTr,
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

describe('applyFormatTr', () => {
  it.each(['bold', 'italic', 'underline'])(
    '%s — toggles ON over plain selection',
    (kind) => {
      const doc = docOf(txt('hello'));
      const state = stateOf(doc, 1, 6);
      const tr = applyFormatTr(state, kind);
      expect(tr).not.toBeNull();
      expect(tr.docChanged).toBe(true);
      const newState = state.apply(tr);
      const mark = findFirstMatchingMark(
        newState.doc, 1, 6, schema.marks[kind], () => true,
      );
      expect(mark).not.toBeNull();
    },
  );

  it.each(['bold', 'italic', 'underline'])(
    '%s — toggles OFF over already-marked selection',
    (kind) => {
      const markInstance = schema.marks[kind].create();
      const doc = docOf(txt('hello', markInstance));
      const state = stateOf(doc, 1, 6);
      const tr = applyFormatTr(state, kind);
      expect(tr).not.toBeNull();
      const newState = state.apply(tr);
      const mark = findFirstMatchingMark(
        newState.doc, 1, 6, schema.marks[kind], () => true,
      );
      expect(mark).toBeNull();
    },
  );

  it('returns null on empty selection', () => {
    const doc = docOf(txt('hello'));
    const state = stateOf(doc, 3, 3);
    expect(applyFormatTr(state, 'bold')).toBeNull();
  });
});

describe('applyInlineMarkTr', () => {
  it('RID toggles ON over plain selection', () => {
    const doc = docOf(txt('hello'));
    const state = stateOf(doc, 1, 6);
    const tr = applyInlineMarkTr(state, 'rid');
    expect(tr).not.toBeNull();
    const newState = state.apply(tr);
    const mark = findFirstMatchingMark(
      newState.doc, 1, 6, schema.marks.inlineMark, (a) => a.kind === 'rid',
    );
    expect(mark).not.toBeNull();
  });

  it('RID toggles OFF over RID-marked selection', () => {
    const rid = schema.marks.inlineMark.create({ kind: 'rid', option: null });
    const doc = docOf(txt('hello', rid));
    const state = stateOf(doc, 1, 6);
    const tr = applyInlineMarkTr(state, 'rid');
    const newState = state.apply(tr);
    expect(findFirstMatchingMark(
      newState.doc, 1, 6, schema.marks.inlineMark, (a) => a.kind === 'rid',
    )).toBeNull();
  });

  it('RID over SRF-marked text — attr-discrimination prevents spurious toggle-off', () => {
    // Attr-discrimination property: when SRF is present and the user clicks RID,
    // the detector queries (kind === 'rid') — which returns null. The fall-through
    // path is addMark(RID). Under PM's default excludes: '_' (one inlineMark per
    // text run), RID replaces SRF. The KEY invariant being tested is that the
    // operation does not silently no-op (which would happen if stock rangeHasMark
    // were used: it returns true on SRF, the toggle calls removeMark, SRF is
    // stripped, no RID is added — user gets neither mark).
    const srf = schema.marks.inlineMark.create({ kind: 'srf', option: null });
    const doc = docOf(txt('hello', srf));
    const state = stateOf(doc, 1, 6);
    const tr = applyInlineMarkTr(state, 'rid');
    expect(tr).not.toBeNull();
    const newState = state.apply(tr);
    expect(findFirstMatchingMark(
      newState.doc, 1, 6, schema.marks.inlineMark, (a) => a.kind === 'rid',
    )).not.toBeNull();
  });

  it('TAI carries the option attr', () => {
    const doc = docOf(txt('hello'));
    const state = stateOf(doc, 1, 6);
    const tr = applyInlineMarkTr(state, 'tai', 'GULF');
    const newState = state.apply(tr);
    const mark = findFirstMatchingMark(
      newState.doc, 1, 6, schema.marks.inlineMark, (a) => a.kind === 'tai',
    );
    expect(mark).not.toBeNull();
    expect(mark.attrs.option).toBe('GULF');
  });

  it('returns null on empty selection', () => {
    const doc = docOf(txt('hello'));
    const state = stateOf(doc, 2, 2);
    expect(applyInlineMarkTr(state, 'rid')).toBeNull();
  });
});

import { applyRevisionTr } from '../pm-toolbar.js';

describe('applyRevisionTr', () => {
  it('applies ADD with current authorId', () => {
    const doc = docOf(txt('hello'));
    const state = stateOf(doc, 1, 6);
    const tr = applyRevisionTr(state, 'add', { authorId: 'A', authorColor: '#f00' });
    const newState = state.apply(tr);
    const mark = findFirstMatchingMark(
      newState.doc, 1, 6, schema.marks.revision, () => true,
    );
    expect(mark).not.toBeNull();
    expect(mark.attrs.kind).toBe('add');
    expect(mark.attrs.authorId).toBe('A');
    expect(mark.attrs.authorColor).toBe('#f00');
  });

  it('toggles off when ALL revisions in range match current (kind, authorId)', () => {
    const add = schema.marks.revision.create({ kind: 'add', authorId: 'A' });
    const doc = docOf(txt('hello', add));
    const state = stateOf(doc, 1, 6);
    const tr = applyRevisionTr(state, 'add', { authorId: 'A' });
    const newState = state.apply(tr);
    expect(findFirstMatchingMark(
      newState.doc, 1, 6, schema.marks.revision, () => true,
    )).toBeNull();
  });

  it('cross-author: B applies ADD over A\'s ADD — current author\'s mark wins', () => {
    // Under default excludes: '_', two revision marks cannot coexist on a
    // text node. The multi-author safety property is: B's apply does NOT
    // silently remove A's mark via toggle-off detection (which would happen
    // if stock rangeHasMark were used — it returns true on A's mark, the
    // toggle calls removeMark, A's mark is stripped, no new mark applied).
    // Correct behavior: detection queries (kind === 'add' && authorId === 'B')
    // and returns null → fall through to addMark with B's identity → B's
    // mark replaces A's. The user-visible result is "B's mark is now on
    // the text" — not "A's mark survived".
    const addA = schema.marks.revision.create({ kind: 'add', authorId: 'A' });
    const doc = docOf(txt('hello', addA));
    const state = stateOf(doc, 1, 6);
    const tr = applyRevisionTr(state, 'add', { authorId: 'B' });
    expect(tr).not.toBeNull();
    const newState = state.apply(tr);
    const markB = findFirstMatchingMark(
      newState.doc, 1, 6, schema.marks.revision, (a) => a.authorId === 'B',
    );
    expect(markB).not.toBeNull();
  });

  it('mixed-author range: A clicks ADD across [A-add][B-add] — toggle-off does NOT fire', () => {
    // The rangeAllHaveMarkWithAttrs check returns false (not all positions
    // are A's), so the toggle-off branch is skipped. Fall through to
    // addMark applies A's mark across the full range, replacing B's.
    // Important: we are testing the SAFETY CHECK ("don't toggle off"),
    // not that B's mark survives — under default excludes it cannot.
    const addA = schema.marks.revision.create({ kind: 'add', authorId: 'A' });
    const addB = schema.marks.revision.create({ kind: 'add', authorId: 'B' });
    const doc = docOf(txt('aa', addA), txt('bb', addB));
    const state = stateOf(doc, 1, 5);
    const tr = applyRevisionTr(state, 'add', { authorId: 'A' });
    expect(tr).not.toBeNull();
    const newState = state.apply(tr);
    // After the apply, A's mark should be present somewhere in the range.
    // (Toggle-off would have left the range with NO revision marks.)
    const stillSomeRevision = findFirstMatchingMark(
      newState.doc, 1, 5, schema.marks.revision, () => true,
    );
    expect(stillSomeRevision).not.toBeNull();
  });

  it('returns null on empty selection', () => {
    const doc = docOf(txt('hello'));
    const state = stateOf(doc, 3, 3);
    expect(applyRevisionTr(state, 'add', { authorId: 'A' })).toBeNull();
  });
});

import { applyInlineRevisionResolveTr } from '../pm-toolbar.js';

describe('applyInlineRevisionResolveTr', () => {
  function docWithMark(kind, text = 'word') {
    const m = schema.marks.revision.create({ kind, authorId: 'A' });
    return docOf(txt('xx'), txt(text, m), txt('yy'));
  }

  it('accept ADD strips the mark and clears storedMarks', () => {
    const doc = docWithMark('add');
    // Cursor inside the marked range. 'xx'=1..3, 'word'=3..7, 'yy'=7..9.
    const state = stateOf(doc, 5);
    const tr = applyInlineRevisionResolveTr(state, 'accept');
    expect(tr).not.toBeNull();
    const newState = state.apply(tr);
    expect(findFirstMatchingMark(
      newState.doc, 3, 7, schema.marks.revision, () => true,
    )).toBeNull();
    expect(tr.storedMarks).toEqual([]);
  });

  it('reject ADD deletes the marked range', () => {
    const doc = docWithMark('add', 'word');
    const state = stateOf(doc, 5);
    const tr = applyInlineRevisionResolveTr(state, 'reject');
    const newState = state.apply(tr);
    const text = newState.doc.textContent;
    expect(text).toBe('xxyy');
  });

  it('accept DEL deletes the marked range', () => {
    const doc = docWithMark('del');
    const state = stateOf(doc, 5);
    const tr = applyInlineRevisionResolveTr(state, 'accept');
    const newState = state.apply(tr);
    expect(newState.doc.textContent).toBe('xxyy');
  });

  it('reject DEL strips the mark and clears storedMarks', () => {
    const doc = docWithMark('del');
    const state = stateOf(doc, 5);
    const tr = applyInlineRevisionResolveTr(state, 'reject');
    const newState = state.apply(tr);
    expect(findFirstMatchingMark(
      newState.doc, 3, 7, schema.marks.revision, () => true,
    )).toBeNull();
    expect(tr.storedMarks).toEqual([]);
  });

  it('cursor at immediate right boundary of mark resolves the mark', () => {
    // 'word' = 3..7. Cursor at 7 = immediate right boundary (inclusive: true).
    const doc = docWithMark('add');
    const state = stateOf(doc, 7);
    const tr = applyInlineRevisionResolveTr(state, 'accept');
    expect(tr).not.toBeNull();
  });

  it('cursor with no revision mark at $pos returns null', () => {
    const doc = docOf(txt('plain text'));
    const state = stateOf(doc, 5);
    expect(applyInlineRevisionResolveTr(state, 'accept')).toBeNull();
  });
});
