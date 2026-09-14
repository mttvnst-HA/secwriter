/**
 * html-text.js
 *
 * Shared HTML-to-plain-text primitives used by the editor's compliance/diff
 * engines and by the Node dev tools (tools/*.mjs) that parse .SEC/HTML text
 * outside the browser. Centralized here so every call site gets the same
 * two defenses CodeQL's sanitization queries look for:
 *
 * - `stripTags` loops until a pass removes nothing, so a malformed/nested
 *   tag (e.g. "<<script>script>") can't leave a residual tag-like construct
 *   behind after a single pass (js/incomplete-multi-character-sanitization).
 * - `decodeEntities` decodes all known entities in ONE regex pass instead of
 *   chaining separate `.replace()` calls. Chaining is order-sensitive: if
 *   `&amp;` is decoded before `&lt;`, an already-escaped sequence like
 *   "&amp;lt;" (literal text "&lt;") is corrupted into "<" because the
 *   decoded "&lt;" gets re-decoded by the next step (js/double-escaping).
 *   A single pass only ever decodes each entity occurrence once.
 */

// Zero-width space (U+200B), built via fromCharCode rather than a regex
// escape so the source never contains the literal escape sequence that
// tooling tends to mis-decode (.claude/rules/testing.md #6).
const ZERO_WIDTH_SPACE_RE = new RegExp(String.fromCharCode(0x200b), 'g');

const ENTITY_RE = /&(amp|lt|gt|quot|apos|#39|nbsp);/g;
const ENTITY_CHARS = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  '#39': "'",
  nbsp: ' ',
};

/**
 * Remove all `<...>` tags from a string, re-scanning until a pass leaves the
 * string unchanged. `replacement` (default '') is substituted for each tag —
 * pass ' ' to avoid fusing words that were separated only by a tag boundary.
 */
export function stripTags(html, replacement = '') {
  if (!html) return '';
  let prev;
  let result = html;
  do {
    prev = result;
    result = result.replace(/<[^>]*>/g, replacement);
  } while (result !== prev);
  return result;
}

/**
 * Decode `&amp; &lt; &gt; &quot; &apos; &#39; &nbsp;` in a single pass.
 */
export function decodeEntities(str) {
  if (!str) return '';
  return str.replace(ENTITY_RE, (_, name) => ENTITY_CHARS[name]);
}

/**
 * Strip tags, decode entities, and drop zero-width spaces — the common
 * "give me the plain text of this HTML fragment" operation.
 */
export function htmlToPlainText(html, { replacement = '' } = {}) {
  if (!html) return '';
  return decodeEntities(stripTags(html, replacement)).replace(ZERO_WIDTH_SPACE_RE, '');
}
