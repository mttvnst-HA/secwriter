/**
 * Revision (Tracked Changes) Logic
 *
 * Handles accept/reject operations for ADD/DEL/CHG revision marks,
 * both inline (within block HTML) and block-level (revision property).
 */

// ─── Inline operations (modify block HTML string) ──────────────────────

/**
 * Accept inline ADD: strip <ins class="mark-add"> tags, keep content.
 *
 * The `[^>]*` after `class="mark-add"` matches the per-author attribution
 * attrs (data-author-id, style) that the 1h TC marking pipeline emits.
 * Without it, marks authored by the post-1h per-keystroke rewriter survived
 * "Accept All" (#109 M4 follow-up — paired with the registry flush).
 */
export function acceptInlineAdd(html) {
  if (!html) return html;
  return html
    .replace(/<ins\s+class="mark-add"[^>]*>/g, '')
    .replace(/<\/ins>/g, '');
}

/**
 * Accept inline DEL: remove <del class="mark-del"> tags AND their content.
 * Preserves word boundaries to prevent word concatenation.
 */
export function acceptInlineDel(html) {
  if (!html) return html;
  return html.replace(/<del\s+class="mark-del"[^>]*>[\s\S]*?<\/del>/g, (match, offset, str) => {
    const before = str[offset - 1];
    const after = str[offset + match.length];
    if (before && after && /\w/.test(before) && /\w/.test(after)) return ' ';
    return '';
  }).replace(/ {2,}/g, ' ');
}

/**
 * Reject inline ADD: remove <ins class="mark-add"> tags AND their content.
 * Preserves word boundaries — if removing the ins tag would concatenate two
 * word characters (e.g., "The<ins>...</ins>Contractor" → "TheContractor"),
 * inserts a space to prevent word concatenation.
 *
 * `[^>]*` matches the per-author attribution attrs emitted by the 1h TC
 * marking pipeline (see acceptInlineAdd note).
 */
export function rejectInlineAdd(html) {
  if (!html) return html;
  return html.replace(/<ins\s+class="mark-add"[^>]*>[\s\S]*?<\/ins>/g, (match, offset, str) => {
    const before = str[offset - 1];
    const after = str[offset + match.length];
    // If both adjacent characters are word characters, insert a space
    if (before && after && /\w/.test(before) && /\w/.test(after)) return ' ';
    return '';
  }).replace(/ {2,}/g, ' ');
}

/**
 * Reject inline DEL: strip <del class="mark-del"> tags, keep content (restore).
 */
export function rejectInlineDel(html) {
  if (!html) return html;
  return html
    .replace(/<del\s+class="mark-del"[^>]*>/g, '')
    .replace(/<\/del>/g, '');
}

/**
 * Accept all inline revisions in one block's HTML.
 * ADD content stays, DEL content is removed.
 */
export function acceptAllInline(html) {
  if (!html) return html;
  let result = acceptInlineDel(html);
  result = acceptInlineAdd(result);
  return result;
}

/**
 * Reject all inline revisions in one block's HTML.
 * ADD content is removed, DEL content is restored.
 */
export function rejectAllInline(html) {
  if (!html) return html;
  let result = rejectInlineAdd(html);
  result = rejectInlineDel(result);
  return result;
}

// ─── Block operations (modify blocks array) ────────────────────────────

/**
 * Accept a block-level revision.
 * ADD → clear revision (keep block). DEL → remove block. CHG → clear revision.
 * Returns new blocks array.
 */
export function acceptBlockRevision(blocks, blockId) {
  return blocks.reduce((acc, b) => {
    if (b.id !== blockId) {
      acc.push(b);
    } else if (b.revision === 'del') {
      // Accept deletion = remove the block
    } else {
      // Accept add/chg = keep block, clear revision
      acc.push({ ...b, revision: undefined });
    }
    return acc;
  }, []);
}

/**
 * Reject a block-level revision.
 * ADD → remove block. DEL → clear revision (restore). CHG → clear revision.
 * Returns new blocks array.
 */
export function rejectBlockRevision(blocks, blockId) {
  return blocks.reduce((acc, b) => {
    if (b.id !== blockId) {
      acc.push(b);
    } else if (b.revision === 'add') {
      // Reject addition = remove the block
    } else {
      // Reject del/chg = keep block, clear revision
      acc.push({ ...b, revision: undefined });
    }
    return acc;
  }, []);
}

/**
 * Accept all block and inline revisions.
 * Returns new blocks array with all revisions resolved.
 */
export function acceptAllRevisions(blocks) {
  return blocks.reduce((acc, b) => {
    if (b.revision === 'del') {
      // Accept deletion = remove
      return acc;
    }
    const cleaned = { ...b, revision: undefined };
    if (cleaned.html) {
      cleaned.html = acceptAllInline(cleaned.html);
    }
    acc.push(cleaned);
    return acc;
  }, []);
}

/**
 * Reject all block and inline revisions.
 * Returns new blocks array with all revisions undone.
 */
export function rejectAllRevisions(blocks) {
  return blocks.reduce((acc, b) => {
    if (b.revision === 'add') {
      // Reject addition = remove
      return acc;
    }
    const cleaned = { ...b, revision: undefined };
    if (cleaned.html) {
      cleaned.html = rejectAllInline(cleaned.html);
    }
    acc.push(cleaned);
    return acc;
  }, []);
}

// ─── Stats ─────────────────────────────────────────────────────────────

/**
 * Count revisions across all blocks (both block-level and inline).
 * Returns { adds, dels, chgs }.
 */
export function countRevisions(blocks) {
  let adds = 0, dels = 0, chgs = 0;

  for (const b of blocks) {
    // Block-level
    if (b.revision === 'add') adds++;
    else if (b.revision === 'del') dels++;
    else if (b.revision === 'chg') chgs++;

    // Inline
    if (b.html) {
      const addMatches = b.html.match(/<ins\s+class="mark-add"[^>]*>/g);
      const delMatches = b.html.match(/<del\s+class="mark-del"[^>]*>/g);
      // `[^>]*` matches the per-author attribution attrs emitted by the 1h TC
      // marking pipeline (data-author-id, style). Without it, chgs authored by
      // the per-keystroke rewriter went uncounted — same bug shape as the add
      // and del regexes had pre-#109 (spawned-from-#109 follow-up).
      const chgMatches = b.html.match(/<span\s+class="mark-chg"[^>]*>/g);
      if (addMatches) adds += addMatches.length;
      if (delMatches) dels += delMatches.length;
      if (chgMatches) chgs += chgMatches.length;
    }
  }

  return { adds, dels, chgs };
}
