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

/**
 * Convert a 1-based counter to a letter label.
 * 1->a, 2->b, ... 26->z, 27->aa, 28->ab, etc.
 */
function counterToLetterLabel(n) {
  let result = "";
  while (n > 0) {
    n--; // make 0-based
    result = String.fromCharCode(97 + (n % 26)) + result;
    n = Math.floor(n / 26);
  }
  return result + ".";
}

/**
 * OLI label computation.
 * Generates letter labels (a. b. c.) for level-1 ordered list items
 * and numeric labels (1. 2. 3.) for level-2+ items.
 *
 * Each level has its own independent counter. When transitioning from
 * level-2 back to level-1, the level-1 counter continues where it left off.
 * Resets at each list header (LST) or non-list block.
 */
export function computeOliLabels(blocks) {
  const labelMap = {};
  // Per-level counters (index 0 unused, level 1 = letters, level 2+ = numbers)
  const counters = [0, 0, 0, 0, 0];
  let prevLevel = 0;
  let prevWasListContent = false;

  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (b.type === "oli") {
      const level = b.level || 1;
      const clampedLevel = Math.min(level, counters.length - 1);

      // If we went to a shallower level, reset deeper counters
      if (clampedLevel < prevLevel) {
        for (let j = clampedLevel + 1; j < counters.length; j++) {
          counters[j] = 0;
        }
      }

      counters[clampedLevel]++;
      prevLevel = clampedLevel;

      if (clampedLevel === 1) {
        labelMap[b.id] = counterToLetterLabel(counters[1]);
      } else {
        labelMap[b.id] = counters[clampedLevel] + ".";
      }
      prevWasListContent = true;
    } else if (b.type === "note") {
      // Notes between OLI items don't reset the counter
    } else if (b.type === "lst") {
      for (let j = 0; j < counters.length; j++) counters[j] = 0;
      prevLevel = 0;
      prevWasListContent = true;
    } else {
      if (prevWasListContent) {
        for (let j = 0; j < counters.length; j++) counters[j] = 0;
        prevLevel = 0;
        prevWasListContent = false;
      }
    }
  }
  return labelMap;
}
