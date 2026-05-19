import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30000,
  retries: process.env.CI ? 1 : 0,
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
      env: {
        SIM_RATE_LIMIT_HTTP_WRITE_PER_MIN: '10000',
        SIM_RATE_LIMIT_HTTP_READ_PER_MIN: '10000',
        SIM_RATE_LIMIT_WS_PER_MIN: '10000',
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
