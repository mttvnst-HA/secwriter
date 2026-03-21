import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { getVisibleTextFromHtml } from "../lib/text-diff.js";

/**
 * Search all blocks for a text query. Returns array of { blockId, offset }
 * where offset is the character position in the block's visible text.
 */
export function searchBlocks(blocks, query) {
  if (!query) return [];
  const lower = query.toLowerCase();
  const results = [];
  for (const block of blocks) {
    if (!block.html) continue;
    const text = getVisibleTextFromHtml(block.html).toLowerCase();
    let idx = 0;
    while ((idx = text.indexOf(lower, idx)) !== -1) {
      results.push({ blockId: block.id, offset: idx, length: query.length });
      idx += 1;
    }
  }
  return results;
}

/**
 * Replace a match in a block's HTML at the given visible-text offset.
 * Walks visible text segments (skipping HTML tags and <del> content) to map
 * the visible-text offset to the correct position in the raw HTML string,
 * then performs the replacement. Returns the new HTML string.
 */
export function replaceMatchInHtml(html, offset, length, replacement) {
  // Walk through the HTML, tracking visible text position
  // Skip: HTML tags, and everything inside <del class="mark-del">...</del>
  let visiblePos = 0;
  let i = 0;
  let inDel = 0; // nesting depth inside del.mark-del
  while (i < html.length && visiblePos < offset + length) {
    if (html[i] === '<') {
      // Check for <del class="mark-del"> open tag
      const delOpen = html.substring(i).match(/^<del\s+class="mark-del"[^>]*>/i);
      if (delOpen) {
        inDel++;
        i += delOpen[0].length;
        continue;
      }
      // Check for </del> close tag
      const delClose = html.substring(i).match(/^<\/del>/i);
      if (delClose) {
        inDel = Math.max(0, inDel - 1);
        i += delClose[0].length;
        continue;
      }
      // Skip any other HTML tag
      const tagEnd = html.indexOf('>', i);
      if (tagEnd === -1) break;
      i = tagEnd + 1;
      continue;
    }
    // Inside a del — skip this character
    if (inDel > 0) {
      i++;
      continue;
    }
    // Handle HTML entities
    if (html[i] === '&') {
      const entityEnd = html.indexOf(';', i);
      if (entityEnd !== -1 && entityEnd - i < 10) {
        if (visiblePos === offset) {
          // Start of match is at an entity — replace from here
          const before = html.substring(0, i);
          // Find the raw HTML position at offset + length
          const endPos = findRawPosition(html, offset + length, i, visiblePos);
          const after = html.substring(endPos);
          return before + replacement + after;
        }
        visiblePos++;
        i = entityEnd + 1;
        continue;
      }
    }
    // Regular visible character
    if (visiblePos === offset) {
      // Found the start — now find the end
      const before = html.substring(0, i);
      const endPos = findRawPosition(html, offset + length, i, visiblePos);
      const after = html.substring(endPos);
      return before + replacement + after;
    }
    visiblePos++;
    i++;
  }
  return html; // fallback: no change
}

/** Find the raw HTML position corresponding to a visible-text offset, starting from a known position. */
function findRawPosition(html, targetVisible, startRaw, startVisible) {
  let visiblePos = startVisible;
  let i = startRaw;
  let inDel = 0;
  while (i < html.length && visiblePos < targetVisible) {
    if (html[i] === '<') {
      const delOpen = html.substring(i).match(/^<del\s+class="mark-del"[^>]*>/i);
      if (delOpen) { inDel++; i += delOpen[0].length; continue; }
      const delClose = html.substring(i).match(/^<\/del>/i);
      if (delClose) { inDel = Math.max(0, inDel - 1); i += delClose[0].length; continue; }
      const tagEnd = html.indexOf('>', i);
      if (tagEnd === -1) break;
      i = tagEnd + 1;
      continue;
    }
    if (inDel > 0) { i++; continue; }
    if (html[i] === '&') {
      const entityEnd = html.indexOf(';', i);
      if (entityEnd !== -1 && entityEnd - i < 10) { visiblePos++; i = entityEnd + 1; continue; }
    }
    visiblePos++;
    i++;
  }
  return i;
}

/**
 * Remove any existing search highlight marks from the document.
 */
