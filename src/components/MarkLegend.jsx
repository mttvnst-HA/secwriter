export default function MarkLegend() {
  const marks = [
    { cls: "mark-rid", label: "Ref Standard", example: "ASTM D2487" },
    { cls: "mark-srf", label: "Section Ref", example: "01 33 00" },
    { cls: "mark-sub", label: "Submittal", example: "SD-01" },
    { cls: "mark-eng", label: "English Units", example: "3 inches" },
    { cls: "mark-met", label: "Metric Units", example: "75 mm" },
  ];
  return (
    <div style={{ display: "flex", gap: 12, padding: "8px 16px", borderBottom: "1px solid #e2e8f0", fontSize: 12, color: "#64748b", flexWrap: "wrap", alignItems: "center" }}>
      <span style={{ fontWeight: 600, marginRight: 4 }}>Data Elements:</span>
      {marks.map(m => (
        <span key={m.cls} style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
          <span className={m.cls} style={{ padding: "2px 8px", borderRadius: 3 }}>{m.example}</span>
          <span>{m.label}</span>
        </span>
      ))}
    </div>
  );
}
