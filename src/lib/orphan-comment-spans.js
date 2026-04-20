// Strip `mark-comment` highlight spans whose `data-comment-id` is NOT
// present in `validIds`. Returns a new blocks array if any orphan was
// removed, or the original reference otherwise.
//
// This cleans up the "ghost-span" case where a user opens the comment
// popup, the eager span injection gets published via the normal
// blocks → yStore sync, and then the user abandons the popup by
// closing the tab before the deferred `handleCommentUpdateCreate`
// publishes the metadata. Peers would otherwise see a dead yellow
// highlight with no openable popup. Runs once per room join after
// the initial `yComments` sync.
export function stripOrphanCommentSpans(blocks, validIds) {
  if (typeof document === 'undefined') return blocks;
  let anyChanged = false;
  const next = blocks.map((b) => {
    if (!b.html || !b.html.includes('mark-comment')) return b;
    const div = document.createElement('div');
    div.innerHTML = b.html;
    // Match both `mark-comment` and `mark-comment-resolved` classes.
    const spans = div.querySelectorAll('span[data-comment-id]');
    let blockChanged = false;
    spans.forEach((span) => {
      const cls = span.getAttribute('class') || '';
      if (!cls.includes('mark-comment')) return;
      const id = span.getAttribute('data-comment-id');
      if (!id || validIds.has(id)) return;
      // Orphan — unwrap: move children up, then remove the span.
      const parent = span.parentNode;
      if (!parent) return;
      while (span.firstChild) parent.insertBefore(span.firstChild, span);
      parent.removeChild(span);
      blockChanged = true;
    });
    if (!blockChanged) return b;
    anyChanged = true;
    return { ...b, html: div.innerHTML };
  });
  return anyChanged ? next : blocks;
}
