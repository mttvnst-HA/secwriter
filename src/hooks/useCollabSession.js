/**
 * useCollabSession — owns the Yjs collaboration session lifecycle and the
 * four publish effects (blocks, meta, TC, comments).
 *
 * Architecture-review entry #5 (docs/architecture-review-2026-05-01.md):
 * before this hook existed, the publish-path coordination was inlined in
 * App.jsx. App held five refs (`collabSessionRef`, `lastRemoteBlocksRef`,
 * `sessionReadyRef`, `metaReadyRef`, `lastPublishedTcSeqRef`,
 * `publishDisabledRef`), the session lifecycle effect, and four parallel
 * publish effects — together ~250 lines that had to coordinate or the
 * document either round-tripped (corrupting persistence) or stopped
 * publishing (silently losing edits).
 *
 * Responsibilities (what the hook owns):
 *   - Session creation + teardown, gated on `inRoom && identity`.
 *   - Echo guard refs: a fresh remote payload is stashed before App's
 *     setBlocks runs, so the publish effect's `blocks === remoteRef.current`
 *     check correctly skips the echo.
 *   - Ready gates: blocks publish suspends until first sync; meta publish
 *     suspends until first remote meta observation.
 *   - TC seq gating: `markTcSeqApplied` lets App tell us "this seq was
 *     handed to us by a remote payload, don't echo it." Local user-driven
 *     verbs bump publishSeq past the gate; remote applies don't.
 *   - DocSizeLimitError handling: a sticky toast on first overflow, a
 *     success toast when the doc shrinks back under the cap. The latch
 *     lives behind the hook's surface — App neither knows nor cares.
 *   - Cursor broadcast on selectionchange.
 *   - DEV-only `window.__collab` exposure for browser-side debugging.
 *
 * Non-responsibilities (left to the caller):
 *   - React state for blocks/sectionMeta/tcState/commentsState (lives in App).
 *   - Caret preservation across remote updates (App-side concern; the hook
 *     calls `onBlocksReceived` AFTER stashing the echo guard, so App can
 *     capture caret before its setBlocks fires).
 *   - The diff at publish time (`applyHtmlToYText` in collab.js — see
 *     ADR-0004, deferred to issue #22).
 *
 * Inputs / outputs: see the JSDoc on `useCollabSession` below.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import {
  createCollabSession,
  DocSizeLimitError,
} from '../lib/collab.js';

/**
 * @typedef {Object} CollabSessionParams
 * @property {boolean} inRoom
 * @property {string|null} roomId
 * @property {{id:string,name:string,color:string}|null} identity
 * @property {string|null} authToken
 * @property {() => Promise<string|null>} [getTokenFn]
 *
 * @property {Array} blocks                 React state — drives publishBlocks.
 * @property {Object} sectionMeta           React state — drives publishMeta.
 * @property {string} fileName              Folded into publishMeta payload.
 * @property {Object} tcState               React state — drives publishTc.
 * @property {(tcState:Object) => Object} getPublishableTc
 *   Pure selector from track-changes module — kept as a parameter so the
 *   hook does not import the TC module directly.
 *
 * @property {() => Array} getInitialBlocks
 *   Closure over App's blocksRef — read once on session creation. Used so
 *   the session sees the latest blocks at join time without re-creating
 *   the session on every `blocks` change.
 * @property {() => Object} getInitialMeta
 *   Same idea for sectionMeta + fileName.
 *
 * @property {(nextBlocks:Array, meta:{initial:boolean}) => void} onBlocksReceived
 *   Fires for every remote blocks payload AFTER the hook has stashed the
 *   echo guard. App typically captures caret position then calls
 *   `setBlocks(nextBlocks)`.
 * @property {(remote:Object, meta:{initial:boolean}) => void} onMetaReceived
 * @property {(payload:Object, meta:{initial:boolean}) => void} onTcReceived
 *   App is expected to call `markTcSeqApplied(next.publishSeq)` from inside
 *   its setTcState updater so the publish effect does not echo.
 * @property {(commentsObj:Object, meta:{initial:boolean}) => void} onCommentsReceived
 * @property {(states:Array) => void} onPresenceChange
 * @property {(status:string, meta:{reconnectIn:number}) => void} onStatusChange
 *
 * @property {(toast:Object) => void} pushToast
 *   Used for the doc-size-cap error toast and the corresponding "sync
 *   resumed" success toast.
 */

