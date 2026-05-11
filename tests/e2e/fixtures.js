// Playwright test fixture that injects `window.__SIM_FORCE_PM_EDITOR = true`
// before any page script runs, gated on the project-level `forcePmEditor`
// option. This is the supported way to set a window property pre-load —
// the baseURL `?pm=1` pattern doesn't work because Playwright resolves
// `page.goto('/')` against the base via `new URL('/', baseURL)`, which drops
// the search component (per WHATWG URL).
//
// Test files import `test` and `expect` from this module instead of from
// `@playwright/test`. The two projects in playwright.config.js set
// `forcePmEditor: true` (chromium / PM-on) or omit it (chromium-legacy /
// flag-off via env default).

import { test as base, expect } from '@playwright/test';

export const test = base.extend({
  // Project-level option. Default is `false` (legacy path).
  forcePmEditor: [false, { option: true }],

  // Override the per-test browser context so the init script runs before any
  // app code in every page Playwright opens.
  context: async ({ context, forcePmEditor }, use) => {
    if (forcePmEditor) {
      await context.addInitScript(() => {
        // The override is read at module-load time by feature-flags.js
        // (`window.__SIM_FORCE_PM_EDITOR` has highest precedence over URL
        // `?pm=` and env VITE_PM_EDITOR). Setting it pre-load means every
        // editable block mounts via PmEditableBlock from the very first
        // render — exactly what the test project is meant to exercise.
        window.__SIM_FORCE_PM_EDITOR = true;
      });
    }
    await use(context);
  },
});

export { expect };
