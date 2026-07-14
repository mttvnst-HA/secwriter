import { test, expect } from './fixtures.js';
import path from 'path';

// File-import E2E — pins the useFileSession input shell (candidate #1 slice 2).
// Before this, the .SEC import chain had NO end-to-end coverage (only an
// "input exists" assertion in editor.spec.js). Drives a real import through the
// hidden file input:
//   handleFileInputChange -> handleFileImport -> FileReader(windows-1252)
//   -> onFileLoaded(text, name, null) -> loadSECContent (whole-document reset).
// loadSECContent stays in App; the shell that reads the file and calls back
// lives in the hook. This guards the seam between them.
test.describe('File import', () => {
  test('real .SEC import replaces the document', async ({ page }) => {
    await page.goto('/');

    // Wait for the app to mount (hidden import input attached) before asserting
    // content — the initial paint can lag under parallel-suite load (RAFT).
    const input = page.locator('input[type="file"][accept=".sec,.xml"]');
    await expect(input).toBeAttached({ timeout: 15000 });
    // Default sample is section 31 00 00.
    await expect(page.locator('text=31 00 00').first()).toBeVisible({ timeout: 15000 });

    const secPath = path.resolve(process.cwd(), 'reference/UFGS_M/01 11 00.SEC');
    await input.setInputFiles(secPath);

    // extractMetadata pulled SCN "01 11 00" -> sectionMeta.sectionNumber -> UI.
    await expect(page.locator('text=01 11 00').first()).toBeVisible({ timeout: 15000 });
    // Old section number is gone — a full document swap, not a merge.
    await expect(page.locator('text=31 00 00')).toHaveCount(0, { timeout: 15000 });
  });
});
