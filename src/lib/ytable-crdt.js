/**
 * ytable-crdt.js — Table CRDT converter for Yjs collaboration
 *
 * Provides four exports for converting between plain TableData objects and
 * nested Yjs types (Y.Array / Y.Map / Y.Text), enabling fine-grained CRDT
 * merges at the cell level rather than last-write-wins JSON replacement.
 *
 * Structure stored in a Y.Map (yTableMap):
 *   columns  : number (scalar)
 *   rows     : Y.Array<Y.Array<Y.Map>>   outer=rows, inner=cells
 *              each cell Y.Map: { text: Y.Text, colspan: number, styleId?: string }
 *   colWidths  : string (JSON-encoded number[])  — optional
 *   rowHeights : string (JSON-encoded number[])  — optional
 *   styles     : string (JSON-encoded object)    — optional
 */

import * as Y from 'yjs';
import { applyHtmlToYText, yTextToHtml, seedYTextFromHtml } from './ytext-html.js';

/**
 * Populate an attached Y.Map row with cells. yRow MUST already be attached
 * to its parent Y.Array (otherwise the inner Y.Map/Y.Text operations may
 * fire "Invalid access" warnings — issue #83, CLAUDE.md "Nine non-obvious
 * invariants" sixth bullet). Each yCell is pushed (attached) BEFORE its
 * fields are populated, and the cell's Y.Text is `set` (attached) BEFORE
 * `seedYTextFromHtml` inserts content.
 *
 * @param {import('yjs').Array} yRow — attached row Y.Array
 * @param {Array<{ text: string, colspan: number, styleId?: string }>} cells
 */
function populateRow(yRow, cells) {
  for (const cell of cells) {
    const yCell = new Y.Map();
    yRow.push([yCell]); // attach yCell BEFORE populating its fields
    yCell.set('colspan', typeof cell.colspan === 'number' ? cell.colspan : 1);
    if (cell.styleId !== undefined) yCell.set('styleId', cell.styleId);
    const yText = new Y.Text();
    yCell.set('text', yText); // attach yText BEFORE seeding content
    seedYTextFromHtml(yText, cell.text || '');
  }
}

/**
 * Populate a Y.Map with nested Yjs types from a plain TableData object.
 *
 * Must be called inside a Y.Doc transaction, with yMap ALREADY attached to
 * its parent (yStore entry or block Y.Map). Clears any existing content
 * in yMap first (full replacement — caller decides when structural changes
 * warrant a full re-seed vs cell-only updates via applyTableCellEdits).
 *
 * Attach-before-populate is enforced at every nested level (yRows, each
 * yRow, each yCell, each cell-text Y.Text) so the Yjs "Invalid access"
 * warning does not fire on a fresh-from-sample doc (#83).
 *
 * @param {import('yjs').Map} yMap   — attached table root Y.Map
 * @param {object} tableData         — plain TableData { columns, rows, colWidths?, rowHeights?, styles? }
 */
export function tableToYStructure(yMap, tableData) {
  // Clear existing keys. `[...yMap.keys()]` requires yMap to be attached
  // (createMapIterator in Yjs warns when `parent.doc` is null).
  for (const key of [...yMap.keys()]) {
    yMap.delete(key);
  }

  yMap.set('columns', tableData.columns);

  // Optional dimension arrays: stored as JSON strings
  if (tableData.colWidths !== undefined) {
    yMap.set('colWidths', JSON.stringify(tableData.colWidths));
  }
  if (tableData.rowHeights !== undefined) {
    yMap.set('rowHeights', JSON.stringify(tableData.rowHeights));
  }
  if (tableData.styles !== undefined) {
    yMap.set('styles', JSON.stringify(tableData.styles));
  }

  // Build rows: Y.Array<Y.Array<Y.Map>>. Attach yRows to yMap BEFORE
  // pushing rows; attach each yRow to yRows BEFORE pushing cells. Each
  // cell's Y.Text is attached to the cell BEFORE seedYTextFromHtml inserts
  // content. The whole chain is rooted at the doc the moment any read
  // happens, so no detached-type warnings fire.
  const yRows = new Y.Array();
  yMap.set('rows', yRows);
  for (const row of tableData.rows) {
    const yRow = new Y.Array();
    yRows.push([yRow]); // attach yRow BEFORE populating it
    populateRow(yRow, row);
  }
}

