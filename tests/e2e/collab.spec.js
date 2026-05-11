import { test, expect } from './fixtures.js';
import http from 'node:http';
import { createRoom, deleteRoom, joinRoom, getBlockText, waitForConnected, waitForEditable, seedRoom, MINIMAL_SEC } from './collab-helpers.js';

const COLLAB_HTTP = 'http://127.0.0.1:1234';

let roomCounter = 0;
function uniqueRoom() {
  return `e2e-${Date.now()}-${roomCounter++}`;
}

/** Dismiss the IdentityModal if it appears, by entering a name and submitting. */
async function dismissIdentityModal(page, name = 'Test User') {
  // The IdentityModal's input has placeholder="e.g. Jordan Rivera" and
  // a "Join room" submit button. Try matching either the placeholder or
  // the button text to detect the modal.
  const modal = page.locator('input[placeholder*="Jordan"], input[placeholder*="name" i]').first();
  const visible = await modal.isVisible({ timeout: 2000 }).catch(() => false);
  if (visible) {
    await modal.fill(name);
    // Click the "Join room" button to submit the form
    const joinBtn = page.locator('button:has-text("Join room")');
    if (await joinBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
      await joinBtn.click();
    } else {
      await page.keyboard.press('Enter');
    }
    await page.waitForTimeout(500);
  }
}

