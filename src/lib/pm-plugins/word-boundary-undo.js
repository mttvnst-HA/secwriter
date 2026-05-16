/**
 * word-boundary-undo plugin — sub-PR 1h Q36 Commit A.
 *
 * Fires a supplied `forceFrame` callback on space, common punctuation,
 * and Enter keydowns. Once Commit B adds `ySyncPluginKey` to the Yjs
 * UndoManager's trackedOrigins, this makes a typing burst like
 * "hello world." produce three undo frames (one per word), matching the
 * Word/Notion convention.
 *
 * In Commit A the plugin is wired into PmEditableBlock but
 * `ySyncPluginKey` is NOT yet tracked, so `forceFrame` ending the
 * current capture window has no production effect on the user's typing.
 * The plugin is functionally dead until Commit B — the tests pin its
 * behavior so Commit B lands on a stable foundation.
 *
 * Naming: `forceFrame` is the public-API name (matches `collab.forceFrame`
 * exposed by useCollabSession and the App-side plumbing). Internally
 * `forceFrame` is implemented as `undoManager.stopCapturing()` — the Yjs
 * library vocabulary stays at the boundary.
 *
 * Ordering invariant (adversarial Q4 finding):
 *   `forceFrame` MUST fire BEFORE PM's default insertText so the space
 *   op enters the NEW frame, not the previous one. `handleKeyDown` runs
 *   synchronously on the keydown event, before the browser's
 *   beforeinput → insertText chain. Using `appendTransaction` would fire
 *   AFTER the Yjs commit, putting the space in the WRONG frame.
 *
 * The plugin is observational — handleKeyDown returns false so PM's
 * default key handling proceeds (the space character still gets inserted).
 */

import { Plugin } from 'prosemirror-state';

// Word-boundary keys. Matches the rule the Q36 plan pinned: space +
// sentence/clause punctuation + Enter (hardest boundary). Pinned by
// word-boundary-undo.test.js so a future maintainer who reaches for
// this list sees both the inclusions and the deliberate exclusions.
// Not included:
//   - Backspace/Delete: continue the current edit, don't start a new one.
//   - Arrow keys / nav: not edits.
//   - Tab: structural action (OLI level change) — produces its own
//     coarse undo frame via handleChangeOliLevel's forceFrame call site.
//   - Quotes / brackets / dashes: ambiguous; let coalesce until
//     adversarial evidence pins a different rule.
const BOUNDARY_KEYS = new Set([
  ' ', '.', ',', ';', ':', '!', '?', 'Enter',
]);

/**
 * @param {Object} opts
 * @param {() => (() => void) | null | undefined} opts.getForceFrame
 *   Returns the live `forceFrame` callback (or null if no UndoManager
 *   is wired yet). Called per keydown so a session create/destroy
 *   cycle picks up the latest reference without rebuilding the plugin.
 */
export function wordBoundaryUndoPlugin({ getForceFrame }) {
  return new Plugin({
    props: {
      handleKeyDown(_view, event) {
        if (!BOUNDARY_KEYS.has(event.key)) return false;
        try {
          const forceFrame = getForceFrame?.();
          if (typeof forceFrame === 'function') forceFrame();
        } catch {
          // Defensive: never let a forceFrame failure consume the
          // user's keystroke. The PM event flow continues regardless.
        }
        return false;
      },
    },
  });
}
