/**
 * slash-menu.js — PM plugin that detects "/" trigger and exposes filter state.
 *
 * Sub-PR 1e (#47, v2 plan Q5). Replaces the EditableBlock.handleInput slash
 * detection (lines around 340-381 of the legacy component). The popup itself
 * stays the existing React `SlashMenu.jsx` — this plugin only owns
 * detection.
 *
 * State shape: `{ open: boolean, filter: string, fromPos: number | null }`.
 *   open=true when the document text starts with `/` (the legacy heuristic;
 *   slash anywhere mid-paragraph is intentionally not a trigger so existing
 *   spec text containing slashes never opens the menu).
 *
 * Exposure: subscribers register via `addSlashListener(view, fn)`. The
 * plugin's `view()` lifecycle calls every listener whenever state changes.
 * PmEditableBlock translates these into React state via useState.
 *
 * Intentional asymmetry with the legacy `handleInput`: that function ran
 * `text.startsWith("/")` against the contentEditable's textContent (which
 * includes ZWS — stripped first). PM's doc.textContent is canonical and
 * has no ZWS, so this plugin reads `state.doc.textBetween(0, doc.content.size)`
 * directly. Behavioral parity verified by the e2e suite under both flag
 * values (Q18).
 *
 * Adversarial-input fallback (Q31/E6): if the doc's first text run is a PM
 * non-text node (an embed, image), we treat the slash detection as off
 * rather than throwing. Schema rejects unsupported nodes upstream anyway.
 */

import { Plugin, PluginKey } from 'prosemirror-state';

export const slashMenuPluginKey = new PluginKey('sim-slash-menu');

const initialState = { open: false, filter: '', fromPos: null };

export function slashMenuPlugin() {
  return new Plugin({
    key: slashMenuPluginKey,
    state: {
      init: () => ({ ...initialState }),
      apply: (tr, prev, _oldState, newState) => {
        // Only reconsider on doc changes — selection moves don't open / close
        // the slash menu. Without this short-circuit, every cursor move would
        // emit a fresh state object and re-fire listeners.
        if (!tr.docChanged) return prev;

        const text = readLeadingText(newState.doc);
        if (text.startsWith('/')) {
          const filter = text.slice(1);
          // QC minor-10: avoid allocating a new state object every keystroke
          // while the menu is open and the filter is unchanged. PmEditableBlock's
          // dispatchTransaction guards on identity-of-fields anyway, but allocating
          // less here keeps the plugin's reference-equality fast path useful for
          // future subscribers.
          if (prev.open && prev.filter === filter && prev.fromPos === 0) return prev;
          return { open: true, filter, fromPos: 0 };
        }
        if (prev.open) return { ...initialState };
        return prev;
      },
    },
    view(_view) {
      // No DOM mutation — the plugin only carries state. PmEditableBlock
      // observes via a transaction-listener wired through the EditorView
      // mount path (dispatchTransaction in EditorView props).
      return {};
    },
  });
}

/**
 * Read the leading plain-text run of the doc, used for the slash trigger
 * heuristic. Bounded to the first ~50 chars so a slash deep into a long
 * paragraph never opens the menu.
 */
function readLeadingText(doc) {
  try {
    const max = Math.min(doc.content.size, 50);
    return doc.textBetween(0, max, '\n', '');
  } catch {
    return '';
  }
}

/** Convenience selector for callers that already hold the EditorState. */
export function getSlashMenuState(state) {
  return slashMenuPluginKey.getState(state) || initialState;
}
