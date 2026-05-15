// @vitest-environment jsdom
//
// pm-tc-mark.test.js — sub-PR 1h (#47) Q33 marking pipeline.
//
// `rewriteForTrackChanges(oldState, tr, identity)` takes a user-driven
// PM transaction and returns a replacement transaction that, instead of
// applying the user's literal text edits, applies them as TC-marked
// operations:
//   - inserts gain a revisionAdd mark in the current author's name
//   - deletes are rewritten as addMark(revisionDel) over the would-be-
//     deleted range (the text stays visible until accepted)
//   - the "self-cancel" case (deleting one's OWN unaccepted revisionAdd)
//     is the ergonomic exception: text the user just typed and then
//     backspaced should actually disappear, not gain a `<del>` wrapper.
//
// The function is pure: identical input → identical output, no DOM, no
// network, no Yjs. The PM substrate write happens later when the host
// dispatches the returned transaction.

import { describe, it, expect } from 'vitest';
import { EditorState } from 'prosemirror-state';

import { schema } from '../pm-schema.js';
import { rewriteForTrackChanges, docHasInlineRevisions } from '../pm-tc-mark.js';

// Build a doc with one paragraph containing `text`. PM positions:
// pos 0 = before <p>, 1 = inside <p>, 2..N = text chars, N+1 = after <p>.
function stateFromText(text) {
  const inline = text ? [schema.text(text)] : [];
  const para = schema.node('paragraph', null, inline);
  const doc = schema.node('doc', null, [para]);
  return EditorState.create({ schema, doc });
}

function getMarksAtRange(doc, from, to) {
  // Collect the marks present on every character in [from, to). Returns
  // a Set of mark-type names.
  const marks = new Set();
  doc.nodesBetween(from, to, (node) => {
    if (!node.isText) return true;
    for (const m of node.marks) marks.add(m.type.name);
    return false;
  });
  return marks;
}

function getAuthorIdsForMarkType(doc, from, to, markName) {
  const ids = new Set();
  doc.nodesBetween(from, to, (node) => {
    if (!node.isText) return true;
    for (const m of node.marks) {
      if (m.type.name === markName) ids.add(m.attrs.authorId || null);
    }
    return false;
  });
  return ids;
}

const ALICE = { id: 'alice', color: '#ff6b6b' };
const BOB = { id: 'bob', color: '#5dade2' };

describe('rewriteForTrackChanges — pure insert', () => {
  it('wraps a single inserted character in revisionAdd with the current author', () => {
    // Start with an empty paragraph: <p></p>. PM doc shape: position 1 is
    // inside the paragraph (between the open and close tokens).
    const oldState = stateFromText('');
    // Simulate the user typing "x" at position 1.
    const userTr = oldState.tr.insertText('x', 1);

    const newTr = rewriteForTrackChanges(oldState, userTr, ALICE);
    expect(newTr).not.toBeNull();

    const newState = oldState.apply(newTr);
    const marks = getMarksAtRange(newState.doc, 1, 2);
    expect(marks.has('revisionAdd')).toBe(true);
    expect(marks.has('revisionDel')).toBe(false);

    const ids = getAuthorIdsForMarkType(newState.doc, 1, 2, 'revisionAdd');
    expect(ids).toEqual(new Set(['alice']));
  });

  it('wraps a multi-character insert (paste) in a single revisionAdd span', () => {
    const oldState = stateFromText('');
    const userTr = oldState.tr.insertText('hello', 1);

    const newTr = rewriteForTrackChanges(oldState, userTr, BOB);
    const newState = oldState.apply(newTr);

    // All five characters carry revisionAdd from Bob.
    const marks = getMarksAtRange(newState.doc, 1, 6);
    expect(marks.has('revisionAdd')).toBe(true);
    const ids = getAuthorIdsForMarkType(newState.doc, 1, 6, 'revisionAdd');
    expect(ids).toEqual(new Set(['bob']));
    // Doc text is exactly "hello".
    expect(newState.doc.textBetween(1, 6, '', '')).toBe('hello');
  });

  it('returns null for a selection-only transaction', () => {
    const oldState = stateFromText('hello');
    // A pure selection update has no steps; tr.docChanged is false.
    const userTr = oldState.tr;
    const newTr = rewriteForTrackChanges(oldState, userTr, ALICE);
    expect(newTr).toBeNull();
  });
});

