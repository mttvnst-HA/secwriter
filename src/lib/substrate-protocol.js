/**
 * substrate-protocol — single source of truth for the client-side substrate
 * write/undo protocol vocabulary (architecture-review candidate #5).
 *
 * Before this module the two Yjs UndoManagers — the in-room one in
 * `createCollabSession` (`src/lib/collab.js`) and the out-of-room one in
 * `useLocalSubstrateUndoManager` (`src/hooks/useLocalSubstrateUndoManager.js`)
 * — each constructed an identical `{ trackedOrigins, captureTimeout,
 * captureTransaction }` config by hand, glued together only by a CLAUDE.md
 * warning that they "must stay in lockstep." A drift between the two (a new
 * tracked origin added to one, a captureTimeout bumped in the other) silently
 * gives in-room and out-of-room users different Ctrl+Z semantics.
 *
 * This module makes that drift structurally impossible: both managers are now
 * built by the one `createSubstrateUndoManager` factory below, so there is a
 * single definition of what the substrate UndoManager tracks and how it frames.
 *
 * Scope note: this is CLIENT-side ESM only. The server-side migration broker's
 * attr-key vocabulary (`server/migrate-pm-substrate.cjs`) cannot import from
 * this module — the ESM/CJS boundary forbids it (dual-package hazard,
 * ADR-0001 / ADR-0006). That seam stays governed by its own per-side pins.
 */

import * as Y from 'yjs';
import { ySyncPluginKey } from 'y-prosemirror';

/**
 * The Yjs transaction origin for substrate writes authored outside a PM
 * EditorView: `setBlockHtml` binder writes (TitleBlock, MarkSuggestions,
 * PmEditableBlock's debounced onUpdate echo), structural `publishBlocks` /
 * `applyBlocksToYDoc` writes, and the click-driven `*ToDoc` helpers. It is
 * `'local-'`-prefixed so `collab.js`'s `handleAfterTx` prefix filter treats it
 * as a local transaction and suppresses the echo. Scoped to the local user so
 * Ctrl+Z never reverts a remote peer's edit.
 */
export const LOCAL_PUBLISH = 'local-publish';

/**
 * The canonical origin membership both substrate UndoManagers track. Frozen so
 * it reads as a constant; the factory copies it into a fresh Set per manager
 * (Y.UndoManager's constructor does `trackedOrigins.add(this)`, mutating the
 * Set it is given — sharing one Set instance across two managers would make
 * each track the other, so every manager MUST get its own copy).
 *
 *   LOCAL_PUBLISH   — see above; the out-of-PM-view write path.
 *   ySyncPluginKey  — y-prosemirror's `ySyncPlugin` tags every PM-driven
 *                     transaction (per-keystroke substrate ops) with this Y
 *                     origin. Tracking it makes PM-mode Ctrl+Z work at
 *                     character granularity, gated by the word-boundary-undo
 *                     plugin's `forceFrame` (split frames at
 *                     space/punctuation/Enter, matching Word/Notion).
 *
 * Remote ops enter NEITHER stack: the HocuspocusProvider applies remote
 * updates with the provider INSTANCE as the Yjs origin (proven by
 * `src/lib/__tests__/hocuspocus-undo-origin.test.js`), which is not in this
 * set, and y-prosemirror guards its remote→PM path against re-emitting a
 * ySyncPluginKey write.
 */
export const TRACKED_ORIGINS = Object.freeze([LOCAL_PUBLISH, ySyncPluginKey]);

/**
 * Yjs default (500ms): adjacent same-origin ops within the window coalesce into
 * one undo frame. The word-boundary plugin calls `forceFrame`
 * (→ `undoManager.stopCapturing()`) to split typing bursts into per-word frames.
 */
export const SUBSTRATE_CAPTURE_TIMEOUT = 500;

/**
 * captureTransaction predicate: reject transactions whose `addToHistory` meta
 * is false. y-prosemirror's sync-plugin propagates the PM-side
 * `tr.setMeta('addToHistory', false)` to the resulting Yjs transaction meta
 * (sync-plugin.js:228), so a PM transaction can opt out of undo capture. The
 * comment-reconcile path uses this (see `pm-comments.js`). Mirrors
 * y-prosemirror's own UndoPlugin filter (undo-plugin.js:71).
 * @param {Y.Transaction} tr
 * @returns {boolean}
 */
export function isUndoableTransaction(tr) {
  return tr.meta.get('addToHistory') !== false;
}

/**
 * Build a Yjs UndoManager wired with the shared substrate protocol config.
 * The one construction path for both the in-room and out-of-room managers, so
 * their tracked origins / capture framing can never drift apart.
 *
 * @param {Array<Y.AbstractType<any>>} scope - the shared types to track (e.g. [yOrder, yStore]).
 * @param {{ captureTimeout?: number }} [opts]
 * @returns {Y.UndoManager}
 */
export function createSubstrateUndoManager(scope, { captureTimeout = SUBSTRATE_CAPTURE_TIMEOUT } = {}) {
  return new Y.UndoManager(scope, {
    // Fresh Set per manager — see TRACKED_ORIGINS note (constructor adds `this`).
    trackedOrigins: new Set(TRACKED_ORIGINS),
    captureTimeout,
    captureTransaction: isUndoableTransaction,
  });
}
