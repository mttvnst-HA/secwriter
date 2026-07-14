/**
 * useFileSession — App's file-session I/O intent (architecture-review
 * candidate #1, slices 1 + 2). Symmetric file I/O: neither half owns document
 * state.
 *
 * OUTPUT half (slice 1) — "write the document out": local Save / Save As
 * (File System Access API handle → picker → download fallback), the .SEC +
 * comments + lint sidecars, and the in-room server downloads. Every action is
 * a READER of editor state — it consumes `blocks`/`sectionMeta`/`comments`/
 * `lintingState`/`currentFile` and emits files or file-handles.
 *
 * INPUT half (slice 2) — the file-INPUT *I/O shell*: drag-over UI state,
 * multi-file drag-drop parsing (.sec/.xml vs .lint.json companion), the two
 * concurrent FileReaders, windows-1252 decode, and lint-companion staging.
 * The shell hides ~55 LOC of DOM/FileReader mechanism behind a single
 * `onFileLoaded(text, name, lintText)` callback. It deliberately does NOT
 * absorb `loadSECContent` — that is a whole-document reset (7 App-state
 * setters) whose home is document-state management, not file I/O; threading
 * those setters through here would be a shallow relocation (the hook would own
 * nothing). So App keeps `loadSECContent` / `extractMetadata` /
 * `applyLintSidecarPayload` and passes `loadSECContent` as `onFileLoaded`.
 * The lint companion text is passed as `onFileLoaded`'s third arg (read from
 * the internal staging ref at the same instant `loadSECContent` used to read
 * it) so the racy parallel-read timing is preserved — behavior-preserving.
 *
 * App still owns `currentFile`, `saveStatus`, and `isDirty` state (render +
 * `loadSECContent` read them); this hook receives them plus the two setters it
 * drives (`setSaveStatus`, `setIsDirty`) and `setCurrentFile` (to record a
 * freshly-picked FSA handle). The four output handlers preserve the exact
 * useCallback dependency chains they had in App so their identities churn
 * identically — the keyboard effect that depends on `handleSave` re-binds on
 * the same inputs as before.
 *
 * handleExport / doFileSave / saveCommentsSidecar / saveLintSidecar (output)
 * and handleFileImport (input) are internal helpers, so they are not returned.
 * The `clearHistoryRef` bridge stays in App: it is a declaration-order
 * artifact of `loadSECContent` living before `useCollabSession`, orthogonal to
 * file I/O.
 */

import { useCallback, useRef, useState } from 'react';

import { serializeSEC } from '../lib/sec-serializer.js';
import { encodeWindows1252 } from '../lib/encoding.js';
import { getDisplayName, getSidecarName, getLintSidecarName } from '../lib/current-file.js';
import { supportsFileSystemAccess, saveToFileHandle } from '../lib/auto-save.js';
import { encodeSidecarV2 } from '../lib/lint-sidecar.js';
import { flushAllPendingUpdates } from '../lib/block-registry.js';
import { DEFAULT_HTTP_URL } from '../lib/collab.js';

const COLLAB_HTTP_URL = DEFAULT_HTTP_URL;

