/**
 * SEC File Serializer
 *
 * Converts a flat array of editor blocks back into a valid SpecsIntact .SEC
 * XML string. This is the reverse of sec-parser.js.
 *
 * Usage:
 *   import { serializeSEC } from './sec-serializer.js'
 *   const xml = serializeSEC(blocks, metadata)
 */

/**
 * Walk a DOM node tree and convert HTML back to SEC SGML inline tags.
 * This is the reverse of elemToHtml() from sec-parser.js.
 */
function walkNodeToSgml(node) {
  const parts = [];
  for (const child of node.childNodes) {
    if (child.nodeType === 3) { // Text node
      parts.push(child.textContent.replace(/\u200B/g, ''));
    } else if (child.nodeType === 1) { // Element node
      const tag = child.tagName.toLowerCase();
      const inner = walkNodeToSgml(child);

      if (tag === 'span') {
        const cls = child.getAttribute('class') || '';
        const match = cls.match(/\bmark-(\w+)\b/);
        if (match) {
          const secTag = match[1].toUpperCase();
          // Comments are editor-only, strip on export
          if (secTag === 'COMMENT' || secTag === 'COMMENT-RESOLVED') {
            parts.push(inner);
          } else if (secTag === 'TAI') {
            const opt = child.getAttribute('data-opt');
            parts.push(opt ? `<TAI OPT="${opt}">${inner}</TAI>` : `<TAI>${inner}</TAI>`);
          } else {
            parts.push(`<${secTag}>${inner}</${secTag}>`);
          }
        } else {
          parts.push(inner);
        }
      } else if (tag === 'b' || tag === 'strong') {
        parts.push(`<BLD>${inner}</BLD>`);
      } else if (tag === 'em' || tag === 'i') {
        parts.push(`<ITA>${inner}</ITA>`);
      } else if (tag === 'u') {
        parts.push(`<UND>${inner}</UND>`);
      } else if (tag === 'ins') {
        parts.push(`<ADD>${inner}</ADD>`);
      } else if (tag === 'del') {
        parts.push(`<DEL>${inner}</DEL>`);
      } else if (tag === 'br') {
        // Skip line breaks
      } else {
        parts.push(inner);
      }
    }
  }
  return parts.join('');
}

/**
 * Convert editor HTML back to SEC SGML inline tags.
 * Uses DOM parsing to correctly handle nested and cross-nested spans.
 */
function htmlToSgml(html) {
  if (!html) return '';

  // Escape ampersands that aren't already entities for valid XML parsing
  const safeHtml = html.replace(/&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[\da-fA-F]+;)/g, '&amp;');

  const parser = new DOMParser();
  const doc = parser.parseFromString(`<root>${safeHtml}</root>`, 'text/xml');

  // Check for parse errors - fall back to simple regex strip
  const parseError = doc.querySelector('parsererror');
  if (parseError) {
    return html
      .replace(/<[^>]+>/g, '')
      .replace(/\u200B/g, '');
  }

  return walkNodeToSgml(doc.documentElement);
}

/**
 * Serialize a table block back to SEC TAB XML.
 */
