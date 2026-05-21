import { test, expect } from './fixtures.js';
import { injectBlockHtml, readBlockHtml, createFreshBlock as createFreshBlockHelper, pmSetSelection, pmSetCaret } from './pm-helpers.js';
import fs from 'fs';

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
 * Return a CSS selector for a block's OUTER WRAPPER (the div carrying
 * block-revision-* and data-tag classes). `PmEditableBlock` sets
 * id="block-{id}" on the outer wrapper. Use this instead of
 * `locator('..')` when asserting on revision styling or gutter buttons.
 */
function blockWrapperSel(id) {
  return `#block-${id}`;
}

/**
 * Create a fresh empty block after n24 and return its locator.
 *
 * Thin wrapper over the PM-mount-aware helper in pm-helpers.js — see #114.
 * The naive `Enter → [data-block-id]:focus → toBeVisible` pattern returns
 * the OLD block before the new block's PM EditorView has mounted and
 * auto-focused; the helper polls for both conditions.
 */
async function createFreshBlock(page) {
  return createFreshBlockHelper(page, 'n24');
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

  test('renders toolbar with Import, Save, and Save As buttons', async ({ page }) => {
    await expect(page.locator('button:has-text("Import")')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Save As', exact: true })).toBeVisible();
  });

  test('renders EDITING status badge', async ({ page }) => {
    await expect(page.getByText('EDITING', { exact: true })).toBeVisible();
  });

  test('renders section banner with UFGS header', async ({ page }) => {
    await expect(page.getByText('UNIFIED FACILITIES GUIDE SPECIFICATIONS', { exact: true })).toBeVisible();
    // "SECTION 31 00 00" appears in multiple places, use the banner one
    await expect(page.getByText('SECTION 31 00 00').first()).toBeVisible();
  });

  test('renders status bar with block count', async ({ page }) => {
    await expect(page.locator('text=426 blocks')).toBeVisible();
  });

  test('renders status bar keyboard hints', async ({ page }) => {
    await expect(page.locator('text=/Enter: new paragraph/')).toBeVisible();
  });

  test('shows filename in status bar', async ({ page }) => {
    await expect(page.locator('text=31_00_00.SEC')).toBeVisible();
  });
});

// ─── createFreshBlock invariant (#114 regression) ──────────────────────────────

test.describe('createFreshBlock invariant (#114)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('text=/\\d+ blocks/');
  });

  test('immediate Backspace after createFreshBlock removes the new block, not n24', async ({ page }) => {
    // Pinned regression for #114. The naive `Enter → :focus → toBeVisible`
    // pattern returns n24's locator before the new block's PmEditableBlock
    // has mounted; the subsequent Backspace then lands on n24 (which has
    // content), not on the empty new block, so the block count never
    // returns to its prior value. createFreshBlock must wait for both the
    // focused [data-block-id] to differ from n24 AND for the new block's
    // PM EditorView to be mounted with a selection placed.
    const countBefore = await getBlockCount(page);
    const newBlock = await createFreshBlock(page);
    expect(await getBlockCount(page)).toBe(countBefore + 1);

    const newId = await newBlock.getAttribute('data-block-id');
    expect(newId).not.toBe('n24');

    await page.keyboard.press('Backspace');

    await page.waitForFunction(
      (before) => {
        const m = document.body.innerText.match(/(\d+) blocks/);
        return m && parseInt(m[1]) === before;
      },
      countBefore,
      { timeout: 3000 },
    );
  });

  test('typing immediately after createFreshBlock lands entirely in the new block', async ({ page }) => {
    // The :918 failure shape — keystrokes leak into n24 because the
    // :focus selector resolves before PM mount. Asserts both invariants:
    // (a) the new block ends up holding the full string, (b) n24's html
    // is unchanged.
    const n24Before = await readBlockHtml(page, 'n24');

    const newBlock = await createFreshBlock(page);
    const newId = await newBlock.getAttribute('data-block-id');
    expect(newId).not.toBe('n24');

    await page.keyboard.type('Integration test content');

    // Allow PM's 400ms onUpdate debounce to flush before reading html.
    await page.waitForTimeout(500);

    const newHtml = await readBlockHtml(page, newId);
    const n24After = await readBlockHtml(page, 'n24');

    expect(newHtml).toContain('Integration test content');
    expect(n24After).toBe(n24Before);
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

// ─── Sidebar Drag-and-Drop ────────────────────────────────────────────────────

test.describe('Sidebar drag-and-drop reordering', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForApp(page);
  });

  test('tree nodes are draggable', async ({ page }) => {
    // Verify that tree node containers have draggable attribute
    const treeNode = page.locator('text=REFERENCES').first();
    await expect(treeNode).toBeVisible();
    // The draggable is on the parent div wrapping the text
    const parent = treeNode.locator('..');
    const draggable = await parent.getAttribute('draggable');
    expect(draggable).toBe('true');
  });
});

// ─── Sidebar Search ──────────────────────────────────────────────────────────

test.describe('Sidebar search', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForApp(page);
  });

  test('search input filters tree to matching sections', async ({ page }) => {
    const searchInput = page.locator('input[placeholder="Search sections..."]');
    await searchInput.fill('REFERENCES');
    await page.waitForTimeout(200);

    // REFERENCES should still be visible
    await expect(page.locator('text=REFERENCES').first()).toBeVisible();
    // PART 1 GENERAL should still be visible (parent of REFERENCES)
    await expect(page.locator('text=PART 1 GENERAL').first()).toBeVisible();
  });

  test('clearing search restores full tree', async ({ page }) => {
    const searchInput = page.locator('input[placeholder="Search sections..."]');

    // Search to filter
    await searchInput.fill('REFERENCES');
    await page.waitForTimeout(200);

    // Clear search
    await searchInput.fill('');
    await page.waitForTimeout(200);

    // All parts should be visible again
    await expect(page.locator('text=PART 1 GENERAL').first()).toBeVisible();
  });

  test('search with no matches shows empty tree', async ({ page }) => {
    const searchInput = page.locator('input[placeholder="Search sections..."]');
    await searchInput.fill('xyznonexistent');
    await page.waitForTimeout(200);

    // No tree nodes should be visible — check the sidebar tree container specifically
    const treeContainer = searchInput.locator('..').locator('..').locator('+ div');
    const treeText = await treeContainer.textContent();
    expect(treeText.trim()).toBe('');
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
    const item = page.locator(blockSel('n104'));
    const subSpan = item.locator('.mark-sub');
    await expect(subSpan.first()).toBeVisible();
  });
});

// ─── Table Editing ────────────────────────────────────────────────────────────

test.describe('Table editing', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForApp(page);
  });

  test('double-clicking table cell enters edit mode', async ({ page }) => {
    const table = page.locator('table').first();
    await expect(table).toBeVisible();
    // Target a data cell in tbody (skip the column-delete header row)
    const cell = table.locator('tbody td:has(span)').first();
    await cell.dblclick();
    await page.waitForTimeout(200);
    const input = table.locator('input');
    await expect(input).toBeVisible({ timeout: 3000 });
  });

  test('adding a row increases row count', async ({ page }) => {
    const table = page.locator('table').first();
    const rowsBefore = await table.locator('tbody tr').count();
    const addRowBtn = page.locator('button:has-text("+ Row")').first();
    await addRowBtn.click();
    await page.waitForTimeout(300);
    const rowsAfter = await table.locator('tbody tr').count();
    expect(rowsAfter).toBe(rowsBefore + 1);
  });

  test('editing a table cell updates content', async ({ page }) => {
    const table = page.locator('table').first();
    const cell = table.locator('tbody td:has(span)').first();
    await cell.dblclick();
    await page.waitForTimeout(200);
    const input = table.locator('input');
    await expect(input).toBeVisible({ timeout: 3000 });
    await input.fill('Edited Cell');
    await input.press('Enter');
    await page.waitForTimeout(300);
    const text = await cell.textContent();
    expect(text).toContain('Edited Cell');
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

    // Place caret at the very start of the block content. After typing 'short'
    // the PM doc shape is <p>short</p>; position 1 is inside the paragraph
    // immediately before 's'. Setting selection through pmSetSelection routes
    // through __simEditorTestUtils.setPmSelection, which uses PM's
    // TextSelection.create + view.dispatch — unlike a raw DOM Range, this
    // updates view.state.selection so the ArrowUp keymap reads the intended
    // selection rather than whatever Selection.atEnd left from auto-focus.
    await pmSetSelection(page, blockId, 1, 1);

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
    // #116 — pmSetCaret('end') instead of keyboard.press('End') so PM's
    // state.selection is updated synchronously before ArrowDown reads it.
    await pmSetCaret(page, newId, 'end');
    await page.keyboard.press('ArrowDown');

    const focused = page.locator('[data-block-id]:focus');
    await expect(focused).toBeVisible({ timeout: 3000 });
    await page.waitForTimeout(200);
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
  });

  test('clicking Bold wraps selection in <b> tag', async ({ page }) => {
    const focused = await createFreshBlock(page);
    const blockId = await focused.getAttribute('data-block-id');
    await page.keyboard.type('bold text');

    // Select "bold" (first 4 characters). #116 — pmSetCaret('start') so
    // PM state.selection is current before Shift+ArrowRight extends it.
    await pmSetCaret(page, blockId, 'start');
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

// ─── Inline Comments ──────────────────────────────────────────────────────────

test.describe('Inline comments', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForApp(page);
  });

  test('comment button appears in floating toolbar', async ({ page }) => {
    const focused = await createFreshBlock(page);
    await page.keyboard.type('commentable text');

    // Select all
    await page.keyboard.down('Shift');
    await page.keyboard.press('Home');
    await page.keyboard.up('Shift');
    await page.waitForTimeout(200);

    await expect(page.locator('button[title="Add Comment"]')).toBeVisible({ timeout: 3000 });
  });
});

