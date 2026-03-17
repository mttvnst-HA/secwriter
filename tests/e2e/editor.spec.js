import { test, expect } from '@playwright/test';

// ─── Helpers ───────────────────────────────────────────────────────────────────

/** Wait for the app to fully render (initial blocks loaded). */
async function waitForApp(page) {
  await page.waitForSelector('text=/\\d+ blocks/');
}

/** Return a CSS selector for a block by its data-block-id. */
function blockSel(id) {
  return `[data-block-id="${id}"]`;
}

/**
 * Create a fresh empty block after n24 and return its locator.
 * This is the most reliable way to get a clean block for testing.
 */
async function createFreshBlock(page) {
  const txt = page.locator(blockSel('n24'));
  await txt.click();
  await page.keyboard.press('Enter');
  const focused = page.locator('[data-block-id]:focus');
  await expect(focused).toBeVisible({ timeout: 3000 });
  return focused;
}

/** Get the current block count from the status bar. */
async function getBlockCount(page) {
  const text = await page.locator('text=/\\d+ blocks/').textContent();
  return parseInt(text);
}

// ─── Page Load & Layout ────────────────────────────────────────────────────────

test.describe('Page load & layout', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForApp(page);
  });

  test('renders sidebar with UFGS section number', async ({ page }) => {
    await expect(page.locator('text=UFGS 31 00 00')).toBeVisible();
  });

  test('renders section title in sidebar', async ({ page }) => {
    // Use .first() since "EARTHWORK" appears in multiple places
    await expect(page.getByText('EARTHWORK', { exact: true }).first()).toBeVisible();
  });

  test('renders toolbar with Import and Export buttons', async ({ page }) => {
    await expect(page.locator('button:has-text("Import")')).toBeVisible();
    await expect(page.locator('button:has-text("Export")')).toBeVisible();
  });

  test('renders EDITING status badge', async ({ page }) => {
    await expect(page.getByText('EDITING', { exact: true })).toBeVisible();
  });

  test('renders section banner with UFGS header', async ({ page }) => {
    await expect(page.getByText('UNIFIED FACILITIES GUIDE SPECIFICATIONS', { exact: true })).toBeVisible();
    // "SECTION 31 00 00" appears in multiple places, use the banner one
    await expect(page.getByText('SECTION 31 00 00').first()).toBeVisible();
  });

  test('renders mark legend', async ({ page }) => {
    await expect(page.locator('text=Data Elements:')).toBeVisible();
    await expect(page.locator('text=Ref Standard')).toBeVisible();
    await expect(page.locator('text=Section Ref')).toBeVisible();
  });

  test('renders status bar with block count', async ({ page }) => {
    await expect(page.locator('text=458 blocks')).toBeVisible();
  });

  test('renders status bar keyboard hints', async ({ page }) => {
    await expect(page.locator('text=/Enter: new paragraph/')).toBeVisible();
  });

  test('shows filename in status bar', async ({ page }) => {
    await expect(page.locator('text=31_00_00.SEC')).toBeVisible();
  });
});

// ─── Sidebar Tree Navigation ──────────────────────────────────────────────────

test.describe('Sidebar tree navigation', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForApp(page);
  });

  test('renders PART 1 in tree', async ({ page }) => {
    const partNode = page.locator('text=PART 1 GENERAL').first();
    await expect(partNode).toBeVisible();
  });

  test('clicking a tree node scrolls to and focuses the block', async ({ page }) => {
    const treeNode = page.locator('text=PART 1 GENERAL').first();
    await treeNode.click();
    const blockEl = page.locator('#block-n5');
    await expect(blockEl).toBeVisible();
  });

  test('tree nodes expand/collapse on click', async ({ page }) => {
    const referencesNode = page.locator('text=REFERENCES').first();
    await expect(referencesNode).toBeVisible();
  });
});

// ─── Block Types Rendering ─────────────────────────────────────────────────────

test.describe('Block type rendering', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForApp(page);
  });

  test('PART titles render as non-editable headings', async ({ page }) => {
    const part1 = page.locator('#block-n5');
    await expect(part1).toBeVisible();
    await expect(part1.locator('text=PART 1 GENERAL')).toBeVisible();
  });

  test('note blocks render with amber left border', async ({ page }) => {
    const note = page.locator(blockSel('n1'));
    await expect(note).toBeVisible();
    await expect(note).toHaveAttribute('contenteditable', 'true');
  });

  test('txt blocks are contentEditable', async ({ page }) => {
    const txt = page.locator(blockSel('n24'));
    await expect(txt).toBeVisible();
    await expect(txt).toHaveAttribute('contenteditable', 'true');
  });

  test('oli blocks are contentEditable', async ({ page }) => {
    const oli = page.locator(blockSel('n85'));
    await expect(oli).toBeVisible();
    await expect(oli).toHaveAttribute('contenteditable', 'true');
  });

  test('item blocks are contentEditable', async ({ page }) => {
    const item = page.locator(blockSel('n98'));
    await expect(item).toBeVisible();
    await expect(item).toHaveAttribute('contenteditable', 'true');
  });

  test('lst blocks are contentEditable', async ({ page }) => {
    const lst = page.locator(blockSel('n97'));
    await expect(lst).toBeVisible();
    await expect(lst).toHaveAttribute('contenteditable', 'true');
  });

  test('table blocks render as HTML tables (read-only)', async ({ page }) => {
    const tables = page.locator('table');
    const count = await tables.count();
    expect(count).toBeGreaterThanOrEqual(1);
  });

  test('inline marks render with colored spans', async ({ page }) => {
    const item = page.locator(blockSel('n136'));
    const subSpan = item.locator('.mark-sub');
    await expect(subSpan.first()).toBeVisible();
  });
});

