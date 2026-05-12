// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import { schema } from '../pm-schema.js';
import {
  findFirstMatchingMark,
  applyFormatTr,
  applyInlineMarkTr,
  applyRevisionTr,
  applyInlineRevisionResolveTr,
  applyChangeCaseTr,
  applyCommentMarkTr,
} from '../pm-toolbar.js';

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

describe('applyInlineRevisionResolveTr', () => {
  function docWithMark(kind, text = 'word') {
    const m = schema.marks.revision.create({ kind, authorId: 'A' });
    return docOf(txt('xx'), txt(text, m), txt('yy'));
  }

  it('accept ADD strips the mark and clears storedMarks', () => {
    const doc = docWithMark('add');
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
    expect(newState.doc.textContent).toBe('xxyy');
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

describe('applyChangeCaseTr', () => {
  it.each([
    ['UPPER → lower', 'HELLO', 'hello'],
    ['lower → Title (first letter of each word)', 'hello world', 'Hello World'],
    ['mixed → UPPER', 'Hello World', 'HELLO WORLD'],
  ])('%s', (_label, input, expected) => {
    const doc = docOf(txt(input));
    const state = stateOf(doc, 1, input.length + 1);
    const tr = applyChangeCaseTr(state);
    expect(state.apply(tr).doc.textContent).toBe(expected);
  });

  it('drops marks on the replaced range (legacy parity) and returns null on empty selection', () => {
    // Two related assertions batched per CLAUDE.md guidance — marks-dropped
    // pins the legacy `range.deleteContents()` parity, empty-selection pins
    // the null-on-collapsed contract.
    const bold = schema.marks.bold.create();
    const doc = docOf(txt('hello', bold));
    const state = stateOf(doc, 1, 6);
    const tr = applyChangeCaseTr(state);
    const newState = state.apply(tr);
    const mark = findFirstMatchingMark(
      newState.doc, 1, 6, schema.marks.bold, () => true,
    );
    expect(mark).toBeNull();

    const emptyState = stateOf(docOf(txt('hello')), 3, 3);
    expect(applyChangeCaseTr(emptyState)).toBeNull();
  });
});

describe('applyCommentMarkTr (issue #64)', () => {
  it('adds comment mark with id+resolved attrs over selection', () => {
    const doc = docOf(txt('hello world'));
    const state = stateOf(doc, 1, 6);
    const tr = applyCommentMarkTr(state, 'c-abc');
    expect(tr).not.toBeNull();
    const newState = state.apply(tr);
    const mark = findFirstMatchingMark(
      newState.doc, 1, 6, schema.marks.comment, (a) => a.id === 'c-abc',
    );
    expect(mark).not.toBeNull();
    expect(mark.attrs).toEqual({ id: 'c-abc', resolved: false });
  });

  it('returns null on collapsed selection, missing commentId, and non-string commentId', () => {
    const doc = docOf(txt('hello'));
    expect(applyCommentMarkTr(stateOf(doc, 3, 3), 'c1')).toBeNull();
    expect(applyCommentMarkTr(stateOf(doc, 1, 6), '')).toBeNull();
    expect(applyCommentMarkTr(stateOf(doc, 1, 6), null)).toBeNull();
    expect(applyCommentMarkTr(stateOf(doc, 1, 6), 123)).toBeNull();
  });
});

describe('Multi-paragraph round-trip', () => {
  it('applyInlineMarkTr across paragraph boundary applies mark to text in both paragraphs (U8)', () => {
    // PmEditableBlock currently hosts a single top-level paragraph (per
    // CLAUDE.md "Out of scope"). This test verifies that the verb function
    // ITSELF correctly applies the mark across a multi-paragraph doc at the
    // PM-doc level — useful as forward-compat coverage if paste/list
    // conversion ever introduces multi-paragraph blocks. We don't assert
    // HTML round-trip because pmFragmentToHtml is designed for the
    // single-paragraph contract and collapses paragraph boundaries.
    const p1 = schema.node('paragraph', null, [txt('foo')]);
    const p2 = schema.node('paragraph', null, [txt('bar')]);
    const doc = schema.node('doc', null, [p1, p2]);
    const state = stateOf(doc, 1, 9);
    const tr = applyInlineMarkTr(state, 'rid');
    expect(tr).not.toBeNull();
    const newState = state.apply(tr);
    expect(newState.doc.childCount).toBe(2);
    const p1Text = newState.doc.child(0).firstChild;
    const p2Text = newState.doc.child(1).firstChild;
    expect(p1Text.marks.some((m) => m.type === schema.marks.inlineMark && m.attrs.kind === 'rid')).toBe(true);
    expect(p2Text.marks.some((m) => m.type === schema.marks.inlineMark && m.attrs.kind === 'rid')).toBe(true);
    expect(p1Text.text).toBe('foo');
    expect(p2Text.text).toBe('bar');
  });
});
