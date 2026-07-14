import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// Pins the FOUC pre-paint contract (PR #280). `public/theme-init.js` runs
// before first paint and must stay in lockstep with App.jsx's darkMode init:
// the localStorage KEY and the string value `'true'` are duplicated across
// the two files with no shared import, so a rename in one silently
// reintroduces the dark-mode flash (light-on-light notes) with zero other
// test failures. This test is the tripwire — see CLAUDE.md "Dark mode".
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => readFileSync(resolve(repoRoot, rel), 'utf8');

describe('theme-init pre-paint contract', () => {
  const themeInit = read('public/theme-init.js');
  const appJsx = read('src/App.jsx');
  const indexHtml = read('index.html');

  it('theme-init reads the same localStorage key + value App.jsx uses', () => {
    expect(themeInit).toContain("localStorage.getItem('sim-dark-mode')");
    expect(themeInit).toContain("=== 'true'");
    // App.jsx side of the coupling (init read + persist write).
    expect(appJsx).toContain("localStorage.getItem('sim-dark-mode') === 'true'");
    expect(appJsx).toContain("localStorage.setItem('sim-dark-mode', String(darkMode))");
  });

  it('theme-init toggles the same class on the same element App.jsx does', () => {
    expect(themeInit).toContain("classList.add('dark-mode')");
    expect(themeInit).toContain('document.documentElement');
    expect(appJsx).toContain("document.documentElement.classList.toggle('dark-mode'");
  });

  it('index.html loads theme-init before the app module (pre-paint ordering)', () => {
    const initPos = indexHtml.indexOf('theme-init.js');
    const modulePos = indexHtml.indexOf('src/main.jsx');
    expect(initPos).toBeGreaterThan(-1);
    expect(modulePos).toBeGreaterThan(-1);
    expect(initPos).toBeLessThan(modulePos);
  });
});