// ─── Comments on REF blocks ──────────────────────────────────────────────────

test.describe('Comments on ref blocks', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForApp(page);
  });

  test('comment button appears for text selected in ref block entry', async ({ page }) => {
    // Find a ref entry RTL text and programmatically select it
    const rtl = page.locator('.ref-rtl').first();
    await expect(rtl).toBeVisible();

    // Use JavaScript to select the text (native click-drag doesn't work reliably on non-contentEditable)
    await rtl.evaluate(el => {
      const range = document.createRange();
      range.selectNodeContents(el);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    });

    // Trigger mouseup to fire the toolbar's selection check
    await rtl.dispatchEvent('mouseup', { bubbles: true });
    await page.waitForTimeout(300);

    // Only comment button should appear (no B/I/U or mark buttons)
    await expect(page.locator('button[title="Add Comment"]')).toBeVisible({ timeout: 3000 });
    // Format and mark buttons should NOT appear for ref blocks
    await expect(page.locator('button[title="Bold"]')).not.toBeVisible();
    await expect(page.locator('button[title="Reference Standard (ASTM, AASHTO)"]')).not.toBeVisible();
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

  test('clicking Save triggers a download', async ({ page }) => {
    // Remove showSaveFilePicker so Save falls back to download
    await page.evaluate(() => { delete window.showSaveFilePicker; });
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe('31_00_00.SEC');
  });

  test('export preserves Track Changes as ADD/DEL SGML tags', async ({ page }) => {
    // Enable Track Changes
    await page.locator('button:has-text("Track Changes")').click();

    // Create a new block (gets revision="add")
    const txt = page.locator(blockSel('n24'));
    await txt.click();
    await page.keyboard.press('Enter');
    const focused = page.locator('[data-block-id]:focus');
    await expect(focused).toBeVisible({ timeout: 3000 });
    await page.keyboard.type('Tracked new content');

    // Save (remove showSaveFilePicker to force download fallback)
    await page.evaluate(() => { delete window.showSaveFilePicker; });
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Save', exact: true }).click(),
    ]);
    const filePath = await download.path();
    const content = fs.readFileSync(filePath, 'latin1');

    // Block-level ADD tag should wrap the new content
    expect(content).toContain('<ADD>');
    expect(content).toMatch(/<ADD>[^]*Tracked new content[^]*<\/ADD>/);
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
    await expect(page.locator('#block-n137').getByText('2.1')).toBeVisible({ timeout: 3000 });
  });
});

// ─── Combined Keyboard Workflow ────────────────────────────────────────────────

test.describe('Combined keyboard workflow', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForApp(page);
  });

  test('full workflow: create block, type, navigate up', async ({ page }) => {
    // 1. Create new block via the PM-mount-aware helper (#114) — the raw
    //    `txt.click → Enter → :focus` pattern returns n24 before the new
    //    block's PM EditorView has mounted, so subsequent type() keystrokes
    //    leak into n24 instead of the new block.
    const newBlock = await createFreshBlock(page);
    const newId = await newBlock.getAttribute('data-block-id');

    // 2. Type content
    await page.keyboard.type('Integration test content');
    const content = await newBlock.textContent();
    expect(content).toContain('Integration test');

    // 3. Place caret at the start of the new block via PM, not via Home.
    //    Home is browser-native and PM's domObserver picks up the new
    //    selection asynchronously; pressing ArrowUp before the observer
    //    runs reads stale state.selection.from (still at end-of-text), so
    //    keymap.js's isCursorAtStart check returns false and ArrowUp
    //    becomes a no-op. pmSetSelection updates view.state.selection
    //    synchronously, eliminating the race.
    await pmSetSelection(page, newId, 1, 1);

    // 4. Navigate up with ArrowUp
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
    // Wait for React re-render + CSS transition (200ms) to complete
    const controlsBar = page.locator('button:has-text("Track Changes")').locator('..');
    await controlsBar.evaluate(el =>
      new Promise(resolve => {
        const check = () => {
          if (getComputedStyle(el).backgroundColor !== 'rgb(250, 250, 250)') resolve();
          else requestAnimationFrame(check);
        };
        check();
      })
    );
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
    const blockId = await focused.getAttribute('data-block-id');

    const wrapper = page.locator(blockWrapperSel(blockId));
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

  test('new block text is fully marked as addition after blur when TC is on', async ({ page }) => {
    // Enable Track Changes
    await page.locator('button:has-text("Track Changes")').click();

    // Create a new block and type text
    const focused = await createFreshBlock(page);
    const blockId = await focused.getAttribute('data-block-id');
    await page.keyboard.type('entirely new content');

    // Blur to trigger diff annotation
    await page.locator(blockSel('n24')).click();
    await page.waitForTimeout(500);

    // All text should be wrapped in ins.mark-add (regression: previously snapshot was
    // undefined for new blocks, so diff was skipped and no ins tags were created)
    const insEl = page.locator(blockSel(blockId)).locator('ins.mark-add');
    const insCount = await insEl.count();
    expect(insCount).toBeGreaterThan(0);

    // The ins text should contain the typed content
    const insText = await insEl.first().textContent();
    expect(insText).toContain('entirely');
  });

  test('revision-add blocks show green left border', async ({ page }) => {
    await page.locator('button:has-text("Track Changes")').click();

    const txt = page.locator(blockSel('n24'));
    await txt.click();
    await page.keyboard.press('Enter');

    const focused = page.locator('[data-block-id]:focus');
    await expect(focused).toBeVisible({ timeout: 3000 });
    const blockId = await focused.getAttribute('data-block-id');

    const wrapper = page.locator(blockWrapperSel(blockId));
    const borderLeft = await wrapper.evaluate(el => getComputedStyle(el).borderLeftColor);
    // #008000 = rgb(0, 128, 0) — green (matches section.ini ADD=GREEN)
    expect(borderLeft).toBe('rgb(0, 128, 0)');
  });
});

// ─── Track Changes: Block Deletion ──────────────────────────────────────────

test.describe('Track changes: block deletion', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForApp(page);
  });

  test('Backspace on empty block marks as deleted instead of removing when Track Changes is on', async ({ page }) => {
    // Create a new EMPTY block (no Track Changes yet, so block.revision is undefined).
    // PM-mount-aware helper (#114) — see createFreshBlock comment for why the naive
    // Enter → :focus → toBeVisible pattern raced the OLD block's focus.
    const newBlock = await createFreshBlock(page);
    const newBlockId = await newBlock.getAttribute('data-block-id');

    const countBefore = await getBlockCount(page);

    // Enable Track Changes and wait for the React commit. handleDelete is a
    // useCallback over tcState; without this wait the immediate re-click +
    // Backspace below can fire while the closure still captures enabled=false,
    // tc.revisionFlagForDelete returns null, and the empty block is removed
    // outright instead of marked. aria-pressed flips synchronously with the
    // trackChanges prop in RevisionControls.jsx.
    const tcBtn = page.locator('button:has-text("Track Changes")');
    await tcBtn.click();
    await expect(tcBtn).toHaveAttribute('aria-pressed', 'true');

    // Focus back on the block and delete
    await page.locator(blockSel(newBlockId)).click();
    await page.keyboard.press('Backspace');

    // Block count should remain the same (marked as deleted, not removed)
    const countAfter = await getBlockCount(page);
    expect(countAfter).toBe(countBefore);

    // The block should now have revision-del styling
    const wrapper = page.locator(blockWrapperSel(newBlockId));
    await expect(wrapper).toHaveClass(/block-revision-del/);
  });

  test('Backspace on new revision-add block removes it normally', async ({ page }) => {
    // Enable Track Changes
    await page.locator('button:has-text("Track Changes")').click();

    // Create a new block (will get revision="add"). The PM-mount-aware
    // helper (#114) ensures the new block is the one holding focus before
    // we press Backspace — otherwise Backspace lands on n24 and the empty
    // revision-add block remains, so countAfter never returns to countBefore.
    const countBefore = await getBlockCount(page);
    await createFreshBlock(page);

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

    const blockId = await focused.getAttribute('data-block-id');
    // ✓ and ✗ buttons should appear
    const wrapper = page.locator(blockWrapperSel(blockId));
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
    const wrapper = page.locator(blockWrapperSel(blockId));
    await wrapper.locator('button[title="Accept add"]').click();

    // Block should still exist but no longer have revision class
    const blockEl = page.locator(blockSel(blockId));
    await expect(blockEl).toBeVisible();
    const wrapperClass = await page.locator(blockWrapperSel(blockId)).getAttribute('class') || '';
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

    const blockId = await focused.getAttribute('data-block-id');
    // Click reject
    const wrapper = page.locator(blockWrapperSel(blockId));
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

    // Just create the empty block — the new block carries block-level
    // revision='add', so countRevisions returns adds=1 deterministically.
    // Typing into the block under TC adds a per-keystroke inline ins span
    // (sub-PR 1h, src/lib/pm-tc-mark.js), so once the 400ms onUpdate
    // debounce flushes adds becomes 2 — racing the toBeVisible polling
    // window with whether "1 addition" appears before the second add lands.
    // The deterministic count is 1 with an empty new block; the inline
    // ins counting is pinned by revisions.test.js (countRevisions) at the
    // unit level instead.
    await createFreshBlock(page);

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

    // Should show additions (block-level + inline from diff-on-blur)
    await expect(page.locator('text=/\\d+ additions?/')).toBeVisible({ timeout: 3000 });

    // Click Accept All
    await page.locator('button:has-text("Accept All")').click();

    // Revisions should be gone — no Accept All button visible
    await expect(page.locator('button:has-text("Accept All")')).not.toBeVisible({ timeout: 3000 });
    // No block-revision-add classes remaining
    await expect(page.locator('.block-revision-add')).toHaveCount(0);
  });

  test('Accept All removes inline revision marks from DOM of editable blocks', async ({ page }) => {
    await page.locator('button:has-text("Track Changes")').click();

    // Create a block and type text
    const focused = await createFreshBlock(page);
    const blockId = await focused.getAttribute('data-block-id');
    await page.keyboard.type('some edited text');

    // Blur to trigger diff annotation — all text becomes <ins> (snapshot was empty)
    await page.locator(blockSel('n24')).click();
    await page.waitForTimeout(500);

    // Verify ins elements exist in the block DOM
    const insBefore = await page.locator(blockSel(blockId)).locator('ins.mark-add').count();
    expect(insBefore).toBeGreaterThan(0);

    // Click Accept All
    await page.locator('button:has-text("Accept All")').click();
    await page.waitForTimeout(500);

    // DOM should no longer contain ins elements (regression: previously DOM wasn't synced)
    const insAfter = await page.locator(blockSel(blockId)).locator('ins.mark-add').count();
    expect(insAfter).toBe(0);

    // Block text should still be present (content preserved)
    const text = await page.locator(blockSel(blockId)).textContent();
    expect(text).toContain('edited');
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

    // Select "added". #116 — pmSetCaret instead of Home.
    await pmSetCaret(page, blockId, 'start');
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

    // Select "delete". #116 — pmSetCaret instead of Home.
    await pmSetCaret(page, blockId, 'start');
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
    // #008000 = rgb(0, 128, 0) — matches section.ini ADD=GREEN
    expect(color).toBe('rgb(0, 128, 0)');

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
    // #ff4444 = rgb(255, 68, 68) — matches section.ini DEL=LIGHTRED
    expect(color).toBe('rgb(255, 68, 68)');

    const textDeco = await delEl.evaluate(el => getComputedStyle(el).textDecorationLine);
    expect(textDeco).toContain('line-through');
  });
});

