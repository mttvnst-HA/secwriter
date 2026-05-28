/**
 * PmEditableBlock — y-prosemirror-backed editable block.
 *
 * Sub-PR 1e (#47, ADR-0006). Mounts a PM EditorView per block, bound via
 * `ySyncPlugin` to the block's Y.XmlFragment in the substrate. The sole
 * editor for editable text blocks since sub-PR 1i-b.2 retired the legacy
 * contentEditable path (EditableBlock.jsx, useBlockBinder.js, the
 * `VITE_PM_EDITOR` flag).
 *
 * Props (App→block surface):
 *   - block, yStore, onUpdate, onEnterKey, isFocused, onFocus
 *   - oliLabel, onDelete, onFocusPrev, onFocusNext
 *   - onConvertBlock, onChangeOliLevel
 *   - resolveHtml, tailorKey
 *   - trackChanges, identity
 *   - onAcceptRevision, onRejectRevision
 *   - comments, onCommentClick, onInlineFix
 *   - lintingState, lintingDispatch, showTags, readOnly
 *
 * Architecture notes (live with the file because they govern every change):
 *   1. EditorView is mounted ONCE per block (see Q29 R4 spike: 83.2ms P50
 *      for 300 blocks — well under the 200ms threshold). The view persists
 *      across React re-renders; only React-state-driven props (showTags,
 *      tailorKey, etc.) flow into the view via dispatched meta or
 *      imperative calls.
 *   2. `ySyncPlugin` is the substrate binding. y-prosemirror's
 *      `ySyncPluginKey` Y origin is what every PM-driven write carries.
 *      Both UndoManagers (in-room in `src/lib/collab.js`, out-of-room in
 *      `src/hooks/useLocalSubstrateUndoManager.js`) track BOTH
 *      `ySyncPluginKey` and `'local-publish'`, so PM keystrokes and the
 *      debounced echo write via `setBlockHtml` join the same undo frame.
 *      The word-boundary-undo plugin calls `forceFrame` on space /
 *      punctuation / Enter so typing bursts split into per-word frames
 *      matching Word/Notion convention.
 *   3. NO_EXFIL_PROPS goes through `EditorProps.attributes` with lowercase
 *      HTML attribute names (Q31/E2). React's camelCase props don't reach
 *      PM's DOM root because PM owns its DOM.
 *   4. Tag visibility is a PM plugin emitting widget decorations, not
 *      contentEditable=false DOM injection (Q4). Pseudo-elements don't
 *      create caret positions; widgets do.
 *   5. Slash detection is a PM plugin watching transactions
 *      (`pm-plugins/slash-menu.js`, Q5). React `SlashMenu.jsx` is the popup,
 *      portal-mounted at `document.body` with `position: fixed` and anchored
 *      via `view.coordsAtPos(fromPos)` (the `computeSlashAnchorRect` helper
 *      handles the fallback to the block's bounding box). PmEditableBlock
 *      owns the combobox ARIA wiring: the PM editor's contentEditable DOM
 *      gets `role=combobox` + `aria-controls` + `aria-activedescendant`
 *      while the menu is open (the listbox itself never receives focus).
 *      Hover is parent-routed via `onHoverChange` → `selectedIdx` so arrow
 *      keys advance from the hovered row, not from a stale internal value.
 *      Three dismiss paths route through `pm-slash-dismiss.js` helpers
 *      (`closeSlashMenuPlugin` + `isBlockJustSlashTrigger`): Escape and a
 *      document-level mousedown listener (gated on `slashState.open`) close
 *      the plugin via a `forceClose` meta — closing React state alone gets
 *      re-projected back to open on the next keystroke. Escape and outside-
 *      click delete the block when it contains only the slash trigger;
 *      inside-click converts to a fresh empty paragraph via `onConvertBlock`.
 *   6. Re-lint trigger is `dispatchTransaction` (Q27) — fires for both
 *      local and remote ops. The legacy `useBlockLinting` hook expects an
 *      'input' event; we synthesize a fake one on doc-changing transactions
 *      so the existing debounce stays untouched.
 *
 * What's deliberately NOT in this file:
 *   - The legacy `setRef` / ZWS focus glue (Q4). PM owns the cursor model.
 *   - The handleInput debounce (Q22 substrate writes are sync via ySync).
 *   - `syncTagLabels` / `stripTagLabels` DOM mutation (decorations now).
 *   - Slash-menu dismiss helpers — extracted to `lib/pm-slash-dismiss.js`
 *     so Vitest can exercise them without mounting React + a PM EditorView.
 */

import {
  useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore,
} from 'react';
import { EditorState, Selection } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { ySyncPlugin, ySyncPluginKey } from 'y-prosemirror';

import SlashMenu, { SLASH_ITEMS } from './SlashMenu.jsx';
import InlineTooltip from './InlineTooltip.jsx';
import { schema } from '../lib/pm-schema.js';
import { pmFragmentToHtml } from '../lib/pmdoc-html.js';
import { BLOCK_MARGINS } from '../lib/ini-config.js';
import { slashMenuPlugin, slashMenuPluginKey } from '../lib/pm-plugins/slash-menu.js';
import { closeSlashMenuPlugin, isBlockJustSlashTrigger } from '../lib/pm-slash-dismiss.js';
import { tagLabelsPlugin, setTagsVisible } from '../lib/pm-plugins/tag-labels.js';
import { blockKeymap } from '../lib/pm-plugins/keymap.js';
import { wordBoundaryUndoPlugin } from '../lib/pm-plugins/word-boundary-undo.js';
import { registerBlock, unregisterBlock } from '../lib/block-registry.js';
import { subscribeBlock } from '../lib/block-html-store.js';
import { dispatchDelAction } from '../lib/pm-del-popup.js';
import { activeCommentPlugin } from '../lib/pm-plugins/active-comment.js';
import { COMMENT_RECONCILE_META, reconcileCommentMarks } from '../lib/pm-comments.js';
import { rewriteForTrackChanges, docHasInlineRevisions, TC_RESOLVE_META } from '../lib/pm-tc-mark.js';
import { sanitizePasteText } from '../lib/paste-sanitize.js';
import { useBlockLinting } from './useBlockLinting.js';

