import { describe, it, expect } from 'vitest';
import { buildContextMenuItems } from '../context-menu-items.js';

const ids = (items) => items.filter(i => !i.divider).map(i => i.id);

describe('buildContextMenuItems - clipboard', () => {
  it('plain PM, no selection, editable -> paste only (no copy/cut)', () => {
    const items = buildContextMenuItems({ blockId: 'b1', kind: 'pm', pos: 3, selectionEmpty: true, readOnly: false });
    expect(ids(items)).toEqual(['paste']);
  });
  it('PM with a selection -> copy, cut, paste', () => {
    const items = buildContextMenuItems({ blockId: 'b1', kind: 'pm', pos: 3, selectionEmpty: false, readOnly: false });
    expect(ids(items)).toEqual(['copy', 'cut', 'paste']);
  });
  it('read-only with a selection -> copy only (no cut, no paste)', () => {
    const items = buildContextMenuItems({ blockId: 'b1', kind: 'pm', pos: 3, selectionEmpty: false, readOnly: true });
    expect(ids(items)).toEqual(['copy']);
  });
  it('read-only with no selection -> empty (App suppresses -> native menu)', () => {
    const items = buildContextMenuItems({ blockId: 'b1', kind: 'pm', pos: 3, selectionEmpty: true, readOnly: true });
    expect(ids(items)).toEqual([]);
  });
});

describe('buildContextMenuItems - tracked changes & comments', () => {
  it('over a revision mark -> accept/reject change after clipboard', () => {
    const items = buildContextMenuItems({
      blockId: 'b1', kind: 'pm', pos: 3, selectionEmpty: true, readOnly: false,
      revision: { kind: 'add', range: { from: 2, to: 6 } },
    });
    expect(ids(items)).toEqual(['paste', 'accept-change', 'reject-change']);
  });
  it('selection contains the click -> add-comment offered', () => {
    const items = buildContextMenuItems({
      blockId: 'b1', kind: 'pm', pos: 3, selectionEmpty: false, readOnly: false,
      addCommentRange: { from: 1, to: 8 },
    });
    expect(ids(items)).toContain('add-comment');
  });
  it('over an unresolved comment -> resolve-comment offered', () => {
    const items = buildContextMenuItems({
      blockId: 'b1', kind: 'pm', pos: 3, selectionEmpty: true, readOnly: false,
      comment: { commentId: 'c1', range: { from: 1, to: 8 }, resolved: false },
    });
    expect(ids(items)).toContain('resolve-comment');
  });
  it('over an already-resolved comment -> no resolve-comment', () => {
    const items = buildContextMenuItems({
      blockId: 'b1', kind: 'pm', pos: 3, selectionEmpty: true, readOnly: false,
      comment: { commentId: 'c1', range: { from: 1, to: 8 }, resolved: true },
    });
    expect(ids(items)).not.toContain('resolve-comment');
  });
});

describe('buildContextMenuItems - table', () => {
  it('editable table cell -> insert/delete row+col, merge gated, split gated', () => {
    const items = buildContextMenuItems({
      blockId: 'b1', kind: 'table', row: 0, col: 0, vcol: 0,
      canMerge: true, canSplit: false, readOnly: false,
    });
    const got = ids(items);
    expect(got).toEqual([
      'table-insert-row-above', 'table-insert-row-below',
      'table-insert-col-left', 'table-insert-col-right',
      'table-delete-row', 'table-delete-col', 'table-merge',
    ]);
    expect(got).not.toContain('table-split');
  });
  it('read-only table -> empty', () => {
    const items = buildContextMenuItems({
      blockId: 'b1', kind: 'table', row: 0, col: 0, vcol: 0,
      canMerge: true, canSplit: true, readOnly: true,
    });
    expect(ids(items)).toEqual([]);
  });
});

describe('buildContextMenuItems - title/ref copy-only', () => {
  it('title with selection -> copy only', () => {
    expect(ids(buildContextMenuItems({ blockId: 'b1', kind: 'title', selectionEmpty: false, readOnly: false }))).toEqual(['copy']);
  });
  it('ref with no selection -> empty', () => {
    expect(ids(buildContextMenuItems({ blockId: 'b1', kind: 'ref', selectionEmpty: true, readOnly: false }))).toEqual([]);
  });
});

describe('buildContextMenuItems - dividers', () => {
  it('never starts or ends with a divider and never doubles one', () => {
    const items = buildContextMenuItems({
      blockId: 'b1', kind: 'pm', pos: 3, selectionEmpty: false, readOnly: false,
      revision: { kind: 'del', range: { from: 2, to: 6 } },
      comment: { commentId: 'c1', range: { from: 1, to: 8 }, resolved: false },
    });
    expect(items[0].divider).toBeUndefined();
    expect(items[items.length - 1].divider).toBeUndefined();
    for (let i = 1; i < items.length; i++) {
      expect(items[i].divider && items[i - 1].divider).toBeFalsy();
    }
  });
});
