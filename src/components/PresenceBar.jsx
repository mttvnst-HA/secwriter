import { initialsFor } from '../lib/identity.js';

/**
 * Small horizontal stack of colored circles showing everyone currently in
 * the room. Hovering a circle reveals the full name as a tooltip.
 */
export default function PresenceBar({ peers, self }) {
  // Order: self first, others after, deduped by user.id
  const seen = new Set();
  const ordered = [];
  if (self) {
    ordered.push({ ...self, isSelf: true });
    seen.add(self.id);
  }
  for (const p of peers) {
    const u = p?.user;
    if (!u || !u.id || seen.has(u.id)) continue;
    seen.add(u.id);
    ordered.push({ ...u, isSelf: false });
  }

  if (ordered.length === 0) return null;

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 4,
      padding: '0 8px',
    }}>
      {ordered.map((u) => (
        <div
          key={u.id}
          title={u.isSelf ? `${u.name} (you)` : u.name}
          style={{
            width: 26, height: 26, borderRadius: '50%',
            background: u.color || '#64748b',
            color: '#fff',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 11, fontWeight: 700,
            border: u.isSelf ? '2px solid #fff' : '2px solid rgba(255,255,255,0.6)',
            boxShadow: '0 1px 3px rgba(15,23,42,0.3)',
            marginLeft: -6,
          }}
        >
          {initialsFor(u.name)}
        </div>
      ))}
    </div>
  );
}
