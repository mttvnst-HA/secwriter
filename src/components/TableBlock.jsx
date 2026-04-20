import { useState, useRef, useCallback } from "react";
import { addRow, deleteRow, addColumn, deleteColumn, updateCell, mergeCellRight, splitCell } from "../lib/table-ops.js";
import { NO_EXFIL_PROPS } from "../lib/no-exfil.js";

function TableBlock({ block, onUpdate, isFocused, onFocus, readOnly }) {
  const canEdit = onUpdate && !readOnly;
  const tbl = block.table;
  if (!tbl || !tbl.rows || tbl.rows.length === 0) return null;

  const [editingCell, setEditingCell] = useState(null); // {row, col}
  const [cellDraft, setCellDraft] = useState("");
  const [hoverRow, setHoverRow] = useState(-1);
  const [hoverCol, setHoverCol] = useState(-1);
  const inputRef = useRef(null);

  const save = useCallback((newTable) => {
    if (onUpdate) onUpdate(block.id, { table: newTable });
  }, [block.id, onUpdate]);

  const startEdit = useCallback((rowIdx, cellIdx, text) => {
    setEditingCell({ row: rowIdx, col: cellIdx });
    setCellDraft(text || "");
    setTimeout(() => inputRef.current?.focus(), 0);
  }, []);

  const saveCell = useCallback(() => {
    if (!editingCell) return;
    const newTable = updateCell(tbl, editingCell.row, editingCell.col, cellDraft);
    save(newTable);
    setEditingCell(null);
  }, [editingCell, cellDraft, tbl, save]);

  const handleCellKeyDown = useCallback((e) => {
    if (e.key === "Escape") {
      setEditingCell(null);
    } else if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      saveCell();
    } else if (e.key === "Tab") {
      e.preventDefault();
      saveCell();
      // Move to next cell
      if (!editingCell) return;
      const row = tbl.rows[editingCell.row];
      if (!row) return;
      if (e.shiftKey) {
        // Move backward
        if (editingCell.col > 0) {
          startEdit(editingCell.row, editingCell.col - 1, row[editingCell.col - 1]?.text);
        } else if (editingCell.row > 0) {
          const prevRow = tbl.rows[editingCell.row - 1];
          if (prevRow) startEdit(editingCell.row - 1, prevRow.length - 1, prevRow[prevRow.length - 1]?.text);
        }
      } else {
        // Move forward
        if (editingCell.col < row.length - 1) {
          startEdit(editingCell.row, editingCell.col + 1, row[editingCell.col + 1]?.text);
        } else if (editingCell.row < tbl.rows.length - 1) {
          const nextRow = tbl.rows[editingCell.row + 1];
          if (nextRow) startEdit(editingCell.row + 1, 0, nextRow[0]?.text);
        }
      }
    }
  }, [editingCell, cellDraft, tbl, saveCell, startEdit]);

  const handleAddRow = useCallback(() => {
    save(addRow(tbl));
  }, [tbl, save]);

  const handleDeleteRow = useCallback((rowIdx) => {
    const result = deleteRow(tbl, rowIdx);
    if (result) save(result);
  }, [tbl, save]);

  const handleAddColumn = useCallback(() => {
    save(addColumn(tbl));
  }, [tbl, save]);

  const handleDeleteColumn = useCallback((colIdx) => {
    const result = deleteColumn(tbl, colIdx);
    if (result) save(result);
  }, [tbl, save]);

  const cellStyle = {
    padding: "5px 10px",
    border: "1px solid #cbd5e1",
    verticalAlign: "top",
    color: "#1e293b",
    position: "relative",
    cursor: canEdit ? "pointer" : "default",
  };

  const headerCellStyle = {
    ...cellStyle,
    padding: "6px 10px",
    backgroundColor: "#f1f5f9",
    fontWeight: 600,
    color: "#334155",
  };

  const [hoverCell, setHoverCell] = useState(null); // {row, col}

  const renderCell = (cell, rowIdx, cellIdx, isHeader, row) => {
    const isEditing = editingCell?.row === rowIdx && editingCell?.col === cellIdx;
    const isHovered = hoverCell?.row === rowIdx && hoverCell?.col === cellIdx;
    const Tag = isHeader ? "th" : "td";
    const style = isHeader ? headerCellStyle : cellStyle;
    const canMerge = canEdit && cellIdx < row.length - 1;
    const canSplit = canEdit && (cell.colspan || 1) > 1;

    return (
      <Tag
        key={cellIdx}
        colSpan={cell.colspan > 1 ? cell.colspan : undefined}
        style={style}
        onDoubleClick={() => canEdit && startEdit(rowIdx, cellIdx, cell.text)}
        onMouseEnter={() => setHoverCell({ row: rowIdx, col: cellIdx })}
        onMouseLeave={() => setHoverCell(null)}
      >
        {isEditing ? (
          <input
            ref={inputRef}
            type="text"
            value={cellDraft}
            onChange={(e) => setCellDraft(e.target.value)}
            onKeyDown={handleCellKeyDown}
            onBlur={saveCell}
            {...NO_EXFIL_PROPS}
            style={{
              width: "100%",
              border: "1px solid #3b82f6",
              borderRadius: 2,
              padding: "2px 4px",
              fontSize: 13,
              outline: "none",
              boxSizing: "border-box",
            }}
          />
        ) : (
          <span dangerouslySetInnerHTML={{ __html: cell.text || "&nbsp;" }} />
        )}
        {/* Merge/Split buttons on hover */}
        {isHovered && !isEditing && canEdit && (
          <span style={{
            position: "absolute", top: 1, right: 1,
            display: "flex", gap: 2,
          }}>
            {canMerge && (
              <button
                onClick={(e) => { e.stopPropagation(); const t = mergeCellRight(tbl, rowIdx, cellIdx); if (t) save(t); }}
                title="Merge with cell to the right"
                style={{
                  width: 18, height: 16, border: "1px solid #3b82f640", borderRadius: 2,
                  backgroundColor: "#eff6ff", color: "#3b82f6", fontSize: 9,
                  cursor: "pointer", padding: 0, display: "flex",
                  alignItems: "center", justifyContent: "center",
                }}
              >&#x21E8;</button>
            )}
            {canSplit && (
              <button
                onClick={(e) => { e.stopPropagation(); const t = splitCell(tbl, rowIdx, cellIdx); if (t) save(t); }}
                title="Split cell (reduce colspan)"
                style={{
                  width: 18, height: 16, border: "1px solid #d9770640", borderRadius: 2,
                  backgroundColor: "#fffbeb", color: "#d97706", fontSize: 9,
                  cursor: "pointer", padding: 0, display: "flex",
                  alignItems: "center", justifyContent: "center",
                }}
              >&#x21D4;</button>
            )}
          </span>
        )}
      </Tag>
    );
  };

  const delBtnStyle = {
    width: 16, height: 16, border: "none", borderRadius: 2,
    backgroundColor: "#fee2e2", color: "#dc2626", fontSize: 10,
    cursor: "pointer", display: "flex", alignItems: "center",
    justifyContent: "center", padding: 0, lineHeight: 1,
  };

  const addBtnStyle = {
    border: "1px dashed #94a3b8", borderRadius: 3,
    backgroundColor: "transparent", color: "#64748b", fontSize: 11,
    cursor: "pointer", padding: "2px 8px", lineHeight: 1,
  };

  return (
    <div id={`block-${block.id}`} style={{
      marginLeft: 15,
      marginRight: 0,
      paddingLeft: 12,
      marginTop: 12,
      marginBottom: 12,
    }}
    onClick={() => onFocus && onFocus(block.id)}
    >
      <table style={{
        width: "100%",
        borderCollapse: "collapse",
        fontSize: 13,
        lineHeight: "1.5",
      }}>
        {/* Column delete buttons row */}
        {canEdit && tbl.columns > 1 && (
          <thead>
            <tr>
              {canEdit && <td style={{ border: "none", width: 20 }} />}
              {Array.from({ length: tbl.columns }, (_, ci) => (
                <td key={ci} style={{
                  border: "none", textAlign: "center", padding: "0 0 2px",
                }}>
                  <button
                    onClick={() => handleDeleteColumn(ci)}
                    title={`Delete column ${ci + 1}`}
                    style={{ ...delBtnStyle, margin: "0 auto", opacity: hoverCol === ci ? 1 : 0 }}
                    onMouseEnter={() => setHoverCol(ci)}
                    onMouseLeave={() => setHoverCol(-1)}
                  >×</button>
                </td>
              ))}
            </tr>
          </thead>
        )}
        <tbody>
          {tbl.rows.map((row, ri) => (
            <tr
              key={ri}
              onMouseEnter={() => setHoverRow(ri)}
              onMouseLeave={() => setHoverRow(-1)}
            >
              {/* Row delete button */}
              {canEdit && (
                <td style={{
                  border: "none", width: 20, padding: 0, verticalAlign: "middle",
                }}>
                  {tbl.rows.length > 1 && (
                    <button
                      onClick={() => handleDeleteRow(ri)}
                      title={`Delete row ${ri + 1}`}
                      style={{ ...delBtnStyle, opacity: hoverRow === ri ? 1 : 0 }}
                    >×</button>
                  )}
                </td>
              )}
              {row.map((cell, ci) => renderCell(cell, ri, ci, false, row))}
            </tr>
          ))}
        </tbody>
      </table>
      {/* Add row / add column buttons */}
      {canEdit && (
        <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
          <button onClick={handleAddRow} title="Add row" style={addBtnStyle}>+ Row</button>
          <button onClick={handleAddColumn} title="Add column" style={addBtnStyle}>+ Column</button>
        </div>
      )}
    </div>
  );
}

export default TableBlock;
