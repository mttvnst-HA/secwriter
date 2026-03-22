/**
 * Offset-aware string replacement in HTML.
 *
 * Replaces a specific occurrence of `match` in `html` based on a plain-text
 * character offset (`targetOffset`). This disambiguates when the same word
 * appears multiple times in a block (e.g., "shall" twice).
 *
 * "Inside a tag" means inside `<...>` angle-bracket syntax (tag names and
 * attributes). Text inside element *content* — including inside
 * `<span class="mark-rid">shall</span>` — is still eligible for replacement.
 *
 * @param {string} html        - The block's innerHTML
 * @param {string} match       - The literal text to find and replace
 * @param {string} replacement - The text to substitute
 * @param {number} [targetOffset] - Plain-text character offset of the target
 *   occurrence. If undefined, null, or negative, falls back to replacing the
 *   first candidate (identical to String.replace behavior).
 * @returns {string} The modified HTML, or the original if no match found
 */
export function replaceAtOffset(html, match, replacement, targetOffset) {
  if (!match || !html) return html;

  const candidates = [];
  let insideTag = false;
  let plainTextOffset = 0;

  for (let i = 0; i < html.length; i++) {
    if (html[i] === '<') {
      insideTag = true;
      continue;
    }
    if (html[i] === '>') {
      insideTag = false;
      continue;
    }

    if (!insideTag) {
      // Check if match starts at this position
      if (html.startsWith(match, i)) {
        candidates.push({ htmlIndex: i, plainTextOffset });
      }
      plainTextOffset++;
    }
  }

  if (candidates.length === 0) return html;

  // Pick the best candidate
  let best = candidates[0];
  const hasValidOffset = typeof targetOffset === 'number' && targetOffset >= 0;

  if (hasValidOffset && candidates.length > 1) {
    let bestDist = Math.abs(best.plainTextOffset - targetOffset);
    for (let i = 1; i < candidates.length; i++) {
      const dist = Math.abs(candidates[i].plainTextOffset - targetOffset);
      if (dist < bestDist) {
        best = candidates[i];
        bestDist = dist;
      }
    }
  }

  return html.slice(0, best.htmlIndex) + replacement + html.slice(best.htmlIndex + match.length);
}
