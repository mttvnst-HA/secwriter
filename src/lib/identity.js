/**
 * User identity for collaborative editing.
 *
 * Supports two identity sources:
 * - Token-based: `identityFromToken(jwt)` extracts claims from a JWT
 *   (Azure AD / Entra ID / external token). Used when auth is configured.
 * - Manual: `saveIdentity({ name })` stores a display name in localStorage.
 *   Used in stub mode (no auth configured) via IdentityModal prompt.
 *
 * Both paths write to localStorage['sim-identity']. Downstream consumers
 * (PresenceBar, RemoteCursors, awareness) read from localStorage and don't
 * care which source produced the identity.
 *
 * Why localStorage (not sessionStorage):
 *   sessionStorage is per-tab. If the user opens the same room in two tabs
 *   of the same browser, sessionStorage gives each tab a fresh identity
 *   with a different random `id` — the presence bar dedupes by `id` and
 *   shows the user twice, and RemoteCursors renders a remote cursor
 *   pointing at the user's own caret. localStorage is shared across tabs
 *   so the same browser = same identity.
 */

const KEY = 'sim-identity';

/**
 * Deterministically map a name to a hue + readable HSL color.
 * Same name always gets the same color across clients.
 */
export function colorForName(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) | 0;
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 70%, 45%)`;
}

function genId() {
  const bytes = new Uint8Array(8);
  (globalThis.crypto || window.crypto).getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Read identity from localStorage, or null if not set.
 *
 * For back-compat with prototype builds that wrote to sessionStorage, we
 * check there too on miss and migrate the value up to localStorage. This
 * keeps any open tabs from suddenly re-prompting for a name after the
 * upgrade.
 */
export function loadIdentity() {
  try {
    let raw = localStorage.getItem(KEY);
    if (!raw) {
      // Migration: earlier prototype builds stored identity in sessionStorage.
      raw = sessionStorage.getItem(KEY);
      if (raw) {
        // M-5: only clear the sessionStorage fallback if the localStorage
        // write actually succeeded. Otherwise we'd re-migrate every load.
        try {
          localStorage.setItem(KEY, raw);
          sessionStorage.removeItem(KEY);
        } catch {
          // localStorage unavailable (quota, private mode). Leave
          // sessionStorage in place so the identity is still usable for
          // this session.
        }
      }
    }
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.name !== 'string' || !parsed.name.trim()) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Persist identity to localStorage. Fills in missing id/color. */
export function saveIdentity(identity) {
  const full = {
    id: identity.id || genId(),
    name: identity.name.trim(),
    color: identity.color || colorForName(identity.name.trim()),
  };
  try {
    localStorage.setItem(KEY, JSON.stringify(full));
  } catch {
    /* ignore quota errors in prototype */
  }
  return full;
}

/**
 * Extract identity from a JWT access token and persist to localStorage.
 * Decodes the payload (base64url) without cryptographic verification —
 * the server validates the token; the client just reads claims for display.
 *
 * @param {string} jwt — raw JWT string (header.payload.signature)
 * @returns {{ id: string, name: string, email: string|null, color: string }}
 */
export function identityFromToken(jwt) {
  const parts = jwt.split('.');
  if (parts.length < 2) return { ...saveIdentity({ name: 'Unknown' }), email: null };
  const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
  const name = payload.name || payload.preferred_username || payload.email || payload.upn || 'Unknown';
  const email = payload.email || payload.upn || null;
  const saved = saveIdentity({
    id: payload.oid || payload.sub || 'unknown',
    name,
    color: colorForName(name),
  });
  return { ...saved, email };
}

/** Initials helper for the presence bar. */
export function initialsFor(name) {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