/**
 * @typedef {Object} CollabSessionApi
 * @property {(envelope:Object) => void} dispatchComment
 *   Routes a comments-module PublishEnvelope to the session. No-op when
 *   not in a room.
 * @property {(seq:number) => void} markTcSeqApplied
 *   Tell the hook "the local TC state's publishSeq matches what peers have
 *   already seen — don't echo on the next publish effect." Call from
 *   inside setTcState updater after `tc.applyRemote(...)`.
 * @property {() => boolean} tryUndo
 *   If a session is active, call `session.undo()` and return true. Else
 *   return false so the caller can fall through to local undo.
 * @property {() => boolean} tryRedo
 * @property {() => boolean} canUndo  False when no session.
 * @property {() => boolean} canRedo
 * @property {Y.Map|null} yStore
 *   The session's per-block Y.Map<string, Y.Map> — exposed so App can
 *   compute `activeYStore = inRoom ? collab.yStore : localYStore` and
 *   pass it to EditableBlock's binder. State, not ref: re-renders when
 *   the session is created or destroyed so the binder resubscribes.
 */

/**
 * @param {CollabSessionParams} params
 * @returns {CollabSessionApi}
 */
export function useCollabSession({
  inRoom,
  roomId,
  identity,
  authToken,
  getTokenFn,

  blocks,
  sectionMeta,
  fileName,
  tcState,
  getPublishableTc,

  getInitialBlocks,
  getInitialMeta,

  onBlocksReceived,
  onMetaReceived,
  onTcReceived,
  onCommentsReceived,
  onPresenceChange,
  onStatusChange,

  pushToast,
}) {
  // ── Coordination refs (all hook-owned) ────────────────────────────────
  // The session itself.
  const sessionRef = useRef(null);

  // Active session's yStore as state — mirrors sessionRef.current?.yStore but
  // re-renders the consumer when the session is (re)created or destroyed so
  // EditableBlock's binder resubscribes against the right substrate. Null
  // when out of room.
  const [yStore, setYStoreState] = useState(null);

  // Echo guard for blocks: every remote payload is stashed here BEFORE
  // App's setBlocks runs. The publish effect checks `blocks === remoteRef`
  // by reference identity — when they match, we know this `blocks` came
  // from us applying a remote update, and we must not republish it (which
  // would (a) corrupt initial persistence on join and (b) make
  // Y.UndoManager track remote edits, breaking Ctrl+Z).
  const lastRemoteBlocksRef = useRef(null);

  // Suspends the blocks publish effect until the initial server sync
  // completes. Without this, the first render would push INITIAL_BLOCKS
  // into Y.Doc before the server's persisted state arrives, duplicating
  // the document on rejoin.
  const sessionReadyRef = useRef(false);

  // I-3: suspends the meta publish effect until the first remote meta
  // observation, so a stale local sectionMeta cannot clobber the room's
  // server-side meta on first join.
  const metaReadyRef = useRef(false);

  // M-shared-tc echo gate. See markTcSeqApplied below.
  const lastPublishedTcSeqRef = useRef(0);

  // A4 latch: once the doc exceeds MAX_PUBLISH_BYTES, we hold until the
  // user shrinks it back under the cap. Without this latch the publish
  // effect re-runs `estimatePublishBytes` and re-pushes a sticky toast on
  // every keystroke.
  const publishDisabledRef = useRef(false);

  // ── Stable callback refs ──────────────────────────────────────────────
  // The session lifecycle effect depends only on roomId+identity (so the
  // session is stable across blocks updates). All callbacks therefore go
  // through refs refreshed every render — without this the session would
  // close+reopen on every render.
  const onBlocksReceivedRef = useRef(onBlocksReceived);
  onBlocksReceivedRef.current = onBlocksReceived;
  const onMetaReceivedRef = useRef(onMetaReceived);
  onMetaReceivedRef.current = onMetaReceived;
  const onTcReceivedRef = useRef(onTcReceived);
  onTcReceivedRef.current = onTcReceived;
  const onCommentsReceivedRef = useRef(onCommentsReceived);
  onCommentsReceivedRef.current = onCommentsReceived;
  const onPresenceChangeRef = useRef(onPresenceChange);
  onPresenceChangeRef.current = onPresenceChange;
  const onStatusChangeRef = useRef(onStatusChange);
  onStatusChangeRef.current = onStatusChange;
  const pushToastRef = useRef(pushToast);
  pushToastRef.current = pushToast;
  const getInitialBlocksRef = useRef(getInitialBlocks);
  getInitialBlocksRef.current = getInitialBlocks;
  const getInitialMetaRef = useRef(getInitialMeta);
  getInitialMetaRef.current = getInitialMeta;
  const getPublishableTcRef = useRef(getPublishableTc);
  getPublishableTcRef.current = getPublishableTc;
  const authTokenRef = useRef(authToken);
  authTokenRef.current = authToken;

  // ── Session lifecycle ─────────────────────────────────────────────────
  useEffect(() => {
    if (!inRoom || !identity) return;

    const session = createCollabSession({
      room: roomId,
      token: authTokenRef.current,
      getTokenFn,
      identity,
      initialBlocks: getInitialBlocksRef.current?.() ?? [],
      initialMeta: getInitialMetaRef.current?.() ?? null,
      onRemoteBlocks: (nextBlocks, meta) => {
        // Stash BEFORE the React update so the publish effect's
        // ref-identity check can detect "this blocks ref came from us
        // applying a remote payload, skip the echo."
        lastRemoteBlocksRef.current = nextBlocks;
        if (meta?.initial) sessionReadyRef.current = true;
        onBlocksReceivedRef.current?.(nextBlocks, meta);
      },
      onRemoteMeta: (remote, meta) => {
        // I-3: flip ready BEFORE the App callback so a setSectionMeta
        // fired inside onMetaReceived can be safely published on the
        // next render.
        metaReadyRef.current = true;
        onMetaReceivedRef.current?.(remote, meta);
      },
      onRemoteTc: (payload, meta) => {
        // App is expected to call markTcSeqApplied(next.publishSeq) from
        // inside its setTcState updater. We can't bump the seq here
        // because the new state is computed asynchronously by App.
        onTcReceivedRef.current?.(payload, meta);
      },
      onRemoteComments: (commentsObj, meta) => {
        onCommentsReceivedRef.current?.(commentsObj, meta);
      },
      onPresenceChange: (states) => {
        onPresenceChangeRef.current?.(states);
      },
      onStatusChange: (status, meta) => {
        onStatusChangeRef.current?.(status, meta);
      },
    });

    sessionRef.current = session;
    setYStoreState(session.yStore);

    // DEV-only: expose for browser devtools debugging. Gated on DEV so a
    // production build does not ship a global that exposes ydoc + awareness
    // state to any page script that gets past the CSP.
    const EXPOSE_DEBUG = typeof import.meta !== 'undefined' && import.meta.env?.DEV;
    if (EXPOSE_DEBUG && typeof window !== 'undefined') window.__collab = session;

    return () => {
      session.destroy();
      sessionRef.current = null;
      setYStoreState(null);
      sessionReadyRef.current = false;
      metaReadyRef.current = false;
      lastRemoteBlocksRef.current = null;
      lastPublishedTcSeqRef.current = 0;
      publishDisabledRef.current = false;
      if (EXPOSE_DEBUG && typeof window !== 'undefined') delete window.__collab;
    };
    // Intentionally depend only on roomId + identity. initialBlocks /
    // initialMeta / authToken / callbacks are read via refs so the session
    // is stable across blocks/meta/state updates.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inRoom, roomId, identity, getTokenFn]);

  // ── Publish effect: blocks ────────────────────────────────────────────
  useEffect(() => {
    if (!inRoom) return;
    const session = sessionRef.current;
    if (!session) return;
    if (!sessionReadyRef.current) return;
    // Reference-identity echo guard: if blocks IS the array onRemoteBlocks
    // just stashed, this update came from us applying a remote payload.
    if (blocks === lastRemoteBlocksRef.current) return;
    try {
      session.publishBlocks(blocks);
      // Success — clear any previous over-cap latch.
      if (publishDisabledRef.current) {
        publishDisabledRef.current = false;
        pushToastRef.current?.({
          kind: 'success',
          title: 'Sync resumed',
          body: 'Document is back under the collab size limit.',
          ttl: 5000,
        });
      }
    } catch (err) {
      if (err instanceof DocSizeLimitError) {
        // M7 — only push the error toast the first time we hit the limit
        // to avoid spamming the user on every keystroke while oversized.
        if (!publishDisabledRef.current) {
          publishDisabledRef.current = true;
          pushToastRef.current?.({
            kind: 'error',
            title: 'Document too large to sync',
            body: `This document is ${(err.actualBytes / (1024 * 1024)).toFixed(1)} MB, ` +
                  `over the ${(err.maxBytes / (1024 * 1024)).toFixed(0)} MB collab limit. ` +
                  `Your edits are not being shared with other users. ` +
                  `Remove some content and try again.`,
            ttl: 0, // sticky — user dismisses manually
          });
        }
      } else {
        console.error('[collab] publishBlocks failed:', err);
      }
    }
  }, [blocks, inRoom]);

  // ── Publish effect: meta ──────────────────────────────────────────────
  // No explicit echo guard: publishMeta does a per-key diff (compare
  // `cur !== v` before writing) so a no-op publish produces a zero-change
  // transaction, and the 'local-meta' origin is filtered inside
  // handleAfterTx so a fired transaction wouldn't round-trip anyway.
  useEffect(() => {
    if (!inRoom) return;
    const session = sessionRef.current;
    if (!session) return;
    if (!sessionReadyRef.current) return;
    if (!metaReadyRef.current) return;
    session.publishMeta({ ...sectionMeta, fileName });
  }, [sectionMeta, fileName, inRoom]);

  // ── Publish effect: track changes ─────────────────────────────────────
  // Gate: publish only when tcState.publishSeq has advanced past what we
  // last sent (or last marked-as-applied via markTcSeqApplied). User verbs
  // bump publishSeq; applyRemote does not.
  useEffect(() => {
    if (!inRoom) return;
    const session = sessionRef.current;
    if (!session) return;
    if (!sessionReadyRef.current) return;
    if (tcState.publishSeq === lastPublishedTcSeqRef.current) return;
    lastPublishedTcSeqRef.current = tcState.publishSeq;
    try {
      session.publishTc(getPublishableTcRef.current?.(tcState));
    } catch (err) {
      console.error('[collab] publishTc failed:', err);
    }
  }, [tcState, inRoom]);

  // ── Cursor broadcast ──────────────────────────────────────────────────
  // Listens for selectionchange and broadcasts the caret position so other
  // peers see a live cursor.
  useEffect(() => {
    if (!inRoom) return;
    const handler = () => {
      const session = sessionRef.current;
      if (!session) return;
      const active = document.activeElement;
      if (!active?.dataset?.blockId || active.contentEditable !== 'true') {
        session.setCursor(null);
        return;
      }
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) {
        session.setCursor(null);
        return;
      }
      const range = sel.getRangeAt(0);
      if (!active.contains(range.startContainer)) {
        session.setCursor(null);
        return;
      }
      const idx = plainTextOffset(active, range.startContainer, range.startOffset);
      if (idx < 0) { session.setCursor(null); return; }
      session.setCursor({
        blockId: active.dataset.blockId,
        index: idx,
      });
    };
    document.addEventListener('selectionchange', handler);
    return () => document.removeEventListener('selectionchange', handler);
  }, [inRoom]);

  // ── Imperative API ────────────────────────────────────────────────────
  const dispatchComment = useCallback((envelope) => {
    if (!envelope || !inRoom) return;
    const session = sessionRef.current;
    if (!session) return;
    try { session.dispatchComment(envelope); }
    catch (err) { console.error('[collab] dispatchComment failed:', err); }
  }, [inRoom]);

  const markTcSeqApplied = useCallback((seq) => {
    if (typeof seq === 'number') lastPublishedTcSeqRef.current = seq;
  }, []);

  const tryUndo = useCallback(() => {
    const session = sessionRef.current;
    if (!session) return false;
    session.undo();
    return true;
  }, []);

  const tryRedo = useCallback(() => {
    const session = sessionRef.current;
    if (!session) return false;
    session.redo();
    return true;
  }, []);

  const canUndo = useCallback(() => {
    const session = sessionRef.current;
    return session ? session.canUndo() : false;
  }, []);

  const canRedo = useCallback(() => {
    const session = sessionRef.current;
    return session ? session.canRedo() : false;
  }, []);

  return {
    dispatchComment,
    markTcSeqApplied,
    tryUndo,
    tryRedo,
    canUndo,
    canRedo,
    yStore,
  };
}

// Local copy of App's getPlainTextOffset so the hook does not depend on App.
// Walks text nodes under `root` to compute the plain-text offset of
// (node, offset). Used to broadcast caret position across DOM rewrites.
function plainTextOffset(root, node, offset) {
  if (!root || !node) return -1;
  let total = 0;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
  let current;
  while ((current = walker.nextNode())) {
    if (current === node) return total + offset;
    total += current.nodeValue.length;
  }
  return -1;
}