/**
 * Convert a Y.Map (written by tableToYStructure) back to a plain TableData object.
 *
 * @param {import('yjs').Map} yMap
 * @returns {{ columns: number, rows: Array, colWidths?: number[], rowHeights?: number[], styles?: object }}
 */
export function yStructureToTable(yMap) {
  const columns = yMap.get('columns') || 0;

  const result = { columns, rows: [] };

  const colWidthsStr = yMap.get('colWidths');
  if (colWidthsStr !== undefined) result.colWidths = JSON.parse(colWidthsStr);

  const rowHeightsStr = yMap.get('rowHeights');
  if (rowHeightsStr !== undefined) result.rowHeights = JSON.parse(rowHeightsStr);

  const stylesStr = yMap.get('styles');
  if (stylesStr !== undefined) result.styles = JSON.parse(stylesStr);

  const yRows = yMap.get('rows');
  if (!yRows || typeof yRows.length !== 'number') return result;

  for (let r = 0; r < yRows.length; r++) {
    const yRow = yRows.get(r);
    if (!yRow || typeof yRow.length !== 'number') continue;
    const row = [];
    for (let c = 0; c < yRow.length; c++) {
      const yCell = yRow.get(c);
      if (!yCell || typeof yCell.get !== 'function') {
        row.push({ text: '', colspan: 1 });
        continue;
      }
      const yText = yCell.get('text');
      const cell = {
        text: yText ? yTextToHtml(yText) : '',
        colspan: yCell.get('colspan') !== undefined ? yCell.get('colspan') : 1,
      };
      const styleId = yCell.get('styleId');
      if (styleId !== undefined) cell.styleId = styleId;
      row.push(cell);
    }
    result.rows.push(row);
  }

  return result;
}

/**
 * Classify the difference between two TableData objects.
 *
 * Returns:
 *   { type: 'structural' }                               — shape changed
 *   { type: 'cells', changes: [{ row, cell, html }] }    — only text changed
 *
 * Structural means: column count differs, row count differs, or any cell's
 * colspan differs. In those cases the caller should do a full re-seed.
 * Cell-only means only text content changed in some cells.
 *
 * @param {object} prevTable
 * @param {object} nextTable
 * @returns {{ type: 'structural' } | { type: 'cells', changes: Array }}
 */
export function diffTableForPublish(prevTable, nextTable) {
  // Structural: column count mismatch
  if (prevTable.columns !== nextTable.columns) return { type: 'structural' };

  // Structural: row count mismatch
  if (prevTable.rows.length !== nextTable.rows.length) return { type: 'structural' };

  const changes = [];

  for (let r = 0; r < prevTable.rows.length; r++) {
    const prevRow = prevTable.rows[r];
    const nextRow = nextTable.rows[r];

    // Structural: cell count per row mismatch
    if (prevRow.length !== nextRow.length) return { type: 'structural' };

    for (let c = 0; c < prevRow.length; c++) {
      const prevCell = prevRow[c];
      const nextCell = nextRow[c];

      // Structural: colspan changed
      const prevColspan = prevCell.colspan !== undefined ? prevCell.colspan : 1;
      const nextColspan = nextCell.colspan !== undefined ? nextCell.colspan : 1;
      if (prevColspan !== nextColspan) return { type: 'structural' };

      // Text-only change
      if (prevCell.text !== nextCell.text) {
        changes.push({ row: r, cell: c, html: nextCell.text });
      }
    }
  }

  return { type: 'cells', changes };
}

/**
 * Apply targeted cell text updates to a Y.Map table structure.
 *
 * Each change specifies a { row, cell, html } tuple. Uses applyHtmlToYText
 * for minimal CRDT operations (the Y.Text IS attached to a doc at this point).
 * Untouched cells are not modified, preserving Y.Text identity for CRDT merge.
 *
 * @param {import('yjs').Map} yMap
 * @param {Array<{ row: number, cell: number, html: string }>} changes
 */
export function applyTableCellEdits(yMap, changes) {
  if (!changes || changes.length === 0) return;

  const yRows = yMap.get('rows');
  if (!yRows) return;

  for (const { row, cell, html } of changes) {
    const yRow = yRows.get(row);
    if (!yRow) continue;
    const yCell = yRow.get(cell);
    if (!yCell) continue;
    const yText = yCell.get('text');
    if (!yText) continue;
    applyHtmlToYText(yText, html || '');
  }
}