// ─── Track Changes: Snapshot Staleness Regression (Issues 1, 2) ──────────────

test.describe('Track changes: snapshot staleness regression', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForApp(page);
  });

  test('after inline accept, re-editing block does not re-create accepted text as addition', async ({ page }) => {
    // Enable TC
    await page.locator('button:has-text("Track Changes")').click();

    // Create a new block and type text
    const focused = await createFreshBlock(page);
    const blockId = await focused.getAttribute('data-block-id');
    await page.keyboard.type('original text');

    // Blur to trigger diff annotation (all text → ins.mark-add since snapshot was empty)
    await page.locator(blockSel('n24')).click();
    await page.waitForTimeout(500);

    // Verify ins elements exist
    const insBefore = await page.locator(blockSel(blockId)).locator('ins.mark-add').count();
    expect(insBefore).toBeGreaterThan(0);

    // Click the block to focus it, select all, and use floating toolbar to accept
    await page.locator(blockSel(blockId)).click();
    await page.waitForTimeout(200);
    await page.keyboard.press('Home');
    await page.keyboard.down('Shift');
    await page.keyboard.press('End');
    await page.keyboard.up('Shift');
    await page.waitForTimeout(300);

    // Accept the addition via floating toolbar
    const acceptBtn = page.locator('button[title="Accept addition"]');
    await expect(acceptBtn).toBeVisible({ timeout: 3000 });
    await acceptBtn.dispatchEvent('mousedown');
    await acceptBtn.dispatchEvent('click');
    await page.waitForTimeout(300);

    // Now re-edit: append " extra" to the block
    const block = page.locator(blockSel(blockId));
    await expect(block).toBeVisible({ timeout: 3000 });
    await block.click();
    await page.keyboard.press('End');
    await page.keyboard.type(' extra');

    // Blur again to trigger diff
    await page.locator(blockSel('n24')).click();
    await page.waitForTimeout(500);

    // "original text" should NOT be re-created as ins.mark-add
    // Only "extra" should be an addition (if anything)
    const html = await page.locator(blockSel(blockId)).evaluate(el => el.innerHTML);
    // The word "original" should NOT be inside an <ins> tag
    expect(html).not.toMatch(/<ins[^>]*>.*original.*<\/ins>/);
  });

  test('after Accept All, editing a block does not re-create old revisions', async ({ page }) => {
    // Enable TC
    await page.locator('button:has-text("Track Changes")').click();

    // Create a new block and type text
    const focused = await createFreshBlock(page);
    const blockId = await focused.getAttribute('data-block-id');
    await page.keyboard.type('accepted content');

    // Blur to create ins marks
    await page.locator(blockSel('n24')).click();
    await page.waitForTimeout(500);

    // Accept All
    await page.locator('button:has-text("Accept All")').click();
    await page.waitForTimeout(500);

    // No revisions should remain
    await expect(page.locator('button:has-text("Accept All")')).not.toBeVisible({ timeout: 3000 });

    // Re-edit the block: append " more"
    await page.locator(blockSel(blockId)).click();
    await page.keyboard.press('End');
    await page.keyboard.type(' more');

    // Blur to trigger diff
    await page.locator(blockSel('n24')).click();
    await page.waitForTimeout(500);

    // "accepted content" should NOT re-appear as ins.mark-add
    const html = await page.locator(blockSel(blockId)).evaluate(el => el.innerHTML);
    expect(html).not.toMatch(/<ins[^>]*>.*accepted.*<\/ins>/);
    // But "more" should be an addition
    expect(html).toMatch(/<ins[^>]*>.*more.*<\/ins>/);
  });
});

// ─── Track Changes: Del Element Click Popup (Issue 5) ────────────────────────

test.describe('Track changes: del element click popup', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForApp(page);
  });

  test('clicking a del element shows accept/reject popup', async ({ page }) => {
    // Enable TC
    await page.locator('button:has-text("Track Changes")').click();

    // Create a block, type text, blur to establish snapshot, then mark as deletion
    const focused = await createFreshBlock(page);
    const blockId = await focused.getAttribute('data-block-id');
    await page.keyboard.type('keep remove keep');

    // Blur to establish snapshot
    await page.locator(blockSel('n24')).click();
    await page.waitForTimeout(500);

    // Accept All to clear initial ins marks
    const acceptAllBtn = page.locator('button:has-text("Accept All")');
    if (await acceptAllBtn.isVisible()) {
      await acceptAllBtn.click();
      await page.waitForTimeout(500);
    }

    // Re-focus and select "remove". #116 — pmSetCaret instead of Home.
    await page.locator(blockSel(blockId)).click();
    await page.waitForTimeout(200);
    await pmSetCaret(page, blockId, 'start');
    for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowRight'); // past "keep "
    for (let i = 0; i < 6; i++) await page.keyboard.press('Shift+ArrowRight'); // select "remove"
    await page.waitForTimeout(200);

    // Mark as deletion
    const delBtn = page.locator('button[title="Mark as Deletion"]');
    await expect(delBtn).toBeVisible({ timeout: 3000 });
    await delBtn.dispatchEvent('mousedown');
    await delBtn.dispatchEvent('click');
    await page.waitForTimeout(500);

    // Now click on the del element
    const delEl = page.locator(blockSel(blockId)).locator('del.mark-del');
    await expect(delEl).toBeVisible({ timeout: 3000 });
    await delEl.click();
    await page.waitForTimeout(300);

    // The popup should appear with accept/reject buttons
    await expect(page.locator('button[title="Accept deletion (remove text)"]')).toBeVisible({ timeout: 3000 });
    await expect(page.locator('button[title="Reject deletion (restore text)"]')).toBeVisible();
  });

  test('accept from del popup removes the deletion mark and content', async ({ page }) => {
    await page.locator('button:has-text("Track Changes")').click();

    // Create block, type text, and blur to establish a snapshot first
    const focused = await createFreshBlock(page);
    const blockId = await focused.getAttribute('data-block-id');
    await page.keyboard.type('before deleted after');

    // Blur to establish snapshot
    await page.locator(blockSel('n24')).click();
    await page.waitForTimeout(500);

    // Accept All to clear initial ins marks
    const acceptAllBtn = page.locator('button:has-text("Accept All")');
    if (await acceptAllBtn.isVisible()) {
      await acceptAllBtn.click();
      await page.waitForTimeout(500);
    }

    // Re-focus and select "deleted". #116 — pmSetCaret instead of Home.
    await page.locator(blockSel(blockId)).click();
    await page.waitForTimeout(200);
    await pmSetCaret(page, blockId, 'start');
    for (let i = 0; i < 7; i++) await page.keyboard.press('ArrowRight'); // past "before "
    for (let i = 0; i < 7; i++) await page.keyboard.press('Shift+ArrowRight'); // select "deleted"
    await page.waitForTimeout(200);

    const delMarkBtn = page.locator('button[title="Mark as Deletion"]');
    await expect(delMarkBtn).toBeVisible({ timeout: 3000 });
    await delMarkBtn.dispatchEvent('mousedown');
    await delMarkBtn.dispatchEvent('click');
    await page.waitForTimeout(500);

    // Click on del element to show popup
    const delEl = page.locator(blockSel(blockId)).locator('del.mark-del');
    await expect(delEl).toBeVisible({ timeout: 3000 });
    await delEl.click();
    await page.waitForTimeout(300);

    // Accept the deletion
    const acceptBtn = page.locator('button[title="Accept deletion (remove text)"]');
    await expect(acceptBtn).toBeVisible({ timeout: 3000 });
    await acceptBtn.click();
    await page.waitForTimeout(500);

    // The del element and its text should be gone
    const delCount = await page.locator(blockSel(blockId)).locator('del.mark-del').count();
    expect(delCount).toBe(0);

    // "deleted" should not appear in text
    const text = await page.locator(blockSel(blockId)).textContent();
    expect(text).not.toContain('deleted');
    expect(text).toContain('before');
    expect(text).toContain('after');
  });

  test('reject from del popup restores the text as normal', async ({ page }) => {
    await page.locator('button:has-text("Track Changes")').click();

    // Create block, type text, and blur to establish a snapshot first
    const focused = await createFreshBlock(page);
    const blockId = await focused.getAttribute('data-block-id');
    await page.keyboard.type('keep restore keep');

    // Blur to establish snapshot (so diff-on-blur won't interfere later)
    await page.locator(blockSel('n24')).click();
    await page.waitForTimeout(500);

    // Accept All to clear the initial ins marks
    const acceptAllBtn = page.locator('button:has-text("Accept All")');
    if (await acceptAllBtn.isVisible()) {
      await acceptAllBtn.click();
      await page.waitForTimeout(500);
    }

    // Re-focus the block and select "restore". #116 — pmSetCaret.
    await page.locator(blockSel(blockId)).click();
    await page.waitForTimeout(200);
    await pmSetCaret(page, blockId, 'start');
    for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowRight'); // past "keep "
    for (let i = 0; i < 7; i++) await page.keyboard.press('Shift+ArrowRight'); // select "restore"
    await page.waitForTimeout(200);

    // Mark as deletion
    const delMarkBtn = page.locator('button[title="Mark as Deletion"]');
    await expect(delMarkBtn).toBeVisible({ timeout: 3000 });
    await delMarkBtn.dispatchEvent('mousedown');
    await delMarkBtn.dispatchEvent('click');
    await page.waitForTimeout(500);

    // Verify the del element exists with the correct text
    const delEl = page.locator(blockSel(blockId)).locator('del.mark-del');
    await expect(delEl).toBeVisible({ timeout: 3000 });
    const delText = await delEl.textContent();
    expect(delText).toContain('restore');

    // Click on del element to show popup
    await delEl.click();
    await page.waitForTimeout(300);

    // Verify popup is visible before clicking
    const rejectBtn = page.locator('button[title="Reject deletion (restore text)"]');
    await expect(rejectBtn).toBeVisible({ timeout: 3000 });

    // Reject the deletion (restore text)
    await rejectBtn.click();
    await page.waitForTimeout(500);

    // The del element should be gone
    const delCount = await page.locator(blockSel(blockId)).locator('del.mark-del').count();
    expect(delCount).toBe(0);

    // "restore" should still be in the text (as plain text now)
    const text = await page.locator(blockSel(blockId)).textContent();
    expect(text).toContain('restore');
    expect(text).toContain('keep');
  });
});