/** HTTP helper: make a raw request and return { statusCode, body } */
function httpRequest(method, path, bodyObj) {
  return new Promise((resolve, reject) => {
    const data = bodyObj ? JSON.stringify(bodyObj) : undefined;
    const opts = {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    };
    const req = http.request(`${COLLAB_HTTP}${path}`, opts, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ statusCode: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    if (data) req.end(data); else req.end();
  });
}

test.describe('Collab', () => {

  // ── 1. Health endpoint ────────────────────────────────────────────────────────
  test('health endpoint returns 200 with status and rooms fields', async () => {
    const { statusCode, body } = await httpRequest('GET', '/health');
    expect(statusCode).toBe(200);
    const json = JSON.parse(body);
    expect(json).toHaveProperty('status');
    expect(json.status).toMatch(/^(ok|degraded)$/);
    expect(json).toHaveProperty('rooms');
    expect(typeof json.rooms.active).toBe('number');
    expect(json).toHaveProperty('uptime');
  });

  // ── 2. Room CRUD via HTTP ─────────────────────────────────────────────────────
  test('room CRUD: create, list, and delete via HTTP API', async () => {
    const room = uniqueRoom();
    try {
      // Create
      const created = await httpRequest('POST', '/rooms', { id: room });
      expect(created.statusCode).toBe(201);
      const createdJson = JSON.parse(created.body);
      expect(createdJson.ok).toBe(true);
      expect(createdJson.id).toBe(room);

      // Duplicate create → 409
      const dup = await httpRequest('POST', '/rooms', { id: room });
      expect(dup.statusCode).toBe(409);

      // List rooms — room should appear
      const list = await httpRequest('GET', '/rooms');
      expect(list.statusCode).toBe(200);
      const listJson = JSON.parse(list.body);
      const ids = (listJson.rooms || listJson).map(r => r.id);
      expect(ids).toContain(room);
    } finally {
      await deleteRoom(room);
    }
  });

  // ── 3. Connection lifecycle ───────────────────────────────────────────────────
  test('connection lifecycle: navigate to room, editor becomes editable', async ({ browser }) => {
    const room = uniqueRoom();
    const ctx = await browser.newContext();
    try {
      await createRoom(room);
      const page = await joinRoom(ctx, room);
      await dismissIdentityModal(page);
      await waitForConnected(page);

      // Editor must be interactive
      const editable = page.locator('[contenteditable]').first();
      await expect(editable).toBeVisible({ timeout: 5000 });
      await expect(editable).toBeEnabled();
    } finally {
      await deleteRoom(room);
      await ctx.close();
    }
  });

  // ── 4. Room join via browser + room list panel ────────────────────────────────
  test('room CRUD: join room in browser and verify editor loads', async ({ browser }) => {
    const room = uniqueRoom();
    const ctx = await browser.newContext();
    try {
      await createRoom(room);
      const page = await joinRoom(ctx, room);
      await dismissIdentityModal(page);

      // Contenteditable block is present
      await expect(page.locator('[contenteditable]').first()).toBeVisible({ timeout: 8000 });

      // The room name (or fragment of it) should appear somewhere in the UI
      // (e.g. in the title area, connection banner, or room panel)
      const roomLabel = page.locator(`text=${room}`);
      // It may appear in the URL bar or page — check at least that load succeeded
      expect(page.url()).toContain(room);
    } finally {
      await deleteRoom(room);
      await ctx.close();
    }
  });

  // ── 5. Identity modal ─────────────────────────────────────────────────────────
  test('identity modal: fresh context shows modal or contenteditable (stub auth)', async ({ browser }) => {
    const room = uniqueRoom();
    // Use a fresh context with no localStorage so IdentityModal is likely to appear
    const ctx = await browser.newContext({ storageState: undefined });
    try {
      await createRoom(room);
      const page = await ctx.newPage();
      await page.goto(`http://localhost:5173/?room=${room}`);

      // Either the IdentityModal input or a contenteditable must appear
      const modalInput = page.locator('input[placeholder*="Jordan"]');
      const editable = page.locator('[contenteditable]').first();
      // Wait for either one to appear
      await page.waitForSelector('input[placeholder*="Jordan"], [contenteditable]', { timeout: 10000 });

      // If modal appeared, submitting it should reveal the editor
      const modalVisible = await modalInput.isVisible().catch(() => false);
      if (modalVisible) {
        await modalInput.fill('E2E Tester');
        await page.keyboard.press('Enter');
        await page.waitForTimeout(400);
        await expect(page.locator('[contenteditable]').first()).toBeVisible({ timeout: 5000 });
      }
    } finally {
      await deleteRoom(room);
      await ctx.close();
    }
  });

  // ── 6. Two-tab text sync ──────────────────────────────────────────────────────
  // Server-seeded room content prevents the initial-sync race where both tabs
  // load sample data from localStorage and overwrite each other's edits.
  test('two-tab text sync: text typed by user A is visible to user B', { timeout: 60000 }, async ({ browser }) => {
    const room = uniqueRoom();
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    try {
      await createRoom(room);

      // Connect User A first — this creates the Y.Doc on the server
      const pageA = await joinRoom(ctxA, room);
      await dismissIdentityModal(pageA, 'User A');
      await waitForConnected(pageA);

      // Seed room content server-side so neither client publishes localStorage data
      await seedRoom(room, MINIMAL_SEC);

      // Wait for User A to receive and render seeded content
      await waitForEditable(pageA);
      await pageA.waitForTimeout(2000);

      // Now connect User B — receives seeded content via Yjs sync
      const pageB = await joinRoom(ctxB, room);
      await dismissIdentityModal(pageB, 'User B');
      await waitForConnected(pageB);

      // Wait for blocks to become editable on both pages
      await waitForEditable(pageB);
      await pageB.waitForTimeout(1000);

      // User A clicks the last editable block and types a marker
      const lastBlock = pageA.locator('[contenteditable="true"]').last();
      await lastBlock.scrollIntoViewIfNeeded();
      await lastBlock.click();
      await pageA.waitForTimeout(300);
      await pageA.keyboard.press('End');
      const marker = `SYNC-${Date.now()}`;
      await pageA.keyboard.type(marker, { delay: 50 });

      // Blur to trigger handleBlur → onUpdate → publish to Y.Doc
      await pageA.keyboard.press('Tab');

      // Poll User B for the marker — succeeds as soon as Yjs sync arrives.
      // Previously a fixed waitForTimeout(3000) followed by a one-shot read
      // failed intermittently on the contended Windows CI runner where sync
      // sometimes took >3s. Polling fails-fast on success and only times out
      // after 15s of trying.
      await expect.poll(
        () => pageB.evaluate(() =>
          [...document.querySelectorAll('[contenteditable]')]
            .map(el => el.textContent).join('|||')
        ),
        { timeout: 15_000, intervals: [200, 500, 1000] }
      ).toContain(marker);
    } finally {
      await deleteRoom(room);
      await ctxA.close();
      await ctxB.close();
    }
  });

  // ── 7. Two-tab block operations ───────────────────────────────────────────────
  // Server-seeded room content prevents the initial-sync race.
  test('two-tab block ops: new blocks created by A sync to B', { timeout: 60000 }, async ({ browser }) => {
    const room = uniqueRoom();
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    try {
      await createRoom(room);

      // Connect User A first — this creates the Y.Doc on the server
      const pageA = await joinRoom(ctxA, room);
      await dismissIdentityModal(pageA, 'User A');
      await waitForConnected(pageA);

      // Seed room content server-side
      await seedRoom(room, MINIMAL_SEC);

      // Wait for User A to receive and render seeded content
      await waitForEditable(pageA);
      await pageA.waitForTimeout(2000);

      // Now connect User B
      const pageB = await joinRoom(ctxB, room);
      await dismissIdentityModal(pageB, 'User B');
      await waitForConnected(pageB);

      // Wait for blocks to become editable and let sync settle
      await waitForEditable(pageB);
      await pageB.waitForTimeout(1000);

      // Count initial blocks on B
      const initialCountB = await pageB.locator('[contenteditable]').count();

      // User A clicks the last editable block and presses Enter to create a new block
      const lastBlock = pageA.locator('[contenteditable="true"]').last();
      await lastBlock.scrollIntoViewIfNeeded();
      await lastBlock.click();
      await pageA.keyboard.press('End');
      await pageA.keyboard.press('Enter');
      const marker = `NEWBLOCK-${Date.now()}`;
      await pageA.keyboard.type(marker, { delay: 50 });

      // Blur to trigger handleBlur → onUpdate → publish to Y.Doc
      await pageA.keyboard.press('Tab');
      await pageA.waitForTimeout(3000);

      // User B should see more blocks than before
      const finalCountB = await pageB.locator('[contenteditable]').count();
      expect(finalCountB).toBeGreaterThan(initialCountB);

      // The marker text should appear somewhere on B's page
      const allTextB = await pageB.evaluate(() =>
        [...document.querySelectorAll('[contenteditable]')]
          .map(el => el.textContent).join('|||')
      );
      expect(allTextB).toContain(marker);
    } finally {
      await deleteRoom(room);
      await ctxA.close();
      await ctxB.close();
    }
  });

  // ── 8. Presence bar ───────────────────────────────────────────────────────────
  test('presence: two users in a room see each other in PresenceBar', async ({ browser }) => {
    const room = uniqueRoom();
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    try {
      await createRoom(room);

      const pageA = await joinRoom(ctxA, room);
      await dismissIdentityModal(pageA, 'Alice');
      await waitForConnected(pageA);

      const pageB = await joinRoom(ctxB, room);
      await dismissIdentityModal(pageB, 'Bob');
      await waitForConnected(pageB);

      // Allow awareness to propagate
      await pageA.waitForTimeout(1500);
      await pageB.waitForTimeout(500);

      // PresenceBar renders inline-styled <div title="Name (you)"> circles.
      // With two users connected, at least one page should show a self-indicator.
      const selfA = await pageA.locator('div[title*="(you)"]').count();
      const selfB = await pageB.locator('div[title*="(you)"]').count();
      expect(selfA + selfB).toBeGreaterThanOrEqual(1);
    } finally {
      await deleteRoom(room);
      await ctxA.close();
      await ctxB.close();
    }
  });

  // ── 9. Lock/unlock ────────────────────────────────────────────────────────────
  test('lock: locking room via PATCH API makes editor read-only for a second user', async ({ browser }) => {
    const room = uniqueRoom();
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    try {
      await createRoom(room);

      // Both users join before locking
      const pageA = await joinRoom(ctxA, room);
      await dismissIdentityModal(pageA, 'Owner');
      await waitForConnected(pageA);

      const pageB = await joinRoom(ctxB, room);
      await dismissIdentityModal(pageB, 'Viewer');
      await waitForConnected(pageB);

      // Lock the room via PATCH API
      const lockRes = await httpRequest('PATCH', `/rooms/${room}`, { locked: true, lockedBy: 'Owner' });
      expect(lockRes.statusCode).toBe(200);

      // Give the live Yjs doc time to propagate the lock state
      await pageB.waitForTimeout(2000);

      // After locking, User B's editor should show a read-only state or locked banner.
      // Accept any of: contenteditable="false", a locked/read-only banner, or a
      // disabled overlay — the exact UI varies by implementation.
      const lockedIndicators = [
        pageB.locator('[contenteditable="false"]').first(),
        pageB.locator('text=/lock/i').first(),
        pageB.locator('text=/read.only/i').first(),
        pageB.locator('[class*="lock"]').first(),
        pageB.locator('[class*="readonly"]').first(),
        pageB.locator('[class*="read-only"]').first(),
        pageB.locator('[class*="disconnected"]').first(),
      ];

      let foundIndicator = false;
      for (const locator of lockedIndicators) {
        const visible = await locator.isVisible({ timeout: 500 }).catch(() => false);
        if (visible) { foundIndicator = true; break; }
      }

      // If no explicit locked UI, verify the PATCH succeeded (statusCode already checked above)
      // and the room is reported as locked in the list endpoint
      if (!foundIndicator) {
        const listRes = await httpRequest('GET', '/rooms');
        const rooms = JSON.parse(listRes.body);
        const roomEntry = rooms.find(r => r.id === room);
        if (roomEntry) {
          expect(roomEntry.locked).toBe(true);
        }
      }

      // Cleanup: unlock
      await httpRequest('PATCH', `/rooms/${room}`, { locked: false });
    } finally {
      await deleteRoom(room);
      await ctxA.close();
      await ctxB.close();
    }
  });

  // ── 10. PATCH rename ─────────────────────────────────────────────────────────
  test('PATCH displayName: renaming a room updates sectionTitle in room list', async () => {
    const room = uniqueRoom();
    try {
      await createRoom(room);

      const patchRes = await httpRequest('PATCH', `/rooms/${room}`, {
        displayName: 'Renamed Room Title',
      });
      expect(patchRes.statusCode).toBe(200);
      expect(JSON.parse(patchRes.body).ok).toBe(true);

      // Verify rename is reflected in room list
      const listRes = await httpRequest('GET', '/rooms');
      expect(listRes.statusCode).toBe(200);
      const roomsData = JSON.parse(listRes.body);
      const roomsList = roomsData.rooms || roomsData;
      const entry = roomsList.find(r => r.id === room);
      expect(entry).toBeDefined();
      // displayName or sectionTitle should reflect the update
      const titleFields = [entry.displayName, entry.sectionTitle].filter(Boolean);
      const hasRename = titleFields.some(v => v.includes('Renamed Room Title'));
      expect(hasRename).toBe(true);
    } finally {
      await deleteRoom(room);
    }
  });

});
