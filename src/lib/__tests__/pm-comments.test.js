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