function clearSearchHighlight() {
  const existing = document.querySelectorAll('mark.search-highlight');
  for (const el of existing) {
    const parent = el.parentNode;
    while (el.firstChild) parent.insertBefore(el.firstChild, el);
    parent.removeChild(el);
    parent.normalize(); // merge adjacent text nodes
  }
}

/**
 * Use TreeWalker to find a text node at a given character offset within a DOM element,
 * then wrap the matched text in a <mark> element for visual highlighting.
 * Does NOT move focus — the search input retains focus.
 */
function highlightMatchInDOM(container, offset, length) {
  if (!container) return;
  clearSearchHighlight();
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  let charCount = 0;
  let node;
  while ((node = walker.nextNode())) {
    if (node.parentElement?.closest?.('del.mark-del')) continue;
    const nodeLen = node.textContent.length;
    if (charCount + nodeLen > offset) {
      const startOffset = offset - charCount;
      const endOffset = Math.min(startOffset + length, nodeLen);
      const range = document.createRange();
      range.setStart(node, startOffset);
      range.setEnd(node, endOffset);
      const mark = document.createElement('mark');
      mark.className = 'search-highlight';
      mark.style.backgroundColor = '#fbbf24';
      mark.style.color = '#1e293b';
      mark.style.borderRadius = '2px';
      mark.style.padding = '0 1px';
      range.surroundContents(mark);
      return;
    }
    charCount += nodeLen;
  }
}

