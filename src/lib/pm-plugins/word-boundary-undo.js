/**
 * word-boundary-undo plugin — sub-PR 1h Q36 Commit A.
 *
 * Fires a supplied `stopCapturing` callback on space, common punctuation,
 * and Enter keydowns. Once Commit B adds `ySyncPluginKey` to the Yjs
 * UndoManager's trackedOrigins, this makes a typing burst like
 * "hello world." produce three undo frames (one per word), matching the
 * Word/Notion convention.
 *
 * In Commit A the plugin is wired into PmEditableBlock but
 * `ySyncPluginKey` is NOT yet tracked, so the callback's effect (ending
 * the current capture window) is observable only on the not-yet-tracked
 * stream of PM ops. The plugin is functionally dead until Commit B —
 * the tests pin its behavior so Commit B lands on a stable foundation.
 *
 * Ordering invariant (adversarial Q4 finding):
 *   stopCapturing MUST fire BEFORE PM's default insertText so the space
 *   op enters the NEW frame, not the previous one. `handleKeyDown` runs
 *   synchronously on the keydown event, before the browser's
 *   beforeinput → insertText chain. Using `appendTransaction` would fire
 *   AFTER the Yjs commit, putting the space in the WRONG frame.
 *
 * The plugin is observational — handleKeyDown returns false so PM's
 * default key handling proceeds (the space character still gets inserted).
 */

import { Plugin } from 'prosemirror-state';

// Word-boundary keys. Matches the legacy stopCapturing rule the Q36 plan
// pinned: space + sentence/clause punctuation + Enter (hardest boundary).
// Not included:
//   - Backspace/Delete: continue the current edit, don't start a new one.
//   - Arrow keys / nav: not edits.
//   - Tab: structural action (OLI level change) — produces its own
//     coarse undo frame via handleChangeOliLevel's forceFrame call site.
//   - Quotes / brackets: ambiguous; let coalesce until adversarial evidence.
const BOUNDARY_KEYS = new Set([
  ' ', '.', ',', ';', ':', '!', '?', 'Enter',
]);

/**
 * @param {Object} opts
 * @param {() => (() => void) | null | undefined} opts.getStopCapturing
 *   Returns the UndoManager's stopCapturing function (or null if no
 *   UndoManager is wired yet). Called per keydown so a session
 *   create/destroy cycle picks up the latest reference without
 *   rebuilding the plugin.
 */
export function wordBoundaryUndoPlugin({ getStopCapturing }) {
  return new Plugin({
    props: {
      handleKeyDown(_view, event) {
        if (!BOUNDARY_KEYS.has(event.key)) return false;
        try {
          const stop = getStopCapturing?.();
          if (typeof stop === 'function') stop();
        } catch {
          // Defensive: never let a stopCapturing failure consume the
          // user's keystroke. The PM event flow continues regardless.
        }
        return false;
      },
    },
  });
}
