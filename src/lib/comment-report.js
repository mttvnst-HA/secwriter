/**
 * Generate a printable HTML comment resolution report.
 * @param {Map} comments - Map<commentId, comment>
 * @param {Array} blocks - flat blocks array (for ordering)
 * @param {{ sectionNumber, sectionTitle, date }} sectionMeta
 * @returns {string} HTML document string
 */
export function generateCommentReport(comments, blocks, sectionMeta) {
  const commentList = Array.from(comments.values());

  // Sort by block order
  const blockOrder = new Map();
  blocks.forEach((b, i) => blockOrder.set(b.id, i));
  commentList.sort((a, b) => (blockOrder.get(a.blockId) || 0) - (blockOrder.get(b.blockId) || 0));

  const totalOpen = commentList.filter(c => c.status === 'open').length;
  const totalResolved = commentList.filter(c => c.status === 'resolved').length;

  const rows = commentList.map((c, idx) => {
    const entries = c.entries.map(e => {
      const date = e.timestamp ? new Date(e.timestamp).toLocaleString() : '';
      if (e.type === 'resolve') return `<div style="color:#166534;font-style:italic">${e.author} resolved - ${date}</div>`;
      if (e.type === 'reopen') return `<div style="color:#854d0e;font-style:italic">${e.author} reopened - ${date}</div>`;
      return `<div><strong>${e.author}</strong> <span style="color:#64748b;font-size:11px">${date}</span><br/>${escapeHtml(e.text)}</div>`;
    }).join('');

    const statusColor = c.status === 'resolved' ? '#166534' : '#854d0e';
    const statusBg = c.status === 'resolved' ? '#dcfce7' : '#fef9c3';

    return `<tr>
      <td style="padding:6px;border:1px solid #cbd5e1;text-align:center">${idx + 1}</td>
      <td style="padding:6px;border:1px solid #cbd5e1"><code>${c.blockId}</code></td>
      <td style="padding:6px;border:1px solid #cbd5e1;background:#fffbeb">${escapeHtml(c.highlightText)}</td>
      <td style="padding:6px;border:1px solid #cbd5e1;text-align:center"><span style="background:${statusBg};color:${statusColor};padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600">${c.status}</span></td>
      <td style="padding:6px;border:1px solid #cbd5e1;font-size:12px">${entries}</td>
    </tr>`;
  }).join('');

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Comment Resolution Report</title>
<style>
  body { font-family: 'Segoe UI', sans-serif; max-width: 900px; margin: 0 auto; padding: 24px; color: #1e293b; }
  h1 { font-size: 18px; margin-bottom: 4px; }
  h2 { font-size: 14px; color: #475569; font-weight: 400; margin-bottom: 16px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th { padding: 8px; border: 1px solid #cbd5e1; background: #f1f5f9; text-align: left; font-weight: 600; }
  .summary { display: flex; gap: 16px; margin-bottom: 16px; font-size: 13px; }
  .summary span { padding: 4px 12px; border-radius: 6px; }
  @media print { body { padding: 0; } }
</style></head><body>
<h1>Comment Resolution Report</h1>
<h2>UFGS ${escapeHtml(sectionMeta.sectionNumber)} - ${escapeHtml(sectionMeta.sectionTitle)} (${escapeHtml(sectionMeta.date)})</h2>
<div class="summary">
  <span style="background:#f1f5f9"><strong>${commentList.length}</strong> total</span>
  <span style="background:#fef9c3;color:#854d0e"><strong>${totalOpen}</strong> open</span>
  <span style="background:#dcfce7;color:#166534"><strong>${totalResolved}</strong> resolved</span>
</div>
<table>
  <thead><tr>
    <th>#</th><th>Block</th><th>Highlighted Text</th><th>Status</th><th>Thread</th>
  </tr></thead>
  <tbody>${rows || '<tr><td colspan="5" style="padding:12px;text-align:center;color:#94a3b8">No comments</td></tr>'}</tbody>
</table>
<div style="margin-top:24px;font-size:11px;color:#94a3b8;text-align:center">Generated ${new Date().toLocaleString()} by SecWriter</div>
</body></html>`;
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
