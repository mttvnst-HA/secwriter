/**
 * useCollabSession — owns the Yjs collaboration session lifecycle and the
 * four publish effects (blocks, meta, TC, comments).
 *
 * Architecture-review entry #5 (docs/architecture-review.md):
 * before this hook existed, the publish-path coordination was inlined in
 * App.jsx. App held five refs (`collabSessionRef`, `lastRemoteBlocksRef`,
 * `sessionReadyRef`, `metaReadyRef`, `lastPublishedTcSeqRef`,
 * `publishDisabledRef`), the session lifecycle effect, and four parallel
 * publish effects — together ~250 lines that had to coordinate or the
 * document either round-tripped (corrupting persistence) or stopped
 * publishing (silently losing edits).
 *
 * Architecture-review entry #10 (2026-05-19): the five lifecycle / UX
 * latches that grew on top of #5 — sessionReady, metaReady,
 * publishDisabled (now publishOvercap), schemaIncompatible,
 * migrationPartial — landed as a pure reducer in
 * `src/lib/session-coordination.js`. The hook applies it to a
 * `coordRef.current` (not React useState) so coord transitions do NOT
 * invalidate the publish-effect dep lists. Echo caches
 * (lastRemoteBlocksRef, lastPublishedTcSeqRef) and the session handle
 * stay as plain refs — they're not state-machine nodes.
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
import { encodeSidecar } from '../lib/lint-sidecar.js';
import * as sc from '../lib/session-coordination.js';

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
 * @property {(lintPayload:Object, meta:{initial:boolean}) => void} [onLintReceived]
 *   Issue #150: a v1 lint-sidecar payload arriving from a peer (or from
 *   server-persisted state on join). App is expected to feed it into
 *   `decodeSidecar` + `projectDecoded` + `prefillFromSidecar`.
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
 * @property {() => void} clearStack
 *   1i-b.2 — drops both undo and redo stacks atomically (via
 *   Y.UndoManager.clear). App's file-import handler calls this so
 *   Ctrl+Z cannot cross the file boundary. No-op when no session is
 *   live (the out-of-room equivalent lives on the local-substrate
 *   manager).
 * @property {Y.Map|null} yStore
 *   The session's per-block Y.Map<string, Y.Map> — exposed so App can
 *   compute `activeYStore = inRoom ? collab.yStore : localYStore` and
 *   pass it to PmEditableBlock's ySyncPlugin. State, not ref: re-renders
 *   when the session is created or destroyed so PmEditableBlock's
 *   useSyncExternalStore subscription resubscribes to the new substrate.
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
  lintingState,
  getPublishableTc,

  getInitialBlocks,
  getInitialMeta,

  onBlocksReceived,
  onMetaReceived,
  onTcReceived,
  onCommentsReceived,
  onLintReceived,
  onPresenceChange,
  onStatusChange,

  pushToast,
}) {
  // ── Coordination state ────────────────────────────────────────────────
  // The session itself.
  const sessionRef = useRef(null);

  // Active session's yStore as state — mirrors sessionRef.current?.yStore
  // but re-renders the consumer when the session is (re)created or
  // destroyed so PmEditableBlock's useSyncExternalStore subscription
  // resubscribes against the right substrate. Null when out of room.
  const [yStore, setYStoreState] = useState(null);

  // Echo guard for blocks: every remote payload is stashed here BEFORE
  // App's setBlocks runs. The publish effect checks `blocks === remoteRef`
  // by reference identity — when they match, we know this `blocks` came
  // from us applying a remote update, and we must not republish it (which
  // would (a) corrupt initial persistence on join and (b) make
  // Y.UndoManager track remote edits, breaking Ctrl+Z).
  const lastRemoteBlocksRef = useRef(null);

  // M-shared-tc echo gate. See markTcSeqApplied below.
  const lastPublishedTcSeqRef = useRef(0);

  // Issue #150 lint echo guard. Skips the async encode when byBlock has not
  // changed since the last publish. A remote receive creates a new byBlock
  // Map (via prefillFromSidecar), so this guard is a true ref identity check
  // — the encode still runs after a remote receive, but publishLintToDoc
  // diffs the result against yLint and no-ops if nothing actually changed.
  const lastPublishedLintByBlockRef = useRef(null);

  // Lifecycle / UX state — see src/lib/session-coordination.js. Pure
  // reducer applied to a ref so coord transitions do not invalidate the
  // publish-effect dep lists (which would otherwise cause re-publish
  // storms when publishOvercap yo-yos around the cap, or when
  // schemaIncompatible trips between meta edits — see architecture-review
  // entry #10).
  const coordRef = useRef(sc.createInitial());

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
  const onLintReceivedRef = useRef(onLintReceived);
  onLintReceivedRef.current = onLintReceived;
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
          coordRef.current = sc.onBlocksSync(coordRef.current);
          // Expose the session yStore only AFTER first sync so
          // PmEditableBlock's substrate subscription (and every App
          // handler that reads activeYStoreRef.current) cannot write
          // into a Y.Doc that hasn't yet absorbed the server's
          // persisted state. Without this gate, a typed character or
          // programmatic html mutation landing in the sync window
          // CRDT-merges on top of the remote state — the eee8977
          // corruption pattern, via the direct setBlockHtml path
          // instead of publishBlocks.
          setYStoreState(session.yStore);
        }
        onBlocksReceivedRef.current?.(nextBlocks, meta);
      },
      onRemoteMeta: (remote, meta) => {
        // 1b.1 schema-version gate. On the first sync, if the room's
        // schemaVersion exceeds what this client supports, refuse the room.
        // Pull the yStore back out of the binder so local writes can't even
        // touch the substrate, and route the ConnectionBanner to its
        // 'incompatible' state via onStatusChange. metaReady IS flipped
        // (sc.onMetaSync always flips it) but every canPublish* selector
        // gates on !schemaIncompatible, so the App callback chain remains
        // muted: we short-circuit BEFORE invoking onMetaReceived, so App's
        // downstream state machine sees nothing.
        let coord = coordRef.current;
        if (meta?.initial) {
          coord = sc.onMetaSync(coord, {
            schemaVersion: remote?.schemaVersion,
            migrationPartial: remote?.migrationPartial,
          });
          coordRef.current = coord;
          if (coord.schemaIncompatible) {
            setYStoreState(null);
            onStatusChangeRef.current?.('incompatible', { reconnectIn: 0 });
            return;
          }
          // 1d/Q22 broker outcome: a partial migration leaves the room
          // editable but with some blocks still on the legacy Y.Text
          // substrate. Surface the banner so the user knows the room had
          // issues, but do NOT short-circuit — onMetaReceived must still
          // fire and publish gates must remain open.
          if (coord.migrationPartial) {
            onStatusChangeRef.current?.('migration-partial', { reconnectIn: 0 });
          }
        } else {
          // I-3: flip metaReady BEFORE the App callback so a
          // setSectionMeta fired inside onMetaReceived can be safely
          // published on the next render. (For meta.initial=true the
          // sc.onMetaSync call above already did this.)
          coordRef.current = sc.onMetaSync(coord);
        }
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
      onRemoteLint: (lintPayload, meta) => {
        onLintReceivedRef.current?.(lintPayload, meta);
      },
      onPresenceChange: (states) => {
        onPresenceChangeRef.current?.(states);
      },
      onStatusChange: (status, meta) => {
        // Sticky-status filter — see sc.effectiveStatus:
        //   - schemaIncompatible is terminal: every incoming status
        //     collapses to 'incompatible' so the banner cannot be
        //     clobbered by a later 'connected' / 'connecting' /
        //     'disconnected' transition. Two clobber paths this guards:
        //       1. collab.js handleSync fires onStatusChange('connected')
        //          a few lines after onRemoteMeta returns — without
        //          this guard the banner would flash 'incompatible' and
        //          immediately revert, leaving an editable-looking UI
        //          where typing silently never persists (publish gates
        //          are still closed, so writes go nowhere).
        //       2. y-websocket reconnect events fire 'connecting' /
        //          'disconnected' via handleStatus — same clobber
        //          pattern over a longer window.
        //   - migrationPartial replaces 'connected' with
        //     'migration-partial' so the operator-actionable banner
        //     survives reconnects. Other statuses pass through (a
        //     real disconnect should still read as 'disconnected').
        // Read coord once so the suppression check and effectiveStatus
        // call share the same snapshot. The post-incompatibility
        // suppression rule: pre-refactor only let the original
        // 'incompatible' emission through; a later 'connected' was
        // suppressed entirely rather than re-emitted as a derived
        // 'incompatible'. We preserve that — sc.effectiveStatus would
        // happily collapse a 'connected' to 'incompatible', but App
        // does not need duplicate banner pings.
        const coord = coordRef.current;
        if (coord.schemaIncompatible && status !== 'incompatible') return;
        onStatusChangeRef.current?.(sc.effectiveStatus(coord, status), meta);
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
      lastRemoteBlocksRef.current = null;
      lastPublishedTcSeqRef.current = 0;
      lastPublishedLintByBlockRef.current = null;
      coordRef.current = sc.createInitial();
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
    if (!sc.canPublishBlocks(coordRef.current)) return;
    // Reference-identity echo guard: if blocks IS the array onRemoteBlocks
    // just stashed, this update came from us applying a remote payload.
    if (blocks === lastRemoteBlocksRef.current) return;
    try {
      session.publishBlocks(blocks);
      // Success — clear any previous over-cap latch and trigger the
      // resumed toast on the prev→next overcap diff (per design lock,
      // toast is a hook-side side effect, not a reducer concern). The
      // assignment is unconditional even when the verb is a no-op
      // (next === prev by ref) so reducer hygiene reads cleanly at the
      // call site; the toast only fires on the actual transition.
      const prev = coordRef.current;
      const next = sc.onPublishSucceeded(prev);
      coordRef.current = next;
      if (prev.publishOvercap && !next.publishOvercap) {
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
        const prev = coordRef.current;
        const next = sc.onPublishOvercap(prev);
        coordRef.current = next;
        if (!prev.publishOvercap && next.publishOvercap) {
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
    if (!sc.canPublishMeta(coordRef.current)) return;
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
    if (!sc.canPublishTc(coordRef.current)) return;
    if (tcState.publishSeq === lastPublishedTcSeqRef.current) return;
    lastPublishedTcSeqRef.current = tcState.publishSeq;
    try {
      session.publishTc(getPublishableTcRef.current?.(tcState));
    } catch (err) {
      console.error('[collab] publishTc failed:', err);
    }
  }, [tcState, inRoom]);

  // ── Publish effect: lint sidecar (#150) ───────────────────────────────
  // Encodes the linting reducer's byBlock map into a v1 sidecar payload
  // and writes diffs into yLint. Async because fingerprinting goes through
  // Web Crypto. Phase 1 is set-only (never deletes): a fingerprint that
  // disappears from one peer's payload may still be valid for another
  // peer's block. Garbage collection is deferred to a phase 3 ticket.
  //
  // Gating: shares the canPublishMeta gate — meta and lint both want to
  // wait for first sync + schema compatibility. canPublishBlocks would
  // also work but meta is closer in spirit (cache state, not user verb).
  useEffect(() => {
    if (!inRoom) return;
    const session = sessionRef.current;
    if (!session || typeof session.publishLint !== 'function') return;
    if (!sc.canPublishMeta(coordRef.current)) return;
    if (!lintingState || !lintingState.byBlock || lintingState.byBlock.size === 0) return;
    if (lintingState.byBlock === lastPublishedLintByBlockRef.current) return;
    let cancelled = false;
    (async () => {
      let payload;
      try {
        payload = await encodeSidecar(lintingState.byBlock, blocks);
      } catch (err) {
        console.error('[collab] encodeSidecar failed:', err);
        return;
      }
      if (cancelled) return;
      // Phase-1 set-only: only push when there's something to push.
      const hasGood = typeof payload.good === 'string' && payload.good.length > 0;
      const hasBad = payload.bad && Object.keys(payload.bad).length > 0;
      if (!hasGood && !hasBad) return;
      try {
        session.publishLint(payload);
        lastPublishedLintByBlockRef.current = lintingState.byBlock;
      } catch (err) {
        console.error('[collab] publishLint failed:', err);
      }
    })();
    return () => { cancelled = true; };
  }, [lintingState, blocks, inRoom]);

  // ── Cursor broadcast ──────────────────────────────────────────────────
  // Listens for selectionchange and broadcasts the caret position so other
  // peers see a live cursor. Gated on canBroadcastCursor so an
  // incompatible-room session does not leak the user's caret position into
  // awareness after the banner has told them the room is locked
  // (privacy / consistency with the four publish paths).
  useEffect(() => {
    if (!inRoom) return;
    const handler = () => {
      if (!sc.canBroadcastCursor(coordRef.current)) return;
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
    if (!sc.canDispatchComment(coordRef.current)) return;
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

  // 1i-b.2 — drop both undo and redo stacks atomically. App's file-import
  // handler calls this so Ctrl+Z cannot cross the file boundary. No-op when
  // out of room (sessionRef is null).
  const clearStack = useCallback(() => {
    const session = sessionRef.current;
    if (session && typeof session.clearStack === 'function') {
      session.clearStack();
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
    clearStack,
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
