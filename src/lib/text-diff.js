/**
 * Word-level text diff for Track Changes.
 *
 * Compares old and new plain text, returns an array of diff operations.
 * Uses a simple LCS (Longest Common Subsequence) approach on word tokens.
 */

/**
 * Split text into word tokens (preserving whitespace boundaries).
 * Returns an array of non-empty word tokens.
 */
function tokenize(text) {
  return text.split(/\s+/).filter(Boolean);
}

/**
 * Compute word-level diff between old and new text.
 * Returns array of { type: 'keep'|'add'|'del', words: string[] }
 *
 * @param {string} oldText - Original plain text
 * @param {string} newText - Modified plain text
 * @returns {Array<{type: string, words: string[]}>}
 */
export function diffWords(oldText, newText) {
  const oldWords = tokenize(oldText);
  const newWords = tokenize(newText);

  // Build LCS table
  const m = oldWords.length;
  const n = newWords.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldWords[i - 1] === newWords[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // Backtrack to get diff operations
  const ops = [];
  let i = m, j = n;

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldWords[i - 1] === newWords[j - 1]) {
      ops.unshift({ type: 'keep', words: [oldWords[i - 1]] });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      ops.unshift({ type: 'add', words: [newWords[j - 1]] });
      j--;
    } else {
      ops.unshift({ type: 'del', words: [oldWords[i - 1]] });
      i--;
    }
  }

  // Merge consecutive operations of the same type
  const merged = [];
  for (const op of ops) {
    if (merged.length > 0 && merged[merged.length - 1].type === op.type) {
      merged[merged.length - 1].words.push(...op.words);
    } else {
      merged.push({ type: op.type, words: [...op.words] });
    }
  }

  return merged;
}

/**
 * Character-level LCS diff between two strings.
 * Returns array of { type: 'keep'|'add'|'del', text: string }
 */
export function diffChars(oldStr, newStr) {
  const m = oldStr.length;
  const n = newStr.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldStr[i - 1] === newStr[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  const ops = [];
  let i = m, j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldStr[i - 1] === newStr[j - 1]) {
      ops.unshift({ type: 'keep', text: oldStr[i - 1] });
      i--; j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      ops.unshift({ type: 'add', text: newStr[j - 1] });
      j--;
    } else {
      ops.unshift({ type: 'del', text: oldStr[i - 1] });
      i--;
    }
  }

  // Merge consecutive ops of same type
  const merged = [];
  for (const op of ops) {
    if (merged.length > 0 && merged[merged.length - 1].type === op.type) {
      merged[merged.length - 1].text += op.text;
    } else {
      merged.push({ type: op.type, text: op.text });
    }
  }
  return merged;
}

/**
 * Escape a string for use in an HTML attribute value (double-quoted).
 */
