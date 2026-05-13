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
import { useUndoableBlocks } from "./lib/useUndoableBlocks.js";
import * as Y from "yjs";
import { seedBlockArray, resetBlockArray, setBlockHtml, getBlockHtml } from "./lib/block-html-store.js";
import { focusBlockById, getBlockHandle, getBlockEditable, getBlockDom, getBlockView, listBlocksInDocumentOrder } from "./lib/block-registry.js";
import { setActiveComment } from "./lib/pm-plugins/active-comment.js";
import { TextSelection } from "prosemirror-state";
import { isPmEditorEnabled } from "./lib/feature-flags.js";
import * as tc from "./lib/track-changes.js";
import * as linting from "./lib/linting.js";
import * as comp from "./lib/compliance.js";
import { findHighlightTargetsInBlock } from "./lib/compliance-ranges.js";
import INITIAL_BLOCKS from "./data/sample-31-00-00.json";
import { getRoomFromUrl, buildRoomUrl, generateRoomId, DEFAULT_HTTP_URL, applyBlocksToYDoc } from "./lib/collab.js";
import { useCollabSession } from "./hooks/useCollabSession.js";
import * as cm from "./lib/comments.js";
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
    blocks, tcState, setBlocks, setBlocksDirect, setTcState,
    undo, redo, canUndo, canRedo, clearHistory, resumeHistory,
  } = useUndoableBlocks(INITIAL_BLOCKS, {
    // Sub-PR 1f: PM-mode dirty-html resolver. For PM EditorView blocks the
    // hook reads the substrate (synchronous per-keystroke writes via
    // ySyncPlugin) instead of `activeEl.innerHTML` (which contains widget
    // decorations from tag-labels). Legacy blocks fall through to the
    // hook's default innerHTML capture. The closure over `activeYStoreRef`
    // is safe even though the ref is declared below — the function is only
    // invoked at undo-time, well after all consts in this render initialize.
    getPmDirtyHtml: (id) => {
      try {
        const yStore = activeYStoreRef.current;
        return yStore ? getBlockHtml(yStore, id) : null;
      } catch {
        return null;
      }
    },
  });
  // Local Y.Doc — the no-room substrate for block html. EditableBlock's
  // useBlockBinder reads/writes this when !inRoom. In-room mode, the
  // session's Y.Doc takes over; the local substrate stays allocated but
  // dormant. See ADR-0004 (#22 sub-PR 1b).
  const [localSubstrate] = useState(() => {
    const ydoc = new Y.Doc();
    const yOrder = ydoc.getArray('order');
    const yStore = ydoc.getMap('store');
    seedBlockArray(ydoc, yOrder, yStore, INITIAL_BLOCKS);
    return { ydoc, yOrder, yStore };
  });
  // Ref to the active substrate's yStore so callbacks declared before the
  // useCollabSession call (which is where the session yStore comes from)
  // can still reach it without a temporal-dead-zone reference. Updated
  // below after `activeYStore` is computed.
  const activeYStoreRef = useRef(localSubstrate.yStore);
  const trackChanges = tc.isEnabled(tcState);
  const [selectedTreeId, setSelectedTreeId] = useState(null);
  const [focusedBlockId, setFocusedBlockId] = useState(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const [fileName, setFileName] = useState("31_00_00.SEC");
  const [tailorActive, setTailorActive] = useState(false);
  const [tailorProfile, setTailorProfile] = useState({ branch: null, region: null, deliveryMethod: null });
  const [tailorShowAll, setTailorShowAll] = useState(false);
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
  const [commentsState, setCommentsState] = useState(cm.createInitial());
  // `commentsState.byId` is a Map<commentId, Comment> — alias kept for the
  // many UI consumers that expect the old `comments` Map shape.
  const comments = commentsState.byId;
  const [openCommentId, setOpenCommentId] = useState(null);
  const [commentRect, setCommentRect] = useState(null);
  const [showComments, setShowComments] = useState(false);
  const [complianceOpen, setComplianceOpen] = useState(false);
  const [complianceState, setComplianceState] = useState(() => comp.createInitial());
  const [collabReachable, setCollabReachable] = useState(false);
  const [showRoomPanel, setShowRoomPanel] = useState(false);
  const [roomList, setRoomList] = useState([]);
  const [lintingState, setLintingState] = useState(() => {
    let enabled = true;
    try { enabled = localStorage.getItem('sim-inline-linting') !== 'false'; } catch {}
    return linting.createInitial({ enabled });
  });
  const inlineLintingEnabled = lintingState.enabled;
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
  const [roomLocked, setRoomLocked] = useState(false);
  const [roomLockedBy, setRoomLockedBy] = useState(null);
  const [roomLockedByName, setRoomLockedByName] = useState(null);
  const isLockedByOther = roomLocked && roomLockedBy !== identity?.id;
  // 'migration-partial' is informational, NOT read-only: the broker
  // succeeded for some blocks but threw on others; the room remains fully
  // editable (1d, ADR-0006). Treat it as a non-blocking status alongside
  // 'connected' for the read-only gate. Without this exclusion the editor
  // locks even though publish gates are open and the substrate accepts
  // writes — contradicts the "room stays editable" invariant.
  const collabReadOnly = (
    inRoom &&
    collabStatus !== null &&
    collabStatus !== 'connected' &&
    collabStatus !== 'migration-partial'
  ) || isLockedByOther;
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
  // Holds the imperative API returned by useCollabSession (see lifecycle
  // section below). Maintained as a ref so callbacks defined before the
  // hook call can still dispatch through it (e.g. dispatchComment).
  const collabRef = useRef(null);

  const fileHandleRef = useRef(null); // File System Access API handle for SEC file
  const commentsHandleRef = useRef(null); // File System Access API handle for comments sidecar
  const editorRef = useRef(null);
  const fileInputRef = useRef(null);
  const blocksRef = useRef(blocks);
  blocksRef.current = blocks;
  const sectionMetaRef = useRef(sectionMeta);
  sectionMetaRef.current = sectionMeta;
  const commentsStateRef = useRef(commentsState);
  commentsStateRef.current = commentsState;
  const tree = useMemo(() => buildTree(blocks), [blocks]);
  const numberMap = useMemo(() => computeNumbering(blocks), [blocks]);
  const oliLabels = useMemo(() => computeOliLabels(blocks), [blocks]);

  // Out-of-room: keep the local Y.Doc substrate's structure (yOrder + yMaps)
  // in sync with the React blocks array. New blocks (Enter/slash menu),
  // deletions, and reorders flow through React state first; the binder needs
  // a Y.Map for each id or its getBlockHtml returns ''. applyBlocksToYDoc's
  // skip-html semantic (#22 sub-PR 1b) means existing yTexts stay intact;
  // brand-new ids get their html seeded from block.html. In-room mode uses
  // the existing useCollabSession publish-effect path and skips this.
  useEffect(() => {
    if (inRoom) return;
    applyBlocksToYDoc(localSubstrate.ydoc, localSubstrate.yOrder, localSubstrate.yStore, blocks);
  }, [blocks, inRoom, localSubstrate]);

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
      // No-room: rewrite the local Y.Doc substrate so the binder sees the
      // freshly-loaded blocks. Single 'reset' transaction so the binder's
      // subscribe never observes a half-cleared document. In-room: the
      // existing publishBlocks path handles structural seeding for any
      // brand-new ids, and the binder reads what's already in the room.
      if (!inRoom) {
        resetBlockArray(localSubstrate.ydoc, localSubstrate.yOrder, localSubstrate.yStore, parsed);
      }
      setBlocks(parsed);
      setFileName(name);
      setSectionMeta(extractMetadata(content));
      setSelectedTreeId(null);
      setFocusedBlockId(null);
      // In a room, yComments is the authoritative source — do not wipe shared
      // comment state on a local file import.
      if (!inRoom) setCommentsState(cm.createInitial());
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
  }, [extractMetadata, clearHistory, inRoom, localSubstrate]);

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
  // New blocks focus themselves via the ref callback in EditableBlock.
  //
  // Sub-PR 1e (#47, v2 plan Q17/E4). Was: querySelector('[data-block-id=…]')
  // + manual Range placement. Now goes through block-registry's imperative
  // handle so PM-mounted blocks (which own their internal DOM and don't
  // surface a single contentEditable) can route the focus to PM's
  // EditorView.dispatch + Selection.atEnd. The 1i sub-PR will lint-fail any
  // re-introduction of the querySelector pattern.
  //
  // Race safety (QC major-5): the legacy fallback's manual Range placement
  // fights PM's own selection management. We give the registry two chances
  // (microtask + animation frame) before falling back to a DOM-level lookup.
  // If the resolved element is PM-owned (data-pm-editor="true"), we only
  // call .focus() — PM resolves the cursor on the next dispatch — rather
  // than imperatively placing a Range PM will immediately overwrite.
  const focusBlock = useCallback((id, atEnd = true) => {
    setFocusedBlockId(id);
    const tryFocus = () => focusBlockById(id, { atEnd });
    const fallbackToDom = () => {
      const el = document.querySelector(`[data-block-id="${id}"]`);
      if (!el) return;
      el.focus();
      // PM owns the cursor for its own DOM — don't fight it with a manual
      // Range placement (PM would overwrite on the next dispatch and our
      // caret would jump). PM's view.focus() above is enough; if the caller
      // needs end-of-doc placement, the registry path (which dispatches
      // Selection.atEnd) will take over once the mount effect fires.
      const isPm = el.getAttribute && el.getAttribute('data-pm-editor') === 'true';
      if (isPm) return;
      const range = document.createRange();
      const sel = window.getSelection();
      if (el.childNodes.length > 0) {
        range.selectNodeContents(el);
        range.collapse(atEnd);
      }
      sel?.removeAllRanges();
      sel?.addRange(range);
    };
    // setTimeout(0) lets React finish any pending state updates first.
    setTimeout(() => {
      if (tryFocus()) return;
      // Registry not populated yet — give it one animation frame for the
      // mount effect to fire, then try once more before the legacy fallback.
      requestAnimationFrame(() => {
        if (tryFocus()) return;
        fallbackToDom();
      });
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

  // Comment dispatcher — thin wrapper that routes a PublishEnvelope to the
  // collab session via the useCollabSession hook (set up further below).
  // collabRef defers the call so this useCallback can be defined before the
  // hook returns; collab.dispatchComment is itself idempotent when not in
  // a room.
  const dispatchComment = useCallback((envelope) => {
    collabRef.current?.dispatchComment(envelope);
  }, []);

  const effectiveIdentity = useCallback(() => (
    identity || { id: 'local', name: getAuthorName() || 'User', color: '#888' }
  ), [identity]);

  const handleCommentCreate = useCallback((blockId, html, commentId, highlightText) => {
    // html is null for ref blocks (their data is in block.ref, not block.html)
    if (html !== null) {
      setBlocks(prev => prev.map(b => b.id === blockId ? { ...b, html } : b));
    }
    const ts = Date.now();
    const { state } = cm.createDraft(commentsStateRef.current, {
      commentId, blockId, highlightText: highlightText || '', identity: effectiveIdentity(), ts,
    });
    setCommentsState(state);
    // Publish is deferred to handleCommentUpdateCreate so the Y.Doc never
    // holds a pending empty-text comment entry.
    setOpenCommentId(commentId);
    setTimeout(() => {
      const el = document.querySelector(`[data-comment-id="${commentId}"]`);
      if (el) setCommentRect(el.getBoundingClientRect());
    }, 50);
  }, [effectiveIdentity]);

  const handleCommentUpdateCreate = useCallback((commentId, text) => {
    const ts = Date.now();
    const { state, publish } = cm.updateCreate(commentsStateRef.current, {
      commentId, text, identity: effectiveIdentity(), ts,
    });
    setCommentsState(state);
    dispatchComment(publish);
  }, [effectiveIdentity, dispatchComment]);

  const handleCommentReply = useCallback((commentId, text) => {
    const ts = Date.now();
    const { state, publish } = cm.reply(commentsStateRef.current, {
      commentId, text, identity: effectiveIdentity(), ts,
    });
    setCommentsState(state);
    dispatchComment(publish);
  }, [effectiveIdentity, dispatchComment]);

  const handleCommentResolve = useCallback((commentId) => {
    const ts = Date.now();
    const { state, publish } = cm.resolve(commentsStateRef.current, {
      commentId, identity: effectiveIdentity(), ts,
    });
    setCommentsState(state);
    dispatchComment(publish);
  }, [effectiveIdentity, dispatchComment]);

  const handleCommentReopen = useCallback((commentId) => {
    const ts = Date.now();
    const { state, publish } = cm.reopen(commentsStateRef.current, {
      commentId, identity: effectiveIdentity(), ts,
    });
    setCommentsState(state);
    dispatchComment(publish);
  }, [effectiveIdentity, dispatchComment]);

  const handleCommentDelete = useCallback((commentId) => {
    const { state, publish } = cm.remove(commentsStateRef.current, { commentId });
    setCommentsState(state);
    dispatchComment(publish);
    setOpenCommentId(null);
  }, [dispatchComment]);

  const handleCommentClick = useCallback((commentId, rect) => {
    setOpenCommentId(commentId);
    setCommentRect(rect);
  }, []);

  // 1g — wire setActiveComment against the right PM view via block-registry.
  // Tracks the previously-highlighted view in `prevActiveViewRef` so a comment
  // that moves between blocks (or simply closes) cleanly clears the old
  // highlight. Plugin reducer detects same-id no-op meta dispatches.
  //
  // Deps are narrow: openCommentId AND the resolved activeBlockId. Peer
  // replies to OTHER comments don't refire the effect because they don't
  // change either dep value.
  const prevActiveViewRef = useRef(null);
  const activeBlockId = openCommentId
    ? commentsState.byId.get(openCommentId)?.blockId ?? null
    : null;
  useEffect(() => {
    const nextView = activeBlockId ? getBlockView(activeBlockId) : null;
    if (prevActiveViewRef.current && prevActiveViewRef.current !== nextView) {
      try { setActiveComment(prevActiveViewRef.current, null); } catch { /* view may be destroyed */ }
    }
    if (nextView) {
      try { setActiveComment(nextView, openCommentId); } catch { /* view may be destroyed */ }
    }
    prevActiveViewRef.current = nextView;
  }, [openCommentId, activeBlockId]);

  // Reconcile mark-comment spans against commentsState whenever either side
  // changes. cm.reconcileBlocks unwraps spans for missing ids and reclasses
  // open↔resolved when the cached className disagrees with state. The verb
  // is idempotent — when nothing changes it returns the original `blocks`
  // ref, so React's setState bails out and there's no re-render loop.
  //
  // Routed through setBlocksDirect so the mechanical fix-up does not push
  // an undo entry / clear the redo stack — otherwise a Ctrl+Z would clear
  // future right after the reconcile effect ran on the new (post-undo)
  // blocks reference.
  //
  // Post-1b: also mirror the html change into the substrate so the binder
  // (and remote peers) see the orphan-unwrap or status-reclass — applyBlocksToYDoc
  // no longer touches html for existing yText.
  useEffect(() => {
    setBlocksDirect(prev => {
      // 1g: PM-mounted blocks own their comment reconcile via the per-block
      // PM effect in PmEditableBlock.jsx (reconcileCommentMarks dispatch).
      // Skip them here so the html walk doesn't redundantly rewrite their
      // mark spans (which would then be clobbered by the PM dispatch anyway).
      const pmMountedIds = new Set();
      for (const b of prev) {
        if (getBlockView(b.id) != null) pmMountedIds.add(b.id);
      }
      const next = cm.reconcileBlocks(prev, commentsState, {
        shouldSkip: (id) => pmMountedIds.has(id),
      });
      const yStore = activeYStoreRef.current;
      if (next !== prev && yStore) {
        for (const b of next) {
          if (typeof b.html !== 'string') continue;
          const before = prev.find(p => p.id === b.id);
          if (before && before.html !== b.html) setBlockHtml(yStore, b.id, b.html);
        }
      }
      return next;
    });
  }, [blocks, commentsState, setBlocksDirect]);

  const handleBlockUpdate = useCallback((id, html) => {
    // Mirror the new html into the active Y.Doc substrate so non-typing
    // mutations stay observable through getBlockHtml. Typing flows through
    // useBlockBinder.write directly and skips this codepath; this handler
    // remains for handleBlur, programmatic onUpdate calls, and anything
    // routed via FloatingToolbar.onBlockUpdate.
    const yStore = activeYStoreRef.current;
    if (yStore) setBlockHtml(yStore, id, html);
    setBlocks(prev => prev.map(b => b.id === id ? { ...b, html } : b));
  }, []);

  // Update block HTML AND refresh its TC snapshot (used by FloatingToolbar inline accept/reject)
  const handleRevisionAction = useCallback((id, html) => {
    resumeHistory();
    const yStore = activeYStoreRef.current;
    if (yStore) setBlockHtml(yStore, id, html);
    setBlocks(prev => prev.map(b => b.id === id ? { ...b, html } : b));
    setTcState(prev => tc.applyResolveAtBlock(prev, id, html));
  }, []);

  // 1f.9 (#47) — TC-only seam for FloatingToolbar in PM mode. PM dispatch
  // already wrote the substrate via ySyncPlugin; this handler ONLY updates
  // React state and the TC snapshot. Skipping setBlockHtml avoids a redundant
  // 'local-publish' op + duplicate broadcast.
  //
  // resumeHistory() matches handleRevisionAction's sibling pattern — without
  // it, useUndoableBlocks stays paused (auto-paused after every keystroke
  // flush) and this setBlocks captures NO snapshot, making inline TC accept/
  // reject silently non-undoable. The FloatingToolbar PM caller skips its
  // usual flushPendingUpdateById and calls cancelPendingUpdateById instead,
  // so this handler's setBlocks is the FIRST setBlocks in the toolbar
  // action's lifecycle and the captured snapshot's `prev` is the true
  // pre-action state.
  //
  // In-room mode does not benefit (App's Ctrl+Z prefers collab.tryUndo →
  // Yjs UndoManager, which only tracks 'local-publish' origin ops — and
  // setBlockHtml after ySyncPlugin's write is a no-op delta that produces
  // no Yjs ops). That gap is part of the broader PM-mode undo limitation
  // tracked alongside the existing Ctrl+Y redo off-by-one and is out of
  // scope for 1f.9.
  //
  // Distinct from handleRevisionAction (above), which is used by the
  // 1f.8 del-popup whose mutator works on serialized HTML and DOES need
  // setBlockHtml.
  const handleRefreshTcSnapshot = useCallback((id, html) => {
    resumeHistory();
    setBlocks(prev => prev.map(b => b.id === id ? { ...b, html } : b));
    setTcState(prev => tc.applyResolveAtBlock(prev, id, html));
  }, [resumeHistory]);

  // Update block HTML and sync the contentEditable DOM (used by MarkSuggestions).
  // For PM-mounted blocks the substrate write is the source of truth — the
  // EditorView re-renders via ySyncPlugin's observe — and the registry's
  // setHtml is a no-op. For legacy blocks, registry.setHtml replaces the
  // contentEditable's innerHTML and clears dataset.init so React's setRef
  // doesn't overwrite on remount.
  const handleBlockUpdateWithSync = useCallback((id, html) => {
    const handle = getBlockHandle(id);
    if (handle) handle.setHtml(html);
    const yStore = activeYStoreRef.current;
    if (yStore) setBlockHtml(yStore, id, html);
    // Then update React state to match
    setBlocks(prev => prev.map(b => b.id === id ? { ...b, html } : b));
  }, []);

  // 1f.7 (#47) — DEV-only Playwright test utilities. The legacy contentEditable
  // path let tests do `el.innerHTML = '...'; el.dispatchEvent('input')` because
  // the DOM was the source of truth. The PM path's source of truth is the Y
  // substrate / PM doc — a direct DOM write is overwritten by the next render
  // cycle, and reading `el.innerHTML` produces PM-wrapped shape (e.g.
  // `<p>text</p>` instead of `text`). These helpers route through App's normal
  // block update path so E2E tests work identically in both modes. Tests use
  // them via `tests/e2e/pm-helpers.js`. Never exposed in production builds.
  // Must come AFTER handleBlockUpdateWithSync so the dep array doesn't TDZ.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    if (typeof window === 'undefined') return;
    let flushOverridden = false;
    window.__simEditorTestUtils = {
      getBlockHtml: (id) => {
        const b = blocksRef.current.find((x) => x.id === id);
        return b ? b.html : null;
      },
      // handleBlockUpdateWithSync (not plain handleBlockUpdate) so the legacy
      // EditableBlock's contentEditable DOM stays in sync — the legacy DOM
      // sync effect skips writes while the block is focused (avoids fighting
      // active typing), so a focused-block injection via plain
      // handleBlockUpdate would update React state + substrate but leave the
      // stale DOM, and the next blur would read the stale DOM and clobber.
      setBlockHtml: (id, html) => { handleBlockUpdateWithSync(id, html); },
      getEditorMode: () => (isPmEditorEnabled() ? 'pm' : 'legacy'),
      // 1f.9 — read PM selection range for E3 (selection-persistence test).
      getPmSelection: (id) => {
        const view = getBlockView(id);
        if (!view) return null;
        const { from, to } = view.state.selection;
        return { from, to };
      },
      // 1f.9 — programmatically set PM selection for tests that need to
      // place the caret/range before clicking a toolbar button. Playwright's
      // dispatchEvent('mousedown')/click does not always route selection
      // through PM's domObserver.
      setPmSelection: (id, from, to) => {
        const view = getBlockView(id);
        if (!view) return false;
        try {
          const sel = TextSelection.create(view.state.doc, from, to);
          view.dispatch(view.state.tr.setSelection(sel));
          view.focus();
          return true;
        } catch { return false; }
      },
      // 1f.9 — negative control for E1 (flushPendingUpdate test). When
      // called with false, FloatingToolbar's PM branch will skip the flush
      // and React state will lag by the 400ms debounce.
      __overrideFlush: (enabled) => { flushOverridden = !enabled; },
      __isFlushOverridden: () => flushOverridden,
    };
    return () => { delete window.__simEditorTestUtils; };
  }, [handleBlockUpdateWithSync]);

  // Replace a match in a block's HTML at a given visible-text offset.
  // Sub-PR 1e (#47, v2 plan Q17/E4): the contentEditable DOM sync routes
  // through block-registry's setHtml — which is a no-op for PM-mounted
  // blocks (they re-render via ySyncPlugin's observe of the substrate
  // write below).
  const handleSearchReplace = useCallback((blockId, offset, length, replacement) => {
    resumeHistory();
    setBlocks(prev => prev.map(b => {
      if (b.id !== blockId || !b.html) return b;
      const newHtml = replaceMatchInHtml(b.html, offset, length, replacement);
      const handle = getBlockHandle(blockId);
      if (handle) handle.setHtml(newHtml);
      const yStore = activeYStoreRef.current;
      if (yStore) setBlockHtml(yStore, blockId, newHtml);
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

      const revisionFlag = tc.revisionFlagForCreate(tcState);
      const newBlock = {
        id: newId,
        type: newType,
        part: current.part,
        depth: current.depth,
        section: current.section,
        level: current.level,
        html: "",
        isNew: true,
        ...(revisionFlag ? { revision: revisionFlag } : {}),
      };
      const next = [...prev];
      next.splice(idx + 1, 0, newBlock);
      return next;
    });
    // Track Changes: add empty snapshot so all typed text is marked as additions on blur
    setTcState(prev => tc.markBlockCreated(prev, newId));
    setFocusedBlockId(newId);
  }, [tcState]);

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

      const flag = tc.revisionFlagForDelete(tcState, block);
      if (flag === 'del') {
        // Track Changes: mark as deleted instead of removing
        const next = [...prev];
        next[idx] = { ...block, revision: 'del' };
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
  }, [focusBlock, tcState]);

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
    setTcState(prev => tc.markBlockCreated(prev, newId));
    setFocusedBlockId(newId);
  }, [handleConvertToTitle]);

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
    const prev = blocksRef.current;
    const next = acceptAllRevisions(prev);
    // Push every changed block's html to the substrate so the binder
    // and remote peers see the resolution, not just the React-state cache.
    // Done OUTSIDE the React state updater — setBlockHtml is a side effect
    // that must not run inside a (potentially-reinvoked-in-StrictMode) updater.
    const yStore = activeYStoreRef.current;
    if (yStore) {
      for (let i = 0; i < next.length; i++) {
        const b = next[i];
        const before = prev.find(p => p.id === b.id);
        if (before && typeof b.html === 'string' && before.html !== b.html) {
          setBlockHtml(yStore, b.id, b.html);
        }
      }
    }
    setBlocks(next);
    // Refresh snapshots from the post-resolution state so subsequent edits
    // diff against the correct baseline (not stale pre-accept text)
    setTcState(s => tc.acceptAll(s, next));
  }, []);

  const handleRejectAll = useCallback(() => {
    resumeHistory();
    const prev = blocksRef.current;
    const next = rejectAllRevisions(prev);
    const yStore = activeYStoreRef.current;
    if (yStore) {
      for (let i = 0; i < next.length; i++) {
        const b = next[i];
        const before = prev.find(p => p.id === b.id);
        if (before && typeof b.html === 'string' && before.html !== b.html) {
          setBlockHtml(yStore, b.id, b.html);
        }
      }
    }
    setBlocks(next);
    setTcState(s => tc.rejectAll(s, next));
  }, []);

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

  // Suspend inline linting while the compliance panel is open
  // (panel renders its own CSS.highlights('compliance-active') ranges).
  useEffect(() => {
    setLintingState(s => linting.setSuspended(s, complianceOpen));
  }, [complianceOpen]);

  // Single seam that mutates the global CSS.highlights registry. Rebuilt
  // whenever lintingState changes, fed by getRangesByTier(state).
  useEffect(() => {
    if (typeof CSS === 'undefined' || !CSS.highlights) return;
    const groups = linting.getRangesByTier(lintingState);
    const sync = (name, ranges) => {
      if (ranges.length > 0) CSS.highlights.set(name, new Highlight(...ranges));
      else CSS.highlights.delete(name);
    };
    sync('compliance-error', groups.compliance);
    sync('grammar-error', groups.grammar);
    sync('passive-voice', groups.nlp);
  }, [lintingState]);

  // Compliance highlight via CSS Custom Highlight API. Mirrors the linting
  // tier-effect pattern above. Building Range objects (instead of injecting
  // spans) keeps the highlights stable across PM EditorView re-renders —
  // PM's view tear-down would have clobbered injected DOM. Computing the
  // targets is pure (compliance-ranges.js); the side effect lives here.
  //
  // `blocks` is in the dep array so PM-driven DOM rewrites (which detach the
  // text nodes our Range objects anchor to) trigger a fresh range build. But
  // scroll must NOT re-fire on every typing pause — only on panel open,
  // active group change, or fresh scan. The ref below gates the scroll
  // against (open, group, result) so block-only re-runs skip the scrollTo.
  const lastComplianceScrollRef = useRef({ open: false, group: null, result: null });
  useEffect(() => {
    if (typeof document === 'undefined') return;
    if (typeof CSS === 'undefined' || !CSS.highlights) return;
    const clear = () => CSS.highlights.delete('compliance-active');

    const prev = lastComplianceScrollRef.current;
    const triggerScroll = complianceOpen && (
      prev.open !== complianceOpen
      || prev.group !== complianceState.activeGroup
      || prev.result !== complianceState.result
    );
    lastComplianceScrollRef.current = {
      open: complianceOpen,
      group: complianceState.activeGroup,
      result: complianceState.result,
    };

    if (!complianceOpen) { clear(); return; }
    const group = comp.getActiveGroupObject(complianceState);
    if (!group || !Array.isArray(group.instances)) { clear(); return; }
    const ranges = [];
    let firstRange = null;
    for (const v of group.instances) {
      const blockEl = getBlockDom(v.blockId)
        || document.querySelector(`[data-block-id="${v.blockId}"]`);
      if (!blockEl) continue;
      const targets = findHighlightTargetsInBlock(blockEl, v.match);
      for (const t of targets) {
        try {
          const range = document.createRange();
          range.setStart(t.textNode, t.startOffset);
          range.setEnd(t.textNode, t.startOffset + t.length);
          ranges.push(range);
          if (!firstRange) firstRange = range;
        } catch { /* invalid range — skip */ }
      }
    }
    if (ranges.length > 0) {
      CSS.highlights.set('compliance-active', new Highlight(...ranges));
      if (triggerScroll && firstRange && typeof firstRange.getBoundingClientRect === 'function') {
        const rect = firstRange.getBoundingClientRect();
        if (rect && (rect.top || rect.bottom)) {
          window.scrollTo({
            top: window.scrollY + rect.top - window.innerHeight / 2,
            behavior: 'smooth',
          });
        }
      }
    } else {
      clear();
    }
    return clear;
  }, [complianceOpen, complianceState.activeGroup, complianceState.result, blocks]);

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
    const yStore = activeYStoreRef.current;
    if (yStore) setBlockHtml(yStore, blockId, fixedText);
    setBlocks(prev => prev.map(b => b.id === blockId ? { ...b, html: fixedText } : b));
  }, []);

  const handleComplianceAcceptGroup = useCallback((fixesByBlock, label) => {
    resumeHistory();
    const yStore = activeYStoreRef.current;
    if (yStore) {
      for (const [bid, html] of fixesByBlock) {
        if (typeof html === 'string') setBlockHtml(yStore, bid, html);
      }
    }
    setBlocks(prev => prev.map(b => {
      const fix = fixesByBlock.get(b.id);
      return fix ? { ...b, html: fix } : b;
    }));
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
    // Reset the local substrate to mirror the restored blocks so the binder
    // serves the auto-saved html, not the freshly-seeded INITIAL_BLOCKS.
    resetBlockArray(localSubstrate.ydoc, localSubstrate.yOrder, localSubstrate.yStore, saved.blocks);
    setBlocks(saved.blocks);
    if (saved.sectionMeta) setSectionMeta(saved.sectionMeta);
    setFileName(saved.fileName);
    if (saved.comments && Array.isArray(saved.comments)) {
      const obj = {};
      for (const c of saved.comments) obj[c.id] = c;
      const normalized = cm.normalizeForLoad(obj);
      const byId = new Map();
      for (const c of Object.values(normalized)) byId.set(c.id, c);
      // Local-only restore: seenRemoteIds stays empty so a future room join
      // treats these as preserved local drafts (mergeRemote's M2.5 rule).
      setCommentsState({ byId, seenRemoteIds: new Set() });
    }
    setIsDirty(false);
    // Restored state has no attached file handle — force a prompt on
    // the next Ctrl+S so it cannot land on an unrelated file.
    fileHandleRef.current = null;
    commentsHandleRef.current = null;
  }, [inRoom, localSubstrate]);

  // ── Collab session ──
  // useCollabSession owns: session creation/teardown, the four publish
  // effects (blocks, meta, TC, comments dispatch), echo/ready/seq guard
  // refs, the doc-size cap latch + toasts, and cursor broadcast. App
  // supplies remote-event callbacks that drive React state.
  //
  // markTcSeqApplied protocol: when a remote TC payload arrives, App's
  // setTcState updater computes `next.publishSeq` (which does NOT advance
  // for applyRemote) and calls collab.markTcSeqApplied(next.publishSeq)
  // so the publish effect treats the local state as already-seen by
  // peers. Any user-driven verb subsequently bumps publishSeq past the
  // gate and a publish fires.
  const collab = useCollabSession({
    inRoom,
    roomId,
    identity,
    authToken,
    getTokenFn: getToken,

    blocks,
    sectionMeta,
    fileName,
    tcState,
    getPublishableTc: tc.getPublishableState,

    getInitialBlocks: useCallback(() => blocksRef.current, []),
    getInitialMeta: useCallback(() => ({ ...sectionMetaRef.current, fileName }), [fileName]),

    onBlocksReceived: useCallback((nextBlocks /* , meta */) => {
      // Preserve caret — and any non-collapsed selection — across a
      // remote-triggered DOM rewrite. Capturing both endpoints lets a
      // user who was mid-replacement keep their selection when a remote
      // peer's edit lands in the middle of their action. Cross-block
      // selection restore is out of scope for the prototype.
      const activeEl = document.activeElement;
      let caret = null;
      // Sub-PR 1e (#47): PM-owned blocks manage their own selection via
      // y-prosemirror's RelPos plugin. Manual Range placement on PM's DOM
      // fights its cursor model and gets clobbered on the next dispatch.
      // Skip the legacy stash/restore for PM blocks (the binding's relpos
      // mapping survives Y.XmlFragment updates without our help).
      const isPmEl = activeEl?.getAttribute?.('data-pm-editor') === 'true';
      if (!isPmEl && activeEl?.dataset?.blockId && activeEl.contentEditable === 'true') {
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
          // Sub-PR 1e (#47, v2 plan Q17/E4). Was a direct querySelector;
          // now goes through the registry. Re-check the resolved element
          // for `data-pm-editor` — if the block re-mounted as a PM block
          // between stash and restore, leave its selection alone.
          const el = getBlockEditable(caret.blockId);
          if (!el) return;
          if (el.getAttribute?.('data-pm-editor') === 'true') return;
          restorePlainTextOffset(el, caret.startOffset, caret.endOffset);
        });
      }
    }, [setBlocks]),

    onMetaReceived: useCallback((remote) => {
      if (!remote || typeof remote !== 'object') return;
      setSectionMeta((prev) => ({ ...prev, ...remote }));
      if (remote.fileName) setFileName(remote.fileName);
      if ('locked' in remote) setRoomLocked(!!remote.locked);
      if ('lockedBy' in remote) setRoomLockedBy(remote.lockedBy || null);
      if ('lockedByName' in remote) setRoomLockedByName(remote.lockedByName || null);
    }, []),

    onTcReceived: useCallback((payload) => {
      setTcState(prev => {
        const next = tc.applyRemote(prev, payload);
        // Tell the hook this seq matches what peers already have, so the
        // publish effect won't echo on the next render.
        collabRef.current?.markTcSeqApplied(next.publishSeq);
        return next;
      });
    }, [setTcState]),

    onCommentsReceived: useCallback((commentsObj) => {
      const normalized = cm.normalizeForLoad(commentsObj || {});
      setCommentsState(prev => cm.mergeRemote(prev, normalized));
    }, []),

    onPresenceChange: useCallback((states) => setPeers(states), []),

    onStatusChange: useCallback((status, meta) => {
      setCollabStatus(status);
      setReconnectIn(meta?.reconnectIn ?? 0);
    }, []),

    pushToast: useCallback((toast) => toastPushRef.current?.(toast), []),
  });
  collabRef.current = collab;

  // The active substrate for EditableBlock's binder. Session yStore wins
  // when in a room; the local Y.Doc is the substrate for single-user mode.
  // Reference identity flips on room transitions, which the binder hook's
  // subscribe deps watch — it tears down the old subscription and attaches
  // to the new yStore in one render cycle.
  const activeYStore = inRoom ? collab.yStore : localSubstrate.yStore;
  // Mirror the active substrate into the ref so callbacks declared above
  // (which can't reach the const due to JS hoisting / TDZ rules) read the
  // current substrate at call time, not the initial one.
  activeYStoreRef.current = activeYStore;

  // Keyboard listener for undo/redo and search
  useEffect(() => {
    const handler = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
        e.preventDefault();
        if (!collab.tryUndo()) undo();
      } else if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) {
        e.preventDefault();
        if (!collab.tryRedo()) redo();
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
    // collab.tryUndo / tryRedo are stable (useCallback with empty deps in
    // the hook), so omitting `collab` from deps is safe — including it
    // would cause the listener to re-bind every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [undo, redo, handleSave, zoomIn, zoomOut, zoomReset]);

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
            {inRoom && isLockedByOther && (
              <div className="locked-banner">
                Locked by {roomLockedByName || 'another user'} — editing disabled
              </div>
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
                setLintingState(s => {
                  const next = linting.setEnabled(s, !s.enabled);
                  // Disabling clears findings so highlights drop immediately.
                  return next.enabled ? next : linting.clearAll(next);
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
                // Preserve scroll position across the layout shift caused by
                // tag labels appearing / disappearing. Sub-PR 1e (#47, v2
                // plan Q17/E4): block lookups go through block-registry
                // instead of querySelector. PmEditableBlock's outer wrapper
                // is what the registry hands back via getDom — it includes
                // the gutter buttons and matches the legacy <div> wrapper
                // shape, so the bounding-rect anchor logic is unchanged.
                const scroller = document.querySelector('.editor-scroll') || document.scrollingElement;
                const focused = focusedBlockId ? getBlockDom(focusedBlockId) : null;
                let anchor = focused;
                if (!anchor || anchor.getBoundingClientRect().top < 0 || anchor.getBoundingClientRect().top > window.innerHeight) {
                  // Walk in document order (not registry insertion order)
                  // so blocks inserted mid-document are visited at the
                  // right index. Insertion order would put them last.
                  for (const { dom: b } of listBlocksInDocumentOrder()) {
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
            // The track-changes module owns the "what's the new baseline?"
            // logic. enable() snapshots visible text from current blocks;
            // disable() clears snapshots. Both bump publishSeq so the
            // publish effect picks the change up.
            setTcState(prev => val
              ? tc.enable(prev, blocksRef.current)
              : tc.disable(prev));
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
          <FloatingToolbar
            editorRef={editorRef}
            onBlockUpdate={handleBlockUpdate}
            onRevisionAction={handleRevisionAction}
            onRefreshTcSnapshot={handleRefreshTcSnapshot}
            trackChanges={trackChanges}
            onCommentCreate={handleCommentCreate}
            identity={identity}
            readOnly={collabReadOnly}
          />

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
                  commentsState={commentsState}
                  activeCommentId={openCommentId}
                  onCommentClick={handleCommentClick}
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
                  onCommentClick={handleCommentClick}
                  commentsState={commentsState}
                  activeCommentId={openCommentId}
                />
              );
            }
            return (
              <div key={`${block.id}-${block.type}`}>
                <EditableBlock
                  block={block}
                  yStore={activeYStore}
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
                  snapshotText={tc.getSnapshot(tcState, block.id)}
                  identity={identity}
                  readOnly={collabReadOnly}
                  onAcceptRevision={(id) => {
                    resumeHistory();
                    let resolvedHtml = '';
                    setBlocks(prev => {
                      const idx = prev.findIndex(b => b.id === id);
                      if (idx < 0) return prev;
                      const b = prev[idx];
                      if (b.revision === 'del') return prev.filter(bl => bl.id !== id);
                      const next = [...prev];
                      const html = b.html ? acceptAllInline(b.html) : b.html;
                      resolvedHtml = html || '';
                      if (activeYStore && typeof html === 'string') setBlockHtml(activeYStore, id, html);
                      next[idx] = { ...b, revision: undefined, html };
                      return next;
                    });
                    setTcState(prev => tc.acceptInline(prev, id, resolvedHtml));
                  }}
                  onRejectRevision={(id) => {
                    resumeHistory();
                    let resolvedHtml = '';
                    setBlocks(prev => {
                      const idx = prev.findIndex(b => b.id === id);
                      if (idx < 0) return prev;
                      const b = prev[idx];
                      if (b.revision === 'add') return prev.filter(bl => bl.id !== id);
                      const next = [...prev];
                      const html = b.html ? rejectAllInline(b.html) : b.html;
                      resolvedHtml = html || '';
                      if (activeYStore && typeof html === 'string') setBlockHtml(activeYStore, id, html);
                      next[idx] = { ...b, revision: undefined, html };
                      return next;
                    });
                    setTcState(prev => tc.rejectInline(prev, id, resolvedHtml));
                  }}
                  onRevisionAction={handleRevisionAction}
                  commentsState={commentsState}
                  onCommentClick={handleCommentClick}
                  onInlineFix={handleComplianceAcceptFix}
                  lintingState={lintingState}
                  lintingDispatch={setLintingState}
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
            complianceState={complianceState}
            dispatchCompliance={setComplianceState}
            onAcceptFix={handleComplianceAcceptFix}
            onAcceptGroupFix={handleComplianceAcceptGroup}
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
            onLockRoom={async (roomId, locked) => {
              try {
                const token = sessionStorage.getItem('sim-auth-token');
                const headers = { 'Content-Type': 'application/json', ...authHeaders };
                if (token && !headers['Authorization']) headers['Authorization'] = `Bearer ${token}`;
                await fetch(`${COLLAB_HTTP_URL}/rooms/${roomId}`, {
                  method: 'PATCH',
                  headers,
                  body: JSON.stringify({ locked, lockedBy: locked ? identity?.id : null, lockedByName: locked ? identity?.name : null }),
                });
              } catch (err) {
                console.warn('Lock room failed:', err.message);
              }
            }}
            onRenameRoom={async (roomId, displayName) => {
              try {
                const token = sessionStorage.getItem('sim-auth-token');
                const headers = { 'Content-Type': 'application/json', ...authHeaders };
                if (token && !headers['Authorization']) headers['Authorization'] = `Bearer ${token}`;
                const res = await fetch(`${COLLAB_HTTP_URL}/rooms/${roomId}`, {
                  method: 'PATCH',
                  headers,
                  body: JSON.stringify({ displayName }),
                });
                if (res.ok) {
                  setRoomList(prev => prev.map(r => r.id === roomId ? { ...r, displayName } : r));
                }
              } catch (err) {
                console.warn('Rename room failed:', err.message);
              }
            }}
            currentUserId={identity?.id}
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