function serializeTable(table) {
  if (!table || !table.rows || table.rows.length === 0) return '';

  const cols = table.columns || (table.rows[0] || []).reduce((sum, c) => sum + (c?.colspan || 1), 0);
  const lines = [];
  lines.push('<TAB BORDERS="0">');
  lines.push('<WBK>');
  lines.push('   <STS>');
  lines.push('      <STY SID="s50">');
  lines.push('         <ALN VERTICAL="BOTTOM"/>');
  lines.push('      </STY>');
  lines.push('   </STS>');
  lines.push(`   <TDA COLUMNCOUNT="${cols}" ROWCOUNT="${table.rows.length}">`);

  // Column definitions
  const colWidth = Math.round(450 / cols * 100) / 100;
  for (let i = 0; i < cols; i++) {
    lines.push(`      <COL STYLEID="s50" WIDTH="${colWidth}"/>`);
  }

  // Rows
  for (const row of table.rows) {
    lines.push('      <ROW>');
    for (const cell of row) {
      const mergeAttr = cell.colspan > 1 ? ` MERGEACROSS="${cell.colspan - 1}"` : '';
      const cellContent = htmlToSgml(cell.text || '');
      if (cellContent) {
        lines.push(`         <CEL${mergeAttr} STYLEID="s50">`);
        lines.push(`<DTA TYPE="STRING">${cellContent}</DTA>`);
        lines.push('         </CEL>');
      } else {
        lines.push(`         <CEL${mergeAttr} STYLEID="s50"/>`);
      }
    }
    lines.push('      </ROW>');
  }

  lines.push('   </TDA>');
  lines.push('</WBK>');
  lines.push('</TAB>');
  return lines.join('\r\n');
}

/**
 * Serialize a ref block back to SEC REF XML.
 */
function serializeRef(block) {
  const { org, entries } = block.ref || { org: '', entries: [] };
  const refLines = [];
  refLines.push('<REF>');
  if (org) {
    refLines.push(`<ORG>${htmlToSgml(org)}</ORG>`);
  }
  refLines.push('<BRK/><BRK/>');
  for (const { rid, rtl } of entries) {
    if (rid) {
      refLines.push(`<RID>${htmlToSgml(rid)}</RID>`);
      if (rtl) refLines.push(`<RTL>${htmlToSgml(rtl)}</RTL>`);
      refLines.push('<BRK/><BRK/>');
    }
  }
  refLines.push('</REF>');
  return refLines.join('\r\n');
}

/**
 * Group blocks by structural hierarchy and serialize to SEC XML.
 *
 * @param {Array} blocks - Flat array of editor blocks
 * @param {Object} metadata - Optional metadata (sectionNumber, sectionTitle, date, agency)
 * @returns {string} Valid SEC XML string
 */
