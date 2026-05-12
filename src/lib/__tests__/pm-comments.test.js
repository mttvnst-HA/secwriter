// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { EditorState } from 'prosemirror-state';

import { schema } from '../pm-schema.js';
import { htmlToPmFragment } from '../pmdoc-html.js';
import { reconcileCommentMarks, COMMENT_RECONCILE_META } from '../pm-comments.js';

function stateFromHtml(html) {
  // Create a PM EditorState by parsing html via the schema. Mirrors the test
  // shape in pm-toolbar-verbs.test.js (no view mount required).
  const doc = htmlToPmFragment(html);
  return EditorState.create({ schema, doc });
}

function commentsState(comments) {
  const byId = new Map();
  for (const c of comments) byId.set(c.id, c);
  return { byId, seenRemoteIds: new Set() };
}

describe('reconcileCommentMarks — idempotency', () => {
  it('returns null when the doc has no comment marks and state is empty', () => {
    const state = stateFromHtml('<p>plain text</p>');
    const tr = reconcileCommentMarks(state, commentsState([]));
    expect(tr).toBeNull();
  });

  it('returns null when the doc and state already agree', () => {
    const state = stateFromHtml('<p><span class="mark-comment" data-comment-id="c1">x</span></p>');
    const tr = reconcileCommentMarks(state, commentsState([
      { id: 'c1', blockId: 'b1', status: 'open' },
    ]));
    expect(tr).toBeNull();
  });
});

describe('reconcileCommentMarks — orphan removal', () => {
  it('removes a mark whose id is not in byId', () => {
    const state = stateFromHtml('<p>before <span class="mark-comment" data-comment-id="dead">x</span> after</p>');
    const tr = reconcileCommentMarks(state, commentsState([]));
    expect(tr).not.toBeNull();
    const newDoc = state.apply(tr).doc;
    const commentMarkType = schema.marks.comment;
    let foundComment = false;
    newDoc.descendants((node) => {
      if (node.isText && node.marks.some((m) => m.type === commentMarkType)) {
        foundComment = true;
      }
      return true;
    });
    expect(foundComment).toBe(false);
  });

  it('preserves adjacent comment marks with DIFFERENT ids when one is orphan', () => {
    const state = stateFromHtml(
      '<p><span class="mark-comment" data-comment-id="keep">A</span><span class="mark-comment" data-comment-id="dead">B</span></p>',
    );
    const tr = reconcileCommentMarks(state, commentsState([
      { id: 'keep', blockId: 'b1', status: 'open' },
    ]));
    expect(tr).not.toBeNull();
    const newDoc = state.apply(tr).doc;
    const commentMarkType = schema.marks.comment;
    const surviving = [];
    newDoc.descendants((node) => {
      if (!node.isText) return true;
      for (const m of node.marks) {
        if (m.type === commentMarkType) surviving.push(m.attrs.id);
      }
      return true;
    });
    expect(surviving).toEqual(['keep']);
  });

  it('tags the returned tr with COMMENT_RECONCILE_META', () => {
    const state = stateFromHtml('<p><span class="mark-comment" data-comment-id="dead">x</span></p>');
    const tr = reconcileCommentMarks(state, commentsState([]));
    expect(tr.getMeta(COMMENT_RECONCILE_META)).toBe(true);
  });
});
