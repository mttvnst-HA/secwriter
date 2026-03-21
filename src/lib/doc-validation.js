import { getVisibleTextFromHtml } from "./text-diff.js";

/**
 * Document validation checks for UFGS specifications.
 * Returns an array of issues, each: { severity, category, message, blockId? }
 * severity: 'error' | 'warning' | 'info'
 */
export function validateDocument(blocks) {
  const issues = [];
  issues.push(...checkStructure(blocks));
  issues.push(...checkTitles(blocks));
  issues.push(...checkEmptyBlocks(blocks));
  issues.push(...checkSubmittals(blocks));
  return issues;
}

/** Structural checks: PART ordering, required PARTs, title hierarchy */
function checkStructure(blocks) {
  const issues = [];
  const parts = blocks.filter(b => b.type === 'title' && b.depth === 0);
  const partNumbers = parts.map(b => b.part);

  // Must have at least PARTs 1, 2, 3
  for (const required of [1, 2, 3]) {
    if (!partNumbers.includes(required)) {
      issues.push({
        severity: 'error',
        category: 'Structure',
        message: `Missing PART ${required}${required === 1 ? ' GENERAL' : required === 2 ? ' PRODUCTS' : ' EXECUTION'}`,
      });
    }
  }

  // PARTs should be in order
  for (let i = 1; i < partNumbers.length; i++) {
    if (partNumbers[i] <= partNumbers[i - 1]) {
      issues.push({
        severity: 'warning',
        category: 'Structure',
        message: `PART ${partNumbers[i]} appears after PART ${partNumbers[i - 1]} (out of order)`,
        blockId: parts[i].id,
      });
    }
  }

  // Check for sections without titles
  let currentPart = null;
  let sectionsInPart = 0;
  for (const block of blocks) {
    if (block.type === 'title' && block.depth === 0) {
      if (currentPart !== null && sectionsInPart === 0) {
        issues.push({
          severity: 'warning',
          category: 'Structure',
          message: `PART ${currentPart} has no subsections`,
          blockId: block.id,
        });
      }
      currentPart = block.part;
      sectionsInPart = 0;
    } else if (block.type === 'title' && block.depth === 1) {
      sectionsInPart++;
    }
  }

  return issues;
}

/** Title checks: length limits, missing text, empty titles */
function checkTitles(blocks) {
  const issues = [];
  const TITLE_MAX_LENGTH = 120;

  for (const block of blocks) {
    if (block.type !== 'title') continue;
    const text = block.html ? getVisibleTextFromHtml(block.html).trim() : '';

    if (!text) {
      issues.push({
        severity: 'error',
        category: 'Title',
        message: `Empty title at depth ${block.depth} in PART ${block.part || '?'}`,
        blockId: block.id,
      });
      continue;
    }

    if (text.length > TITLE_MAX_LENGTH) {
      issues.push({
        severity: 'warning',
        category: 'Title',
        message: `Title exceeds ${TITLE_MAX_LENGTH} chars (${text.length}): "${text.substring(0, 50)}..."`,
        blockId: block.id,
      });
    }
  }

  return issues;
}

/** Check for empty text blocks (no visible content) */
function checkEmptyBlocks(blocks) {
  const issues = [];
  for (const block of blocks) {
    if (block.type === 'title' || block.type === 'table' || block.type === 'ref' || block.type === 'pagebreak') continue;
    if (!block.html) continue; // blocks without html are structural
    const text = getVisibleTextFromHtml(block.html).trim();
    if (!text) {
      issues.push({
        severity: 'info',
        category: 'Content',
        message: `Empty ${block.type.toUpperCase()} block`,
        blockId: block.id,
      });
    }
  }
  return issues;
}

const SUB_SPAN_RE = /<span\s+class="mark-sub"[^>]*>([^<]+)<\/span>/g;

/** Submittal validation: check SUB marks exist in Part 1 Submittals section */
function checkSubmittals(blocks) {
  const issues = [];

  // Find all SUB marks across the document
  const subsByPart = new Map(); // part number → count
  let totalSubs = 0;
  for (const block of blocks) {
    if (!block.html) continue;
    SUB_SPAN_RE.lastIndex = 0;
    let m;
    while ((m = SUB_SPAN_RE.exec(block.html)) !== null) {
      totalSubs++;
      const part = block.part || 0;
      subsByPart.set(part, (subsByPart.get(part) || 0) + 1);
    }
  }

  // Check if there's a Submittals section in Part 1
  const submittalsTitle = blocks.find(b =>
    b.type === 'title' && b.part === 1 &&
    b.html && getVisibleTextFromHtml(b.html).toUpperCase().includes('SUBMITTAL')
  );

  if (totalSubs > 0 && !submittalsTitle) {
    issues.push({
      severity: 'warning',
      category: 'Submittals',
      message: `${totalSubs} submittal item(s) found but no SUBMITTALS section in Part 1`,
    });
  }

  // Check for submittals in Part 1 only (they should reference items in Parts 2/3)
  if (submittalsTitle && totalSubs === 0) {
    issues.push({
      severity: 'info',
      category: 'Submittals',
      message: 'SUBMITTALS section exists but no SUB marks found in document',
      blockId: submittalsTitle.id,
    });
  }

  return issues;
}
