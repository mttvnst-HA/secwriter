// Pre-paint theme application. Runs as a blocking, same-origin (CSP `script-src
// 'self'`) classic script in <head> BEFORE first paint, so token-driven
// backgrounds resolve to the correct theme on frame 0. Without this the
// `.dark-mode` class is only added in an App useEffect (post-paint), which
// (1) flashes light content for dark-mode users (FOUC) and (2) triggers a
// light->dark `transition: background` on token-driven surfaces (note blocks,
// the tailoring bar) that can stick at its light start-frame — rendering notes
// as light-on-light in dark mode. Mirrors the darkMode init in src/App.jsx;
// the key must stay in sync with the `sim-dark-mode` localStorage key there.
(function () {
  try {
    if (localStorage.getItem('sim-dark-mode') === 'true') {
      document.documentElement.classList.add('dark-mode');
    }
  } catch (e) {
    /* localStorage unavailable (private mode / disabled) — fall back to light. */
  }
})();