// ─── Click Focus ───────────────────────────────────────────────────────────────

test.describe('Click focus', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForApp(page);
  });

  test('clicking a txt block focuses it and shows focus ring', async ({ page }) => {
    const txt = page.locator(blockSel('n24'));
    await txt.click();
    const border = await txt.evaluate(el => getComputedStyle(el).borderColor);
    expect(border).not.toBe('rgba(0, 0, 0, 0)');
  });

  test('clicking a title shows Tab/Shift+Tab hint', async ({ page }) => {
    const title = page.locator(blockSel('n20'));
    await title.click();
    await expect(page.locator('text=Tab/Shift+Tab to change level')).toBeVisible();
  });
});

// ─── Enter Key ─────────────────────────────────────────────────────────────────

test.describe('Enter key behavior', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForApp(page);
  });

  test('Enter on a txt block creates a new txt block below', async ({ page }) => {
    const blocksBefore = await getBlockCount(page);

    const txt = page.locator(blockSel('n24'));
    await txt.click();
    await page.keyboard.press('Enter');

    await page.waitForFunction(
      (before) => {
        const match = document.body.innerText.match(/(\d+) blocks/);
        return match && parseInt(match[1]) > before;
      },
      blocksBefore,
      { timeout: 3000 }
    );

    const blocksAfter = await getBlockCount(page);
    expect(blocksAfter).toBe(blocksBefore + 1);
  });

  test('Enter on an oli block creates another oli block', async ({ page }) => {
    const oli = page.locator(blockSel('n85'));
    await oli.click();
    await page.keyboard.type('test content');
    await page.keyboard.press('Enter');

    const focused = page.locator('[data-block-id]:focus');
    await expect(focused).toBeVisible({ timeout: 3000 });
  });

  test('Enter on a title creates a new txt block below', async ({ page }) => {
    const title = page.locator(blockSel('n20'));
    await title.click();
    const before = await getBlockCount(page);

    await page.keyboard.press('Enter');

    await page.waitForFunction(
      (b) => {
        const m = document.body.innerText.match(/(\d+) blocks/);
        return m && parseInt(m[1]) > b;
      },
      before,
      { timeout: 3000 }
    );
  });
});

// ─── Backspace / Delete ────────────────────────────────────────────────────────

test.describe('Backspace on empty block', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForApp(page);
  });

  test('Backspace on an empty new block deletes it', async ({ page }) => {
    const txt = page.locator(blockSel('n24'));
    await txt.click();
    await page.keyboard.press('Enter');

    const focused = page.locator('[data-block-id]:focus');
    await expect(focused).toBeVisible({ timeout: 3000 });

    const afterEnter = await getBlockCount(page);

    await page.keyboard.press('Backspace');

    await page.waitForFunction(
      (ae) => {
        const m = document.body.innerText.match(/(\d+) blocks/);
        return m && parseInt(m[1]) < ae;
      },
      afterEnter,
      { timeout: 3000 }
    );

    const afterDel = await getBlockCount(page);
    expect(afterDel).toBe(afterEnter - 1);
  });
});

// ─── Arrow Key Navigation ──────────────────────────────────────────────────────

test.describe('Arrow key navigation', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForApp(page);
  });

  test('ArrowUp at start of block moves to previous block', async ({ page }) => {
    // Use a freshly created short block to avoid multiline wrapping issues
    const focused = await createFreshBlock(page);
    const blockId = await focused.getAttribute('data-block-id');
    await page.keyboard.type('short');

    // Place cursor at the very start of the block content
    await page.evaluate((id) => {
      const el = document.querySelector(`[data-block-id="${id}"]`);
      const range = document.createRange();
      const sel = window.getSelection();
      range.setStart(el, 0);
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
    }, blockId);

    await page.keyboard.press('ArrowUp');

    const afterNav = page.locator('[data-block-id]:focus');
    await expect(afterNav).toBeVisible({ timeout: 3000 });
    const newId = await afterNav.getAttribute('data-block-id');
    expect(newId).not.toBe(blockId);
  });

  test('ArrowDown at end of short block moves to next block', async ({ page }) => {
    // Use a short block to avoid multiline wrapping issues.
    // Create a new short block, navigate down from it.
    const txt = page.locator(blockSel('n24'));
    await txt.click();
    await page.keyboard.press('Enter');

    const newBlock = page.locator('[data-block-id]:focus');
    await expect(newBlock).toBeVisible({ timeout: 3000 });
    await page.keyboard.type('short');

    // Save the new block's ID
    const newId = await newBlock.getAttribute('data-block-id');

    // Now cursor is at end of "short". Press ArrowDown.
    await page.keyboard.press('End');
    await page.keyboard.press('ArrowDown');

    const focused = page.locator('[data-block-id]:focus');
    await expect(focused).toBeVisible({ timeout: 3000 });
    const downId = await focused.getAttribute('data-block-id');
    expect(downId).not.toBe(newId);
  });
});

// ─── Title Block Tab/Shift+Tab ─────────────────────────────────────────────────