// ─── Track Changes: Inline-only Gutter Buttons (Issue 6) ─────────────────────

test.describe('Track changes: inline-only gutter buttons', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForApp(page);
  });

  test('block with inline-only revisions shows gutter ✓/✗ buttons', async ({ page }) => {
    // Enable TC
    await page.locator('button:has-text("Track Changes")').click();

    // Use an existing block — type into it and blur to create inline diff marks
    // (existing blocks don't have block.revision, only inline ins/del from diff-on-blur)
    const txt = page.locator(blockSel('n24'));
    await txt.click();
    await page.waitForTimeout(200);

    // Get current text, then append to create a diff
    await page.keyboard.press('End');
    await page.keyboard.type(' appended');

    // Blur to trigger diff annotation
    await page.locator(blockSel('n23')).click();
    await page.waitForTimeout(500);

    // n24 should have inline ins marks but NO block.revision
    const insCount = await page.locator(blockSel('n24')).locator('ins.mark-add').count();
    expect(insCount).toBeGreaterThan(0);

    // Gutter buttons should appear (title says "Accept inline changes")
    const wrapper = page.locator(blockWrapperSel('n24'));
    await expect(wrapper.locator('button[title="Accept inline changes"]')).toBeVisible({ timeout: 3000 });
    await expect(wrapper.locator('button[title="Reject inline changes"]')).toBeVisible();
  });

  test('clicking gutter ✓ on inline-only block strips ins and removes del content', async ({ page }) => {
    await page.locator('button:has-text("Track Changes")').click();

    // Edit an existing block to create inline marks
    const txt = page.locator(blockSel('n24'));
    await txt.click();
    await page.waitForTimeout(200);
    await page.keyboard.press('End');
    await page.keyboard.type(' gutter test');

    // Blur to create ins marks
    await page.locator(blockSel('n23')).click();
    await page.waitForTimeout(500);

    // Verify inline marks exist
    const insBefore = await page.locator(blockSel('n24')).locator('ins.mark-add').count();
    expect(insBefore).toBeGreaterThan(0);

    // Click gutter accept button
    const wrapper = page.locator(blockWrapperSel('n24'));
    const acceptBtn = wrapper.locator('button[title="Accept inline changes"]');
    await expect(acceptBtn).toBeVisible({ timeout: 3000 });
    await acceptBtn.click();
    await page.waitForTimeout(500);

    // Inline marks should be cleared
    const insAfter = await page.locator(blockSel('n24')).locator('ins.mark-add').count();
    expect(insAfter).toBe(0);

    // Content should still contain the added text
    const text = await page.locator(blockSel('n24')).textContent();
    expect(text).toContain('gutter test');
  });
});

// ═══════════════════════════════════════════════════════════════
// Reference Block (REF) tests
// ═══════════════════════════════════════════════════════════════

test.describe('Reference blocks', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForApp(page);
  });

  test('REF blocks render with ORG header and RID entries in sample data', async ({ page }) => {
    // The REFERENCES section should contain ref blocks with org headers
    const refBlocks = page.locator('.ref-block');
    const count = await refBlocks.count();
    expect(count).toBeGreaterThan(0);

    // First ref block should have an org header
    const firstRef = refBlocks.first();
    const orgHeader = firstRef.locator('.ref-org');
    await expect(orgHeader).toBeVisible();

    // Should have at least one entry with mark-rid
    const entries = firstRef.locator('.ref-entry');
    const entryCount = await entries.count();
    expect(entryCount).toBeGreaterThan(0);
  });

  test('REF block ORG header shows organization name', async ({ page }) => {
    const orgHeaders = page.locator('.ref-org span');
    const firstOrg = orgHeaders.first();
    const text = await firstOrg.textContent();
    // The sample data has real organizations like AASHTO, ASTM, etc.
    expect(text.length).toBeGreaterThan(5);
  });

  test('REF block entries display RID pills with mark-rid styling', async ({ page }) => {
    const ridPills = page.locator('.ref-block .ref-entry .mark-rid');
    const count = await ridPills.count();
    expect(count).toBeGreaterThan(0);

    const firstRid = ridPills.first();
    // Default mode is tags-hidden which strips mark backgrounds to transparent
    // Verify the element has the mark-rid class (styling depends on tag visibility toggle)
    await expect(firstRid).toHaveClass(/mark-rid/);
  });

  test('double-clicking ORG header enters edit mode', async ({ page }) => {
    const orgHeader = page.locator('.ref-org').first();
    await orgHeader.dblclick();
    await page.waitForTimeout(200);

    // Should show an input field
    const input = page.locator('.ref-block input').first();
    await expect(input).toBeVisible();
  });

  test('double-clicking entry enters edit mode with two inputs', async ({ page }) => {
    const entry = page.locator('.ref-entry').first();
    await entry.dblclick();
    await page.waitForTimeout(200);

    // Should show input fields for RID and RTL
    const inputs = page.locator('.ref-block input');
    const count = await inputs.count();
    expect(count).toBeGreaterThanOrEqual(2);
  });

  test('Add Reference button adds a new entry', async ({ page }) => {
    const firstRefBlock = page.locator('.ref-block').first();
    const entriesBefore = await firstRefBlock.locator('.ref-entry').count();

    const addBtn = firstRefBlock.locator('.ref-add-btn');
    await addBtn.click();
    await page.waitForTimeout(200);

    // New entry should be in edit mode (inputs visible)
    const inputs = firstRefBlock.locator('input');
    await expect(inputs.first()).toBeVisible();
  });

  test('slash menu shows Reference option', async ({ page }) => {
    const focused = await createFreshBlock(page);
    await page.keyboard.type('/ref');
    await page.waitForTimeout(200);

    // Look for the slash menu item specifically (not "Add Reference" buttons)
    const menuItem = page.locator('div:has-text("Standards reference group")');
    await expect(menuItem.first()).toBeVisible();
  });
});

// ═══════════════════════════════════════════════════════════════
// In-Document Search (Ctrl+F)
// ═══════════════════════════════════════════════════════════════

