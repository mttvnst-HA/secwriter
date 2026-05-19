// Playwright globalSetup — wipes E2E-only collab storage before each suite.
//
// Paired with SIM_LOCAL_STORAGE_DIR=server/collab-db-e2e in
// playwright.config.js's webServer.env. The collab-server reads that env
// and writes all room state under that directory; this hook deletes its
// contents so the suite never inherits rooms from a prior run.
//
// Dev storage at server/collab-db/ is NOT touched.

import fs from 'node:fs';
import path from 'node:path';

const E2E_STORAGE_DIR = path.resolve(process.cwd(), 'server/collab-db-e2e');

// Hard guard: refuse to wipe anything that doesn't end in '-e2e'. A typo
// elsewhere that left this pointing at server/collab-db/ would silently
// destroy real work — this stops it.
if (!E2E_STORAGE_DIR.endsWith('-e2e')) {
  throw new Error(
    `global-setup refuses to wipe a directory not ending in -e2e: ${E2E_STORAGE_DIR}`,
  );
}

export default async function globalSetup() {
  if (fs.existsSync(E2E_STORAGE_DIR)) {
    fs.rmSync(E2E_STORAGE_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(E2E_STORAGE_DIR, { recursive: true });
}