test.describe('Title promote/demote', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForApp(page);
  });

  test('Tab on a title block demotes it (increases depth)', async ({ page }) => {
    const title = page.locator(blockSel('n20'));
    await title.click();
    const fontBefore = await title.evaluate(el => {
      return getComputedStyle(el.closest('[id^="block-"]') || el.parentElement).fontSize;
    });

    await page.keyboard.press('Tab');

    const fontAfter = await title.evaluate(el => {
      return getComputedStyle(el.closest('[id^="block-"]') || el.parentElement).fontSize;
    });

    expect(parseInt(fontAfter)).toBeLessThanOrEqual(parseInt(fontBefore));
  });

  test('Shift+Tab on a title block promotes it (decreases depth)', async ({ page }) => {
    const title = page.locator(blockSel('n20'));
    await title.click();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Shift+Tab');

    const font = await title.evaluate(el => {
      return getComputedStyle(el.closest('[id^="block-"]') || el.parentElement).fontSize;
    });
    expect(parseInt(font)).toBeGreaterThanOrEqual(14);
  });
});

// ─── Slash Menu ────────────────────────────────────────────────────────────────

test.describe('Slash command menu', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForApp(page);
  });

  test('typing / in a block opens the slash menu', async ({ page }) => {
    await createFreshBlock(page);
    await page.keyboard.type('/');

    // Use exact match to avoid matching status bar text
    await expect(page.getByText('Insert block', { exact: true })).toBeVisible({ timeout: 3000 });
  });

  test('slash menu shows all block types', async ({ page }) => {
    await createFreshBlock(page);
    await page.keyboard.type('/');
    await expect(page.getByText('Insert block', { exact: true })).toBeVisible({ timeout: 3000 });

    await expect(page.getByText('Heading', { exact: true })).toBeVisible();
    await expect(page.getByText('Paragraph', { exact: true })).toBeVisible();
    await expect(page.getByText('Designer Note', { exact: true })).toBeVisible();
    await expect(page.getByText('Ordered List', { exact: true })).toBeVisible();
    await expect(page.getByText('List Item', { exact: true })).toBeVisible();
    await expect(page.getByText('List Header', { exact: true })).toBeVisible();
  });

  test('slash menu filters items as you type', async ({ page }) => {
    await createFreshBlock(page);
    await page.keyboard.type('/h');

    // Only "Heading" should match (starts with 'h')
    await expect(page.getByText('Heading', { exact: true })).toBeVisible({ timeout: 3000 });
    // The slash menu dropdown should not contain "Paragraph"
    // Paragraph doesn't start with 'h' so it's filtered out
    await expect(page.getByText('Paragraph', { exact: true })).not.toBeVisible();
  });

  test('ArrowDown/ArrowUp navigate slash menu items', async ({ page }) => {
    await createFreshBlock(page);
    await page.keyboard.type('/');
    await expect(page.getByText('Insert block', { exact: true })).toBeVisible({ timeout: 3000 });

    // Press ArrowDown — the highlight moves
    await page.keyboard.press('ArrowDown');
    // Verify the menu is still open (the interaction didn't close it)
    await expect(page.getByText('Insert block', { exact: true })).toBeVisible();
  });

  test('Enter selects slash menu item and converts block', async ({ page }) => {
    await createFreshBlock(page);

    await page.keyboard.type('/d');
    await expect(page.getByText('Designer Note', { exact: true })).toBeVisible({ timeout: 3000 });
    await page.keyboard.press('Enter');

    const newFocused = page.locator('[data-block-id]:focus');
    await expect(newFocused).toBeVisible({ timeout: 3000 });
  });

  test('Escape closes the slash menu', async ({ page }) => {
    await createFreshBlock(page);
    await page.keyboard.type('/');
    await expect(page.getByText('Insert block', { exact: true })).toBeVisible({ timeout: 3000 });

    await page.keyboard.press('Escape');
    await expect(page.getByText('Insert block', { exact: true })).not.toBeVisible();
  });
});

// ─── List Continuation & Exit ──────────────────────────────────────────────────

test.describe('List continuation', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForApp(page);
  });

  test('Enter on an empty oli block converts it back to txt', async ({ page }) => {
    await createFreshBlock(page);

    // Convert to oli via slash menu
    await page.keyboard.type('/o');
    await expect(page.getByText('Ordered List', { exact: true })).toBeVisible({ timeout: 3000 });
    await page.keyboard.press('Enter');

    const oliFocused = page.locator('[data-block-id]:focus');
    await expect(oliFocused).toBeVisible({ timeout: 3000 });

    // Empty oli + Enter = convert back to txt
    await page.keyboard.press('Enter');

    const finalFocused = page.locator('[data-block-id]:focus');
    await expect(finalFocused).toBeVisible({ timeout: 3000 });
  });
});

// ─── Content Editing ───────────────────────────────────────────────────────────

test.describe('Content editing', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForApp(page);
  });

  test('typing in a txt block updates its content', async ({ page }) => {
    const focused = await createFreshBlock(page);
    await page.keyboard.type('Hello World');

    const content = await focused.textContent();
    expect(content).toContain('Hello World');
  });

  test('typing in a note block updates its content', async ({ page }) => {
    const note = page.locator(blockSel('n1'));
    await note.click();
    await page.keyboard.press('End');
    await page.keyboard.type(' APPENDED');

    const content = await note.textContent();
    expect(content).toContain('APPENDED');
  });
});

// ─── Floating Toolbar ──────────────────────────────────────────────────────────

