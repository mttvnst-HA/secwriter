/**
 * Section numbering computation.
 * Generates hierarchical numbers (1.1, 1.2.1, etc.) for title blocks.
 */
export function computeNumbering(blocks) {
  const titles = blocks.filter(b => b.type === "title");
  const numberMap = {};
  const counters = [0, 0, 0, 0, 0, 0, 0];
  let currentPart = 0;

  for (const t of titles) {
    const isPart = t.html.startsWith("PART ");
    if (isPart) {
      currentPart++;
      for (let i = 1; i < counters.length; i++) counters[i] = 0;
      numberMap[t.id] = null;
    } else {
      const d = t.depth;
      if (d >= 1 && d < counters.length) {
        counters[d]++;
        for (let i = d + 1; i < counters.length; i++) counters[i] = 0;
        const parts = [currentPart];
        for (let i = 1; i <= d; i++) {
          parts.push(counters[i]);
        }
        numberMap[t.id] = parts.join(".");
      }
    }
  }
  return numberMap;
}

/** Maximum ordered-list nesting depth (UFS 1-300-02 Figure A-1). */
export const MAX_OLI_LEVEL = 4;

/**
 * Convert a 1-based counter to a letter sequence.
 * 1->a, 2->b, ... 26->z, 27->aa, 28->ab, etc.
 */
function counterToLetters(n) {
  let result = "";
  while (n > 0) {
    n--; // make 0-based
    result = String.fromCharCode(97 + (n % 26)) + result;
    n = Math.floor(n / 26);
  }
  return result;
}

/**
 * Local (per-level) label for an OLI item, per UFS 1-300-02 Figure A-1.
 *   Level 1: a. b. c.
 *   Level 2: (1) (2) (3)
 *   Level 3: (a) (b) (c)
 *   Level 4: 1. 2. 3.
 */
function labelForLevel(level, counter) {
  switch (level) {
    case 1: return counterToLetters(counter) + ".";
    case 2: return "(" + counter + ")";
    case 3: return "(" + counterToLetters(counter) + ")";
    case 4: return counter + ".";
    default: return counter + ".";
  }
}

/**
 * Walk a block array, computing per-level counters for OLI items.
 * Returns two parallel maps keyed by block id:
 *   - labels: the local label to render (e.g. "a.", "(1)", "(a)", "1.")
 *   - items:  the cumulative hierarchical path used for the OLI ITEM attribute
 *             (e.g. "a.", "a.(1)", "a.(1)(a)", "a.(1)(a)1.")
 *
 * Each level has its own counter. Returning to a shallower level continues
 * the shallower counter; deeper counters reset. Counters reset on LST
 * headers and non-list/non-note blocks.
 */
function walkOli(blocks) {
  const labels = {};
  const items = {};
  // index 0 unused; levels 1..MAX_OLI_LEVEL
  const counters = new Array(MAX_OLI_LEVEL + 1).fill(0);
  const segs = new Array(MAX_OLI_LEVEL + 1).fill("");
  let prevLevel = 0;
  let prevWasListContent = false;

  const resetAll = () => {
    for (let j = 0; j <= MAX_OLI_LEVEL; j++) {
      counters[j] = 0;
      segs[j] = "";
    }
    prevLevel = 0;
  };

  for (const b of blocks) {
    if (b.type === "oli") {
      const requested = b.level || 1;
      const level = Math.max(1, Math.min(requested, MAX_OLI_LEVEL));

      // Returning to a shallower level clears deeper counters.
      if (level < prevLevel) {
        for (let j = level + 1; j <= MAX_OLI_LEVEL; j++) {
          counters[j] = 0;
          segs[j] = "";
        }
      }

      counters[level]++;
      const local = labelForLevel(level, counters[level]);
      segs[level] = local;
      for (let j = level + 1; j <= MAX_OLI_LEVEL; j++) segs[j] = "";

      labels[b.id] = local;
      let item = "";
      for (let j = 1; j <= level; j++) item += segs[j];
      items[b.id] = item;

      prevLevel = level;
      prevWasListContent = true;
    } else if (b.type === "note") {
      // Notes between OLI items don't reset counters.
    } else if (b.type === "lst") {
      resetAll();
      prevWasListContent = true;
    } else if (prevWasListContent) {
      resetAll();
      prevWasListContent = false;
    }
  }
  return { labels, items };
}

/**
 * OLI label computation.
 * Generates the local label (a., (1), (a), 1.) per UFS 1-300-02 Figure A-1
 * for each OLI block, keyed by block id. See walkOli() for counter rules.
 */
export function computeOliLabels(blocks) {
  return walkOli(blocks).labels;
}

/**
 * OLI ITEM attribute computation.
 * Returns the cumulative hierarchical path for each OLI block (e.g.
 * "a.(1)(a)1."), suitable for serializing as the ITEM attribute.
 */
export function computeOliItems(blocks) {
  return walkOli(blocks).items;
}
