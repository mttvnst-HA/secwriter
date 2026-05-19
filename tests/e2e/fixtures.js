// Re-export from @playwright/test for the editor + collab E2E suites.
// 1i-b.2 (#47) — the forcePmEditor fixture option was removed when the
// VITE_PM_EDITOR flag retired. Test files import test/expect from here
// rather than @playwright/test in case future project-wide fixtures land.

import { test, expect } from '@playwright/test';

export { test, expect };
