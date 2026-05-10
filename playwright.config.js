import { defineConfig } from '@playwright/test';

// Sub-PR 1e (#47, ADR-0006) — the E2E suite runs under both flag values
// (legacy contentEditable and PM EditorView) so collab + editor scenarios
// are validated against both code paths until the 1i sub-PR removes the
// flag. Pick which project to run via `--project=chromium` (legacy) or
// `--project=chromium-pm` (PM editor on). Default: both.
//
// Each project's `use.extraHTTPHeaders` is unused; the PM-flag project sets
// the runtime override `window.__SIM_FORCE_PM_EDITOR = true` on every page
// via `use.contextOptions` storage state — see the addInitScript stanza
// below.
export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30000,
  retries: process.env.CI ? 1 : 0,
  // Run tests within each file in parallel and shard across workers.
  // Each worker gets an isolated browser context, so localStorage
  // auto-save state does not leak between tests.
  fullyParallel: true,
  workers: process.env.CI ? 4 : undefined,
  use: {
    baseURL: 'http://localhost:5173',
    headless: true,
    viewport: { width: 1280, height: 800 },
  },
  webServer: [
    {
      command: 'npm run dev',
      port: 5173,
      reuseExistingServer: true,
      timeout: 15000,
    },
    {
      command: 'node server/collab-server.cjs',
      port: 1234,
      reuseExistingServer: true,
      timeout: 10000,
    },
  ],
  projects: [
    {
      name: 'chromium',
      use: {
        browserName: 'chromium',
      },
    },
    {
      name: 'chromium-pm',
      use: {
        browserName: 'chromium',
        // Inject the runtime override before any app code runs. The flag is
        // read once at module load time by feature-flags.js; setting it
        // pre-load means PmEditableBlock is mounted from the very first
        // render. Tests in this project see the PM-backed editor.
        baseURL: 'http://localhost:5173/?pm=1',
      },
    },
  ],
});