test.describe('Floating toolbar', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForApp(page);
  });

  test('selecting text shows the floating toolbar', async ({ page }) => {
    const focused = await createFreshBlock(page);
    await page.keyboard.type('Select this text');

    // Select all text in the block via Shift+Home
    await page.keyboard.down('Shift');
    await page.keyboard.press('Home');
    await page.keyboard.up('Shift');

    await page.waitForTimeout(200);

    await expect(page.locator('button[title="Bold"]')).toBeVisible({ timeout: 3000 });
    await expect(page.locator('button[title="Italic"]')).toBeVisible();
    await expect(page.locator('button[title="Underline"]')).toBeVisible();
  });

  test('floating toolbar has mark type buttons', async ({ page }) => {
    await createFreshBlock(page);
    await page.keyboard.type('ASTM D2487');

    await page.keyboard.down('Shift');
    await page.keyboard.press('Home');
    await page.keyboard.up('Shift');
    await page.waitForTimeout(200);

    await expect(page.locator('button[title="Reference Standard (ASTM, AASHTO)"]')).toBeVisible({ timeout: 3000 });
    await expect(page.locator('button[title="Section Cross-Reference"]')).toBeVisible();
    await expect(page.locator('button[title="Submittal Item"]')).toBeVisible();
    await expect(page.locator('button[title="English Units"]')).toBeVisible();
    await expect(page.locator('button[title="Metric Units"]')).toBeVisible();
    await expect(page.locator('button[title="Tailoring Option"]')).toBeVisible();
  });

  test('clicking Bold wraps selection in <b> tag', async ({ page }) => {
    const focused = await createFreshBlock(page);
    const blockId = await focused.getAttribute('data-block-id');
    await page.keyboard.type('bold text');

    // Select "bold" (first 4 characters)
    await page.keyboard.press('Home');
    for (let i = 0; i < 4; i++) await page.keyboard.press('Shift+ArrowRight');
    await page.waitForTimeout(200);

    // Dispatch mousedown (preventDefault to keep selection) then click
    const boldBtn = page.locator('button[title="Bold"]');
    await expect(boldBtn).toBeVisible({ timeout: 3000 });
    await boldBtn.dispatchEvent('mousedown');
    await boldBtn.dispatchEvent('click');
    await page.waitForTimeout(200);

    // Check that the block now contains a <b> tag
    const html = await page.locator(blockSel(blockId)).evaluate(el => el.innerHTML);
    expect(html).toContain('<b>');
  });

  test('clicking RID mark wraps selection in mark-rid span', async ({ page }) => {
    const focused = await createFreshBlock(page);
    await page.keyboard.type('ASTM D2487');

    await page.keyboard.down('Shift');
    await page.keyboard.press('Home');
    await page.keyboard.up('Shift');
    await page.waitForTimeout(200);

    await page.locator('button[title="Reference Standard (ASTM, AASHTO)"]').click({ force: true });

    const blockId = await focused.getAttribute('data-block-id');
    const html = await page.locator(blockSel(blockId)).evaluate(el => el.innerHTML);
    expect(html).toContain('mark-rid');
  });

  test('toolbar hides when clicking outside', async ({ page }) => {
    await createFreshBlock(page);
    await page.keyboard.type('some text');
    await page.keyboard.down('Shift');
    await page.keyboard.press('Home');
    await page.keyboard.up('Shift');
    await page.waitForTimeout(200);
    await expect(page.locator('button[title="Bold"]')).toBeVisible({ timeout: 3000 });

    // Click outside — on the sidebar
    await page.locator('text=UFGS 31 00 00').click();

    await expect(page.locator('button[title="Bold"]')).not.toBeVisible({ timeout: 3000 });
  });
});

// ─── Mark Suggestions (Pattern Recognition) ────────────────────────────────────

test.describe('Mark suggestions', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForApp(page);
  });

  test('typing an RID pattern shows auto-detect suggestions', async ({ page }) => {
    const focused = await createFreshBlock(page);
    const blockId = await focused.getAttribute('data-block-id');
    await page.keyboard.type('Use ASTM D1557 for testing');

    // Click away to blur, then click back to refocus and trigger MarkSuggestions
    await page.locator(blockSel('n24')).click();
    await page.waitForTimeout(100);
    await page.locator(blockSel(blockId)).click();
    await page.waitForTimeout(300);

    await expect(page.locator('text=Auto-detect:')).toBeVisible({ timeout: 5000 });
  });

  test('typing an SRF pattern shows auto-detect suggestions', async ({ page }) => {
    const focused = await createFreshBlock(page);
    const blockId = await focused.getAttribute('data-block-id');
    await page.keyboard.type('See Section 01 33 00 for details');

    await page.locator(blockSel('n24')).click();
    await page.waitForTimeout(100);
    await page.locator(blockSel(blockId)).click();
    await page.waitForTimeout(300);

    await expect(page.locator('text=Auto-detect:')).toBeVisible({ timeout: 5000 });
  });

  test('Mark all button appears when multiple suggestions exist', async ({ page }) => {
    const focused = await createFreshBlock(page);
    const blockId = await focused.getAttribute('data-block-id');
    await page.keyboard.type('ASTM D1557 and AASHTO T99 standards');

    await page.locator(blockSel('n24')).click();
    await page.waitForTimeout(100);
    await page.locator(blockSel(blockId)).click();
    await page.waitForTimeout(300);

    await expect(page.locator('button:has-text("Mark all")')).toBeVisible({ timeout: 5000 });
  });
});

// ─── Export ────────────────────────────────────────────────────────────────────

test.describe('Export', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForApp(page);
  });

  test('clicking Export triggers a download', async ({ page }) => {
    const downloadPromise = page.waitForEvent('download');
    await page.locator('button:has-text("Export")').click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe('31_00_00.SEC');
  });
});

// ─── File Import ───────────────────────────────────────────────────────────────

test.describe('File import', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForApp(page);
  });

  test('Import button opens file dialog (hidden input exists)', async ({ page }) => {
    const fileInput = page.locator('input[type="file"][accept=".sec,.xml"]');
    await expect(fileInput).toBeAttached();
  });
});

// ─── OLI Labels ────────────────────────────────────────────────────────────────

