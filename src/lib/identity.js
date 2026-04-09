/**
 * User identity for the collab prototype.
 *
 * No real authentication yet — this is a stub that stores a display name in
 * sessionStorage. When real auth lands, the login flow should write to the
 * same key (`sim-identity`) and the IdentityModal will no longer prompt.
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

/** Read identity from sessionStorage, or null if not set. */
export function loadIdentity() {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.name !== 'string' || !parsed.name.trim()) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Persist identity to sessionStorage. Fills in missing id/color. */
export function saveIdentity(identity) {
  const full = {
    id: identity.id || genId(),
    name: identity.name.trim(),
    color: identity.color || colorForName(identity.name.trim()),
  };
  try {
    sessionStorage.setItem(KEY, JSON.stringify(full));
  } catch {
    /* ignore quota errors in prototype */
  }
  return full;
}

/** Initials helper for the presence bar. */
export function initialsFor(name) {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