function escapeHtmlAttr(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Refine word-level diff by applying character-level sub-diff
 * to consecutive del→add pairs where words share ≥50% common characters.
 *
 * Overloaded signature:
 *   refineWordDiff(ops)                        → refined ops array (existing behavior)
 *   refineWordDiff(oldText, newText, options)  → HTML string with <ins>/<del> marks
 *
 * When called with string arguments, `options.author` may be
 * `{ id, name, color }` to attach data-author-* and style attributes to every
 * emitted <ins> and <del> tag (Task 4 author attribution).
 *
 * @param {Array|string} opsOrOldText
 * @param {string} [newText]
 * @param {{ author?: { id: string, name: string, color: string } }} [options]
 */
export function refineWordDiff(opsOrOldText, newText, options = {}) {
  // --- String overload: (oldText, newText, options?) → HTML ---
  if (typeof opsOrOldText === 'string') {
    const oldText = opsOrOldText;
    const { author } = options;

    const authorAttrs = author
      ? ` data-author-id="${escapeHtmlAttr(author.id)}" data-author-name="${escapeHtmlAttr(author.name)}" data-author-color="${escapeHtmlAttr(author.color)}" style="--author-color:${escapeHtmlAttr(author.color)}"`
      : '';

    const rawOps = diffWords(oldText, newText);
    const refinedOps = refineWordDiff(rawOps); // recurse with array form

    const parts = [];
    for (const op of refinedOps) {
      if (op.type === 'keep') {
        parts.push(op.words.join(' '));
      } else if (op.type === 'add') {
        parts.push(`<ins${authorAttrs}>${op.words.join(' ')}</ins>`);
      } else if (op.type === 'del') {
        parts.push(`<del${authorAttrs}>${op.words.join(' ')}</del>`);
      } else if (op.type === 'charDiff') {
        for (const cd of op.ops) {
          if (cd.type === 'keep') {
            parts.push(cd.text);
          } else if (cd.type === 'add') {
            parts.push(`<ins${authorAttrs}>${cd.text}</ins>`);
          } else if (cd.type === 'del') {
            parts.push(`<del${authorAttrs}>${cd.text}</del>`);
          }
        }
      }
    }
    return parts.join(' ');
  }

  // --- Array overload: (ops) → refined ops array (original behavior) ---
  const ops = opsOrOldText;
  const refined = [];
  for (let i = 0; i < ops.length; i++) {
    if (ops[i].type === 'del' && i + 1 < ops.length && ops[i + 1].type === 'add') {
      const oldText = ops[i].words.join(' ');
      const newText = ops[i + 1].words.join(' ');
      const longer = Math.max(oldText.length, newText.length);

      // Only refine if the strings share enough common characters (≥50%)
      const charDiff = diffChars(oldText, newText);
      const commonLen = charDiff.filter(d => d.type === 'keep').reduce((s, d) => s + d.text.length, 0);

      if (longer > 0 && commonLen / longer >= 0.5) {
        refined.push({ type: 'charDiff', ops: charDiff });
        i++; // skip the 'add' op
      } else {
        refined.push(ops[i]);
      }
    } else {
      refined.push(ops[i]);
    }
  }
  return refined;
}

/**
 * Strip HTML tags from a string to get plain text.
 */
export function stripHtml(html) {
  if (!html) return '';
  return html.replace(/<[^>]+>/g, '').replace(/\u200B/g, '');
}

/**
 * Get the "visible" plain text from an HTML string for Track Changes snapshots.
 * Includes text from <ins> nodes but excludes text inside <del> nodes.
 * This represents the "current accepted state" — what the user sees as their text.
 *
 * Works on an HTML string (not a live DOM node) so it can be used during
 * snapshot creation from block.html.
 */
export function getVisibleTextFromHtml(html) {
  if (!html) return '';
  // Remove <del ...>...</del> blocks (including nested content)
  const withoutDel = html.replace(/<del\b[^>]*>[\s\S]*?<\/del>/gi, '');
  // Strip remaining HTML tags and zero-width spaces
  return withoutDel.replace(/<[^>]+>/g, '').replace(/\u200B/g, '');
}

/**
 * Get the "visible" plain text from a live DOM container.
 * Includes text from <ins> nodes but excludes text inside <del> nodes.
 */
export function getVisibleText(container) {
  if (!container) return '';
  const parts = [];
  function walk(node) {
    if (node.nodeType === 3) {
      parts.push(node.textContent.replace(/\u200B/g, ''));
    } else if (node.nodeType === 1) {
      if (node.tagName.toLowerCase() === 'del') return;
      for (const child of node.childNodes) walk(child);
    }
  }
  walk(container);
  return parts.join('');
}

/**
 * Apply diff annotations to a DOM container.
 *
 * Algorithm:
 * 1. Get visible text BEFORE modifying DOM (excludes <del>, includes <ins> text)
 * 2. Diff snapshot vs visible text → add/del/keep operations
 * 3. Strip existing annotations (unwrap <ins>, remove <del> entirely)
 * 4. Now container text = visible text. Apply diff to this clean state.
 * 5. <del> elements are created with contentEditable="false" to prevent
 *    the browser from placing the caret inside them.
 *
 * @param {HTMLElement} container - The contentEditable DOM element
 * @param {string} snapshotText - Original plain text (from when TC was enabled)
 * @returns {boolean} Whether any changes were annotated
 */
export function annotateDomWithDiff(container, snapshotText) {
  // Step 1: Get visible text BEFORE modifying the DOM
  const visibleText = getVisibleText(container);
  if (visibleText === snapshotText) {
    cleanupAnnotations(container);
    return false;
  }

  const rawDiff = diffWords(snapshotText, visibleText);
  if (rawDiff.length === 0) {
    cleanupAnnotations(container);
    return false;
  }

  // Check if there are actual add/del operations (not just keeps)
  const hasChanges = rawDiff.some(op => op.type !== 'keep');
  if (!hasChanges) {
    cleanupAnnotations(container);
    return false;
  }

  // Step 2: Remove existing annotations
  // - <ins>: unwrap (keep content — it's part of visible text)
  // - <del>: remove entirely (content is NOT in visible text; diff will re-insert)
  const insNodes = Array.from(container.querySelectorAll('ins.mark-add'));
  for (const ins of insNodes) {
    const parent = ins.parentNode;
    while (ins.firstChild) {
      parent.insertBefore(ins.firstChild, ins);
    }
    parent.removeChild(ins);
  }

  const delNodes = Array.from(container.querySelectorAll('del.mark-del'));
  for (const del of delNodes) {
    del.parentNode.removeChild(del);
  }

  container.normalize();

  // Step 3: Collect text nodes. Container text should now equal visibleText.
  const textNodes = [];
  function walkTextNodes(node) {
    if (node.nodeType === 3) {
      const text = node.textContent.replace(/\u200B/g, '');
      if (text) textNodes.push(node);
    } else if (node.nodeType === 1) {
      for (const child of node.childNodes) walkTextNodes(child);
    }
  }
  walkTextNodes(container);

  // Build flat string from text nodes
  let flatText = '';
  const nodeMap = [];
  for (const tn of textNodes) {
    const text = tn.textContent.replace(/\u200B/g, '');
    const start = flatText.length;
    flatText += text;
    nodeMap.push({ node: tn, start, end: flatText.length });
  }

  // Apply character-level refinement to consecutive del→add pairs
  const diff = refineWordDiff(rawDiff);

  // Step 4: Map diff ops to character positions
  const addRanges = [];
  const delInsertions = [];
  let pos = 0;

  for (const op of diff) {
    if (op.type === 'charDiff') {
      // Character-level refined diff: interleaved keep/add/del within a word
      for (const cd of op.ops) {
        if (cd.type === 'keep') {
          pos += cd.text.length;
        } else if (cd.type === 'add') {
          const idx = flatText.indexOf(cd.text, pos);
          if (idx >= 0) {
            addRanges.push({ start: idx, end: idx + cd.text.length });
            pos = idx + cd.text.length;
          } else {
            addRanges.push({ start: pos, end: pos + cd.text.length });
            pos += cd.text.length;
          }
        } else if (cd.type === 'del') {
          delInsertions.push({ charPos: pos, text: cd.text });
        }
      }
    } else {
      const text = op.words.join(' ');
      if (op.type === 'keep') {
        const idx = flatText.indexOf(text, pos);
        if (idx >= 0) {
          pos = idx + text.length;
        } else {
          pos += text.length;
        }
      } else if (op.type === 'add') {
        const idx = flatText.indexOf(text, pos);
        if (idx >= 0) {
          addRanges.push({ start: idx, end: idx + text.length });
          pos = idx + text.length;
        } else {
          addRanges.push({ start: pos, end: pos + text.length });
          pos += text.length;
        }
      } else if (op.type === 'del') {
        delInsertions.push({ charPos: pos, text });
      }
    }
  }

  // Step 5: Apply add annotations (reverse order to preserve positions)
  for (let r = addRanges.length - 1; r >= 0; r--) {
    const range = addRanges[r];
    wrapRangeInElement(container, nodeMap, range.start, range.end, 'ins', 'mark-add');
  }

  // Step 6: Insert del elements (non-editable to prevent caret entry)
  for (let d = delInsertions.length - 1; d >= 0; d--) {
    const { charPos, text } = delInsertions[d];
    const doc = container.ownerDocument;
    const delNode = doc.createElement('del');
    delNode.className = 'mark-del';
    delNode.textContent = text;
    // CRITICAL: Prevent caret from entering <del> elements.
    // Without this, the browser places the caret inside the del node,
    // causing new typed text to inherit red strikethrough styling.
    delNode.contentEditable = 'false';

    const textNodesNow = [];
    collectTextNodes(container, textNodesNow);
    let currentPos = 0;
    let inserted = false;
    for (const tn of textNodesNow) {
      const len = tn.textContent.replace(/\u200B/g, '').length;
      if (charPos <= currentPos + len) {
        const offset = charPos - currentPos;
        if (offset > 0 && offset < tn.textContent.length) {
          const after = tn.splitText(offset);
          after.parentNode.insertBefore(delNode, after);
        } else {
          tn.parentNode.insertBefore(delNode, offset === 0 ? tn : tn.nextSibling);
        }
        inserted = true;
        break;
      }
      currentPos += len;
    }
    if (!inserted) {
      container.appendChild(delNode);
    }
    // Insert a space text node after the del for visual separation
    // (kept outside del so it isn't removed when del is accepted)
    const spaceNode = doc.createTextNode(' ');
    if (delNode.nextSibling) {
      delNode.parentNode.insertBefore(spaceNode, delNode.nextSibling);
    } else {
      delNode.parentNode.appendChild(spaceNode);
    }
  }

  return true;
}

/**
 * Remove stale annotations when there are no actual changes.
 */
function cleanupAnnotations(container) {
  const insNodes = Array.from(container.querySelectorAll('ins.mark-add'));
  for (const ins of insNodes) {
    const parent = ins.parentNode;
    while (ins.firstChild) parent.insertBefore(ins.firstChild, ins);
    parent.removeChild(ins);
  }
  const delNodes = Array.from(container.querySelectorAll('del.mark-del'));
  for (const del of delNodes) {
    del.parentNode.removeChild(del);
  }
  container.normalize();
}

/**
 * Collect text nodes from a container, skipping ins/del elements.
 * Used after add annotations are applied to find positions for del insertions.
 */
function collectTextNodes(node, result) {
  if (node.nodeType === 3) {
    const text = node.textContent.replace(/\u200B/g, '');
    if (text) result.push(node);
  } else if (node.nodeType === 1) {
    const tag = node.tagName.toLowerCase();
    if (tag === 'ins' || tag === 'del') return;
    for (const child of node.childNodes) collectTextNodes(child, result);
  }
}

/**
 * Wrap a character range across text nodes in an element.
 */
function wrapRangeInElement(container, nodeMap, start, end, tagName, className) {
  const doc = container.ownerDocument;

  for (const nm of nodeMap) {
    const nodeStart = nm.start;
    const nodeEnd = nm.end;
    const node = nm.node;

    const overlapStart = Math.max(start, nodeStart);
    const overlapEnd = Math.min(end, nodeEnd);
    if (overlapStart >= overlapEnd) continue;

    if (node.parentNode && node.parentNode.tagName &&
        node.parentNode.tagName.toLowerCase() === tagName) continue;

    const textContent = node.textContent;
    const localStart = overlapStart - nodeStart;
    const localEnd = overlapEnd - nodeStart;

    if (localStart === 0 && localEnd === textContent.length) {
      const wrapper = doc.createElement(tagName);
      wrapper.className = className;
      node.parentNode.insertBefore(wrapper, node);
      wrapper.appendChild(node);
    } else {
      let targetNode = node;
      if (localStart > 0) {
        targetNode = node.splitText(localStart);
      }
      if (localEnd - localStart < targetNode.textContent.length) {
        targetNode.splitText(localEnd - localStart);
      }
      const wrapper = doc.createElement(tagName);
      wrapper.className = className;
      targetNode.parentNode.insertBefore(wrapper, targetNode);
      wrapper.appendChild(targetNode);
    }
  }
}
