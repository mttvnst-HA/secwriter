// R4 spike runner — launches headless Chromium against the Vite dev server
// at localhost:5173/bench-pm-mount.html, waits for window.__benchResult,
// prints the JSON, and exits.
//
// Vite must already be running (npm run dev). No webServer auto-start here —
// the bench is a one-shot, not part of the test suite.

import { chromium } from 'playwright';

const URL = 'http://localhost:5173/bench-pm-mount.html';
const TIMEOUT_MS = 120000;

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();

  page.on('pageerror', (err) => {
    process.stderr.write(`[pageerror] ${err.message}\n${err.stack || ''}\n`);
  });
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      process.stderr.write(`[console.error] ${msg.text()}\n`);
    }
  });

  await page.goto(URL, { waitUntil: 'load', timeout: 30000 });

  const result = await page.waitForFunction(
    () => window.__benchResult,
    null,
    { timeout: TIMEOUT_MS },
  ).then((handle) => handle.jsonValue());

  await browser.close();

  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

main().catch((err) => {
  process.stderr.write(`[runner] ${err.message}\n${err.stack || ''}\n`);
  process.exit(1);
});
