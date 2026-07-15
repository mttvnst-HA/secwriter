import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import { FileText, Search, Upload, Download, Check, Loader, Users } from "lucide-react";
import TreeNode from "./components/TreeNode.jsx";
// MarkLegend component preserved for future user manual documentation (removed from toolbar UI)
import PmEditableBlock from "./components/PmEditableBlock.jsx";
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
import SearchBar from "./components/SearchBar.jsx";
import BracketReplace from "./components/BracketReplace.jsx";
import ValidationPanel from "./components/ValidationPanel.jsx";
import RefWizard from "./components/RefWizard.jsx";
import CommentPopup, { getAuthorName, captureCommentRects, shouldShowCommentPopup } from "./components/CommentPopup.jsx";
import CompliancePanel from "./components/CompliancePanel.jsx";
import { compileRegister, generateRegisterReport } from "./lib/submittal-register.js";
import { generateExportHtml } from "./lib/doc-export.js";
import { autoSave, loadAutoSave, clearAutoSave, getAutoSaveTimestamp } from "./lib/auto-save.js";
import { CURRENT_FILE_INITIAL, getDisplayName } from "./lib/current-file.js";
import { buildTree } from "./lib/tree-builder.js";
import { generateCommentReport } from "./lib/comment-report.js";
import { parseSEC } from "./lib/sec-parser.js";
import * as Y from "yjs";
import { seedBlockArray, resetBlockArray, setBlockHtmlSilent, getBlockHtml } from "./lib/block-html-store.js";
import { focusBlockById, getBlockEditable, getBlockDom, getBlockView, listBlocksInDocumentOrder, getContextAtCoordsById, cancelPendingUpdateById, flushPendingUpdateById, flushAllPendingUpdates } from "./lib/block-registry.js";
import { setActiveComment } from "./lib/pm-plugins/active-comment.js";
import ContextMenu from "./components/ContextMenu.jsx";
import { buildContextMenuItems, tableCellCoordsFromTd } from "./lib/context-menu-items.js";
import { applyInlineRevisionResolveTr, dispatchToolbarVerb, extractHtml, extractRangeText } from "./lib/pm-toolbar.js";
import { sanitizePasteText } from "./lib/paste-sanitize.js";
import { pmFragmentToHtml } from "./lib/pmdoc-html.js";
import { insertRowAt, insertColumnAt, deleteRow, deleteColumn, mergeCellRight, splitCell } from "./lib/table-ops.js";
import { Selection, TextSelection } from "prosemirror-state";
import * as tc from "./lib/track-changes.js";
import * as Blocks from "./lib/blocks.js";
import * as linting from "./lib/linting.js";
import { encodeSidecar, decodeSidecar, decodeSidecarV2, projectDecoded, fingerprintBlock } from "./lib/lint-sidecar.js";
import INITIAL_BLOCKS from "./data/sample-31-00-00.json";
import { getRoomFromUrl, buildRoomUrl, stripRoomFromUrl, generateRoomId, DEFAULT_HTTP_URL, applyBlocksToYDoc, yBlocksToArray } from "./lib/collab.js";
import { useCollabSession } from "./hooks/useCollabSession.js";
import { useBlockActions } from "./hooks/useBlockActions.js";
import { useFileSession } from "./hooks/useFileSession.js";
import { useComments } from "./hooks/useComments.js";
import { useCompliancePanel } from "./hooks/useCompliancePanel.js";
import { useLocalSubstrateUndoManager } from "./hooks/useLocalSubstrateUndoManager.js";
import * as cm from "./lib/comments.js";
import { loadIdentity } from "./lib/identity.js";
import { getToken, onTokenRefresh, getAuthMode, signOut as authSignOut, getIdentity } from './lib/auth-client.js';
import IdentityModal from "./components/IdentityModal.jsx";
import RoomPanel from "./components/RoomPanel.jsx";
import PresenceBar from "./components/PresenceBar.jsx";
import RemoteCursors from "./components/RemoteCursors.jsx";
import ConnectionBanner from "./components/ConnectionBanner.jsx";
import ToastStack, { useToasts } from "./components/Toast.jsx";
import ConvertBlockPalette from "./components/ConvertBlockPalette.jsx";

const COLLAB_HTTP_URL = DEFAULT_HTTP_URL;

