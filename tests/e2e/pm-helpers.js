// pm-helpers.js — editor-mode-agnostic test helpers for Playwright E2E.
//
// 1f.7 (#47): in PM mode (`VITE_PM_EDITOR=true`, or `?pm=1`, or
// `window.__SIM_FORCE_PM_EDITOR=true`) the contentEditable host is owned by
// ProseMirror — a direct `el.innerHTML = '...'` is overwritten on the next
// render cycle, and reading `el.innerHTML` produces PM-wrapped shape (e.g.
// `<p>text</p>` instead of `text`). These helpers route through App's
// DEV-only `window.__simEditorTestUtils` so tests work identically in both
// modes. The utility is wired in `src/App.jsx` under `import.meta.env.DEV`;
// our Playwright `webServer` runs Vite dev, so it's always available.
//
// Usage:
//   import { readBlockHtml, injectBlockHtml } from './pm-helpers.js';
//   const html = await readBlockHtml(page, blockId);
//   await injectBlockHtml(page, blockId, '<span class="mark-srf">...</span>');

/**
 * Read a block's canonical HTML from App state. Matches the legacy flat
 * shape in both editor modes (no PM `<p>` wrapper).
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} blockId
 * @returns {Promise<string|null>}
 */
export async function readBlockHtml(page, blockId) {
  return page.evaluate((id) => {
    const utils = window.__simEditorTestUtils;
    if (!utils) {
      throw new Error('readBlockHtml: window.__simEditorTestUtils unavailable — DEV-only hook missing');
    }
    return utils.getBlockHtml(id);
  }, blockId);
}

/**
 * Replace a block's HTML through App's normal update path. Works for both
 * legacy contentEditable and PM EditorView blocks — the PM path re-renders
 * via ySyncPlugin's substrate observe; the legacy path re-renders via the
 * React setBlocks dispatch.
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} blockId
 * @param {string} html
 */
export async function injectBlockHtml(page, blockId, html) {
  await page.evaluate(
    ({ id, html }) => {
      const utils = window.__simEditorTestUtils;
      if (!utils) {
        throw new Error('injectBlockHtml: window.__simEditorTestUtils unavailable — DEV-only hook missing');
      }
      utils.setBlockHtml(id, html);
    },
    { id: blockId, html },
  );
  // Allow React commit + PM ySyncPlugin observe to flush before the next
  // assertion runs. 50ms is comfortably above the typical render window.
  await page.waitForTimeout(50);
}

/**
 * Report the active editor mode for tests that need to branch behavior
 * (e.g. asserts that target a PM widget decoration vs a legacy DOM span).
 *
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<'pm'|'legacy'>}
 */
export async function getEditorMode(page) {
  return page.evaluate(() => {
    const utils = window.__simEditorTestUtils;
    if (!utils) {
      throw new Error('getEditorMode: window.__simEditorTestUtils unavailable — DEV-only hook missing');
    }
    return utils.getEditorMode();
  });
}

/**
 * Programmatically set PM selection on a block. Required for some
 * Playwright tests where keyboard-driven Shift+End / Shift+Arrow flows
 * have been flaky on this repo's history because PM's domObserver
 * doesn't always pick up synthesized selectionchange under dispatchEvent.
 *
 * `from` and `to` are PM document positions. For a single-paragraph block
 * with N characters, the first text position is 1 and the last is N+1.
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} blockId
 * @param {number} from
 * @param {number} to
 */
export async function pmSetSelection(page, blockId, from, to) {
  const ok = await page.evaluate(
    ({ id, from, to }) => {
      const utils = window.__simEditorTestUtils;
      if (!utils?.setPmSelection) return false;
      return utils.setPmSelection(id, from, to);
    },
    { id: blockId, from, to },
  );
  if (!ok) throw new Error(`pmSetSelection: setPmSelection failed for block ${blockId}`);
}

/**
 * Read PM selection range for assertions. Returns { from, to } or null
 * if the block has no mounted PM view.
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} blockId
 * @returns {Promise<{from: number, to: number} | null>}
 */
export async function pmGetSelection(page, blockId) {
  return page.evaluate((id) => {
    const utils = window.__simEditorTestUtils;
    return utils?.getPmSelection ? utils.getPmSelection(id) : null;
  }, blockId);
}
