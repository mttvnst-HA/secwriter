import { getVisibleTextFromHtml } from "./text-diff.js";

/**
 * Find all [bracketed text] placeholders in blocks.
 * Returns array of { blockId, text, offset, length } where text is the full bracket
 * content including brackets, offset is in visible text.
 */
export function findBrackets(blocks) {
  const results = [];
  for (const block of blocks) {
    if (!block.html) continue;
    const visible = getVisibleTextFromHtml(block.html);
    const re = /\[[^\[\]]+\]/g;
    let m;
    while ((m = re.exec(visible)) !== null) {
      results.push({
        blockId: block.id,
        text: m[0],
        innerText: m[0].slice(1, -1),
        offset: m.index,
        length: m[0].length,
      });
    }
  }
  return results;
}

/**
 * Group bracket results by their inner text for batch replacement.
 * Returns Map<innerText, { count, entries }>.
 */
export function groupBrackets(brackets) {
  const groups = new Map();
  for (const b of brackets) {
    const key = b.innerText;
    if (!groups.has(key)) {
      groups.set(key, { innerText: key, count: 0, entries: [] });
    }
    const g = groups.get(key);
    g.count++;
    g.entries.push(b);
  }
  return groups;
}
