/**
 * Pure functions for table row/column/cell operations.
 * Table data model: { columns: number, rows: [[{text, colspan}]] }
 */

/**
 * Deep clone a table object.
 */
export function cloneTable(table) {
  return {
    columns: table.columns,
    rows: table.rows.map(row => row.map(cell => ({ ...cell }))),
  };
}

/**
 * Add a new empty row at the end of the table.
 */
export function addRow(table) {
  const t = cloneTable(table);
  const newRow = [];
  for (let i = 0; i < t.columns; i++) {
    newRow.push({ text: '', colspan: 1 });
  }
  t.rows.push(newRow);
  return t;
}

/**
 * Delete a row by index. Returns null if it would leave no rows.
 */
export function deleteRow(table, rowIdx) {
  if (table.rows.length <= 1) return null;
  const t = cloneTable(table);
  t.rows.splice(rowIdx, 1);
  return t;
}

/**
 * Add a new column at the end of the table.
 */
export function addColumn(table) {
  const t = cloneTable(table);
  const oldCols = t.columns;
  t.columns += 1;
  for (const row of t.rows) {
    const totalSpan = row.reduce((sum, c) => sum + (c.colspan || 1), 0);
    if (totalSpan >= oldCols && row.length < oldCols) {
      // Row uses colspan to span all old columns — extend the spanning cell
      row[row.length - 1].colspan = (row[row.length - 1].colspan || 1) + 1;
    } else {
      row.push({ text: '', colspan: 1 });
    }
  }
  return t;
}

/**
 * Delete a column by visual index. Returns null if it would leave no columns.
 * Handles colspan: if a cell spans the deleted column, its colspan is reduced.
 */
export function deleteColumn(table, colIdx) {
  if (table.columns <= 1) return null;
  const t = cloneTable(table);
  t.columns -= 1;
  for (let r = 0; r < t.rows.length; r++) {
    const row = t.rows[r];
    let pos = 0;
    for (let c = 0; c < row.length; c++) {
      const span = row[c].colspan || 1;
      if (colIdx >= pos && colIdx < pos + span) {
        // This cell covers the deleted column
        if (span > 1) {
          row[c].colspan = span - 1;
        } else {
          row.splice(c, 1);
        }
        break;
      }
      pos += span;
    }
  }
  return t;
}

/**
 * Update a cell's text content.
 * @param {object} table
 * @param {number} rowIdx - row index
 * @param {number} cellIdx - cell index within the row array (not visual column)
 * @param {string} text - new text content
 */
export function updateCell(table, rowIdx, cellIdx, text) {
  const t = cloneTable(table);
  if (t.rows[rowIdx] && t.rows[rowIdx][cellIdx]) {
    t.rows[rowIdx][cellIdx].text = text;
  }
  return t;
}

/**
 * Merge a cell with its right neighbor (increase colspan by 1).
 * The right neighbor's text is appended to the merged cell.
 * Returns null if merge is not possible (cell is at the right edge).
 */
export function mergeCellRight(table, rowIdx, cellIdx) {
  const t = cloneTable(table);
  const row = t.rows[rowIdx];
  if (!row || cellIdx >= row.length - 1) return null;
  const cell = row[cellIdx];
  const right = row[cellIdx + 1];
  // Merge: combine text and add colspans
  cell.text = [cell.text, right.text].filter(Boolean).join(' ');
  cell.colspan = (cell.colspan || 1) + (right.colspan || 1);
  // Remove the right cell
  row.splice(cellIdx + 1, 1);
  return t;
}

/**
 * Split a cell into two (decrease colspan by 1, insert a new empty cell).
 * Returns null if cell has colspan 1 (cannot split further).
 */
export function splitCell(table, rowIdx, cellIdx) {
  const t = cloneTable(table);
  const row = t.rows[rowIdx];
  if (!row) return null;
  const cell = row[cellIdx];
  if (!cell || (cell.colspan || 1) <= 1) return null;
  // Reduce colspan and insert new empty cell after
  cell.colspan = (cell.colspan || 1) - 1;
  row.splice(cellIdx + 1, 0, { text: '', colspan: 1 });
  return t;
}