describe('rewriteForTrackChanges — pure delete', () => {
  it('marks the deleted range with revisionDel instead of removing the text', () => {
    // Doc: <p>abc</p> — positions 1,2,3 hold "a","b","c"; pos 4 is the
    // paragraph close. Total content.size = 5.
    const oldState = stateFromText('abc');
    // Backspace at end: delete position 3..4 ("c").
    const userTr = oldState.tr.delete(3, 4);

    const newTr = rewriteForTrackChanges(oldState, userTr, ALICE);
    expect(newTr).not.toBeNull();

    const newState = oldState.apply(newTr);

    // Text is unchanged — "abc" still visible.
    expect(newState.doc.textBetween(1, 4, '', '')).toBe('abc');
    // The deleted character now carries revisionDel from Alice.
    const marks = getMarksAtRange(newState.doc, 3, 4);
    expect(marks.has('revisionDel')).toBe(true);
    expect(marks.has('revisionAdd')).toBe(false);
    const ids = getAuthorIdsForMarkType(newState.doc, 3, 4, 'revisionDel');
    expect(ids).toEqual(new Set(['alice']));
    // Earlier characters ("ab") are untouched — no revision marks.
    expect(getMarksAtRange(newState.doc, 1, 3).has('revisionDel')).toBe(false);
  });

  it('partial-mark deletion: only the unmarked characters get revisionDel', () => {
    // Doc has "abXcd" where "X" already carries revisionDel from Alice
    // (older finding). User selects "bXc" (positions 2..5) and deletes.
    // Expected behavior: "b" and "c" pick up revisionDel:Alice; "X" is
    // already marked so we leave it alone (idempotent).
    const aliceDel = schema.marks.revisionDel.create({
      authorId: 'alice', authorColor: null,
    });
    const para = schema.node('paragraph', null, [
      schema.text('ab'),
      schema.text('X', [aliceDel]),
      schema.text('cd'),
    ]);
    const oldState = EditorState.create({
      schema, doc: schema.node('doc', null, [para]),
    });
    const userTr = oldState.tr.delete(2, 5); // deletes "bXc"

    const newTr = rewriteForTrackChanges(oldState, userTr, ALICE);
    const newState = oldState.apply(newTr);

    // Text unchanged.
    expect(newState.doc.textBetween(1, 6, '', '')).toBe('abXcd');
    // Every character in [2..5] carries revisionDel from Alice.
    const marks = getMarksAtRange(newState.doc, 2, 5);
    expect(marks.has('revisionDel')).toBe(true);
    const ids = getAuthorIdsForMarkType(newState.doc, 2, 5, 'revisionDel');
    expect(ids).toEqual(new Set(['alice']));
  });

  it('marks a multi-character deletion (select+delete) as one revisionDel span', () => {
    const oldState = stateFromText('hello world');
    // Select "world" (positions 7..12) and delete.
    const userTr = oldState.tr.delete(7, 12);

    const newTr = rewriteForTrackChanges(oldState, userTr, BOB);
    const newState = oldState.apply(newTr);

    // Text unchanged.
    expect(newState.doc.textBetween(1, 12, '', '')).toBe('hello world');
    // "world" carries revisionDel; "hello " does not.
    const worldMarks = getMarksAtRange(newState.doc, 7, 12, 'revisionDel');
    expect(worldMarks.has('revisionDel')).toBe(true);
    const helloMarks = getMarksAtRange(newState.doc, 1, 7);
    expect(helloMarks.has('revisionDel')).toBe(false);
    const ids = getAuthorIdsForMarkType(newState.doc, 7, 12, 'revisionDel');
    expect(ids).toEqual(new Set(['bob']));
  });
});

describe('docHasInlineRevisions — post-1g.6 schema-split detection', () => {
  it('returns true for a doc with revisionAdd marks', () => {
    const addMark = schema.marks.revisionAdd.create({ authorId: 'a', authorColor: null });
    const doc = schema.node('doc', null, [
      schema.node('paragraph', null, [schema.text('hello', [addMark])]),
    ]);
    expect(docHasInlineRevisions(doc)).toBe(true);
  });

  it('returns true for a doc with revisionDel marks', () => {
    const delMark = schema.marks.revisionDel.create({ authorId: 'a', authorColor: null });
    const doc = schema.node('doc', null, [
      schema.node('paragraph', null, [schema.text('hello', [delMark])]),
    ]);
    expect(docHasInlineRevisions(doc)).toBe(true);
  });

  it('returns false for a doc with no revision marks', () => {
    const doc = schema.node('doc', null, [
      schema.node('paragraph', null, [schema.text('hello')]),
    ]);
    expect(docHasInlineRevisions(doc)).toBe(false);
  });

  it('returns false when only revisionChg marks are present (chg is decorative, not actionable)', () => {
    // Chg marks track inline replacements; the inline-revisions gutter
    // button accepts/rejects add/del — not chg. Keep chg out of the gate.
    const chgMark = schema.marks.revisionChg.create({ authorId: 'a', authorColor: null });
    const doc = schema.node('doc', null, [
      schema.node('paragraph', null, [schema.text('hello', [chgMark])]),
    ]);
    expect(docHasInlineRevisions(doc)).toBe(false);
  });
});

