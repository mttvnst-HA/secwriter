import { useState, useEffect } from 'react';
import { Loader, WifiOff, RefreshCw, AlertTriangle } from 'lucide-react';

/**
 * Fixed banner below the toolbar showing WebSocket connection status.
 * Only visible when NOT connected (connecting, disconnected, syncing,
 * incompatible, migration-partial).
 *
 * Props:
 *   state: 'connecting' | 'connected' | 'disconnected' | 'syncing'
 *        | 'incompatible' | 'migration-partial'
 *   reconnectIn?: number — seconds until next reconnect attempt (disconnected state)
 *
 * 'incompatible' is the schema-version gate from sub-PR 1b.1 (#47):
 * the room's yMeta.schemaVersion exceeds this client's MAX_SUPPORTED_SCHEMA_VERSION.
 * The banner is sticky — only a page reload (and a newer client) clears it.
 *
 * 'migration-partial' is the v1 → v2 substrate broker outcome from sub-PR 1d
 * ([ADR-0006](../../docs/adr/0006-pm-substrate-migration.md)): the broker
 * succeeded for some blocks but per-block conversion threw on others. The
 * room is still editable — the banner is informational. v1 clients still
 * join; v2 clients see the banner alongside the editor.
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
    incompatible: {
      borderColor: '#dc2626',
      icon: <AlertTriangle size={16} />,
      text: 'This room requires a newer client. Please reload.',
    },
    'migration-partial': {
      borderColor: '#d97706',
      icon: <AlertTriangle size={16} />,
      text: 'This room’s migration had issues — some blocks remain in legacy mode. Editing continues, but please report this room ID.',
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
