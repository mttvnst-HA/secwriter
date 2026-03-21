/**
 * Auto-save and file persistence for SIM.
 *
 * Two persistence layers:
 * 1. localStorage auto-save — crash recovery, saves every few seconds
 * 2. File System Access API — Ctrl+S writes back to original file on disk
 */

const AUTO_SAVE_KEY = 'sim-autosave';
const AUTO_SAVE_TIMESTAMP_KEY = 'sim-autosave-ts';

/**
 * Save document state to localStorage.
 */
export function autoSave(blocks, sectionMeta, comments, fileName) {
  try {
    const data = {
      blocks,
      sectionMeta,
      comments: Array.from(comments.values()),
      fileName,
      savedAt: new Date().toISOString(),
    };
    localStorage.setItem(AUTO_SAVE_KEY, JSON.stringify(data));
    localStorage.setItem(AUTO_SAVE_TIMESTAMP_KEY, data.savedAt);
  } catch (e) {
    // localStorage might be full — silently fail
    console.warn('Auto-save failed:', e.message);
  }
}

/**
 * Load auto-saved document state from localStorage.
 * Returns null if no auto-save exists.
 */
export function loadAutoSave() {
  try {
    const raw = localStorage.getItem(AUTO_SAVE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (!data.blocks || !Array.isArray(data.blocks) || data.blocks.length === 0) return null;
    return data;
  } catch {
    return null;
  }
}

/**
 * Clear auto-save data from localStorage.
 */
export function clearAutoSave() {
  localStorage.removeItem(AUTO_SAVE_KEY);
  localStorage.removeItem(AUTO_SAVE_TIMESTAMP_KEY);
}

/**
 * Get the timestamp of the last auto-save, or null.
 */
export function getAutoSaveTimestamp() {
  return localStorage.getItem(AUTO_SAVE_TIMESTAMP_KEY) || null;
}

/**
 * Check if the File System Access API is supported.
 */
export function supportsFileSystemAccess() {
  return typeof window !== 'undefined' && 'showSaveFilePicker' in window;
}

/**
 * Save the SEC file using a stored file handle (File System Access API).
 * @param {FileSystemFileHandle} fileHandle
 * @param {Uint8Array} encoded - the encoded SEC file bytes
 * @returns {Promise<boolean>} true if save succeeded
 */
export async function saveToFileHandle(fileHandle, encoded) {
  try {
    const writable = await fileHandle.createWritable();
    await writable.write(encoded);
    await writable.close();
    return true;
  } catch (e) {
    console.warn('File save failed:', e.message);
    return false;
  }
}

/**
 * Save comments sidecar to a file handle.
 * Creates a new file handle based on the SEC file name.
 */
export async function saveCommentsToFile(commentsData, suggestedName) {
  try {
    const handle = await window.showSaveFilePicker({
      suggestedName,
      types: [{ description: 'JSON', accept: { 'application/json': ['.json'] } }],
    });
    const writable = await handle.createWritable();
    await writable.write(JSON.stringify(commentsData, null, 2));
    await writable.close();
    return true;
  } catch {
    return false; // user cancelled
  }
}
