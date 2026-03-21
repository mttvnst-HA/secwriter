/**
 * Cross-reference validation for RID citations and SRF section references.
 *
 * RID: Compares inline RID marks in body text against REF block entries
 * to find unlinked citations and orphaned references.
 *
 * SRF: Document-level analysis — inventories all section references and
 * flags self-references (document citing its own section number).
 */

const RID_SPAN_RE = /<span\s+class="mark-rid"[^>]*>([^<]+)<\/span>/g;
const SRF_SPAN_RE = /<span\s+class="mark-srf"[^>]*>([^<]+)<\/span>/g;

/**
 * Extract all inline RID citations from body blocks (non-ref blocks).
 * @param {Array} blocks
 * @returns {Map<string, string[]>} normalized RID text → array of block IDs where it appears
 */
export function extractInlineRids(blocks) {
  const map = new Map();
  for (const block of blocks) {
    if (block.type === 'ref' || !block.html) continue;
    RID_SPAN_RE.lastIndex = 0;
    let m;
    while ((m = RID_SPAN_RE.exec(block.html)) !== null) {
      const rid = m[1].trim();
      if (!rid) continue;
      if (!map.has(rid)) map.set(rid, []);
      map.get(rid).push(block.id);
    }
  }
  return map;
}

/**
 * Extract all RID entries from REF blocks.
 * @param {Array} blocks
 * @returns {Map<string, string>} normalized RID text → ref block ID
 */
export function extractRefRids(blocks) {
  const map = new Map();
  for (const block of blocks) {
    if (block.type !== 'ref' || !block.ref || !block.ref.entries) continue;
    for (const entry of block.ref.entries) {
      const rid = (entry.rid || '').trim();
      if (rid) map.set(rid, block.id);
    }
  }
  return map;
}

/**
 * Validate RID cross-references between body text and REFERENCES section.
 * @param {Array} blocks
 * @returns {{ unlinked: string[], orphaned: string[] }}
 *   unlinked = RID cited in body but not in any REF block
 *   orphaned = RID in REF block but never cited in body
 */
export function validateRids(blocks) {
  const inlineRids = extractInlineRids(blocks);
  const refRids = extractRefRids(blocks);

  const unlinked = [];
  for (const rid of inlineRids.keys()) {
    if (!refRids.has(rid)) unlinked.push(rid);
  }

  const orphaned = [];
  for (const rid of refRids.keys()) {
    if (!inlineRids.has(rid)) orphaned.push(rid);
  }

  return { unlinked, orphaned };
}

/**
 * Extract all inline SRF section references from body blocks.
 * @param {Array} blocks
 * @returns {Map<string, string[]>} normalized SRF text → array of block IDs where it appears
 */
export function extractInlineSrfs(blocks) {
  const map = new Map();
  for (const block of blocks) {
    if (block.type === 'ref' || !block.html) continue;
    SRF_SPAN_RE.lastIndex = 0;
    let m;
    while ((m = SRF_SPAN_RE.exec(block.html)) !== null) {
      const srf = m[1].trim();
      if (!srf) continue;
      if (!map.has(srf)) map.set(srf, []);
      map.get(srf).push(block.id);
    }
  }
  return map;
}

/**
 * Validate SRF section references at document level.
 * @param {Array} blocks
 * @param {string} sectionNumber - the document's own section number (e.g. "31 00 00")
 * @returns {{ selfReferences: string[], allSrfs: Array<{srf: string, count: number, blockIds: string[]}> }}
 */
export function validateSrfs(blocks, sectionNumber) {
  const srfMap = extractInlineSrfs(blocks);
  const selfReferences = [];
  const allSrfs = [];

  for (const [srf, blockIds] of srfMap) {
    if (sectionNumber && srf === sectionNumber.trim()) {
      selfReferences.push(srf);
    }
    allSrfs.push({ srf, count: blockIds.length, blockIds });
  }

  allSrfs.sort((a, b) => a.srf.localeCompare(b.srf));
  return { selfReferences, allSrfs };
}
