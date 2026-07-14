/**
 * useComments — App's comment-interaction intent (architecture-review
 * candidate #1, "review surfaces" slice).
 *
 * Re-grill note: the backlog scoped a single `useReviewPanels` bundling
 * comments + compliance + lint. The coupling map says otherwise — comments
 * share ZERO state with lint/compliance (verified grep-clean); they touch only
 * via the right-rail panel-toggle mutual-exclusion. Comments couple instead to
 * the substrate / collab / PM axis. So comments extract on their own here;
 * lint+compliance (the pair that genuinely share the CSS.highlights registry +
 * the ignore sub-store + the suspend coupling) are a separate later slice.
 *
 * Owns the comment interaction STATE and the HANDLERS as a cohesive intent:
 *   - state: commentsState (+ ref mirror), openCommentId, commentRect,
 *     commentRects (all-popups layer seed), showCommentSpans (persisted).
 *   - handlers: create / update-create / reply / resolve / reopen / delete /
 *     click. Each folds the `cm.*` reducer result into commentsState and, for
 *     mutations that publish, routes the envelope to `dispatchComment`.
 *
 * The four comment EFFECTS (active-highlight, cm.reconcileBlocks + substrate
 * mirror, span-visibility persist, all-popups rect capture) deliberately stay
 * in App at their original declaration positions — NOT in this hook. They are
 * effect-DECLARATION-ORDER sensitive: relocating them ahead of App's other
 * effects (this hook is called early, before useFileSession, because it must
 * supply `comments`/`setCommentsState` to the file-session + import paths)
 * introduced a ~50% flake in the #195 all-popups rect-capture E2E — a race the
 * baseline never had (see CLAUDE.md Rule #12 on StrictMode masking effect-order
 * bugs). Keeping them in App preserves the exact ordering. The hook returns the
 * state + setters they read; App wires them via `useCommentEffects`-style
 * inline effects.
 *
 * Injected (App-owned): `setBlocks` (create writes the comment's block html),
 * `dispatchComment` (the stable collabRef wrapper — the single imperative
 * collab seam), and `effectiveIdentity` (shared with lint/compliance, so it
 * stays in App). The comments PANEL toggle `showComments` is a right-rail
 * layout concern (mutually exclusive with the compliance panel) and stays in
 * App. Most setters are returned because non-comment App sites + the four
 * effects drive them (collab inbound, file load, block-type conversion, etc.).
 */

import { useCallback, useRef, useState } from 'react';

import * as cm from '../lib/comments.js';

export function useComments({
  setBlocks,
  dispatchComment,
  effectiveIdentity,
}) {
  const [commentsState, setCommentsState] = useState(cm.createInitial());
  // `commentsState.byId` is a Map<commentId, Comment> — alias kept for the
  // many UI consumers that expect the old `comments` Map shape.
  const comments = commentsState.byId;
  const [openCommentId, setOpenCommentId] = useState(null);
  const [commentRect, setCommentRect] = useState(null);
  // Initial id→rect map for the all-popups layer (#195 follow-up). When the
  // comment-highlight layer is ON, every comment shows its popup and they
  // persist until the layer is toggled OFF. Each popup self-tracks its span on
  // scroll/resize after mount; this map only seeds the open-time position.
  const [commentRects, setCommentRects] = useState(() => new Map());
  // Comment-span visibility layer — separate from the comments PANEL
  // (`showComments`, owned by App). Persisted, default ON. Mirrors the
  // inline-linting toggle.
  const [showCommentSpans, setShowCommentSpans] = useState(() => {
    try { return localStorage.getItem('sim-comment-spans') !== 'false'; } catch { return true; }
  });

  const commentsStateRef = useRef(commentsState);
  commentsStateRef.current = commentsState;

  const handleCommentCreate = useCallback((blockId, html, commentId, highlightText) => {
    // Creating a comment auto-reveals the comment-span layer if it was hidden —
    // creation is never blocked (issue #195).
    setShowCommentSpans(true);
    // html is null for ref blocks (their data is in block.ref, not block.html)
    if (html !== null) {
      setBlocks(prev => prev.map(b => b.id === blockId ? { ...b, html } : b));
    }
    const ts = Date.now();
    const { state } = cm.createDraft(commentsStateRef.current, {
      commentId, blockId, highlightText: highlightText || '', identity: effectiveIdentity(), ts,
    });
    setCommentsState(state);
    // Publish is deferred to handleCommentUpdateCreate so the Y.Doc never
    // holds a pending empty-text comment entry.
    setOpenCommentId(commentId);
    setTimeout(() => {
      const el = document.querySelector(`[data-comment-id="${commentId}"]`);
      if (el) setCommentRect(el.getBoundingClientRect());
    }, 50);
  }, [effectiveIdentity, setBlocks]);

  const handleCommentUpdateCreate = useCallback((commentId, text) => {
    const ts = Date.now();
    const { state, publish } = cm.updateCreate(commentsStateRef.current, {
      commentId, text, identity: effectiveIdentity(), ts,
    });
    setCommentsState(state);
    dispatchComment(publish);
  }, [effectiveIdentity, dispatchComment]);

  const handleCommentReply = useCallback((commentId, text) => {
    const ts = Date.now();
    const { state, publish } = cm.reply(commentsStateRef.current, {
      commentId, text, identity: effectiveIdentity(), ts,
    });
    setCommentsState(state);
    dispatchComment(publish);
  }, [effectiveIdentity, dispatchComment]);

  const handleCommentResolve = useCallback((commentId) => {
    const ts = Date.now();
    const { state, publish } = cm.resolve(commentsStateRef.current, {
      commentId, identity: effectiveIdentity(), ts,
    });
    setCommentsState(state);
    dispatchComment(publish);
    // Collapse the just-resolved comment's popup (it stays collapsed unless
    // its span is clicked again to reopen it).
    setOpenCommentId((id) => (id === commentId ? null : id));
  }, [effectiveIdentity, dispatchComment]);

  const handleCommentReopen = useCallback((commentId) => {
    const ts = Date.now();
    const { state, publish } = cm.reopen(commentsStateRef.current, {
      commentId, identity: effectiveIdentity(), ts,
    });
    setCommentsState(state);
    dispatchComment(publish);
  }, [effectiveIdentity, dispatchComment]);

  const handleCommentDelete = useCallback((commentId) => {
    const { state, publish } = cm.remove(commentsStateRef.current, { commentId });
    setCommentsState(state);
    dispatchComment(publish);
    setOpenCommentId(null);
  }, [dispatchComment]);

  const handleCommentClick = useCallback((commentId, rect) => {
    setOpenCommentId(commentId);
    setCommentRect(rect);
  }, []);

  return {
    commentsState,
    setCommentsState,
    commentsStateRef,
    comments,
    openCommentId,
    setOpenCommentId,
    commentRect,
    setCommentRect,
    commentRects,
    setCommentRects,
    showCommentSpans,
    setShowCommentSpans,
    handleCommentCreate,
    handleCommentUpdateCreate,
    handleCommentReply,
    handleCommentResolve,
    handleCommentReopen,
    handleCommentDelete,
    handleCommentClick,
  };
}
