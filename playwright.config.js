import { defineConfig } from '@playwright/test';

// Sub-PR 1e (#47, ADR-0006) — the E2E suite runs under both flag values
// (legacy contentEditable and PM EditorView) so collab + editor scenarios
// are validated against both code paths until the 1i sub-PR removes the
// flag. Pick which project to run via `--project=chromium-legacy` (legacy
// contentEditable) or `--project=chromium` (PM editor on). Default: both.
//
// Sub-PR 1f.5 (#47) — the previous `?pm=1` baseURL pattern was a no-op
// because Playwright resolves `page.goto('/')` against `baseURL` via
// `new URL('/', baseURL)`, which drops the search component (per WHATWG
// URL). The PM project ran legacy in both projects until this was caught.
//
// Fix: project-level `forcePmEditor` option consumed by the custom test
// fixture in `tests/e2e/fixtures.js`. The fixture overrides the browser
// context to call `context.addInitScript(() => window.__SIM_FORCE_PM_EDITOR = true)`
// before any app code runs. Test files import test/expect from the fixture
// instead of @playwright/test so the option is honored.
//
// 1f.5 keeps both projects passing under the still-default-false flag. The
// flag flip itself ships in a follow-on PR once all PM-mode regressions
// are addressed (the legacy project disappears in 1i).
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
      // Raise rate limits for E2E. Defaults (20 write/min, 60 read/min,
      // 10 ws/min) are exhausted quickly when both chromium-legacy and
      // chromium projects run against the same reused server — all traffic
      // comes from one IP and the in-memory window persists across the
      // whole run. Matches the overrides in .github/workflows/ci.yml.
      env: {
        SIM_RATE_LIMIT_HTTP_WRITE_PER_MIN: '10000',
        SIM_RATE_LIMIT_HTTP_READ_PER_MIN: '10000',
        SIM_RATE_LIMIT_WS_PER_MIN: '10000',
      },
    },
  ],
  projects: [
    {
      name: 'chromium-legacy',
      use: {
        browserName: 'chromium',
        // forcePmEditor omitted → default false → fixture skips addInitScript
        // → app reads VITE_PM_EDITOR env (defaults false on `main`) → legacy
        // contentEditable path.
      },
    },
    {
      name: 'chromium',
      use: {
        browserName: 'chromium',
        forcePmEditor: true,
      },
    },
  ],
});
