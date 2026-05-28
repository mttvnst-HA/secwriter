/**
 * pm-slash-dismiss.js — pure helpers used by PmEditableBlock's slash-menu
 * dismiss paths (Escape, outside-click, click-inside-block). Extracted from
 * the component so Vitest can exercise them without mounting React + PM.
 *
 * Two seams:
 *   1. `closeSlashMenuPlugin(view)` — dispatches a forceClose meta on the
 *      slash-menu plugin so its state goes to `{open:false}` without mutating
 *      the doc. Necessary because the React-side `setSlashState({open:false})`
 *      alone gets clobbered by `dispatchTransaction`'s plugin→React projection
 *      on the next keystroke (plugin still says open → React flips back).
 *
 *   2. `isBlockJustSlashTrigger(view)` — heuristic that says "the block's
 *      sole content is the slash trigger pattern", i.e. `/<filter>` on a
 *      single line with no other text. Drives the "delete the block on
 *      Escape/outside-click" decision so we don't destroy real content if
 *      a user somehow opened the menu in an existing populated block.
 */

import { slashMenuPluginKey } from './pm-plugins/slash-menu.js';

export function closeSlashMenuPlugin(view) {
  if (!view) return;
  try {
    view.dispatch(view.state.tr.setMeta(slashMenuPluginKey, 'forceClose'));
  } catch {
    // View may be mid-tear-down during a block delete — closing is moot.
  }
}

export function isBlockJustSlashTrigger(view) {
  if (!view) return false;
  try {
    const doc = view.state.doc;
    const text = doc.textBetween(0, doc.content.size, '\n', '');
    // Trim trailing whitespace only — leading "/" is required. No newlines
    // means no second paragraph / hard_break with content beyond the trigger.
    const trimmed = text.replace(/\s+$/, '');
    return trimmed.startsWith('/') && !trimmed.includes('\n');
  } catch {
    return false;
  }
}
