// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EditorState } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';

import { schema } from '../../pm-schema.js';
import { htmlToPmFragment } from '../../pmdoc-html.js';
import {
  activeCommentPlugin,
  activeCommentPluginKey,
  setActiveComment,
} from '../active-comment.js';

let root;
beforeEach(() => {
  root = document.createElement('div');
  document.body.appendChild(root);
});
afterEach(() => {
  root?.remove();
});

function mountWithDoc(html) {
  const state = EditorState.create({
    schema,
    doc: htmlToPmFragment(html),
    plugins: [activeCommentPlugin()],
  });
  const view = new EditorView(root, { state });
  return view;
}

describe('activeCommentPlugin — initial state', () => {
  it('initializes with activeCommentId === null', () => {
    const view = mountWithDoc('<p>plain</p>');
    const pluginState = activeCommentPluginKey.getState(view.state);
    expect(pluginState.activeCommentId).toBeNull();
    view.destroy();
  });
});

describe('activeCommentPlugin — setActiveComment', () => {
  it('setActiveComment dispatches a meta tr that updates activeCommentId', () => {
    const view = mountWithDoc('<p>plain</p>');
    setActiveComment(view, 'c1');
    const pluginState = activeCommentPluginKey.getState(view.state);
    expect(pluginState.activeCommentId).toBe('c1');
    view.destroy();
  });

  it('setActiveComment(view, null) clears the activeCommentId', () => {
    const view = mountWithDoc('<p>plain</p>');
    setActiveComment(view, 'c1');
    setActiveComment(view, null);
    const pluginState = activeCommentPluginKey.getState(view.state);
    expect(pluginState.activeCommentId).toBeNull();
    view.destroy();
  });

  it('setActiveComment(view, sameId) is a no-op at the state level', () => {
    const view = mountWithDoc('<p>plain</p>');
    setActiveComment(view, 'c1');
    const stateBefore = activeCommentPluginKey.getState(view.state);
    setActiveComment(view, 'c1');
    const stateAfter = activeCommentPluginKey.getState(view.state);
    // Same object reference proves the reducer short-circuited.
    expect(stateAfter).toBe(stateBefore);
    view.destroy();
  });
});
