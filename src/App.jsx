import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import { FileText, Search, Upload, Download, Check, Loader } from "lucide-react";
import TreeNode from "./components/TreeNode.jsx";
// MarkLegend component preserved for future user manual documentation (removed from toolbar UI)
import EditableBlock from "./components/EditableBlock.jsx";
import TitleBlock from "./components/TitleBlock.jsx";
import TableBlock from "./components/TableBlock.jsx";
import RefBlock from "./components/RefBlock.jsx";
import FloatingToolbar from "./components/FloatingToolbar.jsx";
import MarkSuggestions from "./components/MarkSuggestions.jsx";
import TailoringProfile from "./components/TailoringProfile.jsx";
import { computeNumbering, computeOliLabels } from "./lib/numbering.js";
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
  const fileHandleRef = useRef(null); // File System Access API handle for SEC file
  const commentsHandleRef = useRef(null); // File System Access API handle for comments sidecar
  const editorRef = useRef(null);
  const fileInputRef = useRef(null);
  const blocksRef = useRef(blocks);
  blocksRef.current = blocks;
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
      setComments(new Map());
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
  }, [blocks, sectionMeta, doFileSave, saveCommentsSidecar]);

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
    setComments(prev => {
      const next = new Map(prev);
      next.set(commentId, {
        id: commentId,
        blockId,
        status: "open",
        highlightText: highlightText || "",
        entries: [{ type: "create", text: "", author: "User", timestamp: new Date().toISOString() }],
      });
      return next;
    });
    // Open the popup immediately so user can type the comment
    setOpenCommentId(commentId);
    setTimeout(() => {
      const el = document.querySelector(`[data-comment-id="${commentId}"]`);
      if (el) setCommentRect(el.getBoundingClientRect());
    }, 50);
  }, []);

  // Update the initial "create" entry with actual comment text and author
  const handleCommentUpdateCreate = useCallback((commentId, text, author) => {
    setComments(prev => {
      const next = new Map(prev);
      const c = next.get(commentId);
      if (!c) return prev;
      const entries = [...c.entries];
      if (entries[0]?.type === "create") {
        entries[0] = { ...entries[0], text, author };
      }
      next.set(commentId, { ...c, entries });
      return next;
    });
  }, []);

  const handleCommentReply = useCallback((commentId, text, author) => {
    setComments(prev => {
      const next = new Map(prev);
      const c = next.get(commentId);
      if (!c) return prev;
      next.set(commentId, {
        ...c,
        entries: [...c.entries, { type: "reply", text, author, timestamp: new Date().toISOString() }],
      });
      return next;
    });
  }, []);

  const handleCommentResolve = useCallback((commentId) => {
    setComments(prev => {
      const next = new Map(prev);
      const c = next.get(commentId);
      if (!c) return prev;
      next.set(commentId, {
        ...c,
        status: "resolved",
        entries: [...c.entries, { type: "resolve", author: getAuthorName() || "User", timestamp: new Date().toISOString() }],
      });
      return next;
    });
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
  }, []);

  const handleCommentReopen = useCallback((commentId) => {
    setComments(prev => {
      const next = new Map(prev);
      const c = next.get(commentId);
      if (!c) return prev;
      next.set(commentId, {
        ...c,
        status: "open",
        entries: [...c.entries, { type: "reopen", author: getAuthorName() || "User", timestamp: new Date().toISOString() }],
      });
      return next;
    });
    const el = document.querySelector(`[data-comment-id="${commentId}"]`);
    if (el) {
      el.className = "mark-comment";
      const blockEl = el.closest('[data-block-id]');
      if (blockEl) {
        const blockId = blockEl.getAttribute('data-block-id');
        setBlocks(prev => prev.map(b => b.id === blockId ? { ...b, html: blockEl.innerHTML } : b));
      }
    }
  }, []);

  const handleCommentDelete = useCallback((commentId) => {
    setComments(prev => {
      const next = new Map(prev);
      next.delete(commentId);
      return next;
    });
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
  }, []);

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

  // Auto-save to localStorage every 3 seconds (silent, no UI)
  useEffect(() => {
    const timer = setTimeout(() => {
      autoSave(blocks, sectionMeta, comments, fileName);
    }, 3000);
    return () => clearTimeout(timer);
  }, [blocks, sectionMeta, comments, fileName]);

  // Track dirty state — any block/comment change marks dirty
  useEffect(() => {
    setIsDirty(true);
  }, [blocks, comments]);

  // On mount: offer to restore auto-saved state if available. Previously
  // this was silent, which let a stale auto-save from a different file
  // quietly overwrite the initial document (and then, combined with a
  // leftover file handle, get written back to disk on the next Ctrl+S).
  useEffect(() => {
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
  }, []);

  // Keyboard listener for undo/redo and search
  useEffect(() => {
    const handler = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
        e.preventDefault();
        undo();
      } else if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) {
        e.preventDefault();
        redo();
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
  }, [undo, redo, handleSave, zoomIn, zoomOut, zoomReset]);

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
            setTrackChanges(val);
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
          <FloatingToolbar editorRef={editorRef} onBlockUpdate={handleBlockUpdate} onRevisionAction={handleRevisionAction} trackChanges={trackChanges} onCommentCreate={handleCommentCreate} />

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
                <div
                  key={block.id}
                  id={`block-${block.id}`}
                  className="block-tbl"
                  data-block-id={block.id}
                  data-tag="TBL"
                  contentEditable={false}
                  onClick={() => handleClickFocus(block.id)}
                  dangerouslySetInnerHTML={{ __html: block.html }}
                  style={{
                    padding: "12px 16px",
                    margin: "4px 0",
                    outline: focusedBlockId === block.id ? "2px solid #3b82f6" : "none",
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
    </div>
  );
}
