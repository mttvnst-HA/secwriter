import { useEffect, useState, useCallback } from 'react';
import { X, UserPlus } from 'lucide-react';

/**
 * #239 — owner-only share management for a room. Lists the graded-role
 * collaborators from GET /rooms/:id/acl and mutates them via
 * PATCH /rooms/:id/share ({ userId, action:'add'|'remove', role }).
 *
 * The server is the authority: this dialog only surfaces the opaque subject
 * ids the owner already knows (no user-directory discovery — deferred, see
 * ADR-0017). `role` grants are limited to viewer/editor; ownership is not
 * transferable here.
 *
 * Network is injected so the component stays React-only testable:
 *   loadAcl(roomId)                     → { ownerId, roles: { <sub>: role } }
 *   submitShare(roomId, { userId, action, role }) → { roles } | throws
 */
export default function ShareDialog({ roomId, loadAcl, submitShare, onClose }) {
  const [acl, setAcl] = useState(null); // { ownerId, roles }
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [newUserId, setNewUserId] = useState('');
  const [newRole, setNewRole] = useState('editor');
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await loadAcl(roomId);
      setAcl(next);
    } catch (err) {
      setError(err?.message || 'Failed to load collaborators');
    } finally {
      setLoading(false);
    }
  }, [roomId, loadAcl]);

  useEffect(() => { refresh(); }, [refresh]);

  const mutate = useCallback(async (payload) => {
    setBusy(true);
    setError(null);
    try {
      const res = await submitShare(roomId, payload);
      // The route returns the authoritative roles map — trust it over a
      // local edit so a concurrent owner's change is reflected.
      setAcl((prev) => (prev ? { ...prev, roles: res.roles || {} } : prev));
    } catch (err) {
      setError(err?.message || 'Update failed');
    } finally {
      setBusy(false);
    }
  }, [roomId, submitShare]);

  const handleAdd = () => {
    const uid = newUserId.trim();
    if (!uid || busy) return;
    mutate({ userId: uid, action: 'add', role: newRole });
    setNewUserId('');
  };

  const roleEntries = acl ? Object.entries(acl.roles || {}) : [];

  return (
    <div
      role="dialog"
      aria-label="Share room"
      onClick={(e) => e.stopPropagation()}
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'rgba(15,23,42,0.35)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
    >
      <div style={{
        width: 420, maxWidth: '90vw', maxHeight: '80vh',
        background: '#fff', borderRadius: 8, overflow: 'hidden',
        display: 'flex', flexDirection: 'column',
        boxShadow: '0 10px 40px rgba(0,0,0,0.2)',
      }}>
        {/* Header */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '12px 16px', borderBottom: '1px solid #e2e8f0',
        }}>
          <span style={{ fontWeight: 600, fontSize: 14, color: '#1e293b' }}>
            Share &ldquo;{roomId}&rdquo;
          </span>
          <button
            onClick={onClose}
            title="Close"
            style={{ border: 'none', background: 'none', cursor: 'pointer', color: '#64748b', padding: 4, display: 'flex' }}
          >
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <div style={{ padding: '12px 16px', overflowY: 'auto', flex: 1 }}>
          {error && (
            <div style={{ color: '#b91c1c', fontSize: 12, marginBottom: 8 }}>{error}</div>
          )}
          {loading ? (
            <div style={{ color: '#94a3b8', fontSize: 12 }}>Loading…</div>
          ) : (
            <>
              {acl && (
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '4px 0', fontSize: 12 }}>
                  <span style={{ color: '#1e293b', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {acl.ownerId}
                  </span>
                  <span style={{ color: '#64748b', flexShrink: 0, marginLeft: 8 }}>Owner</span>
                </div>
              )}
              {roleEntries.length === 0 && (
                <div style={{ color: '#94a3b8', fontSize: 12, padding: '8px 0' }}>
                  No collaborators yet.
                </div>
              )}
              {roleEntries.map(([uid, role]) => (
                <div key={uid} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '4px 0', fontSize: 12 }}>
                  <span style={{ color: '#1e293b', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                    {uid}
                  </span>
                  <select
                    value={role}
                    disabled={busy}
                    aria-label={`Role for ${uid}`}
                    onChange={(e) => mutate({ userId: uid, action: 'add', role: e.target.value })}
                    style={{ fontSize: 12, padding: '2px 4px', borderRadius: 4, border: '1px solid #cbd5e1' }}
                  >
                    <option value="viewer">Viewer</option>
                    <option value="editor">Editor</option>
                  </select>
                  <button
                    onClick={() => mutate({ userId: uid, action: 'remove' })}
                    disabled={busy}
                    title="Remove"
                    style={{ border: 'none', background: 'none', cursor: 'pointer', color: '#94a3b8', padding: 4, display: 'flex' }}
                  >
                    <X size={14} />
                  </button>
                </div>
              ))}
            </>
          )}
        </div>

        {/* Add form */}
        <div style={{ display: 'flex', gap: 6, padding: '10px 16px', borderTop: '1px solid #e2e8f0' }}>
          <input
            type="text"
            value={newUserId}
            onChange={(e) => setNewUserId(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleAdd(); }}
            placeholder="Collaborator subject id…"
            aria-label="Collaborator subject id"
            style={{ flex: 1, minWidth: 0, border: '1px solid #cbd5e1', borderRadius: 4, padding: '4px 8px', fontSize: 12, outline: 'none' }}
          />
          <select
            value={newRole}
            onChange={(e) => setNewRole(e.target.value)}
            aria-label="New collaborator role"
            style={{ fontSize: 12, padding: '2px 4px', borderRadius: 4, border: '1px solid #cbd5e1' }}
          >
            <option value="viewer">Viewer</option>
            <option value="editor">Editor</option>
          </select>
          <button
            onClick={handleAdd}
            disabled={busy || !newUserId.trim()}
            style={{
              border: 'none', backgroundColor: '#3b82f6', color: '#fff',
              borderRadius: 4, padding: '4px 10px', fontSize: 12, fontWeight: 600,
              cursor: busy || !newUserId.trim() ? 'default' : 'pointer',
              opacity: busy || !newUserId.trim() ? 0.6 : 1,
              display: 'flex', alignItems: 'center', gap: 4,
            }}
          >
            <UserPlus size={13} /> Add
          </button>
        </div>
      </div>
    </div>
  );
}
