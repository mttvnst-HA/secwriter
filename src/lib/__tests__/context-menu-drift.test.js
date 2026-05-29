// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import { schema } from '../pm-schema.js';
import { applyInlineRevisionResolveTr } from '../pm-toolbar.js';

function docOf(...children) {
  return schema.node('doc', null, [schema.node('paragraph', null, children)]);
}
const txt = (text, ...marks) => schema.text(text, marks);
const stateOf = (doc) => EditorState.create({ doc, selection: TextSelection.create(doc, 1) });

describe('context-menu collab-drift guard', () => {
  it('resolves the revision mark when it is still present at the click position', () => {
    const mark = schema.marks.revisionAdd.create({ authorId: 'u1', authorColor: '#0a0' });
    const state = stateOf(docOf(txt('added', mark)));
    const result = applyInlineRevisionResolveTr(state, 'accept', 3);
    expect(result).not.toBeNull();
  });

  it('returns null (App no-ops) when a peer removed the mark before the click', () => {
    // Same position, but the mark is gone (peer accepted it first).
    const state = stateOf(docOf(txt('added')));
    const result = applyInlineRevisionResolveTr(state, 'accept', 3);
    expect(result).toBeNull();
  });

  it('moved-mark contract: resolves whatever same-kind mark now sits at the position', () => {
    // Drift hazard the guard does NOT fully close: a peer reflow puts a
    // DIFFERENT revisionAdd (different author) at the same position. With
    // coordinate re-resolution + kindHint='add', the verb resolves THAT mark
    // rather than the original. This pins the known v1 limitation documented
    // in the plan's Self-Review (full relpos mapping is the follow-up).
    const mark = schema.marks.revisionAdd.create({ authorId: 'u2', authorColor: '#00a' });
    const state = stateOf(docOf(txt('other', mark)));
    const result = applyInlineRevisionResolveTr(state, 'accept', 3, 'add');
    expect(result).not.toBeNull(); // resolves the now-present mark, by design
  });
});
