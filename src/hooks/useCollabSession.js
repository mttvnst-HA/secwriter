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
 * @property {(fn: () => void) => void} withUndoFrame
 *   1h Q36 Commit A — when a session is live, wraps `fn` in
 *   `ydoc.transact(fn, 'local-publish')` so its writes collapse to one
 *   undo frame. When no session is live (out of room, or session not
 *   yet created), runs `fn` directly so its non-Yjs side effects (like
 *   `setBlocks`) still execute. This makes the helper safe to call
 *   regardless of room state — Commit C's migrated sites don't need to
 *   gate on `inRoom`. Stable identity across renders — safe to include
 *   in `useMemo` / `useCallback` dep lists.
 * @property {() => void} forceFrame
 *   1h Q36 Commit A — ends the current UndoManager capture window so
 *   the next 'local-publish' write starts a fresh frame. No-op when no
 *   session is live. Stable identity across renders.
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

  // Sub-PR 1b.1 (#47 v2 plan, Q25). Trips when the room's
  // yMeta.schemaVersion is higher than this client's max supported version.
  // Forces collab into read-only via the 'incompatible' status; gates all
  // publish paths so a stale write cannot land in a v2 doc; nulls the yStore
  // exposure so EditableBlock's binder writes also no-op. The user reloads
  // to pick up a newer client.
  //
  // Sub-PR 1d (#47, ADR-0006) bumps max-supported to 2: this client speaks
  // the Y.XmlFragment substrate. A future v3 client/server pair will bump
  // this further; the gate's purpose is unchanged.
  const schemaIncompatibleRef = useRef(false);
  const MAX_SUPPORTED_SCHEMA_VERSION = 2;

  // Sub-PR 1d (#47, ADR-0006). Trips when the broker reports
  // yMeta.migrationPartial === true on the first sync. Unlike
  // schemaIncompatibleRef the room remains editable; the ref only exists
  // to keep the banner sticky. Without this, the trailing
  // handleSync('connected') in collab.js (fired immediately after
  // onRemoteMeta) clobbers the 'migration-partial' status with 'connected'
  // and the banner disappears, hiding the operator-actionable signal that
  // some blocks failed to migrate. Reconnect cycles also fire 'connected'
  // through handleStatus — we re-pin to 'migration-partial' on every
  // 'connected' transition so the banner survives the full session.
  // 'connecting' / 'disconnected' / 'syncing' / 'incompatible' are NOT
  // suppressed — those carry more urgent state for the user.
  const migrationPartialRef = useRef(false);

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
        if (meta?.initial) {
          sessionReadyRef.current = true;
          // Expose the session yStore only AFTER first sync so
          // EditableBlock's binder (and every App handler that reads
          // activeYStoreRef.current) cannot write into a Y.Doc that
          // hasn't yet absorbed the server's persisted state. Without
          // this gate, a typed character or programmatic html mutation
          // landing in the sync window CRDT-merges on top of the
          // remote state — the eee8977 corruption pattern, via the
          // direct setBlockHtml path instead of publishBlocks.
          setYStoreState(session.yStore);
        }
        onBlocksReceivedRef.current?.(nextBlocks, meta);
      },
      onRemoteMeta: (remote, meta) => {
        // 1b.1 schema-version gate. On the first sync, if the room's
        // schemaVersion exceeds what this client supports, refuse the room.
        // Pull the yStore back out of the binder so local writes can't even
        // touch the substrate, and route the ConnectionBanner to its
        // 'incompatible' state via onStatusChange. metaReadyRef stays false
        // and onMetaReceived never fires, so App's downstream state machine
        // sees nothing.
        if (meta?.initial) {
          const v = remote?.schemaVersion;
          if (typeof v === 'number' && v > MAX_SUPPORTED_SCHEMA_VERSION) {
            schemaIncompatibleRef.current = true;
            setYStoreState(null);
            onStatusChangeRef.current?.('incompatible', { reconnectIn: 0 });
            return;
          }
          // 1d/Q22 broker outcome: a partial migration leaves the room
          // editable but with some blocks still on the legacy Y.Text
          // substrate. Surface the banner so the user knows the room had
          // issues, but do NOT short-circuit — onMetaReceived must still
          // fire and publish gates must remain open.
          if (remote?.migrationPartial === true) {
            migrationPartialRef.current = true;
            onStatusChangeRef.current?.('migration-partial', { reconnectIn: 0 });
          }
        }
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
        // 1b.1 sticky-incompatible. Once the schema-version gate has
        // tripped, the room is permanently unusable for this session.
        // Suppress any subsequent status transitions so they cannot clobber
        // the 'incompatible' banner. This covers two clobber paths:
        //   1. collab.js handleSync fires onStatusChange('connected') a few
        //      lines after onRemoteMeta returns — without this guard the
        //      banner would flash 'incompatible' and immediately revert,
        //      leaving an editable-looking UI where typing silently never
        //      persists (the four publish paths are still gated, so writes
        //      go nowhere).
        //   2. y-websocket reconnect events fire 'connecting'/'disconnected'
        //      via handleStatus — same clobber pattern over a longer window.
        if (schemaIncompatibleRef.current && status !== 'incompatible') {
          return;
        }
        // 1d sticky-migration-partial. handleSync emits 'connected'
        // shortly after onRemoteMeta sets the partial flag — and every
        // reconnect re-emits 'connected' too. Replacing 'connected' with
        // 'migration-partial' (rather than swallowing it entirely)
        // preserves the rest of the status state machine: a subsequent
        // 'disconnected' or 'connecting' still reaches the consumer, and
        // when the room reconnects the banner re-pins automatically.
        if (migrationPartialRef.current && status === 'connected') {
          onStatusChangeRef.current?.('migration-partial', meta);
          return;
        }
        onStatusChangeRef.current?.(status, meta);
      },
    });

    sessionRef.current = session;

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
      schemaIncompatibleRef.current = false;
      migrationPartialRef.current = false;
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
    if (schemaIncompatibleRef.current) return;
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
    if (schemaIncompatibleRef.current) return;
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
    if (schemaIncompatibleRef.current) return;
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
  // peers see a live cursor. Gated on schemaIncompatibleRef so an
  // incompatible-room session does not leak the user's caret position into
  // awareness after the banner has told them the room is locked
  // (privacy / consistency with the four publish paths).
  useEffect(() => {
    if (!inRoom) return;
    const handler = () => {
      if (schemaIncompatibleRef.current) return;
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
    if (schemaIncompatibleRef.current) return;
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
    return session.canUndo() && (session.undo(), true);
  }, []);

  const tryRedo = useCallback(() => {
    const session = sessionRef.current;
    if (!session) return false;
    return session.canRedo() && (session.redo(), true);
  }, []);

  const canUndo = useCallback(() => {
    const session = sessionRef.current;
    return session ? session.canUndo() : false;
  }, []);

  const canRedo = useCallback(() => {
    const session = sessionRef.current;
    return session ? session.canRedo() : false;
  }, []);

  // 1h Q36 Commit A — undo helpers. Stable function identities returned
  // from useCallback so App-level memos that depend on them don't re-run
  // unnecessarily. Each call reads sessionRef.current so a session
  // create/destroy cycle picks up the latest helpers without a re-render.
  //
  //   withUndoFrame: when a session is live, wraps `fn` in
  //     ydoc.transact(fn, 'local-publish') so its Yjs writes collapse to
  //     one undo frame. When NO session is live, runs `fn` directly so
  //     its non-Yjs side effects (setBlocks, React state updates) still
  //     execute — Commit C's migrated sites don't need to gate on
  //     `inRoom`. The Commit B out-of-room local-substrate hook will own
  //     framing for that path independently.
  //   forceFrame: ends the UndoManager's current capture window when a
  //     session is live; no-op otherwise.
  const withUndoFrame = useCallback((fn) => {
    const session = sessionRef.current;
    if (session && typeof session.withUndoFrame === 'function') {
      session.withUndoFrame(fn);
      return;
    }
    fn();
  }, []);

  const forceFrame = useCallback(() => {
    const session = sessionRef.current;
    if (session && typeof session.forceFrame === 'function') {
      session.forceFrame();
    }
  }, []);

  return {
    dispatchComment,
    markTcSeqApplied,
    tryUndo,
    tryRedo,
    canUndo,
    canRedo,
    withUndoFrame,
    forceFrame,
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