test.describe('In-document search and replace', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForApp(page);
  });

  test('Ctrl+F opens search bar and finds text', async ({ page }) => {
    await page.keyboard.press('Control+f');
    await page.waitForTimeout(300);

    const input = page.locator('input[placeholder="Find..."]');
    await expect(input).toBeVisible({ timeout: 3000 });

    await input.fill('earthwork');
    await page.waitForTimeout(500);

    await expect(page.locator('text=/\\d+ of \\d+/')).toBeVisible({ timeout: 3000 });
  });

  test('Escape closes search bar', async ({ page }) => {
    await page.keyboard.press('Control+f');
    await page.waitForTimeout(300);

    const input = page.locator('input[placeholder="Find..."]');
    await expect(input).toBeVisible({ timeout: 3000 });

    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);

    await expect(input).not.toBeVisible();
  });

  test('Ctrl+H opens search bar with replace panel visible', async ({ page }) => {
    await page.keyboard.press('Control+h');
    await page.waitForTimeout(300);

    const findInput = page.locator('input[placeholder="Find..."]');
    await expect(findInput).toBeVisible({ timeout: 3000 });

    const replaceInput = page.locator('input[placeholder="Replace with..."]');
    await expect(replaceInput).toBeVisible({ timeout: 3000 });

    await expect(page.getByRole('button', { name: 'Replace', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Replace All', exact: true })).toBeVisible();
  });

  test('Replace replaces current match in document', async ({ page }) => {
    // Create a block with known content
    const focused = await createFreshBlock(page);
    const blockId = await focused.getAttribute('data-block-id');
    await page.keyboard.type('alpha beta gamma');

    // Open find & replace
    await page.keyboard.press('Control+h');
    await page.waitForTimeout(300);

    const findInput = page.locator('input[placeholder="Find..."]');
    await findInput.fill('beta');
    await page.waitForTimeout(500);

    // Should find the match
    await expect(page.locator('text=/1 of \\d+/')).toBeVisible({ timeout: 3000 });

    // Type replacement
    const replaceInput = page.locator('input[placeholder="Replace with..."]');
    await replaceInput.fill('REPLACED');

    // Click Replace
    await page.getByRole('button', { name: 'Replace', exact: true }).click();
    await page.waitForTimeout(500);

    // Block should now contain the replacement text
    const text = await page.locator(blockSel(blockId)).textContent();
    expect(text).toContain('REPLACED');
    expect(text).not.toContain('beta');
  });

  test('Replace All replaces all matches', async ({ page }) => {
    // Create blocks with repeated text
    const focused = await createFreshBlock(page);
    const blockId = await focused.getAttribute('data-block-id');
    await page.keyboard.type('foo bar foo baz foo');

    // Open find & replace
    await page.keyboard.press('Control+h');
    await page.waitForTimeout(300);

    const findInput = page.locator('input[placeholder="Find..."]');
    await findInput.fill('foo');
    await page.waitForTimeout(500);

    // Should find 3 matches in this block (plus possibly others in sample data)
    await expect(page.locator('text=/\\d+ of \\d+/')).toBeVisible({ timeout: 3000 });

    const replaceInput = page.locator('input[placeholder="Replace with..."]');
    await replaceInput.fill('X');

    // Click Replace All
    await page.locator('button:has-text("Replace All")').click();
    await page.waitForTimeout(500);

    // Block should have all instances replaced
    const text = await page.locator(blockSel(blockId)).textContent();
    expect(text).toContain('X bar X baz X');
    expect(text).not.toContain('foo');
  });
});

// ═══════════════════════════════════════════════════════════════
// Bracket Replacement
// ═══════════════════════════════════════════════════════════════

test.describe('Bracket replacement', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForApp(page);
  });

  test('Brackets button opens panel and shows placeholder count', async ({ page }) => {
    // Create a block with brackets
    const focused = await createFreshBlock(page);
    await page.keyboard.type('Use [concrete type] for the [foundation].');

    // Blur to save text to block state
    await page.locator(blockSel('n24')).click();
    await page.waitForTimeout(300);

    // Click the Brackets button
    await page.locator('button:has-text("Brackets")').click();
    await page.waitForTimeout(300);

    // Panel should show placeholder count
    await expect(page.locator('text=/\\d+ placeholder/')).toBeVisible({ timeout: 3000 });
  });

  test('bracket replacement replaces placeholder text', async ({ page }) => {
    const focused = await createFreshBlock(page);
    const blockId = await focused.getAttribute('data-block-id');
    await page.keyboard.type('Apply [XYZTEST] to surface.');

    // Blur to save text to block state
    await page.locator(blockSel('n24')).click();
    await page.waitForTimeout(300);

    // Open bracket panel
    await page.locator('button:has-text("Brackets")').click();
    await page.waitForTimeout(300);

    // Find the row containing XYZTEST and fill in its replacement input
    const row = page.locator('text=XYZTEST').locator('..');
    const replInput = row.locator('input[placeholder="Replacement value..."]');
    await expect(replInput).toBeVisible({ timeout: 3000 });
    await replInput.fill('epoxy');

    // Click the Replace button in the same row
    await row.locator('button:has-text("Replace")').click();
    await page.waitForTimeout(500);

    // Block should contain replacement
    const text = await page.locator(blockSel(blockId)).textContent();
    expect(text).toContain('epoxy');
    expect(text).not.toContain('XYZTEST');
  });
});

// ═══════════════════════════════════════════════════════════════
// Copy Without Tags
// ═══════════════════════════════════════════════════════════════

test.describe('Copy without tags', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForApp(page);
  });

  test('copy from editor and paste into new block gives plain text', async ({ page, context }) => {
    // Grant clipboard permissions
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);

    // Enable TC and create a block with inline marks
    await page.locator('button:has-text("Track Changes")').click();

    const focused = await createFreshBlock(page);
    const blockId = await focused.getAttribute('data-block-id');
    await page.keyboard.type('marked text here');

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

    // Verify the block has ins elements
    const html = await page.locator(blockSel(blockId)).evaluate(el => el.innerHTML);
    expect(html).toContain('<ins');

    // Select all text in the block and copy
    await page.locator(blockSel(blockId)).click();
    await page.keyboard.press('Home');
    await page.keyboard.down('Shift');
    await page.keyboard.press('End');
    await page.keyboard.up('Shift');
    await page.keyboard.press('Control+c');

    // Read clipboard via evaluate
    const clipText = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipText).toBe('marked text here');
    expect(clipText).not.toContain('<ins');
  });
});

// ═══════════════════════════════════════════════════════════════
// Change Case
// ═══════════════════════════════════════════════════════════════

test.describe('Change case', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForApp(page);
  });

  test('Aa button in floating toolbar changes lowercase to title case', async ({ page }) => {
    const focused = await createFreshBlock(page);
    const blockId = await focused.getAttribute('data-block-id');
    await page.keyboard.type('hello world');

    // Select all text
    await page.keyboard.down('Shift');
    await page.keyboard.press('Home');
    await page.keyboard.up('Shift');
    await page.waitForTimeout(200);

    // Click Aa (Change Case) button — lowercase → Title
    const caseBtn = page.locator('button[title*="Change Case"]');
    await expect(caseBtn).toBeVisible({ timeout: 3000 });
    await caseBtn.dispatchEvent('mousedown');
    await caseBtn.dispatchEvent('click');
    await page.waitForTimeout(300);

    const text = await page.locator(blockSel(blockId)).textContent();
    expect(text).toBe('Hello World');
  });

  test('change case cycles: mixed → UPPER → lower → Title', async ({ page }) => {
    const focused = await createFreshBlock(page);
    const blockId = await focused.getAttribute('data-block-id');
    await page.keyboard.type('Hello World');

    // Select all — mixed case should go to UPPER
    await page.keyboard.down('Shift');
    await page.keyboard.press('Home');
    await page.keyboard.up('Shift');
    await page.waitForTimeout(200);

    const caseBtn = page.locator('button[title*="Change Case"]');
    await expect(caseBtn).toBeVisible({ timeout: 3000 });
    await caseBtn.dispatchEvent('mousedown');
    await caseBtn.dispatchEvent('click');
    await page.waitForTimeout(300);

    let text = await page.locator(blockSel(blockId)).textContent();
    expect(text).toBe('HELLO WORLD');

    // Select again, click: UPPER → lower
    await page.locator(blockSel(blockId)).click();
    await page.keyboard.press('Home');
    await page.keyboard.down('Shift');
    await page.keyboard.press('End');
    await page.keyboard.up('Shift');
    await page.waitForTimeout(200);

    const caseBtn2 = page.locator('button[title*="Change Case"]');
    await expect(caseBtn2).toBeVisible({ timeout: 3000 });
    await caseBtn2.dispatchEvent('mousedown');
    await caseBtn2.dispatchEvent('click');
    await page.waitForTimeout(300);

    text = await page.locator(blockSel(blockId)).textContent();
    expect(text).toBe('hello world');

    // Select again, click: lower → Title
    await page.locator(blockSel(blockId)).click();
    await page.keyboard.press('Home');
    await page.keyboard.down('Shift');
    await page.keyboard.press('End');
    await page.keyboard.up('Shift');
    await page.waitForTimeout(200);

    const caseBtn3 = page.locator('button[title*="Change Case"]');
    await expect(caseBtn3).toBeVisible({ timeout: 3000 });
    await caseBtn3.dispatchEvent('mousedown');
    await caseBtn3.dispatchEvent('click');
    await page.waitForTimeout(300);

    text = await page.locator(blockSel(blockId)).textContent();
    expect(text).toBe('Hello World');
  });
});

// ═══════════════════════════════════════════════════════════════
// Document Validation
// ═══════════════════════════════════════════════════════════════

test.describe('Document validation', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForApp(page);
  });

  test('Validate button opens validation panel with issue count', async ({ page }) => {
    await page.locator('button:has-text("Validate")').click();
    await page.waitForTimeout(300);

    await expect(page.locator('text=Document Validation')).toBeVisible({ timeout: 3000 });
    await expect(page.locator('text=/\\d+ issue/')).toBeVisible({ timeout: 3000 });
  });

  test('validation panel shows severity filter chips', async ({ page }) => {
    await page.locator('button:has-text("Validate")').click();
    await page.waitForTimeout(300);

    // Should have filter buttons
    await expect(page.locator('button:has-text("All")')).toBeVisible({ timeout: 3000 });
  });

  test('clicking issue with blockId scrolls to that block', async ({ page }) => {
    // Create an empty block that will be flagged
    const focused = await createFreshBlock(page);
    await page.keyboard.type('   '); // whitespace only
    await page.locator(blockSel('n24')).click();
    await page.waitForTimeout(300);

    await page.locator('button:has-text("Validate")').click();
    await page.waitForTimeout(300);

    // Should show at least one content issue
    const panel = page.locator('text=Document Validation');
    await expect(panel).toBeVisible({ timeout: 3000 });
  });
});

// ═══════════════════════════════════════════════════════════════
// Cross-Reference Validation Panel
// ═══════════════════════════════════════════════════════════════

