/**
 * active-comment.js — PM plugin holding singleton activeCommentId state
 * (sub-PR 1g, issue #47).
 *
 * Replaces CommentPopup.jsx's imperative `setAttribute('data-active', ...)`
 * for PM-mounted blocks. App calls `setActiveComment(view, commentId)` when
 * the popup opens; the plugin renders an inline decoration applying
 * `class: 'mark-comment-active'` to the matching `comment` mark's range.
 * CSS selector `.mark-comment.mark-comment-active` (and the dark-mode
 * variant) provides the visual treatment.
 *
 * The DecorationSet is cached in plugin state and rebuilt only on
 * `tr.docChanged || activeCommentId changed`. The PM guide explicitly
 * recommends this pattern (Decorations section): "When you have a lot of
 * decorations, recreating the set on the fly for every redraw is likely to
 * be too expensive."
 *
 * Same-id meta short-circuit: re-dispatching `setActiveComment(view, sameId)`
 * returns the same plugin-state object reference, so the React-side wiring
 * effect can safely fire on any commentsState dep change without thrashing
 * the DecorationSet.
 */

import { Plugin, PluginKey } from 'prosemirror-state';
import { Decoration, DecorationSet } from 'prosemirror-view';

export const activeCommentPluginKey = new PluginKey('active-comment');

function buildDecorations(doc, activeCommentId) {
  if (!activeCommentId) return DecorationSet.empty;
  const commentMarkType = doc.type.schema.marks.comment;
  if (!commentMarkType) return DecorationSet.empty;
  const decos = [];
  doc.descendants((node, pos) => {
    if (!node.isText) return true;
    for (const m of node.marks) {
      if (m.type === commentMarkType && m.attrs.id === activeCommentId) {
        decos.push(
          Decoration.inline(pos, pos + node.nodeSize, { class: 'mark-comment-active' }),
        );
        break;
      }
    }
    return true;
  });
  return DecorationSet.create(doc, decos);
}

export function activeCommentPlugin() {
  return new Plugin({
    key: activeCommentPluginKey,
    state: {
      init(_config, state) {
        return {
          activeCommentId: null,
          decorations: buildDecorations(state.doc, null),
        };
      },
      apply(tr, prev, _oldState, newState) {
        const metaSet = tr.getMeta(activeCommentPluginKey);
        let activeCommentId = prev.activeCommentId;
        let needsRebuild = false;
        if (metaSet !== undefined) {
          if (metaSet !== prev.activeCommentId) {
            activeCommentId = metaSet;
            needsRebuild = true;
          }
        }
        if (tr.docChanged) needsRebuild = true;
        if (!needsRebuild) return prev;
        return {
          activeCommentId,
          decorations: buildDecorations(newState.doc, activeCommentId),
        };
      },
    },
    props: {
      decorations(state) {
        return activeCommentPluginKey.getState(state).decorations;
      },
    },
  });
}

export function setActiveComment(view, commentId) {
  view.dispatch(view.state.tr.setMeta(activeCommentPluginKey, commentId));
}
