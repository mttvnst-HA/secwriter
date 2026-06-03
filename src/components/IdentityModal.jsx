import { useState, useCallback } from 'react';
import { NO_EXFIL_PROPS } from '../lib/no-exfil.js';
import { saveIdentity, colorForName } from '../lib/identity.js';

/**
 * First-load modal that asks the user for a display name when joining a
 * collab room. Prototype stub — replaced by real auth later.
 */
export default function IdentityModal({ onIdentity, onCancel, roomId }) {
  const [name, setName] = useState('');
  const trimmed = name.trim();
  const previewColor = trimmed ? colorForName(trimmed) : '#94a3b8';

  const handleSubmit = useCallback((e) => {
    e.preventDefault();
    if (!trimmed) return;
    const identity = saveIdentity({ name: trimmed });
    onIdentity(identity);
  }, [trimmed, onIdentity]);

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(15, 23, 42, 0.55)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999,
      fontFamily: "'Inter', 'Segoe UI', sans-serif",
    }}>
      <form
        onSubmit={handleSubmit}
        onKeyDown={(e) => { if (e.key === 'Escape') onCancel?.(); }}
        style={{
          background: '#ffffff', borderRadius: 10, padding: '28px 32px', minWidth: 360,
          boxShadow: '0 20px 40px rgba(15,23,42,0.25)',
        }}>
        <h2 style={{ margin: '0 0 8px', fontSize: 18, color: '#1e293b' }}>
          Join collaborative room
        </h2>
        <p style={{ margin: '0 0 16px', fontSize: 13, color: '#64748b' }}>
          Room <code style={{ background: '#f1f5f9', padding: '1px 6px', borderRadius: 4 }}>{roomId}</code> — enter your name so others can see who&apos;s editing.
        </p>
        <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#475569', marginBottom: 6 }}>
          Your name
        </label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Jordan Rivera"
          autoFocus
          {...NO_EXFIL_PROPS}
          style={{
            width: '100%', boxSizing: 'border-box',
            padding: '10px 12px', fontSize: 14,
            border: '1px solid #cbd5e1', borderRadius: 6,
            outline: 'none',
          }}
        />
        <div style={{ marginTop: 14, display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{
            width: 28, height: 28, borderRadius: '50%',
            background: previewColor, color: '#fff',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 12, fontWeight: 700,
          }}>
            {trimmed ? trimmed[0].toUpperCase() : '?'}
          </div>
          <span style={{ fontSize: 12, color: '#64748b' }}>
            Your color will be assigned from your name.
          </span>
        </div>
        <div style={{ marginTop: 20, display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button
            type="button"
            onClick={onCancel}
            style={{
              padding: '8px 16px', fontSize: 13, fontWeight: 600,
              background: '#f1f5f9', color: '#475569',
              border: '1px solid #cbd5e1', borderRadius: 6, cursor: 'pointer',
            }}
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!trimmed}
            style={{
              padding: '8px 16px', fontSize: 13, fontWeight: 600,
              background: trimmed ? '#2563eb' : '#cbd5e1',
              color: '#fff', border: 'none', borderRadius: 6,
              cursor: trimmed ? 'pointer' : 'not-allowed',
            }}
          >
            Join room
          </button>
        </div>
      </form>
    </div>
  );
}
