/**
 * current-file.js — Client-side identity of the file the user is editing.
 *
 * Pinned by CONTEXT.md "Local file" section. The record bundles the SEC
 * handle/fallbackName and the sidecar handle so cross-file loads can swap
 * the whole record atomically — a stale sec.handle cannot survive into a
 * save against the next file.
 */

export const CURRENT_FILE_INITIAL = {
  sec: { handle: null, fallbackName: '31_00_00.SEC' },
  sidecar: { handle: null },
  lintSidecar: { handle: null },
};

/**
 * Display name for the SEC file. `handle.name` wins; `fallbackName` is used
 * when no FSA handle exists (drag-drop import, file-input picker,
 * autosave-restore, brand-new doc). `'output.SEC'` is the last-resort
 * default so callers never deal with empty strings.
 */
export function getDisplayName(currentFile) {
  return currentFile.sec.handle?.name ?? currentFile.sec.fallbackName ?? 'output.SEC';
}

/** Sidecar (.comments.json) filename derived from the SEC display name. */
export function getSidecarName(currentFile) {
  return getDisplayName(currentFile).replace(/\.sec$/i, '.comments.json');
}

/**
 * Lint sidecar (.lint.json) filename derived from the SEC display name
 * (issue #138). Block-granular linting cache; mirrors getSidecarName.
 */
export function getLintSidecarName(currentFile) {
  return getDisplayName(currentFile).replace(/\.sec$/i, '.lint.json');
}