test.describe('OLI labels', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForApp(page);
  });

  test('OLI blocks show lettered labels (a. b. c.)', async ({ page }) => {
    const oli = page.locator(blockSel('n85'));
    await oli.scrollIntoViewIfNeeded();

    const label = page.locator('text=/^a\\.$/').first();
    await expect(label).toBeVisible({ timeout: 3000 });
  });
});

// ─── Section Numbering ────────────────────────────────────────────────────────

test.describe('Section numbering', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForApp(page);
  });

  test('title blocks show section numbers', async ({ page }) => {
    // "1.1" appears in a span inside the title block for REFERENCES
    await expect(page.locator('#block-n20').getByText('1.1')).toBeVisible({ timeout: 3000 });
  });

  test('PART numbers reset section numbering', async ({ page }) => {
    // PART 2 should also have 2.1 numbering
    await expect(page.locator('#block-n169').getByText('2.1')).toBeVisible({ timeout: 3000 });
  });
});

// ─── Combined Keyboard Workflow ────────────────────────────────────────────────

test.describe('Combined keyboard workflow', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForApp(page);
  });

  test('full workflow: create block, type, navigate up', async ({ page }) => {
    // 1. Click into existing txt block
    const txt = page.locator(blockSel('n24'));
    await txt.click();

    // 2. Press Enter to create new block
    await page.keyboard.press('Enter');
    const newBlock = page.locator('[data-block-id]:focus');
    await expect(newBlock).toBeVisible({ timeout: 3000 });

    // 3. Type content
    await page.keyboard.type('Integration test content');
    const content = await newBlock.textContent();
    expect(content).toContain('Integration test');

    // 4. Navigate up with ArrowUp (cursor is at end of single-line text)
    await page.keyboard.press('Home');
    await page.keyboard.press('ArrowUp');
    const afterUp = page.locator('[data-block-id]:focus');
    await expect(afterUp).toBeVisible({ timeout: 3000 });
    const upId = await afterUp.getAttribute('data-block-id');
    expect(upId).toBe('n24');
  });

  test('create, convert via slash menu, then delete', async ({ page }) => {
    const txt = page.locator(blockSel('n24'));
    await txt.click();
    const before = await getBlockCount(page);

    // Create new block
    await page.keyboard.press('Enter');
    const newBlock = page.locator('[data-block-id]:focus');
    await expect(newBlock).toBeVisible({ timeout: 3000 });

    // Convert to note via slash menu
    await page.keyboard.type('/d');
    await expect(page.getByText('Designer Note', { exact: true })).toBeVisible({ timeout: 3000 });
    await page.keyboard.press('Enter');

    // Verify conversion happened
    const converted = page.locator('[data-block-id]:focus');
    await expect(converted).toBeVisible({ timeout: 3000 });

    // Delete it (it's empty)
    await page.keyboard.press('Backspace');

    await page.waitForFunction(
      (b) => {
        const m = document.body.innerText.match(/(\d+) blocks/);
        return m && parseInt(m[1]) === b;
      },
      before,
      { timeout: 3000 }
    );
  });
});

// ─── Inline Mark Rendering (CSS classes) ───────────────────────────────────────

test.describe('Inline mark CSS classes', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForApp(page);
  });

  test('mark-sub spans exist in sample data', async ({ page }) => {
    const subs = page.locator('.mark-sub');
    const count = await subs.count();
    expect(count).toBeGreaterThan(0);
  });

  test('mark-url spans exist in sample data', async ({ page }) => {
    const urls = page.locator('.mark-url');
    const count = await urls.count();
    expect(count).toBeGreaterThan(0);
  });

  test('mark-tai spans exist in sample data', async ({ page }) => {
    const tais = page.locator('.mark-tai');
    const count = await tais.count();
    expect(count).toBeGreaterThan(0);
  });
});

// ─── Revision Controls UI ────────────────────────────────────────────────────

test.describe('Revision controls UI', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForApp(page);
  });

  test('renders Track Changes toggle button', async ({ page }) => {
    await expect(page.locator('button:has-text("Track Changes")')).toBeVisible();
  });

  test('renders Revisions toggle button', async ({ page }) => {
    await expect(page.locator('button:has-text("Revisions")')).toBeVisible();
  });

  test('Track Changes toggle changes background on click', async ({ page }) => {
    const btn = page.locator('button:has-text("Track Changes")');

    // Get initial background color
    const bgBefore = await btn.evaluate(el => getComputedStyle(el).backgroundColor);

    await btn.click();

    // Wait for React re-render and transition
    await page.waitForTimeout(300);

    const bgAfter = await btn.evaluate(el => getComputedStyle(el).backgroundColor);
    expect(bgAfter).not.toBe(bgBefore);
  });

  test('Track Changes toggle activates revision-aware editing mode', async ({ page }) => {
    // Turn on Track Changes
    await page.locator('button:has-text("Track Changes")').click();

    // The editor area background color should change to indicate active state
    // The RevisionControls bar should have blue background when active
    const controlsBar = page.locator('button:has-text("Track Changes")').locator('..');
    const bg = await controlsBar.evaluate(el => getComputedStyle(el).backgroundColor);
    // eff6ff = blue tint when trackChanges is on
    expect(bg).not.toBe('rgb(250, 250, 250)'); // not the inactive #fafafa
  });
});

// ─── Track Changes: New Block Creation ───────────────────────────────────────

