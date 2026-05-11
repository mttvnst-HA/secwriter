/**
 * PmEditableBlock — y-prosemirror-backed editable block.
 *
 * Sub-PR 1e (#47, ADR-0006). Mounts a PM EditorView per block, bound via
 * `ySyncPlugin` to the block's Y.XmlFragment in the substrate. Replaces the
 * legacy `EditableBlock`'s contentEditable + binder snapshot-write path
 * when `VITE_PM_EDITOR=true`.
 *
 * Surface parity with `EditableBlock` (same props, same behavior to App):
 *   - block, yStore, onUpdate, onEnterKey, isFocused, onFocus
 *   - oliLabel, onDelete, onFocusPrev, onFocusNext
 *   - onConvertBlock, onChangeOliLevel
 *   - resolveHtml, tailorKey
 *   - trackChanges, snapshotText, identity
 *   - onAcceptRevision, onRejectRevision, onRevisionAction
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
 *      `ySyncPluginKey` Y origin is what every PM-driven write carries —
 *      the Yjs UndoManager (configured in `src/lib/collab.js` to track
 *      `'local-publish'`) does NOT pick up these ops. App-level undo flows
 *      through `useUndoableBlocks` snapshots; this is preserved per Q16/Q32.
 *   3. NO_EXFIL_PROPS goes through `EditorProps.attributes` with lowercase
 *      HTML attribute names (Q31/E2). React's camelCase props don't reach
 *      PM's DOM root because PM owns its DOM.
 *   4. Tag visibility is a PM plugin emitting widget decorations, not
 *      contentEditable=false DOM injection (Q4). Pseudo-elements don't
 *      create caret positions; widgets do.
 *   5. Slash detection is a PM plugin watching transactions (Q5); the
 *      popup is the existing React `SlashMenu.jsx`.
 *   6. Re-lint trigger is `dispatchTransaction` (Q27) — fires for both
 *      local and remote ops. The legacy `useBlockLinting` hook expects an
 *      'input' event; we synthesize a fake one on doc-changing transactions
 *      so the existing debounce stays untouched.
 *
 * What's deliberately NOT in this file:
 *   - The legacy `setRef` / ZWS focus glue (Q4). PM owns the cursor model.
 *   - The handleInput debounce (Q22 substrate writes are sync via ySync).
 *   - `syncTagLabels` / `stripTagLabels` DOM mutation (decorations now).
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
import { tagLabelsPlugin, setTagsVisible } from '../lib/pm-plugins/tag-labels.js';
import { blockKeymap } from '../lib/pm-plugins/keymap.js';
import { registerBlock, unregisterBlock } from '../lib/block-registry.js';
import { setBlockHtml, subscribeBlock } from '../lib/block-html-store.js';
import { annotateDomWithDiff } from '../lib/text-diff.js';
import { applyDelAction } from '../lib/pm-del-popup.js';
import { useBlockLinting } from './useBlockLinting.js';

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
  snapshotText,
  identity,
  onAcceptRevision,
  onRejectRevision,
  onRevisionAction,
  comments,     // eslint-disable-line no-unused-vars  -- comments rendered via marks (1g)
  onCommentClick,
  onInlineFix,
  lintingState,
  lintingDispatch,
  showTags = false,
  readOnly = false,
}) {
  const containerRef = useRef(null);
  const viewRef = useRef(null);
  const yXmlFragmentRef = useRef(null);
  const onUpdateDebounceRef = useRef(null);
  const [slashState, setSlashState] = useState({ open: false, filter: '', selectedIdx: 0 });
  const [hasInlineRevisions, setHasInlineRevisions] = useState(false);
  const [delPopup, setDelPopup] = useState(null); // { el, rect, delIndex } | null
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
  const onRevisionActionRef = useRef(onRevisionAction);
  onRevisionActionRef.current = onRevisionAction;
  const blockTypeRef = useRef(block.type);
  blockTypeRef.current = block.type;
  // QC major-6: Track Changes inputs mirrored into refs so the blur handler
  // (registered on the EditorView at mount time) reads the latest values
  // without rebuilding the view. snapshotText changes on every TC enable /
  // accept-all and identity may change on auth refresh.
  const trackChangesRef = useRef(trackChanges);
  trackChangesRef.current = trackChanges;
  const snapshotTextRef = useRef(snapshotText);
  snapshotTextRef.current = snapshotText;
  const identityRef = useRef(identity);
  identityRef.current = identity;
  const yStoreRef = useRef(yStore);
  yStoreRef.current = yStore;
  const slashStateRef = useRef(slashState);
  slashStateRef.current = slashState;
  const filteredSlashRef = useRef([]);

  const editable = useMemo(() => {
    const t = block.type;
    const typeEditable = t === 'txt' || t === 'note' || t === 'oli' || t === 'item' || t === 'lst' || block.isNew;
    return typeEditable && !readOnly;
  }, [block.type, block.isNew, readOnly]);

  // Subscribe to yStore for THIS block's slot existence + identity. The
  // mount effect below depends on `yStore.get(block.id)` being present, but
  // React fires child effects before parent effects in the commit phase —
  // so a freshly-created block (Enter / slash-convert) reaches PmEditableBlock's
  // mount BEFORE App's seeding effect (`applyBlocksToYDoc` in App.jsx ~line 287
  // for out-of-room, or useCollabSession's publish effect for in-room) has run.
  // Without this subscription the mount effect bails on missing yMap and never
  // re-fires, leaving the new block with no EditorView. subscribeBlock from
  // block-html-store.js fires when (a) the slot first appears, (b) the slot's
  // html shape changes (1d migration broker swap), or (c) the slot is removed —
  // exactly the events that gate the EditorView lifecycle. The snapshot is the
  // yMap reference itself (or null) so React re-renders when it flips, and the
  // mount effect's dep list catches both "slot appeared" and "slot identity
  // changed" with no extra wiring.
  const yMapBound = useSyncExternalStore(
    useCallback(
      (notify) => (yStore ? subscribeBlock(yStore, block.id, notify) : () => {}),
      [yStore, block.id],
    ),
    useCallback(
      () => (yStore ? (yStore.get(block.id) || null) : null),
      [yStore, block.id],
    ),
    () => null, // SSR — no Y substrate
  );

  // ── Mount: create EditorView wired to the block's Y.XmlFragment ─────────
  useEffect(() => {
    if (!containerRef.current) return;
    if (!editable) return;
    if (!yStore) return;
    if (!yMapBound) return;

    const yMap = yMapBound;
    const yXml = yMap.get('html');
    // Only the PM-substrate path mounts EditorView. Legacy Y.Text slots
    // (migrationPartial leftover) fall through to the legacy editor; this
    // component is rendered only when the flag + substrate combine.
    if (!yXml || typeof yXml.toArray !== 'function' || typeof yXml.nodeName === 'string') {
      return;
    }
    yXmlFragmentRef.current = yXml;

    const handleSlashSelect = (type) => {
      setSlashState({ open: false, filter: '', selectedIdx: 0 });
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
        setSlashState({ open: false, filter: '', selectedIdx: 0 });
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
          const allDels = Array.from(view.dom.querySelectorAll('del.mark-del'));
          const delIndex = allDels.indexOf(delEl);
          if (delIndex >= 0) {
            setDelPopup({
              el: delEl,
              rect: delEl.getBoundingClientRect(),
              delIndex,
            });
            return true; // Suppress PM's default caret placement
          }
        }
        // Click elsewhere → dismiss any open popup
        setDelPopup(null);
        return false;
      },
      handleDOMEvents: {
        focus: () => {
          onFocus?.(block.id);
          return false;
        },
        // QC major-6: TC inline-mark materialization on blur. The legacy
        // EditableBlock ran annotateDomWithDiff on the contentEditable in
        // place, then pushed the annotated html through the binder. PM
        // owns its inner DOM, so we annotate a detached div with the
        // serialized PM html instead, then route the annotated html
        // through setBlockHtml — y-prosemirror's diff-and-merge re-renders
        // the view with the schema's `revision` mark intact (parseDOM
        // rules at pm-schema.js:147-148 turn `<ins class="mark-add">` /
        // `<del class="mark-del">` back into PM marks).
        //
        // We also flush any pending debounced onUpdate so the post-blur
        // annotated html (not a stale pre-blur snapshot) is what reaches
        // App's React state.
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
          let finalHtml = html;
          if (trackChangesRef.current && snapshotTextRef.current != null) {
            try {
              const div = document.createElement('div');
              div.innerHTML = html;
              const annotated = annotateDomWithDiff(div, snapshotTextRef.current, identityRef.current || null);
              if (annotated) finalHtml = div.innerHTML;
            } catch {
              // Annotation throws → keep the un-annotated html. Better to
              // lose revision marks than corrupt the block.
            }
          }
          // Substrate write — ySyncPlugin re-renders the view with the
          // (possibly annotated) html. Skipped if yStore unset (no collab,
          // or pre-sync) — onUpdate below still pushes to React state.
          if (yStoreRef.current) {
            try { setBlockHtml(yStoreRef.current, block.id, finalHtml); }
            catch { /* substrate unavailable mid-tear-down */ }
          }
          onUpdateRef.current?.(block.id, finalHtml);
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
        const newState = this.state.apply(tr);
        this.updateState(newState);

        // Slash state mirroring: pull from the plugin and project to React.
        const slash = slashMenuPluginKey.getState(newState);
        if (slash && (slash.open !== slashStateRef.current.open || slash.filter !== slashStateRef.current.filter)) {
          setSlashState((prev) => ({
            open: slash.open,
            filter: slash.filter,
            selectedIdx: slash.open ? prev.selectedIdx : 0,
          }));
        }

        if (tr.docChanged) {
          // Q27 re-lint trigger: synthesize an 'input' event so
          // useBlockLinting's debounce fires. PM doesn't dispatch input
          // events natively on transactions. Fire on every doc change
          // (local + remote) so a peer's edit triggers a re-lint pass.
          if (this.dom) {
            try {
              this.dom.dispatchEvent(new Event('input', { bubbles: true }));
            } catch { /* SSR / jsdom safety */ }
          }
          // hasInlineRevisions recompute (gutter buttons).
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
          // The synthesized 'input' event above must still fire for remote
          // ops so the linter re-runs against peer edits.
          const isRemote = tr.getMeta(ySyncPluginKey) != null;
          if (!isRemote) {
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
  }, [block.id, yStore, editable, yMapBound]);

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
    };
    registerBlock(block.id, handle);
    return () => unregisterBlock(block.id);
  }, [block.id]);

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
    // pre-action html and clobber the post-action React state.
    if (onUpdateDebounceRef.current) {
      clearTimeout(onUpdateDebounceRef.current);
      onUpdateDebounceRef.current = null;
    }
    let html;
    try { html = pmFragmentToHtml(view.state.doc); }
    catch { setDelPopup(null); return; }
    const newHtml = applyDelAction(html, delPopup.delIndex, action);
    // Route through onRevisionAction — App.handleRevisionAction calls
    // setBlockHtml with origin 'local-publish' (Yjs UndoManager covered),
    // updates React state (App-level useUndoableBlocks frames a snapshot),
    // and runs tc.applyResolveAtBlock(blockId, newHtml) to refresh the TC
    // snapshot so the next blur diff doesn't re-create the del.
    if (onRevisionActionRef.current) {
      onRevisionActionRef.current(block.id, newHtml);
    } else {
      onUpdateRef.current?.(block.id, newHtml);
    }
    setDelPopup(null);
  }, [delPopup, block.id]);

  const handleSlashSelectClick = useCallback((type) => {
    setSlashState({ open: false, filter: '', selectedIdx: 0 });
    onConvertBlockRef.current?.(block.id, type);
  }, [block.id]);

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
        />
      )}
      {slashState.open && editable && (
        <SlashMenu
          filter={slashState.filter}
          selectedIdx={slashState.selectedIdx}
          onSelect={handleSlashSelectClick}
          position={{ left: leftMargin + 12, top: 32 }}
        />
      )}
    </div>
  );
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

function docHasInlineRevisions(doc) {
  let found = false;
  doc.descendants((node) => {
    if (found) return false;
    if (!node.isText) return true;
    for (const m of node.marks) {
      if (m.type.name === 'revision' && (m.attrs.kind === 'add' || m.attrs.kind === 'del')) {
        found = true;
        return false;
      }
    }
    return true;
  });
  return found;
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
