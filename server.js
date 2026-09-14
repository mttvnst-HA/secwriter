import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
// SIM_STATIC_DIR lets the test suite point the server at a fixture dir.
const DIST = process.env.SIM_STATIC_DIR || join(__dirname, 'dist');
const PORT = process.env.PORT || 8080;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};

const INDEX = join(DIST, 'index.html');

const server = createServer(async (req, res) => {
  // WHATWG URL parsing collapses `.`/`..` (and `%2e`) segments before we
  // touch the filesystem, so `join` can never escape DIST.
  const url = new URL(req.url, `http://${req.headers.host}`);
  const exactPath = join(DIST, url.pathname);

  // Read the exact path directly and fall back to index.html (SPA routing)
  // when that fails — no separate existence probe, so there is no
  // check-then-use window (CodeQL js/file-system-race) and one fewer
  // syscall per request. A directory (EISDIR), a path through a file
  // (ENOTDIR), or a missing file (ENOENT) all mean "not a static asset".
  let filePath = exactPath;
  let data;
  try {
    data = await readFile(exactPath);
  } catch {
    filePath = INDEX;
    try {
      data = await readFile(INDEX);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
      return;
    }
  }

  const ext = extname(filePath);
  const mime = MIME[ext] || 'application/octet-stream';

  // Long cache for Vite hashed assets, no-cache for HTML. Keyed on what was
  // actually served: a MISSING /assets/* URL falls back to index.html and
  // must not be cached as immutable under the asset URL.
  const cache = filePath !== INDEX && url.pathname.startsWith('/assets/')
    ? 'public, max-age=31536000, immutable'
    : 'no-cache';

  res.writeHead(200, {
    'Content-Type': mime,
    'Cache-Control': cache,
  });
  res.end(data);
});

server.listen(PORT, () => {
  // Report the bound port (PORT=0 picks an ephemeral one).
  console.log(`SecWriter static server listening on port ${server.address().port}`);
});
