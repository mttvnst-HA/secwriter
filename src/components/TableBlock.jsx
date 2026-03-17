import { BLOCK_MARGINS } from "../lib/ini-config.js";

function TableBlock({ block }) {
  const tbl = block.table;
  if (!tbl || !tbl.rows || tbl.rows.length === 0) return null;

  // Detect if first row is a header (single cell spanning all columns, or all cells have text)
  const firstRow = tbl.rows[0];
  const isCaption = firstRow.length === 1 && firstRow[0].colspan > 1;
  const headerRowIdx = isCaption ? 1 : 0;
  const captionText = isCaption ? firstRow[0].text : null;
  const dataRows = tbl.rows.slice(isCaption ? 1 : 0);
  const headerRow = dataRows[0];
  const bodyRows = dataRows.slice(1);

  // Determine if first data row looks like a header (all cells have text, short-ish)
  const firstRowIsHeader = headerRow && headerRow.every(c => c.text && c.text.length < 80);

  return (
    <div style={{
      marginLeft: 15,   // TAB not in [MARGINS] - inherits from parent TXT=0.16,0
      marginRight: 0,   // TXT right margin is 0
      paddingLeft: 12,  // Match TXT padding so table border aligns with text edge
      marginTop: 12,
      marginBottom: 12,
    }}>
      {captionText && (
        <div
          style={{
            textAlign: "center",
            fontWeight: 700,
            fontSize: 14,
            padding: "8px 12px",
            backgroundColor: "#f1f5f9",
            border: "1px solid #cbd5e1",
            borderBottom: "none",
          }}
          dangerouslySetInnerHTML={{ __html: captionText }}
        />
      )}
      <table style={{
        width: "100%",
        borderCollapse: "collapse",
        fontSize: 13,
        lineHeight: "1.5",
      }}>
        {firstRowIsHeader && (
          <thead>
            <tr>
              {headerRow.map((cell, ci) => (
                <th
                  key={ci}
                  colSpan={cell.colspan > 1 ? cell.colspan : undefined}
                  style={{
                    padding: "6px 10px",
                    border: "1px solid #cbd5e1",
                    backgroundColor: "#f1f5f9",
                    fontWeight: 600,
                    textAlign: "left",
                    color: "#334155",
                  }}
                  dangerouslySetInnerHTML={{ __html: cell.text }}
                />
              ))}
            </tr>
          </thead>
        )}
        <tbody>
          {(firstRowIsHeader ? bodyRows : dataRows).map((row, ri) => (
            <tr key={ri}>
              {row.map((cell, ci) => (
                <td
                  key={ci}
                  colSpan={cell.colspan > 1 ? cell.colspan : undefined}
                  style={{
                    padding: "5px 10px",
                    border: "1px solid #cbd5e1",
                    verticalAlign: "top",
                    color: "#1e293b",
                  }}
                  dangerouslySetInnerHTML={{ __html: cell.text || "&nbsp;" }}
                />
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default TableBlock;