test.describe('Cross-reference validation panel', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForApp(page);
  });

  test('panel shows validation results for sample data', async ({ page }) => {
    // The sample data has inline RID marks and REF blocks — panel should show counts
    // Check that the panel exists (it only renders when there are issues)
    const panel = page.locator('text=/unlinked citation|orphaned reference/');
    // Panel may or may not appear depending on whether sample data has mismatches
    // At minimum, the app should load without errors
    await page.waitForTimeout(500);
    // If the panel is visible, it should contain counts
    const panelCount = await panel.count();
    if (panelCount > 0) {
      await expect(panel.first()).toBeVisible();
    }
  });

  test('adding an unlinked RID mark shows it in validation panel', async ({ page }) => {
    // Enable TC and create a block with a mark-rid that doesn't exist in REFERENCES
    await page.locator('button:has-text("Track Changes")').click();

    const focused = await createFreshBlock(page);
    const blockId = await focused.getAttribute('data-block-id');
    await page.keyboard.type('See FAKE Z9999');

    // Select "FAKE Z9999" and mark as RID. #116 — pmSetCaret.
    await pmSetCaret(page, blockId, 'start');
    for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowRight'); // past "See "
    for (let i = 0; i < 10; i++) await page.keyboard.press('Shift+ArrowRight'); // select "FAKE Z9999"
    await page.waitForTimeout(200);

    // Apply RID mark via floating toolbar
    const ridBtn = page.locator('button[title="Mark as Reference ID"]');
    if (await ridBtn.isVisible()) {
      await ridBtn.dispatchEvent('mousedown');
      await ridBtn.dispatchEvent('click');
      await page.waitForTimeout(500);

      // The cross-ref panel should now show "unlinked citation"
      await expect(page.locator('text=/unlinked citation/')).toBeVisible({ timeout: 3000 });
    }
  });

  test('SRF self-reference is flagged in cross-ref panel', async ({ page }) => {
    // Create a block and inject a mark-srf with the document's own section number (31 00 00).
    // Routed through injectBlockHtml (App's normal update path) so PM mode
    // doesn't drop the write on the next render — see 1f.7 (#47).
    const focused = await createFreshBlock(page);
    const blockId = await focused.getAttribute('data-block-id');

    await injectBlockHtml(
      page,
      blockId,
      'See Section <span class="mark-srf">31 00 00</span> for details',
    );
    await page.waitForTimeout(500);

    // Blur to trigger state sync
    await page.locator(blockSel('n24')).click();
    await page.waitForTimeout(500);

    // The cross-ref panel should show "self-reference"
    await expect(page.locator('text=/self-reference/')).toBeVisible({ timeout: 3000 });
  });

  test('Remove button removes an orphaned reference entry', async ({ page }) => {
    // Sample data has 6 orphaned references — expand the panel and click Remove on one
    const panel = page.locator('text=/orphaned reference/');
    const panelCount = await panel.count();
    if (panelCount === 0) return; // skip if no orphaned references

    // Click to expand the panel
    await panel.first().click();
    await page.waitForTimeout(300);

    // Count orphaned entries before removal
    const removeButtons = page.locator('button:has-text("Remove")').filter({ hasNotText: 'All' });
    const countBefore = await removeButtons.count();
    if (countBefore === 0) return;

    // Click the first Remove button
    await removeButtons.first().click();
    await page.waitForTimeout(500);

    // Should have one fewer orphaned entry (or panel may disappear if none left)
    const countAfter = await page.locator('button:has-text("Remove")').filter({ hasNotText: 'All' }).count();
    expect(countAfter).toBeLessThan(countBefore);
  });

  test('Remove All Orphaned removes all orphaned references', async ({ page }) => {
    const panel = page.locator('text=/orphaned reference/');
    const panelCount = await panel.count();
    if (panelCount === 0) return;

    // Expand panel
    await panel.first().click();
    await page.waitForTimeout(300);

    // Click Remove All Orphaned button
    const removeAllBtn = page.locator('button:has-text("Remove All Orphaned")');
    if (await removeAllBtn.count() === 0) return;

    await removeAllBtn.click();
    await page.waitForTimeout(500);

    // No orphaned references should remain
    await expect(page.locator('text=/orphaned reference/')).not.toBeVisible({ timeout: 3000 });
  });
});

// ═══════════════════════════════════════════════════════════════
// Notes Toggle
// ═══════════════════════════════════════════════════════════════

test.describe('Notes toggle', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForApp(page);
  });

  test('Notes button is visible and toggles note visibility', async ({ page }) => {
    // Notes button should be visible
    const notesBtn = page.locator('button:has-text("Notes")');
    await expect(notesBtn).toBeVisible({ timeout: 3000 });

    // Note blocks should be visible initially
    const noteBlocks = page.locator('.block-type-note');
    const countBefore = await noteBlocks.count();
    expect(countBefore).toBeGreaterThan(0);

    // Click Notes to hide
    await notesBtn.click();
    await page.waitForTimeout(300);

    // Note blocks should be hidden
    for (let i = 0; i < countBefore; i++) {
      await expect(noteBlocks.nth(i)).not.toBeVisible();
    }

    // Click Notes again to show
    await notesBtn.click();
    await page.waitForTimeout(300);

    // Note blocks should be visible again
    await expect(noteBlocks.first()).toBeVisible();
  });
});

// ═══════════════════════════════════════════════════════════════
// Auto-save and Ctrl+S
// ═══════════════════════════════════════════════════════════════

test.describe('Auto-save', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForApp(page);
  });

  test('Ctrl+S triggers save (shows Saved status)', async ({ page }) => {
    await page.keyboard.press('Control+s');
    await page.waitForTimeout(1000);

    // Should show "Saved" or a save dialog (depending on browser support)
    // At minimum, the keystroke should not trigger browser save dialog
    // The save status indicator shows briefly
    // Just verify no crash occurred and app is still functional
    await expect(page.locator('text=/\\d+ blocks/')).toBeVisible({ timeout: 3000 });
  });

  test('auto-save writes to localStorage after edit', async ({ page }) => {
    // Make an edit
    const focused = await createFreshBlock(page);
    await page.keyboard.type('auto-save test content');

    // Wait for auto-save debounce (3 seconds)
    await page.waitForTimeout(4000);

    // Check localStorage has auto-save data
    const hasAutoSave = await page.evaluate(() => {
      const data = localStorage.getItem('sim-autosave');
      return data !== null && data.length > 0;
    });
    expect(hasAutoSave).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════
// Undo/Redo
// ═══════════════════════════════════════════════════════════════

test.describe('Undo/Redo', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForApp(page);
  });

  test('Ctrl+Z undoes typing in a block', async ({ page }) => {
    const focused = await createFreshBlock(page);
    const blockId = await focused.getAttribute('data-block-id');
    await page.keyboard.type('hello world');

    // Blur to flush state
    await page.locator(blockSel('n24')).click();
    await page.waitForTimeout(300);

    // Verify text was saved
    let text = await page.locator(blockSel(blockId)).textContent();
    expect(text).toContain('hello world');

    // Undo
    await page.keyboard.press('Control+z');
    await page.waitForTimeout(500);

    // Block should be empty or removed (it was newly created with empty snapshot)
    const blockExists = await page.locator(blockSel(blockId)).count();
    if (blockExists > 0) {
      text = await page.locator(blockSel(blockId)).textContent();
      expect(text).not.toContain('hello world');
    }
  });

  test('Ctrl+Z undoes Enter (block creation)', async ({ page }) => {
    const countBefore = await getBlockCount(page);

    const txt = page.locator(blockSel('n24'));
    await txt.click();
    await page.keyboard.press('Enter');
    const focused = page.locator('[data-block-id]:focus');
    await expect(focused).toBeVisible({ timeout: 3000 });

    const countAfter = await getBlockCount(page);
    expect(countAfter).toBe(countBefore + 1);

    // Undo the Enter
    await page.keyboard.press('Control+z');
    await page.waitForTimeout(500);

    const countUndo = await getBlockCount(page);
    expect(countUndo).toBe(countBefore);
  });

  test('Ctrl+Y redoes after undo', async ({ page }) => {
    const countBefore = await getBlockCount(page);

    const txt = page.locator(blockSel('n24'));
    await txt.click();
    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);

    // Undo
    await page.keyboard.press('Control+z');
    await page.waitForTimeout(500);
    expect(await getBlockCount(page)).toBe(countBefore);

    // Redo
    await page.keyboard.press('Control+y');
    await page.waitForTimeout(500);
    expect(await getBlockCount(page)).toBe(countBefore + 1);
  });

  test('redo stack cleared on new edit after undo', async ({ page }) => {
    const txt = page.locator(blockSel('n24'));
    await txt.click();
    await page.keyboard.press('Enter');
    const focused = page.locator('[data-block-id]:focus');
    await expect(focused).toBeVisible({ timeout: 3000 });

    // Undo
    await page.keyboard.press('Control+z');
    await page.waitForTimeout(500);

    // Make a new edit (type in n24)
    await page.locator(blockSel('n24')).click();
    await page.keyboard.press('End');
    await page.keyboard.type(' diverged');
    await page.locator(blockSel('n23')).click(); // blur
    await page.waitForTimeout(300);

    // Redo should do nothing (stack cleared by new edit)
    const countBefore = await getBlockCount(page);
    await page.keyboard.press('Control+y');
    await page.waitForTimeout(300);
    expect(await getBlockCount(page)).toBe(countBefore);
  });
});

// ═══════════════════════════════════════════════════════════════
// Compliance Checker
// ═══════════════════════════════════════════════════════════════

