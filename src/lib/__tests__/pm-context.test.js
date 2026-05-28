// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import { schema } from '../pm-schema.js';
import { resolvePmContextAt } from '../pm-context.js';

function docOf(...children) {
  return schema.node('doc', null, [schema.node('paragraph', null, children)]);
}
const txt = (text, ...marks) => schema.text(text, marks);
function stateOf(doc, from = 0, to = from) {
  return EditorState.create({ doc, selection: TextSelection.create(doc, from, to) });
}

describe('resolvePmContextAt', () => {
  it('plain text, collapsed selection -> selectionEmpty true, no extras', () => {
    const state = stateOf(docOf(txt('hello')), 3);
    const d = resolvePmContextAt(state, 3, { blockId: 'b1', readOnly: false });
    expect(d).toMatchObject({ blockId: 'b1', kind: 'pm', pos: 3, selectionEmpty: true, readOnly: false });
    expect(d.revision).toBeUndefined();
    expect(d.comment).toBeUndefined();
    expect(d.addCommentRange).toBeUndefined();
  });

  it('read-only short-circuits before mark resolution', () => {
    const mark = schema.marks.revisionAdd.create({ authorId: 'a', authorColor: '#f00' });
    const state = stateOf(docOf(txt('hello', mark)), 3);
    const d = resolvePmContextAt(state, 3, { blockId: 'b1', readOnly: true });
    expect(d.readOnly).toBe(true);
    expect(d.revision).toBeUndefined();
  });

  it('detects a revisionAdd mark under the position', () => {
    const mark = schema.marks.revisionAdd.create({ authorId: 'a', authorColor: '#f00' });
    const state = stateOf(docOf(txt('hello', mark)), 3);
    const d = resolvePmContextAt(state, 3, { blockId: 'b1', readOnly: false });
    expect(d.revision.kind).toBe('add');
    expect(d.revision.range).toEqual({ from: 1, to: 6 });
  });

  it('detects an unresolved comment mark under the position', () => {
    const mark = schema.marks.comment.create({ id: 'c1', resolved: false });
    const state = stateOf(docOf(txt('hello', mark)), 3);
    const d = resolvePmContextAt(state, 3, { blockId: 'b1', readOnly: false });
    expect(d.comment).toEqual({ commentId: 'c1', range: { from: 1, to: 6 }, resolved: false });
  });

  it('marks addCommentRange when a non-empty selection contains the click pos', () => {
    const state = stateOf(docOf(txt('hello world')), 1, 6); // selection 1..6
    const d = resolvePmContextAt(state, 3, { blockId: 'b1', readOnly: false });
    expect(d.selectionEmpty).toBe(false);
    expect(d.addCommentRange).toEqual({ from: 1, to: 6 });
  });

  it('omits addCommentRange when the click is outside the selection', () => {
    const state = stateOf(docOf(txt('hello world')), 1, 4);
    const d = resolvePmContextAt(state, 9, { blockId: 'b1', readOnly: false });
    expect(d.addCommentRange).toBeUndefined();
  });
});
