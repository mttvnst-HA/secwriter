// Wrapper for preview_start — Vite 8 removed --root CLI flag.
// This script strips --root from args and uses the Vite JS API instead.
import { createServer } from 'vite';

const raw = process.argv.slice(2);
let port = 5173;
let root;
for (let i = 0; i < raw.length; i++) {
  if (raw[i] === '--port' && raw[i + 1]) { port = parseInt(raw[i + 1]); i++; continue; }
  if (raw[i] === '--root' && raw[i + 1]) { root = raw[i + 1]; i++; continue; }
  if (raw[i].startsWith('--root=')) { root = raw[i].split('=')[1]; continue; }
}

const server = await createServer({
  root: root || process.cwd(),
  server: { port, strictPort: true, host: true },
});
await server.listen();
server.printUrls();
