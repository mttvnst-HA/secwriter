/**
 * Pattern recognition for inline marks.
 *
 * Scans text content for patterns that match known UFGS data element types
 * and returns suggestions for marking them. Each pattern maps to a mark type
 * (RID, SRF, ENG/MET).
 *
 * Used by the editor to offer auto-marking as the user types.
 */

/**
 * RID patterns — reference standard citations.
 * Matches organization prefix + alphanumeric designation.
 * Examples: ASTM D2487, ASTM C33/C33M, AASHTO T99, AWWA C600, ACI 318,
 *           ANSI/AISC 360, NFPA 70, UL 263, IEEE 519, MIL-STD-810,
 *           FS SS-S-210, SSPC SP-6, AWS D1.1/D1.1M
 */
const RID_PATTERN = /\b(ASTM|AASHTO|AWWA|ACI|ANSI|NFPA|UL|IEEE|SSPC|AWS|ASME|AISC|SAE|ASHRAE|IESNA|SMACNA|NIST|USACE|NAVFAC|AFI|UFC|FS|MIL|FED|CRD|CE|COE|TM)\s?[-/]?\s?[A-Z]?\d[\w/-]*(?:\.\d[\w/-]*)*/g;

/**
 * SRF patterns — section cross-references.
 * Matches the UFGS section number format: XX XX XX (with optional .XX suffix)
 * Only triggers when preceded by "Section" or standalone with valid number ranges.
 * Examples: 01 33 00, 32 92 19, Section 01 20 00
 */
const SRF_PATTERN = /\b(\d{2}\s\d{2}\s\d{2}(?:\.\d{2})?)\b/g;

/**
 * Scan a text string for unmarked patterns and return match suggestions.
 *
 * @param {string} text - Plain text content (no HTML) to scan
 * @param {string} html - The HTML content of the block (to check for existing marks)
 * @returns {Array<{type: string, text: string, start: number, end: number}>}
 *   Array of suggested marks with their position in the text string
 */
export function detectPatterns(text, html) {
  const suggestions = [];
  if (!text || !text.trim()) return suggestions;

  // Find RID patterns
  let match;
  RID_PATTERN.lastIndex = 0;
  while ((match = RID_PATTERN.exec(text)) !== null) {
    const matchText = match[0];
    // Skip if this text is already inside a mark-rid span in the HTML
    if (html && isAlreadyMarked(html, matchText)) continue;

    suggestions.push({
      type: "rid",
      cls: "mark-rid",
      label: "RID",
      title: "Mark as Reference Standard",
      text: matchText,
      start: match.index,
      end: match.index + matchText.length,
    });
  }

  // Find SRF patterns (section number format)
  SRF_PATTERN.lastIndex = 0;
  while ((match = SRF_PATTERN.exec(text)) !== null) {
    const matchText = match[1];
    // Skip if already marked
    if (html && isAlreadyMarked(html, matchText)) continue;
    // Skip if this overlaps with a RID match (some standards have numbers in XX XX XX format)
    const overlaps = suggestions.some(s =>
      s.type === "rid" && match.index >= s.start && match.index < s.end
    );
    if (overlaps) continue;

    suggestions.push({
      type: "srf",
      cls: "mark-srf",
      label: "SRF",
      title: "Mark as Section Reference",
      text: matchText,
      start: match.index,
      end: match.index + matchText.length,
    });
  }

  return suggestions;
}

/**
 * Check if a given text fragment is already inside ANY mark span in the HTML.
 * Checks all mark types (mark-rid, mark-srf, mark-url, etc.) — if the text
 * is already wrapped in any data element span, don't suggest marking it again.
 */
function isAlreadyMarked(html, text) {
  // Escape regex special chars in the text
  const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`<span\\s+class="mark-[^"]*"[^>]*>[^<]*${escaped}[^<]*</span>`, "i");
  return re.test(html);
}
