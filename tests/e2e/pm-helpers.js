// pm-helpers.js — test helpers for Playwright E2E.
//
// PmEditableBlock owns the contentEditable host for editable blocks — a
// direct `el.innerHTML = '...'` is overwritten on the next render cycle, and
// reading `el.innerHTML` produces PM-wrapped shape (e.g. `<p>text</p>`
// instead of `text`). These helpers route through App's DEV-only
// `window.__simEditorTestUtils` so test injection and reads stay flat. The
// utility is wired in `src/App.jsx` under `import.meta.env.DEV`; our
// Playwright `webServer` runs Vite dev, so it's always available.
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
 * Place a collapsed caret on a block. Use INSTEAD of
 * `keyboard.press('Home' | 'End')` whenever the next test step invokes a
 * PM keymap handler that reads `state.selection` synchronously
 * (Arrow keys, Backspace, Tab, '/'). See issue #116.
 *
 * `Home`/`End` are browser-native and update the DOM `Selection`; PM's
 * `domObserver` translates that back into `state.selection` on a
 * microtask + animation-frame schedule. If the next Playwright keystroke
 * fires before the observer settles, the keymap handler reads stale
 * `state.selection.from` and falls through (e.g. `isCursorAtStart`/
 * `isCursorAtEnd` in `src/lib/pm-plugins/keymap.js`).
 *
 * This helper dispatches a PM `TextSelection` synchronously via
 * `view.dispatch`, so the read-after is always coherent.
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} blockId
 * @param {'start' | 'end' | number} position 'start'/'end' resolve via
 *   `Selection.atStart`/`atEnd`; a number is a PM document position
 *   (first text pos is 1; last is N+1 for an N-character paragraph).
 */
export async function pmSetCaret(page, blockId, position) {
  const ok = await page.evaluate(
    ({ id, position }) => {
      const utils = window.__simEditorTestUtils;
      if (!utils?.setPmCaret) return false;
      return utils.setPmCaret(id, position);
    },
    { id: blockId, position },
  );
  if (!ok) throw new Error(`pmSetCaret: setPmCaret failed for block ${blockId} (position=${position})`);
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

/**
 * Create a fresh empty block by clicking into an anchor block and pressing
 * Enter, then wait for the new block's PM EditorView to mount AND for its
 * auto-focus useEffect to fire. Returns a Playwright Locator pointing at the
 * new block's outer `[data-block-id]` element.
 *
 * Why this exists: the naive pattern
 *
 *     await anchor.click();
 *     await page.keyboard.press('Enter');
 *     const focused = page.locator('[data-block-id]:focus');
 *     await expect(focused).toBeVisible({ timeout: 3000 });
 *
 * is racy. After `Enter`, the OLD block (e.g. n24) still holds focus until
 * PmEditableBlock mounts for the new block and its `isNew` useEffect
 * dispatches `view.focus()` + `Selection.atEnd`. The `:focus` selector is
 * satisfied immediately by the OLD block; subsequent keystrokes / Backspace
 * race the mount and either leak into the wrong block (typing) or no-op the
 * intended target (Backspace lands on n24 instead of the empty new block).
 *
 * This helper waits for BOTH conditions:
 *   1. document.activeElement is inside a [data-block-id] whose id differs
 *      from the block that held focus before Enter was pressed.
 *   2. window.__simEditorTestUtils.getPmSelection(newId) returns a non-null
 *      { from, to } — which is the post-condition of PmEditableBlock's
 *      mount-time view.focus() + Selection.atEnd dispatch.
 *
 * Tracks issue #114.
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} [anchorBlockId='n24'] block to click into before Enter
 * @returns {Promise<import('@playwright/test').Locator>}
 */
export async function createFreshBlock(page, anchorBlockId = 'n24') {
  const anchor = page.locator(`[data-block-id="${anchorBlockId}"]`);
  await anchor.click();

  // Capture the block id that currently holds focus. We must observe focus
  // LEAVING this block before we trust the new block.
  const oldId = await page.evaluate(() => {
    const el = document.activeElement?.closest('[data-block-id]');
    return el?.getAttribute('data-block-id') ?? null;
  });

  await page.keyboard.press('Enter');

  const newId = await page.evaluate(
    async (prevId) => {
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        const focusedEl = document.activeElement?.closest('[data-block-id]');
        const id = focusedEl?.getAttribute('data-block-id');
        if (id && id !== prevId) {
          const sel = window.__simEditorTestUtils?.getPmSelection?.(id);
          // sel is non-null only after PmEditableBlock's mount-time
          // auto-focus useEffect has dispatched its initial selection.
          if (sel && typeof sel.from === 'number') return id;
        }
        await new Promise((r) => setTimeout(r, 10));
      }
      return null;
    },
    oldId,
  );

  if (!newId) {
    throw new Error(
      `createFreshBlock: timed out waiting for a new block to mount + auto-focus (anchor=${anchorBlockId}, oldId=${oldId})`,
    );
  }
  return page.locator(`[data-block-id="${newId}"]`);
}

/**
 * Returns the data-comment-id of the currently-active comment span (the one
 * with class 'mark-comment-active', applied by activeCommentPlugin's inline
 * decoration). Returns null when no comment is active. 1g — DOM-based so no
 * test-utils plugin-state exposure is needed.
 *
 * PM's Decoration.inline creates a nested wrapper span with the added class
 * INSIDE the comment mark's <span class="mark-comment" data-comment-id="...">
 * element. The data-comment-id lives on the outer mark span, not the inner
 * decoration span. We traverse to the closest ancestor with that attribute.
 */
export async function pmGetActiveCommentId(page) {
  return await page.evaluate(() => {
    const el = document.querySelector('.mark-comment-active');
    if (!el) return null;
    // The decoration span is inside the mark span that carries data-comment-id.
    const markEl = el.closest('[data-comment-id]');
    return markEl?.getAttribute('data-comment-id') ?? null;
  });
}