describe('rewriteForTrackChanges — self-cancel (delete own pending add)', () => {
  it('actually removes text that the SAME author just added under revisionAdd', () => {
    // Author "alice" types "x" under TC — the doc now has "x" with
    // revisionAdd:alice. Then alice backspaces. Expected: the "x" disappears.
    // Without self-cancel the text would be wrapped in revisionDel and
    // rendered as <ins><del>x</del></ins> — confusing UX.
    const aliceAdd = schema.marks.revisionAdd.create({
      authorId: 'alice', authorColor: null,
    });
    const para = schema.node('paragraph', null, [
      schema.text('x', [aliceAdd]),
    ]);
    const oldState = EditorState.create({
      schema, doc: schema.node('doc', null, [para]),
    });
    // Alice backspaces — delete pos 1..2.
    const userTr = oldState.tr.delete(1, 2);

    const newTr = rewriteForTrackChanges(oldState, userTr, ALICE);
    const newState = oldState.apply(newTr);

    // The "x" should be gone — empty paragraph remains.
    expect(newState.doc.textContent).toBe('');
    expect(newState.doc.content.size).toBe(2); // <p></p>
  });

  it('does NOT self-cancel a different author\'s revisionAdd', () => {
    // Bob's text under revisionAdd:bob. Alice tries to delete it. Alice
    // is a different author — the delete should produce revisionDel:alice
    // layered on Bob's revisionAdd (the audit trail S3 case).
    const bobAdd = schema.marks.revisionAdd.create({
      authorId: 'bob', authorColor: null,
    });
    const para = schema.node('paragraph', null, [
      schema.text('y', [bobAdd]),
    ]);
    const oldState = EditorState.create({
      schema, doc: schema.node('doc', null, [para]),
    });
    const userTr = oldState.tr.delete(1, 2);

    const newTr = rewriteForTrackChanges(oldState, userTr, ALICE);
    const newState = oldState.apply(newTr);

    // Text survives ("y" still present).
    expect(newState.doc.textContent).toBe('y');
    // The "y" carries BOTH Bob's revisionAdd and Alice's revisionDel.
    const marks = getMarksAtRange(newState.doc, 1, 2);
    expect(marks.has('revisionAdd')).toBe(true);
    expect(marks.has('revisionDel')).toBe(true);
    expect(getAuthorIdsForMarkType(newState.doc, 1, 2, 'revisionAdd'))
      .toEqual(new Set(['bob']));
    expect(getAuthorIdsForMarkType(newState.doc, 1, 2, 'revisionDel'))
      .toEqual(new Set(['alice']));
  });

  it('replace: selecting text and typing new text del-marks the old + add-marks the new', () => {
    // Doc "hello world". Alice selects "world" (pos 7..12) and types "earth".
    // Expected post-rewrite: "world" carries revisionDel:alice; "earth" is
    // inserted AFTER it with revisionAdd:alice. Visible text: "hello worldearth".
    const oldState = stateFromText('hello world');
    const userTr = oldState.tr.replaceWith(7, 12, schema.text('earth'));

    const newTr = rewriteForTrackChanges(oldState, userTr, ALICE);
    const newState = oldState.apply(newTr);

    // Both old + new text visible.
    expect(newState.doc.textContent).toBe('hello worldearth');
    // "world" carries revisionDel:alice.
    const delMarks = getMarksAtRange(newState.doc, 7, 12);
    expect(delMarks.has('revisionDel')).toBe(true);
    expect(getAuthorIdsForMarkType(newState.doc, 7, 12, 'revisionDel'))
      .toEqual(new Set(['alice']));
    // "earth" carries revisionAdd:alice — positions 12..17 in the new doc.
    const addMarks = getMarksAtRange(newState.doc, 12, 17);
    expect(addMarks.has('revisionAdd')).toBe(true);
    expect(getAuthorIdsForMarkType(newState.doc, 12, 17, 'revisionAdd'))
      .toEqual(new Set(['alice']));
    // The "hello " prefix is untouched.
    expect(getMarksAtRange(newState.doc, 1, 7).size).toBe(0);
  });

  it('mixed range: own-add chars vanish, other chars get revisionDel', () => {
    // Doc: "abc" where positions 1..2 ("a") is alice's pending add and
    // positions 2..4 ("bc") is plain. Alice selects all "abc" and deletes.
    // Expected: "a" disappears (self-cancel), "bc" gains revisionDel:alice.
    const aliceAdd = schema.marks.revisionAdd.create({
      authorId: 'alice', authorColor: null,
    });
    const para = schema.node('paragraph', null, [
      schema.text('a', [aliceAdd]),
      schema.text('bc'),
    ]);
    const oldState = EditorState.create({
      schema, doc: schema.node('doc', null, [para]),
    });
    const userTr = oldState.tr.delete(1, 4); // all three

    const newTr = rewriteForTrackChanges(oldState, userTr, ALICE);
    const newState = oldState.apply(newTr);

    // "a" gone, "bc" remains with revisionDel.
    expect(newState.doc.textContent).toBe('bc');
    const marks = getMarksAtRange(newState.doc, 1, 3);
    expect(marks.has('revisionDel')).toBe(true);
    expect(marks.has('revisionAdd')).toBe(false);
    expect(getAuthorIdsForMarkType(newState.doc, 1, 3, 'revisionDel'))
      .toEqual(new Set(['alice']));
  });
});
