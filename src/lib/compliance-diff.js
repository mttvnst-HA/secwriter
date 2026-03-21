/**
 * compliance-diff.js
 *
 * Word-level diff between original and proposed compliance text.
 * Wraps the existing diffWords() from text-diff.js.
 */

import { diffWords } from './text-diff.js';

/**
 * Compute a word-level diff between original and proposed text.
 *
 * @param {string} originalText - Original plain text
 * @param {string} proposedText - Proposed compliant text
 * @returns {Array} diff ops: [{ type: 'keep'|'del'|'add', text }]
 *          Empty array if texts are identical.
 */
export function computeComplianceDiff(originalText, proposedText) {
  if (!originalText && !proposedText) return [];
  if (originalText === proposedText) return [];

  const ops = diffWords(originalText || '', proposedText || '');

  // Map diffWords output format to compliance diff format
  return ops.map(op => ({
    type: op.type, // 'keep', 'del', 'add'
    text: op.text,
  }));
}