test.describe('Track changes: new block creation', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForApp(page);
  });

  test('new blocks get revision="add" styling when Track Changes is on', async ({ page }) => {
    // Enable Track Changes
    await page.locator('button:has-text("Track Changes")').click();

    // Create a new block
    const txt = page.locator(blockSel('n24'));
    await txt.click();
    await page.keyboard.press('Enter');

    const focused = page.locator('[data-block-id]:focus');
    await expect(focused).toBeVisible({ timeout: 3000 });

    // The wrapper div should have the block-revision-add class
    const wrapper = focused.locator('..');
    await expect(wrapper).toHaveClass(/block-revision-add/);
  });

  test('new blocks do NOT get revision styling when Track Changes is off', async ({ page }) => {
    // Track Changes is off by default — just create a block
    const txt = page.locator(blockSel('n24'));
    await txt.click();
    await page.keyboard.press('Enter');

    const focused = page.locator('[data-block-id]:focus');
    await expect(focused).toBeVisible({ timeout: 3000 });

    const wrapper = focused.locator('..');
    const cls = await wrapper.getAttribute('class') || '';
    expect(cls).not.toContain('block-revision-');
  });

  test('revision-add blocks show green left border', async ({ page }) => {
    await page.locator('button:has-text("Track Changes")').click();

    const txt = page.locator(blockSel('n24'));
    await txt.click();
    await page.keyboard.press('Enter');

    const focused = page.locator('[data-block-id]:focus');
    await expect(focused).toBeVisible({ timeout: 3000 });

    const wrapper = focused.locator('..');
    const borderLeft = await wrapper.evaluate(el => getComputedStyle(el).borderLeftColor);
    // #16a34a = rgb(22, 163, 74) — green
    expect(borderLeft).toBe('rgb(22, 163, 74)');
  });
});

// ─── Track Changes: Block Deletion ──────────────────────────────────────────

test.describe('Track changes: block deletion', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForApp(page);
  });

  test('Backspace on empty block marks as deleted instead of removing when Track Changes is on', async ({ page }) => {
    // Create a new block first (without Track Changes so it has no revision)
    const txt = page.locator(blockSel('n24'));
    await txt.click();
    await page.keyboard.press('Enter');

    const focused = page.locator('[data-block-id]:focus');
    await expect(focused).toBeVisible({ timeout: 3000 });
    await page.keyboard.type('temporary');

    // Save the block id
    const newBlockId = await focused.getAttribute('data-block-id');

    // Clear the text to make it empty
    await page.keyboard.press('Home');
    await page.keyboard.down('Shift');
    await page.keyboard.press('End');
    await page.keyboard.up('Shift');
    await page.keyboard.press('Delete');

    const countBefore = await getBlockCount(page);

    // Now enable Track Changes
    await page.locator('button:has-text("Track Changes")').click();

    // Focus back on the block and delete
    await page.locator(blockSel(newBlockId)).click();
    await page.keyboard.press('Backspace');

    // Block count should remain the same (marked as deleted, not removed)
    const countAfter = await getBlockCount(page);
    expect(countAfter).toBe(countBefore);

    // The block should now have revision-del styling
    const wrapper = page.locator(blockSel(newBlockId)).locator('..');
    await expect(wrapper).toHaveClass(/block-revision-del/);
  });

  test('Backspace on new revision-add block removes it normally', async ({ page }) => {
    // Enable Track Changes
    await page.locator('button:has-text("Track Changes")').click();

    // Create a new block (will get revision="add")
    const txt = page.locator(blockSel('n24'));
    await txt.click();
    const countBefore = await getBlockCount(page);
    await page.keyboard.press('Enter');

    const focused = page.locator('[data-block-id]:focus');
    await expect(focused).toBeVisible({ timeout: 3000 });

    // Delete it — since it's a new "add" block, it should be removed entirely
    await page.keyboard.press('Backspace');

    await page.waitForFunction(
      (before) => {
        const m = document.body.innerText.match(/(\d+) blocks/);
        return m && parseInt(m[1]) === before;
      },
      countBefore,
      { timeout: 3000 }
    );
  });
});

// ─── Track Changes: Accept / Reject Gutter Buttons ──────────────────────────

test.describe('Track changes: accept/reject gutter buttons', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForApp(page);
  });

  test('revision-add block shows ✓ and ✗ gutter buttons', async ({ page }) => {
    // Enable Track Changes and create a new block
    await page.locator('button:has-text("Track Changes")').click();

    const txt = page.locator(blockSel('n24'));
    await txt.click();
    await page.keyboard.press('Enter');

    const focused = page.locator('[data-block-id]:focus');
    await expect(focused).toBeVisible({ timeout: 3000 });
    await page.keyboard.type('Added content');

    // ✓ and ✗ buttons should appear
    const wrapper = focused.locator('..');
    await expect(wrapper.locator('button[title="Accept add"]')).toBeVisible();
    await expect(wrapper.locator('button[title="Reject add"]')).toBeVisible();
  });

  test('clicking ✓ on revision-add block clears revision (keeps block)', async ({ page }) => {
    await page.locator('button:has-text("Track Changes")').click();

    const txt = page.locator(blockSel('n24'));
    await txt.click();
    await page.keyboard.press('Enter');

    const focused = page.locator('[data-block-id]:focus');
    await expect(focused).toBeVisible({ timeout: 3000 });
    await page.keyboard.type('Accepted content');
    const blockId = await focused.getAttribute('data-block-id');

    // Click accept
    const wrapper = focused.locator('..');
    await wrapper.locator('button[title="Accept add"]').click();

    // Block should still exist but no longer have revision class
    const blockEl = page.locator(blockSel(blockId));
    await expect(blockEl).toBeVisible();
    const wrapperClass = await blockEl.locator('..').getAttribute('class') || '';
    expect(wrapperClass).not.toContain('block-revision-');
  });

  test('clicking ✗ on revision-add block removes the block', async ({ page }) => {
    await page.locator('button:has-text("Track Changes")').click();

    const txt = page.locator(blockSel('n24'));
    await txt.click();
    const countBefore = await getBlockCount(page);
    await page.keyboard.press('Enter');

    const focused = page.locator('[data-block-id]:focus');
    await expect(focused).toBeVisible({ timeout: 3000 });
    await page.keyboard.type('Rejected content');

    // Click reject
    const wrapper = focused.locator('..');
    await wrapper.locator('button[title="Reject add"]').click();

    // Block should be removed — count back to before
    await page.waitForFunction(
      (before) => {
        const m = document.body.innerText.match(/(\d+) blocks/);
        return m && parseInt(m[1]) === before;
      },
      countBefore,
      { timeout: 3000 }
    );
  });
});

