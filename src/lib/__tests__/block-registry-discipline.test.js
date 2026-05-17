// src/lib/__tests__/block-registry-discipline.test.js
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';

// Scope: production source under src/ only. tests/e2e/ is deliberately
// excluded — Playwright in-page evaluate() runs in the browser context
// where block-registry is not exposed as a global, so test scripts must
// use a DOM query to inspect the rendered editor (e.g.
// `tests/e2e/editor.spec.js:413` reads injected block html for assertions).
// The discipline being enforced here is the App.jsx ↔ component focus
// path: production code must go through the imperative-handle registry,
// not querySelector. Widening to tests/ would only force a whitelist
// marker on every in-page evaluate, with no behavioral benefit.
const SRC = join(process.cwd(), 'src');
// Allow the literal pattern inside the registry itself + the registry's
// own tests + the inline whitelist marker `/* allowed: block-registry fallback */`.
// Catches single quote, double quote, and backtick (template literal) forms.
const FORBIDDEN = /querySelector\(['"`]\[data-block-id/;
const WHITELIST_MARKER = /\/\* allowed: block-registry fallback \*\//;
const ALLOWED_FILES = new Set([
  'lib/block-registry.js',
]);

function walk(dir, files = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (name === '__tests__') continue;
      walk(full, files);
    } else if (st.isFile() && /\.(js|jsx)$/.test(name)) {
      files.push(full);
    }
  }
  return files;
}

describe('block-registry discipline', () => {
  it('no src/ file outside block-registry.js calls querySelector on [data-block-id] without the whitelist marker', () => {
    const offenders = [];
    for (const full of walk(SRC)) {
      const rel = relative(SRC, full).replace(/\\/g, '/');
      if (ALLOWED_FILES.has(rel)) continue;
      const text = readFileSync(full, 'utf8');
      const lines = text.split('\n');
      lines.forEach((line, idx) => {
        // Skip single-line comments — they may reference the forbidden
        // pattern as documentation (e.g. "Was: querySelector('[data-block-id=…]')").
        const trimmed = line.trim();
        if (trimmed.startsWith('//') || trimmed.startsWith('*')) return;
        if (FORBIDDEN.test(line) && !WHITELIST_MARKER.test(line)) {
          offenders.push(`${rel}:${idx + 1}  ${trimmed}`);
        }
      });
    }
    expect(offenders, `Forbidden querySelector pattern. Route through block-registry.js or add inline marker:\n${offenders.join('\n')}`).toEqual([]);
  });
});
