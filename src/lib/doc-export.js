/**
 * Document Export — generates formatted HTML for Print/PDF and Word (.doc) export.
 *
 * Both formats use the same HTML generation with Word-compatible CSS.
 * - Print/PDF: opens in new window with window.print()
 * - Word: saves as .doc file (Word opens HTML files with .doc extension)
 */

import { getVisibleTextFromHtml } from "./text-diff.js";
import { computeNumbering } from "./numbering.js";

/**
 * Generate a fully formatted HTML document from blocks.
 * @param {Array} blocks
 * @param {{ sectionNumber, sectionTitle, date }} sectionMeta
 * @param {{ showNotes: boolean, unitDisplay: 'both'|'eng'|'met' }} options
 * @returns {string} Complete HTML document string
 */
export function generateExportHtml(blocks, sectionMeta, options = {}) {
  const { sectionNumber, sectionTitle, date } = sectionMeta || {};
  const { showNotes = true, unitDisplay = 'both' } = options;
  const numberMap = computeNumbering(blocks);

  const bodyContent = [];

  // UFGS Header
  bodyContent.push(`
    <div class="ufgs-header">
      <div class="agency">USACE / NAVFAC / AFCEC</div>
      <div class="ufgs-number">UFGS-${esc(sectionNumber || '')} (${esc(date || '')})</div>
      <div class="ufgs-label">UNIFIED FACILITIES GUIDE SPECIFICATIONS</div>
      <div class="section-number">SECTION ${esc(sectionNumber || '')}</div>
      <div class="section-title">${esc(sectionTitle || '')}</div>
      <div class="section-date">${esc(date || '')}</div>
    </div>
    <hr class="header-rule"/>
  `);

  for (const block of blocks) {
    // Skip notes if hidden
    if (block.type === 'note' && !showNotes) continue;

    // Page break
    if (block.type === 'pagebreak') {
      bodyContent.push('<div class="page-break"></div>');
      continue;
    }

    // Title
    if (block.type === 'title') {
      const num = numberMap[block.id] || '';
      const text = block.html ? getVisibleTextFromHtml(block.html) : '';
      const depth = block.depth || 0;
      if (depth === 0) {
        bodyContent.push(`<h1 class="part-title"><span class="title-num">PART ${block.part}</span> ${esc(text)}</h1>`);
        bodyContent.push('<hr class="part-rule"/>');
      } else {
        const tag = depth <= 2 ? 'h2' : 'h3';
        bodyContent.push(`<${tag} class="section-heading depth-${depth}"><span class="title-num">${esc(num)}</span> ${esc(text)}</${tag}>`);
      }
      continue;
    }

    // Table
    if (block.type === 'table' && block.table) {
      bodyContent.push(renderTable(block.table));
      continue;
    }

    // Ref block
    if (block.type === 'ref' && block.ref) {
      bodyContent.push(renderRef(block.ref));
      continue;
    }

    // Text blocks (txt, note, oli, item, lst)
    if (block.html) {
      let html = processInlineHtml(block.html, unitDisplay);
      const cls = block.type === 'note' ? 'block-note' :
                  block.type === 'oli' ? 'block-oli' :
                  block.type === 'item' ? 'block-item' :
                  block.type === 'lst' ? 'block-lst' : 'block-txt';
      bodyContent.push(`<div class="${cls}">${html}</div>`);
    }
  }

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8"/>
<title>${esc(sectionNumber || 'UFGS')} — ${esc(sectionTitle || 'Specification')}</title>
${getStyles()}
</head>
<body>
${bodyContent.join('\n')}
<div class="footer-info">
  <span>${esc(sectionNumber || '')} — ${esc(sectionTitle || '')}</span>
  <span>Page <span class="page-number"></span></span>
</div>
</body>
</html>`;
}

/** Process inline HTML: strip comment spans, handle unit visibility */
function processInlineHtml(html, unitDisplay) {
  // Strip comment marks
  let result = html.replace(/<span\s+class="mark-comment[^"]*"[^>]*>/g, '').replace(/<\/span>/g, (m, offset, str) => {
    // Only strip closing spans that matched comment opens — this is imprecise but safe
    return '</span>';
  });
  // Simpler: strip all mark-comment spans properly
  result = html.replace(/<span\s+class="mark-comment[^"]*"[^>]*>([\s\S]*?)<\/span>/g, '$1');

  // Handle unit display
  if (unitDisplay === 'eng') {
    result = result.replace(/<span\s+class="mark-met"[^>]*>[\s\S]*?<\/span>/g, '');
  } else if (unitDisplay === 'met') {
    result = result.replace(/<span\s+class="mark-eng"[^>]*>[\s\S]*?<\/span>/g, '');
  }

  return result;
}

/** Render a table block as HTML */
function renderTable(table) {
  const rows = table.rows.map((row, ri) => {
    const cells = row.map(cell => {
      const tag = ri === 0 ? 'th' : 'td';
      const cs = cell.colspan > 1 ? ` colspan="${cell.colspan}"` : '';
      return `<${tag}${cs}>${esc(cell.text || '')}</${tag}>`;
    }).join('');
    return `<tr>${cells}</tr>`;
  }).join('\n');
  return `<table class="spec-table">\n${rows}\n</table>`;
}

/** Render a reference block as HTML */
function renderRef(ref) {
  const entries = (ref.entries || []).map(e =>
    `<div class="ref-entry"><span class="ref-rid">${esc(e.rid)}</span> ${esc(e.rtl)}</div>`
  ).join('\n');
  return `<div class="ref-block">
    <div class="ref-org">${esc(ref.org)}</div>
    ${entries}
  </div>`;
}

function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** CSS styles for the exported document */
function getStyles() {
  return `<style>
  @page {
    size: letter;
    margin: 1in 1in 1in 1in;
    @bottom-center { content: counter(page); }
  }
  body {
    font-family: 'Times New Roman', Times, serif;
    font-size: 12pt;
    line-height: 1.5;
    color: #000;
    max-width: 7in;
    margin: 0 auto;
    padding: 0.5in;
  }
  .ufgs-header { text-align: center; margin-bottom: 12pt; }
  .agency { font-size: 10pt; color: #555; }
  .ufgs-number { font-size: 10pt; color: #555; }
  .ufgs-label { font-size: 9pt; color: #888; letter-spacing: 0.1em; margin-top: 6pt; }
  .section-number { font-size: 16pt; font-weight: bold; margin-top: 8pt; }
  .section-title { font-size: 14pt; font-weight: bold; }
  .section-date { font-size: 10pt; color: #555; margin-bottom: 12pt; }
  .header-rule { border: none; border-top: 2px solid #000; margin: 12pt 0; }
  .part-rule { border: none; border-top: 1px solid #000; margin: 6pt 0 12pt; }

  h1.part-title { font-size: 14pt; font-weight: bold; text-transform: uppercase; margin: 18pt 0 6pt; page-break-after: avoid; }
  h2.section-heading { font-size: 12pt; font-weight: bold; margin: 14pt 0 6pt; page-break-after: avoid; }
  h3.section-heading { font-size: 12pt; font-weight: bold; margin: 10pt 0 4pt; page-break-after: avoid; }
  .title-num { margin-right: 24pt; font-family: 'Courier New', monospace; font-size: 11pt; }

  .block-txt { margin: 0 0 6pt; text-indent: 0; margin-left: 0.16in; }
  .block-note {
    margin: 4pt 0.89in 4pt 0.16in;
    padding: 6pt 8pt;
    border-left: 2pt solid #d97706;
    background: #fffbeb;
    color: #92400e;
    font-style: normal;
  }
  .block-oli { margin: 0 0 4pt; margin-left: 0.5in; }
  .block-item { margin: 0 0 4pt; margin-left: 0.85in; }
  .block-lst { margin: 6pt 0 4pt; margin-left: 0.5in; font-weight: 600; }

  .spec-table { border-collapse: collapse; width: 100%; margin: 12pt 0; font-size: 11pt; }
  .spec-table th, .spec-table td { border: 1px solid #000; padding: 4pt 6pt; vertical-align: top; }
  .spec-table th { font-weight: bold; text-align: left; }

  .ref-block { margin: 8pt 0 8pt 0.16in; }
  .ref-org { font-weight: bold; font-size: 11pt; margin-bottom: 4pt; }
  .ref-entry { margin-left: 0.5in; margin-bottom: 2pt; }
  .ref-rid { font-family: 'Courier New', monospace; font-weight: 600; margin-right: 8pt; }

  /* Inline marks — render as styled text in export */
  .mark-rid, .mark-srf { font-family: 'Courier New', monospace; }
  .mark-eng { color: #1d4ed8; }
  .mark-met { color: #b91c1c; }
  .mark-sub { color: #1e40af; }

  /* Track changes in export */
  ins.mark-add { color: #008000; text-decoration: underline; }
  del.mark-del { color: #ff4444; text-decoration: line-through; }

  .page-break { page-break-before: always; height: 0; }

  .footer-info {
    display: none; /* shown only in print */
  }

  @media print {
    body { padding: 0; margin: 0; max-width: none; }
    .footer-info {
      display: flex;
      justify-content: space-between;
      position: fixed;
      bottom: 0;
      left: 0;
      right: 0;
      font-size: 9pt;
      color: #555;
      border-top: 1px solid #ccc;
      padding: 4pt 0.5in;
    }
  }

  /* Word-specific: mso styles for proper rendering in Microsoft Word */
  @media screen {
    .page-break { border-top: 2px dashed #cbd5e1; margin: 16pt 0; text-align: center; }
    .page-break::after { content: 'PAGE BREAK'; font-size: 8pt; color: #94a3b8; position: relative; top: -8pt; background: white; padding: 0 8pt; }
  }
</style>`;
}
