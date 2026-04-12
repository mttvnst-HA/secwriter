import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import { FileText, Search, Upload, Download, Check, Loader, Users } from "lucide-react";
import TreeNode from "./components/TreeNode.jsx";
// MarkLegend component preserved for future user manual documentation (removed from toolbar UI)
import EditableBlock from "./components/EditableBlock.jsx";
import TitleBlock from "./components/TitleBlock.jsx";
import TableBlock from "./components/TableBlock.jsx";
import PreformattedBlock from "./components/PreformattedBlock.jsx";
import RefBlock from "./components/RefBlock.jsx";
import FloatingToolbar from "./components/FloatingToolbar.jsx";
import MarkSuggestions from "./components/MarkSuggestions.jsx";
import TailoringProfile from "./components/TailoringProfile.jsx";
import { computeNumbering, computeOliLabels } from "./lib/numbering.js";
import { NO_EXFIL_PROPS } from "./lib/no-exfil.js";
import { resolveTaiInHtml, cleanTaiClasses } from "./lib/tailor-profile.js";
import RevisionControls from "./components/RevisionControls.jsx";
import CrossRefPanel from "./components/CrossRefPanel.jsx";
import SearchBar, { replaceMatchInHtml } from "./components/SearchBar.jsx";
import BracketReplace from "./components/BracketReplace.jsx";
import ValidationPanel from "./components/ValidationPanel.jsx";
import RefWizard from "./components/RefWizard.jsx";
import CommentPopup, { getAuthorName } from "./components/CommentPopup.jsx";
import CompliancePanel from "./components/CompliancePanel.jsx";
import { acceptAllRevisions, rejectAllRevisions, acceptAllInline, rejectAllInline } from "./lib/revisions.js";
import { compileRegister, generateRegisterReport } from "./lib/submittal-register.js";
import { generateExportHtml } from "./lib/doc-export.js";
import { autoSave, loadAutoSave, clearAutoSave, getAutoSaveTimestamp, supportsFileSystemAccess, saveToFileHandle } from "./lib/auto-save.js";
import { buildTree } from "./lib/tree-builder.js";
import { reorderSection } from "./lib/block-reorder.js";
import { generateCommentReport } from "./lib/comment-report.js";
import { parseSEC } from "./lib/sec-parser.js";
import { serializeSEC } from "./lib/sec-serializer.js";
import { encodeWindows1252 } from "./lib/encoding.js";
import { getVisibleTextFromHtml } from "./lib/text-diff.js";
import { useUndoableBlocks } from "./lib/useUndoableBlocks.js";
import { clearInlineLinting } from "./lib/inline-linter.js";
import INITIAL_BLOCKS from "./data/sample-31-00-00.json";
import { createCollabSession, getRoomFromUrl, buildRoomUrl, generateRoomId, DocSizeLimitError, MAX_PUBLISH_BYTES, DEFAULT_HTTP_URL } from "./lib/collab.js";
import { stripOrphanCommentSpans } from "./lib/orphan-comment-spans.js";
import { loadIdentity } from "./lib/identity.js";
import { getToken, onTokenRefresh, getAuthMode, signOut as authSignOut, getIdentity } from './lib/auth-client.js';
import IdentityModal from "./components/IdentityModal.jsx";
import RoomPanel from "./components/RoomPanel.jsx";
import PresenceBar from "./components/PresenceBar.jsx";
import RemoteCursors from "./components/RemoteCursors.jsx";
import ConnectionBanner from "./components/ConnectionBanner.jsx";
import ToastStack, { useToasts } from "./components/Toast.jsx";

const COLLAB_HTTP_URL = DEFAULT_HTTP_URL;

// Walk text nodes under `root` to compute the plain-text offset of
// (node, offset). Used to transport a caret position across a DOM rewrite
// caused by a remote collab update.
function getPlainTextOffset(root, node, offset) {
  if (!root || !node) return -1;
  let total = 0;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
  let current;
  while ((current = walker.nextNode())) {
    if (current === node) return total + offset;
    total += current.nodeValue.length;
  }
  return -1; // M-6: node not found — caller must bail rather than jump caret to end
}

// Walk text nodes in `root` and resolve a plain-text offset to a
// (textNode, offsetInNode) pair. Returns null if the walker is empty.
// Offsets past the end clamp to the last text node's end.
function resolveOffsetInRoot(root, index) {
  let remaining = index;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
  let current;
  let last = null;
  while ((current = walker.nextNode())) {
    last = current;
    const len = current.nodeValue.length;
    if (remaining <= len) return { node: current, offset: remaining };
    remaining -= len;
  }
  if (last) return { node: last, offset: last.nodeValue.length };
  return null;
}

// Restore a caret or selection inside `root` from plain-text offsets.
//
// If `endIndex` is undefined or equal to `startIndex`, a collapsed caret
// is restored at `startIndex` (unchanged legacy behavior).
//
// If `endIndex > startIndex`, a non-collapsed selection is restored
// spanning both offsets. This preserves text highlighted by the user
// before a remote update arrived — previously the selection was
// silently collapsed, which was a UX surprise during long replacements
// (user thinks text is still selected, types to replace, instead
// appends).
function restorePlainTextOffset(root, startIndex, endIndex) {
  const start = resolveOffsetInRoot(root, startIndex);
  if (!start) { try { root.focus(); } catch { /* ignore */ } return; }
  const range = document.createRange();
  range.setStart(start.node, start.offset);
  if (endIndex === undefined || endIndex <= startIndex) {
    range.collapse(true);
  } else {
    const end = resolveOffsetInRoot(root, endIndex);
    if (end) range.setEnd(end.node, end.offset);
    else range.collapse(true);
  }
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  try { root.focus(); } catch { /* ignore */ }
}