/**
 * 1i-b.1 — migrationPartial detection. A block whose html slot is still
 * Y.Text (per-block conversion failed in the 1d migration broker) cannot
 * be safely mounted on ySyncPlugin (it expects Y.XmlFragment). Render
 * a read-only banner instead. Operator must re-run conversion to recover
 * full editability. Mirrors block-html-store.js's deriveHtml duck-typing:
 * Y.XmlFragment has toArray() and (unlike YXmlElement which has nodeName)
 * does NOT expose a nodeName property. Y.Text has toDelta() and no toArray.
 */
function isLegacyYTextSlot(yHtml) {
  if (!yHtml) return false;
  if (typeof yHtml.toArray === 'function' && typeof yHtml.nodeName !== 'string') {
    return false;
  }
  if (typeof yHtml.toDelta === 'function') return true;
  return false;
}

/**
 * NO_EXFIL attributes for PM EditorProps. PM uses raw HTML attribute names
 * (lowercase) on the rendered DOM, not React's camelCase prop names. This
 * is the explicit translation; tested by no-exfil.test.js.
 */
const NO_EXFIL_PM_ATTRS = Object.freeze({
  spellcheck: 'false',
  autocorrect: 'off',
  autocapitalize: 'off',
  autocomplete: 'off',
  'data-gramm': 'false',
  'data-gramm_editor': 'false',
  'data-enable-grammarly': 'false',
  writingsuggestions: 'false',
});

