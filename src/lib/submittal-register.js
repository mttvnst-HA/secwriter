/**
 * Submittal Register Compilation.
 *
 * Extracts all SUB marks from the document, groups them by SD category,
 * and produces a structured register matching SpecsIntact legacy format.
 *
 * Columns: Line, Specification Section, SD#, Submittal Description, Item Submitted,
 *          Paragraph#, Classification (GOVT or A/E Reviewer)
 */

import { getVisibleTextFromHtml } from "./text-diff.js";
import { computeNumbering } from "./numbering.js";

const SUB_SPAN_RE = /<span\s+class="mark-sub"[^>]*>((?:[^<]|<(?!\/span>))*)<\/span>/g;
const SD_RE = /^SD-(\d+)\s+(.+)/;
const CLASSIFICATION_RE = /^[A-Z]{1,3}$/; // G, A/E, etc.

/**
 * Extract all submittal items from blocks, with classification and paragraph info.
 * Returns array of { itemName, classification, blockId, part, sectionNumber, sectionTitle, sdNumber, sdTitle }
 */
export function extractSubmittals(blocks) {
  const numberMap = computeNumbering(blocks);

  // Build section title + number lookup
  const sectionInfo = new Map();
  for (const b of blocks) {
    if (b.type === 'title' && b.html) {
      sectionInfo.set(b.id, {
        title: getVisibleTextFromHtml(b.html).trim(),
        number: numberMap[b.id] || '',
      });
    }
  }

  const items = [];
  let currentSD = null; // { number, title }

  for (const block of blocks) {
    if (!block.html) continue;

    // Parse all SUB spans from this block
    SUB_SPAN_RE.lastIndex = 0;
    const spans = [];
    let m;
    while ((m = SUB_SPAN_RE.exec(block.html)) !== null) {
      // Strip nested tags to get plain text
      const plainText = m[1].replace(/<[^>]+>/g, '').trim();
      if (!plainText) continue;
      spans.push(plainText);
    }

    if (spans.length === 0) continue;

    // Check if first span is an SD header
    const sdMatch = spans[0].match(SD_RE);
    if (sdMatch && (block.type === 'lst' || block.type === 'item')) {
      currentSD = { number: parseInt(sdMatch[1]), title: sdMatch[2] };
      // SD headers are not submittal items themselves — skip to next block
      if (spans.length === 1) continue;
      // If there are more spans after the SD header, process them below
      spans.shift();
    }

    // Process remaining spans: item name, then classification
    // Pattern: "Item Name" ; "G" → two SUB spans, second is classification
    // Or just "Item Name" with no classification
    let itemName = null;
    let classification = '';

    for (const text of spans) {
      if (CLASSIFICATION_RE.test(text)) {
        // This is a classification code (G, etc.)
        classification = text;
      } else if (!itemName) {
        itemName = text;
      }
      // Ignore additional spans (like TAI content)
    }

    if (!itemName) continue;

    // Get paragraph number from the block's section
    const secId = block.section;
    const sec = secId ? sectionInfo.get(secId) : null;

    items.push({
      itemName,
      classification,
      blockId: block.id,
      part: block.part,
      sectionNumber: sec?.number || '',
      sectionTitle: sec?.title || '',
      sdNumber: currentSD?.number || null,
      sdTitle: currentSD?.title || '',
    });
  }

  return items;
}

/**
 * Group submittal items by SD category.
 * Returns array of { sd, sdNumber, title, items }
 */
export function groupBySD(items) {
  const groups = new Map();
  for (const item of items) {
    const key = item.sdNumber || 0;
    if (!groups.has(key)) {
      groups.set(key, {
        sd: item.sdNumber ? `SD-${String(item.sdNumber).padStart(2, '0')}` : 'SD-??',
        sdNumber: item.sdNumber || 0,
        title: item.sdTitle || 'Uncategorized',
        items: [],
      });
    }
    groups.get(key).items.push(item);
  }
  // Sort by SD number
  return [...groups.values()].sort((a, b) => a.sdNumber - b.sdNumber);
}

/**
 * Compile a complete submittal register.
 */
export function compileRegister(blocks, sectionMeta) {
  const items = extractSubmittals(blocks);
  const groups = groupBySD(items);
  const specSection = sectionMeta?.sectionNumber || '';
  return { totalItems: items.length, groups, specSection };
}

/**
 * Generate a printable HTML submittal register report (SpecsIntact legacy format).
 */
export function generateRegisterReport(register, sectionMeta) {
  const { sectionNumber, sectionTitle } = sectionMeta || {};
  let lineNum = 0;

  const rows = register.groups.map(g => {
    const itemRows = g.items.map(item => {
      lineNum++;
      return `<tr>
        <td class="c">${lineNum}</td>
        <td class="c">${escHtml(item.sectionNumber ? sectionNumber || '' : '')}</td>
        <td class="c">${g.sdNumber || ''}</td>
        <td>${escHtml(g.title)}</td>
        <td>${escHtml(item.itemName)}</td>
        <td class="c">${escHtml(item.sectionNumber)}</td>
        <td class="c">${escHtml(item.classification)}</td>
      </tr>`;
    }).join('');
    return itemRows;
  }).join('');

  return `<!DOCTYPE html>
<html><head>
<title>Submittal Register — ${escHtml(sectionNumber || '')} ${escHtml(sectionTitle || '')}</title>
<style>
  body { font-family: Inter, 'Segoe UI', sans-serif; max-width: 960px; margin: 24px auto; color: #1e293b; }
  h1 { font-size: 18px; margin-bottom: 4px; }
  h2 { font-size: 14px; color: #64748b; font-weight: 400; margin-top: 0; }
  table { border-collapse: collapse; width: 100%; margin-top: 16px; font-size: 12px; }
  th { background: #334155; color: white; padding: 6px 8px; text-align: left; border: 1px solid #334155; font-size: 11px; }
  td { padding: 4px 8px; border: 1px solid #ddd; }
  td.c { text-align: center; }
  tr:nth-child(even) { background: #f8fafc; }
  .summary { font-size: 12px; color: #64748b; margin-top: 8px; }
  @media print { body { margin: 0; } }
</style>
</head><body>
<h1>Submittal Register</h1>
<h2>${escHtml(sectionNumber || '')} — ${escHtml(sectionTitle || '')}</h2>
<p class="summary">${register.totalItems} submittal item${register.totalItems !== 1 ? 's' : ''} in ${register.groups.length} categor${register.groups.length !== 1 ? 'ies' : 'y'}</p>
<table>
<thead><tr>
  <th style="width:40px;">Line</th>
  <th style="width:90px;">Spec Section</th>
  <th style="width:40px;">SD #</th>
  <th>Submittal Description</th>
  <th>Item Submitted</th>
  <th style="width:80px;">Paragraph #</th>
  <th style="width:90px;">Classification</th>
</tr></thead>
<tbody>${rows}</tbody>
</table>
<p class="summary" style="margin-top:16px;">Generated ${new Date().toLocaleDateString()}</p>
</body></html>`;
}

function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