export default function SpecEditor() {
  const {
    blocks, tcSnapshots, setBlocks, setTcSnapshots,
    undo, redo, canUndo, canRedo, clearHistory, resumeHistory,
  } = useUndoableBlocks(INITIAL_BLOCKS);
  const [selectedTreeId, setSelectedTreeId] = useState(null);
  const [focusedBlockId, setFocusedBlockId] = useState(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const [fileName, setFileName] = useState("31_00_00.SEC");
  const [tailorActive, setTailorActive] = useState(false);
  const [tailorProfile, setTailorProfile] = useState({ branch: null, region: null, deliveryMethod: null });
  const [tailorShowAll, setTailorShowAll] = useState(false);
  const [trackChanges, setTrackChanges] = useState(false);
  const [showRevisions, setShowRevisions] = useState(true);
  const [showNotes, setShowNotes] = useState(true);
  const [unitDisplay, setUnitDisplay] = useState('both'); // 'both' | 'eng' | 'met'
  const [showTags, setShowTags] = useState(false); // default OFF — inline marks hidden
  const [darkMode, setDarkMode] = useState(() => {
    try { return localStorage.getItem('sim-dark-mode') === 'true'; } catch { return false; }
  });
  const [sidebarSearch, setSidebarSearch] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [bracketOpen, setBracketOpen] = useState(false);
  const [validationOpen, setValidationOpen] = useState(false);
  const [refWizardOpen, setRefWizardOpen] = useState(false);
  const [comments, setComments] = useState(new Map()); // Map<commentId, comment>
  const [openCommentId, setOpenCommentId] = useState(null);
  const [commentRect, setCommentRect] = useState(null);
  const [showComments, setShowComments] = useState(false);
  const [complianceOpen, setComplianceOpen] = useState(false);
  const [collabReachable, setCollabReachable] = useState(false);
  const [showRoomPanel, setShowRoomPanel] = useState(false);
  const [roomList, setRoomList] = useState([]);
  const [inlineLintingEnabled, setInlineLintingEnabled] = useState(() => {
    try { return localStorage.getItem('sim-inline-linting') !== 'false'; } catch { return true; }
  });
  const [sectionMeta, setSectionMeta] = useState({
    sectionNumber: "31 00 00",
    sectionTitle: "EARTHWORK",
    date: "08/23",
  });
  const [saveStatus, setSaveStatus] = useState(null); // null | 'saving' | 'saved'
  const [isDirty, setIsDirty] = useState(false); // unsaved changes since last file save
  const [editorZoom, setEditorZoom] = useState(() => {
    try { return parseFloat(localStorage.getItem('sim-editor-zoom')) || 1; } catch { return 1; }
  });
  // ── Collaborative editing (prototype) ──────────────────────────────────
  // When ?room=... is present the app joins a Yjs room. The collab session
  // becomes the source of truth for `blocks`; localStorage auto-save and
  // auto-restore are suppressed, and undo/redo is handled by Y.UndoManager.
  const [roomId] = useState(() => getRoomFromUrl());
  const inRoom = !!roomId;
  const [identity, setIdentity] = useState(() => (inRoom ? loadIdentity() : null));
  // Safety net: if auth-client extracted identity from JWT but localStorage
  // wasn't written in time for the useState initializer, sync it here.
  useEffect(() => {
    if (inRoom && !identity) {
      const authIdentity = getIdentity();  // from auth-client
      if (authIdentity) setIdentity(authIdentity);
    }
  }, [inRoom, identity]);
  const [peers, setPeers] = useState([]);
  const [collabStatus, setCollabStatus] = useState(inRoom ? 'connecting' : null);
  const [reconnectIn, setReconnectIn] = useState(0);
  const collabReadOnly = inRoom && collabStatus !== null && collabStatus !== 'connected';
  // Reactive auth token — refreshed by MSAL silent renewal or external host
  const [authToken, setAuthToken] = useState(null);
  const authHeaders = useMemo(
    () => authToken ? { 'Authorization': `Bearer ${authToken}` } : {},
    [authToken]
  );

  useEffect(() => {
    let cancelled = false;
    getToken().then(t => { if (!cancelled && t) setAuthToken(t); });
    const unsub = onTokenRefresh(t => { if (!cancelled) setAuthToken(t); });
    return () => { cancelled = true; unsub(); };
  }, []);
  const toasts = useToasts();
  // A2 — stable ref to toasts.push so effects can fire toasts without
  // needing `toasts` in their dep array. Without this, the publish effect
  // would re-run on every render because `toasts.items` changes whenever
  // a toast is added or dismissed, which in turn would wastefully re-run
  // estimatePublishBytes + ref-equality check on every keystroke.
  const toastPushRef = useRef(toasts.push);
  toastPushRef.current = toasts.push;
  const authHeadersRef = useRef(authHeaders);
  authHeadersRef.current = authHeaders;
  const collabSessionRef = useRef(null);
  // Reference-equality guard: whenever onRemoteBlocks runs, we stash the new
  // array here and the publish effect compares `blocks === lastRemoteBlocksRef.current`
  // to decide whether the change was local (publish) or remote (skip).
  // The previous synchronous `remoteApplyingRef` guard was ineffective because
  // React's effect runs after commit — by then the flag was already cleared,
  // so every remote change got re-published as a local transaction, which
  // (a) corrupted initial persistence on join and (b) caused Y.UndoManager
  // to track remote edits, making Ctrl+Z undo everyone's work.
  const lastRemoteBlocksRef = useRef(null);
  const sessionReadyRef = useRef(false);
  const metaReadyRef = useRef(false);
  const tcDirtyRef = useRef(false);
  // Stash the nextBlocks from the initial onRemoteBlocks call so the
  // subsequent initial onRemoteComments can strip orphan mark-comment
  // spans against the authoritative remote blocks (blocksRef is not
  // yet updated — setBlocks is async).
  const initialBlocksForCleanupRef = useRef(null);

  const fileHandleRef = useRef(null); // File System Access API handle for SEC file
  const commentsHandleRef = useRef(null); // File System Access API handle for comments sidecar
  const editorRef = useRef(null);
  const fileInputRef = useRef(null);
  const blocksRef = useRef(blocks);
  blocksRef.current = blocks;
  const sectionMetaRef = useRef(sectionMeta);
  sectionMetaRef.current = sectionMeta;
  const commentsRef = useRef(new Map());
  commentsRef.current = comments;
  const tree = useMemo(() => buildTree(blocks), [blocks]);
  const numberMap = useMemo(() => computeNumbering(blocks), [blocks]);
  const oliLabels = useMemo(() => computeOliLabels(blocks), [blocks]);

  // Filter tree for sidebar search
  const filteredTree = useMemo(() => {
    if (!sidebarSearch.trim()) return tree;
    const q = sidebarSearch.trim().toLowerCase();
    function filterNodes(nodes) {
      const result = [];
      for (const node of nodes) {
        const childMatches = node.children ? filterNodes(node.children) : [];
        const selfMatches = node.text.toLowerCase().includes(q);
        if (selfMatches || childMatches.length > 0) {
          result.push({ ...node, children: selfMatches && node.children ? node.children : childMatches });
        }
      }
      return result;
    }
    return filterNodes(tree);
  }, [tree, sidebarSearch]);

  // TAI resolution: compute a key that changes when tailoring settings change,
  // forcing EditableBlock to re-render with resolved HTML
  const tailorKey = useMemo(() => {
    if (!tailorActive || !tailorProfile.branch) return null;
    return `${tailorProfile.branch}-${tailorProfile.region || ''}-${tailorProfile.deliveryMethod || ''}-${tailorShowAll}`;
  }, [tailorActive, tailorProfile, tailorShowAll]);

  // Resolve TAI visibility in HTML based on current tailoring profile
  const resolveHtml = useCallback((html) => {
    if (!tailorActive || !tailorProfile.branch) return html;
    return resolveTaiInHtml(html, tailorProfile, tailorShowAll);
  }, [tailorActive, tailorProfile, tailorShowAll]);

  // --- SEC File Import ---
  const extractMetadata = useCallback((xmlString) => {
    const meta = { sectionNumber: '00 00 00', sectionTitle: 'UNTITLED', date: '' };
    // Extract section number from <SCN>
    const scnMatch = xmlString.match(/<SCN[^>]*>SECTION\s+([\d\s.]+)<\/SCN>/i);
    if (scnMatch) meta.sectionNumber = scnMatch[1].trim();
    // Extract title from <STL>
    const stlMatch = xmlString.match(/<STL[^>]*>(.*?)<\/STL>/i);
    if (stlMatch) meta.sectionTitle = stlMatch[1].trim();
    // Extract date from <DTE>
    const dteMatch = xmlString.match(/<DTE[^>]*>(.*?)<\/DTE>/i);
    if (dteMatch) meta.date = dteMatch[1].trim();
    return meta;
  }, []);

  const loadSECContent = useCallback((content, name) => {
    try {
      const parsed = parseSEC(content);
      if (parsed.length === 0) {
        alert('No content blocks found in file. The file may be empty or in an unsupported format.');
        return;
      }
      clearHistory();
      setBlocks(parsed);
      setFileName(name);
      setSectionMeta(extractMetadata(content));
      setSelectedTreeId(null);
      setFocusedBlockId(null);
      // In a room, yComments is the authoritative source — do not wipe shared
      // comment state on a local file import.
      if (!inRoom) setComments(new Map());
      // Prevent cross-file data loss: a stale handle from a previous file
      // would otherwise cause Ctrl+S to silently overwrite that file with
      // the newly-loaded content.
      fileHandleRef.current = null;
      commentsHandleRef.current = null;
      // Drop any localStorage auto-save from the previous file so a future
      // mount-time restore cannot resurrect it over a freshly-loaded file.
      clearAutoSave();
    } catch (err) {
      alert(`Failed to parse SEC file: ${err.message}`);
    }
  }, [extractMetadata, clearHistory]);

  const handleFileImport = useCallback((file) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      // SEC files use windows-1252 encoding, not UTF-8
      const decoder = new TextDecoder('windows-1252');
      const text = decoder.decode(e.target.result);
      loadSECContent(text, file.name);
    };
    reader.onerror = () => {
      alert(`Failed to read file: ${file.name}`);
    };
    reader.readAsArrayBuffer(file);
  }, [loadSECContent]);

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
    const file = e.dataTransfer.files[0];
    if (file && (file.name.toLowerCase().endsWith('.sec') || file.name.toLowerCase().endsWith('.xml'))) {
      handleFileImport(file);
    }
  }, [handleFileImport]);

  const handleFileInputChange = useCallback((e) => {
    handleFileImport(e.target.files[0]);
    e.target.value = ''; // Reset so same file can be re-imported
  }, [handleFileImport]);

  // --- SEC File Export ---
  const handleExport = useCallback(() => {
    const xml = serializeSEC(blocks, sectionMeta);
    const encoded = encodeWindows1252(xml);
    const blob = new Blob([encoded], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName || 'output.SEC';
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
      ca.download = (fileName || 'output.SEC').replace(/\.sec$/i, '.comments.json');
      document.body.appendChild(ca);
      ca.click();
      document.body.removeChild(ca);
      URL.revokeObjectURL(commentsUrl);
    }
  }, [blocks, sectionMeta, fileName, comments]);

  // Save helpers
  const doFileSave = useCallback(async (encoded, promptNewLocation) => {
    // Try existing file handle first (unless forcing new location)
    if (!promptNewLocation && fileHandleRef.current) {
      const ok = await saveToFileHandle(fileHandleRef.current, encoded);
      if (ok) return true;
    }
    // Try File System Access API — prompt for location
    if (supportsFileSystemAccess()) {
      try {
        const handle = await window.showSaveFilePicker({
          suggestedName: fileName || 'output.SEC',
          types: [{ description: 'SEC File', accept: { 'application/octet-stream': ['.sec', '.SEC'] } }],
        });
        fileHandleRef.current = handle;
        // Update fileName from the handle
        if (handle.name) setFileName(handle.name);
        return await saveToFileHandle(handle, encoded);
      } catch {
        return false; // user cancelled
      }
    }
    // Fallback: download
    handleExport();
    return true;
  }, [fileName, handleExport]);

  // Save comments sidecar alongside the SEC file
  const saveCommentsSidecar = useCallback(async (promptNew) => {
    if (comments.size === 0) return;
    const commentsData = { version: 1, comments: Array.from(comments.values()) };
    const sidecarName = (fileName || 'output.SEC').replace(/\.sec$/i, '.comments.json');

    // Try existing handle
    if (!promptNew && commentsHandleRef.current) {
      await saveToFileHandle(commentsHandleRef.current,
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
        commentsHandleRef.current = handle;
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
  }, [comments, fileName]);

  // Save (Ctrl+S) — save to current location, or prompt if first save
  const handleSave = useCallback(async () => {
    if (inRoom && roomId) {
      // Server already persists — just show confirmation
      setSaveStatus('saved');
      setTimeout(() => setSaveStatus(null), 2000);
      return;
    }
    setSaveStatus('saving');
    const xml = serializeSEC(blocks, sectionMeta);
    const encoded = encodeWindows1252(xml);
    const ok = await doFileSave(encoded, false);
    if (ok) {
      await saveCommentsSidecar(false);
      setIsDirty(false);
      setSaveStatus('saved');
      setTimeout(() => setSaveStatus(null), 2000);
    } else {
      setSaveStatus(null);
    }
  }, [blocks, sectionMeta, doFileSave, saveCommentsSidecar, inRoom, roomId]);

  // Save As — always prompt for new location
  const handleSaveAs = useCallback(async () => {
    setSaveStatus('saving');
    const xml = serializeSEC(blocks, sectionMeta);
    const encoded = encodeWindows1252(xml);
    const ok = await doFileSave(encoded, true);
    if (ok) {
      await saveCommentsSidecar(true);
      setIsDirty(false);
      setSaveStatus('saved');
      setTimeout(() => setSaveStatus(null), 2000);
    } else {
      setSaveStatus(null);
    }
  }, [blocks, sectionMeta, doFileSave]);

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
  }, [roomId, sectionMeta.sectionNumber, authHeaders]);

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

  // Programmatic focus for EXISTING elements (arrow nav, tree select, delete-focus-prev)
  // New blocks focus themselves via the ref callback in EditableBlock
  const focusBlock = useCallback((id, atEnd = true) => {
    setFocusedBlockId(id);
    // setTimeout(0) lets React finish any pending state updates first
    setTimeout(() => {
      const el = document.querySelector(`[data-block-id="${id}"]`);
      if (el) {
        el.focus();
        const range = document.createRange();
        const sel = window.getSelection();
        if (el.childNodes.length > 0) {
          range.selectNodeContents(el);
          range.collapse(atEnd);
        }
        sel.removeAllRanges();
        sel.addRange(range);
      }
    }, 0);
  }, []);

  // Click focus - just update the visual highlight, let browser handle native cursor
  const handleClickFocus = useCallback((id) => {
    setFocusedBlockId(id);
  }, []);

  const handleTreeSelect = useCallback((id) => {
    setSelectedTreeId(id);
    focusBlock(id);
    const el = document.getElementById(`block-${id}`);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [focusBlock]);

  const handleReorderSection = useCallback((dragId, dropId, position) => {
    resumeHistory();
    setBlocks(prev => reorderSection(prev, dragId, dropId, position));
  }, [resumeHistory]);

  // Comment handlers
  const handleCommentCreate = useCallback((blockId, html, commentId, highlightText) => {
    // html is null for ref blocks (their data is in block.ref, not block.html)
    if (html !== null) {
      setBlocks(prev => prev.map(b => b.id === blockId ? { ...b, html } : b));
    }
    const author = identity || { id: 'local', name: getAuthorName() || 'User', color: '#888' };
    const createdAt = Date.now();
    const ts = new Date(createdAt).toISOString();
    setComments(prev => {
      const next = new Map(prev);
      next.set(commentId, {
        id: commentId,
        blockId,
        status: "open",
        highlightText: highlightText || "",
        createdAt,
        authorId: author.id,
        authorName: author.name,
        authorColor: author.color,
        entries: [{
          id: `e-${createdAt}`,
          type: "create",
          text: "",
          // New shape fields (used by collab + future Task 7 UI):
          authorId: author.id,
          authorName: author.name,
          authorColor: author.color,
          ts: createdAt,
          // Legacy shape fields (keep until Task 7 updates CommentPopup):
          author: author.name,
          timestamp: ts,
        }],
      });
      return next;
    });
    // NOTE: we do NOT publishComment here — defer to handleCommentUpdateCreate
    // so the Y.Doc never holds a pending empty-text comment entry.
    // Open the popup immediately so user can type the comment
    setOpenCommentId(commentId);
    setTimeout(() => {
      const el = document.querySelector(`[data-comment-id="${commentId}"]`);
      if (el) setCommentRect(el.getBoundingClientRect());
    }, 50);
  }, [inRoom, identity]);

  // Update the initial "create" entry with actual comment text and author
  const handleCommentUpdateCreate = useCallback((commentId, text, author) => {
    setComments(prev => {
      const next = new Map(prev);
      const c = next.get(commentId);
      if (!c) return prev;
      const entries = [...c.entries];
      if (entries[0]?.type === "create") {
        // Update both legacy `author` field and new `authorName` field
        entries[0] = { ...entries[0], text, author, authorName: author };
      }
      next.set(commentId, { ...c, entries });
      return next;
    });
    if (inRoom && collabSessionRef.current) {
      // Publish the full comment now that we have the user's submitted text.
      // Deferred from handleCommentCreate so the Y.Doc never holds a
      // pending empty-text comment entry.
      const effectiveAuthor = identity || { id: 'local', name: author || 'User', color: '#888' };
      // commentsRef is assigned on every render (`commentsRef.current = comments`),
      // so it reflects the last *rendered* comments Map. This is safe here
      // because handleCommentCreate ran on a prior render tick (the user had
      // to type submission text between create and update-create), so the
      // freshly-created comment is already present in commentsRef.current.
      const current = commentsRef.current?.get(commentId);
      if (current) {
        try {
          collabSessionRef.current.publishComment(commentId, {
            blockId: current.blockId,
            status: current.status,
            highlightText: current.highlightText,
            createdAt: current.createdAt,
            author: effectiveAuthor,
            initialText: text,
          });
        } catch (err) {
          console.error('[collab] publishComment (update-create) failed:', err);
        }
      }
    }
  }, [inRoom, identity]);

  const handleCommentReply = useCallback((commentId, text, author) => {
    const effectiveAuthor = identity || { id: 'local', name: author || 'User', color: '#888' };
    const ts = Date.now();
    const timestamp = new Date(ts).toISOString();
    setComments(prev => {
      const next = new Map(prev);
      const c = next.get(commentId);
      if (!c) return prev;
      next.set(commentId, {
        ...c,
        entries: [...c.entries, {
          id: `e-${ts}`,
          type: "reply",
          text,
          // New shape fields:
          authorId: effectiveAuthor.id,
          authorName: effectiveAuthor.name,
          authorColor: effectiveAuthor.color,
          ts,
          // Legacy shape fields:
          author: effectiveAuthor.name,
          timestamp,
        }],
      });
      return next;
    });
    if (inRoom && collabSessionRef.current) {
      try {
        collabSessionRef.current.publishCommentReply(commentId, {
          author: effectiveAuthor,
          text,
          ts,
        });
      } catch (err) {
        console.error('[collab] publishCommentReply failed:', err);
      }
    }
  }, [inRoom, identity]);

  const handleCommentResolve = useCallback((commentId) => {
    const effectiveAuthor = identity || { id: 'local', name: getAuthorName() || 'User', color: '#888' };
    const ts = Date.now();
    const timestamp = new Date(ts).toISOString();
    setComments(prev => {
      const next = new Map(prev);
      const c = next.get(commentId);
      if (!c) return prev;
      next.set(commentId, {
        ...c,
        status: "resolved",
        entries: [...c.entries, {
          id: `e-${ts}`,
          type: "resolve",
          // New shape fields:
          authorId: effectiveAuthor.id,
          authorName: effectiveAuthor.name,
          authorColor: effectiveAuthor.color,
          ts,
          // Legacy shape fields:
          author: effectiveAuthor.name,
          timestamp,
        }],
      });
      return next;
    });
    if (inRoom && collabSessionRef.current) {
      try {
        collabSessionRef.current.publishCommentStatus(commentId, 'resolved', {
          author: effectiveAuthor,
          ts,
        });
      } catch (err) {
        console.error('[collab] publishCommentStatus failed:', err);
      }
    }
    // Update the span class in the DOM
    const el = document.querySelector(`[data-comment-id="${commentId}"]`);
    if (el) {
      el.className = "mark-comment-resolved";
      const blockEl = el.closest('[data-block-id]');
      if (blockEl) {
        const blockId = blockEl.getAttribute('data-block-id');
        setBlocks(prev => prev.map(b => b.id === blockId ? { ...b, html: blockEl.innerHTML } : b));
      }
    }
  }, [inRoom, identity]);

  const handleCommentReopen = useCallback((commentId) => {
    const effectiveAuthor = identity || { id: 'local', name: getAuthorName() || 'User', color: '#888' };
    const ts = Date.now();
    const timestamp = new Date(ts).toISOString();
    setComments(prev => {
      const next = new Map(prev);
      const c = next.get(commentId);
      if (!c) return prev;
      next.set(commentId, {
        ...c,
        status: "open",
        entries: [...c.entries, {
          id: `e-${ts}`,
          type: "reopen",
          // New shape fields:
          authorId: effectiveAuthor.id,
          authorName: effectiveAuthor.name,
          authorColor: effectiveAuthor.color,
          ts,
          // Legacy shape fields:
          author: effectiveAuthor.name,
          timestamp,
        }],
      });
      return next;
    });
    if (inRoom && collabSessionRef.current) {
      try {
        collabSessionRef.current.publishCommentStatus(commentId, 'open', {
          author: effectiveAuthor,
          ts,
        });
      } catch (err) {
        console.error('[collab] publishCommentStatus failed:', err);
      }
    }
    const el = document.querySelector(`[data-comment-id="${commentId}"]`);
    if (el) {
      el.className = "mark-comment";
      const blockEl = el.closest('[data-block-id]');
      if (blockEl) {
        const blockId = blockEl.getAttribute('data-block-id');
        setBlocks(prev => prev.map(b => b.id === blockId ? { ...b, html: blockEl.innerHTML } : b));
      }
    }
  }, [inRoom, identity]);

  const handleCommentDelete = useCallback((commentId) => {
    setComments(prev => {
      const next = new Map(prev);
      next.delete(commentId);
      return next;
    });
    if (inRoom && collabSessionRef.current) {
      try {
        collabSessionRef.current.deleteComment(commentId);
      } catch (err) {
        console.error('[collab] deleteComment failed:', err);
      }
    }
    // Remove span from DOM, keep text
    const el = document.querySelector(`[data-comment-id="${commentId}"]`);
    if (el) {
      const text = document.createTextNode(el.textContent);
      el.parentNode.replaceChild(text, el);
      const blockEl = text.parentElement?.closest('[data-block-id]');
      if (blockEl) {
        blockEl.normalize();
        const blockId = blockEl.getAttribute('data-block-id');
        setBlocks(prev => prev.map(b => b.id === blockId ? { ...b, html: blockEl.innerHTML } : b));
      }
    }
    setOpenCommentId(null);
    // `identity` is not read in this handler, but we include it in the
    // dep array for symmetry with the other comment handlers. Keeps
    // the hook identity stable across the same renders as its siblings.
  }, [inRoom, identity]);

  const handleCommentClick = useCallback((commentId, rect) => {
    setOpenCommentId(commentId);
    setCommentRect(rect);
  }, []);

  const handleBlockUpdate = useCallback((id, html) => {
    setBlocks(prev => prev.map(b => b.id === id ? { ...b, html } : b));
  }, []);

  // Update block HTML AND refresh its TC snapshot (used by FloatingToolbar inline accept/reject)
  const handleRevisionAction = useCallback((id, html) => {
    resumeHistory();
    setBlocks(prev => prev.map(b => b.id === id ? { ...b, html } : b));
    if (trackChanges) {
      tcDirtyRef.current = true;
      setTcSnapshots(prev => {
        const next = new Map(prev);
        next.set(id, getVisibleTextFromHtml(html));
        return next;
      });
    }
  }, [trackChanges]);

  // Update block HTML and sync the contentEditable DOM (used by MarkSuggestions)
  const handleBlockUpdateWithSync = useCallback((id, html) => {
    // Immediately update the DOM so contentEditable reflects the new marks
    const el = document.querySelector(`[data-block-id="${id}"]`);
    if (el) {
      el.innerHTML = html;
      // Clear init flag so setRef won't overwrite on React remount
      delete el.dataset.init;
    }
    // Then update React state to match
    setBlocks(prev => prev.map(b => b.id === id ? { ...b, html } : b));
  }, []);

  // Replace a match in a block's HTML at a given visible-text offset
  const handleSearchReplace = useCallback((blockId, offset, length, replacement) => {
    resumeHistory();
    setBlocks(prev => prev.map(b => {
      if (b.id !== blockId || !b.html) return b;
      const newHtml = replaceMatchInHtml(b.html, offset, length, replacement);
      // Sync DOM
      const el = document.querySelector(`[data-block-id="${blockId}"]`);
      if (el) el.innerHTML = newHtml;
      return { ...b, html: newHtml };
    }));
  }, []);

  // Remove an orphaned RID entry from a REF block
  const handleRemoveOrphaned = useCallback((blockId, rid) => {
    resumeHistory();
    setBlocks(prev => prev.map(b => {
      if (b.id !== blockId || b.type !== 'ref' || !b.ref?.entries) return b;
      const filtered = b.ref.entries.filter(e => (e.rid || '').trim() !== rid);
      if (filtered.length === 0) {
        // Remove the entire ref block if no entries remain
        return null;
      }
      return { ...b, ref: { ...b.ref, entries: filtered } };
    }).filter(Boolean));
  }, []);

  // Add reference from wizard — find or create the org's REF block, sorted insertion
  const handleAddReference = useCallback(({ org, rid, rtl }) => {
    resumeHistory();
    // Alphanumeric sort comparator for RIDs: letters first, then numbers
    const ridCompare = (a, b) => {
      const pa = (a.rid || '').replace(/^[A-Z/]+\s*/i, '');
      const pb = (b.rid || '').replace(/^[A-Z/]+\s*/i, '');
      // Compare the designation part (after the org prefix)
      const na = parseFloat(pa) || 0;
      const nb = parseFloat(pb) || 0;
      if (pa[0] !== pb[0]) return pa.localeCompare(pb);
      if (na !== nb) return na - nb;
      return pa.localeCompare(pb);
    };

    setBlocks(prev => {
      const refBlock = prev.find(b => b.type === 'ref' && b.ref?.org === org);
      if (refBlock) {
        // Add entry in sorted position within existing block
        return prev.map(b => {
          if (b.id !== refBlock.id) return b;
          const entries = [...b.ref.entries, { rid, rtl }].sort(ridCompare);
          return { ...b, ref: { ...b.ref, entries } };
        });
      }
      // Create new REF block — insert in alphabetical org order among existing REF blocks
      const refBlocks = prev.map((b, i) => ({ b, i })).filter(x => x.b.type === 'ref' && x.b.part === 1);
      let insertIdx;
      if (refBlocks.length === 0) {
        // No REF blocks — find the end of Part 1 section 1.1 (REFERENCES)
        insertIdx = prev.length;
      } else {
        // Find insertion point: after the last REF block whose org comes before this one alphabetically
        const afterIdx = refBlocks.reduce((acc, x) => {
          if ((x.b.ref?.org || '').localeCompare(org) < 0) return x.i;
          return acc;
        }, -1);
        insertIdx = afterIdx >= 0 ? afterIdx + 1 : refBlocks[0].i;
      }
      const newBlock = {
        id: `ref-${Date.now()}`,
        type: 'ref',
        part: 1,
        depth: 1,
        ref: { org, entries: [{ rid, rtl }] },
      };
      const next = [...prev];
      next.splice(insertIdx, 0, newBlock);
      return next;
    });
  }, []);

  const handleEnterKey = useCallback((afterId) => {
    resumeHistory();
    const newId = `new-${Date.now()}`;
    setBlocks(prev => {
      const idx = prev.findIndex(b => b.id === afterId);
      if (idx === -1) return prev;
      const current = prev[idx];

      // Enter on an empty list item exits back to paragraph
      const isEmpty = !(current.html || "").replace(/\u200B/g, "").trim();
      if (isEmpty && (current.type === "oli" || current.type === "item")) {
        const next = [...prev];
        next[idx] = { ...current, type: "txt", isNew: true, id: newId };
        return next;
      }

      // Propagate type for list-like blocks
      const propagateTypes = { oli: "oli", item: "item" };
      const newType = propagateTypes[current.type] || "txt";

      const newBlock = {
        id: newId,
        type: newType,
        part: current.part,
        depth: current.depth,
        section: current.section,
        level: current.level,
        html: "",
        isNew: true,
        // Track Changes: new blocks are marked as additions
        ...(trackChanges ? { revision: "add" } : {}),
      };
      const next = [...prev];
      next.splice(idx + 1, 0, newBlock);
      return next;
    });
    // Track Changes: add empty snapshot so all typed text is marked as additions on blur
    if (trackChanges) {
      tcDirtyRef.current = true;
      setTcSnapshots(prev => {
        const next = new Map(prev);
        next.set(newId, "");
        return next;
      });
    }
    setFocusedBlockId(newId);
  }, [trackChanges]);

  // Tab/Shift+Tab on an OLI item: demote/promote list level (1..4, UFS Figure A-1).
  const handleChangeOliLevel = useCallback((blockId, delta) => {
    resumeHistory();
    setBlocks(prev => {
      const idx = prev.findIndex(b => b.id === blockId);
      if (idx < 0) return prev;
      const current = prev[idx];
      if (current.type !== "oli") return prev;
      const currentLevel = current.level || 1;
      const nextLevel = Math.max(1, Math.min(currentLevel + delta, 4));
      if (nextLevel === currentLevel) return prev;
      const next = [...prev];
      next[idx] = { ...current, level: nextLevel };
      return next;
    });
  }, []);

  // Delete a block and focus the previous one
  const handleDelete = useCallback((blockId) => {
    resumeHistory();
    setBlocks(prev => {
      const idx = prev.findIndex(b => b.id === blockId);
      if (idx <= 0) return prev; // don't delete first block
      const block = prev[idx];

      // Track Changes: mark as deleted instead of removing
      if (trackChanges && block.revision !== "add") {
        const next = [...prev];
        next[idx] = { ...block, revision: "del" };
        const prevBlock = prev[idx - 1];
        setTimeout(() => focusBlock(prevBlock.id, true), 0);
        return next;
      }

      const prevBlock = prev[idx - 1];
      const next = prev.filter(b => b.id !== blockId);
      // Focus previous block
      setTimeout(() => focusBlock(prevBlock.id, true), 0);
      return next;
    });
  }, [focusBlock, trackChanges]);

  // A block is focusable if it's a title or an editable text block
  const isFocusable = useCallback((block) => {
    if (block.type === "title") return true;
    if (block.type === "table") return false;
    if (block.type === "ref") return true;
    // All text-bearing block types are focusable/editable
    return true;
  }, []);

  // Navigate to previous editable block (reads blocksRef, no state update)
  const handleFocusPrev = useCallback((blockId) => {
    const cur = blocksRef.current;
    const idx = cur.findIndex(b => b.id === blockId);
    if (idx <= 0) return;
    for (let i = idx - 1; i >= 0; i--) {
      if (isFocusable(cur[i])) {
        focusBlock(cur[i].id, true);
        break;
      }
    }
  }, [focusBlock, isFocusable]);

  // Navigate to next editable block (reads blocksRef, no state update)
  const handleFocusNext = useCallback((blockId) => {
    const cur = blocksRef.current;
    const idx = cur.findIndex(b => b.id === blockId);
    if (idx < 0 || idx >= cur.length - 1) return;
    for (let i = idx + 1; i < cur.length; i++) {
      if (isFocusable(cur[i])) {
        focusBlock(cur[i].id, false);
        break;
      }
    }
  }, [focusBlock, isFocusable]);

  // Convert a text block to a title
  const handleConvertToTitle = useCallback((blockId) => {
    resumeHistory();
    setBlocks(prev => {
      const idx = prev.findIndex(b => b.id === blockId);
      if (idx < 0) return prev;
      const block = prev[idx];
      // Determine appropriate depth - look at surrounding titles
      let depth = 1;
      for (let i = idx - 1; i >= 0; i--) {
        if (prev[i].type === "title") {
          depth = prev[i].depth;
          break;
        }
      }
      const next = [...prev];
      next[idx] = { ...block, type: "title", depth, isNew: false };
      return next;
    });
    setTimeout(() => focusBlock(blockId, true), 0);
  }, [focusBlock]);

  // General block type conversion (from slash menu)
  const handleConvertBlock = useCallback((blockId, newType) => {
    resumeHistory();
    if (newType === "title") {
      handleConvertToTitle(blockId);
      return;
    }
    // Replace with a brand new block (new ID) so it goes through the exact same
    // mount path as Enter-created blocks, which we know works for focus
    const newId = `new-${Date.now()}`;
    setBlocks(prev => {
      const idx = prev.findIndex(b => b.id === blockId);
      if (idx < 0) return prev;
      const block = prev[idx];
      const next = [...prev];
      const newBlock = {
        id: newId,
        type: newType,
        part: block.part,
        depth: block.depth,
        section: block.section,
        html: "",
        isNew: true,
      };
      // REF blocks need structured data, not html
      if (newType === 'ref') {
        newBlock.ref = { org: '', entries: [{ rid: '', rtl: '' }] };
        delete newBlock.html;
      }
      // Page break blocks have no content
      if (newType === 'pagebreak') {
        delete newBlock.html;
        delete newBlock.isNew;
      }
      // Table blocks need table data, not html
      if (newType === 'table') {
        newBlock.table = {
          columns: 2,
          rows: [
            [{ text: '', colspan: 1 }, { text: '', colspan: 1 }],
            [{ text: '', colspan: 1 }, { text: '', colspan: 1 }],
          ],
        };
        delete newBlock.html;
        delete newBlock.isNew;
      }
      next[idx] = newBlock;
      return next;
    });
    // Track Changes: add empty snapshot so all typed text is marked as additions on blur
    if (trackChanges) {
      tcDirtyRef.current = true;
      setTcSnapshots(prev => {
        const next = new Map(prev);
        next.set(newId, "");
        return next;
      });
    }
    setFocusedBlockId(newId);
  }, [handleConvertToTitle, trackChanges]);

  // Promote a title (decrease depth)
  const handlePromote = useCallback((blockId) => {
    resumeHistory();
    setBlocks(prev => prev.map(b => {
      if (b.id === blockId && b.type === "title" && b.depth > 1) {
        return { ...b, depth: b.depth - 1 };
      }
      return b;
    }));
  }, []);

  // Demote a title (increase depth)
  const handleDemote = useCallback((blockId) => {
    resumeHistory();
    setBlocks(prev => prev.map(b => {
      if (b.id === blockId && b.type === "title" && b.depth < 6) {
        return { ...b, depth: b.depth + 1 };
      }
      return b;
    }));
  }, []);

  const handleAcceptAll = useCallback(() => {
    resumeHistory();
    setBlocks(prev => {
      const next = acceptAllRevisions(prev);
      // Refresh snapshots from the post-resolution state so subsequent edits
      // diff against the correct baseline (not stale pre-accept text)
      if (trackChanges) {
        const snap = new Map();
        for (const b of next) {
          if (b.html) snap.set(b.id, getVisibleTextFromHtml(b.html));
        }
        tcDirtyRef.current = true;
        setTcSnapshots(snap);
      }
      return next;
    });
  }, [trackChanges]);

  const handleRejectAll = useCallback(() => {
    resumeHistory();
    setBlocks(prev => {
      const next = rejectAllRevisions(prev);
      if (trackChanges) {
        const snap = new Map();
        for (const b of next) {
          if (b.html) snap.set(b.id, getVisibleTextFromHtml(b.html));
        }
        tcDirtyRef.current = true;
        setTcSnapshots(snap);
      }
      return next;
    });
  }, [trackChanges]);

  // Persist dark mode
  useEffect(() => {
    try { localStorage.setItem('sim-dark-mode', String(darkMode)); } catch {}
    document.documentElement.classList.toggle('dark-mode', darkMode);
  }, [darkMode]);

  // Persist zoom level
  useEffect(() => {
    try { localStorage.setItem('sim-editor-zoom', String(editorZoom)); } catch {}
  }, [editorZoom]);

  // Persist inline linting preference
  useEffect(() => {
    try { localStorage.setItem('sim-inline-linting', String(inlineLintingEnabled)); } catch {}
  }, [inlineLintingEnabled]);

  // Collab server reachability detection — ping GET /rooms on mount and tab focus (30s cooldown)
  useEffect(() => {
    let cancelled = false;
    const checkCollab = async () => {
      try {
        const res = await fetch(`${COLLAB_HTTP_URL}/rooms`, { signal: AbortSignal.timeout(3000), headers: authHeadersRef.current });
        if (!cancelled && res.ok) {
          setCollabReachable(true);
          const data = await res.json();
          setRoomList(data.rooms || []);
        }
      } catch {
        if (!cancelled) setCollabReachable(false);
      }
    };
    checkCollab();
    let lastCheck = Date.now();
    const handleFocus = () => {
      if (Date.now() - lastCheck > 30000) {
        lastCheck = Date.now();
        checkCollab();
      }
    };
    window.addEventListener('focus', handleFocus);
    return () => { cancelled = true; window.removeEventListener('focus', handleFocus); };
  }, []);

  const zoomIn = useCallback(() => setEditorZoom(z => Math.min(2, Math.round((z + 0.1) * 10) / 10)), []);
  const zoomOut = useCallback(() => setEditorZoom(z => Math.max(0.5, Math.round((z - 0.1) * 10) / 10)), []);
  const zoomReset = useCallback(() => setEditorZoom(1), []);

  // ── Compliance Checker Handlers ──

  const handleComplianceAcceptFix = useCallback((blockId, fixedText) => {
    resumeHistory();
    setBlocks(prev => prev.map(b => b.id === blockId ? { ...b, html: fixedText } : b));
  }, []);

  const handleComplianceAcceptGroup = useCallback((fixesByBlock, label) => {
    resumeHistory();
    setBlocks(prev => prev.map(b => {
      const fix = fixesByBlock.get(b.id);
      return fix ? { ...b, html: fix } : b;
    }));
  }, []);

  const handleComplianceScrollTo = useCallback((blockId) => {
    const el = document.querySelector(`[data-block-id="${blockId}"]`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setFocusedBlockId(blockId);
    }
  }, []);

  // Auto-save to localStorage every 3 seconds (silent, no UI).
  // Suppressed in a collab room — the server-persisted Yjs doc is the source of truth.
  useEffect(() => {
    if (inRoom) return;
    const timer = setTimeout(() => {
      autoSave(blocks, sectionMeta, comments, fileName);
    }, 3000);
    return () => clearTimeout(timer);
  }, [blocks, sectionMeta, comments, fileName, inRoom]);

  // Track dirty state — any block/comment change marks dirty
  useEffect(() => {
    setIsDirty(true);
  }, [blocks, comments]);

  // On mount: offer to restore auto-saved state if available. Previously
  // this was silent, which let a stale auto-save from a different file
  // quietly overwrite the initial document (and then, combined with a
  // leftover file handle, get written back to disk on the next Ctrl+S).
  // Suppressed in a collab room — the server Yjs doc wins.
  useEffect(() => {
    if (inRoom) return;
    const saved = loadAutoSave();
    if (!saved || !saved.blocks || saved.blocks.length === 0 || !saved.fileName) return;
    setBlocks(saved.blocks);
    if (saved.sectionMeta) setSectionMeta(saved.sectionMeta);
    setFileName(saved.fileName);
    if (saved.comments && Array.isArray(saved.comments)) {
      const m = new Map();
      for (const c of saved.comments) m.set(c.id, c);
      setComments(m);
    }
    setIsDirty(false);
    // Restored state has no attached file handle — force a prompt on
    // the next Ctrl+S so it cannot land on an unrelated file.
    fileHandleRef.current = null;
    commentsHandleRef.current = null;
  }, [inRoom]);

  // ── Collab session lifecycle ──
  // Creates the Yjs session once we have both a room ID and an identity.
  // Remote updates are pushed into React state via setBlocks; local edits
  // are published by the next effect.
  useEffect(() => {
    if (!inRoom || !identity) return;

    const session = createCollabSession({
      room: roomId,
      token: authToken,
      getTokenFn: getToken,
      identity,
      initialBlocks: blocksRef.current,
      onRemoteBlocks: (nextBlocks, meta) => {
        // Stash the remote snapshot so the publish effect can detect this
        // update was not a local edit and skip publishing it back.
        lastRemoteBlocksRef.current = nextBlocks;

        // The first call (initial sync from the server) is what unblocks
        // local publishing. Before this fires we must NOT push blocks to
        // Y.Doc — doing so would race the server's persisted state and
        // duplicate the document on reload.
        if (meta?.initial) {
          sessionReadyRef.current = true;
          // Stash for the ghost-span cleanup pass that runs in the
          // subsequent initial onRemoteComments call.
          initialBlocksForCleanupRef.current = nextBlocks;
        }

        // Preserve caret — and any non-collapsed selection — across a
        // remote-triggered DOM rewrite. Capturing both endpoints lets a
        // user who was mid-replacement (e.g., highlighted a phrase and
        // was about to retype it) keep their selection when a remote
        // peer's edit lands in the middle of their action. If the
        // selection spans into a different block we fall back to a
        // collapsed caret at the start — cross-block selection restore
        // would require resolving two block IDs and is out of scope for
        // the prototype.
        const activeEl = document.activeElement;
        let caret = null;
        if (activeEl?.dataset?.blockId && activeEl.contentEditable === 'true') {
          const sel = window.getSelection();
          if (sel && sel.rangeCount > 0) {
            const range = sel.getRangeAt(0);
            if (activeEl.contains(range.startContainer)) {
              const startOffset = getPlainTextOffset(activeEl, range.startContainer, range.startOffset);
              if (startOffset >= 0) {
                let endOffset;
                if (!range.collapsed && activeEl.contains(range.endContainer)) {
                  endOffset = getPlainTextOffset(activeEl, range.endContainer, range.endOffset);
                  if (endOffset < 0) endOffset = undefined;
                }
                caret = { blockId: activeEl.dataset.blockId, startOffset, endOffset };
              }
            }
          }
        }
        setBlocks(nextBlocks);
        if (caret) {
          requestAnimationFrame(() => {
            const el = document.querySelector(`[data-block-id="${caret.blockId}"]`);
            if (el) restorePlainTextOffset(el, caret.startOffset, caret.endOffset);
          });
        }
      },
      initialMeta: { ...sectionMetaRef.current, fileName },
      onRemoteMeta: (remote) => {
        // I-3: flip ready flag on first remote meta observation so the
        // publishMeta effect doesn't clobber server-side state with stale
        // local values on first join.
        metaReadyRef.current = true;
        // M3 — apply remote section metadata updates. No local echo
        // guard needed; publishMeta's per-key diff + 'local-meta'
        // origin filter already prevent round-trip.
        if (!remote || typeof remote !== 'object') return;
        setSectionMeta((prev) => ({ ...prev, ...remote }));
        if (remote.fileName) setFileName(remote.fileName);
      },
      onRemoteTc: (tc) => {
        // M-shared-tc — apply remote Track Changes state. Round-tripping
        // is prevented by the publish effect's tcDirtyRef gate — only
        // user actions flip that bit, so these remote setters don't echo.
        setTrackChanges(!!tc.enabled);
        setTcSnapshots(new Map(Object.entries(tc.snapshots || {})));
      },
      onRemoteComments: (commentsObj, commentsMeta) => {
        // M-shared-comments — apply remote comment state. The
        // mark-comment DOM spans are synced via the existing
        // blocks → yStore pathway, so we only update the metadata Map
        // here. Publishes are imperative (no effect watching `comments`),
        // so there is no echo to guard against.
        setComments(new Map(Object.entries(commentsObj || {})));
        // Ghost-span cleanup: on initial sync, strip mark-comment
        // highlight spans whose data-comment-id has no matching entry
        // in yComments. This recovers from the tab-close abandon case
        // where the eager span injection got published but the
        // deferred metadata publish never fired. Runs once per join.
        if (commentsMeta?.initial && initialBlocksForCleanupRef.current) {
          const initialBlocks = initialBlocksForCleanupRef.current;
          initialBlocksForCleanupRef.current = null;
          const validIds = new Set(Object.keys(commentsObj || {}));
          const cleaned = stripOrphanCommentSpans(initialBlocks, validIds);
          if (cleaned !== initialBlocks) {
            // setBlocks with a new reference — this is NOT equal to
            // lastRemoteBlocksRef.current, so the publish effect will
            // fire and push the cleaned version back to the Y.Doc for
            // all peers. That's intentional: the ghosts should be
            // removed globally, not just locally.
            setBlocks(cleaned);
          }
        }
      },
      onPresenceChange: (states) => setPeers(states),
      onStatusChange: (status, meta) => {
        setCollabStatus(status);
        setReconnectIn(meta?.reconnectIn ?? 0);
      },
    });
    collabSessionRef.current = session;
    // Debug hook: expose for devtools inspection during prototype QA.
    // Gated on DEV so a production build does not ship a global that exposes
    // ydoc + awareness state to any page script that gets past the CSP.
    const EXPOSE_DEBUG = typeof import.meta !== 'undefined' && import.meta.env?.DEV;
    if (EXPOSE_DEBUG && typeof window !== 'undefined') window.__collab = session;

    return () => {
      session.destroy();
      collabSessionRef.current = null;
      sessionReadyRef.current = false;
      metaReadyRef.current = false;
      lastRemoteBlocksRef.current = null;
      if (EXPOSE_DEBUG && typeof window !== 'undefined') delete window.__collab;
    };
    // Intentionally depend only on roomId + identity so the session is stable
    // across blocks updates. initialBlocks is read via blocksRef.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inRoom, roomId, identity]);

  // Publish local `blocks` updates to the collab session.
  //
  // Two guards:
  //   1. sessionReadyRef — suppress publishing until the initial server sync
  //      is complete. Otherwise the first render would push INITIAL_BLOCKS
  //      into Y.Doc before the server's persisted state arrives, duplicating
  //      the document on rejoin.
  //   2. lastRemoteBlocksRef identity check — if the new `blocks` reference
  //      is literally the same array we just received from a remote update,
  //      skip the publish effect as a fast path.
  //
  // I-2 backstop: ref-equality is the fast path; if an upstream layer
  // ever clones `blocks` into a new-reference-but-content-equal array,
  // applyBlocksToYDoc produces a zero-change transaction (pinned by the
  // `zero-change publish after a remote-applied clone does not grow
  // undo stack (I-2)` regression test in collab.test.js). Both layers
  // must hold — a worst-case echo is harmless because zero-change
  // transactions do not create Y.UndoManager stack items.
  // A4 — publishDisabled latch: once the document exceeds MAX_PUBLISH_BYTES
  // we stop calling publishBlocks on every keystroke (which would re-walk
  // every block through estimatePublishBytes and re-push a toast) until
  // the user shrinks the document back under the cap. The latch clears
  // automatically on the next render where the estimate is safe again.
  const publishDisabledRef = useRef(false);
  useEffect(() => {
    if (!inRoom) return;
    const session = collabSessionRef.current;
    if (!session) return;
    if (!sessionReadyRef.current) return;
    if (blocks === lastRemoteBlocksRef.current) return;
    try {
      session.publishBlocks(blocks);
      // Success — clear any previous over-cap latch.
      if (publishDisabledRef.current) {
        publishDisabledRef.current = false;
        toastPushRef.current?.({
          kind: 'success',
          title: 'Sync resumed',
          body: 'Document is back under the collab size limit.',
          ttl: 5000,
        });
      }
    } catch (err) {
      if (err instanceof DocSizeLimitError) {
        // M7 — client-side doc size guard. Only push the error toast
        // the first time we hit the limit to avoid spamming the user
        // on every keystroke while the document is oversized.
        if (!publishDisabledRef.current) {
          publishDisabledRef.current = true;
          toastPushRef.current?.({
            kind: 'error',
            title: 'Document too large to sync',
            body: `This document is ${(err.actualBytes / (1024 * 1024)).toFixed(1)} MB, ` +
                  `over the ${(err.maxBytes / (1024 * 1024)).toFixed(0)} MB collab limit. ` +
                  `Your edits are not being shared with other users. ` +
                  `Remove some content and try again.`,
            ttl: 0, // sticky — the user has to dismiss it manually
          });
        }
      } else {
        console.error('[collab] publishBlocks failed:', err);
      }
    }
    // Intentionally NOT depending on `toasts` — A2. Toast dispatch goes
    // through toastPushRef which is refreshed every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blocks, inRoom]);

  // M3 — publish local section metadata updates.
  //
  // No explicit echo guard here: publishMeta's per-key diff (compare
  // `cur !== v` before writing) produces a zero-change transaction when
  // the local state already matches the remote, and the `'local-meta'`
  // origin is filtered inside handleAfterTx so even a fired transaction
  // wouldn't round-trip through onRemoteMeta. An earlier version added
  // an Object.keys().every() guard here but it was both unnecessary and
  // subtly broken (asymmetric key sets could drop legitimate edits).
  useEffect(() => {
    if (!inRoom) return;
    const session = collabSessionRef.current;
    if (!session) return;
    if (!sessionReadyRef.current) return;
    if (!metaReadyRef.current) return; // I-3: wait for first onRemoteMeta
    session.publishMeta({ ...sectionMeta, fileName });
  }, [sectionMeta, fileName, inRoom]);

  // M-shared-tc — publish local TC state changes to the Y.Doc.
  //
  // Gating: only publish when `tcDirtyRef` is set (meaning the change
  // came from a user action). Remote updates land via onRemoteTc WITHOUT
  // setting tcDirtyRef, so round-tripping is suppressed.
  //
  // When disabled, we publish an empty snapshots object so the baseline
  // is cleared in the same Y.Doc transaction as the flag flip — otherwise
  // remote clients would re-diff against a stale baseline and flag
  // phantom changes.
  useEffect(() => {
    if (!inRoom) return;
    const session = collabSessionRef.current;
    if (!session) return;
    if (!sessionReadyRef.current) return;
    if (!tcDirtyRef.current) return;
    tcDirtyRef.current = false;
    const snapshots = {};
    if (trackChanges) {
      for (const [id, txt] of tcSnapshots.entries()) snapshots[id] = txt;
    }
    try {
      session.publishTc({ enabled: trackChanges, snapshots });
    } catch (err) {
      console.error('[collab] publishTc failed:', err);
    }
  }, [trackChanges, tcSnapshots, inRoom]);

  // Broadcast our caret position so other users see a live cursor.
  useEffect(() => {
    if (!inRoom) return;
    const handler = () => {
      const session = collabSessionRef.current;
      if (!session) return;
      const active = document.activeElement;
      if (!active?.dataset?.blockId || active.contentEditable !== 'true') {
        session.setCursor(null);
        return;
      }
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) {
        session.setCursor(null);
        return;
      }
      const range = sel.getRangeAt(0);
      if (!active.contains(range.startContainer)) {
        session.setCursor(null);
        return;
      }
      const idx = getPlainTextOffset(active, range.startContainer, range.startOffset);
      if (idx < 0) { session.setCursor(null); return; }
      session.setCursor({
        blockId: active.dataset.blockId,
        index: idx,
      });
    };
    document.addEventListener('selectionchange', handler);
    return () => document.removeEventListener('selectionchange', handler);
  }, [inRoom]);

  // Keyboard listener for undo/redo and search
  useEffect(() => {
    const handler = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
        e.preventDefault();
        if (inRoom && collabSessionRef.current) collabSessionRef.current.undo();
        else undo();
      } else if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) {
        e.preventDefault();
        if (inRoom && collabSessionRef.current) collabSessionRef.current.redo();
        else redo();
      } else if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        e.preventDefault();
        setSearchOpen(true);
      } else if ((e.ctrlKey || e.metaKey) && e.key === 'h') {
        e.preventDefault();
        setSearchOpen('replace');
      } else if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        handleSave();
      } else if ((e.ctrlKey || e.metaKey) && (e.key === '=' || e.key === '+')) {
        e.preventDefault();
        zoomIn();
      } else if ((e.ctrlKey || e.metaKey) && e.key === '-') {
        e.preventDefault();
        zoomOut();
      } else if ((e.ctrlKey || e.metaKey) && e.key === '0') {
        e.preventDefault();
        zoomReset();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [undo, redo, handleSave, zoomIn, zoomOut, zoomReset, inRoom]);

  // Share button handler: generate a room and reload into it, or copy the current room URL.
  const handleShare = useCallback(() => {
    if (inRoom) {
      // M6 — toast instead of alert(). alert() blocks the event loop and
      // steals focus from the editor, which is a regression from the
      // otherwise keyboard-driven UX. The toast includes a Copy action
      // so the user can manually retry if the implicit clipboard write
      // was blocked by the browser.
      const url = window.location.href;
      navigator.clipboard?.writeText(url).catch(() => {});
      toastPushRef.current?.({
        kind: 'success',
        title: 'Room link copied',
        body: url,
        actions: [
          { label: 'Copy again', onClick: () => navigator.clipboard?.writeText(url).catch(() => {}) },
        ],
        ttl: 8000,
      });
      return;
    }
    const newRoom = generateRoomId();
    const url = buildRoomUrl(newRoom);
    // Starting a room clears our localStorage auto-save so the server-persisted
    // doc becomes the source of truth cleanly.
    try { clearAutoSave(); } catch { /* ignore */ }
    window.location.href = url;
    // toasts accessed via toastPushRef; intentionally omitted from deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inRoom]);

  const sectionNumber = sectionMeta.sectionNumber;
  const sectionTitle = sectionMeta.sectionTitle;
  const ufgsDate = sectionMeta.date;

  return (
    <div className={darkMode ? 'dark-mode' : ''} style={{
      display: "flex",
      height: "100vh",
      fontFamily: "'Inter', 'Segoe UI', 'Helvetica Neue', -apple-system, sans-serif",
      backgroundColor: "var(--sim-bg, #fafaf7)",
      color: "var(--sim-text, #1e293b)",
      overflow: "hidden",
    }}>
      <ToastStack toasts={toasts.items} onDismiss={toasts.dismiss} />

      {/* LEFT SIDEBAR - Navigation Tree */}
      <div style={{
        width: 280,
        minWidth: 280,
        backgroundColor: "var(--sim-sidebar-bg, #1e293b)",
        display: "flex",
        flexDirection: "column",
        borderRight: "1px solid var(--sim-border, #334155)",
        overflow: "hidden",
      }}>
        {/* Sidebar Header */}
        <div style={{
          padding: "16px 14px 12px",
          borderBottom: "1px solid #334155",
        }}>
          <div style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            marginBottom: 4,
          }}>
            <FileText size={16} color="#6384a8" />
            <span style={{ color: "#e2e8f0", fontSize: 11, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase" }}>
              UFGS {sectionNumber}
            </span>
          </div>
          <div style={{ color: "#94a3b8", fontSize: 12, marginLeft: 24 }}>
            {sectionTitle} ({ufgsDate})
          </div>
        </div>

        {/* Search */}
        <div style={{ padding: "8px 10px", borderBottom: "1px solid #334155" }}>
          <div style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: "6px 8px",
            backgroundColor: "#0f172a",
            borderRadius: 4,
            border: "1px solid #334155",
          }}>
            <Search size={14} color="#94a3b8" />
            <input
              placeholder="Search sections..."
              value={sidebarSearch}
              onChange={(e) => setSidebarSearch(e.target.value)}
              {...NO_EXFIL_PROPS}
              style={{
                background: "none",
                border: "none",
                outline: "none",
                color: "#cbd5e1",
                fontSize: 13,
                padding: "4px 0",
                width: "100%",
              }}
            />
          </div>
        </div>

        {/* Tree */}
        <div style={{
          flex: 1,
          overflowY: "auto",
          padding: "6px 4px",
        }}>
          {filteredTree.map(node => (
            <TreeNode
              key={node.id}
              node={node}
              selectedId={selectedTreeId}
              onSelect={handleTreeSelect}
              depth={0}
              numberMap={numberMap}
              forceExpand={!!sidebarSearch.trim()}
              onReorder={handleReorderSection}
            />
          ))}
        </div>

        {/* Sidebar Footer */}
        <div style={{
          padding: "10px 14px",
          borderTop: "1px solid #334155",
          fontSize: 11,
          color: "#64748b",
          letterSpacing: "0.04em",
        }}>
          UFGS SPEC EDITOR PROTOTYPE v0.1
        </div>
      </div>

      {/* RIGHT PANEL - Editor */}
      <div
        style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", position: "relative", backgroundColor: "var(--sim-toolbar-bg, #ffffff)" }}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {/* Drag overlay */}
        {isDragOver && (
          <div style={{
            position: "absolute",
            inset: 0,
            backgroundColor: "rgba(59, 130, 246, 0.08)",
            border: "3px dashed #3b82f6",
            borderRadius: 8,
            zIndex: 50,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            pointerEvents: "none",
          }}>
            <div style={{
              padding: "24px 48px",
              backgroundColor: "#ffffff",
              borderRadius: 12,
              boxShadow: "0 4px 24px rgba(0,0,0,0.12)",
              textAlign: "center",
            }}>
              <Upload size={32} color="#3b82f6" />
              <div style={{ fontSize: 16, fontWeight: 600, color: "#1e293b", marginTop: 8 }}>
                Drop .SEC file to import
              </div>
            </div>
          </div>
        )}

        {/* Hidden file input */}
        <input
          ref={fileInputRef}
          type="file"
          accept=".sec,.xml"
          style={{ display: "none" }}
          onChange={handleFileInputChange}
        />

        {/* Toolbar */}
        <div style={{
          display: "flex",
          alignItems: "center",
          flexWrap: "wrap",
          gap: 8,
          padding: "8px 16px",
          borderBottom: "1px solid #e2e8f0",
          backgroundColor: "#ffffff",
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginRight: "auto" }}>
            <span style={{ fontSize: 14, fontWeight: 700, color: "#0f172a", fontFamily: "Georgia, serif" }}>
              SECTION {sectionNumber}
            </span>
            <span style={{ fontSize: 14, color: "#64748b" }}> - </span>
            <span style={{ fontSize: 14, fontWeight: 600, color: "#334155", fontFamily: "Georgia, serif" }}>
              {sectionTitle}
            </span>
          </div>
          <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 8, fontSize: 12, color: "#64748b" }}>
            <button
              onClick={() => fileInputRef.current?.click()}
              title="Import .SEC file"
              style={{
                display: "flex",
                alignItems: "center",
                gap: 4,
                padding: "4px 10px",
                backgroundColor: "#f1f5f9",
                border: "1px solid #e2e8f0",
                borderRadius: 6,
                cursor: "pointer",
                fontSize: 13,
                fontWeight: 600,
                color: "#475569",
                minHeight: 32,
              }}
            >
              <Upload size={14} /> Import
            </button>
            <button
              onClick={handleSave}
              title="Save (Ctrl+S)"
              style={{
                display: "flex",
                alignItems: "center",
                gap: 4,
                padding: "4px 10px",
                backgroundColor: saveStatus === 'saved' ? "#d1fae5" : saveStatus === 'saving' ? "#e0f2fe" : "#f1f5f9",
                border: `1px solid ${saveStatus === 'saved' ? "#10b981" : saveStatus === 'saving' ? "#38bdf8" : "#e2e8f0"}`,
                borderRadius: 6,
                cursor: "pointer",
                fontSize: 13,
                fontWeight: 600,
                color: saveStatus === 'saved' ? "#047857" : saveStatus === 'saving' ? "#0369a1" : "#475569",
                minHeight: 32,
                transition: "background-color 150ms, border-color 150ms, color 150ms",
              }}
            >
              {saveStatus === 'saved' ? <Check size={14} /> : saveStatus === 'saving' ? <Loader size={14} className="spin" /> : <Download size={14} />}
              {saveStatus === 'saved' ? 'Saved' : saveStatus === 'saving' ? 'Saving...' : 'Save'}
            </button>
            <button
              onClick={handleShare}
              title={inRoom ? "Copy room link to clipboard" : "Start a collaborative room"}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 4,
                padding: "4px 10px",
                backgroundColor: inRoom ? "#dbeafe" : "#f1f5f9",
                border: inRoom ? "1px solid #2563eb" : "1px solid #e2e8f0",
                borderRadius: 6,
                cursor: "pointer",
                fontSize: 13,
                fontWeight: 600,
                color: inRoom ? "#1d4ed8" : "#475569",
                minHeight: 32,
              }}
            >
              {inRoom ? `Room ${roomId}` : "Share"}
            </button>
            {collabReachable && (
              <button
                onClick={() => {
                  setShowRoomPanel(!showRoomPanel);
                  if (!showRoomPanel) {
                    fetch(`${COLLAB_HTTP_URL}/rooms`, { headers: authHeaders })
                      .then(r => r.json())
                      .then(d => setRoomList(d.rooms || []))
                      .catch(() => {});
                  }
                }}
                title="Manage rooms"
                style={{
                  display: "flex", alignItems: "center", gap: 4, padding: "4px 10px",
                  backgroundColor: showRoomPanel ? "#dbeafe" : "#f1f5f9",
                  border: showRoomPanel ? "1px solid #2563eb" : "1px solid #e2e8f0",
                  borderRadius: 6, cursor: "pointer", fontSize: 13, fontWeight: 600,
                  color: showRoomPanel ? "#1d4ed8" : "#475569", minHeight: 32,
                }}
              >
                <Users size={14} /> Rooms
              </button>
            )}
            {inRoom && (
              <PresenceBar peers={peers} self={identity} />
            )}
            {getAuthMode() !== 'stub' && identity && (
              <span style={{ fontSize: 12, color: '#6b7280', display: 'flex', alignItems: 'center', gap: 4 }}>
                {identity.name}
                <span style={{ color: '#d1d5db' }}>·</span>
                <button
                  onClick={() => authSignOut().then(() => window.location.reload())}
                  style={{
                    background: 'none', border: 'none', color: '#6b7280',
                    cursor: 'pointer', fontSize: 12, textDecoration: 'underline',
                    padding: 0,
                  }}
                >Sign out</button>
              </span>
            )}
            {inRoom && collabStatus && collabStatus !== 'connected' && (
              <ConnectionBanner state={collabStatus} reconnectIn={reconnectIn} />
            )}
            {inRoom && (
              <>
                <button
                  onClick={handleDownloadSec}
                  title="Download .SEC file from server"
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 4,
                    padding: "4px 10px",
                    backgroundColor: "#f1f5f9",
                    border: "1px solid #e2e8f0",
                    borderRadius: 6,
                    cursor: "pointer",
                    fontSize: 13,
                    fontWeight: 600,
                    color: "#475569",
                    minHeight: 32,
                  }}
                >
                  <Download size={14} /> .SEC
                </button>
                <button
                  onClick={handleDownloadComments}
                  title="Download comments JSON from server"
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 4,
                    padding: "4px 10px",
                    backgroundColor: "#f1f5f9",
                    border: "1px solid #e2e8f0",
                    borderRadius: 6,
                    cursor: "pointer",
                    fontSize: 13,
                    fontWeight: 600,
                    color: "#475569",
                    minHeight: 32,
                  }}
                >
                  <Download size={14} /> Comments
                </button>
              </>
            )}
            <button
              onClick={handleSaveAs}
              title="Save As... (choose new location)"
              style={{
                display: "flex",
                alignItems: "center",
                gap: 4,
                padding: "4px 10px",
                backgroundColor: "#f1f5f9",
                border: "1px solid #e2e8f0",
                borderRadius: 6,
                cursor: "pointer",
                fontSize: 13,
                fontWeight: 600,
                color: "#475569",
                minHeight: 32,
              }}
            >
              Save As
            </button>
            <button
              onClick={() => {
                const html = generateExportHtml(blocks, sectionMeta, { showNotes, unitDisplay });
                const blob = new Blob([html], { type: 'application/msword' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = (fileName || 'output.SEC').replace(/\.sec$/i, '.doc');
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                URL.revokeObjectURL(url);
              }}
              title="Export as Word document (.doc)"
              style={{
                display: "flex", alignItems: "center", gap: 4,
                padding: "4px 10px", backgroundColor: "#f1f5f9",
                border: "1px solid #e2e8f0", borderRadius: 6,
                cursor: "pointer", fontSize: 13, fontWeight: 600,
                color: "#475569", minHeight: 32,
              }}
            >Word</button>
            <button
              onClick={() => {
                const html = generateExportHtml(blocks, sectionMeta, { showNotes, unitDisplay });
                const w = window.open('', '_blank');
                w.document.write(html);
                w.document.close();
                setTimeout(() => w.print(), 500);
              }}
              title="Print / Save as PDF (Ctrl+P in print dialog)"
              style={{
                display: "flex", alignItems: "center", gap: 4,
                padding: "4px 10px", backgroundColor: "#f1f5f9",
                border: "1px solid #e2e8f0", borderRadius: 6,
                cursor: "pointer", fontSize: 13, fontWeight: 600,
                color: "#475569", minHeight: 32,
              }}
            >Print</button>
            {comments.size > 0 && (
              <>
                <button
                  onClick={() => { setShowComments(prev => !prev); if (!showComments) setComplianceOpen(false); }}
                  title={showComments ? "Hide comments panel" : "Show comments panel"}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 4,
                    padding: "4px 10px",
                    backgroundColor: showComments ? "#fce895" : "#f1f5f9",
                    border: showComments ? "1px solid #f6c744" : "1px solid #e2e8f0",
                    borderRadius: 6,
                    cursor: "pointer",
                    fontSize: 13,
                    fontWeight: 600,
                    color: showComments ? "#854d0e" : "#475569",
                    minHeight: 32,
                  }}
                >
                  &#x1F4AC; Comments
                </button>
                <button
                  onClick={() => {
                    const html = generateCommentReport(comments, blocks, sectionMeta);
                    const w = window.open('', '_blank');
                    w.document.write(html);
                    w.document.close();
                  }}
                  title="Generate comment resolution report"
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 4,
                    padding: "4px 10px",
                    backgroundColor: "#f1f5f9",
                    border: "1px solid #e2e8f0",
                    borderRadius: 6,
                    cursor: "pointer",
                    fontSize: 13,
                    fontWeight: 600,
                    color: "#475569",
                    minHeight: 32,
                  }}
                >
                  Comment Report
                </button>
              </>
            )}
            <button
              onClick={() => {
                const register = compileRegister(blocks);
                if (register.totalItems === 0) {
                  alert('No submittal items (SUB marks) found in the document.');
                  return;
                }
                const html = generateRegisterReport(register, sectionMeta);
                const w = window.open('', '_blank');
                w.document.write(html);
                w.document.close();
              }}
              title="Generate submittal register from SUB marks"
              style={{
                display: "flex",
                alignItems: "center",
                gap: 4,
                padding: "4px 10px",
                backgroundColor: "#f1f5f9",
                border: "1px solid #e2e8f0",
                borderRadius: 6,
                cursor: "pointer",
                fontSize: 13,
                fontWeight: 600,
                color: "#475569",
                minHeight: 32,
              }}
            >Submittals</button>
            <button
              onClick={() => setRefWizardOpen(true)}
              title="Add a reference using the Reference Wizard"
              style={{
                display: "flex",
                alignItems: "center",
                gap: 4,
                padding: "4px 10px",
                backgroundColor: "#f1f5f9",
                border: "1px solid #e2e8f0",
                borderRadius: 6,
                cursor: "pointer",
                fontSize: 13,
                fontWeight: 600,
                color: "#475569",
                minHeight: 32,
              }}
            >+ Ref</button>
            <button
              onClick={() => setBracketOpen(prev => !prev)}
              title="Find and replace [bracketed] placeholders"
              style={{
                display: "flex",
                alignItems: "center",
                gap: 4,
                padding: "4px 10px",
                backgroundColor: bracketOpen ? "#ede9fe" : "#f1f5f9",
                border: bracketOpen ? "1px solid #7c3aed" : "1px solid #e2e8f0",
                borderRadius: 6,
                cursor: "pointer",
                fontSize: 13,
                fontWeight: 600,
                color: bracketOpen ? "#7c3aed" : "#475569",
                minHeight: 32,
              }}
            >[  ] Brackets</button>
            <button
              onClick={() => setValidationOpen(prev => !prev)}
              title="Run document validation checks"
              style={{
                display: "flex",
                alignItems: "center",
                gap: 4,
                padding: "4px 10px",
                backgroundColor: validationOpen ? "#fef2f2" : "#f1f5f9",
                border: validationOpen ? "1px solid #dc2626" : "1px solid #e2e8f0",
                borderRadius: 6,
                cursor: "pointer",
                fontSize: 13,
                fontWeight: 600,
                color: validationOpen ? "#dc2626" : "#475569",
                minHeight: 32,
              }}
            >Validate</button>
            <button
              onClick={() => { setComplianceOpen(prev => !prev); if (!complianceOpen) setShowComments(false); }}
              title={complianceOpen ? "Hide compliance panel" : "Check UFS 1-300-02 compliance"}
              style={{
                display: "flex", alignItems: "center", gap: 4,
                padding: "4px 10px",
                backgroundColor: complianceOpen ? "#faf5ff" : "#f1f5f9",
                border: complianceOpen ? "1px solid #7c3aed" : "1px solid #e2e8f0",
                borderRadius: 6, cursor: "pointer", fontSize: 13, fontWeight: 600,
                color: complianceOpen ? "#7c3aed" : "#475569", minHeight: 32,
              }}
            >Compliance</button>
            {/* Inline linting toggle */}
            <button
              onClick={() => {
                setInlineLintingEnabled(prev => {
                  if (prev) clearInlineLinting();
                  return !prev;
                });
              }}
              title={inlineLintingEnabled ? "Disable inline linting" : "Enable inline linting"}
              style={{
                padding: "4px 10px",
                backgroundColor: inlineLintingEnabled ? "#ecfdf5" : "#f1f5f9",
                border: inlineLintingEnabled ? "1px solid #10b981" : "1px solid #e2e8f0",
                borderRadius: 6, cursor: "pointer", fontSize: 13, fontWeight: 600,
                color: inlineLintingEnabled ? "#059669" : "#94a3b8", minHeight: 32,
              }}
            >Lint {inlineLintingEnabled ? "●" : "○"}</button>
            {/* Tags visibility toggle */}
            <button
              onClick={() => {
                // Preserve scroll position across layout shift caused by tag labels
                const scroller = document.querySelector('.editor-scroll') || document.scrollingElement;
                const focused = focusedBlockId ? document.querySelector(`[data-block-id="${focusedBlockId}"]`) : null;
                let anchor = focused;
                if (!anchor || anchor.getBoundingClientRect().top < 0 || anchor.getBoundingClientRect().top > window.innerHeight) {
                  const blocks = document.querySelectorAll('[data-block-id]');
                  for (const b of blocks) {
                    const r = b.getBoundingClientRect();
                    if (r.bottom > 0) { anchor = b; break; }
                  }
                }
                const beforeTop = anchor ? anchor.getBoundingClientRect().top : 0;
                setShowTags(prev => !prev);
                requestAnimationFrame(() => {
                  if (!anchor || !scroller) return;
                  const afterTop = anchor.getBoundingClientRect().top;
                  scroller.scrollTop += (afterTop - beforeTop);
                });
              }}
              title={showTags ? "Hide inline tags" : "Show inline tags"}
              style={{
                padding: "4px 10px",
                backgroundColor: showTags ? "#e0f2fe" : "#f1f5f9",
                border: showTags ? "1px solid #0ea5e9" : "1px solid #e2e8f0",
                borderRadius: 6, cursor: "pointer", fontSize: 12, fontWeight: 600,
                color: showTags ? "#0369a1" : "#475569", minHeight: 32,
                fontFamily: "'SF Mono', Consolas, monospace",
              }}
            >&lt;/&gt;</button>
            {/* Dark mode toggle */}
            <button
              onClick={() => setDarkMode(prev => !prev)}
              title={darkMode ? "Switch to light mode" : "Switch to dark mode"}
              style={{
                width: 32, height: 32, border: "1px solid #e2e8f0", borderRadius: 6,
                backgroundColor: darkMode ? "#334155" : "#f1f5f9",
                color: darkMode ? "#fbbf24" : "#475569",
                fontSize: 16, cursor: "pointer", display: "flex",
                alignItems: "center", justifyContent: "center",
              }}
            >{darkMode ? "\u2600" : "\u263D"}</button>
            {/* Zoom control */}
            <div style={{
              display: "flex", alignItems: "center", gap: 2,
              border: "1px solid #e2e8f0", borderRadius: 6,
              padding: "0 2px", backgroundColor: "#f1f5f9",
            }}>
              <button onClick={zoomOut} title="Zoom out (Ctrl+-)" style={{
                width: 26, height: 28, border: "none", background: "transparent",
                cursor: "pointer", fontSize: 14, color: "#475569", display: "flex",
                alignItems: "center", justifyContent: "center",
              }}>−</button>
              <button onClick={zoomReset}
                title="Reset zoom (Ctrl+0)"
                style={{
                  border: "none", background: "transparent", cursor: "pointer",
                  fontSize: 11, color: "#475569", fontWeight: 600, minWidth: 36,
                  textAlign: "center", height: 28,
                }}
              >{Math.round(editorZoom * 100)}%</button>
              <button onClick={zoomIn} title="Zoom in (Ctrl+=)" style={{
                width: 26, height: 28, border: "none", background: "transparent",
                cursor: "pointer", fontSize: 14, color: "#475569", display: "flex",
                alignItems: "center", justifyContent: "center",
              }}>+</button>
            </div>
            <span style={{
              padding: "2px 8px",
              backgroundColor: "#ecfdf5",
              color: "#059669",
              borderRadius: 10,
              fontWeight: 600,
              fontSize: 12,
            }}>EDITING</span>
            {saveStatus === 'saved' && (
              <span style={{ fontSize: 11, color: "#059669", opacity: 0.7 }}>Saved</span>
            )}
            {saveStatus === 'saving' && (
              <span style={{ fontSize: 11, color: "#64748b", opacity: 0.7 }}>Saving...</span>
            )}
            {isDirty && !saveStatus && (
              <span title="Unsaved changes" style={{ fontSize: 11, color: "#d97706" }}>●</span>
            )}
          </div>
        </div>

        {/* Tailoring Profile */}
        <TailoringProfile
          active={tailorActive}
          onActiveChange={setTailorActive}
          profile={tailorProfile}
          onProfileChange={setTailorProfile}
          showAll={tailorShowAll}
          onShowAllChange={setTailorShowAll}
        />

        {/* Revision Controls */}
        <RevisionControls
          trackChanges={trackChanges}
          onTrackChangesChange={(val) => {
            tcDirtyRef.current = true;
            setTrackChanges(val);
            // When disabling TC we intentionally leave local tcSnapshots
            // state as-is. The publish effect at the top of the file
            // computes `snapshots = {}` whenever trackChanges is false
            // (regardless of tcSnapshots), so the Y.Doc gets cleared
            // correctly, and annotateDomWithDiff is not called with TC
            // off — stale local state is harmless.
            if (val) {
              // Snapshot the "visible" text of each block when TC turns on.
              // Uses getVisibleTextFromHtml which excludes <del> content
              // (already-deleted text) but includes <ins> content (already-added text).
              // This ensures re-enabling TC after a toggle doesn't corrupt the baseline.
              const snap = new Map();
              for (const b of blocksRef.current) {
                if (b.html) {
                  snap.set(b.id, getVisibleTextFromHtml(b.html));
                }
              }
              setTcSnapshots(snap);
            }
          }}
          showRevisions={showRevisions}
          onShowRevisionsChange={setShowRevisions}
          showNotes={showNotes}
          onShowNotesChange={setShowNotes}
          unitDisplay={unitDisplay}
          onUnitDisplayChange={setUnitDisplay}
          blocks={blocks}
          onAcceptAll={handleAcceptAll}
          onRejectAll={handleRejectAll}
        />

        {/* Cross-Reference Validation */}
        <CrossRefPanel blocks={blocks} sectionNumber={sectionNumber} onRemoveOrphaned={handleRemoveOrphaned} />

        {/* In-Document Search */}
        {searchOpen && (
          <SearchBar
            blocks={blocks}
            editorRef={editorRef}
            onReplace={handleSearchReplace}
            initialShowReplace={searchOpen === 'replace'}
            onClose={() => {
              setSearchOpen(false);
              // Clean up any search highlight marks
              const marks = document.querySelectorAll('mark.search-highlight');
              for (const el of marks) {
                const parent = el.parentNode;
                while (el.firstChild) parent.insertBefore(el.firstChild, el);
                parent.removeChild(el);
                parent.normalize();
              }
            }}
          />
        )}

        {/* Bracket Replace Panel */}
        {bracketOpen && (
          <BracketReplace
            blocks={blocks}
            onReplace={handleSearchReplace}
            onClose={() => setBracketOpen(false)}
          />
        )}

        {/* Document Validation Panel */}
        {validationOpen && (
          <ValidationPanel
            blocks={blocks}
            onClose={() => setValidationOpen(false)}
          />
        )}

        {/* Editor + Comments Panel Container */}
        <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
        {/* Editor Scroll Area — full width so scrolling works in white space */}
        <div
          className="editor-scroll"
          style={{
            flex: 1,
            overflowY: "auto",
            backgroundColor: "var(--sim-editor-bg, #f8f7f4)",
          }}
        >
        {/* Editor Content — centered with max width, zoomable */}
        <div
          ref={editorRef}
          className={`${showRevisions ? '' : 'revisions-hidden'} ${showNotes ? '' : 'notes-hidden'} ${showTags ? 'tags-visible' : 'tags-hidden'} ${unitDisplay === 'eng' ? 'units-eng-only' : unitDisplay === 'met' ? 'units-met-only' : ''}`.trim()}
          onCopy={(e) => {
            const sel = window.getSelection();
            if (!sel || sel.isCollapsed) return;
            const plainText = sel.toString();
            e.clipboardData.setData('text/plain', plainText);
            e.preventDefault();
          }}
          style={{
            padding: "16px 24px 100px",
            maxWidth: 800,
            marginLeft: "auto",
            marginRight: showComments ? 0 : "auto",
            width: "100%",
            position: "relative",
            zoom: editorZoom,
          }}
        >
          <FloatingToolbar editorRef={editorRef} onBlockUpdate={handleBlockUpdate} onRevisionAction={handleRevisionAction} trackChanges={trackChanges} onCommentCreate={handleCommentCreate} readOnly={collabReadOnly} />

          {inRoom && identity && (
            <RemoteCursors peers={peers} selfId={identity.id} editorRef={editorRef} />
          )}

          {/* Comment Popup */}
          {openCommentId && comments.get(openCommentId) && commentRect && (
            <CommentPopup
              comment={comments.get(openCommentId)}
              rect={commentRect}
              onReply={handleCommentReply}
              onResolve={handleCommentResolve}
              onReopen={handleCommentReopen}
              onDelete={handleCommentDelete}
              onUpdateCreate={handleCommentUpdateCreate}
              onClose={() => setOpenCommentId(null)}
            />
          )}

          {/* Section Banner */}
          <div style={{
            textAlign: "center",
            padding: "24px 0 16px",
            marginBottom: 16,
            borderBottom: "3px double #334155",
          }}>
            <div style={{ fontSize: 11, color: "#64748b", letterSpacing: "0.1em", marginBottom: 4 }}>
              USACE / NAVFAC / AFCEC
            </div>
            <div style={{ fontSize: 11, color: "#64748b", marginBottom: 12 }}>
              UFGS-{sectionNumber} ({ufgsDate})
            </div>
            <div style={{ fontSize: 10, color: "#94a3b8", letterSpacing: "0.08em", marginBottom: 8 }}>
              UNIFIED FACILITIES GUIDE SPECIFICATIONS
            </div>
            <div style={{ fontSize: 20, fontWeight: 800, color: "#0f172a", letterSpacing: "0.04em", fontFamily: "Georgia, serif" }}>
              SECTION {sectionNumber}
            </div>
            <div style={{ fontSize: 18, fontWeight: 700, color: "#1e293b", fontFamily: "Georgia, serif", marginTop: 4 }}>
              {sectionTitle}
            </div>
            {ufgsDate && <div style={{ fontSize: 12, color: "#64748b", marginTop: 4 }}>{ufgsDate}</div>}
          </div>

          {/* Content Blocks */}
          {blocks.map(block => {
            if (block.type === "title") {
              return (
                <TitleBlock
                  key={block.id}
                  block={block}
                  onFocus={handleClickFocus}
                  isFocused={focusedBlockId === block.id}
                  sectionNum={numberMap[block.id]}
                  onUpdate={handleBlockUpdate}
                  onPromote={handlePromote}
                  onDemote={handleDemote}
                  onEnterKey={handleEnterKey}
                  onDelete={handleDelete}
                  onFocusPrev={handleFocusPrev}
                  onFocusNext={handleFocusNext}
                  readOnly={collabReadOnly}
                />
              );
            }
            if (block.type === "pagebreak") {
              return (
                <div key={block.id} id={`block-${block.id}`}
                  onClick={() => handleClickFocus(block.id)}
                  style={{
                    position: "relative",
                    margin: "16px 0",
                    borderTop: "2px dashed #cbd5e1",
                    textAlign: "center",
                  }}
                >
                  <span style={{
                    position: "relative", top: -10,
                    backgroundColor: "var(--sim-editor-bg, #f8f7f4)",
                    padding: "0 12px",
                    fontSize: 10,
                    color: "#94a3b8",
                    fontWeight: 600,
                    letterSpacing: "0.06em",
                    textTransform: "uppercase",
                  }}>Page Break</span>
                  {focusedBlockId === block.id && (
                    <button
                      onClick={(e) => { e.stopPropagation(); handleDelete(block.id); }}
                      title="Remove page break"
                      style={{
                        position: "absolute", top: -12, right: 0,
                        width: 20, height: 20, border: "1px solid #dc262640",
                        borderRadius: 3, backgroundColor: "#fef2f2", color: "#dc2626",
                        fontSize: 11, cursor: "pointer", display: "flex",
                        alignItems: "center", justifyContent: "center", padding: 0,
                      }}
                    >×</button>
                  )}
                </div>
              );
            }
            if (block.type === "tbl") {
              return (
                <PreformattedBlock
                  key={block.id}
                  block={block}
                  isFocused={focusedBlockId === block.id}
                  onFocus={handleClickFocus}
                  onUpdate={(id, data) => {
                    resumeHistory();
                    setBlocks(prev => prev.map(b => b.id === id ? { ...b, ...data } : b));
                  }}
                />
              );
            }
            if (block.type === "table") {
              return (
                <TableBlock
                  key={block.id}
                  block={block}
                  isFocused={focusedBlockId === block.id}
                  onFocus={handleClickFocus}
                  onUpdate={(id, data) => {
                    resumeHistory();
                    setBlocks(prev => prev.map(b => b.id === id ? { ...b, ...data } : b));
                  }}
                  readOnly={collabReadOnly}
                />
              );
            }
            if (block.type === "ref") {
              return (
                <RefBlock
                  key={block.id}
                  block={block}
                  onUpdate={(id, data) => setBlocks(prev => prev.map(b =>
                    b.id === id ? { ...b, ref: data.ref } : b
                  ))}
                  isFocused={focusedBlockId === block.id}
                  onFocus={handleClickFocus}
                  readOnly={collabReadOnly}
                  onAcceptRevision={(id) => {
                    resumeHistory();
                    setBlocks(prev => {
                      const idx = prev.findIndex(b => b.id === id);
                      if (idx < 0) return prev;
                      const b = prev[idx];
                      if (b.revision === 'del') return prev.filter(bl => bl.id !== id);
                      const next = [...prev];
                      next[idx] = { ...b, revision: undefined };
                      return next;
                    });
                  }}
                  onRejectRevision={(id) => {
                    resumeHistory();
                    setBlocks(prev => {
                      const idx = prev.findIndex(b => b.id === id);
                      if (idx < 0) return prev;
                      const b = prev[idx];
                      if (b.revision === 'add') return prev.filter(bl => bl.id !== id);
                      const next = [...prev];
                      next[idx] = { ...b, revision: undefined };
                      return next;
                    });
                  }}
                  onCommentClick={(commentId, rect) => {
                    setOpenCommentId(commentId);
                    setCommentRect(rect);
                  }}
                />
              );
            }
            return (
              <div key={`${block.id}-${block.type}`}>
                <EditableBlock
                  block={block}
                  onUpdate={handleBlockUpdate}
                  onEnterKey={handleEnterKey}
                  onFocus={handleClickFocus}
                  isFocused={focusedBlockId === block.id}
                  oliLabel={block.type === "oli" ? oliLabels[block.id] : null}
                  onDelete={handleDelete}
                  onFocusPrev={handleFocusPrev}
                  onFocusNext={handleFocusNext}
                  onConvertBlock={handleConvertBlock}
                  onChangeOliLevel={handleChangeOliLevel}
                  resolveHtml={resolveHtml}
                  tailorKey={tailorKey}
                  trackChanges={trackChanges}
                  snapshotText={tcSnapshots.get(block.id)}
                  identity={identity}
                  readOnly={collabReadOnly}
                  onAcceptRevision={(id) => {
                    resumeHistory();
                    setBlocks(prev => {
                      const idx = prev.findIndex(b => b.id === id);
                      if (idx < 0) return prev;
                      const b = prev[idx];
                      if (b.revision === 'del') return prev.filter(bl => bl.id !== id);
                      const next = [...prev];
                      const html = b.html ? acceptAllInline(b.html) : b.html;
                      next[idx] = { ...b, revision: undefined, html };
                      return next;
                    });
                    if (trackChanges) {
                      tcDirtyRef.current = true;
                      setTcSnapshots(prev => {
                        const s = new Map(prev);
                        const b = blocksRef.current.find(bl => bl.id === id);
                        const html = b?.html ? acceptAllInline(b.html) : (b?.html || '');
                        s.set(id, getVisibleTextFromHtml(html));
                        return s;
                      });
                    }
                  }}
                  onRejectRevision={(id) => {
                    resumeHistory();
                    setBlocks(prev => {
                      const idx = prev.findIndex(b => b.id === id);
                      if (idx < 0) return prev;
                      const b = prev[idx];
                      if (b.revision === 'add') return prev.filter(bl => bl.id !== id);
                      const next = [...prev];
                      const html = b.html ? rejectAllInline(b.html) : b.html;
                      next[idx] = { ...b, revision: undefined, html };
                      return next;
                    });
                    if (trackChanges) {
                      tcDirtyRef.current = true;
                      setTcSnapshots(prev => {
                        const s = new Map(prev);
                        const b = blocksRef.current.find(bl => bl.id === id);
                        const html = b?.html ? rejectAllInline(b.html) : (b?.html || '');
                        s.set(id, getVisibleTextFromHtml(html));
                        return s;
                      });
                    }
                  }}
                  onRevisionAction={handleRevisionAction}
                  comments={comments}
                  onCommentClick={handleCommentClick}
                  onInlineFix={handleComplianceAcceptFix}
                  inlineLintingEnabled={inlineLintingEnabled}
                  compliancePanelActive={complianceOpen}
                  showTags={showTags}
                />
                {focusedBlockId === block.id && (
                  <MarkSuggestions
                    blockId={block.id}
                    html={block.html}
                    onApply={handleBlockUpdateWithSync}
                  />
                )}
              </div>
            );
          })}
        </div>
        </div>{/* close Editor Scroll Area */}

        {/* Comments Panel (right side) */}
        {showComments && comments.size > 0 && (
          <div style={{
            width: 300,
            borderLeft: "1px solid #dadce0",
            overflowY: "auto",
            padding: "16px 12px",
            backgroundColor: "#fafafa",
            flexShrink: 0,
          }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: "#202124", marginBottom: 12, padding: "0 4px" }}>
              Comments ({comments.size})
            </div>
            {Array.from(comments.values())
              .sort((a, b) => {
                const aIdx = blocks.findIndex(bl => bl.id === a.blockId);
                const bIdx = blocks.findIndex(bl => bl.id === b.blockId);
                return aIdx - bIdx;
              })
              .map(c => {
                const firstEntry = c.entries.find(e => e.type === "create");
                const isActive = openCommentId === c.id;
                return (
                  <div
                    key={c.id}
                    onClick={() => {
                      const el = document.querySelector(`[data-comment-id="${c.id}"]`);
                      if (el) {
                        el.scrollIntoView({ behavior: "smooth", block: "center" });
                        setOpenCommentId(c.id);
                        setCommentRect(el.getBoundingClientRect());
                      }
                    }}
                    style={{
                      padding: "8px 10px",
                      marginBottom: 6,
                      borderRadius: 6,
                      border: isActive ? "1px solid #1a73e8" : "1px solid #dadce0",
                      backgroundColor: isActive ? "#e8f0fe" : "white",
                      cursor: "pointer",
                      fontSize: 12,
                      transition: "all 0.15s ease",
                    }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <span style={{ fontWeight: 500, color: "#202124" }}>{firstEntry?.author || "User"}</span>
                      <span style={{
                        fontSize: 10, fontWeight: 600, padding: "1px 6px", borderRadius: 8,
                        background: c.status === "resolved" ? "#e6f4ea" : "#fef7e0",
                        color: c.status === "resolved" ? "#188038" : "#b06000",
                      }}>{c.status}</span>
                    </div>
                    <div style={{ color: "#5f6368", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {firstEntry?.text || ""}
                    </div>
                    <div style={{
                      color: "#80868b", fontSize: 10, marginTop: 2,
                      fontStyle: "italic", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                    }}>
                      &ldquo;{c.highlightText}&rdquo;
                    </div>
                  </div>
                );
              })}
          </div>
        )}

        {/* Compliance Panel (right side) */}
        {complianceOpen && (
          <CompliancePanel
            blocks={blocks}
            focusedBlockId={focusedBlockId}
            onAcceptFix={handleComplianceAcceptFix}
            onAcceptGroupFix={handleComplianceAcceptGroup}
            onScrollToBlock={handleComplianceScrollTo}
            trackChanges={trackChanges}
            unitDisplay={unitDisplay}
          />
        )}

        {/* Room Management Panel (right side) */}
        {showRoomPanel && (
          <RoomPanel
            rooms={roomList}
            currentRoom={roomId}
            onJoin={(id) => { window.location.href = buildRoomUrl(id); }}
            onClose={() => setShowRoomPanel(false)}
            onCreateRoom={async (name) => {
              try {
                const res = await fetch(`${COLLAB_HTTP_URL}/rooms`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json', ...authHeaders },
                  body: JSON.stringify({ id: name }),
                });
                if (res.ok) {
                  const listRes = await fetch(`${COLLAB_HTTP_URL}/rooms`, { headers: authHeaders });
                  const data = await listRes.json();
                  setRoomList(data.rooms || []);
                }
              } catch { /* ignore */ }
            }}
            onDeleteRoom={async (id) => {
              if (!window.confirm(`Delete room "${id}"? This cannot be undone.`)) return;
              try {
                await fetch(`${COLLAB_HTTP_URL}/rooms/${id}`, { method: 'DELETE', headers: authHeaders });
                setRoomList(prev => prev.filter(r => r.id !== id));
              } catch { /* ignore */ }
            }}
          />
        )}
        </div>

        {/* Status Bar */}
        <div style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "5px 16px",
          borderTop: "1px solid #e2e8f0",
          backgroundColor: "#ffffff",
          fontSize: 12,
          color: "#64748b",
        }}>
          <span>{blocks.length} blocks | {blocks.filter(b => b.type === "title").length} sections | {blocks.filter(b => b.type === "table").length} tables</span>
          <span>Enter: new paragraph | Backspace: delete empty | / : insert block type | Tab/Shift+Tab: heading level | Ctrl+Z: undo | Ctrl+Y: redo</span>
          <span>{fileName}</span>
        </div>
      </div>

      {/* Reference Wizard Modal */}
      {refWizardOpen && (
        <RefWizard
          onAdd={handleAddReference}
          onClose={() => setRefWizardOpen(false)}
          existingOrgs={blocks.filter(b => b.type === 'ref' && b.ref?.org).map(b => b.ref.org)}
        />
      )}

      {/* Collab identity prompt — appears on first load when ?room=... is present */}
      {inRoom && !identity && getAuthMode() === 'stub' && (
        <IdentityModal roomId={roomId} onIdentity={setIdentity} />
      )}
    </div>
  );
}
