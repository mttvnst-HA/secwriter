// src/lib/context-menu-items.js
/**
 * context-menu-items.js - pure builder for the right-click context menu.
 *
 * buildContextMenuItems(ctx) takes a resolved context descriptor (see the
 * implementation plan / design spec for the per-kind shapes) and returns an
 * ordered flat array of item descriptors. Items are `{ id, label, icon }`;
 * section separators are `{ divider: true }`. The dynamic model: only items
 * valid for the exact target appear ("hide irrelevant", not show-disabled).
 *
 * React-free and DOM-free so it is table-testable. The owning component
 * (App) maps each item `id` to behavior at dispatch time.
 *
 * tableCellCoordsFromTd(td) is the pure DOM-attr reader used by App's table
 * host resolution - colocated here because it produces the {row,col,vcol,
 * canMerge,canSplit} half of a table descriptor.
 */

function pushSection(out, sectionItems) {
  if (sectionItems.length === 0) return;
  if (out.length > 0) out.push({ divider: true });
  out.push(...sectionItems);
}

export function buildContextMenuItems(ctx) {
  if (!ctx) return [];
  const out = [];

  if (ctx.kind === 'pm') {
    const clip = [];
    if (!ctx.selectionEmpty) {
      clip.push({ id: 'copy', label: 'Copy', icon: '⧉' });
      if (!ctx.readOnly) clip.push({ id: 'cut', label: 'Cut', icon: '✂' });
    }
    if (!ctx.readOnly) clip.push({ id: 'paste', label: 'Paste', icon: '📋' });
    pushSection(out, clip);

    if (!ctx.readOnly) {
      const tc = [];
      if (ctx.revision) {
        tc.push({ id: 'accept-change', label: 'Accept change', icon: '✓' });
        tc.push({ id: 'reject-change', label: 'Reject change', icon: '✕' });
      }
      pushSection(out, tc);

      const comments = [];
      if (ctx.addCommentRange) comments.push({ id: 'add-comment', label: 'Add comment', icon: '💬' });
      if (ctx.comment && !ctx.comment.resolved) {
        comments.push({ id: 'resolve-comment', label: 'Resolve comment', icon: '✅' });
      }
      pushSection(out, comments);
    }
    return out;
  }

  if (ctx.kind === 'table') {
    if (ctx.readOnly) return [];
    const table = [
      { id: 'table-insert-row-above', label: 'Insert row above', icon: '▦' },
      { id: 'table-insert-row-below', label: 'Insert row below', icon: '▦' },
      { id: 'table-insert-col-left', label: 'Insert column left', icon: '▦' },
      { id: 'table-insert-col-right', label: 'Insert column right', icon: '▦' },
      { id: 'table-delete-row', label: 'Delete row', icon: '✕' },
      { id: 'table-delete-col', label: 'Delete column', icon: '✕' },
    ];
    if (ctx.canMerge) table.push({ id: 'table-merge', label: 'Merge cell right', icon: '⇨' });
    if (ctx.canSplit) table.push({ id: 'table-split', label: 'Split cell', icon: '⇔' });
    pushSection(out, table);
    return out;
  }

  if (ctx.kind === 'title' || ctx.kind === 'ref') {
    if (!ctx.selectionEmpty) pushSection(out, [{ id: 'copy', label: 'Copy', icon: '⧉' }]);
    return out;
  }

  return out;
}

/**
 * Read a table descriptor's index half from a <td>/<th> carrying the
 * data-row / data-col / data-vcol attributes set by TableBlock. Returns null
 * if the element lacks the attributes (not a registered table cell).
 *
 * data-col is the CELL ARRAY index (drives merge/split/updateCell, which are
 * array-indexed); data-vcol is the VISUAL column start (drives column
 * insert/delete, which are visual-column indexed). A right-click on a merged
 * (colspan>1) cell maps to that cell's start column via data-vcol.
 */
export function tableCellCoordsFromTd(td) {
  if (!td || typeof td.getAttribute !== 'function') return null;
  const r = td.getAttribute('data-row');
  const c = td.getAttribute('data-col');
  const v = td.getAttribute('data-vcol');
  if (r == null || c == null) return null;
  return {
    row: Number(r),
    col: Number(c),
    vcol: v == null ? Number(c) : Number(v),
    canMerge: td.getAttribute('data-can-merge') === 'true',
    canSplit: td.getAttribute('data-can-split') === 'true',
  };
}
