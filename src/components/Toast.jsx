import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Lightweight toast primitive — no dependencies, no portal.
 *
 * Usage:
 *   const toasts = useToasts();
 *   toasts.push({ kind: 'info', title: 'Saved', body: 'Wrote 2.1 KB.' });
 *   <ToastStack toasts={toasts.items} onDismiss={toasts.dismiss} />
 *
 * Toasts auto-dismiss after `ttl` ms (default 4000). `kind` controls the
 * accent color: 'info' | 'success' | 'warn' | 'error'. Action buttons are
 * optional — pass `actions: [{ label, onClick }]` for "Copy link"-style
 * affordances that replace the previous alert() dialogs.
 */

const KIND_ACCENT = {
  info: '#2563eb',
  success: '#16a34a',
  warn: '#d97706',
  error: '#dc2626',
};

let nextId = 1;

export function useToasts() {
  const [items, setItems] = useState([]);
  const timersRef = useRef(new Map());

  const dismiss = useCallback((id) => {
    setItems((prev) => prev.filter((t) => t.id !== id));
    const timer = timersRef.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timersRef.current.delete(id);
    }
  }, []);

  const push = useCallback((toast) => {
    const id = nextId++;
    const ttl = toast.ttl ?? 4000;
    setItems((prev) => [...prev, { id, kind: 'info', ...toast }]);
    if (ttl > 0) {
      const timer = setTimeout(() => dismiss(id), ttl);
      timersRef.current.set(id, timer);
    }
    return id;
  }, [dismiss]);

  // Clear all timers on unmount.
  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    };
  }, []);

  return { items, push, dismiss };
}

export default function ToastStack({ toasts, onDismiss }) {
  if (!toasts || toasts.length === 0) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        position: 'fixed',
        bottom: 24,
        right: 24,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        zIndex: 10000,
        maxWidth: 400,
      }}
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          style={{
            background: 'var(--sim-bg, #ffffff)',
            color: 'var(--sim-text, #1e293b)',
            border: `1px solid ${KIND_ACCENT[t.kind] || KIND_ACCENT.info}`,
            borderLeft: `4px solid ${KIND_ACCENT[t.kind] || KIND_ACCENT.info}`,
            borderRadius: 6,
            padding: '10px 12px',
            boxShadow: '0 4px 12px rgba(0,0,0,0.12)',
            fontSize: 13,
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              {t.title && (
                <div style={{ fontWeight: 600, marginBottom: t.body ? 2 : 0 }}>
                  {t.title}
                </div>
              )}
              {t.body && (
                <div style={{ wordBreak: 'break-word', opacity: 0.85 }}>
                  {t.body}
                </div>
              )}
            </div>
            <button
              type="button"
              onClick={() => onDismiss(t.id)}
              aria-label="Dismiss"
              style={{
                background: 'transparent',
                border: 'none',
                cursor: 'pointer',
                padding: 0,
                marginLeft: 4,
                fontSize: 16,
                lineHeight: 1,
                color: 'var(--sim-text, #64748b)',
                opacity: 0.6,
              }}
            >
              ×
            </button>
          </div>
          {Array.isArray(t.actions) && t.actions.length > 0 && (
            <div style={{ display: 'flex', gap: 8 }}>
              {t.actions.map((a, i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => {
                    try { a.onClick?.(); } finally {
                      if (a.dismissAfter !== false) onDismiss(t.id);
                    }
                  }}
                  style={{
                    background: KIND_ACCENT[t.kind] || KIND_ACCENT.info,
                    color: '#fff',
                    border: 'none',
                    borderRadius: 4,
                    padding: '4px 10px',
                    fontSize: 12,
                    fontWeight: 600,
                    cursor: 'pointer',
                  }}
                >
                  {a.label}
                </button>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
