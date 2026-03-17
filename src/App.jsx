import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import { FileText, Search, Upload, Download } from "lucide-react";
import TreeNode from "./components/TreeNode.jsx";
import MarkLegend from "./components/MarkLegend.jsx";
import EditableBlock from "./components/EditableBlock.jsx";
import TitleBlock from "./components/TitleBlock.jsx";
import TableBlock from "./components/TableBlock.jsx";
import FloatingToolbar from "./components/FloatingToolbar.jsx";
import MarkSuggestions from "./components/MarkSuggestions.jsx";
import TailoringProfile from "./components/TailoringProfile.jsx";
import { computeNumbering, computeOliLabels } from "./lib/numbering.js";
import { resolveTaiInHtml, cleanTaiClasses } from "./lib/tailor-profile.js";
import RevisionControls from "./components/RevisionControls.jsx";
import { acceptAllRevisions, rejectAllRevisions } from "./lib/revisions.js";
import { buildTree } from "./lib/tree-builder.js";
import { parseSEC } from "./lib/sec-parser.js";
import { serializeSEC } from "./lib/sec-serializer.js";
import { encodeWindows1252 } from "./lib/encoding.js";
import INITIAL_BLOCKS from "./data/sample-31-00-00.json";

export default function SpecEditor() {
  const [blocks, setBlocks] = useState(INITIAL_BLOCKS);
  const [selectedTreeId, setSelectedTreeId] = useState(null);
  const [focusedBlockId, setFocusedBlockId] = useState(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const [fileName, setFileName] = useState("31_00_00.SEC");
  const [tailorActive, setTailorActive] = useState(false);
  const [tailorProfile, setTailorProfile] = useState({ branch: null, region: null, deliveryMethod: null });
  const [tailorShowAll, setTailorShowAll] = useState(false);
  const [trackChanges, setTrackChanges] = useState(false);
  const [showRevisions, setShowRevisions] = useState(true);
  const [sectionMeta, setSectionMeta] = useState({
    sectionNumber: "31 00 00",
    sectionTitle: "EARTHWORK",
    date: "08/23",
  });
  const editorRef = useRef(null);
  const fileInputRef = useRef(null);
  const blocksRef = useRef(blocks);
  blocksRef.current = blocks;
  const tree = useMemo(() => buildTree(blocks), [blocks]);
  const numberMap = useMemo(() => computeNumbering(blocks), [blocks]);
  const oliLabels = useMemo(() => computeOliLabels(blocks), [blocks]);

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
      setBlocks(parsed);
      setFileName(name);
      setSectionMeta(extractMetadata(content));
      setSelectedTreeId(null);
      setFocusedBlockId(null);
    } catch (err) {
      alert(`Failed to parse SEC file: ${err.message}`);
    }
  }, [extractMetadata]);

  const handleFileImport = useCallback((file) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      // SEC files use windows-1252 encoding, not UTF-8
      const decoder = new TextDecoder('windows-1252');
      const text = decoder.decode(e.target.result);
      loadSECContent(text, file.name);
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
  }, [blocks, sectionMeta, fileName]);

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

  const handleBlockUpdate = useCallback((id, html) => {
    setBlocks(prev => prev.map(b => b.id === id ? { ...b, html } : b));
  }, []);

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

  const handleEnterKey = useCallback((afterId) => {
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
    setFocusedBlockId(newId);
  }, [trackChanges]);

  // Delete a block and focus the previous one
  const handleDelete = useCallback((blockId) => {
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
      next[idx] = {
        id: newId,
        type: newType,
        part: block.part,
        depth: block.depth,
        section: block.section,
        html: "",
        isNew: true,
      };
      return next;
    });
    setFocusedBlockId(newId);
  }, [handleConvertToTitle]);

  // Promote a title (decrease depth)
  const handlePromote = useCallback((blockId) => {
    setBlocks(prev => prev.map(b => {
      if (b.id === blockId && b.type === "title" && b.depth > 1) {
        return { ...b, depth: b.depth - 1 };
      }
      return b;
    }));
  }, []);

  // Demote a title (increase depth)
  const handleDemote = useCallback((blockId) => {
    setBlocks(prev => prev.map(b => {
      if (b.id === blockId && b.type === "title" && b.depth < 6) {
        return { ...b, depth: b.depth + 1 };
      }
      return b;
    }));
  }, []);

  const handleAcceptAll = useCallback(() => {
    setBlocks(prev => acceptAllRevisions(prev));
  }, []);

  const handleRejectAll = useCallback(() => {
    setBlocks(prev => rejectAllRevisions(prev));
  }, []);

  const sectionNumber = sectionMeta.sectionNumber;
  const sectionTitle = sectionMeta.sectionTitle;
  const ufgsDate = sectionMeta.date;

  return (
    <div style={{
      display: "flex",
      height: "100vh",
      fontFamily: "'Segoe UI', 'Helvetica Neue', -apple-system, sans-serif",
      backgroundColor: "#f8fafc",
      overflow: "hidden",
    }}>

      {/* LEFT SIDEBAR - Navigation Tree */}
      <div style={{
        width: 280,
        minWidth: 280,
        backgroundColor: "#1e293b",
        display: "flex",
        flexDirection: "column",
        borderRight: "1px solid #334155",
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
            <Search size={13} color="#64748b" />
            <input
              placeholder="Search sections..."
              style={{
                background: "none",
                border: "none",
                outline: "none",
                color: "#cbd5e1",
                fontSize: 12,
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
          {tree.map(node => (
            <TreeNode
              key={node.id}
              node={node}
              selectedId={selectedTreeId}
              onSelect={handleTreeSelect}
              depth={0}
              numberMap={numberMap}
            />
          ))}
        </div>

        {/* Sidebar Footer */}
        <div style={{
          padding: "10px 14px",
          borderTop: "1px solid #334155",
          fontSize: 10,
          color: "#475569",
          letterSpacing: "0.04em",
        }}>
          UFGS SPEC EDITOR PROTOTYPE v0.1
        </div>
      </div>

      {/* RIGHT PANEL - Editor */}
      <div
        style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", position: "relative" }}
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
          justifyContent: "space-between",
          padding: "8px 16px",
          borderBottom: "1px solid #e2e8f0",
          backgroundColor: "#ffffff",
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <span style={{ fontSize: 14, fontWeight: 700, color: "#0f172a", fontFamily: "Georgia, serif" }}>
              SECTION {sectionNumber}
            </span>
            <span style={{ fontSize: 14, color: "#64748b" }}> - </span>
            <span style={{ fontSize: 14, fontWeight: 600, color: "#334155", fontFamily: "Georgia, serif" }}>
              {sectionTitle}
            </span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "#64748b" }}>
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
                fontSize: 11,
                fontWeight: 600,
                color: "#475569",
              }}
            >
              <Upload size={13} /> Import
            </button>
            <button
              onClick={handleExport}
              title="Export as .SEC file"
              style={{
                display: "flex",
                alignItems: "center",
                gap: 4,
                padding: "4px 10px",
                backgroundColor: "#f1f5f9",
                border: "1px solid #e2e8f0",
                borderRadius: 6,
                cursor: "pointer",
                fontSize: 11,
                fontWeight: 600,
                color: "#475569",
              }}
            >
              <Download size={13} /> Export
            </button>
            <span style={{
              padding: "2px 8px",
              backgroundColor: "#ecfdf5",
              color: "#059669",
              borderRadius: 10,
              fontWeight: 600,
              fontSize: 11,
            }}>EDITING</span>
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
          onTrackChangesChange={setTrackChanges}
          showRevisions={showRevisions}
          onShowRevisionsChange={setShowRevisions}
          blocks={blocks}
          onAcceptAll={handleAcceptAll}
          onRejectAll={handleRejectAll}
        />

        {/* Mark Legend */}
        <MarkLegend />

        {/* Editor Content */}
        <div
          ref={editorRef}
          className={showRevisions ? '' : 'revisions-hidden'}
          style={{
            flex: 1,
            overflowY: "auto",
            padding: "16px 24px 100px",
            maxWidth: 800,
            marginLeft: "auto",
            marginRight: "auto",
            width: "100%",
            position: "relative",
          }}
        >
          <FloatingToolbar editorRef={editorRef} onBlockUpdate={handleBlockUpdate} trackChanges={trackChanges} />
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
            if (block.type === "table") {
              return (
                <TableBlock
                  key={block.id}
                  block={block}
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
                  resolveHtml={resolveHtml}
                  tailorKey={tailorKey}
                  onAcceptRevision={(id) => setBlocks(prev => {
                    const idx = prev.findIndex(b => b.id === id);
                    if (idx < 0) return prev;
                    const b = prev[idx];
                    if (b.revision === 'del') return prev.filter(bl => bl.id !== id);
                    const next = [...prev];
                    next[idx] = { ...b, revision: undefined };
                    return next;
                  })}
                  onRejectRevision={(id) => setBlocks(prev => {
                    const idx = prev.findIndex(b => b.id === id);
                    if (idx < 0) return prev;
                    const b = prev[idx];
                    if (b.revision === 'add') return prev.filter(bl => bl.id !== id);
                    const next = [...prev];
                    next[idx] = { ...b, revision: undefined };
                    return next;
                  })}
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

        {/* Status Bar */}
        <div style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "4px 16px",
          borderTop: "1px solid #e2e8f0",
          backgroundColor: "#ffffff",
          fontSize: 11,
          color: "#94a3b8",
        }}>
          <span>{blocks.length} blocks | {blocks.filter(b => b.type === "title").length} sections | {blocks.filter(b => b.type === "table").length} tables</span>
          <span>Enter: new paragraph | Backspace: delete empty | / : insert block type | Tab/Shift+Tab: heading level</span>
          <span>{fileName}</span>
        </div>
      </div>
    </div>
  );
}
