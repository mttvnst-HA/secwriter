/**
 * keymap.js — keymap that mirrors the legacy EditableBlock key handlers.
 *
 * Sub-PR 1e (#47, v2 plan). PM commands return true if they handled the key
 * (PM stops the event), false otherwise. The block-level concerns (create
 * new block on Enter, change OLI level on Tab, delete on Backspace-empty,
 * focus-prev/next on Arrow at boundary) are NOT PM-internal — they bubble
 * up to App via the callbacks supplied at plugin construction. The plugin
 * itself owns nothing; callbacks own the structural action.
 *
 * Slash menu: keys (ArrowUp/Down/Enter/Escape) defer to the slash menu
 * handlers when `getSlashOpen()` returns true. PmEditableBlock sets these
 * to its React handlers — symmetric with the legacy component's
 * `if (slashOpen) ...` block.
 *
 * Why `commitBeforeAction`: every legacy handler (Enter, Tab, Arrow nav)
 * called `onUpdate(block.id, html)` synchronously before invoking the
 * structural action, so the React-state html and the new block's html both
 * reflected the latest typing. PM's substrate is updated synchronously by
 * ySyncPlugin on each transaction, so a setTimeout-style flush isn't
 * needed — but the App-side React state still derives html from the
 * substrate via the binder's snapshot, which is read on render. Calling
 * `commitBeforeAction()` here is a no-op stub today; sub-PR 1g/1i may
 * tighten it once the binder's read pathway is rewired around PM.
 */

import { keymap } from 'prosemirror-keymap';
import { Selection } from 'prosemirror-state';

import { getSlashMenuState } from './slash-menu.js';

/**
 * Build the keymap plugin.
 *
 * @param {Object} cb — block-level callbacks supplied by PmEditableBlock.
 * @param {() => string} cb.getBlockId
 * @param {() => string} cb.getBlockType
 * @param {() => boolean} cb.isEmpty — block has no visible text
 * @param {() => void} cb.onEnterKey — split / new block at end
 * @param {(dir: -1|1) => void} cb.onChangeOliLevel — Tab/Shift+Tab in OLI
 * @param {() => void} cb.onDeleteEmpty — Backspace at empty
 * @param {() => void} cb.onFocusPrev
 * @param {() => void} cb.onFocusNext
 * @param {() => boolean} cb.isSlashOpen
 * @param {() => boolean} cb.onSlashArrowDown
 * @param {() => boolean} cb.onSlashArrowUp
 * @param {() => boolean} cb.onSlashEnter
 * @param {() => boolean} cb.onSlashEscape
 * @param {() => void} [cb.commitBeforeAction] — flush pending edits
 */
export function blockKeymap(cb) {
  const commit = cb.commitBeforeAction || (() => {});

  function isCursorAtStart(state) {
    const sel = state.selection;
    return sel.empty && sel.from <= firstSelectablePos(state);
  }

  function isCursorAtEnd(state) {
    const sel = state.selection;
    return sel.empty && sel.to >= lastSelectablePos(state);
  }

  return keymap({
    Enter(state, dispatch, view) {
      if (cb.isSlashOpen?.()) {
        return cb.onSlashEnter?.() ?? true;
      }
      commit();
      cb.onEnterKey?.();
      return true;
    },
    'Shift-Enter'(state, dispatch) {
      // Insert a hard_break — keep newline behavior parity (#25 br round-trip).
      const tr = state.tr.replaceSelectionWith(state.schema.nodes.hard_break.create());
      if (dispatch) dispatch(tr.scrollIntoView());
      return true;
    },
    Tab(state, dispatch, view) {
      if (cb.isSlashOpen?.()) return false;
      if (cb.getBlockType?.() === 'oli') {
        commit();
        cb.onChangeOliLevel?.(1);
        return true;
      }
      // Default: let browser handle Tab focus (parity with legacy — no Tab
      // capture for non-OLI blocks).
      return false;
    },
    'Shift-Tab'(state, dispatch, view) {
      if (cb.isSlashOpen?.()) return false;
      if (cb.getBlockType?.() === 'oli') {
        commit();
        cb.onChangeOliLevel?.(-1);
        return true;
      }
      return false;
    },
    Backspace(state) {
      if (cb.isEmpty?.()) {
        commit();
        cb.onDeleteEmpty?.();
        return true;
      }
      return false;
    },
    ArrowUp(state) {
      if (cb.isSlashOpen?.()) {
        return cb.onSlashArrowUp?.() ?? true;
      }
      if (isCursorAtStart(state)) {
        commit();
        cb.onFocusPrev?.();
        return true;
      }
      return false;
    },
    ArrowDown(state) {
      if (cb.isSlashOpen?.()) {
        return cb.onSlashArrowDown?.() ?? true;
      }
      if (isCursorAtEnd(state)) {
        commit();
        cb.onFocusNext?.();
        return true;
      }
      return false;
    },
    Escape(state, dispatch, view) {
      if (cb.isSlashOpen?.()) {
        return cb.onSlashEscape?.() ?? true;
      }
      return false;
    },
  });
}

function firstSelectablePos(state) {
  const sel = Selection.atStart(state.doc);
  return sel.from;
}

function lastSelectablePos(state) {
  const sel = Selection.atEnd(state.doc);
  return sel.to;
}

// Re-export for symmetry — PmEditableBlock can read the slash state directly.
export { getSlashMenuState };
