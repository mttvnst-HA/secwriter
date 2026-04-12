/**
 * Shared helpers for collab E2E tests.
 */
import http from 'node:http';

const COLLAB_HTTP = 'http://127.0.0.1:1235';

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
  await page.waitForSelector('[contenteditable]', { timeout: 10000 });
  await page.waitForTimeout(500);
  return page;
}

/** Get visible text content of the nth editable block. */
export async function getBlockText(page, index = 0) {
  const blocks = page.locator('[contenteditable="true"]');
  return blocks.nth(index).textContent();
}

/** Wait for connection banner to disappear (connected state). */
export async function waitForConnected(page) {
  await page.waitForFunction(() => {
    const banner = document.querySelector('.connection-banner');
    return !banner || banner.style.display === 'none';
  }, { timeout: 10000 });
}
