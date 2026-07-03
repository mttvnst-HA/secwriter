/**
 * Shared sentence-boundary heuristic for the docs:check-* lint scripts.
 *
 * Naive "." splitting breaks on periods inside things like "harper.js" or
 * "e.g." — only treat "." (or "!"/"?", optionally followed by markdown
 * bold-close "**") as a sentence end when followed by whitespace + an
 * uppercase/digit/markdown-marker char.
 */

export const SENTENCE_BOUNDARY = /(?<=[.!?]\*{0,2})\s+(?=[A-Z0-9`*[])/;

// Split into rough "sentences" so a keyword or acknowledgment word several
// sentences away from the citation being checked doesn't count as
// co-occurrence.
export function splitSentences(text) {
  const pieces = text.split(new RegExp(SENTENCE_BOUNDARY, 'g'));
  const sentences = [];
  let cursor = 0;
  for (const piece of pieces) {
    const start = text.indexOf(piece, cursor);
    sentences.push({ text: piece, start });
    cursor = start + piece.length;
  }
  return sentences;
}

// Returns the single sentence (trimmed) containing the given character index.
export function sentenceAround(text, index) {
  const sentences = splitSentences(text);
  for (let i = 0; i < sentences.length; i++) {
    const start = sentences[i].start;
    const end = i + 1 < sentences.length ? sentences[i + 1].start : text.length;
    if (index >= start && index < end) return text.slice(start, end).trim();
  }
  return text.slice(index).trim();
}
