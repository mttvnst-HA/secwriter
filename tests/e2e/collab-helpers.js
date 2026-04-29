/**
 * Shared helpers for collab E2E tests.
 */
import http from 'node:http';

const COLLAB_HTTP = 'http://127.0.0.1:1234';

/** POST /rooms to create a room. Returns room id. */
export async function createRoom(name) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ id: name });
    const req = http.request(`${COLLAB_HTTP}/rooms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        if (res.statusCode === 201 || res.statusCode === 409) resolve(name);
        else reject(new Error(`createRoom ${name}: ${res.statusCode}`));
      });
    });
    req.on('error', reject);
    req.end(data);
  });
}

/** DELETE /rooms/:id to clean up. */
export async function deleteRoom(name) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${COLLAB_HTTP}/rooms/${name}`, { method: 'DELETE' }, (res) => {
      res.resume();
      res.on('end', () => resolve());
    });
    req.on('error', () => resolve()); // ignore errors on cleanup
    req.end();
  });
}

/**
 * Open a new page in the given context, navigate to /?room=name,
 * and wait for the editor to be ready.
 */
export async function joinRoom(context, roomName) {
  const page = await context.newPage();
  await page.goto(`http://localhost:5173/?room=${roomName}`);
  // Wait for either the identity modal input or the editor to appear
  await page.waitForSelector('[contenteditable], input[placeholder*="name" i]', { timeout: 15000 });
  await page.waitForTimeout(500);
  return page;
}

/** Get visible text content of the nth editable block. */
export async function getBlockText(page, index = 0) {
  const blocks = page.locator('[contenteditable]');
  return blocks.nth(index).textContent();
}

/**
 * Seed a room with .SEC content via the upload endpoint.
 * Requires a live Y.Doc on the server (at least one WebSocket client connected).
 * The caller should connect one client first, then call this, then connect others.
 */
export async function seedRoom(roomId, secContent) {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(secContent, 'latin1');
    const req = http.request(`${COLLAB_HTTP}/rooms/${roomId}/upload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': body.length },
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        if (res.statusCode === 200) resolve(JSON.parse(Buffer.concat(chunks).toString()));
        else reject(new Error(`seedRoom ${roomId}: ${res.statusCode} ${Buffer.concat(chunks).toString()}`));
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

/** Minimal .SEC content for seeding test rooms. */
export const MINIMAL_SEC = `<?xml version="1.0" encoding="windows-1252"?><SEC><MTA NAME="SUBFORMAT" CONTENT="NEW"/><MTA NAME="AUTONUMBER" CONTENT="TRUE"/><HDR/><PRT><TTL>PART 1   GENERAL</TTL><SPT><TTL>1.1   TEST SECTION</TTL><TXT>This is seeded test content.</TXT></SPT></PRT></SEC>`;

/** Wait for the collab connection to establish and editor to be ready. */
export async function waitForConnected(page) {
  // Wait until at least one contenteditable block is visible and no
  // "Connecting" text remains on the page. The ConnectionBanner renders
  // null when connected, so once contenteditable exists and no banner
  // text is present, we're good.
  await page.waitForSelector('[contenteditable]', { timeout: 20000 });
  // Give Yjs a moment to complete the sync handshake
  await page.waitForTimeout(1000);
}

/**
 * Wait for blocks to become editable (collabReadOnly cleared).
 * Use after waitForConnected + room seeding to ensure the editor is interactive.
 */
export async function waitForEditable(page) {
  await page.waitForSelector('[contenteditable="true"]', { timeout: 25000 });
}
