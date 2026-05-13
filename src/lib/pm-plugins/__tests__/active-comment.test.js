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

describe('activeCommentPlugin — decoration emission', () => {
  it('emits no decorations when activeCommentId is null', () => {
    const view = mountWithDoc('<p><span class="mark-comment" data-comment-id="c1">x</span></p>');
    const pluginState = activeCommentPluginKey.getState(view.state);
    expect(pluginState.decorations.find()).toHaveLength(0);
    view.destroy();
  });

  it('emits an inline decoration over the matching comment range', () => {
    const view = mountWithDoc('<p>before <span class="mark-comment" data-comment-id="c1">x</span> after</p>');
    setActiveComment(view, 'c1');
    const pluginState = activeCommentPluginKey.getState(view.state);
    const decos = pluginState.decorations.find();
    expect(decos.length).toBe(1);
    expect(decos[0].spec.class || decos[0].type?.attrs?.class).toBeDefined();
    view.destroy();
  });

  it('emits no decoration when activeCommentId does not match any mark', () => {
    const view = mountWithDoc('<p><span class="mark-comment" data-comment-id="c1">x</span></p>');
    setActiveComment(view, 'no-such-id');
    const pluginState = activeCommentPluginKey.getState(view.state);
    expect(pluginState.decorations.find()).toHaveLength(0);
    view.destroy();
  });
});

describe('activeCommentPlugin — cache invalidation', () => {
  it('rebuilds the DecorationSet on docChanged', () => {
    const view = mountWithDoc('<p><span class="mark-comment" data-comment-id="c1">x</span></p>');
    setActiveComment(view, 'c1');
    const stateBefore = activeCommentPluginKey.getState(view.state);
    // Force a doc-changing transaction.
    view.dispatch(view.state.tr.insertText(' more', view.state.doc.content.size - 1));
    const stateAfter = activeCommentPluginKey.getState(view.state);
    // New plugin-state object means the reducer ran with needsRebuild=true.
    expect(stateAfter).not.toBe(stateBefore);
    expect(stateAfter.activeCommentId).toBe('c1');
    view.destroy();
  });
});