function PmEditableBlock({
  block,
  yStore,
  onUpdate,
  onEnterKey,
  isFocused,
  onFocus,
  oliLabel,
  onDelete,
  onFocusPrev,
  onFocusNext,
  onConvertBlock,
  onChangeOliLevel,
  resolveHtml,
  tailorKey,
  trackChanges,
  identity,
  onAcceptRevision,
  onRejectRevision,
  onRefreshTcSnapshot,  // 1g.5 (#86): PM-tr del-popup path — substrate-only refresh
  commentsState,    // 1g: drives per-block reconcile effect via reconcileCommentMarks
  onCommentClick,
  onInlineFix,
  lintingState,
  lintingDispatch,
  showTags = false,
  readOnly = false,
  // 1h Q36 Commit A — `collab.forceFrame` (or App's local-substrate
  // equivalent once Commit B lands). The word-boundary plugin reads
  // this through a ref on every keydown so a session create/destroy
  // cycle picks up the latest reference without rebuilding the
  // EditorView. Until Commit B adds `ySyncPluginKey` to the Yjs
  // UndoManager's trackedOrigins, calling this has no production
  // effect — but the plumbing lets Commit B land atomically.
  forceFrame,
  // #140 persistent rule ignores
  onSuppress,
  onMuteNlpRule,
}) {
  const containerRef = useRef(null);
  const viewRef = useRef(null);
  const yXmlFragmentRef = useRef(null);
  const onUpdateDebounceRef = useRef(null);
  const [slashState, setSlashState] = useState({ open: false, filter: '', selectedIdx: 0, fromPos: null });
  const [hasInlineRevisions, setHasInlineRevisions] = useState(false);
  // 1g.5 (#86): el + rect only — position resolution happens at action time
  // via view.posAtDOM(el, 0); no DOM-index against a serialized HTML string.
  const [delPopup, setDelPopup] = useState(null); // { el, rect } | null
  // QC critical-2: tick incremented every time the EditorView mounts so
  // useBlockLinting's input-listener effect re-evaluates and binds against
  // the now-existing DOM. yStore is null until first sync in collab rooms,
  // so the initial mount effect bails; without this signal, useBlockLinting
  // ran once with a null `getEl()` and never re-bound when the view appeared.
  const [viewMountTick, setViewMountTick] = useState(0);

  // App callbacks change every render; mirror into refs so the PM plugins
  // (built once at mount time inside the EditorView's plugin list) read
  // the latest closures without re-creating the view.
  const onEnterKeyRef = useRef(onEnterKey);
  onEnterKeyRef.current = onEnterKey;
  const onChangeOliLevelRef = useRef(onChangeOliLevel);
  onChangeOliLevelRef.current = onChangeOliLevel;
  const onDeleteRef = useRef(onDelete);
  onDeleteRef.current = onDelete;
  const onFocusPrevRef = useRef(onFocusPrev);
  onFocusPrevRef.current = onFocusPrev;
  const onFocusNextRef = useRef(onFocusNext);
  onFocusNextRef.current = onFocusNext;
  const onUpdateRef = useRef(onUpdate);
  onUpdateRef.current = onUpdate;
  const onConvertBlockRef = useRef(onConvertBlock);
  onConvertBlockRef.current = onConvertBlock;
  const onCommentClickRef = useRef(onCommentClick);
  onCommentClickRef.current = onCommentClick;
  const onRefreshTcSnapshotRef = useRef(onRefreshTcSnapshot);
  onRefreshTcSnapshotRef.current = onRefreshTcSnapshot;
  const blockTypeRef = useRef(block.type);
  blockTypeRef.current = block.type;
  // QC major-6: Track Changes inputs mirrored into refs so the
  // dispatchTransaction marking pipeline reads the latest values without
  // rebuilding the view. trackChanges flips on the TC toggle; identity
  // may change on auth refresh.
  const trackChangesRef = useRef(trackChanges);
  trackChangesRef.current = trackChanges;
  const identityRef = useRef(identity);
  identityRef.current = identity;
  const commentsStateRef = useRef(commentsState);
  commentsStateRef.current = commentsState;
  const yStoreRef = useRef(yStore);
  yStoreRef.current = yStore;
  const slashStateRef = useRef(slashState);
  slashStateRef.current = slashState;
  const filteredSlashRef = useRef([]);
  const forceFrameRef = useRef(forceFrame);
  forceFrameRef.current = forceFrame;

  const editable = useMemo(() => {
    const t = block.type;
    const typeEditable = t === 'txt' || t === 'note' || t === 'oli' || t === 'item' || t === 'lst' || block.isNew;
    return typeEditable && !readOnly;
  }, [block.type, block.isNew, readOnly]);

  // Subscribe to the html SLOT reference (not the outer yMap). Two distinct
  // races make this load-bearing:
  //
  //   1. Mount race (1f.5): React fires child effects before parent effects
  //      in the commit phase, so a freshly-created block (Enter / slash-
  //      convert) reaches PmEditableBlock's mount BEFORE App's seeding
  //      effect (`applyBlocksToYDoc` out-of-room, or useCollabSession's
  //      publish effect in-room) has run. Without an external-store
  //      subscription the mount effect would bail on missing yMap and
  //      never re-fire.
  //
  //   2. Broker swap race (1i-b.2 fix): the 1d server-side migration
  //      broker swaps the slot from Y.Text → Y.XmlFragment mid-session
  //      without changing the outer yMap's identity. If getSnapshot
  //      returned the yMap, useSyncExternalStore would Object.is-compare
  //      the unchanged yMap and skip the re-render — leaving
  //      PmEditableBlock stuck on the migration-partial banner forever
  //      on the original client. Returning the html slot makes the swap
  //      observable: identity flips when the broker calls
  //      yMap.set('html', newFragment).
  //
  // The seedRoom → broker race in collab.spec.js's two-tab text sync test
  // pins case 2: User A receives Y.Text slots from the seed, the broker
  // swaps to Y.XmlFragment when User B's WS upgrade fires, and A's
  // PmEditableBlock must re-render to mount the EditorView.
  const yHtmlSlot = useSyncExternalStore(
    useCallback(
      (notify) => (yStore ? subscribeBlock(yStore, block.id, notify) : () => {}),
      [yStore, block.id],
    ),
    useCallback(
      () => {
        if (!yStore) return null;
        const map = yStore.get(block.id);
        return map ? (map.get('html') || null) : null;
      },
      [yStore, block.id],
    ),
    () => null, // SSR — no Y substrate
  );
  // The outer yMap reference is stable as long as the block exists in
  // yStore. Read it on every render so the mount effect's `yMap.get('html')`
  // calls see the current slot. yHtmlSlot is what triggers re-renders;
  // yMapBound is what the code below reads for the binding.
  const yMapBound = yStore ? (yStore.get(block.id) || null) : null;

  // 1i-b.1 — derive migrationPartial state from the live html slot. The
  // useSyncExternalStore subscription above re-renders when the broker
  // swaps the slot identity, so this useMemo's dep list catches every
  // transition.
  const isMigrationPartial = useMemo(() => {
    return isLegacyYTextSlot(yHtmlSlot);
  }, [yHtmlSlot]);

  // ── Mount: create EditorView wired to the block's Y.XmlFragment ─────────
  useEffect(() => {
    if (!containerRef.current) return;
    if (!editable) return;
    if (!yStore) return;
    if (!yMapBound) return;
    if (isMigrationPartial) return; // 1i-b.1 — banner-only render path

    const yMap = yMapBound;
    const yXml = yMap.get('html');
    // Defensive — isMigrationPartial above catches the Y.Text case, but
    // keep this guard for any other unexpected slot shape (e.g. yMap with
    // no html key, slot mid-replacement). Without isMigrationPartial we'd
    // still bail silently here, which 1i-b.2 turns into an invisible block.
    if (!yXml || typeof yXml.toArray !== 'function' || typeof yXml.nodeName === 'string') {
      return;
    }
    yXmlFragmentRef.current = yXml;

    const handleSlashSelect = (type) => {
      setSlashState({ open: false, filter: '', selectedIdx: 0, fromPos: null });
      onConvertBlockRef.current?.(block.id, type);
    };

    const slashCallbacks = {
      isSlashOpen: () => slashStateRef.current.open,
      onSlashEnter: () => {
        const f = filteredSlashRef.current;
        if (!f.length) return true;
        const idx = Math.min(slashStateRef.current.selectedIdx, f.length - 1);
        handleSlashSelect(f[idx].type);
        return true;
      },
      onSlashEscape: () => {
        // Two-layer close: dispatch forceClose so the plugin state resets
        // (otherwise next keystroke re-projects open=true back into React
        // state), then mirror to React state for instant popup teardown.
        // If the block contains nothing but the slash trigger, also delete
        // the block — user requested "Escape exits the menu AND removes
        // the empty newly-created block".
        const view = viewRef.current;
        const shouldDelete = isBlockJustSlashTrigger(view);
        closeSlashMenuPlugin(view);
        setSlashState({ open: false, filter: '', selectedIdx: 0, fromPos: null });
        if (shouldDelete) onDeleteRef.current?.(block.id);
        return true;
      },
      onSlashArrowDown: () => {
        setSlashState((s) => ({
          ...s,
          selectedIdx: Math.min(s.selectedIdx + 1, filteredSlashRef.current.length - 1),
        }));
        return true;
      },
      onSlashArrowUp: () => {
        setSlashState((s) => ({ ...s, selectedIdx: Math.max(s.selectedIdx - 1, 0) }));
        return true;
      },
    };

    const plugins = [
      ySyncPlugin(yXml),
      slashMenuPlugin(),
      tagLabelsPlugin({ initialVisible: !!showTags }),
      activeCommentPlugin(),
      // 1h Q36 Commit A — must precede blockKeymap so its handleKeyDown
      // observes word-boundary keys BEFORE blockKeymap might consume
      // Enter (slash-menu selection) or Tab (OLI level change). PM
      // iterates plugins in order and stops at the first handler that
      // returns true; this plugin always returns false (observational).
      wordBoundaryUndoPlugin({
        getForceFrame: () => {
          const fn = forceFrameRef.current;
          return typeof fn === 'function' ? fn : null;
        },
      }),
      blockKeymap({
        getBlockId: () => block.id,
        getBlockType: () => blockTypeRef.current,
        isEmpty: () => isViewEmpty(viewRef.current),
        onEnterKey: () => onEnterKeyRef.current?.(block.id),
        onChangeOliLevel: (dir) => onChangeOliLevelRef.current?.(block.id, dir),
        onDeleteEmpty: () => onDeleteRef.current?.(block.id),
        onFocusPrev: () => onFocusPrevRef.current?.(block.id),
        onFocusNext: () => onFocusNextRef.current?.(block.id),
        ...slashCallbacks,
      }),
    ];

    const state = EditorState.create({ schema, plugins });

    const view = new EditorView(containerRef.current, {
      state,
      editable: () => editable,
      attributes: {
        ...NO_EXFIL_PM_ATTRS,
        class: 'sim-pm-editor',
        'data-block-id': block.id,
        'data-pm-editor': 'true',
        contenteditable: editable ? 'true' : 'false',
      },
      handleClick(view, _pos, e) {
        // Comment-span click → React popup
        const commentEl = e.target?.closest?.('.mark-comment, .mark-comment-resolved');
        if (commentEl && onCommentClickRef.current) {
          const id = commentEl.getAttribute('data-comment-id');
          if (id) {
            onCommentClickRef.current(id, commentEl.getBoundingClientRect());
            return true;
          }
        }
        // Del-span click → local popup (TC accept/reject for inline deletions)
        const delEl = e.target?.closest?.('del.mark-del');
        if (delEl && view.dom.contains(delEl)) {
          setDelPopup({
            el: delEl,
            rect: delEl.getBoundingClientRect(),
          });
          return true; // Suppress PM's default caret placement
        }
        // Click elsewhere → dismiss any open popup
        setDelPopup(null);
        return false;
      },
      handlePaste(view, event) {
        // Issue #99 — strip ALL clipboard formatting and insert plain text only,
        // mirroring legacy EditableBlock's onPaste behavior. PM's default paste
        // pipeline parses text/html via the schema's parseDOM rules; with `<b>`
        // mapped to `bold`, generic rich-text from Word/web survives as marks
        // unless we intercept here. We deliberately ignore the parsed `slice`
        // argument and the text/html clipboard variant — SpecsIntact specs
        // never carry ad-hoc inline formatting beyond schema-recognized marks,
        // so plaintext-only paste is the safe default.
        //
        // Returning true tells PM "I handled it" so PM does not also process
        // the event. preventDefault is explicit defense against any default
        // browser paste behavior on the contentEditable surface.
        //
        // TC mode interaction: the dispatched insertText transaction passes
        // through dispatchTransaction and triggers rewriteForTrackChanges when
        // TC is on, so pasted text correctly enters as a tracked addition
        // without additional wiring here.
        event.preventDefault();
        const text = sanitizePasteText(event.clipboardData?.getData('text/plain') ?? '');
        if (text) view.dispatch(view.state.tr.insertText(text));
        return true;
      },
      handleDOMEvents: {
        focus: () => {
          onFocus?.(block.id);
          return false;
        },
        // Blur flush. 1h Q33 (#47): per-keystroke marking in
        // dispatchTransaction is now the source of truth for inline TC
        // marks, so the legacy snapshot-diff annotation that used to run
        // here (annotateDomWithDiff) is removed — it would strip the
        // edit-time marks and re-derive them from a coarse visible-text
        // diff, losing per-author attribution and overwriting marks from
        // peers concurrent with the blur. The blur handler now only
        // flushes the debounced onUpdate so React state catches up
        // synchronously when the user leaves the block.
        blur: () => {
          const view = viewRef.current;
          if (!view) return false;
          if (onUpdateDebounceRef.current) {
            clearTimeout(onUpdateDebounceRef.current);
            onUpdateDebounceRef.current = null;
          }
          let html;
          try { html = pmFragmentToHtml(view.state.doc); }
          catch { return false; }
          onUpdateRef.current?.(block.id, html);
          return false;
        },
      },
      dispatchTransaction(tr) {
        // PM calls this as a method of the EditorView (`prop.call(this, tr)`
        // in EditorView.prototype.dispatch), so `this` is the view —
        // available even during construction when `ySyncPlugin` fires its
        // initial-sync transaction from the plugin's `view()` hook. Using
        // the outer `const view` here would TDZ: that binding isn't
        // assigned until `new EditorView(...)` returns, but PM's plugin
        // activation runs *inside* the constructor and can dispatch
        // before that assignment completes.
        //
        // 1h Q33 (#47) marking pipeline: when Track Changes is on AND the
        // transaction is a local user op (not remote ySyncPlugin op, not
        // a UndoManager inverse, not a comment-reconcile, not the linter's
        // input-event synth), rewrite the user's literal edits into TC-
        // marked operations. The rewrite is pure — see pm-tc-mark.js —
        // and returns null when no rewrite is needed (selection-only,
        // attr-only). Self-cancel: deleting one's OWN un-accepted
        // revisionAdd actually removes the text (no <ins><del> wrapper).
        const ySyncMeta = tr.getMeta(ySyncPluginKey);
        const isRemote = ySyncMeta != null;
        const isUndoRedo = ySyncMeta && ySyncMeta.isUndoRedoOperation === true;
        const isReconcile = tr.getMeta(COMMENT_RECONCILE_META) === true;
        // TC_RESOLVE_META (#96): producers of TC-resolution transactions
        // (pm-del-popup.js dispatchDelAction) tag their tr so the rewriter
        // does not hijack the literal delete/removeMark step. The synthesized
        // 'input' event and onUpdate debounce below still fire — the doc
        // genuinely changed, the linter and React state need to see it.
        const isTcResolve = tr.getMeta(TC_RESOLVE_META) === true;
        let appliedTr = tr;
        if (
          trackChangesRef.current
          && !isRemote
          && !isUndoRedo
          && !isReconcile
          && !isTcResolve
          && tr.docChanged
        ) {
          const rewritten = rewriteForTrackChanges(
            this.state,
            tr,
            identityRef.current || { id: null, color: null },
          );
          if (rewritten) appliedTr = rewritten;
        }
        const newState = this.state.apply(appliedTr);
        this.updateState(newState);

        // Slash state mirroring: pull from the plugin and project to React.
        const slash = slashMenuPluginKey.getState(newState);
        if (slash && (
          slash.open !== slashStateRef.current.open ||
          slash.filter !== slashStateRef.current.filter ||
          slash.fromPos !== slashStateRef.current.fromPos
        )) {
          setSlashState((prev) => ({
            open: slash.open,
            filter: slash.filter,
            fromPos: slash.fromPos,
            selectedIdx: slash.open ? prev.selectedIdx : 0,
          }));
        }

        if (tr.docChanged) {
          // Q27 re-lint trigger: synthesize an 'input' event so
          // useBlockLinting's debounce fires. PM doesn't dispatch input
          // events natively on transactions. Fire on every doc change
          // (local + remote) so a peer's edit triggers a re-lint pass.
          // Skipped for reconcile (mark-attr-only changes don't affect
          // text — linter has nothing new to find).
          if (!isReconcile && this.dom) {
            try {
              this.dom.dispatchEvent(new Event('input', { bubbles: true }));
            } catch { /* SSR / jsdom safety */ }
          }
          // hasInlineRevisions recompute (gutter buttons). Cheap; always run.
          setHasInlineRevisions(docHasInlineRevisions(newState.doc));

          // QC critical-1: only the *local* user's edits should round-trip
          // through onUpdate → setBlockHtml ('local-publish' origin →
          // UndoManager). Remote ySyncPlugin-applied transactions carry
          // ySyncPluginKey on the transaction meta; without this gate, a
          // remote peer's keystroke would (a) re-publish their content as
          // a local edit, clobbering any concurrent edits in the 400ms
          // debounce window, and (b) enter the Yjs UndoManager via the
          // back-channel, violating the "PM-driven keystroke does NOT
          // enter the UndoManager" invariant in CLAUDE.md.
          //
          // Reconcile-tagged transactions are also skipped: setBlockHtml
          // ('local-publish') on the post-reconcile html would produce an
          // echo Yjs op that enters the UndoManager.
          //
          // The synthesized 'input' event above must still fire for remote
          // ops so the linter re-runs against peer edits.
          if (!isRemote && !isReconcile) {
            // Push html back to App's React state so block.html stays in
            // sync with the substrate. Debounced for the same reason the
            // legacy binder debounces (avoid every-keystroke setBlocks).
            if (onUpdateDebounceRef.current) clearTimeout(onUpdateDebounceRef.current);
            onUpdateDebounceRef.current = setTimeout(() => {
              onUpdateDebounceRef.current = null;
              const html = pmFragmentToHtml(newState.doc);
              onUpdateRef.current?.(block.id, html);
            }, 400);
          }
        }
      },
    });

    viewRef.current = view;
    setHasInlineRevisions(docHasInlineRevisions(view.state.doc));
    // Notify dependent effects (linting input-listener wiring) that the
    // EditorView's DOM is now available. Without this tick, useBlockLinting's
    // initial run with `getEl()` returning null would never re-bind when the
    // view mounts later — silently breaking linting in collab rooms where
    // yStore is null until first sync.
    setViewMountTick((t) => t + 1);
    return () => {
      if (onUpdateDebounceRef.current) {
        clearTimeout(onUpdateDebounceRef.current);
        onUpdateDebounceRef.current = null;
      }
      view.destroy();
      viewRef.current = null;
      yXmlFragmentRef.current = null;
    };
    // We deliberately rebuild the EditorView only when the binding identity
    // changes (block.id, yStore reference, yMap identity from subscribeBlock,
    // or editable flips). showTags / tailorKey / etc. are pushed in via
    // dispatched metas below. yMapBound is the load-bearing dep for the new-
    // block mount race — when the slot first appears or its identity flips
    // (1d migration broker), we re-mount the EditorView against the new shape.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [block.id, yStore, editable, yMapBound, isMigrationPartial]);

  // ── Auto-focus on first mount when block.isNew ───────────────────────────
  // 1f.7 (#47) — mirrors EditableBlock.jsx:172-210 (`needsFocus` path). Block
  // creation flows (handleEnterKey, slash-convert, paragraph-from-list-exit)
  // set `isNew: true` on the new block and rely on the editor mount placing
  // the caret. Legacy did this via the ref callback + Range API; PM owns its
  // own selection, so we view.focus() and dispatch Selection.atEnd. Gated by
  // a ref so a later yMapBound flip (1d migration broker) doesn't re-steal
  // focus on a non-new block whose `isNew` was never explicitly cleared.
  const hasAutoFocusedRef = useRef(false);
  useEffect(() => {
    if (!block.isNew || hasAutoFocusedRef.current) return;
    const view = viewRef.current;
    if (!view) return;
    hasAutoFocusedRef.current = true;
    view.focus();
    const sel = selectionAtEnd(view.state);
    if (sel) view.dispatch(view.state.tr.setSelection(sel));
  }, [block.id, block.isNew, viewMountTick]);

  // ── Dismiss del popup on scroll ──────────────────────────────────────────
  useEffect(() => {
    if (!delPopup) return;
    const dismiss = () => setDelPopup(null);
    window.addEventListener('scroll', dismiss, true);
    return () => window.removeEventListener('scroll', dismiss, true);
  }, [delPopup]);

  // ── Tag visibility flip ──────────────────────────────────────────────────
  useEffect(() => {
    if (viewRef.current) setTagsVisible(viewRef.current, showTags);
  }, [showTags]);

  // ── Imperative handle: register with the App-scoped registry ─────────────
  useEffect(() => {
    const handle = {
      focus: ({ atEnd = true } = {}) => {
        const view = viewRef.current;
        if (!view) return;
        view.focus();
        const tr = view.state.tr;
        const sel = atEnd
          ? selectionAtEnd(view.state)
          : selectionAtStart(view.state);
        if (sel) view.dispatch(tr.setSelection(sel));
      },
      getDom: () => containerRef.current,
      getEditable: () => viewRef.current?.dom || null,
      getPlainText: () => {
        const view = viewRef.current;
        if (!view) return '';
        return view.state.doc.textBetween(0, view.state.doc.content.size, '\n', '');
      },
      setHtml: () => {
        // For the PM path, App's setHtml routing is funneled through the
        // substrate (block-html-store.setBlockHtml) which the substrate
        // adapter rewires through prosemirrorToYXmlFragment. The view
        // re-renders via ySyncPlugin's observe → no manual innerHTML.
        // Implementation: the App callsite already calls setBlockHtml
        // post-1d; this stub is a no-op so the legacy querySelector path's
        // dataset.init removal is benign.
      },
      getView: () => viewRef.current,
      flushPendingUpdate: () => {
        // 1f.9 — close the 400ms debounce window after a toolbar dispatch
        // so App's blocks array reflects the substrate synchronously.
        //
        // Cancels the pending debounce, then calls onUpdate with the current
        // doc html. `onUpdate` is App's handleBlockUpdate which writes both
        // setBlocks AND setBlockHtml('local-publish'); the latter is a no-op
        // delta because ySyncPlugin already wrote the substrate during the
        // toolbar's view.dispatch — so no extra Yjs UndoManager frame is
        // produced and no double-write reaches peers.
        //
        // Same shape as the blur handler post-1h: both call onUpdate with the
        // current pmFragmentToHtml output. TC inline-mark materialization
        // happens at edit time in dispatchTransaction (1h Q33), so neither
        // seam needs a separate annotation pass anymore.
        if (onUpdateDebounceRef.current) {
          clearTimeout(onUpdateDebounceRef.current);
          onUpdateDebounceRef.current = null;
        }
        const view = viewRef.current;
        if (!view) return;
        try {
          const html = pmFragmentToHtml(view.state.doc);
          onUpdateRef.current?.(block.id, html);
        } catch { /* substrate unavailable mid-tear-down */ }
      },
      cancelPendingUpdate: () => {
        // 1f.9 — clear the onUpdate debounce WITHOUT firing it. Used by
        // the inline TC accept/reject path which owns its own setBlocks
        // via onRefreshTcSnapshot. Without this, a debounce scheduled by
        // the toolbar's view.dispatch would fire 400ms later and re-issue
        // setBlocks via handleBlockUpdate, redundantly mutating React
        // state after onRefreshTcSnapshot has already settled.
        if (onUpdateDebounceRef.current) {
          clearTimeout(onUpdateDebounceRef.current);
          onUpdateDebounceRef.current = null;
        }
      },
    };
    registerBlock(block.id, handle);
    return () => unregisterBlock(block.id);
  }, [block.id]);

  // ── Per-block comment reconcile (1g) ────────────────────────────────────
  // Dispatches a PM tr that synchronizes the block's `comment` marks with the
  // canonical commentsState. Verb returns null when no work is needed, so the
  // effect is cheap for blocks without comments and idempotent for blocks
  // where the substrate already agrees with state.
  //
  // The dispatched tr is tagged with COMMENT_RECONCILE_META; dispatchTransaction
  // skips both the synthesized 'input' event (no linter re-run) and the onUpdate
  // debounce (no setBlockHtml echo via 'local-publish').
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const tr = reconcileCommentMarks(view.state, commentsStateRef.current);
    if (tr) view.dispatch(tr);
  }, [commentsState]);

  // ── Inline linting (delegated to useBlockLinting hook) ───────────────────
  const getEl = useCallback(() => viewRef.current?.dom || null, []);
  const applyTagLabelsAfterFix = useCallback(() => {
    // No-op for PM — tag labels are decorations, recomputed automatically
    // when the doc changes (the linter's fix dispatches a doc-changing
    // transaction through setBlockHtml, which the binder turns into a
    // ySyncPlugin op, which the tag-labels plugin observes).
  }, []);
  const {
    severity: lintSeverity,
    tooltipFinding,
    dismissTooltip,
    applyFix: handleInlineFix,
    addToDictionary: handleAddToDictionary,
  } = useBlockLinting({
    getEl,
    blockId: block.id,
    blockType: block.type,
    editable,
    lintingState,
    dispatch: lintingDispatch,
    onFix: onInlineFix,
    applyTagLabels: applyTagLabelsAfterFix,
    elVersion: viewMountTick,
  });

  const lintingActive = lintingState ? (lintingState.enabled && !lintingState.suspended) : false;
  // #140 — blockHash for the Dismiss button. Derived from lintingState so it
  // updates whenever the block's cached findings are refreshed.
  const blockHash = lintingState?.byBlock?.get(block.id)?.blockHash || null;

  // ── Filtered slash items for keyboard nav (refresh on filter change) ─────
  const slashFiltered = useMemo(() => {
    if (!slashState.open) return [];
    return SLASH_ITEMS.filter((item) => {
      if (!slashState.filter) return true;
      return item.label.toLowerCase().startsWith(slashState.filter.toLowerCase());
    });
  }, [slashState.open, slashState.filter]);
  filteredSlashRef.current = slashFiltered;

  const handleDelAction = useCallback((action) => {
    if (!delPopup) return;
    const view = viewRef.current;
    if (!view) return;
    // Defensive: if the del was removed by a peer edit between click and
    // button press, the el reference is detached. Close popup, no-op.
    if (!delPopup.el.isConnected) {
      setDelPopup(null);
      return;
    }
    // Cancel any pending debounced onUpdate so it can't fire later with
    // pre-action html and clobber the post-action React state. This
    // mirrors FloatingToolbar's PM-mode inline TC accept/reject path
    // (cancelPendingUpdateById, 1f.9): a debounce firing AFTER
    // onRefreshTcSnapshot's setBlocks would redundantly mutate React
    // state with the same html that onRefreshTcSnapshot just wrote.
    if (onUpdateDebounceRef.current) {
      clearTimeout(onUpdateDebounceRef.current);
      onUpdateDebounceRef.current = null;
    }
    // 1h Q36 Commit C review — close the Yjs UndoManager's current
    // capture window BEFORE the PM dispatch. dispatchDelAction calls
    // view.dispatch(tr); ySyncPlugin writes a Yjs op with
    // ySyncPluginKey origin synchronously. If the user typed within
    // the prior 500ms, that op would coalesce with the typing burst
    // into one undo frame (per the captureTimeout merge behavior the
    // dual-origin-coalescing test pins). Calling forceFrame here makes
    // this accept/reject its own Ctrl+Z step. (handleBlockUpdatePmSync
    // ALSO calls forceFrame for FUTURE writes; this paired pre-dispatch
    // call closes the prior window for PAST writes.)
    const pmForceFrame = forceFrameRef.current;
    if (typeof pmForceFrame === 'function') pmForceFrame();
    // 1g.5 (#86) — dispatch a PM transaction instead of mutating
    // serialized HTML. The substrate write rides ySyncPlugin; no
    // setBlockHtml round-trip. dispatchDelAction returns null on
    // idempotent re-accept (the mark is already gone) — in that case
    // we still close the popup but don't fire onRefreshTcSnapshot.
    const tr = dispatchDelAction(view, delPopup.el, action);
    setDelPopup(null);
    if (!tr) return;
    // PM dispatch already wrote the substrate via ySyncPlugin. App owns
    // the React state + TC snapshot refresh via onRefreshTcSnapshot,
    // same path FloatingToolbar uses for its PM-mode inline TC actions
    // (1f.9). The handler (handleBlockUpdatePmSync) does NOT call
    // setBlockHtml — only forceFrame + setBlocks — because the Yjs
    // UndoManager already captured the PM dispatch above as its own
    // frame (forceFrame ran before view.dispatch).
    if (onRefreshTcSnapshotRef.current) {
      try {
        const html = pmFragmentToHtml(view.state.doc);
        onRefreshTcSnapshotRef.current(block.id, html);
      } catch { /* defensive — view tear-down race */ }
    }
  }, [delPopup, block.id]);

  const handleSlashSelectClick = useCallback((type) => {
    setSlashState({ open: false, filter: '', selectedIdx: 0, fromPos: null });
    onConvertBlockRef.current?.(block.id, type);
  }, [block.id]);

  const handleSlashClose = useCallback(() => {
    // Window-scroll dismiss path (called by SlashMenu.onClose). Same two-layer
    // close as Escape: forceClose on the plugin, then React state. Without
    // forceClose the next keystroke re-projects open=true and the popup
    // bounces back. No block deletion here — scroll is incidental motion,
    // not a user-driven exit.
    closeSlashMenuPlugin(viewRef.current);
    setSlashState({ open: false, filter: '', selectedIdx: 0, fromPos: null });
  }, []);

  const slashAnchorRect = useMemo(() => {
    if (!slashState.open) return null;
    return computeSlashAnchorRect(viewRef.current, slashState.fromPos, containerRef.current);
  }, [slashState.open, slashState.fromPos]);

  // ── Slash menu dismiss on mousedown outside the popup ────────────────────
  // Two exit paths handled here:
  //
  //   (a) mousedown lands inside the block's PM editor DOM. User wants to
  //       resume typing in the block as a paragraph. Close the menu and
  //       convert the block to txt — onConvertBlock allocates a new id +
  //       html='' + isNew=true, which remounts the EditorView, clears the
  //       slash trigger text, and auto-focuses the fresh empty paragraph.
  //
  //   (b) mousedown lands anywhere else (other blocks, toolbar, sidebar).
  //       User abandoned the menu. Close it; if the block is empty modulo
  //       the slash trigger, delete it (user-requested cleanup of the
  //       just-created scratch block). Otherwise leave the block alone.
  //
  // Skipped when the click lands inside the menu portal itself — the menu's
  // own onMouseDown handles item selection there. Capture phase so we win
  // against PM's own click handlers; mousedown (not click) so we exit
  // before drag-selection or caret placement starts.
  useEffect(() => {
    if (!slashState.open) return undefined;
    function onDocMouseDown(e) {
      const target = e.target;
      if (!(target instanceof Node)) return;
      const listbox = document.getElementById('sim-slash-listbox');
      if (listbox && listbox.contains(target)) return; // click on the menu
      const view = viewRef.current;
      const editorDom = view?.dom;
      if (editorDom && editorDom.contains(target)) {
        // (a) Click inside this block — close menu + convert to fresh paragraph.
        closeSlashMenuPlugin(view);
        setSlashState({ open: false, filter: '', selectedIdx: 0, fromPos: null });
        onConvertBlockRef.current?.(block.id, 'txt');
        return;
      }
      // (b) Click outside — close menu, delete block if it's only the trigger.
      const shouldDelete = isBlockJustSlashTrigger(view);
      closeSlashMenuPlugin(view);
      setSlashState({ open: false, filter: '', selectedIdx: 0, fromPos: null });
      if (shouldDelete) onDeleteRef.current?.(block.id);
    }
    document.addEventListener('mousedown', onDocMouseDown, true);
    return () => document.removeEventListener('mousedown', onDocMouseDown, true);
  }, [slashState.open, block.id]);

  // ── Combobox ARIA: wire PM editor DOM so screen readers announce active items ──
  // The listbox (SlashMenu portal) never receives focus; instead the PM editor's
  // contentEditable DOM gets role=combobox + aria-controls/aria-activedescendant
  // so AT announces item changes via the combobox pattern.
  useEffect(() => {
    const dom = viewRef.current?.dom;
    if (!dom) return undefined;
    if (slashState.open) {
      dom.setAttribute('role', 'combobox');
      dom.setAttribute('aria-haspopup', 'listbox');
      dom.setAttribute('aria-expanded', 'true');
      dom.setAttribute('aria-controls', 'sim-slash-listbox');
      dom.setAttribute('aria-activedescendant', `sim-slash-item-${slashState.selectedIdx}`);
    } else {
      dom.removeAttribute('role');
      dom.removeAttribute('aria-haspopup');
      dom.removeAttribute('aria-expanded');
      dom.removeAttribute('aria-controls');
      dom.removeAttribute('aria-activedescendant');
    }
    return () => {
      dom.removeAttribute('role');
      dom.removeAttribute('aria-haspopup');
      dom.removeAttribute('aria-expanded');
      dom.removeAttribute('aria-controls');
      dom.removeAttribute('aria-activedescendant');
    };
  }, [slashState.open, slashState.selectedIdx]);

  // ── Layout (mirrors EditableBlock.jsx) ───────────────────────────────────
  const isNote = block.type === 'note';
  const isTxt = block.type === 'txt';
  const isOli = block.type === 'oli';
  const isItem = block.type === 'item';
  const isLst = block.type === 'lst';
  const MARGINS = BLOCK_MARGINS;
  const OLI_LEVEL_STEP = 24;
  let leftMargin = MARGINS[block.type] || 15;
  if (isOli) {
    const lvl = Math.max(1, Math.min(block.level || 1, 4));
    leftMargin = MARGINS.oli + (lvl - 1) * OLI_LEVEL_STEP;
  }

  const baseStyle = {
    padding: isTxt ? '6px 12px' : isNote ? '6px 12px' : '4px 12px',
    marginLeft: leftMargin,
    marginBottom: 2,
    outline: 'none',
    borderRadius: 3,
    minHeight: 24,
    transition: 'background 0.15s ease',
  };
  if (isNote) {
    Object.assign(baseStyle, {
      borderLeft: '3px solid #f59e0b',
      backgroundColor: '#fffbeb',
      color: '#92400e',
      fontStyle: 'normal',
      marginBottom: 4,
      marginRight: 85,
      padding: '6px 12px 6px 14px',
    });
  } else if (isLst) {
    Object.assign(baseStyle, { fontWeight: 600, marginTop: 8, paddingLeft: 0 });
  } else if (isItem) {
    Object.assign(baseStyle, { paddingLeft: 20, position: 'relative' });
  } else if (isOli) {
    Object.assign(baseStyle, { paddingLeft: 28 });
  } else {
    Object.assign(baseStyle, { backgroundColor: isFocused ? '#fafaf7' : 'transparent' });
  }

  const revisionClass = `${block.revision ? `block-revision-${block.revision}` : ''} ${isNote ? 'block-type-note' : ''}`.trim();
  const sgmlTag = { txt: 'TXT', note: 'NTE', oli: 'OLI', item: 'ITM', lst: 'LST' }[block.type] || 'TXT';

  // 1i-b.1 — user-facing fallback for migrationPartial blocks. The mount
  // effect bails before constructing EditorView for this shape, so the
  // banner is the only thing the user sees for this block until the
  // operator re-runs conversion. role="alert" surfaces to assistive tech.
  if (isMigrationPartial) {
    return (
      <div
        data-block-id={block.id}
        id={`block-${block.id}`}
        className="migration-partial-banner"
        role="alert"
      >
        <span className="banner-icon" aria-hidden="true">&#9888;</span>
        <span className="banner-text">
          This block needs re-migration. The room is partially migrated;
          contact your operator to re-run conversion.
        </span>
      </div>
    );
  }

  return (
    <div id={`block-${block.id}`} style={{ position: 'relative' }} className={revisionClass} data-tag={sgmlTag}>
      {(block.revision || hasInlineRevisions) && onAcceptRevision && (
        <div style={{
          position: 'absolute', left: -4, top: 4, display: 'flex',
          flexDirection: 'column', gap: 2, zIndex: 10,
        }}>
          <button
            onClick={() => onAcceptRevision(block.id)}
            title={block.revision ? `Accept ${block.revision}` : 'Accept inline changes'}
            style={gutterBtn('#008000', '#f0fdf4')}
          >✓</button>
          <button
            onClick={() => onRejectRevision(block.id)}
            title={block.revision ? `Reject ${block.revision}` : 'Reject inline changes'}
            style={gutterBtn('#ff4444', '#fef2f2')}
          >✗</button>
        </div>
      )}
      {isItem && (
        <span style={{
          position: 'absolute', left: MARGINS.item + 4, top: 6,
          color: '#94a3b8', fontSize: 10, userSelect: 'none',
        }}>&#9679;</span>
      )}
      {isOli && oliLabel && (
        <span style={{
          position: 'absolute', left: leftMargin - 4, top: 4, height: '1.5em',
          display: 'flex', alignItems: 'flex-end', justifyContent: 'flex-end',
          color: '#475569', fontSize: 15, lineHeight: 1, fontWeight: 500,
          userSelect: 'none', width: 28,
        }}>{oliLabel}</span>
      )}
      {lintSeverity && lintingActive && (
        <span
          title={`${lintSeverity} severity finding`}
          style={{
            position: 'absolute', left: 2, top: 8, width: 6, height: 6,
            borderRadius: '50%',
            backgroundColor: lintSeverity === 'high' ? '#ef4444'
              : lintSeverity === 'medium' ? '#f59e0b' : '#3b82f6',
            pointerEvents: 'none',
          }}
        />
      )}
      <div
        ref={containerRef}
        style={{
          ...baseStyle,
          cursor: editable ? 'text' : readOnly ? 'not-allowed' : 'default',
          opacity: readOnly ? 0.8 : 1,
          border: isFocused && editable ? '1px solid #cbd5e1' : '1px solid transparent',
          boxShadow: isFocused && editable ? '0 0 0 2px rgba(99,132,168,0.15)' : 'none',
        }}
      />
      {delPopup && (
        <div style={{
          position: 'fixed',
          top: delPopup.rect.top - 34,
          left: delPopup.rect.left + delPopup.rect.width / 2,
          transform: 'translateX(-50%)',
          display: 'flex',
          gap: 2,
          padding: '3px 6px',
          backgroundColor: '#1e293b',
          borderRadius: 6,
          boxShadow: '0 4px 12px rgba(0,0,0,0.25)',
          zIndex: 100,
        }}>
          <button
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => handleDelAction('accept')}
            title="Accept deletion (remove text)"
            style={{
              width: 22, height: 22, border: 'none', borderRadius: 3,
              backgroundColor: 'transparent', color: '#4ade80',
              fontSize: 13, cursor: 'pointer', display: 'flex',
              alignItems: 'center', justifyContent: 'center', padding: 0,
            }}
          >✓</button>
          <button
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => handleDelAction('reject')}
            title="Reject deletion (restore text)"
            style={{
              width: 22, height: 22, border: 'none', borderRadius: 3,
              backgroundColor: 'transparent', color: '#f87171',
              fontSize: 13, cursor: 'pointer', display: 'flex',
              alignItems: 'center', justifyContent: 'center', padding: 0,
            }}
          >✗</button>
        </div>
      )}
      {tooltipFinding && editable && (
        <InlineTooltip
          finding={tooltipFinding}
          blockId={block.id}
          onFix={handleInlineFix}
          onDismiss={dismissTooltip}
          onAddToDictionary={handleAddToDictionary}
          blockEl={viewRef.current?.dom}
          onSuppress={onSuppress}
          blockHash={blockHash}
          onMuteNlpRule={onMuteNlpRule}
        />
      )}
      {slashState.open && editable && slashAnchorRect && (
        <SlashMenu
          filter={slashState.filter}
          selectedIdx={slashState.selectedIdx}
          onSelect={handleSlashSelectClick}
          onClose={handleSlashClose}
          onHoverChange={(idx) => setSlashState((s) => ({ ...s, selectedIdx: idx }))}
          anchorRect={slashAnchorRect}
        />
      )}
    </div>
  );
}

function computeSlashAnchorRect(view, fromPos, fallbackEl) {
  if (view && typeof fromPos === 'number') {
    try {
      const coords = view.coordsAtPos(fromPos);
      return { top: coords.top, bottom: coords.bottom, left: coords.left, right: coords.right };
    } catch {
      // PM view may not be in a consistent state — fall through to DOM bounds.
    }
  }
  if (fallbackEl) {
    const r = fallbackEl.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
  }
  return null;
}

function gutterBtn(color, bg) {
  return {
    width: 18, height: 18, border: `1px solid ${color}40`, borderRadius: 3,
    backgroundColor: bg, color, fontSize: 11, cursor: 'pointer',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    padding: 0, lineHeight: 1,
  };
}

function isViewEmpty(view) {
  if (!view) return true;
  const text = view.state.doc.textBetween(0, view.state.doc.content.size, '\n', '');
  return text.trim().length === 0;
}

function selectionAtEnd(state) {
  return Selection.atEnd(state.doc);
}

function selectionAtStart(state) {
  return Selection.atStart(state.doc);
}

export default PmEditableBlock;

// Tag-label visibility for tests / dev to inspect.
export { NO_EXFIL_PM_ATTRS };
