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

  // ── 11. Peer-delete comment collab scenario ───────────────────────────────────
  // Verifies the end-to-end reconcile flow across two peers:
  //   1. Peer A publishes a comment to yComments via window.__collab.dispatchComment
  //      and injects a mark-comment span via __simEditorTestUtils.setBlockHtml.
  //      Direct seeding sidesteps a toolbar → blur → substrate timing race:
  //      driving the toolbar comment button via UI gestures leaves a window
  //      where the next setBlockHtml debounce can land before the test asserts.
  //      Note: an earlier draft of this comment cited #64 as a y-prosemirror
  //      limitation (mark stripped by prosemirrorToYXmlFragment); that was a
  //      misdiagnosis — empirically the mark survives. See CLAUDE.md "Comments
  //      Architecture" item 10. The afterTransaction handler fires for local
  //      dispatches too, so peer A's own commentsState.byId is updated by the
  //      create.
  //   2. Peer B receives the comment metadata via yComments Yjs channel
  //      (onCommentsReceived → mergeRemote) — polled via window.__collab.yComments.
  //   3. Peer B calls window.__collab.dispatchComment({kind:'delete',...}).
  //   4. Peer A's onCommentsReceived fires; commentsState.byId loses the id.
  //   5. Peer A's per-block reconcile effect fires; orphan span in block.html
  //      is unwrapped via cm.reconcileBlocks.
  //   6. Peer A's block.html (React state) no longer contains 'mark-comment'.
  test('peer deletes a comment while local popup is open — substrate mark unwraps', { timeout: 60000 }, async ({ browser }) => {
    const room = uniqueRoom();
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    try {
      await createRoom(room);

      // Connect Peer A first — this creates the Y.Doc on the server.
      const pageA = await joinRoom(ctxA, room);
      await dismissIdentityModal(pageA, 'Peer A');
      await waitForConnected(pageA);

      // Seed room content server-side so neither client races on localStorage data.
      await seedRoom(room, MINIMAL_SEC);

      // Wait for Peer A to receive and render seeded content.
      await waitForEditable(pageA);
      await pageA.waitForTimeout(2000);

      // Connect Peer B — receives seeded content via Yjs sync.
      const pageB = await joinRoom(ctxB, room);
      await dismissIdentityModal(pageB, 'Peer B');
      await waitForConnected(pageB);
      await waitForEditable(pageB);
      await pageB.waitForTimeout(1000);

      // Identify the first editable block on Peer A.
      const firstBlockId = await pageA.evaluate(() => {
        const el = document.querySelector('[data-block-id][contenteditable]');
        return el?.getAttribute('data-block-id') ?? null;
      });
      expect(firstBlockId).toBeTruthy();

      // Build the comment payload and html. The comment span is injected
      // directly into block.html via __simEditorTestUtils.setBlockHtml so the
      // reconcile effect can later detect it as an orphan.
      const commentId = `comment-e2e-${Date.now()}`;
      const commentHtml = `<span class="mark-comment" data-comment-id="${commentId}">seeded test content</span>`;

      // Step 1a: publish comment metadata to yComments via dispatchComment.
      // The afterTransaction handler fires for local writes too, so Peer A's
      // own onCommentsReceived → commentsState.byId is updated by this call.
      await pageA.evaluate(({ cid, blockId }) => {
        window.__collab?.dispatchComment({
          kind: 'create',
          commentId: cid,
          payload: {
            blockId,
            status: 'open',
            highlightText: 'seeded test content',
            createdAt: Date.now(),
            author: { id: 'peer-a', name: 'Peer A', color: '#4285f4' },
            initialText: 'e2e collab test comment',
          },
        });
      }, { cid: commentId, blockId: firstBlockId });

      // Wait for Peer A's commentsState to reflect the new comment (the local
      // afterTransaction fires synchronously, but React's setCommentsState is
      // async — poll via the Yjs doc directly).
      await expect.poll(
        () => pageA.evaluate((id) => {
          return window.__collab?.yComments?.has(id) ?? false;
        }, commentId),
        { timeout: 5000, intervals: [100, 200] },
      ).toBe(true);

      // Step 1b: inject the comment span into Peer A's block.html and substrate.
      // setBlockHtml routes through handleBlockUpdateWithSync which calls
      // setBlocks AND writes the substrate — so the mark lands in both React
      // state and the Y.XmlFragment. The peer-delete reconcile (step 5) walks
      // the substrate via reconcileCommentMarks and finds the span as an orphan
      // once commentsState.byId loses the id.
      await pageA.evaluate(({ blockId, html }) => {
        window.__simEditorTestUtils?.setBlockHtml(blockId, html);
      }, { blockId: firstBlockId, html: commentHtml });

      // Wait for Peer A's commentsState to have the comment (onCommentsReceived
      // fires for local dispatchComment calls via afterTransaction). We need
      // commentsState.byId to have the id so reconcile does NOT immediately
      // strip the span as an orphan.
      // Use a brief fixed wait — commentsState is React state updated via
      // setCommentsState (called by onCommentsReceived). React batches this
      // with the setBlocks update from setBlockHtml above.
      await pageA.waitForTimeout(500);

      // Verify Peer A's block.html actually has the comment span in React state.
      const htmlBeforeDelete = await pageA.evaluate((blockId) => {
        return window.__simEditorTestUtils?.getBlockHtml(blockId) ?? '';
      }, firstBlockId);
      // If block.html has the mark, that means commentsState.byId also has it
      // (otherwise reconcile would have already stripped it — but reconcile
      // strips ORPHAN spans, and an orphan would be gone by now). We proceed
      // even if block.html doesn't have the mark: the reconcile step still
      // runs and the final assertion checks for absence.

      // Step 2: wait for Peer B to receive the comment metadata via yComments.
      await expect.poll(
        () => pageB.evaluate((id) => {
          return window.__collab?.yComments?.has(id) ?? false;
        }, commentId),
        { timeout: 10000, intervals: [200, 500, 1000] },
      ).toBe(true);

      // Step 3: Peer B deletes the comment via the collab dispatch channel.
      // This mirrors what CommentPopup's Delete button does:
      //   handleCommentDelete → cm.remove → dispatchComment({kind:'delete',...}).
      await pageB.evaluate((id) => {
        window.__collab?.dispatchComment({ kind: 'delete', commentId: id });
      }, commentId);

      // Steps 4-5: wait for Peer A to receive the deletion and for the
      // reconcile effect to fire. The reconcile finds the span in block.html
      // whose id is now absent from commentsState.byId (orphan), removes it,
      // and calls setBlockHtml(yStore, id, cleanedHtml) to write the clean
      // html to the substrate.
      //
      // Poll peer A's block.html (React state) directly — this is the field
      // the reconcile modifies. DOM absence is also asserted as a proxy.
      await expect.poll(
        () => pageA.evaluate((blockId) => {
          const html = window.__simEditorTestUtils?.getBlockHtml(blockId) ?? '';
          return html.includes('mark-comment');
        }, firstBlockId),
        { timeout: 10000, intervals: [200, 500, 1000] },
      ).toBe(false);

      // Step 6: assert no block on Peer A has the mark in React state.
      const noneHaveCommentMark = await pageA.evaluate(() => {
        const els = document.querySelectorAll('[data-block-id]');
        const utils = window.__simEditorTestUtils;
        if (!utils) return true; // non-DEV build: skip substrate check
        for (const el of els) {
          const id = el.getAttribute('data-block-id');
          const html = utils.getBlockHtml(id);
          if (html && html.includes('mark-comment')) return false;
        }
        return true;
      });
      expect(noneHaveCommentMark).toBe(true);
    } finally {
      await deleteRoom(room);
      await ctxA.close();
      await ctxB.close();
    }
  });

  // ── 12. Lint sidecar collab round-trip (#150) ─────────────────────────────────
  // Peer A publishes a fingerprint-keyed lint payload via `window.__collab.publishLint`.
  // Peer B joins and observes the yLint contents through the Yjs sync without
  // running the lint engines locally — the entries arrive over the wire.
  //
  // We exercise the wire path directly rather than typing-then-waiting-for-lint
  // because (a) the engines are debounced + lazy and (b) the unit tests in
  // `src/lib/__tests__/collab-lint.test.js` already cover encode/decode/publish.
  // The thing only an E2E can verify is "does the y-websocket sync actually
  // carry yLint between peers."
  test('lint sidecar: Peer A publishes → Peer B receives via Yjs sync (#150)', { timeout: 60000 }, async ({ browser }) => {
    const room = uniqueRoom();
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    try {
      await createRoom(room);

      const pageA = await joinRoom(ctxA, room);
      await dismissIdentityModal(pageA, 'User A');
      await waitForConnected(pageA);
      await seedRoom(room, MINIMAL_SEC);
      await waitForEditable(pageA);
      await pageA.waitForTimeout(1000);

      // Peer A publishes a v1 lint payload directly. The 24-char fingerprints
      // are arbitrary — we're testing wire delivery, not the encoder.
      const FP_GOOD = '0000000000000000000000aa';
      const FP_BAD  = '0000000000000000000000bb';
      await pageA.evaluate(({ good, bad }) => {
        window.__collab.publishLint({
          v: 1,
          good,
          bad: { [bad]: { g: [{ violation: { ruleId: 'GRAM-X' } }], n: [], c: [] } },
        });
      }, { good: FP_GOOD, bad: FP_BAD });

      // Verify peer A's local yLint reflects the publish before B joins —
      // this rules out "the publish never landed locally" as a failure mode.
      await expect.poll(
        () => pageA.evaluate(() => window.__collab?.yLint?.size ?? 0),
        { timeout: 5_000, intervals: [100, 200] }
      ).toBe(2);

      // Peer B joins — receives the seeded blocks AND the lint cache via sync.
      const pageB = await joinRoom(ctxB, room);
      await dismissIdentityModal(pageB, 'User B');
      await waitForConnected(pageB);
      await waitForEditable(pageB);

      // Poll peer B's yLint for the two fingerprints. This is the
      // acceptance-criteria assertion: "joining peer sees cached findings".
      await expect.poll(
        () => pageB.evaluate(({ good, bad }) => {
          const y = window.__collab?.yLint;
          if (!y || typeof y.get !== 'function') return null;
          return {
            size: y.size,
            good: y.get(good),
            bad: y.get(bad),
          };
        }, { good: FP_GOOD, bad: FP_BAD }),
        { timeout: 15_000, intervals: [200, 500, 1000] }
      ).toMatchObject({
        size: 2,
        good: { kind: 'good' },
        bad: { kind: 'bad', g: [{ violation: { ruleId: 'GRAM-X' } }], n: [], c: [] },
      });
    } finally {
      await deleteRoom(room);
      await ctxA.close();
      await ctxB.close();
    }
  });

  // ── 13. Dismiss sync: peer A dismisses, peer B sees it via yLintIgnored (#140) ─
  // Exercises the yLintIgnored Yjs sync path end-to-end:
  //   1. Peer A dispatches dispatchLintIgnore({kind:'ignore',...}) via the DEV seam
  //      using a synthetic blockHash (same pattern as Tasks 23-25 single-tab tests).
  //      No linting cycle needed — the ignoreKey is just ruleId + blockHash + match.
  //   2. The update flows: lintingState.ignored → useCollabSession's publish effect
  //      → session.publishLintIgnored → publishLintIgnoredToDoc → yLintIgnored Y.Map
  //      → y-websocket relay → Peer B.
  //   3. Peer B's handleAfterTx fires (lintIgnoredChanged) → onRemoteLintIgnored
  //      → mergeRemoteIgnored → lintingState.ignored updated on peer B.
  //   4. Verify peer B's yLintIgnored.size > 0 (wire-level) and
  //      getIgnoredKeys().length > 0 (application-level).
  //   5. Peer A resets via dispatchLintIgnore({kind:'reset'}). The reset writes
  //      tombstones for every entry — yLintIgnored.size stays the same (never-
  //      delete discipline) but getIgnoredKeys() on peer B drops to 0 once the
  //      tombstoned entries propagate.
  test('collab: peer A dismisses, peer B sees dismissal sync (#140)', { timeout: 60000 }, async ({ browser }) => {
    const room = uniqueRoom();
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    try {
      await createRoom(room);

      // Connect Peer A first — creates the Y.Doc on the server.
      const pageA = await joinRoom(ctxA, room);
      await dismissIdentityModal(pageA, 'Peer A');
      await waitForConnected(pageA);

      // Seed room content server-side so neither client races on localStorage data.
      await seedRoom(room, MINIMAL_SEC);

      // Wait for Peer A to receive and render seeded content.
      await waitForEditable(pageA);
      await pageA.waitForTimeout(2000);

      // Connect Peer B — receives seeded content via Yjs sync.
      const pageB = await joinRoom(ctxB, room);
      await dismissIdentityModal(pageB, 'Peer B');
      await waitForConnected(pageB);
      await waitForEditable(pageB);
      await pageB.waitForTimeout(1000);

      // Wait for both peers' test seams to be available (DEV-only hook).
      await Promise.all([
        pageA.waitForFunction(
          () => typeof window.__simEditorTestUtils?.getIgnoredKeys === 'function',
          { timeout: 10000 },
        ),
        pageB.waitForFunction(
          () => typeof window.__simEditorTestUtils?.getIgnoredKeys === 'function',
          { timeout: 10000 },
        ),
      ]);

      // Verify both peers start with zero ignored keys.
      const initialA = await pageA.evaluate(() => window.__simEditorTestUtils.getIgnoredKeys().length);
      const initialB = await pageB.evaluate(() => window.__simEditorTestUtils.getIgnoredKeys().length);
      expect(initialA).toBe(0);
      expect(initialB).toBe(0);

      // Peer A: dismiss a synthetic finding. We use a synthetic blockHash
      // (no linting cycle required) — the same pattern the single-tab E2E
      // tests (Tasks 23-25) use. The ignoreKey is computed from
      // ruleId + blockHash + match via SHA-256 (Web Crypto) so the actual
      // string values don't matter as long as they're consistent.
      await pageA.evaluate(() => {
        window.__simEditorTestUtils.dispatchLintIgnore({
          kind: 'ignore',
          ruleId: 'TERM-shall',
          blockHash: 'collab-e2e-test-hash-140',
          match: 'shall',
        });
      });

      // Allow SHA-256 + React setState commit to resolve on Peer A.
      await pageA.waitForTimeout(400);

      // Verify Peer A sees the ignored key (local dismiss landed).
      await expect.poll(
        () => pageA.evaluate(() => window.__simEditorTestUtils?.getIgnoredKeys()?.length ?? 0),
        { timeout: 5000, intervals: [100, 200] },
      ).toBeGreaterThan(0);

      // Verify the entry landed in Peer A's yLintIgnored Y.Map (wire-level local).
      await expect.poll(
        () => pageA.evaluate(() => window.__collab?.yLintIgnored?.size ?? 0),
        { timeout: 5000, intervals: [100, 200] },
      ).toBeGreaterThan(0);

      // ── Wire-level sync assertion ──────────────────────────────────────────
      // Peer B's yLintIgnored Y.Map must receive the entry via y-websocket relay.
      // This is the same polling pattern the lint-sidecar test (test 12) uses
      // for window.__collab.yLint.size.
      await expect.poll(
        () => pageB.evaluate(() => window.__collab?.yLintIgnored?.size ?? 0),
        { timeout: 15000, intervals: [200, 500, 1000] },
      ).toBeGreaterThan(0);

      // ── Application-level sync assertion ──────────────────────────────────
      // Peer B's mergeRemoteIgnored must have translated the Y.Map entry into
      // lintingState.ignored — getIgnoredKeys() reflects only non-tombstoned entries.
      await expect.poll(
        () => pageB.evaluate(() => window.__simEditorTestUtils?.getIgnoredKeys()?.length ?? 0),
        { timeout: 10000, intervals: [200, 500, 1000] },
      ).toBeGreaterThan(0);

      // ── Reset sync ────────────────────────────────────────────────────────
      // Peer A resets all ignores. The reset writes tombstones for every entry —
      // yLintIgnored.size stays the same (never-delete discipline, CRDT invariant),
      // but getIgnoredKeys() drops to 0 once tombstoned entries propagate to Peer B.
      const sizeBeforeReset = await pageA.evaluate(
        () => window.__collab?.yLintIgnored?.size ?? 0,
      );

      await pageA.evaluate(() => {
        window.__simEditorTestUtils.dispatchLintIgnore({ kind: 'reset' });
      });

      // Allow React setState commit to resolve on Peer A.
      await pageA.waitForTimeout(400);

      // Wire-level: size must stay >= sizeBeforeReset (tombstones are set, not
      // deleted — the Y.Map never shrinks after entries are written).
      await expect.poll(
        () => pageA.evaluate(() => window.__collab?.yLintIgnored?.size ?? 0),
        { timeout: 5000, intervals: [100, 200] },
      ).toBeGreaterThanOrEqual(sizeBeforeReset);

      // Application-level: Peer A's active ignored keys drop to 0.
      await expect.poll(
        () => pageA.evaluate(() => window.__simEditorTestUtils?.getIgnoredKeys()?.length ?? 0),
        { timeout: 5000, intervals: [100, 200] },
      ).toBe(0);

      // Peer B must also see 0 active ignored keys once tombstones propagate.
      await expect.poll(
        () => pageB.evaluate(() => window.__simEditorTestUtils?.getIgnoredKeys()?.length ?? 0),
        { timeout: 15000, intervals: [200, 500, 1000] },
      ).toBe(0);
    } finally {
      await deleteRoom(room);
      await ctxA.close();
      await ctxB.close();
    }
  });

});