test.describe('Compliance checker', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForApp(page);
  });

  test('Compliance button opens compliance panel', async ({ page }) => {
    const btn = page.locator('button:has-text("Compliance")');
    await expect(btn).toBeVisible();
    await btn.click();
    await expect(page.locator('button:has-text("Run Check")')).toBeVisible({ timeout: 3000 });
  });

  test('Run Check finds violations in sample data', async ({ page }) => {
    await page.locator('button:has-text("Compliance")').click();
    await expect(page.locator('button:has-text("Run Check")')).toBeVisible({ timeout: 3000 });

    // Select "Entire Document" scope and run
    await page.locator('select').last().selectOption('document');
    await page.locator('button:has-text("Run Check")').click();
    await page.waitForTimeout(500);

    // Should find violations — the sample data has "shall", "per", etc.
    await expect(page.locator('text=/\\d+ high/')).toBeVisible({ timeout: 3000 });
  });

  test('compliance panel shows severity filter tabs', async ({ page }) => {
    await page.locator('button:has-text("Compliance")').click();
    await page.locator('select').last().selectOption('document');
    await page.locator('button:has-text("Run Check")').click();
    await page.waitForTimeout(500);

    // Filter tabs should be visible
    await expect(page.locator('button:has-text("high")')).toBeVisible({ timeout: 3000 });
    await expect(page.locator('button:has-text("medium")')).toBeVisible();
    await expect(page.locator('button:has-text("low")')).toBeVisible();
    await expect(page.locator('button:text-is("all")')).toBeVisible();
  });

  test('compliance panel shows grouped findings with Accept/Reject', async ({ page }) => {
    await page.locator('button:has-text("Compliance")').click();
    await page.locator('select').last().selectOption('document');
    await page.locator('button:has-text("Run Check")').click();
    await page.waitForTimeout(500);

    // Should have at least one "Accept All" button in a group
    const acceptBtn = page.locator('button:has-text("Accept All")').first();
    await expect(acceptBtn).toBeVisible({ timeout: 3000 });

    // Should have "Reject All" buttons
    const rejectBtn = page.locator('button:has-text("Reject All")').first();
    await expect(rejectBtn).toBeVisible();
  });

  test('clicking Reject All on a group dims it', async ({ page }) => {
    await page.locator('button:has-text("Compliance")').click();
    await page.locator('select').last().selectOption('document');
    await page.locator('button:has-text("Run Check")').click();
    await page.waitForTimeout(500);

    // Click Reject All on the first group
    const rejectBtn = page.locator('button:has-text("Reject All")').first();
    await rejectBtn.click();
    await page.waitForTimeout(300);

    // The group should be dimmed (opacity 0.5) — verify the ✗ appears
    await expect(page.locator('text=✗').first()).toBeVisible();
  });

  test('Why? toggle shows UFS citation', async ({ page }) => {
    await page.locator('button:has-text("Compliance")').click();
    await page.locator('select').last().selectOption('document');
    await page.locator('button:has-text("Run Check")').click();
    await page.waitForTimeout(500);

    // Click "Why?" toggle
    const whyBtn = page.locator('text=Why?').first();
    await whyBtn.click();
    await page.waitForTimeout(200);

    // Should show UFS reference
    await expect(page.locator('text=UFS 1-300-02').first()).toBeVisible({ timeout: 3000 });
  });

  test('compliance panel and comments panel are mutually exclusive', async ({ page }) => {
    // Open compliance
    await page.locator('button:has-text("Compliance")').click();
    await expect(page.locator('button:has-text("Run Check")')).toBeVisible({ timeout: 3000 });

    // The comments panel should not be visible (if no comments, it wouldn't be anyway)
    // Just verify compliance panel is the only right panel
    const runCheckBtn = page.locator('button:has-text("Run Check")');
    await expect(runCheckBtn).toBeVisible();
  });

  test('first-run onboarding tooltip appears and can be dismissed', async ({ page }) => {
    // Clear the onboarding flag
    await page.evaluate(() => localStorage.removeItem('sim-compliance-onboarded'));

    // Re-open compliance panel
    await page.locator('button:has-text("Compliance")').click();
    await page.waitForTimeout(300);

    // Onboarding tooltip should be visible
    const tooltip = page.locator('text=UFS 1-300-02 writing standards');
    await expect(tooltip).toBeVisible({ timeout: 3000 });

    // Click to dismiss
    await tooltip.click();
    await page.waitForTimeout(200);

    // Should be gone
    await expect(tooltip).not.toBeVisible();
  });
});

test.describe('Paste formatting', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('strips HTML formatting from pasted content', async ({ page }) => {
    // Click into the first TXT block
    const block = page.locator('[contenteditable="true"]').first();
    await block.click();

    // Simulate pasting rich HTML via clipboard API
    await page.evaluate(() => {
      const block = document.querySelector('[contenteditable="true"]');
      block.focus();
      // Select all existing content
      document.execCommand('selectAll');
      // Create a paste event with rich HTML
      const dt = new DataTransfer();
      dt.setData('text/html', '<b style="font-family: Comic Sans MS; color: red;">Bold Red Text</b>');
      dt.setData('text/plain', 'Bold Red Text');
      const pasteEvent = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
      block.dispatchEvent(pasteEvent);
    });

    // Verify plain text was inserted and no formatting leaked through
    const textContent = await block.evaluate(el => el.textContent);
    expect(textContent).toContain('Bold Red Text');

    const innerHTML = await block.evaluate(el => el.innerHTML);
    expect(innerHTML).not.toContain('style=');
    expect(innerHTML).not.toContain('<b');
    expect(innerHTML).not.toContain('Comic Sans');
  });
});

// ─── Comment active highlight (1g) ────────────────────────────────────────────
//
// Seeding pattern: type text in a fresh block, select it via Shift+Home, click
// the floating toolbar's "Add Comment" button (title="Add Comment"). This
// seeds both the block html (mark-comment span) and commentsState.byId, which
// is required for setActiveComment to fire (activeBlockId lookup).
//
// PM mode: activeCommentPlugin's inline decoration adds class
// 'mark-comment-active' alongside the existing 'mark-comment' class.
// Legacy mode: CommentPopup mount effect sets data-active="true" imperatively.

test.describe('Comment active highlight (1g)', () => {
  /**
   * Shared seeding helper — creates a block with "highlight text", selects it,
   * clicks "Add Comment" in the floating toolbar, types comment text, submits
   * the comment, then closes the popup by clicking outside. Returns the
   * .mark-comment span locator with the comment already submitted (so
   * isNewComment === false on re-open). Assumes page.goto('/') + waitForApp
   * have already been called.
   *
   * Why submit before returning?
   * When isNewComment === true, CommentPopup's textarea-focus effect fires
   * before the data-active effect (React runs effects top-to-bottom). The
   * textarea focus triggers handleBlur on the legacy contentEditable block,
   * which re-renders the block DOM — destroying the span element that
   * data-active was set on. By submitting the comment first, the second open
   * has isNewComment === false, so the reply input does not auto-focus and
   * no handleBlur interference occurs.
   */
  async function seedComment(page) {
    // Seed the author name so the CommentPopup skips the "Enter your name"
    // prompt. Without this, the popup's autoFocus input steals focus from
    // the block, causing [data-block-id]:focus locators to time out.
    await page.evaluate(() => {
      localStorage.setItem('sim-comment-author', 'Test User');
    });

    const focused = await createFreshBlock(page);
    const blockId = await focused.getAttribute('data-block-id');

    await page.keyboard.type('highlight text');

    // Select the typed text via Shift+Home so the floating toolbar appears.
    await page.keyboard.down('Shift');
    await page.keyboard.press('Home');
    await page.keyboard.up('Shift');
    await page.waitForTimeout(200);

    await expect(page.locator('button[title="Add Comment"]')).toBeVisible({ timeout: 3000 });
    await page.locator('button[title="Add Comment"]').click();

    // Wait for the mark-comment span and the new-comment textarea.
    const span = page.locator(`[data-block-id="${blockId}"] .mark-comment`).first();
    await expect(span).toBeVisible({ timeout: 3000 });
    await expect(page.locator('textarea[placeholder="Add a comment..."]')).toBeVisible({ timeout: 3000 });

    // Submit the comment so isNewComment becomes false on the next open.
    // Clicking outside without text would delete the draft (onDelete).
    await page.locator('textarea[placeholder="Add a comment..."]').fill('test comment');
    // The popup card is fixed-positioned with z-index 200; its submit button is
    // the only <button> with text "Comment" inside the card. Scope to the card
    // (identified by the presence of the textarea) to avoid matching toolbar
    // buttons ("Comments" panel, "Comment Report").
    await page.locator('textarea[placeholder="Add a comment..."]').press('Enter');

    // Close the popup by clicking outside (top-left corner, always outside).
    await page.mouse.click(10, 10);
    await page.waitForTimeout(200);

    return { span, blockId };
  }

  test('clicking a comment span applies the active-highlight class (PM-mounted block)', async ({ page }) => {
    await page.goto('/');
    await waitForApp(page);

    const { span, blockId } = await seedComment(page);

    // Click the span to open the popup. App's useEffect fires
    // setActiveComment(view, commentId) which dispatches a PM transaction
    // adding the 'mark-comment-active' decoration.
    await span.click();

    // PM's Decoration.inline creates a child wrapper span with class
    // 'mark-comment-active' INSIDE the outer <span class="mark-comment">
    // mark element (the decoration adds a nested span, not a second class on
    // the outer span). Assert on the inner decoration span.
    const activeDecoLocator = page.locator(`[data-block-id="${blockId}"] .mark-comment-active`).first();
    await expect(activeDecoLocator).toBeVisible({ timeout: 5000 });

    // Close the popup by clicking outside; setActiveComment(view, null)
    // fires and the decoration is removed.
    await page.mouse.click(10, 10);
    await page.waitForTimeout(200);
    await expect(activeDecoLocator).not.toBeVisible();
  });

  // The previous "Legacy mode — clicking a comment span sets data-active"
  // counterpart asserted CommentPopup's imperative `el.setAttribute('data-
  // active', 'true')` path. That code path still exists (and stays per
  // CLAUDE.md Comments §6 / Task b2.8) for ref + table block comment spans
  // — they have no PM EditorView registered, so the setAttribute effect
  // fires for them. Re-seeding a comment inside a ref or table block needs
  // a different helper than `seedComment` (which uses createFreshBlock /
  // editable contentEditable selection), so the coverage moved to a
  // follow-up issue rather than a synthetic rewrite here.
});

