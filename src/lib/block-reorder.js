/**
 * Pure functions for reordering sections in the flat blocks array.
 * A "section" is a title block plus all subsequent blocks until the next
 * title at the same or shallower depth.
 */

/**
 * Get the index range [start, end) of blocks belonging to a section.
 * Includes the title block and all content/subsection blocks that follow it
 * until the next title at equal or shallower depth.
 *
 * @param {Array} blocks - flat blocks array
 * @param {string} titleId - ID of the title block
 * @returns {{ start: number, end: number }} - half-open range [start, end)
 */
export function getSectionRange(blocks, titleId) {
  const start = blocks.findIndex(b => b.id === titleId);
  if (start < 0) return null;

  const titleBlock = blocks[start];
  if (titleBlock.type !== 'title') return null;

  const titleDepth = titleBlock.depth;
  let end = start + 1;

  while (end < blocks.length) {
    const b = blocks[end];
    // Stop at the next title at same or shallower depth
    if (b.type === 'title' && b.depth <= titleDepth) break;
    end++;
  }

  return { start, end };
}

/**
 * Reorder a section by moving it before or after another section.
 *
 * @param {Array} blocks - flat blocks array
 * @param {string} dragId - ID of the title block being moved
 * @param {string} dropId - ID of the title block at the drop target
 * @param {"before"|"after"} position - insert before or after the drop target section
 * @returns {Array} new blocks array with the section moved
 */
export function reorderSection(blocks, dragId, dropId, position) {
  if (dragId === dropId) return blocks;

  const dragRange = getSectionRange(blocks, dragId);
  const dropRange = getSectionRange(blocks, dropId);
  if (!dragRange || !dropRange) return blocks;

  // Extract the dragged section
  const draggedBlocks = blocks.slice(dragRange.start, dragRange.end);
  // Remove dragged blocks from array
  const remaining = [
    ...blocks.slice(0, dragRange.start),
    ...blocks.slice(dragRange.end),
  ];

  // Find the drop target in the remaining array
  const dropIdx = remaining.findIndex(b => b.id === dropId);
  if (dropIdx < 0) return blocks;

  // Calculate insertion point
  let insertAt;
  if (position === 'before') {
    insertAt = dropIdx;
  } else {
    // "after" = after the entire drop target section
    const dropSectionRange = getSectionRange(remaining, dropId);
    insertAt = dropSectionRange ? dropSectionRange.end : dropIdx + 1;
  }

  // Insert dragged blocks at the target position
  const result = [
    ...remaining.slice(0, insertAt),
    ...draggedBlocks,
    ...remaining.slice(insertAt),
  ];

  return result;
}