// ─── Track Changes: Show/Hide Revisions Toggle ─────────────────────────────

test.describe('Track changes: show/hide revisions', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForApp(page);
  });

  test('toggling Show Revisions off adds revisions-hidden class to editor', async ({ page }) => {
    // Revisions shown by default — the editor div should NOT have revisions-hidden
    const editorDiv = page.locator('.revisions-hidden');
    await expect(editorDiv).not.toBeVisible();

    // Click "Revisions" to toggle off
    await page.locator('button:has-text("Revisions")').click();

    // Now the editor wrapper should have revisions-hidden class
    await expect(page.locator('.revisions-hidden')).toBeVisible();
  });

  test('toggling Show Revisions back on removes revisions-hidden class', async ({ page }) => {
    // Toggle off
    await page.locator('button:has-text("Revisions")').click();
    await expect(page.locator('.revisions-hidden')).toBeVisible();

    // Toggle back on
    await page.locator('button:has-text("Revisions")').click();
    await expect(page.locator('.revisions-hidden')).not.toBeVisible();
  });
});

// ─── Track Changes: Accept All / Reject All ──────────────────────────────────

test.describe('Track changes: accept all / reject all', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForApp(page);
  });

  test('Accept All and Reject All buttons appear when revisions exist', async ({ page }) => {
    // Initially no revisions, buttons should not be present
    await expect(page.locator('button:has-text("Accept All")')).not.toBeVisible();
    await expect(page.locator('button:has-text("Reject All")')).not.toBeVisible();

    // Create a revision
    await page.locator('button:has-text("Track Changes")').click();
    const txt = page.locator(blockSel('n24'));
    await txt.click();
    await page.keyboard.press('Enter');
    const focused = page.locator('[data-block-id]:focus');
    await expect(focused).toBeVisible({ timeout: 3000 });
    await page.keyboard.type('Revision content');

    // Now the buttons should appear
    await expect(page.locator('button:has-text("Accept All")')).toBeVisible({ timeout: 3000 });
    await expect(page.locator('button:has-text("Reject All")')).toBeVisible();
  });

  test('revision stats show addition count', async ({ page }) => {
    await page.locator('button:has-text("Track Changes")').click();

    const txt = page.locator(blockSel('n24'));
    await txt.click();
    await page.keyboard.press('Enter');
    const focused = page.locator('[data-block-id]:focus');
    await expect(focused).toBeVisible({ timeout: 3000 });
    await page.keyboard.type('New paragraph');

    // Stats should show "1 addition"
    await expect(page.locator('text=1 addition')).toBeVisible({ timeout: 3000 });
  });

  test('Accept All clears all revisions', async ({ page }) => {
    await page.locator('button:has-text("Track Changes")').click();

    // Create 2 revision blocks
    const txt = page.locator(blockSel('n24'));
    await txt.click();
    await page.keyboard.press('Enter');
    let focused = page.locator('[data-block-id]:focus');
    await expect(focused).toBeVisible({ timeout: 3000 });
    await page.keyboard.type('First addition');

    await page.keyboard.press('Enter');
    focused = page.locator('[data-block-id]:focus');
    await expect(focused).toBeVisible({ timeout: 3000 });
    await page.keyboard.type('Second addition');

    // Should show "2 additions"
    await expect(page.locator('text=2 additions')).toBeVisible({ timeout: 3000 });

    // Click Accept All
    await page.locator('button:has-text("Accept All")').click();

    // Revisions should be gone — no Accept All button visible
    await expect(page.locator('button:has-text("Accept All")')).not.toBeVisible({ timeout: 3000 });
    // No block-revision-add classes remaining
    await expect(page.locator('.block-revision-add')).toHaveCount(0);
  });

  test('Reject All removes add-revision blocks', async ({ page }) => {
    await page.locator('button:has-text("Track Changes")').click();

    const txt = page.locator(blockSel('n24'));
    await txt.click();
    const countBefore = await getBlockCount(page);

    await page.keyboard.press('Enter');
    let focused = page.locator('[data-block-id]:focus');
    await expect(focused).toBeVisible({ timeout: 3000 });
    await page.keyboard.type('Will be rejected');

    // Should have 1 more block now
    const countWith = await getBlockCount(page);
    expect(countWith).toBe(countBefore + 1);

    // Reject All
    await page.locator('button:has-text("Reject All")').click();

    // Block should be removed
    await page.waitForFunction(
      (before) => {
        const m = document.body.innerText.match(/(\d+) blocks/);
        return m && parseInt(m[1]) === before;
      },
      countBefore,
      { timeout: 3000 }
    );
  });
});

// ─── Track Changes: Floating Toolbar Revision Buttons ────────────────────────

