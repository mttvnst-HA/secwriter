/**
 * Feature flags for SecWriter.
 *
 * Sub-PR 1e (#47, ADR-0006): VITE_PM_EDITOR mounts a y-prosemirror EditorView
 * inside each editable block, replacing the legacy contentEditable + binder
 * snapshot-write path. The flag stays default-off through 1e/1f/1g/1h. The
 * 1i sub-PR removes the flag entirely.
 *
 * Truthy values: '1', 'true', 'yes', 'on' (case-insensitive). Anything else
 * (undefined, '0', '', 'false') is off. Vite inlines `import.meta.env` at
 * build time, so reading it through this module is zero-cost in production.
 */

function readFlag(value) {
  if (value == null) return false;
  const s = String(value).trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

// import.meta.env is undefined in the Node test runner unless Vite is in the
// loop. The optional-chaining + try keeps non-Vite imports (Node tests of
// pure modules) from blowing up.
//
// Override precedence (highest first):
//   1. window.__SIM_FORCE_PM_EDITOR — explicit dev / harness override.
//      A developer setting `window.__SIM_FORCE_PM_EDITOR = undefined`
//      means "no override" (let URL or env decide), NOT "force off" — the
//      assigned-undefined case falls through. The legacy `in` check
//      treated assigned-undefined as a present override and bypassed the
//      URL fallback (QC minor-9).
//   2. URL ?pm=1|true|on — what the Playwright E2E harness uses to flip
//      the PM project without booting a second Vite dev server
//   3. import.meta.env.VITE_PM_EDITOR — the production-style env switch
function readPmEditorFlag() {
  if (typeof window !== 'undefined'
      && '__SIM_FORCE_PM_EDITOR' in window
      && window.__SIM_FORCE_PM_EDITOR !== undefined) {
    return readFlag(window.__SIM_FORCE_PM_EDITOR);
  }
  if (typeof window !== 'undefined' && window.location?.search) {
    try {
      const params = new URLSearchParams(window.location.search);
      if (params.has('pm')) return readFlag(params.get('pm'));
    } catch {
      // URL parse error: fall through to env.
    }
  }
  try {
    return readFlag(import.meta?.env?.VITE_PM_EDITOR);
  } catch {
    return false;
  }
}

export const PM_EDITOR_ENABLED = readPmEditorFlag();

// Re-readable for tests that flip window.__SIM_FORCE_PM_EDITOR mid-run.
export function isPmEditorEnabled() {
  return readPmEditorFlag();
}