export function serializeSEC(blocks, metadata = {}) {
  const {
    sectionNumber = '00 00 00',
    sectionTitle = 'UNTITLED',
    date = '',
    agency = 'USACE / NAVFAC / AFCEC',
  } = metadata;

  const lines = [];

  // XML declaration and root
  lines.push('<?xml version="1.0" encoding="windows-1252"?>');
  lines.push('<SEC xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="http://si.ksc.nasa.gov/sidownloads/xml/specsintactSEC.xsd">');
  lines.push('<MTA NAME="SUBFORMAT" CONTENT="NEW"/>');
  lines.push('<MTA NAME="AUTONUMBER" CONTENT="TRUE"/>');

  // Minimal header
  lines.push('<HDR><AST/>');
  lines.push(`<HL4>UNIFIED FACILITIES GUIDE SPECIFICATIONS</HL4><BRK/>`);
  lines.push('<AST/><BRK/></HDR>');
  lines.push('<BRK/>');
  lines.push(`<SCN>SECTION ${sectionNumber}</SCN><BRK/>`);
  lines.push('<BRK/>');
  lines.push(`<STL>${sectionTitle}</STL><BRK/>`);
  if (date) {
    lines.push(`<DTE>${date}</DTE><BRK/>`);
  }

  // Process blocks - group into structure
  let currentPart = 0;
  let currentDepth = 0;
  let inNote = false;

  // Pre-part blocks (part === 0) - notes, tables, txt
  let firstPartIdx = blocks.findIndex(b => b.part > 0);
  if (firstPartIdx === -1) firstPartIdx = blocks.length;

  const prePartBlocks = blocks.slice(0, firstPartIdx);
  if (prePartBlocks.length > 0) {
    let noteGroupOpen = false;
    for (let i = 0; i < prePartBlocks.length; i++) {
      const block = prePartBlocks[i];
      const nextBlock = prePartBlocks[i + 1];

      if (block.type === 'note') {
        if (!noteGroupOpen) {
          lines.push('<NTE><BRK/>');
          lines.push('<AST/><BRK/>');
          noteGroupOpen = true;
        }
        lines.push(`<NPR>${htmlToSgml(block.html)}</NPR><BRK/>`);
        lines.push('<BRK/>');
        if (!nextBlock || nextBlock.type !== 'note') {
          lines.push('<AST/><BRK/></NTE>');
          lines.push('<BRK/>');
          noteGroupOpen = false;
        }
      } else if (block.type === 'table' && block.table) {
        if (noteGroupOpen) {
          lines.push('<AST/><BRK/></NTE>');
          lines.push('<BRK/>');
          noteGroupOpen = false;
        }
        lines.push(serializeTable(block.table));
        lines.push('<BRK/>');
      } else if (block.type === 'ref' && block.ref) {
        if (noteGroupOpen) {
          lines.push('<AST/><BRK/></NTE>');
          lines.push('<BRK/>');
          noteGroupOpen = false;
        }
        const refXml = serializeRef(block);
        if (block.revision) {
          const tag = block.revision.toUpperCase();
          lines.push(`<${tag}>${refXml}</${tag}>`);
        } else {
          lines.push(refXml);
        }
        lines.push('<BRK/>');
      } else if (block.type === 'pagebreak') {
        if (noteGroupOpen) {
          lines.push('<AST/><BRK/></NTE>');
          lines.push('<BRK/>');
          noteGroupOpen = false;
        }
        lines.push('<NPG/><BRK/>');
      } else if (block.type === 'txt') {
        if (noteGroupOpen) {
          lines.push('<AST/><BRK/></NTE>');
          lines.push('<BRK/>');
          noteGroupOpen = false;
        }
        lines.push(`<TXT>${htmlToSgml(block.html)}</TXT><BRK/>`);
        lines.push('<BRK/>');
      }
    }
    if (noteGroupOpen) {
      lines.push('<AST/><BRK/></NTE>');
      lines.push('<BRK/>');
    }
  }

  // Process remaining blocks (part > 0)
  const partBlocks = blocks.filter(b => b.part > 0);
  if (partBlocks.length === 0) {
    lines.push('</SEC>');
    return lines.join('\r\n');
  }

  // Group into parts
  const parts = new Map();
  for (const block of partBlocks) {
    if (!parts.has(block.part)) parts.set(block.part, []);
    parts.get(block.part).push(block);
  }

  for (const [partNum, partBlockList] of parts) {
    lines.push('<PRT>');

    // Track open SPT depth to close them properly
    let openSptDepth = 0;

    // Track whether we're in a note group
    let noteGroupOpen = false;

    // Helper: close note group if open
    function closeNoteGroup() {
      if (noteGroupOpen) {
        lines.push('<AST/><BRK/></NTE>');
        lines.push('<BRK/>');
        noteGroupOpen = false;
      }
    }

    // Helper: wrap a line in revision tags if block has revision property
    function revWrap(line, block) {
      if (!block.revision) return line;
      const tag = block.revision.toUpperCase();
      return `<${tag}>${line}</${tag}>`;
    }

    // Helper: adjust SPT depth for content blocks
    function adjustDepthForContent(block) {
      while (openSptDepth > block.depth) {
        lines.push('</SPT>');
        openSptDepth--;
      }
    }

    for (let i = 0; i < partBlockList.length; i++) {
      const block = partBlockList[i];
      const nextBlock = partBlockList[i + 1];

      // Title block
      if (block.type === 'title') {
        closeNoteGroup();

        const targetDepth = block.depth;

        // Close SPTs to reach the right depth
        while (openSptDepth > targetDepth) {
          lines.push('</SPT>');
          openSptDepth--;
        }

        // Open new SPTs if needed (depth > 0 means we're in a subpart)
        if (targetDepth > 0) {
          // If we're at the same depth, close the previous SPT first
          if (openSptDepth === targetDepth) {
            lines.push('</SPT>');
            openSptDepth--;
          }
          lines.push('<SPT>');
          openSptDepth = targetDepth;
        }

        lines.push(revWrap(`<TTL>${htmlToSgml(block.html)}</TTL>`, block) + '<BRK/>');
        continue;
      }

      // Note blocks - group consecutive notes into NTE
      if (block.type === 'note') {
        adjustDepthForContent(block);
        if (!noteGroupOpen) {
          lines.push('<NTE><BRK/>');
          lines.push('<AST/><BRK/>');
          noteGroupOpen = true;
        }
        lines.push(revWrap(`<NPR>${htmlToSgml(block.html)}</NPR>`, block) + '<BRK/>');
        lines.push('<BRK/>');

        // Close note group if next block is not a note
        if (!nextBlock || nextBlock.type !== 'note') {
          lines.push('<AST/><BRK/></NTE>');
          lines.push('<BRK/>');
          noteGroupOpen = false;
        }
        continue;
      }

      // Text blocks
      if (block.type === 'txt') {
        closeNoteGroup();
        adjustDepthForContent(block);
        lines.push(revWrap(`<TXT>${htmlToSgml(block.html)}</TXT>`, block) + '<BRK/>');
        lines.push('<BRK/>');
        continue;
      }

      // Ordered list items
      if (block.type === 'oli') {
        closeNoteGroup();
        adjustDepthForContent(block);
        // Check if this is the first OLI in a sequence - wrap in OLG
        const prevBlock = partBlockList[i - 1];
        const isFirstOli = !prevBlock || prevBlock.type !== 'oli';
        if (isFirstOli) {
          lines.push('<OLG>');
        }
        const levelAttr = block.level && block.level > 1 ? ` LEVEL="${block.level}"` : '';
        lines.push(revWrap(`<OLI${levelAttr}>${htmlToSgml(block.html)}</OLI>`, block) + '<BRK/>');
        // Close OLG if next block is not an OLI
        if (!nextBlock || nextBlock.type !== 'oli') {
          lines.push('</OLG>');
        }
        lines.push('<BRK/>');
        continue;
      }

      // List headers
      if (block.type === 'lst') {
        closeNoteGroup();
        adjustDepthForContent(block);
        lines.push(revWrap(`<LST>${htmlToSgml(block.html)}</LST>`, block) + '<BRK/>');
        lines.push('<BRK/>');
        continue;
      }

      // Items (bulleted)
      if (block.type === 'item') {
        closeNoteGroup();
        adjustDepthForContent(block);
        lines.push(revWrap(`<ITM>${htmlToSgml(block.html)}</ITM>`, block) + '<BRK/>');
        lines.push('<BRK/>');
        continue;
      }

      // Reference blocks
      if (block.type === 'ref' && block.ref) {
        closeNoteGroup();
        adjustDepthForContent(block);
        const refXml = serializeRef(block);
        if (block.revision) {
          const tag = block.revision.toUpperCase();
          lines.push(`<${tag}>${refXml}</${tag}>`);
        } else {
          lines.push(refXml);
        }
        lines.push('<BRK/>');
        continue;
      }

      // Tables
      if (block.type === 'table' && block.table) {
        closeNoteGroup();
        adjustDepthForContent(block);
        lines.push(serializeTable(block.table));
        lines.push('<BRK/>');
        continue;
      }
    }

    // Close any remaining open note group
    if (noteGroupOpen) {
      lines.push('<AST/><BRK/></NTE>');
      lines.push('<BRK/>');
    }

    // Close remaining open SPTs
    while (openSptDepth > 0) {
      lines.push('</SPT>');
      openSptDepth--;
    }

    lines.push('</PRT>');
  }

  lines.push('</SEC>');
  return lines.join('\r\n');
}
