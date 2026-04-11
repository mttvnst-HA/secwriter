import { useState, useEffect } from 'react';
import { Loader, WifiOff, RefreshCw } from 'lucide-react';

/**
 * Fixed banner below the toolbar showing WebSocket connection status.
 * Only visible when NOT connected (connecting, disconnected, syncing).
 *
 * Props:
 *   state: 'connecting' | 'connected' | 'disconnected' | 'syncing'
 *   reconnectIn?: number — seconds until next reconnect attempt (disconnected state)
 */
export default function ConnectionBanner({ state, reconnectIn }) {
  const [countdown, setCountdown] = useState(reconnectIn ?? 0);

  useEffect(() => {
    setCountdown(reconnectIn ?? 0);
  }, [reconnectIn]);

  useEffect(() => {
    if (state !== 'disconnected' || countdown <= 0) return;
    const id = setInterval(() => {
      setCountdown((c) => (c > 1 ? c - 1 : 0));
    }, 1000);
    return () => clearInterval(id);
  }, [state, countdown]);

  if (state === 'connected') return null;

  const configs = {
    connecting: {
      borderColor: '#d97706',
      icon: <Loader size={16} style={{ animation: 'spin 1s linear infinite' }} />,
      text: 'Connecting to room\u2026',
    },
    disconnected: {
      borderColor: '#dc2626',
      icon: <WifiOff size={16} />,
      text: `Connection lost \u2014 edits are paused. Reconnecting in ${countdown}s\u2026`,
    },
    syncing: {
      borderColor: '#d97706',
      icon: <RefreshCw size={16} style={{ animation: 'spin 1s linear infinite' }} />,
      text: 'Reconnected \u2014 syncing changes\u2026',
    },
  };

  const cfg = configs[state];
  if (!cfg) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '8px 16px',
        borderLeft: `4px solid ${cfg.borderColor}`,
        background: '#fefce8',
        fontSize: 13,
        fontWeight: 500,
        color: '#1e293b',
      }}
    >
      {cfg.icon}
      <span>{cfg.text}</span>
    </div>
  );
}
