import { useEffect, useState, useCallback } from 'react';
import { X, UserPlus, Mail, Link as LinkIcon } from 'lucide-react';

/**
 * #239 + #267 — owner-only share management for a room.
 *
 * Two add paths: an EMAIL invite (#267 — server stores a pending entry that
 * binds to the invitee's subject id at their next login) and the original
 * raw-subject-id grant (#239, kept as an acceptance criterion). Bound
 * collaborators render their cached display name (raw sub fallback); pending
 * invites render the email with an "invited" tag. A "Copy room link" button
 * eases owner-side delivery.
 *
 * Network is injected so the component stays React-only testable:
 *   loadAcl(roomId)  → { ownerId, roles, pending, display }
 *   submitShare(roomId, { userId|email, action, role }) → { roles } | throws
 */
export default function ShareDialog({ roomId, loadAcl, submitShare, onClose }) {
  const [acl, setAcl] = useState(null); // { ownerId, roles, pending, display }
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [newEmail, setNewEmail] = useState('');
  const [newUserId, setNewUserId] = useState('');
  const [newRole, setNewRole] = useState('editor');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

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

  // Raw-sub mutations trust the returned roles map (a concurrent owner change
  // is reflected). Email mutations produce NO roles delta, so they refresh()
  // to surface the new pending entry.
  const mutate = useCallback(async (payload, { reload = false } = {}) => {
    setBusy(true);
    setError(null);
    try {
      const res = await submitShare(roomId, payload);
      if (reload) {
        await refresh();
      } else {
        setAcl((prev) => (prev ? { ...prev, roles: res.roles || {} } : prev));
      }
    } catch (err) {
      setError(err?.message || 'Update failed');
    } finally {
      setBusy(false);
    }
  }, [roomId, submitShare, refresh]);

  const handleInvite = () => {
    const email = newEmail.trim();
    if (!email || busy) return;
    mutate({ email, action: 'add', role: newRole }, { reload: true });
    setNewEmail('');
  };
  const handleRemovePending = (email) => mutate({ email, action: 'remove' }, { reload: true });
  const handleAdd = () => {
    const uid = newUserId.trim();
    if (!uid || busy) return;
    mutate({ userId: uid, action: 'add', role: newRole });
    setNewUserId('');
  };

  const copyLink = async () => {
    try {
      const url = `${window.location.origin}${window.location.pathname}?room=${encodeURIComponent(roomId)}`;
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setError('Could not copy link');
    }
  };

  const roleEntries = acl ? Object.entries(acl.roles || {}) : [];
  const pendingEntries = acl ? Object.entries(acl.pending || {}) : [];
  const nameFor = (uid) => (acl?.display?.[uid]?.name) || uid;

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
        width: 440, maxWidth: '90vw', maxHeight: '80vh',
        background: '#fff', borderRadius: 8, overflow: 'hidden',
        display: 'flex', flexDirection: 'column',
        boxShadow: '0 10px 40px rgba(0,0,0,0.2)',
      }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', borderBottom: '1px solid #e2e8f0' }}>
          <span style={{ fontWeight: 600, fontSize: 14, color: '#1e293b' }}>Share &ldquo;{roomId}&rdquo;</span>
          <div style={{ display: 'flex', gap: 4 }}>
            <button onClick={copyLink} title="Copy room link"
              style={{ border: '1px solid #cbd5e1', background: '#f8fafc', cursor: 'pointer', color: '#334155', padding: '2px 8px', borderRadius: 4, fontSize: 12, display: 'flex', alignItems: 'center', gap: 4 }}>
              <LinkIcon size={13} /> {copied ? 'Copied!' : 'Copy room link'}
            </button>
            <button onClick={onClose} title="Close" style={{ border: 'none', background: 'none', cursor: 'pointer', color: '#64748b', padding: 4, display: 'flex' }}>
              <X size={16} />
            </button>
          </div>
        </div>

        {/* Body */}
        <div style={{ padding: '12px 16px', overflowY: 'auto', flex: 1 }}>
          {error && <div style={{ color: '#b91c1c', fontSize: 12, marginBottom: 8 }}>{error}</div>}
          {loading ? (
            <div style={{ color: '#94a3b8', fontSize: 12 }}>Loading…</div>
          ) : (
            <>
              {acl && (
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '4px 0', fontSize: 12 }}>
                  <span style={{ color: '#1e293b', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{nameFor(acl.ownerId)}</span>
                  <span style={{ color: '#64748b', flexShrink: 0, marginLeft: 8 }}>Owner</span>
                </div>
              )}
              {roleEntries.length === 0 && pendingEntries.length === 0 && (
                <div style={{ color: '#94a3b8', fontSize: 12, padding: '8px 0' }}>No collaborators yet.</div>
              )}
              {roleEntries.map(([uid, role]) => (
                <div key={uid} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '4px 0', fontSize: 12 }}>
                  <span style={{ color: '#1e293b', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{nameFor(uid)}</span>
                  <select value={role} disabled={busy} aria-label={`Role for ${uid}`}
                    onChange={(e) => mutate({ userId: uid, action: 'add', role: e.target.value })}
                    style={{ fontSize: 12, padding: '2px 4px', borderRadius: 4, border: '1px solid #cbd5e1' }}>
                    <option value="viewer">Viewer</option>
                    <option value="editor">Editor</option>
                  </select>
                  <button onClick={() => mutate({ userId: uid, action: 'remove' })} disabled={busy} title="Remove"
                    style={{ border: 'none', background: 'none', cursor: 'pointer', color: '#94a3b8', padding: 4, display: 'flex' }}>
                    <X size={14} />
                  </button>
                </div>
              ))}
              {pendingEntries.map(([email, info]) => (
                <div key={`p-${email}`} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '4px 0', fontSize: 12 }}>
                  <span style={{ color: '#1e293b', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{email}</span>
                  <span style={{ color: '#a16207', background: '#fef9c3', borderRadius: 4, padding: '1px 6px', flexShrink: 0 }}>invited · {info.role}</span>
                  <button onClick={() => handleRemovePending(email)} disabled={busy} title="Revoke invite"
                    style={{ border: 'none', background: 'none', cursor: 'pointer', color: '#94a3b8', padding: 4, display: 'flex' }}>
                    <X size={14} />
                  </button>
                </div>
              ))}
            </>
          )}
        </div>

        {/* Invite by email */}
        <div style={{ display: 'flex', gap: 6, padding: '10px 16px', borderTop: '1px solid #e2e8f0' }}>
          <input type="email" value={newEmail}
            onChange={(e) => setNewEmail(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleInvite(); }}
            placeholder="Invite by email…" aria-label="Invite by email"
            style={{ flex: 1, minWidth: 0, border: '1px solid #cbd5e1', borderRadius: 4, padding: '4px 8px', fontSize: 12, outline: 'none' }} />
          <select value={newRole} onChange={(e) => setNewRole(e.target.value)} aria-label="New collaborator role"
            style={{ fontSize: 12, padding: '2px 4px', borderRadius: 4, border: '1px solid #cbd5e1' }}>
            <option value="viewer">Viewer</option>
            <option value="editor">Editor</option>
          </select>
          <button onClick={handleInvite} disabled={busy || !newEmail.trim()}
            style={{ border: 'none', backgroundColor: '#3b82f6', color: '#fff', borderRadius: 4, padding: '4px 10px', fontSize: 12, fontWeight: 600, cursor: busy || !newEmail.trim() ? 'default' : 'pointer', opacity: busy || !newEmail.trim() ? 0.6 : 1, display: 'flex', alignItems: 'center', gap: 4 }}>
            <Mail size={13} /> Invite
          </button>
        </div>

        {/* Add by raw subject id (kept — acceptance criterion) */}
        <div style={{ display: 'flex', gap: 6, padding: '0 16px 10px', alignItems: 'center' }}>
          <input type="text" value={newUserId}
            onChange={(e) => setNewUserId(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleAdd(); }}
            placeholder="Collaborator subject id…" aria-label="Collaborator subject id"
            style={{ flex: 1, minWidth: 0, border: '1px solid #e2e8f0', borderRadius: 4, padding: '4px 8px', fontSize: 11, outline: 'none', color: '#64748b' }} />
          <button onClick={handleAdd} disabled={busy || !newUserId.trim()}
            style={{ border: '1px solid #cbd5e1', background: '#f8fafc', color: '#334155', borderRadius: 4, padding: '4px 10px', fontSize: 11, cursor: busy || !newUserId.trim() ? 'default' : 'pointer', opacity: busy || !newUserId.trim() ? 0.6 : 1, display: 'flex', alignItems: 'center', gap: 4 }}>
            <UserPlus size={12} /> Add
          </button>
        </div>
      </div>
    </div>
  );
}