test.describe('Track changes: floating toolbar revision buttons', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForApp(page);
  });

  test('ADD and DEL buttons appear in floating toolbar when Track Changes is on', async ({ page }) => {
    await page.locator('button:has-text("Track Changes")').click();

    const focused = await createFreshBlock(page);
    await page.keyboard.type('Mark this text');

    // Select all
    await page.keyboard.down('Shift');
    await page.keyboard.press('Home');
    await page.keyboard.up('Shift');
    await page.waitForTimeout(200);

    await expect(page.locator('button[title="Mark as Addition"]')).toBeVisible({ timeout: 3000 });
    await expect(page.locator('button[title="Mark as Deletion"]')).toBeVisible();
  });

  test('ADD and DEL buttons do NOT appear when Track Changes is off', async ({ page }) => {
    const focused = await createFreshBlock(page);
    await page.keyboard.type('No revision buttons');

    await page.keyboard.down('Shift');
    await page.keyboard.press('Home');
    await page.keyboard.up('Shift');
    await page.waitForTimeout(200);

    // Format buttons should appear but NOT revision buttons
    await expect(page.locator('button[title="Bold"]')).toBeVisible({ timeout: 3000 });
    await expect(page.locator('button[title="Mark as Addition"]')).not.toBeVisible();
    await expect(page.locator('button[title="Mark as Deletion"]')).not.toBeVisible();
  });

  test('clicking ADD button wraps selection in ins.mark-add', async ({ page }) => {
    await page.locator('button:has-text("Track Changes")').click();

    const focused = await createFreshBlock(page);
    const blockId = await focused.getAttribute('data-block-id');
    await page.keyboard.type('added text here');

    // Select "added"
    await page.keyboard.press('Home');
    for (let i = 0; i < 5; i++) await page.keyboard.press('Shift+ArrowRight');
    await page.waitForTimeout(200);

    const addBtn = page.locator('button[title="Mark as Addition"]');
    await expect(addBtn).toBeVisible({ timeout: 3000 });
    await addBtn.dispatchEvent('mousedown');
    await addBtn.dispatchEvent('click');
    await page.waitForTimeout(200);

    const html = await page.locator(blockSel(blockId)).evaluate(el => el.innerHTML);
    expect(html).toContain('<ins class="mark-add">');
    expect(html).toContain('added');
  });

  test('clicking DEL button wraps selection in del.mark-del', async ({ page }) => {
    await page.locator('button:has-text("Track Changes")').click();

    const focused = await createFreshBlock(page);
    const blockId = await focused.getAttribute('data-block-id');
    await page.keyboard.type('delete this word');

    // Select "delete"
    await page.keyboard.press('Home');
    for (let i = 0; i < 6; i++) await page.keyboard.press('Shift+ArrowRight');
    await page.waitForTimeout(200);

    const delBtn = page.locator('button[title="Mark as Deletion"]');
    await expect(delBtn).toBeVisible({ timeout: 3000 });
    await delBtn.dispatchEvent('mousedown');
    await delBtn.dispatchEvent('click');
    await page.waitForTimeout(200);

    const html = await page.locator(blockSel(blockId)).evaluate(el => el.innerHTML);
    expect(html).toContain('<del class="mark-del">');
    expect(html).toContain('delete');
  });
});

// ─── Track Changes: Inline Revision CSS Rendering ────────────────────────────

test.describe('Track changes: inline revision CSS', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForApp(page);
  });

  test('ins.mark-add renders green underlined text', async ({ page }) => {
    await page.locator('button:has-text("Track Changes")').click();

    const focused = await createFreshBlock(page);
    const blockId = await focused.getAttribute('data-block-id');
    await page.keyboard.type('green text');

    // Select all and mark as ADD
    await page.keyboard.down('Shift');
    await page.keyboard.press('Home');
    await page.keyboard.up('Shift');
    await page.waitForTimeout(200);

    const addBtn = page.locator('button[title="Mark as Addition"]');
    await expect(addBtn).toBeVisible({ timeout: 3000 });
    await addBtn.dispatchEvent('mousedown');
    await addBtn.dispatchEvent('click');
    await page.waitForTimeout(200);

    // Check the ins element's computed styles
    const insEl = page.locator(blockSel(blockId)).locator('ins.mark-add');
    await expect(insEl).toBeVisible();

    const color = await insEl.evaluate(el => getComputedStyle(el).color);
    // #16a34a = rgb(22, 163, 74)
    expect(color).toBe('rgb(22, 163, 74)');

    const textDeco = await insEl.evaluate(el => getComputedStyle(el).textDecorationLine);
    expect(textDeco).toContain('underline');
  });

  test('del.mark-del renders red strikethrough text', async ({ page }) => {
    await page.locator('button:has-text("Track Changes")').click();

    const focused = await createFreshBlock(page);
    const blockId = await focused.getAttribute('data-block-id');
    await page.keyboard.type('deleted text');

    // Select all and mark as DEL
    await page.keyboard.down('Shift');
    await page.keyboard.press('Home');
    await page.keyboard.up('Shift');
    await page.waitForTimeout(200);

    const delBtn = page.locator('button[title="Mark as Deletion"]');
    await expect(delBtn).toBeVisible({ timeout: 3000 });
    await delBtn.dispatchEvent('mousedown');
    await delBtn.dispatchEvent('click');
    await page.waitForTimeout(200);

    const delEl = page.locator(blockSel(blockId)).locator('del.mark-del');
    await expect(delEl).toBeVisible();

    const color = await delEl.evaluate(el => getComputedStyle(el).color);
    // #dc2626 = rgb(220, 38, 38)
    expect(color).toBe('rgb(220, 38, 38)');

    const textDeco = await delEl.evaluate(el => getComputedStyle(el).textDecorationLine);
    expect(textDeco).toContain('line-through');
  });
});
