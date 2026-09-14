import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30000,
  retries: process.env.CI ? 1 : 0,
  fullyParallel: true,
  workers: process.env.CI ? 4 : undefined,
  globalSetup: './tests/e2e/global-setup.js',
  use: {
    baseURL: 'http://localhost:5173',
    headless: true,
    viewport: { width: 1280, height: 800 },
    // Diagnostics for CI-only failures. `on-first-retry` keeps the happy
    // path free of trace overhead (retries is 1 on CI, 0 locally, so the
    // trace only ever records on a CI retry). ci.yml uploads test-results/
    // and playwright-report/ as a job artifact when the job fails.
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  // `list` keeps the console output CI already relies on; `html` writes
  // playwright-report/ (gitignored) for the failure artifact. `open: never`
  // stops a local run from launching a browser tab on failure.
  reporter: process.env.CI
    ? [['list'], ['html', { open: 'never' }]]
    : 'list',
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
      env: {
        SIM_RATE_LIMIT_HTTP_WRITE_PER_MIN: '10000',
        SIM_RATE_LIMIT_HTTP_READ_PER_MIN: '10000',
        SIM_RATE_LIMIT_WS_PER_MIN: '10000',
        SIM_LOCAL_STORAGE_DIR: 'server/collab-db-e2e',
      },
    },
  ],
  projects: [
    {
      name: 'chromium',
      use: { browserName: 'chromium' },
    },
  ],
});