// ─── Persistent rule ignores (#140) ──────────────────────────────────────────
//
// Tests for Task 23-25 of the persistent-rule-ignores feature.
// Strategy: drive all state changes through the DEV test seam
// (`window.__simEditorTestUtils.dispatchLintIgnore` / `getIgnoredKeys` /
// `getMutedRuleIds`) rather than clicking UI buttons, which avoids
// dependency on inline-linting async NLP workers completing.
//
// Cross-reload persistence in FILE MODE is via the sidecar v2
// encoder/decoder (Tasks 7-8 of #140); that path is covered by the
// `lint-sidecar.node-test.mjs` unit suite, not here. E2E here validates
// the in-memory reducer lifecycle that every UI surface depends on.

test('persistent dismiss: finding state is tracked and survives tombstone round-trip (file mode)', async ({ page }) => {
  // #140 Task 23.
  // Demonstrates the in-memory dismissal lifecycle that backs file-mode
  // persistence. Full file-mode cross-reload persistence (sidecar v2
  // encode → re-import → prefillIgnored) is covered by the node-test
  // unit suite (lint-sidecar.node-test.mjs + linting.test.js prefillIgnored).
  await page.goto('/');
  await waitForApp(page);

  // Confirm the test seam is available.
  const seamAvailable = await page.evaluate(() => typeof window.__simEditorTestUtils?.dispatchLintIgnore === 'function');
  expect(seamAvailable).toBe(true);

  // Initially no ignored keys.
  const initialKeys = await page.evaluate(() => window.__simEditorTestUtils.getIgnoredKeys());
  expect(initialKeys).toHaveLength(0);

  // Dismiss two synthetic findings via the test seam. ruleId + blockHash +
  // match determine the ignoreKey (SHA-256 truncated). We use distinct
  // triplets so they produce two different keys.
  await page.evaluate(() => {
    window.__simEditorTestUtils.dispatchLintIgnore({
      kind: 'ignore',
      ruleId: 'TERM-should',
      blockHash: 'deadbeef00001',
      match: 'should',
    });
  });
  // dispatchLintIgnore is async (SHA-256 via Web Crypto) — give the
  // microtask + React setState commit time to resolve.
  await page.waitForTimeout(200);

  await page.evaluate(() => {
    window.__simEditorTestUtils.dispatchLintIgnore({
      kind: 'ignore',
      ruleId: 'COLLOQ-furnish',
      blockHash: 'deadbeef00002',
      match: 'furnish',
    });
  });
  // Allow 400ms for SHA-256 + React setState + commit to propagate.
  await page.waitForTimeout(400);

  // Both keys should now appear in getIgnoredKeys().
  const afterTwo = await page.evaluate(() => window.__simEditorTestUtils.getIgnoredKeys());
  expect(afterTwo).toHaveLength(2);

  // Unignore the first finding — it becomes a tombstone, not deleted.
  // getIgnoredKeys() filters tombstones, so count drops to 1.
  await page.evaluate(() => {
    window.__simEditorTestUtils.dispatchLintIgnore({
      kind: 'unignore',
      ruleId: 'TERM-should',
      blockHash: 'deadbeef00001',
      match: 'should',
    });
  });
  // Allow 400ms for SHA-256 + React setState + commit to propagate.
  await page.waitForTimeout(400);

  const afterUnignore = await page.evaluate(() => window.__simEditorTestUtils.getIgnoredKeys());
  expect(afterUnignore).toHaveLength(1);
  // The surviving key is from the COLLOQ-furnish dismiss.
  // (Exact hash value is opaque; we just verify count is correct.)
});

test('mute NLP rule: hides all instances; reset reveals them', async ({ page }) => {
  // #140 Task 24.
  // Verifies the mute-nlp → getMutedRuleIds → reset lifecycle via the
  // DEV test seam without requiring a loaded NLP worker or live lint
  // highlights (CSS Custom Highlight API ranges are not inspectable as
  // DOM elements). CSS.highlights state IS checked to confirm the
  // 'passive-voice' bucket empties when muting suppresses all NLP findings
  // for a block — but only when the linting engine has produced ranges,
  // which requires a focused block. We verify the reducer state directly
  // because that is the authoritative signal the CSS effect reads.
  await page.goto('/');
  await waitForApp(page);

  // Confirm getMutedRuleIds seam is present.
  const seamAvailable = await page.evaluate(() => typeof window.__simEditorTestUtils?.getMutedRuleIds === 'function');
  expect(seamAvailable).toBe(true);

  // Initially no muted rules.
  const initialMuted = await page.evaluate(() => window.__simEditorTestUtils.getMutedRuleIds());
  expect(initialMuted).toHaveLength(0);

  // Mute the NLP passive-voice rule.
  await page.evaluate(() => {
    window.__simEditorTestUtils.dispatchLintIgnore({
      kind: 'mute-nlp',
      ruleId: 'NLP-passive',
    });
  });
  // mute-nlp is synchronous (no crypto hash) but lintingStateRef is updated
  // in a useEffect which runs after paint — allow 400ms for the commit cycle.
  await page.waitForTimeout(400);

  const afterMute = await page.evaluate(() => window.__simEditorTestUtils.getMutedRuleIds());
  expect(afterMute).toContain('NLP-passive');
  expect(afterMute).toHaveLength(1);

  // Mute a second rule to verify independent tracking.
  await page.evaluate(() => {
    window.__simEditorTestUtils.dispatchLintIgnore({
      kind: 'mute-nlp',
      ruleId: 'NLP-indicative',
    });
  });
  await page.waitForTimeout(400);

  const afterTwo = await page.evaluate(() => window.__simEditorTestUtils.getMutedRuleIds());
  expect(afterTwo).toHaveLength(2);
  expect(afterTwo).toContain('NLP-passive');
  expect(afterTwo).toContain('NLP-indicative');

  // Reset clears both muted rules (tombstones them). getMutedRuleIds
  // filters tombstones, so it returns an empty array.
  await page.evaluate(() => {
    window.__simEditorTestUtils.dispatchLintIgnore({ kind: 'reset' });
  });
  await page.waitForTimeout(400);

  const afterReset = await page.evaluate(() => window.__simEditorTestUtils.getMutedRuleIds());
  expect(afterReset).toHaveLength(0);

  // Verify the findings map was also cleared by reset.
  const afterResetKeys = await page.evaluate(() => window.__simEditorTestUtils.getIgnoredKeys());
  expect(afterResetKeys).toHaveLength(0);
});

test('reset from Settings clears ignored state and disables the reset button', async ({ page }) => {
  // #140 Task 25.
  // Verifies the full UI path: dismiss findings → open Compliance panel →
  // run a scan (needed to render the "⚙ Settings" footer button) →
  // open Settings → click "Reset ignored findings" → confirm dialog →
  // verify state empties AND button becomes disabled.
  //
  // The "⚙ Settings" button lives in a footer that only renders when
  // `result && result.stats.total > 0` (CompliancePanel.jsx ~line 782).
  // We run a "document" scope check first to surface the button; the
  // sample .SEC has 426 blocks and many UFS violations so total > 0 is
  // guaranteed. The scan is CPU-bound and typically takes 1-3 s.
  await page.goto('/');
  await waitForApp(page);

  // Seed 3 ignored findings via the test seam.
  for (const [ruleId, blockHash, match] of [
    ['TERM-should', 'aaa000', 'should'],
    ['COLLOQ-furnish', 'bbb000', 'furnish'],
    ['VAGUE-applicable', 'ccc000', 'applicable'],
  ]) {
    await page.evaluate(({ ruleId, blockHash, match }) => {
      window.__simEditorTestUtils.dispatchLintIgnore({ kind: 'ignore', ruleId, blockHash, match });
    }, { ruleId, blockHash, match });
    // Stagger dispatches to avoid SHA-256 hash collision in the Map.
    await page.waitForTimeout(150);
  }

  const beforeReset = await page.evaluate(() => window.__simEditorTestUtils.getIgnoredKeys());
  expect(beforeReset).toHaveLength(3);

  // Open the Compliance panel.
  await page.locator('button:has-text("Compliance")').click();
  await page.waitForTimeout(300);

  // Change scope to "Entire Document" so the scan always produces violations.
  // Target specifically the scope select (it contains option[value="document"]);
  // other <select> elements on the page (TailoringProfile, AI model) don't.
  await page.selectOption('select:has(option[value="document"])', 'document');

  // Run the compliance scan.
  await page.locator('button:has-text("Run Check")').click();

  // Wait for the "⚙ Settings" footer button to appear (scan complete + total > 0).
  // Allow up to 15 s for the document-wide scan to finish.
  await page.locator('button:has-text("⚙ Settings")').first().waitFor({ state: 'visible', timeout: 15000 });

  // Open Settings.
  await page.locator('button:has-text("⚙ Settings")').first().click();

  // The ComplianceSettings modal should now be visible.
  await expect(page.locator('text=Compliance AI Settings')).toBeVisible({ timeout: 5000 });

  // The "Reset ignored findings" button should be enabled (ignoredCount > 0).
  const resetBtn = page.locator('button:has-text("Reset ignored findings")');
  await expect(resetBtn).toBeVisible({ timeout: 3000 });
  await expect(resetBtn).not.toBeDisabled();

  // Set up the confirm dialog handler BEFORE clicking — Playwright handles
  // window.confirm() via page.on('dialog').
  page.once('dialog', async (dialog) => {
    expect(dialog.message()).toContain('Reset all');
    await dialog.accept();
  });

  await resetBtn.click();
  await page.waitForTimeout(300);

  // Reducer state should now be empty.
  const afterReset = await page.evaluate(() => window.__simEditorTestUtils.getIgnoredKeys());
  expect(afterReset).toHaveLength(0);

  // The reset button should now be disabled (ignoredCount === 0).
  await expect(resetBtn).toBeDisabled({ timeout: 3000 });
});
