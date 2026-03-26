/**
 * SEC File Parser
 *
 * Parses SpecsIntact .SEC files (XML-based SGML) into a flat array of
 * content blocks suitable for the editor.
 *
 * Usage (browser):
 *   import { parseSEC } from './sec-parser.js'
 *   const blocks = parseSEC(xmlString)
 *
 * Usage (Node CLI):
 *   node tools/parse-sec.js input.sec output.json
 */

// Inline tags that carry semantic meaning (data-driven)
const INLINE_MARK_TAGS = new Set(['RID', 'SRF', 'SUB', 'ENG', 'MET', 'TAI', 'TST', 'URL', 'HLS', 'ATT']);

// Inline tags that are pure formatting
const INLINE_FORMAT_TAGS = new Set([
  'BLD', 'ITA', 'UND', 'HL1', 'HL2', 'HL3', 'HL4',
  'SBS', 'SPS', 'CTR'
]);

// Tags to skip entirely
const SKIP_TAGS = new Set([
  'BRK', 'BRL', 'AST', 'NED', 'PGE', 'MTA', 'END', 'EOD'
]);

/**
 * Convert an XML element to HTML string with semantic mark spans.
 */
function elemToHtml(elem) {
  const parts = [];

  // Traverse childNodes to build HTML
  for (const node of elem.childNodes) {
    if (node.nodeType === 3) { // Text node
      parts.push(node.textContent.replace(/\n/g, ' '));
    } else if (node.nodeType === 1) { // Element node
      const tag = node.tagName;

      if (INLINE_MARK_TAGS.has(tag)) {
        const cls = `mark-${tag.toLowerCase()}`;
        const inner = elemToHtml(node);
        const opt = (tag === 'TAI') ? node.getAttribute('OPT') : null;
        const optAttr = opt ? ` data-opt="${opt}"` : '';
        parts.push(`<span class="${cls}"${optAttr}>${inner}</span>`);
      } else if (tag === 'ADD') {
        parts.push(`<ins class="mark-add">${elemToHtml(node)}</ins>`);
      } else if (tag === 'DEL') {
        parts.push(`<del class="mark-del">${elemToHtml(node)}</del>`);
      } else if (tag === 'CHG') {
        parts.push(`<span class="mark-chg">${elemToHtml(node)}</span>`);
      } else if (INLINE_FORMAT_TAGS.has(tag)) {
        if (tag === 'BLD' || tag === 'HL3') {
          parts.push(`<b>${elemToHtml(node)}</b>`);
        } else if (tag === 'ITA' || tag === 'HL2') {
          parts.push(`<em>${elemToHtml(node)}</em>`);
        } else if (tag === 'UND' || tag === 'HL1') {
          parts.push(`<u>${elemToHtml(node)}</u>`);
        } else {
          parts.push(elemToHtml(node));
        }
      } else if (SKIP_TAGS.has(tag)) {
        // Skip
      } else if (tag === 'SCP' || tag === 'PRA') {
        parts.push(elemToHtml(node));
      } else {
        parts.push(elemToHtml(node));
      }
    }
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

/**
 * Same as elemToHtml but skips TAB children (for TXT blocks that contain embedded tables).
 */
function elemToHtmlNoTab(elem) {
  const parts = [];
  for (const node of elem.childNodes) {
    if (node.nodeType === 3) {
      parts.push(node.textContent.replace(/\n/g, ' '));
    } else if (node.nodeType === 1) {
      const tag = node.tagName;
      if (tag === 'TAB' || tag === 'WBK' || tag === 'TDA' || tag === 'ROW' ||
          tag === 'CEL' || tag === 'DTA' || tag === 'COL' || tag === 'STS' ||
          tag === 'STY' || tag === 'ALN') {
        // Skip table internals
      } else if (INLINE_MARK_TAGS.has(tag)) {
        const cls = `mark-${tag.toLowerCase()}`;
        const opt = (tag === 'TAI') ? node.getAttribute('OPT') : null;
        const optAttr = opt ? ` data-opt="${opt}"` : '';
        parts.push(`<span class="${cls}"${optAttr}>${elemToHtml(node)}</span>`);
      } else if (tag === 'ADD') {
        parts.push(`<ins class="mark-add">${elemToHtml(node)}</ins>`);
      } else if (tag === 'DEL') {
        parts.push(`<del class="mark-del">${elemToHtml(node)}</del>`);
      } else if (tag === 'CHG') {
        parts.push(`<span class="mark-chg">${elemToHtml(node)}</span>`);
      } else if (INLINE_FORMAT_TAGS.has(tag)) {
        if (tag === 'BLD' || tag === 'HL3') {
          parts.push(`<b>${elemToHtml(node)}</b>`);
        } else if (tag === 'ITA' || tag === 'HL2') {
          parts.push(`<em>${elemToHtml(node)}</em>`);
        } else if (tag === 'UND' || tag === 'HL1') {
          parts.push(`<u>${elemToHtml(node)}</u>`);
        } else {
          parts.push(elemToHtml(node));
        }
      } else if (SKIP_TAGS.has(tag)) {
        // Skip
      } else {
        parts.push(elemToHtml(node));
      }
    }
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

/**
 * Convert a TBL element to HTML, preserving whitespace and converting BRK to newlines.
 * Unlike elemToHtml, this does NOT collapse whitespace — TBL content is preformatted.
 */
function elemToTblHtml(elem) {
  const parts = [];
  for (const node of elem.childNodes) {
    if (node.nodeType === 3) { // Text node — preserve whitespace (only strip leading/trailing newlines)
      parts.push(node.textContent.replace(/^\n|\n$/g, ''));
    } else if (node.nodeType === 1) {
      const tag = node.tagName;
      if (tag === 'BRK' || tag === 'BRL') {
        parts.push('\n');
      } else if (tag === 'THD') {
        // THD rendered as bold header
        parts.push(`<b>${elemToTblHtml(node)}</b>`);
      } else if (tag === 'PGE' || tag === 'AST' || tag === 'NED') {
        // Skip print-only tags
      } else if (INLINE_MARK_TAGS.has(tag)) {
        const cls = `mark-${tag.toLowerCase()}`;
        const opt = (tag === 'TAI') ? node.getAttribute('OPT') : null;
        const optAttr = opt ? ` data-opt="${opt}"` : '';
        parts.push(`<span class="${cls}"${optAttr}>${elemToTblHtml(node)}</span>`);
      } else if (INLINE_FORMAT_TAGS.has(tag)) {
        if (tag === 'BLD' || tag === 'HL3') {
          parts.push(`<b>${elemToTblHtml(node)}</b>`);
        } else if (tag === 'ITA' || tag === 'HL2') {
          parts.push(`<em>${elemToTblHtml(node)}</em>`);
        } else if (tag === 'UND' || tag === 'HL1') {
          parts.push(`<u>${elemToTblHtml(node)}</u>`);
        } else if (tag === 'HL4') {
          parts.push(`<b>${elemToTblHtml(node)}</b>`);
        } else {
          parts.push(elemToTblHtml(node));
        }
      } else {
        parts.push(elemToTblHtml(node));
      }
    }
  }
  return parts.join('');
}

/**
 * Extract a TAB element into a table data structure.
 */
function extractTable(tabElem) {
  const tda = tabElem.querySelector('TDA');
  if (!tda) return null;

  const cols = parseInt(tda.getAttribute('COLUMNCOUNT') || '0');
  const rows = [];

  // Extract cell fill styles from STS > STY > INT
  const styles = {};
  const stsElem = tabElem.querySelector('STS');
  if (stsElem) {
    for (const styElem of stsElem.querySelectorAll('STY')) {
      const sid = styElem.getAttribute('SID');
      const intElem = styElem.querySelector('INT');
      if (sid && intElem) {
        const color = intElem.getAttribute('COLOR');
        const pattern = intElem.getAttribute('PATTERN');
        if (color && pattern === 'SOLID') {
          styles[sid] = { backgroundColor: color };
        }
      }
    }
  }

  // Extract column widths from COL elements
  const colElems = tda.querySelectorAll('COL');
  const colWidths = [];
  for (const col of colElems) {
    const w = col.getAttribute('WIDTH');
    if (w) colWidths.push(parseFloat(w));
  }

  // Extract row heights and cell data from ROW elements
  const rowHeights = [];
  for (const rowElem of tda.querySelectorAll('ROW')) {
    const h = rowElem.getAttribute('HEIGHT');
    rowHeights.push(h ? parseFloat(h) : null);
    const cells = [];
    for (const cel of rowElem.querySelectorAll(':scope > CEL')) {
      const mergeAcross = cel.getAttribute('MERGEACROSS');
      const dta = cel.querySelector('DTA');
      const styleId = cel.getAttribute('STYLEID') || undefined;
      cells.push({
        text: dta ? elemToHtml(dta) : '',
        colspan: mergeAcross ? parseInt(mergeAcross) + 1 : 1,
        styleId,
      });
    }
    rows.push(cells);
  }

  const result = { columns: cols, rows };
  if (Object.keys(styles).length > 0) result.styles = styles;
  if (colWidths.length > 0) result.colWidths = colWidths;
  if (rowHeights.some(h => h !== null)) result.rowHeights = rowHeights;
  return result;
}

/**
 * Parse a .SEC XML string into an array of editor blocks.
 *
 * @param {string} xmlString - The raw .SEC file content
 * @returns {Array} Array of block objects
 */
export function parseSEC(xmlString) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlString, 'text/xml');
  const root = doc.documentElement;

  const blocks = [];
  let nodeId = 0;

  function nextId() {
    return `n${++nodeId}`;
  }

  const state = {
    partNum: 0,
    sptDepth: 0,
    currentSection: null,
  };

  function processElement(elem) {
    const tag = elem.tagName;

    if (tag === 'PRT') {
      state.partNum++;
      state.sptDepth = 0;
      for (const child of elem.children) processElement(child);
      return;
    }

    if (tag === 'SPT') {
      state.sptDepth++;
      for (const child of elem.children) processElement(child);
      state.sptDepth--;
      return;
    }

    if (tag === 'TTL') {
      const html = elemToHtml(elem);
      if (html) {
        const nid = nextId();
        blocks.push({
          id: nid,
          type: 'title',
          part: state.partNum,
          depth: state.sptDepth,
          html,
        });
        state.currentSection = nid;
      }
      return;
    }

    if (tag === 'TXT') {
      const tabChild = elem.querySelector('TAB');
      const html = elemToHtmlNoTab(elem);
      if (html) {
        blocks.push({
          id: nextId(),
          type: 'txt',
          part: state.partNum,
          depth: state.sptDepth,
          section: state.currentSection,
          html,
        });
      }
      if (tabChild) {
        const tdata = extractTable(tabChild);
        if (tdata && tdata.rows.length > 0) {
          blocks.push({
            id: nextId(),
            type: 'table',
            part: state.partNum,
            depth: state.sptDepth,
            section: state.currentSection,
            table: tdata,
          });
        }
      }
      return;
    }

    if (tag === 'NPR') {
      const html = elemToHtml(elem);
      if (html) {
        blocks.push({
          id: nextId(),
          type: 'note',
          part: state.partNum,
          depth: state.sptDepth,
          section: state.currentSection,
          html,
        });
      }
      return;
    }

    if (tag === 'NPG') {
      blocks.push({
        id: nextId(),
        type: 'pagebreak',
        part: state.partNum,
        depth: state.sptDepth,
        section: state.currentSection,
      });
      return;
    }

    if (tag === 'NTE' || tag === 'OLG' || tag === 'SBM') {
      for (const child of elem.children) processElement(child);
      return;
    }

    if (tag === 'OLI') {
      const html = elemToHtml(elem);
      const level = parseInt(elem.getAttribute('LEVEL') || '1');
      if (html) {
        blocks.push({
          id: nextId(),
          type: 'oli',
          part: state.partNum,
          depth: state.sptDepth,
          level,
          section: state.currentSection,
          html,
        });
      }
      return;
    }

    if (tag === 'LST') {
      const html = elemToHtml(elem);
      if (html) {
        blocks.push({
          id: nextId(),
          type: 'lst',
          part: state.partNum,
          depth: state.sptDepth,
          section: state.currentSection,
          html,
        });
      }
      return;
    }

    if (tag === 'ITM') {
      const html = elemToHtml(elem);
      if (html) {
        blocks.push({
          id: nextId(),
          type: 'item',
          part: state.partNum,
          depth: state.sptDepth,
          section: state.currentSection,
          html,
        });
      }
      return;
    }

    if (tag === 'TAB') {
      // Standalone table (not inside TXT)
      const tdata = extractTable(elem);
      if (tdata && tdata.rows.length > 0) {
        blocks.push({
          id: nextId(),
          type: 'table',
          part: state.partNum,
          depth: state.sptDepth,
          section: state.currentSection,
          table: tdata,
        });
      }
      return;
    }

    if (tag === 'TBL') {
      const html = elemToTblHtml(elem);
      if (html) {
        blocks.push({
          id: nextId(),
          type: 'tbl',
          part: state.partNum,
          depth: state.sptDepth,
          section: state.currentSection,
          html,
        });
      }
      return;
    }

    if (tag === 'REF') {
      // Parse structured reference block: ORG + RID/RTL entries
      const orgElem = elem.querySelector('ORG');
      const orgText = orgElem ? elemToHtmlNoTab(orgElem) : '';
      const entries = [];

      // Extract RID/RTL pairs from direct children
      const children = Array.from(elem.children);
      for (let ci = 0; ci < children.length; ci++) {
        const child = children[ci];
        if (child.tagName === 'RID') {
          const rid = elemToHtmlNoTab(child);
          // Look for the following RTL sibling
          let rtl = '';
          for (let ri = ci + 1; ri < children.length; ri++) {
            if (children[ri].tagName === 'RTL') {
              rtl = elemToHtmlNoTab(children[ri]);
              ci = ri; // skip past the RTL
              break;
            }
            if (children[ri].tagName === 'RID') break; // next RID without RTL
          }
          if (rid) entries.push({ rid, rtl });
        }
        // NTE children inside REF — process them normally as separate blocks
        if (child.tagName === 'NTE') {
          for (const sub of child.children) processElement(sub);
        }
      }

      blocks.push({
        id: nextId(),
        type: 'ref',
        part: state.partNum,
        depth: state.sptDepth,
        section: state.currentSection,
        ref: { org: orgText, entries },
      });
      return;
    }

    // Block-level revision wrappers: tag all child blocks with revision type
    if (tag === 'ADD' || tag === 'DEL' || tag === 'CHG') {
      const prevCount = blocks.length;
      for (const child of elem.children) processElement(child);
      const rev = tag.toLowerCase();
      for (let i = prevCount; i < blocks.length; i++) {
        blocks[i].revision = rev;
      }
      return;
    }

    // Recurse into any other container
    for (const child of elem.children) processElement(child);
  }

  // Process root-level children (skip HDR, SCN, STL, DTE, MTA, etc.)
  const ROOT_CONTENT_TAGS = new Set(['NTE', 'PRT', 'TAB', 'TXT']);
  for (const child of root.children) {
    if (child.tagName === 'NTE' && state.partNum === 0) {
      for (const sub of child.children) processElement(sub);
    } else if (child.tagName === 'PRT') {
      processElement(child);
    } else if (ROOT_CONTENT_TAGS.has(child.tagName) && state.partNum === 0) {
      processElement(child);
    }
  }

  return blocks;
}

/**
 * Extract metadata from a .SEC XML string for roundtrip serialization.
 * Separate from parseSEC() — callers use both independently.
 */
export function extractMetadata(xml) {
  const meta = { sectionNumber: '00 00 00', sectionTitle: 'UNTITLED', date: '' };
  const scn = xml.match(/<SCN[^>]*>SECTION\s+([\d\s.]+)<\/SCN>/i);
  if (scn) meta.sectionNumber = scn[1].trim();
  const stl = xml.match(/<STL[^>]*>(.*?)<\/STL>/i);
  if (stl) meta.sectionTitle = stl[1].trim();
  const dte = xml.match(/<DTE[^>]*>(.*?)<\/DTE>/i);
  if (dte) meta.date = dte[1].trim();

  const mta = {};
  const mtaRegex = /<MTA\s+NAME="([^"]+)"\s+CONTENT="([^"]*)"\/>/g;
  let m;
  while ((m = mtaRegex.exec(xml)) !== null) {
    mta[m[1]] = m[2];
  }
  meta.mta = mta;

  // Capture raw HDR block for verbatim roundtrip
  const hdrMatch = xml.match(/<HDR>[\s\S]*?<\/HDR>/);
  if (hdrMatch) meta.rawHeader = hdrMatch[0];

  return meta;
}