export default function SearchBar({ blocks, editorRef, onClose, onReplace, initialShowReplace }) {
  const [query, setQuery] = useState("");
  const [replaceText, setReplaceText] = useState("");
  const [showReplace, setShowReplace] = useState(!!initialShowReplace);
  const [currentIdx, setCurrentIdx] = useState(0);
  const inputRef = useRef(null);
  const replaceRef = useRef(null);
  const debounceRef = useRef(null);
  const [debouncedQuery, setDebouncedQuery] = useState("");

  // Auto-focus input on mount
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Debounce search query
  useEffect(() => {
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => setDebouncedQuery(query), 200);
    return () => clearTimeout(debounceRef.current);
  }, [query]);

  const results = useMemo(() => searchBlocks(blocks, debouncedQuery), [blocks, debouncedQuery]);

  // Reset index when results change
  useEffect(() => {
    setCurrentIdx(results.length > 0 ? 0 : -1);
  }, [results]);

  // Navigate to current result
  useEffect(() => {
    if (currentIdx < 0 || currentIdx >= results.length) return;
    const match = results[currentIdx];
    const el = document.getElementById(`block-${match.blockId}`);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      // Find the contentEditable or text container within
      const contentEl = el.querySelector('[data-block-id]') || el;
      setTimeout(() => highlightMatchInDOM(contentEl, match.offset, match.length), 100);
    }
  }, [currentIdx, results]);

  const goNext = useCallback(() => {
    if (results.length === 0) return;
    setCurrentIdx(prev => (prev + 1) % results.length);
  }, [results.length]);

  const goPrev = useCallback(() => {
    if (results.length === 0) return;
    setCurrentIdx(prev => (prev - 1 + results.length) % results.length);
  }, [results.length]);

  const handleReplace = useCallback(() => {
    if (currentIdx < 0 || currentIdx >= results.length || !onReplace) return;
    const match = results[currentIdx];
    onReplace(match.blockId, match.offset, match.length, replaceText);
  }, [currentIdx, results, replaceText, onReplace]);

  const handleReplaceAll = useCallback(() => {
    if (results.length === 0 || !onReplace) return;
    // Process in reverse order to preserve offsets (later matches first)
    const grouped = new Map();
    for (const match of results) {
      if (!grouped.has(match.blockId)) grouped.set(match.blockId, []);
      grouped.get(match.blockId).push(match);
    }
    for (const [blockId, matches] of grouped) {
      // Sort by offset descending so replacements don't shift earlier offsets
      const sorted = [...matches].sort((a, b) => b.offset - a.offset);
      for (const match of sorted) {
        onReplace(blockId, match.offset, match.length, replaceText);
      }
    }
  }, [results, replaceText, onReplace]);

  const handleKeyDown = useCallback((e) => {
    if (e.key === "Escape") {
      onClose();
    } else if (e.key === "Enter" && e.shiftKey) {
      e.preventDefault();
      goPrev();
    } else if (e.key === "Enter") {
      e.preventDefault();
      goNext();
    } else if (e.key === "h" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      setShowReplace(prev => !prev);
      setTimeout(() => replaceRef.current?.focus(), 50);
    }
  }, [onClose, goNext, goPrev]);

  const handleReplaceKeyDown = useCallback((e) => {
    if (e.key === "Escape") {
      onClose();
    } else if (e.key === "Enter") {
      e.preventDefault();
      handleReplace();
    }
  }, [onClose, handleReplace]);

  const matchLabel = results.length === 0
    ? (debouncedQuery ? "No matches" : "")
    : `${currentIdx + 1} of ${results.length}`;

  const btnStyle = {
    height: 28, border: "1px solid #cbd5e1", borderRadius: 4,
    backgroundColor: "white", color: "#475569", fontSize: 12,
    cursor: "pointer", display: "flex", alignItems: "center",
    justifyContent: "center", padding: "0 8px",
  };

  const navBtnStyle = {
    width: 28, height: 28, border: "1px solid #cbd5e1", borderRadius: 4,
    backgroundColor: "white", color: "#475569", fontSize: 12,
    cursor: "pointer", display: "flex", alignItems: "center",
    justifyContent: "center", padding: 0,
  };

  return (
    <div style={{
      padding: "6px 16px",
      borderBottom: "1px solid #e2e8f0",
      backgroundColor: "#f8fafc",
      fontSize: 13,
    }}>
      {/* Find row */}
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <button
          onClick={() => {
            setShowReplace(prev => !prev);
            if (!showReplace) setTimeout(() => replaceRef.current?.focus(), 50);
          }}
          title={showReplace ? "Hide Replace (Ctrl+H)" : "Show Replace (Ctrl+H)"}
          style={{
            ...navBtnStyle, width: 22, height: 22, border: "none",
            backgroundColor: "transparent", color: "#64748b", fontSize: 14,
          }}
        >{showReplace ? "▾" : "▸"}</button>
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Find..."
          style={{
            flex: 1, maxWidth: 260,
            border: "1px solid #cbd5e1", borderRadius: 4,
            padding: "4px 8px", fontSize: 13, outline: "none",
          }}
        />
        <span style={{ color: "#64748b", fontSize: 12, minWidth: 70 }}>{matchLabel}</span>
        <button onClick={goPrev} disabled={results.length === 0}
          title="Previous (Shift+Enter)"
          style={{ ...navBtnStyle, opacity: results.length > 0 ? 1 : 0.4 }}
        >&#x25B2;</button>
        <button onClick={goNext} disabled={results.length === 0}
          title="Next (Enter)"
          style={{ ...navBtnStyle, opacity: results.length > 0 ? 1 : 0.4 }}
        >&#x25BC;</button>
        <button onClick={onClose} title="Close (Escape)"
          style={{
            ...navBtnStyle, width: 22, height: 22, border: "none",
            backgroundColor: "transparent", color: "#94a3b8", fontSize: 16,
          }}
        >&#x2715;</button>
      </div>

      {/* Replace row */}
      {showReplace && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 4, paddingLeft: 30 }}>
          <input
            ref={replaceRef}
            type="text"
            value={replaceText}
            onChange={(e) => setReplaceText(e.target.value)}
            onKeyDown={handleReplaceKeyDown}
            placeholder="Replace with..."
            style={{
              flex: 1, maxWidth: 260,
              border: "1px solid #cbd5e1", borderRadius: 4,
              padding: "4px 8px", fontSize: 13, outline: "none",
            }}
          />
          <button onClick={handleReplace}
            disabled={results.length === 0}
            title="Replace current match (Enter)"
            style={{ ...btnStyle, opacity: results.length > 0 ? 1 : 0.4 }}
          >Replace</button>
          <button onClick={handleReplaceAll}
            disabled={results.length === 0}
            title="Replace all matches"
            style={{ ...btnStyle, opacity: results.length > 0 ? 1 : 0.4 }}
          >Replace All</button>
        </div>
      )}
    </div>
  );
}