export function useFileSession({
  blocks,
  blocksRef,
  sectionMeta,
  currentFile,
  setCurrentFile,
  comments,
  lintingState,
  inRoom,
  roomId,
  authHeaders,
  setSaveStatus,
  setIsDirty,
  onFileLoaded,
}) {
  // --- SEC File Export ---
  const handleExport = useCallback(() => {
    flushAllPendingUpdates(); // #213 — see handleSave
    const xml = serializeSEC(blocksRef.current, sectionMeta);
    const encoded = encodeWindows1252(xml);
    const blob = new Blob([encoded], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = getDisplayName(currentFile);
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    // Export comments sidecar if any comments exist
    if (comments.size > 0) {
      const commentsData = { version: 1, comments: Array.from(comments.values()) };
      const commentsBlob = new Blob([JSON.stringify(commentsData, null, 2)], { type: 'application/json' });
      const commentsUrl = URL.createObjectURL(commentsBlob);
      const ca = document.createElement('a');
      ca.href = commentsUrl;
      ca.download = getSidecarName(currentFile);
      document.body.appendChild(ca);
      ca.click();
      document.body.removeChild(ca);
      URL.revokeObjectURL(commentsUrl);
    }
  }, [sectionMeta, currentFile, comments, blocksRef]);

  // Save helpers
  const doFileSave = useCallback(async (encoded, promptNewLocation) => {
    // Try existing file handle first (unless forcing new location)
    if (!promptNewLocation && currentFile.sec.handle) {
      const ok = await saveToFileHandle(currentFile.sec.handle, encoded);
      if (ok) return true;
    }
    // Try File System Access API — prompt for location
    if (supportsFileSystemAccess()) {
      try {
        const handle = await window.showSaveFilePicker({
          suggestedName: getDisplayName(currentFile),
          types: [{ description: 'SEC File', accept: { 'application/octet-stream': ['.sec', '.SEC'] } }],
        });
        // handle.name becomes authoritative via getDisplayName — no separate
        // setter needed for the displayed name.
        setCurrentFile(prev => ({ ...prev, sec: { ...prev.sec, handle } }));
        return await saveToFileHandle(handle, encoded);
      } catch {
        return false; // user cancelled
      }
    }
    // Fallback: download
    handleExport();
    return true;
  }, [currentFile, handleExport, setCurrentFile]);

  // Save comments sidecar alongside the SEC file
  const saveCommentsSidecar = useCallback(async (promptNew) => {
    if (comments.size === 0) return;
    const commentsData = { version: 1, comments: Array.from(comments.values()) };
    const sidecarName = getSidecarName(currentFile);

    // Try existing handle
    if (!promptNew && currentFile.sidecar.handle) {
      await saveToFileHandle(currentFile.sidecar.handle,
        new TextEncoder().encode(JSON.stringify(commentsData, null, 2)));
      return;
    }

    // Try File System Access API
    if (supportsFileSystemAccess()) {
      try {
        const handle = await window.showSaveFilePicker({
          suggestedName: sidecarName,
          types: [{ description: 'JSON', accept: { 'application/json': ['.json'] } }],
        });
        setCurrentFile(prev => ({ ...prev, sidecar: { ...prev.sidecar, handle } }));
        await saveToFileHandle(handle,
          new TextEncoder().encode(JSON.stringify(commentsData, null, 2)));
        return;
      } catch { /* user cancelled */ }
    }

    // Fallback: download
    const blob = new Blob([JSON.stringify(commentsData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = sidecarName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [comments, currentFile, setCurrentFile]);

  // Save lint sidecar (.lint.json) — block-granular linting cache, issue #138.
  // v2 (issue #140) also persists per-finding dismissals + per-rule NLP mutes,
  // so file-mode round-trip (save → reload) preserves user dismissals just like
  // collab-mode (via yLintIgnored / yLintMutedNlp). Mirrors saveCommentsSidecar's
  // pattern (FSA handle → picker → download). The cache exists per-block in
  // lintingState.byBlock; we encode it against the current blocks array so
  // the fingerprint reflects the just-saved html. Falls through to v1 when
  // both ignored arrays are empty (encodeSidecarV2 handles the fallthrough).
  const saveLintSidecar = useCallback(async (promptNew) => {
    const hasByBlock = lintingState && lintingState.byBlock.size > 0;
    const hasIgnored = lintingState?.ignored?.findings?.size > 0
      || lintingState?.ignored?.mutedRules?.size > 0;
    if (!hasByBlock && !hasIgnored) return;
    let payload;
    try {
      // Findings Map keys ARE the ignoreKeys (entry values omit it), so
      // project via entries() to recover the ignoreKey field expected by
      // encodeSidecarV2's ignoredFindings entries.
      const ignoredFindings = lintingState?.ignored?.findings
        ? Array.from(lintingState.ignored.findings.entries()).map(([ignoreKey, entry]) => ({
            ignoreKey,
            ruleId: entry.ruleId,
            blockHash: entry.blockHash,
            match: entry.match,
            ts: entry.ts,
            authorId: entry.authorId,
            ...(entry.tombstone === true ? { tombstone: true } : {}),
          }))
        : [];
      // mutedRules Map keys ARE the ruleIds (entry values carry only
      // { ts, authorId, tombstone? }), so project via entries() to recover
      // the ruleId field expected by encodeSidecarV2's mutedNlpRules entries.
      const mutedNlpRules = lintingState?.ignored?.mutedRules
        ? Array.from(lintingState.ignored.mutedRules.entries()).map(([ruleId, entry]) => ({
            ruleId,
            ts: entry.ts,
            authorId: entry.authorId,
            ...(entry.tombstone === true ? { tombstone: true } : {}),
          }))
        : [];
      payload = await encodeSidecarV2(lintingState.byBlock, blocks, {
        ignoredFindings,
        mutedNlpRules,
      });
    } catch {
      return; // best effort — sidecar is a cache, not source of truth
    }
    if (!payload) return;
    const emptyV1 = !payload.good && Object.keys(payload.bad || {}).length === 0;
    const emptyV2 = (payload.ignoredFindings || []).length === 0
      && (payload.mutedNlpRules || []).length === 0;
    if (emptyV1 && emptyV2) return;
    const json = JSON.stringify(payload);
    const sidecarName = getLintSidecarName(currentFile);

    // Try existing handle
    if (!promptNew && currentFile.lintSidecar?.handle) {
      await saveToFileHandle(currentFile.lintSidecar.handle, new TextEncoder().encode(json));
      return;
    }

    // Try File System Access API — but unlike comments, do NOT prompt the
    // user for the lint cache. Treat it as best-effort: persist when an FSA
    // handle is already attached, otherwise skip silently. Avoids surprising
    // the user with an extra Save dialog for a derived cache.
    if (supportsFileSystemAccess() && promptNew) {
      try {
        const handle = await window.showSaveFilePicker({
          suggestedName: sidecarName,
          types: [{ description: 'JSON', accept: { 'application/json': ['.json'] } }],
        });
        setCurrentFile(prev => ({ ...prev, lintSidecar: { ...prev.lintSidecar, handle } }));
        await saveToFileHandle(handle, new TextEncoder().encode(json));
      } catch { /* user cancelled */ }
    }
  }, [lintingState, blocks, currentFile, setCurrentFile]);

  // Save (Ctrl+S) — save to current location, or prompt if first save
  const handleSave = useCallback(async () => {
    if (inRoom && roomId) {
      // Server already persists — just show confirmation
      setSaveStatus('saved');
      setTimeout(() => setSaveStatus(null), 2000);
      return;
    }
    setSaveStatus('saving');
    // #213 — drain PM's 400ms onUpdate debounce so the most recent keystrokes
    // (still focused, not yet synced to React `blocks`) reach the serializer.
    // The flush mutates blocksRef.current synchronously (ADR-0008); the
    // closed-over `blocks` would still be stale.
    flushAllPendingUpdates();
    const xml = serializeSEC(blocksRef.current, sectionMeta);
    const encoded = encodeWindows1252(xml);
    const ok = await doFileSave(encoded, false);
    if (ok) {
      await saveCommentsSidecar(false);
      await saveLintSidecar(false);
      setIsDirty(false);
      setSaveStatus('saved');
      setTimeout(() => setSaveStatus(null), 2000);
    } else {
      setSaveStatus(null);
    }
  }, [sectionMeta, doFileSave, saveCommentsSidecar, saveLintSidecar, inRoom, roomId, blocksRef, setSaveStatus, setIsDirty]);

  // Save As — always prompt for new location
  const handleSaveAs = useCallback(async () => {
    setSaveStatus('saving');
    flushAllPendingUpdates(); // #213 — see handleSave
    const xml = serializeSEC(blocksRef.current, sectionMeta);
    const encoded = encodeWindows1252(xml);
    const ok = await doFileSave(encoded, true);
    if (ok) {
      await saveCommentsSidecar(true);
      await saveLintSidecar(true);
      setIsDirty(false);
      setSaveStatus('saved');
      setTimeout(() => setSaveStatus(null), 2000);
    } else {
      setSaveStatus(null);
    }
  }, [sectionMeta, doFileSave, saveCommentsSidecar, saveLintSidecar, blocksRef, setSaveStatus, setIsDirty]);

  // Download .SEC from collab server (in-room only)
  const handleDownloadSec = useCallback(async () => {
    if (!roomId) return;
    try {
      const resp = await fetch(`${COLLAB_HTTP_URL}/rooms/${roomId}/sec`, { headers: authHeaders });
      if (!resp.ok) throw new Error(`Server returned ${resp.status}`);
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${sectionMeta.sectionNumber?.replace(/\s+/g, '_') || roomId}.SEC`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('Download SEC failed:', err);
      setSaveStatus('error');
      setTimeout(() => setSaveStatus(null), 2000);
    }
  }, [roomId, sectionMeta.sectionNumber, authHeaders, setSaveStatus]);

  // Download comments JSON from collab server (in-room only)
  const handleDownloadComments = useCallback(async () => {
    if (!roomId) return;
    try {
      const resp = await fetch(`${COLLAB_HTTP_URL}/rooms/${roomId}/comments`, { headers: authHeaders });
      if (!resp.ok) throw new Error(`Server returned ${resp.status}`);
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${sectionMeta.sectionNumber?.replace(/\s+/g, '_') || roomId}.comments.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('Download comments failed:', err);
    }
  }, [roomId, sectionMeta.sectionNumber, authHeaders]);

  // --- File input (I/O shell) ---
  const fileInputRef = useRef(null);
  const [isDragOver, setIsDragOver] = useState(false);
  // Lint sidecar payload (.lint.json text) staged for the next import call —
  // populated by the drag-drop handler when a companion file is part of the
  // drop, consumed (and cleared) inside handleFileImport's SEC-reader onload
  // and forwarded to onFileLoaded so `loadSECContent` reads it at the same
  // instant it used to read this ref (preserves the racy parallel-read).
  const pendingLintSidecarRef = useRef(null);

  // --- SEC File Import ---
  const handleFileImport = useCallback((file) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      // SEC files use windows-1252 encoding, not UTF-8
      const decoder = new TextDecoder('windows-1252');
      const text = decoder.decode(e.target.result);
      // Consume the staged lint companion at the same point loadSECContent
      // used to read pendingLintSidecarRef.current, then clear it.
      const pendingLint = pendingLintSidecarRef.current;
      pendingLintSidecarRef.current = null;
      onFileLoaded?.(text, file.name, pendingLint);
    };
    reader.onerror = () => {
      alert(`Failed to read file: ${file.name}`);
    };
    reader.readAsArrayBuffer(file);
  }, [onFileLoaded]);

  const handleDragOver = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
  }, []);

  const handleDrop = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
    // The user may drop just a .SEC, or .SEC + .lint.json companion (#138).
    // Pick the .SEC for import; collect a sibling .lint.json (if any) and
    // hand its text to applyLintSidecarPayload after the SEC parse settles.
    const files = Array.from(e.dataTransfer.files || []);
    const secFile = files.find(f => f && (f.name.toLowerCase().endsWith('.sec') || f.name.toLowerCase().endsWith('.xml')));
    if (!secFile) return;
    const lintFile = files.find(f => f && f.name.toLowerCase().endsWith('.lint.json'));
    if (lintFile) {
      // Read lint json in parallel; applied inside loadSECContent after the parse.
      const lintReader = new FileReader();
      lintReader.onload = (ev) => {
        pendingLintSidecarRef.current = typeof ev.target.result === 'string' ? ev.target.result : null;
      };
      lintReader.onerror = () => { pendingLintSidecarRef.current = null; };
      lintReader.readAsText(lintFile);
    } else {
      pendingLintSidecarRef.current = null;
    }
    handleFileImport(secFile);
  }, [handleFileImport]);

  const handleFileInputChange = useCallback((e) => {
    handleFileImport(e.target.files[0]);
    e.target.value = ''; // Reset so same file can be re-imported
  }, [handleFileImport]);

  return {
    handleSave,
    handleSaveAs,
    handleDownloadSec,
    handleDownloadComments,
    fileInputRef,
    isDragOver,
    handleDragOver,
    handleDragLeave,
    handleDrop,
    handleFileInputChange,
  };
}