// Walk text nodes under `root` to compute the plain-text offset of
// (node, offset). Used to transport a caret position across a DOM rewrite
// caused by a remote collab update.
//
// 1i-b.2 — post-PM-only world, the only surface that still needs this is
// TitleBlock's contentEditable title span (TitleBlock isn't a PM
// EditorView). PM-mounted blocks short-circuit via the `data-pm-editor`
// gate in onBlocksReceived and let y-prosemirror's relpos plugin own
// selection management. Ref/table contentEditable inputs live on inner
// elements that don't carry `data-block-id` so the gate also skips them.
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
  // 1i-b.2 — blocks state migrates to plain React useState. The Yjs
  // UndoManager (collab.undoManager in-room, localUndo.undoStack out-of-
  // room) is now the only undo source. `setBlocksDirect` and `setBlocks`
  // converge — both are plain React setters now; the "direct vs undoable"
  // distinction died with the snapshot stack.
  const [blocks, setBlocks] = useState(INITIAL_BLOCKS);
  const setBlocksDirect = setBlocks;
  // `clearHistory` is defined here as a stable wrapper that delegates to
  // `clearHistoryRef.current()` at call time. The ref is populated by an
  // effect below (after `useCollabSession` is in scope) so the wrapper
  // points to a function that clears both UndoManagers. This is the
  // standard React idiom for "I need to call X from a callback declared
  // earlier than X exists" — the same pattern App uses for
  // `activeYStoreRef` and `onUpdateRef` inside PmEditableBlock.
  const clearHistoryRef = useRef(() => {});
  const clearHistory = useCallback(() => clearHistoryRef.current(), []);
  // Post-1h Q35+Q37 the TC reducer is `{ enabled, publishSeq }` and the
  // publishSeq counter handles echo-gating. Accepted regression: a
  // Ctrl+Z crossing a TC enable/disable boundary no longer rolls back
  // the toggle (it's an explicit user gesture, never a typing-frame
  // mutation).
  const [tcState, setTcState] = useState(() => tc.createInitial());
  // Local Y.Doc — the no-room substrate for block html. PmEditableBlock's
  // ySyncPlugin binds to this when !inRoom. In-room mode, the session's
  // Y.Doc takes over; the local substrate stays allocated but dormant.
  // See ADR-0004 (#22 sub-PR 1b).
  const [localSubstrate] = useState(() => {
    const ydoc = new Y.Doc();
    const yOrder = ydoc.getArray('order');
    const yStore = ydoc.getMap('store');
    seedBlockArray(ydoc, yOrder, yStore, INITIAL_BLOCKS);
    return { ydoc, yOrder, yStore };
  });
  // Sub-PR 1h Q36 Commit B — out-of-room Yjs UndoManager. Mirrors the
  // in-room collab session's UndoManager config (`'local-publish'` +
  // `ySyncPluginKey`, captureTimeout 500ms). App's Ctrl+Z handler routes
  // to this when there's no collab session, so PM-mode typing-grain undo
  // works identically in and out of rooms.
  const localUndo = useLocalSubstrateUndoManager(localSubstrate);
  // Ref to the active substrate's yStore so callbacks declared before the
  // useCollabSession call (which is where the session yStore comes from)
  // can still reach it without a temporal-dead-zone reference. Updated
  // below after `activeYStore` is computed.
  const activeYStoreRef = useRef(localSubstrate.yStore);
  // Mirror of the active undo-framing target (in-room collab vs out-of-room
  // localUndo), assigned each render at the same site as activeYStoreRef.current
  // (below). useBlockActions reads framingRef.current at action-call time —
  // same call-time discipline as activeYStoreRef.
  const framingRef = useRef(null);
  const trackChanges = tc.isEnabled(tcState);
  const [selectedTreeId, setSelectedTreeId] = useState(null);
  const [focusedBlockId, setFocusedBlockId] = useState(null);
  // Current-file record — bundles SEC handle/fallbackName + sidecar handle so
  // cross-file loads can swap the whole record atomically (see CONTEXT.md
  // "Local file"). `displayName` is derived via getDisplayName at use sites.
  const [currentFile, setCurrentFile] = useState(CURRENT_FILE_INITIAL);
  const [tailorActive, setTailorActive] = useState(false);
  const [tailorProfile, setTailorProfile] = useState({ branch: null, region: null, deliveryMethod: null });
  const [tailorShowAll, setTailorShowAll] = useState(false);
  const [showRevisions, setShowRevisions] = useState(true);
  const [showNotes, setShowNotes] = useState(true);
  // Block ids exempted from `.notes-hidden .block-type-note { display: none }`
  // — see revealConvertedNote below. Cleared on an explicit "hide notes" toggle.
  const [revealedNoteIds, setRevealedNoteIds] = useState(() => new Set());
  const [unitDisplay, setUnitDisplay] = useState('both'); // 'both' | 'eng' | 'met'
  const [showTags, setShowTags] = useState(false); // default OFF — inline marks hidden
  const [darkMode, setDarkMode] = useState(() => {
    try { return localStorage.getItem('sim-dark-mode') === 'true'; } catch { return false; }
  });
  const [sidebarSearch, setSidebarSearch] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [convertPalette, setConvertPalette] = useState(null);
  // { blockId, currentType, anchorRect, savedSelection } | null
  // Right-click context menu (Task 9). { items, anchor:{x,y}, ctx } | null
  const [contextMenu, setContextMenu] = useState(null);
  const editorScrollRef = useRef(null);
  const [bracketOpen, setBracketOpen] = useState(false);
  const [validationOpen, setValidationOpen] = useState(false);
  const [refWizardOpen, setRefWizardOpen] = useState(false);
  // Comment interaction state + handlers + effects live in useComments
  // (architecture-review candidate #1, "review surfaces" slice). The hook owns
  // commentsState / openCommentId / commentRect / commentRects /
  // showCommentSpans; the call site is below (after dispatchComment +
  // effectiveIdentity, which it consumes). The comments PANEL toggle
  // `showComments` is a right-rail layout concern (mutually exclusive with the
  // compliance panel) and stays here.
  const [showComments, setShowComments] = useState(false);
  // Compliance panel intent (architecture-review candidate #1, slice 4a).
  // Owns complianceOpen + complianceState + the compliance-active highlight
  // effect. Lint stays in App (collab-published custodian state — separate
  // slice). See useCompliancePanel.js header.
  const {
    complianceOpen,
    setComplianceOpen,
    complianceState,
    setComplianceState,
  } = useCompliancePanel({ blocks });
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
  // Mirror inRoom into a ref so callbacks declared before `collab`
  // (search this file for `const collab =`, declared much further down)
  // can read the current value at invocation time. Including `inRoom`
  // directly in those callbacks' deps arrays would trigger TDZ when
  // `collab` is referenced.
  // 1h Q36 Commit C — read by `framingForHandler()` (declared after
  // `const collab` below) to pick collab vs localUndo for forceFrame/
  // withUndoFrame at click-driven undo sites.
  const inRoomRef = useRef(inRoom);
  inRoomRef.current = inRoom;
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
  // #239: server-assigned auth scope ('readonly' for a viewer role, else
  // 'read-write'). The server already rejects a viewer's ops at the WS layer;
  // this drives the read-only editor UX (disabled edits + banner). Null until
  // the provider's 'authenticated' event fires (auth=none never fires it →
  // stays null → read-write). roomId is fixed for the page lifetime, so this
  // resets naturally on navigation; isViewerScope is gated on inRoom anyway.
  const [collabScope, setCollabScope] = useState(null);
  const isViewerScope = inRoom && collabScope === 'readonly';
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
  ) || isLockedByOther || isViewerScope;
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

  const editorRef = useRef(null);
  // fileInputRef, the drag-over state, and the lint-companion staging ref now
  // live inside useFileSession's file-input I/O shell (candidate #1 slice 2).
  const blocksRef = useRef(blocks);
  blocksRef.current = blocks;
  const focusedBlockIdRef = useRef(focusedBlockId);
  focusedBlockIdRef.current = focusedBlockId;
  const collabReadOnlyRef = useRef(collabReadOnly);
  collabReadOnlyRef.current = collabReadOnly;
  const sectionMetaRef = useRef(sectionMeta);
  sectionMetaRef.current = sectionMeta;
  const tcStateRef = useRef(tcState);
  tcStateRef.current = tcState;
  const lintingStateRef = useRef(lintingState);
  useEffect(() => { lintingStateRef.current = lintingState; }, [lintingState]);
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
  // forcing PmEditableBlock to re-render with resolved HTML
  const tailorKey = useMemo(() => {
    if (!tailorActive || !tailorProfile.branch) return null;
    return `${tailorProfile.branch}-${tailorProfile.region || ''}-${tailorProfile.deliveryMethod || ''}-${tailorShowAll}`;
  }, [tailorActive, tailorProfile, tailorShowAll]);

  // Resolve TAI visibility in HTML based on current tailoring profile
  const resolveHtml = useCallback((html) => {
    if (!tailorActive || !tailorProfile.branch) return html;
    return resolveTaiInHtml(html, tailorProfile, tailorShowAll);
  }, [tailorActive, tailorProfile, tailorShowAll]);

  // Load lint sidecar payload (parsed JSON) into the linting reducer (#138).
  // Called from the .SEC import path when a `.lint.json` companion is
  // available (e.g. via the multi-file drag-drop). Async because
  // fingerprinting goes through Web Crypto.
  const applyLintSidecarPayload = useCallback(async (rawJson, freshBlocks) => {
    if (typeof rawJson !== 'string' || rawJson.length === 0) return;
    let parsedJson;
    try { parsedJson = JSON.parse(rawJson); }
    catch { return; }
    const decoded = decodeSidecarV2(parsedJson);
    if (decoded.fingerprints.size === 0) return;
    const projection = await projectDecoded(decoded, freshBlocks);
    if (projection.size === 0) return;
    setLintingState(s => linting.prefillFromSidecar(s, projection));
    // File-mode only: prefill ignored/muted state from sidecar v2 payload.
    // In collab mode, yLintIgnored is the authoritative source.
    if (!inRoomRef.current) {
      if ((decoded.ignoredFindings?.length ?? 0) > 0 || (decoded.mutedNlpRules?.length ?? 0) > 0) {
        setLintingState(s => linting.prefillIgnored(s, {
          findings: decoded.ignoredFindings || [],
          mutedRules: decoded.mutedNlpRules || [],
        }));
      }
    }
  }, []);

  // Comment dispatcher — thin wrapper that routes a PublishEnvelope to the
  // collab session via the useCollabSession hook (set up further below).
  // collabRef defers the call so this useCallback can be defined before the
  // hook returns; collab.dispatchComment is itself idempotent when not in a room.
  const dispatchComment = useCallback((envelope) => {
    collabRef.current?.dispatchComment(envelope);
  }, []);

  const effectiveIdentity = useCallback(() => (
    identity || { id: 'local', name: getAuthorName() || 'User', color: '#888' }
  ), [identity]);

  // Comment interaction — state + handlers + effects (active-highlight,
  // reconcile, span-persist, rect-capture) — live in useComments
  // (architecture-review candidate #1, "review surfaces" slice). Owns
  // commentsState / openCommentId / commentRect / commentRects / showCommentSpans;
  // consumes the App-owned dispatchComment + effectiveIdentity seams and the
  // blocks setter. Declared here (before the SEC-import + useFileSession calls)
  // because loadSECContent drives setCommentsState and useFileSession reads
  // `comments`. setCommentsState / setOpenCommentId are also driven by a few
  // non-comment sites (collab inbound, file load, block-type flip).
  const {
    commentsState, setCommentsState, commentsStateRef, comments,
    openCommentId, setOpenCommentId, commentRect, setCommentRect,
    commentRects, setCommentRects,
    showCommentSpans, setShowCommentSpans,
    handleCommentCreate, handleCommentUpdateCreate, handleCommentReply,
    handleCommentResolve, handleCommentReopen, handleCommentDelete,
    handleCommentClick,
  } = useComments({ setBlocks, dispatchComment, effectiveIdentity });

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

  const loadSECContent = useCallback((content, name, pendingLint = null) => {
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
      // Atomic record swap — drops stale FSA handles in the same update so
      // Ctrl+S cannot silently overwrite the previous file with the newly
      // loaded content.
      setCurrentFile({
        sec: { handle: null, fallbackName: name },
        sidecar: { handle: null },
        lintSidecar: { handle: null },
      });
      setSectionMeta(extractMetadata(content));
      setSelectedTreeId(null);
      setFocusedBlockId(null);
      // In a room, yComments is the authoritative source — do not wipe shared
      // comment state on a local file import.
      if (!inRoom) setCommentsState(cm.createInitial());
      // Drop any localStorage auto-save from the previous file so a future
      // mount-time restore cannot resurrect it over a freshly-loaded file.
      clearAutoSave();
      // Reset the in-memory lint cache for the new file. Then, if the
      // drag-drop handler staged a `.lint.json` companion (#138) — forwarded
      // by useFileSession's import shell as the third arg — feed it into
      // prefillFromSidecar against the freshly-parsed blocks.
      setLintingState(s => linting.clearAll(s));
      if (pendingLint) {
        // Fire-and-forget — fingerprinting is async; the next render shows
        // findings as soon as projection resolves.
        applyLintSidecarPayload(pendingLint, parsed);
      }
    } catch (err) {
      alert(`Failed to parse SEC file: ${err.message}`);
    }
  }, [extractMetadata, clearHistory, inRoom, localSubstrate, applyLintSidecarPayload]);

  // The file-INPUT I/O shell (drag-drop parsing, FileReaders, windows-1252
  // decode, lint-companion staging) lives in useFileSession — candidate #1
  // slice 2. It reads files and calls back into loadSECContent (wired as
  // onFileLoaded below); loadSECContent stays here because it resets document
  // state. See the useFileSession destructure below for the returned handlers.

  // File-session I/O lives in useFileSession — architecture-review candidate
  // #1, slices 1 (output) + 2 (input shell). App still owns currentFile /
  // saveStatus / isDirty and the document-reset loadSECContent (passed as
  // onFileLoaded); the hook consumes them + the setters it drives. The output
  // helpers (handleExport / doFileSave / sidecar savers) and the input helper
  // (handleFileImport) are internal to the hook.
  const {
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
  } = useFileSession({
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
    onFileLoaded: loadSECContent,
  });

  // Programmatic focus for EXISTING elements (arrow nav, tree select, delete-focus-prev).
  // New blocks focus themselves from their own mount effect (see
  // PmEditableBlock's `block.isNew` auto-focus and TitleBlock's mount).
  //
  // Sub-PR 1e (#47, v2 plan Q17/E4). Was: querySelector('[data-block-id=…]')
  // + manual Range placement. Now goes through block-registry's imperative
  // handle so PM-mounted blocks (which own their internal DOM and don't
  // surface a single contentEditable) can route the focus to PM's
  // EditorView.dispatch + Selection.atEnd.
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
      const el = document.querySelector(/* allowed: block-registry fallback */ `[data-block-id="${id}"]`);
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

  // The block-action surface (src/hooks/useBlockActions.js). Reads yStore +
  // framing from refs at call time, so it can be declared here — before every
  // handler / JSX callsite that references `blockActions` — without a TDZ on
  // framingForHandler (defined further below).
  const blockActions = useBlockActions({
    blocksRef,
    setBlocks,
    yStoreRef: activeYStoreRef,
    framingRef,
    setFocusedBlockId,
    focusBlock,
    tcStateRef,
  });

  // Resolve a blockHash for dismiss-from-Compliance gestures. Prefers the
  // cache in `lintingState.byBlock` (populated by useBlockLinting on focus)
  // but falls back to computing it from the block's html. Used by
  // CompliancePanel's per-item and group Dismiss handlers — the Compliance
  // scan can find violations in blocks the user has never focused, so
  // requiring a cached hash would silently no-op those dismissals.
  const resolveBlockHashForDismiss = useCallback(async (blockId) => {
    const cached = lintingState?.byBlock?.get(blockId)?.blockHash;
    if (cached) return cached;
    const block = blocksRef.current.find(b => b.id === blockId);
    if (!block) return null;
    try {
      return await fingerprintBlock(block.html || '');
    } catch {
      return null;
    }
  }, [lintingState]);

  // Comment effects (candidate #1 "review surfaces" slice) — these stay in App
  // at their ORIGINAL declaration positions, reading state from useComments.
  // They are effect-order-sensitive (CLAUDE.md Rule #12): moving them into the
  // hook, which is called early (before useFileSession), reordered them ahead of
  // App's other effects and raced the #195 all-popups rect capture. See
  // useComments' header for the full rationale.

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
  //
  // 1i-b.1: substrate mirror uses setBlockHtmlSilent (origin 'local-reconcile')
  // instead of setBlockHtml — the mirror still broadcasts to peers, but the
  // local UndoManager does NOT capture it. Without this gate, Ctrl+Z after a
  // reconcile fires would undo the reconcile (which then re-fires on the
  // next render) rather than the user's action.
  //
  // 1i-b.1: uniform reconcile walk. Pre-1i.b.1 we skipped PM-mounted blocks
  // because reconcileCommentMarks in PmEditableBlock handles those at the
  // PM substrate level — and the html-walk's substrate mirror would have
  // entered local undo. Now that the mirror uses setBlockHtmlSilent (origin
  // 'local-reconcile', non-tracked), the worst case for PM-mounted blocks
  // is a redundant write that PM's domObserver swallows as a no-op. The
  // simpler uniform walk wins.
  useEffect(() => {
    setBlocksDirect(prev => {
      const next = cm.reconcileBlocks(prev, commentsState);
      const yStore = activeYStoreRef.current;
      if (next !== prev && yStore) {
        for (const b of next) {
          if (typeof b.html !== 'string') continue;
          const before = prev.find(p => p.id === b.id);
          if (before && before.html !== b.html) setBlockHtmlSilent(yStore, b.id, b.html);
        }
      }
      return next;
    });
  }, [blocks, commentsState, setBlocksDirect]);

  // 1f.7 (#47) — DEV-only Playwright test utilities. The legacy contentEditable
  // path let tests do `el.innerHTML = '...'; el.dispatchEvent('input')` because
  // the DOM was the source of truth. The PM path's source of truth is the Y
  // substrate / PM doc — a direct DOM write is overwritten by the next render
  // cycle, and reading `el.innerHTML` produces PM-wrapped shape (e.g.
  // `<p>text</p>` instead of `text`). These helpers route through App's normal
  // block update path so E2E tests work identically in both modes. Tests use
  // them via `tests/e2e/pm-helpers.js`. Never exposed in production builds.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    if (typeof window === 'undefined') return;
    window.__simEditorTestUtils = {
      getBlockHtml: (id) => {
        const b = blocksRef.current.find((x) => x.id === id);
        return b ? b.html : null;
      },
      // Route through blockActions.updateHtml (also called by
      // MarkSuggestions). Writes substrate via setBlockHtml + setBlocks,
      // and ySyncPlugin observes the substrate write and re-renders the
      // PM view — so the test sees its html land on the EditorView,
      // not just in React state.
      setBlockHtml: (id, html) => { blockActions.updateHtml(id, html); },
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
      // #116 — collapsed-caret variant supporting 'start' | 'end' | number.
      // The 'end' sentinel resolves to Selection.atEnd at dispatch time so
      // callers don't need to know the block's text length; this is the
      // dispatch-synchronous equivalent of keyboard.press('End') without
      // PM's async domObserver settle.
      setPmCaret: (id, position) => {
        const view = getBlockView(id);
        if (!view) return false;
        try {
          let sel;
          if (position === 'start') {
            sel = Selection.atStart(view.state.doc);
          } else if (position === 'end') {
            sel = Selection.atEnd(view.state.doc);
          } else if (typeof position === 'number') {
            sel = TextSelection.create(view.state.doc, position, position);
          } else {
            return false;
          }
          view.dispatch(view.state.tr.setSelection(sel));
          view.focus();
          return true;
        } catch { return false; }
      },
      // #140 — persistent rule ignores test seam.
      getIgnoredKeys: () => {
        const out = [];
        lintingStateRef.current.ignored.findings.forEach((entry, key) => {
          if (entry.tombstone !== true) out.push(key);
        });
        return out;
      },
      getBlockHash: (blockId) => {
        // Exposes the cached per-block fingerprint so E2E tests (Task 26) can
        // construct an ignoreKey envelope without round-tripping through the DOM.
        return lintingStateRef.current.byBlock.get(blockId)?.blockHash || null;
      },
      getMutedRuleIds: () => {
        // Returns active (non-tombstoned) muted NLP rule IDs. Used by Task 24
        // E2E test to verify mute-nlp + reset state without relying on CSS
        // Custom Highlights (which require actual linted content to be non-empty).
        const out = [];
        lintingStateRef.current.ignored.mutedRules.forEach((entry, ruleId) => {
          if (entry.tombstone !== true) out.push(ruleId);
        });
        return out;
      },
      isFindingIgnored: (ruleId, blockHash, match) => {
        // Async — returns a Promise from test land.
        return linting.computeIgnoreKey(ruleId, blockHash, match)
          .then(key => linting.isFindingIgnored(lintingStateRef.current, key));
      },
      getLintingFindings: (blockId) => {
        // Returns all findings (compliance + nlp + grammar) for a block, or
        // null if the block has no byBlock entry yet (not yet linted / cleared).
        // Used by E2E tests to verify lint-clear-on-conversion without relying
        // on CSS.highlights (Custom Highlight API is not queryable via DOM selectors).
        const entry = lintingStateRef.current.byBlock.get(blockId);
        if (!entry) return null;
        return {
          compliance: (entry.compliance || []).map(f => f.violation?.ruleId).filter(Boolean),
          nlp: (entry.nlp || []).map(f => f.violation?.ruleId).filter(Boolean),
          grammar: (entry.grammar || []).map(f => f.violation?.ruleId).filter(Boolean),
        };
      },
      dispatchLintIgnore: (envelope) => {
        if (!envelope || typeof envelope !== 'object') return;
        const ts = typeof envelope.ts === 'number' ? envelope.ts : Date.now();
        const identity = envelope.identity || effectiveIdentity();
        switch (envelope.kind) {
          case 'ignore':
            linting.computeIgnoreKey(envelope.ruleId, envelope.blockHash, envelope.match)
              .then(ignoreKey => setLintingState(s => linting.ignoreFinding(s,
                { ignoreKey, ruleId: envelope.ruleId, blockHash: envelope.blockHash, match: envelope.match, identity, ts })));
            break;
          case 'unignore':
            linting.computeIgnoreKey(envelope.ruleId, envelope.blockHash, envelope.match)
              .then(ignoreKey => setLintingState(s => linting.unignoreFinding(s, { ignoreKey, ts })));
            break;
          case 'mute-nlp':
            setLintingState(s => linting.muteNlpRule(s, { ruleId: envelope.ruleId, identity, ts }));
            break;
          case 'unmute-nlp':
            setLintingState(s => linting.unmuteNlpRule(s, { ruleId: envelope.ruleId, ts }));
            break;
          case 'reset':
            setLintingState(s => linting.resetIgnored(s, { ts }));
            break;
        }
      },
    };
    return () => { delete window.__simEditorTestUtils; };
  }, [blockActions]);

  // Delete a block and focus the previous one. The verb's focus effect
  // handles the setTimeout-queued focusBlock; nothing imperative here.
  //
  // Clears the deleted block's linting findings (#148). Under TC, deleteBlock
  // only marks the block revision='del' and the block stays in the array, so
  // clearBlock is a no-op (the byBlock entry stays valid). Once the user
  // accepts the del-revision the block is removed for real and the orphan-
  // pruning effect (below the highlight effect) cleans up byBlock for it.
  // clearBlock is idempotent (linting.clearBlock returns the same state ref
  // when the entry is absent), so dispatching it unconditionally is safe.
  const handleDelete = useCallback((blockId) => {
    blockActions.deleteBlock(blockId);
    setLintingState(s => linting.clearBlock(s, blockId));
  }, [blockActions]);

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

  // If a block is converted to a Designer Note while notes are hidden, it
  // would render under `.notes-hidden .block-type-note { display: none }`
  // and look deleted. Rather than force-showing EVERY hidden note
  // (surprising the user who deliberately hid them), track just this
  // block's id and exempt it via PmEditableBlock's `forceVisible` prop
  // (see the `.force-visible` override in editor.css). Cleared when the
  // user explicitly re-hides notes — see onShowNotesChange below.
  const revealConvertedNote = useCallback((blockId, newType) => {
    if (newType !== 'note') return;
    setRevealedNoteIds((prev) => (prev.has(blockId) ? prev : new Set(prev).add(blockId)));
  }, []);

  const handleConvertBlock = useCallback((blockId, newType) => {
    const newId = `new-${Date.now()}`;
    revealConvertedNote(newId, newType);
    blockActions.convertBlock(blockId, newType, newId);
  }, [blockActions, revealConvertedNote]);

  // Read tcState via ref to avoid recreating the handler on every TC toggle —
  // this prop is passed to every PmEditableBlock instance.
  const handleConvertBlockType = useCallback((blockId, newType) => {
    revealConvertedNote(blockId, newType);
    blockActions.convertBlockType(blockId, newType);
    setLintingState((s) => linting.clearBlock(s, blockId));
    setOpenCommentId((id) => {
      if (!id) return id;
      const c = commentsStateRef.current?.byId.get(id);
      return c?.blockId === blockId ? null : id;
    });
  }, [blockActions, revealConvertedNote]);

  // #109 M4 — preFlush='all' drains every PM block's pending 400ms onUpdate
  // debounce so the verb's compute reads post-debounce html (including any
  // revisionAdd/revisionDel marks the user just typed). The verb returns
  // framing=wrappedFrame so N substrate writes form ONE Yjs UndoManager
  // frame regardless of captureTimeout. The tcState transition stays here
  // because it's a separate reducer (`tc.acceptAll` / `tc.rejectAll`).
  const handleAcceptAll = useCallback(() => {
    blockActions.acceptAllRevisions();
    setTcState(s => tc.acceptAll(s));
  }, [blockActions]);

  const handleRejectAll = useCallback(() => {
    blockActions.rejectAllRevisions();
    setTcState(s => tc.rejectAll(s));
  }, [blockActions]);

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

  // Persist comment-span visibility preference; closing the layer also closes
  // any open comment popup so it can't float over hidden spans. (State lives in
  // useComments; this effect stays here to preserve effect-declaration order —
  // see the comment-effects note above.)
  useEffect(() => {
    try { localStorage.setItem('sim-comment-spans', String(showCommentSpans)); } catch {}
    if (!showCommentSpans) setOpenCommentId(null);
  }, [showCommentSpans]);

  // All-popups layer (#195 follow-up): while the highlight layer is ON, render a
  // popup for EVERY comment and keep them up until the layer is toggled OFF.
  // This captures each comment span's open-time rect to seed the popup position;
  // each popup self-tracks its span on scroll/resize after mount. rAF + a short
  // fallback let the comment-mark reconcile create the spans (including a
  // brand-new draft) before getBoundingClientRect is read. Re-runs only when the
  // layer flips or the set of comment ids changes.
  const commentIdsKey = [...comments.keys()].sort().join('|');
  useEffect(() => {
    if (!showCommentSpans) { setCommentRects(new Map()); return; }
    const esc = (typeof CSS !== 'undefined' && CSS.escape) ? CSS.escape : (s) => s;
    const capture = () => {
      const ids = [...commentsStateRef.current.byId.keys()];
      setCommentRects(captureCommentRects(ids, (id) => {
        const el = document.querySelector(`[data-comment-id="${esc(id)}"]`);
        return el ? el.getBoundingClientRect() : null;
      }));
    };
    const raf = requestAnimationFrame(capture);
    const t = setTimeout(capture, 80);
    return () => { cancelAnimationFrame(raf); clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showCommentSpans, commentIdsKey]);

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

  // Prune lintingState.byBlock entries whose blocks no longer exist (#148).
  // Defense in depth on top of handleDelete's explicit clearBlock and
  // useBlockLinting's per-block unmount cleanup. Covers every removal path
  // by deriving truth from the blocks array itself: handleDelete (non-TC),
  // acceptBlockRevision (revision='del'), rejectBlockRevision (revision='add'),
  // accept/rejectAllRevisionsVerb (bulk), convertBlock (ID swap), undo of
  // an insertion (Yjs-driven), and peer-driven deletion (collab session
  // onBlocksReceived). pruneOrphanedBlocks is idempotent and ref-equal on
  // no-op, so this is a zero-cost steady-state pass — the setLintingState
  // bails via Object.is when the reducer returns the same state ref.
  //
  // Deps are [blocks] only — orphans can only appear when blocks shrinks.
  // Including lintingState would fire this effect on every lint dispatch
  // (debounced typing, Harper async return, accept-fix), each one a wasted
  // Set construction. The byBlock.size === 0 fast-bail reads from the
  // closure at body-execution time, which is fresh at every blocks change.
  useEffect(() => {
    if (lintingState.byBlock.size === 0) return;
    const liveIds = new Set(blocks.map(b => b.id));
    setLintingState(s => linting.pruneOrphanedBlocks(s, liveIds));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blocks]);

  // Compliance-active highlight + scroll effect moved into useCompliancePanel
  // (slice 4a) — co-located with the complianceOpen/complianceState it reads.

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

  // Auto-save to localStorage every 3 seconds (silent, no UI).
  // Suppressed in a collab room — the server-persisted Yjs doc is the source of truth.
  useEffect(() => {
    if (inRoom) return;
    const timer = setTimeout(() => {
      flushAllPendingUpdates(); // #213 — see handleSave
      autoSave(blocksRef.current, sectionMeta, comments, getDisplayName(currentFile));
    }, 3000);
    return () => clearTimeout(timer);
    // `blocks` stays in deps to re-arm the 3s timer on every change even though
    // the body reads blocksRef.current (#213); dropping it would freeze autosave.
  }, [blocks, sectionMeta, comments, currentFile, inRoom]);

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
    // Restored state has no attached file handle — atomic swap forces the
    // next Ctrl+S to prompt so it cannot land on an unrelated file.
    setCurrentFile({
      sec: { handle: null, fallbackName: saved.fileName },
      sidecar: { handle: null },
      lintSidecar: { handle: null },
    });
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
  }, [inRoom, localSubstrate]);

  // When the user actually joins a room (identity established while in-room),
  // drop the local autosave so the server-persisted Yjs doc is the sole source
  // of truth. Mode-independent on purpose: stub auth sets identity via the
  // IdentityModal; external (JWT) / msal set it via auth-client + the
  // safety-net effect above. All routes pass through here — without this seam
  // those non-stub modes would never clear the autosave (it used to be cleared
  // in handleShare), leaving a stale local document that could later be
  // restored or written to disk. Until the user joins, the autosave survives so
  // the IdentityModal Cancel path can restore the pre-Share document.
  useEffect(() => {
    if (inRoom && identity) {
      try { clearAutoSave(); } catch { /* ignore */ }
    }
  }, [inRoom, identity]);

  // Handlers for remote ignored / muted state arriving from peers (#140).
  const handleLintIgnoredInitial = useCallback((ignoredMap) => {
    setLintingState(s => linting.mergeRemoteIgnored(s, ignoredMap));
  }, []);
  const handleLintIgnoredUpdated = useCallback((ignoredMap) => {
    // Full snapshot — apply via the same bulk merge.
    setLintingState(s => linting.mergeRemoteIgnored(s, ignoredMap));
  }, []);
  const handleLintMutedNlpInitial = useCallback((mutedMap) => {
    setLintingState(s => linting.mergeRemoteMutedRules(s, mutedMap));
  }, []);
  const handleLintMutedNlpUpdated = useCallback((mutedMap) => {
    setLintingState(s => linting.mergeRemoteMutedRules(s, mutedMap));
  }, []);

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
    fileName: getDisplayName(currentFile),
    tcState,
    lintingState,
    getPublishableTc: tc.getPublishableState,

    getInitialBlocks: useCallback(() => blocksRef.current, []),
    getInitialMeta: useCallback(
      () => ({ ...sectionMetaRef.current, fileName: getDisplayName(currentFile) }),
      [currentFile],
    ),

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
      // Remote peers don't share an FSA handle — update fallbackName so the
      // displayed name reflects the room's authoritative file name when no
      // local handle is set. If a local Save-As-in-room set sec.handle,
      // handle.name takes priority via getDisplayName.
      if (remote.fileName) {
        setCurrentFile((prev) => ({ ...prev, sec: { ...prev.sec, fallbackName: remote.fileName } }));
      }
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

    // Issue #150: remote lint cache update. Decode the v1 payload, project
    // it against the current blocks (fingerprint → blockId), and prefill
    // into the linting reducer so squiggles appear without engines running.
    onLintReceived: useCallback(async (payload) => {
      if (!payload || typeof payload !== 'object') return;
      const decoded = decodeSidecarV2(payload);
      if (decoded.fingerprints.size === 0) return;
      const projection = await projectDecoded(decoded, blocksRef.current || []);
      if (projection.size === 0) return;
      setLintingState(s => linting.prefillFromSidecar(s, projection));
    }, []),

    onLintIgnoredInitial: handleLintIgnoredInitial,
    onLintIgnoredUpdated: handleLintIgnoredUpdated,
    onLintMutedNlpInitial: handleLintMutedNlpInitial,
    onLintMutedNlpUpdated: handleLintMutedNlpUpdated,

    onPresenceChange: useCallback((states) => setPeers(states), []),

    onStatusChange: useCallback((status, meta) => {
      setCollabStatus(status);
      setReconnectIn(meta?.reconnectIn ?? 0);
    }, []),

    onAuthScope: useCallback((scope) => setCollabScope(scope || null), []),

    pushToast: useCallback((toast) => toastPushRef.current?.(toast), []),
  });
  collabRef.current = collab;

  // Picks the undo-framing source for a click-driven action: the collab
  // session's UndoManager when in a room, the local-substrate hook's when
  // out. Returns `{ forceFrame, withUndoFrame }`. Centralizes the prior
  // `(inRoomRef.current ? collab : localUndo)` pattern at 20+ call sites
  // above and the inline JSX below. Declared AFTER `const collab` so the
  // closure resolves at call time; the useCallback handlers above reach
  // it via lexical closure with no deps-array entry (same TDZ-skirting
  // pattern used for `collab` itself). `inRoom` never flips mid-session
  // (roomId is set once from URL via useState and never reassigned), so
  // `inRoomRef.current` is read once at call time and the right branch
  // is taken.
  const framingForHandler = () => (inRoomRef.current ? collab : localUndo);

  // The active substrate for PmEditableBlock's ySyncPlugin. Session yStore
  // wins when in a room; the local Y.Doc is the substrate for single-user
  // mode. Reference identity flips on room transitions, which the per-
  // block useSyncExternalStore subscription watches — it tears down the
  // old EditorView and attaches to the new yStore in one render cycle.
  const activeYStore = inRoom ? collab.yStore : localSubstrate.yStore;
  // Mirror the active substrate into the ref so callbacks declared above
  // (which can't reach the const due to JS hoisting / TDZ rules) read the
  // current substrate at call time, not the initial one.
  activeYStoreRef.current = activeYStore;
  framingRef.current = framingForHandler();

  // 1i-b.2 — populate the clearHistoryRef hoisted near the top of the
  // component. Effect re-runs whenever collab or localUndo identity
  // changes, so the wrapper always invokes the latest snapshot. App's
  // file-import handler calls clearHistory() (the stable wrapper) so
  // Ctrl+Z cannot cross the file boundary. Both UndoManagers expose
  // clearStack() per Task b2.6b; collab?.clearStack is a no-op out of
  // room and localUndo is always alive (dormant when in-room).
  useEffect(() => {
    clearHistoryRef.current = () => {
      collab?.clearStack?.();
      localUndo.clearStack();
    };
  }, [collab, localUndo]);

  // Keyboard listener for undo/redo and search.
  //
  // 1i-b.2 — two-tier undo routing. The Yjs UndoManager is the only
  // undo source post-1i-b.2 (snapshot-stack tier retired).
  //   1. collab.tryUndo()    — in-room Yjs UndoManager (no-op if no session)
  //   2. localUndo.tryUndo() — out-of-room Yjs UndoManager (always alive;
  //                            empty when in-room because all writes route
  //                            to collab.yStore, leaving localSubstrate
  //                            dormant per `activeYStore` selection)
  //
  // tryUndo returns true iff it popped a frame. Same pattern for redo.
  useEffect(() => {
    const handler = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
        e.preventDefault();
        // Two-tier: in-room Yjs UM first, out-of-room Yjs UM fallback.
        if (collab.tryUndo()) {
          // In-room: useCollabSession.onBlocksReceived bridges substrate → blocks.
        } else if (localUndo.tryUndo()) {
          // Out-of-room sync. localUndo reverts the substrate (yOrder +
          // yStore) but does NOT touch React's `blocks` state — no observer
          // bridges the gap out-of-room. PM EditorViews bound to per-block
          // Y.XmlFragments propagate THEIR undos through onUpdate, but
          // structural ops (Enter creating a block, slash-convert, delete)
          // mutate yOrder + yStore which no PM view observes. Sync blocks
          // from the substrate. In-room mode gets this for free via
          // session.onBlocksReceived.
          if (!inRoomRef.current) {
            setBlocksDirect(yBlocksToArray(localSubstrate.yOrder, localSubstrate.yStore));
          }
        }
      } else if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) {
        e.preventDefault();
        if (collab.tryRedo()) {
          // In-room: onBlocksReceived bridges substrate → blocks.
        } else if (localUndo.tryRedo()) {
          if (!inRoomRef.current) {
            setBlocksDirect(yBlocksToArray(localSubstrate.yOrder, localSubstrate.yStore));
          }
        }
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
      } else if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'M') {
        // With Shift held, e.key is the uppercase 'M' per WHATWG UI Events.
        e.preventDefault();
        const blockId = focusedBlockIdRef.current;
        if (!blockId) return;
        const focusedBlock = blocksRef.current.find(b => b.id === blockId);
        if (!focusedBlock) return;
        if (!Blocks.FAMILY_A.has(focusedBlock.type)) return;
        if (collabReadOnlyRef.current) return;
        // Capture the PM selection so we can restore the caret post-dispatch.
        const view = getBlockView(blockId);
        const savedSelection = view
          ? { from: view.state.selection.from, to: view.state.selection.to }
          : null;
        const dom = getBlockDom(blockId);
        const anchorRect = dom ? dom.getBoundingClientRect() : null;
        setConvertPalette({ blockId, currentType: focusedBlock.type, anchorRect, savedSelection });
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
    // collab.tryUndo/tryRedo are stable — useCollabSession returns
    // useCallback wrappers that read `sessionRef.current` at invocation
    // time. localUndo.tryUndo/tryRedo are stable after the Commit C
    // review fix: the hook returns a useRef-cached api object whose
    // methods read `managerRef.current` at invocation, so the M1→M2 swap
    // during the initial-mount effect doesn't strand a stale closure.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handleSave, zoomIn, zoomOut, zoomReset]);

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
    // NOTE: the autosave is intentionally NOT cleared here. It is cleared at the
    // join seam (the [inRoom, identity] effect above) so it survives the
    // Share -> name-prompt window and the IdentityModal Cancel path can restore
    // the pre-Share document.
    window.location.href = url;
    // toasts accessed via toastPushRef; intentionally omitted from deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inRoom]);

  // ─── Right-click context menu (Task 9) ────────────────────────────────
  // Resolve a context descriptor at the event's coordinates. Returns null to
  // fall through to the native browser menu (unknown host, non-editable kind,
  // mid-teardown PM view). Reads refs only, so the callback stays stable.
  const resolveContextDescriptor = useCallback((e) => {
    const target = e.target;
    if (!(target instanceof Element)) return null;
    const hostEl = target.closest('[id^="block-"]');
    if (!hostEl) return null;
    const blockId = hostEl.id.slice('block-'.length);
    const block = blocksRef.current.find((b) => b.id === blockId);
    if (!block) return null;
    const readOnly = collabReadOnlyRef.current;
    if (block.type === 'table') {
      // Header cells render <th>, body cells <td> — match either via the
      // data attributes rather than the tag name.
      const td = target.closest('[data-row][data-col]');
      const coords = tableCellCoordsFromTd(td);
      if (!coords) return null;
      const span = Number(td.getAttribute('colspan')) || 1;
      return { blockId, kind: 'table', ...coords, span, readOnly };
    }
    if (block.type === 'title' || block.type === 'ref') {
      const sel = window.getSelection();
      return { blockId, kind: block.type, selectionEmpty: !sel || sel.isCollapsed, readOnly };
    }
    if (block.type === 'pagebreak' || block.type === 'tbl') return null;
    return getContextAtCoordsById(blockId, { x: e.clientX, y: e.clientY });
  }, []);

  // Dispatch a context-menu action. `menu` is the captured contextMenu state
  // ({ items, anchor, ctx }) so the action sees the descriptor resolved at
  // open time. forceFrame closes the UndoManager capture window before each
  // mutating gesture (matches the FloatingToolbar / inline-TC pattern).
  const handleContextAction = useCallback((id, menu) => {
    const forceFrame = inRoom ? collab.forceFrame : localUndo.forceFrame;
    const blockId = menu.ctx.blockId;
    const toastInfo = (msg) => toastPushRef.current?.({ kind: 'info', title: msg, ttl: 4000 });

    switch (id) {
      case 'copy': {
        const view = getBlockView(blockId);
        let text = '';
        if (view) {
          const { from, to } = view.state.selection;
          text = view.state.doc.textBetween(from, to, '\n', '');
        } else {
          text = window.getSelection()?.toString() ?? '';
        }
        if (!text) break;
        if (!navigator.clipboard?.writeText) { toastInfo('Clipboard unavailable'); break; }
        view?.focus();
        navigator.clipboard.writeText(text).catch((err) => {
          toastInfo(err?.name === 'NotAllowedError' ? 'Clipboard permission denied' : 'Copy failed');
        });
        break;
      }
      case 'cut': {
        const view = getBlockView(blockId);
        if (!view) break;
        const { from, to } = view.state.selection;
        if (from === to) break;
        const text = view.state.doc.textBetween(from, to, '\n', '');
        if (!navigator.clipboard?.writeText) { toastInfo('Clipboard unavailable'); break; }
        view.focus();
        navigator.clipboard.writeText(text).then(() => {
          const v = getBlockView(blockId);
          if (!v) return;
          forceFrame();
          v.dispatch(v.state.tr.delete(from, to));
          cancelPendingUpdateById(blockId);
          blockActions.updateHtmlPmSync(blockId, pmFragmentToHtml(v.state.doc));
        }).catch((err) => {
          toastInfo(err?.name === 'NotAllowedError' ? 'Clipboard permission denied' : 'Cut failed');
        });
        break;
      }
      case 'paste': {
        const view = getBlockView(blockId);
        if (!view) break;
        if (!navigator.clipboard?.readText) { toastInfo('Clipboard unavailable'); break; }
        view.focus();
        navigator.clipboard.readText().then((raw) => {
          const text = sanitizePasteText(raw || '');
          if (!text) return;
          const v = getBlockView(blockId);
          if (!v) return;
          v.focus();
          forceFrame();
          v.dispatch(v.state.tr.insertText(text));
          flushPendingUpdateById(blockId);
        }).catch((err) => {
          toastInfo(err?.name === 'NotAllowedError' ? 'Clipboard permission denied' : 'Paste failed');
        });
        break;
      }
      case 'accept-change':
      case 'reject-change': {
        const view = getBlockView(blockId);
        if (!view) { toastInfo('Change no longer available'); break; }
        let coords;
        try { coords = view.posAtCoords({ left: menu.anchor.x, top: menu.anchor.y }); }
        catch { coords = null; }
        if (!coords) { toastInfo('Change no longer available'); break; }
        const action = id === 'accept-change' ? 'accept' : 'reject';
        const kindHint = menu.ctx.revision?.kind;
        const result = dispatchToolbarVerb({
          view,
          saved: { blockId },
          onForceFrame: forceFrame,
          // applyInlineRevisionResolveTr tags its tr with TC_RESOLVE_META
          // itself, for every action/kind combination.
          compute: (state) => applyInlineRevisionResolveTr(state, action, coords.pos, kindHint),
        });
        if (!result.dispatched) { toastInfo('Change no longer available'); break; }
        blockActions.updateHtmlPmSync(blockId, extractHtml(result.state));
        break;
      }
      case 'add-comment': {
        const view = getBlockView(blockId);
        const range = menu.ctx.addCommentRange;
        if (!view || !range) break;
        if (range.from < 0 || range.to > view.state.doc.content.size) { toastInfo('Selection no longer here'); break; }
        const markType = view.state.schema.marks.comment;
        if (!markType) break;
        const commentId = `comment-${Date.now()}`;
        forceFrame();
        view.dispatch(view.state.tr.addMark(range.from, range.to, markType.create({ id: commentId, resolved: false })));
        const stateAfter = view.state;
        flushPendingUpdateById(blockId);
        handleCommentCreate(blockId, extractHtml(stateAfter), commentId, extractRangeText(stateAfter, range));
        break;
      }
      case 'resolve-comment': {
        const fresh = getContextAtCoordsById(blockId, menu.anchor);
        const commentId = fresh?.comment?.commentId ?? menu.ctx.comment?.commentId;
        if (!commentId) { toastInfo('Comment no longer here'); break; }
        handleCommentResolve(commentId);
        break;
      }
      default: {
        if (!id.startsWith('table-')) break;
        const { row, col, vcol, span = 1 } = menu.ctx;
        // Persist through the SAME path TableBlock's inline editor uses:
        // onUpdate(id, { table }) → blockActions.mergeBlockData. The
        // table-ops helpers are pure and return null when the op is impossible.
        const apply = (fn) => {
          const current = blocksRef.current.find((b) => b.id === blockId)?.table;
          if (!current) return;
          const nt = fn(current);
          if (!nt) return;
          blockActions.mergeBlockData(blockId, { table: nt });
        };
        if (id === 'table-insert-row-above') apply((t) => insertRowAt(t, row));
        else if (id === 'table-insert-row-below') apply((t) => insertRowAt(t, row + 1));
        else if (id === 'table-insert-col-left') apply((t) => insertColumnAt(t, vcol));
        else if (id === 'table-insert-col-right') apply((t) => insertColumnAt(t, vcol + span));
        else if (id === 'table-delete-row') apply((t) => deleteRow(t, row));
        else if (id === 'table-delete-col') apply((t) => deleteColumn(t, vcol));
        else if (id === 'table-merge') apply((t) => mergeCellRight(t, row, col));
        else if (id === 'table-split') apply((t) => splitCell(t, row, col));
        break;
      }
    }
  }, [inRoom, collab, localUndo, blockActions, handleCommentCreate, handleCommentResolve]);

  // Singleton contextmenu listener on the editor scroll container. Suppresses
  // the native menu only when at least one non-divider item is buildable.
  useEffect(() => {
    const scroller = editorScrollRef.current;
    if (!scroller) return undefined;
    const onContextMenu = (e) => {
      const ctx = resolveContextDescriptor(e);
      if (!ctx) return;
      const items = buildContextMenuItems(ctx);
      if (!items.some((i) => !i.divider)) return;
      e.preventDefault();
      setContextMenu({ items, anchor: { x: e.clientX, y: e.clientY }, ctx });
    };
    scroller.addEventListener('contextmenu', onContextMenu);
    return () => scroller.removeEventListener('contextmenu', onContextMenu);
  }, [resolveContextDescriptor]);

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
              onReorder={blockActions.reorderSection}
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
          borderBottom: "1px solid var(--sim-border, #e2e8f0)",
          backgroundColor: "var(--sim-toolbar-bg, #ffffff)",
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
              data-priority="primary"
              style={{
                display: "flex",
                alignItems: "center",
                gap: 4,
                padding: "4px 10px",
                backgroundColor: "#2563eb",
                border: "1px solid #1d4ed8",
                borderRadius: 6,
                cursor: "pointer",
                fontSize: 13,
                fontWeight: 600,
                color: "#ffffff",
                minHeight: 32,
              }}
            >
              <Upload size={14} /> Import
            </button>
            <button
              onClick={handleSave}
              title="Save (Ctrl+S)"
              data-priority={saveStatus === null ? "primary" : undefined}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 4,
                padding: "4px 10px",
                backgroundColor: saveStatus === 'saved' ? "#d1fae5" : saveStatus === 'saving' ? "#e0f2fe" : "#2563eb",
                border: `1px solid ${saveStatus === 'saved' ? "#10b981" : saveStatus === 'saving' ? "#38bdf8" : "#1d4ed8"}`,
                borderRadius: 6,
                cursor: "pointer",
                fontSize: 13,
                fontWeight: 600,
                color: saveStatus === 'saved' ? "#047857" : saveStatus === 'saving' ? "#0369a1" : "#ffffff",
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
            {/* #239: viewer role — server rejects writes; mirror it in the UI. */}
            {isViewerScope && !isLockedByOther && (
              <div className="viewer-banner">
                View only — you have read access to this room
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
                flushAllPendingUpdates(); // #213 — drain pending PM debounce; read blocksRef.current
                const html = generateExportHtml(blocksRef.current, sectionMeta, { showNotes, unitDisplay });
                const blob = new Blob([html], { type: 'application/msword' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = getDisplayName(currentFile).replace(/\.sec$/i, '.doc');
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
                flushAllPendingUpdates(); // #213 — drain pending PM debounce; read blocksRef.current
                const html = generateExportHtml(blocksRef.current, sectionMeta, { showNotes, unitDisplay });
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
            {/* Comment-span visibility toggle (separate from the comments panel) */}
            <button
              onClick={() => setShowCommentSpans(prev => !prev)}
              title={showCommentSpans ? "Hide comment highlights" : "Show comment highlights"}
              aria-label="Toggle comment highlights"
              data-test="comment-spans-toggle"
              style={{
                padding: "4px 10px",
                backgroundColor: showCommentSpans ? "#fef9c3" : "#f1f5f9",
                border: showCommentSpans ? "1px solid #eab308" : "1px solid #e2e8f0",
                borderRadius: 6, cursor: "pointer", fontSize: 13, fontWeight: 600,
                color: showCommentSpans ? "#a16207" : "#94a3b8", minHeight: 32,
              }}
            >&#x1F4AC; {showCommentSpans ? "●" : "○"}</button>
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
              border: "1px solid var(--sim-border, #e2e8f0)", borderRadius: 6,
              padding: "0 2px", backgroundColor: "var(--sim-hover, #f1f5f9)",
            }}>
              <button onClick={zoomOut} title="Zoom out (Ctrl+-)" style={{
                width: 26, height: 28, border: "none", background: "transparent",
                cursor: "pointer", fontSize: 14, color: "var(--sim-text-secondary, #475569)", display: "flex",
                alignItems: "center", justifyContent: "center",
              }}>−</button>
              <button onClick={zoomReset}
                title="Reset zoom (Ctrl+0)"
                style={{
                  border: "none", background: "transparent", cursor: "pointer",
                  fontSize: 11, color: "var(--sim-text-secondary, #475569)", fontWeight: 600, minWidth: 36,
                  textAlign: "center", height: 28,
                }}
              >{Math.round(editorZoom * 100)}%</button>
              <button onClick={zoomIn} title="Zoom in (Ctrl+=)" style={{
                width: 26, height: 28, border: "none", background: "transparent",
                cursor: "pointer", fontSize: 14, color: "var(--sim-text-secondary, #475569)", display: "flex",
                alignItems: "center", justifyContent: "center",
              }}>+</button>
            </div>
            <span style={{
              padding: "2px 8px",
              backgroundColor: "var(--sim-success-tint, #ecfdf5)",
              color: "var(--sim-success-text, #059669)",
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
            // Q35: enable/disable only flip the flag + bump publishSeq.
            // Per-keystroke marking lives in PmEditableBlock's dispatchTransaction.
            setTcState(prev => val ? tc.enable(prev) : tc.disable(prev));
          }}
          showRevisions={showRevisions}
          onShowRevisionsChange={setShowRevisions}
          showNotes={showNotes}
          onShowNotesChange={(val) => {
            // Explicit re-hide wins over any per-block reveal exemption —
            // the user asked for ALL notes hidden, including recently
            // converted ones.
            if (!val) setRevealedNoteIds(new Set());
            setShowNotes(val);
          }}
          unitDisplay={unitDisplay}
          onUnitDisplayChange={setUnitDisplay}
          blocks={blocks}
          onAcceptAll={handleAcceptAll}
          onRejectAll={handleRejectAll}
        />

        {/* Cross-Reference Validation */}
        <CrossRefPanel blocks={blocks} sectionNumber={sectionNumber} onRemoveOrphaned={blockActions.removeOrphaned} />

        {/* In-Document Search */}
        {searchOpen && (
          <SearchBar
            blocks={blocks}
            editorRef={editorRef}
            onReplace={blockActions.searchReplace}
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

        {/* Block Type Conversion Palette (Ctrl+Shift+M) */}
        {convertPalette && (
          <ConvertBlockPalette
            currentType={convertPalette.currentType}
            anchorRect={convertPalette.anchorRect}
            onConvert={(newType) => {
              const { blockId, savedSelection } = convertPalette;
              handleConvertBlockType(blockId, newType);
              setConvertPalette(null);
              // Restore PM caret + focus after dispatch. requestAnimationFrame
              // gives React time to flush the re-render so the EditorView's
              // selection state matches the doc.
              requestAnimationFrame(() => {
                const view = getBlockView(blockId);
                if (!view) return;
                view.focus();
                if (savedSelection) {
                  try {
                    const docSize = view.state.doc.content.size;
                    const safeFrom = Math.min(savedSelection.from, docSize);
                    const safeTo = Math.min(savedSelection.to, docSize);
                    const tr = view.state.tr.setSelection(
                      TextSelection.create(view.state.doc, safeFrom, safeTo)
                    );
                    view.dispatch(tr);
                  } catch (err) {
                    if (import.meta.env.DEV) {
                      console.warn('[ConvertBlockPalette] selection restore failed', err);
                    }
                  }
                }
              });
            }}
            onClose={() => {
              const { blockId } = convertPalette;
              setConvertPalette(null);
              requestAnimationFrame(() => {
                const view = getBlockView(blockId);
                if (view) view.focus();
              });
            }}
          />
        )}

        {contextMenu && (
          <ContextMenu
            items={contextMenu.items}
            anchor={contextMenu.anchor}
            onSelect={(actionId) => { handleContextAction(actionId, contextMenu); setContextMenu(null); }}
            onClose={() => setContextMenu(null)}
          />
        )}

        {/* Bracket Replace Panel */}
        {bracketOpen && (
          <BracketReplace
            blocks={blocks}
            onReplace={blockActions.searchReplace}
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
          ref={editorScrollRef}
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
          className={`editor-content ${showRevisions ? '' : 'revisions-hidden'} ${showNotes ? '' : 'notes-hidden'} ${showTags ? 'tags-visible' : 'tags-hidden'} ${showCommentSpans ? '' : 'comment-spans-hidden'} ${unitDisplay === 'eng' ? 'units-eng-only' : unitDisplay === 'met' ? 'units-met-only' : ''}`.trim()}
          onCopy={(e) => {
            const sel = window.getSelection();
            if (!sel || sel.isCollapsed) return;
            const plainText = sel.toString();
            e.clipboardData.setData('text/plain', plainText);
            e.preventDefault();
          }}
          style={{
            padding: "16px 24px 100px",
            marginLeft: "auto",
            marginRight: showComments ? 0 : "auto",
            width: "100%",
            position: "relative",
            zoom: editorZoom,
          }}
        >
          <FloatingToolbar
            editorRef={editorRef}
            onRefreshTcSnapshot={blockActions.updateHtmlPmSync}
            onForceFrame={inRoom ? collab.forceFrame : localUndo.forceFrame}
            trackChanges={trackChanges}
            onCommentCreate={handleCommentCreate}
            identity={identity}
            readOnly={collabReadOnly}
          />

          {inRoom && identity && (
            <RemoteCursors peers={peers} selfId={identity.id} editorRef={editorRef} />
          )}

          {/* Comment popups — one per comment while the highlight layer is ON
              (#195 follow-up). They persist until the layer is toggled OFF; the
              clicked comment uses its live commentRect until the capture effect
              seeds commentRects. Each popup self-tracks its span on scroll. */}
          {showCommentSpans && [...comments.values()].map((c) => {
            // Resolved comments stay collapsed unless explicitly clicked open.
            if (!shouldShowCommentPopup(c, openCommentId)) return null;
            const rect = commentRects.get(c.id) || (c.id === openCommentId ? commentRect : null);
            if (!rect) return null;
            return (
              <CommentPopup
                key={c.id}
                comment={c}
                rect={rect}
                onReply={handleCommentReply}
                onResolve={handleCommentResolve}
                onReopen={handleCommentReopen}
                onDelete={handleCommentDelete}
                onUpdateCreate={handleCommentUpdateCreate}
                onClose={() => setOpenCommentId(null)}
                paneRef={editorScrollRef}
              />
            );
          })}

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
                  onUpdate={blockActions.updateHtml}
                  onPromote={blockActions.promote}
                  onDemote={blockActions.demote}
                  onEnterKey={blockActions.insertAfter}
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
                  onUpdate={blockActions.mergeBlockData}
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
                  onUpdate={blockActions.mergeBlockData}
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
                  onUpdate={blockActions.updateRefScalar}
                  isFocused={focusedBlockId === block.id}
                  onFocus={handleClickFocus}
                  readOnly={collabReadOnly}
                  onAcceptRevision={blockActions.acceptRevision}
                  onRejectRevision={blockActions.rejectRevision}
                  onCommentClick={handleCommentClick}
                  commentsState={commentsState}
                  activeCommentId={openCommentId}
                />
              );
            }
            return (
              <div key={block.id}>
                <PmEditableBlock
                  block={block}
                  yStore={activeYStore}
                  onUpdate={blockActions.updateHtml}
                  onEnterKey={blockActions.insertAfter}
                  onFocus={handleClickFocus}
                  isFocused={focusedBlockId === block.id}
                  oliLabel={block.type === "oli" ? oliLabels[block.id] : null}
                  onDelete={handleDelete}
                  onFocusPrev={handleFocusPrev}
                  onFocusNext={handleFocusNext}
                  onConvertBlock={handleConvertBlock}
                  onConvertBlockType={handleConvertBlockType}
                  onChangeOliLevel={blockActions.changeOliLevel}
                  resolveHtml={resolveHtml}
                  tailorKey={tailorKey}
                  trackChanges={trackChanges}
                  identity={identity}
                  readOnly={collabReadOnly}
                  forceVisible={revealedNoteIds.has(block.id)}
                  onAcceptRevision={blockActions.acceptRevision}
                  onRejectRevision={blockActions.rejectRevision}
                  onRefreshTcSnapshot={blockActions.updateHtmlPmSync}
                  commentsState={commentsState}
                  onCommentClick={handleCommentClick}
                  onInlineFix={blockActions.applyInlineFix}
                  lintingState={lintingState}
                  lintingDispatch={setLintingState}
                  showTags={showTags}
                  forceFrame={inRoom ? collab.forceFrame : localUndo.forceFrame}
                  onSuppress={(ruleId, blockHash, match) => {
                    if (!blockHash) return;
                    // Single dispatch path — production AND tests share it. The DEV seam
                    // `__simEditorTestUtils.dispatchLintIgnore` exists for E2E tests that
                    // need to inject envelopes WITHOUT a tooltip mounted.
                    // Do NOT call it from here (would double-dispatch in DEV).
                    linting.computeIgnoreKey(ruleId, blockHash, match).then(ignoreKey => {
                      setLintingState(s => linting.ignoreFinding(s, {
                        ignoreKey, ruleId, blockHash, match,
                        identity: effectiveIdentity(), ts: Date.now(),
                      }));
                    });
                  }}
                  onMuteNlpRule={(ruleId) => {
                    setLintingState(s => linting.muteNlpRule(s, {
                      ruleId, identity: effectiveIdentity(), ts: Date.now(),
                    }));
                  }}
                />
                {focusedBlockId === block.id && (
                  <MarkSuggestions
                    blockId={block.id}
                    html={block.html}
                    onApply={blockActions.updateHtml}
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
            lintingState={lintingState}
            onAcceptFix={blockActions.applyInlineFix}
            onAcceptGroupFix={blockActions.complianceAcceptGroup}
            unitDisplay={unitDisplay}
            onItemDismiss={async (ruleId, item) => {
              // Lazy blockHash: lintingState.byBlock is populated only on focus
              // (see useBlockLinting.js), so a Compliance scan finding in a
              // block the user has never focused has no cached hash. Falling
              // back to fingerprintBlock(block.html) lets Dismiss work for
              // any block in the document, not just visited ones.
              const blockHash = await resolveBlockHashForDismiss(item.blockId);
              if (!blockHash) return;
              const ignoreKey = await linting.computeIgnoreKey(ruleId, blockHash, item.match);
              setLintingState(s => linting.ignoreFinding(s, {
                ignoreKey, ruleId, blockHash, match: item.match,
                identity: effectiveIdentity(), ts: Date.now(),
              }));
            }}
            onGroupDismiss={async (group) => {
              // Batched single state update via reduce. Same lazy blockHash
              // behavior as onItemDismiss — group findings can span blocks
              // the user has never focused.
              const updates = [];
              for (const item of group.instances) {
                const blockHash = await resolveBlockHashForDismiss(item.blockId);
                if (!blockHash) continue;
                const ignoreKey = await linting.computeIgnoreKey(group.ruleId, blockHash, item.match);
                updates.push({ ignoreKey, ruleId: group.ruleId, blockHash, match: item.match });
              }
              const identity = effectiveIdentity();
              const ts = Date.now();
              setLintingState(s => updates.reduce(
                (acc, args) => linting.ignoreFinding(acc, { ...args, identity, ts }),
                s,
              ));
            }}
            ignoredCount={Array.from(lintingState.ignored.findings.values()).filter(e => !e.tombstone).length}
            mutedCount={Array.from(lintingState.ignored.mutedRules.values()).filter(e => !e.tombstone).length}
            onResetIgnored={() => {
              setLintingState(s => linting.resetIgnoredFindings(s, { ts: Date.now() }));
            }}
            onResetMuted={() => {
              setLintingState(s => linting.resetMutedRules(s, { ts: Date.now() }));
            }}
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
                // #215 — identify the actor so the lock owner can delete their own
                // locked room; non-owners get 423 from the server.
                const delHeaders = { ...authHeaders };
                if (identity?.id) delHeaders['X-Actor-Id'] = identity.id;
                const delRes = await fetch(`${COLLAB_HTTP_URL}/rooms/${id}`, { method: 'DELETE', headers: delHeaders });
                if (delRes.status === 423) { window.alert('Room is locked — only the user who locked it can delete it.'); return; }
                setRoomList(prev => prev.filter(r => r.id !== id));
              } catch { /* ignore */ }
            }}
            onLockRoom={async (roomId, locked) => {
              try {
                const token = sessionStorage.getItem('sim-auth-token');
                const headers = { 'Content-Type': 'application/json', ...authHeaders };
                if (token && !headers['Authorization']) headers['Authorization'] = `Bearer ${token}`;
                // #215 — actor id lets the lock owner unlock; others get 423.
                if (identity?.id) headers['X-Actor-Id'] = identity.id;
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
                // #215 — actor id lets the lock owner rename a locked room; others get 423.
                if (identity?.id) headers['X-Actor-Id'] = identity.id;
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
            onLoadAcl={async (roomId) => {
              // #239: owner-only. Returns { ownerId, roles }.
              const res = await fetch(`${COLLAB_HTTP_URL}/rooms/${roomId}/acl`, { headers: authHeaders });
              if (!res.ok) throw new Error(res.status === 404 ? 'Room not found' : `Failed to load (${res.status})`);
              return res.json();
            }}
            onShareRoom={async (roomId, payload) => {
              // #239 raw-sub grant + #267 email invite. Forward the payload
              // ({ userId|email, action, role }) as-is; the server branches.
              const res = await fetch(`${COLLAB_HTTP_URL}/rooms/${roomId}/share`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json', ...authHeaders },
                body: JSON.stringify(payload),
              });
              if (!res.ok) {
                const msg = await res.text().catch(() => '');
                throw new Error(msg || `Share failed (${res.status})`);
              }
              return res.json();
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
          borderTop: "1px solid var(--sim-border, #e2e8f0)",
          backgroundColor: "var(--sim-toolbar-bg, #ffffff)",
          fontSize: 12,
          color: "var(--sim-text-secondary, #64748b)",
        }}>
          <span>{blocks.length} blocks | {blocks.filter(b => b.type === "title").length} sections | {blocks.filter(b => b.type === "table").length} tables</span>
          <span>Enter: new paragraph | Backspace: delete empty | / : insert block type | Tab/Shift+Tab: heading level | Ctrl+Z: undo | Ctrl+Y: redo</span>
          <span>{getDisplayName(currentFile)}</span>
        </div>
      </div>

      {/* Reference Wizard Modal */}
      {refWizardOpen && (
        <RefWizard
          onAdd={blockActions.addReference}
          onClose={() => setRefWizardOpen(false)}
          existingOrgs={blocks.filter(b => b.type === 'ref' && b.ref?.org).map(b => b.ref.org)}
        />
      )}

      {/* Collab identity prompt — appears on first load when ?room=... is present */}
      {inRoom && !identity && getAuthMode() === 'stub' && (
        <IdentityModal
          roomId={roomId}
          onIdentity={setIdentity}
          onCancel={() => { window.location.href = stripRoomFromUrl(); }}
        />
      )}
    </div>
  );
}
