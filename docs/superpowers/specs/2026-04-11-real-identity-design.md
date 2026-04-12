# Real Identity — Design Spec

**Date:** 2026-04-11
**Status:** Design approved, pending implementation plan
**Scope:** Replace stub localStorage identity with JWT-based identity supporting three modes: Azure AD (MSAL.js), external token injection, and stub (dev fallback).

## Overview

SIM's collab system currently uses a stub identity stored in localStorage — users pick a display name on first load. The auth infrastructure (auth-jwt.cjs, WebSocket/HTTP middleware) is in place but the client still prompts for a name instead of reading identity from the JWT token.

This spec adds a client-side auth orchestrator that detects the identity source, handles Azure AD login via MSAL.js when configured, and maps JWT claims to the existing identity system. No server changes needed.

## Identity Modes

Three modes, detected at app load:

| Mode | Trigger | Login UX | Identity source |
|------|---------|----------|-----------------|
| **External token** | `sessionStorage['sim-auth-token']` present | None — immediate | Decode JWT payload |
| **MSAL** | `VITE_AZURE_AD_CLIENT_ID` env var set | "Sign in with Microsoft" button | MSAL acquireTokenSilent/redirect |
| **Stub** | Neither of the above | IdentityModal display name prompt | localStorage (current behavior) |

Detection order: external token > MSAL > stub. First match wins.

## Access Model

Any authenticated user can join any room. Authentication gates entry to the system; room-level authorization is not implemented. Room lock (yMeta.locked) provides basic write control.

---

## Module 1: Auth Client (`src/lib/auth-client.js`, ~150 lines)

Central orchestrator for all three identity modes.

### Public API

```javascript
/**
 * Initialize auth. Detects mode, loads MSAL if needed, checks for existing token.
 * Call once at app startup (before rendering App).
 * @returns {{ mode: 'external'|'msal'|'stub', isAuthenticated: boolean, identity: Identity|null }}
 */
export async function initAuth()

/**
 * Get a valid access token for server requests.
 * In MSAL mode, calls acquireTokenSilent (auto-refresh).
 * In external mode, returns sessionStorage token.
 * In stub mode, returns null.
 * @returns {string|null}
 */
export async function getToken()

/**
 * Get the current user identity, or null if not authenticated.
 * @returns {{ id: string, name: string, email: string|null, color: string }|null}
 */
export function getIdentity()

/**
 * Subscribe to token refresh events.
 * Callback receives the new token (or null if refresh failed = session expired).
 * @returns {() => void} unsubscribe function
 */
export function onTokenRefresh(callback)

/**
 * Trigger interactive sign-in (MSAL redirect). No-op in external/stub modes.
 */
export async function signIn()

/**
 * Sign out: clear token, MSAL logout, clear localStorage identity.
 * No-op in stub mode.
 */
export async function signOut()
```

### Mode Detection Logic

```
1. if sessionStorage['sim-auth-token'] exists and is non-empty → mode = 'external'
2. else if import.meta.env.VITE_AZURE_AD_CLIENT_ID is set → mode = 'msal'
3. else → mode = 'stub'
```

### MSAL Initialization

MSAL is lazy-loaded via dynamic `import('@azure/msal-browser')` only when mode is `'msal'`. This keeps the ~30KB MSAL bundle out of stub/external builds via Vite code splitting.

MSAL configuration:
```javascript
{
  auth: {
    clientId: import.meta.env.VITE_AZURE_AD_CLIENT_ID,
    authority: `https://login.microsoftonline.com/${import.meta.env.VITE_AZURE_AD_TENANT_ID}`,
    redirectUri: import.meta.env.VITE_AZURE_AD_REDIRECT_URI || window.location.origin,
  },
  cache: {
    cacheLocation: 'sessionStorage',  // not localStorage — matches SIM's token storage convention
  },
}
```

Scopes requested: `['openid', 'profile', 'email']`.

### Token Refresh

In MSAL mode, `getToken()` calls `acquireTokenSilent()` which handles refresh automatically via hidden iframe. If silent refresh fails (e.g., refresh token expired after extended inactivity), `onTokenRefresh` fires with `null` — LoginGate catches this to show re-auth prompt.

In external mode, `getToken()` returns the sessionStorage value as-is. No refresh — the external host is responsible for token lifecycle.

### Identity Extraction from JWT

`getToken()` returns the raw JWT. Identity is extracted by decoding the payload (base64url decode, no cryptographic verification — server validates):

| JWT Claim | Identity Field | Fallback |
|-----------|---------------|----------|
| `oid` or `sub` | `id` | `'unknown'` |
| `name` | `name` | `preferred_username` → `email` → `'Unknown'` |
| `email` or `upn` | `email` | `null` |
| (derived) | `color` | `colorForName(name)` from `identity.js` |

After extraction, calls `saveIdentity()` to persist to `localStorage['sim-identity']`. This means the existing identity consumers (PresenceBar, RemoteCursors, awareness) work unchanged — they read from localStorage.

---

## Module 2: LoginGate Component (`src/components/LoginGate.jsx`, ~60 lines)

Wraps the entire app. Gates rendering on authentication status.

### Component Tree Position

```
main.jsx → ErrorBoundary → LoginGate → App
```

### Props

```javascript
/** @param {{ children: React.ReactNode }} */
```

### Behavior by Mode

| Mode | Authenticated | Renders |
|------|--------------|---------|
| Stub | (always) | Children immediately. IdentityModal handles name prompt inside App. |
| External | Yes (token present) | Children immediately. |
| MSAL | Yes (token acquired) | Children immediately. |
| MSAL | No (not signed in) | Centered login card: SIM logo, "Sign in with Microsoft" button. |
| MSAL | Expired mid-session | Banner: "Session expired — please sign in again" + button. Editor visible but read-only via `collabReadOnly`. |

### State

```javascript
const [authState, setAuthState] = useState({ mode: null, isAuthenticated: false, identity: null, loading: true });
```

`loading: true` during `initAuth()`. Shows a minimal spinner or blank screen. `initAuth()` is fast (<100ms for stub/external, ~200ms for MSAL cache check).

### Session Expiry Handling

Subscribes to `onTokenRefresh`. When callback fires with `null`:
- Sets `authState.isAuthenticated = false`
- App sees this via context and sets `collabReadOnly = true`
- LoginGate overlays the re-auth banner (editor still visible underneath)

---

## Module 3: Integration Changes

### `identity.js` — Add `identityFromToken()`

```javascript
/**
 * Extract identity from a JWT access token and persist to localStorage.
 * @param {string} jwt — raw JWT string (header.payload.signature)
 * @returns {{ id: string, name: string, email: string|null, color: string }}
 */
export function identityFromToken(jwt) {
  const payload = JSON.parse(atob(jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
  const name = payload.name || payload.preferred_username || payload.email || 'Unknown';
  const identity = {
    id: payload.oid || payload.sub || 'unknown',
    name,
    email: payload.email || payload.upn || null,
    color: colorForName(name),
  };
  saveIdentity(identity);
  return identity;
}
```

Existing functions (`loadIdentity`, `saveIdentity`, `colorForName`, `initialsFor`) unchanged.

### `App.jsx` — 3 Targeted Edits

**Edit 1: Reactive token state**

Replace:
```javascript
const authToken = typeof sessionStorage !== 'undefined' ? sessionStorage.getItem('sim-auth-token') : null;
const authHeaders = authToken ? { 'Authorization': `Bearer ${authToken}` } : {};
```

With:
```javascript
const [authToken, setAuthToken] = useState(null);  // populated by effect below
const authHeaders = useMemo(() => authToken ? { 'Authorization': `Bearer ${authToken}` } : {}, [authToken]);

useEffect(() => {
  // Refresh token on mount (MSAL silent refresh) and subscribe to changes
  getToken().then(setAuthToken);
  return onTokenRefresh(setAuthToken);
}, []);
```

This ensures HTTP headers and the WebSocket connection use fresh tokens after MSAL silent refresh.

**Edit 2: Gate IdentityModal on stub mode**

Replace:
```jsx
{inRoom && !identity && (<IdentityModal ... />)}
```

With:
```jsx
{inRoom && !identity && authMode === 'stub' && (<IdentityModal ... />)}
```

Where `authMode` comes from LoginGate's context or a module-level export from auth-client.

**Edit 3: Sign-out in toolbar**

When `authMode !== 'stub'`, show the user's name and a sign-out option in the toolbar area. Minimal UI — a small text link or dropdown near the presence bar:

```jsx
{authMode !== 'stub' && identity && (
  <span style={{ fontSize: 12, color: '#6b7280' }}>
    {identity.name} · <button onClick={signOut} style={linkStyle}>Sign out</button>
  </span>
)}
```

### `collab.js` — Token Refresh on Reconnect

Add a `getToken` function parameter to `createCollabSession`:

```javascript
export function createCollabSession({
  room,
  token = null,
  getToken = null,  // NEW: async () => string|null — called on reconnect
  ...
}) {
```

When `getToken` is provided, hook into y-websocket's reconnect cycle. Before each reconnect, call `getToken()` to get a fresh token and update the WebSocket URL:

```javascript
provider.on('status', ({ status }) => {
  if (status === 'connecting' && getToken) {
    getToken().then(freshToken => {
      if (freshToken && freshToken !== token) {
        token = freshToken;
        // Update the URL y-websocket will reconnect to
        provider.url = `${wsUrl}/${room}?token=${encodeURIComponent(freshToken)}`;
      }
    });
  }
});
```

This ensures reconnections after token refresh use the new token, not the stale one from session start.

### Server Changes

None. The existing `auth-jwt.cjs` already:
- Validates Azure AD tokens (RS256 via public key, or HS256 via shared secret)
- Extracts `sub`, `name`, `email` from standard JWT claims
- `requiresAuth: true` flag gates unauthenticated connections

---

## Configuration

### Vite Env Vars (all optional)

```
VITE_AZURE_AD_CLIENT_ID=<app-registration-guid>     # Azure AD app registration
VITE_AZURE_AD_TENANT_ID=<tenant-guid>               # Azure AD tenant
VITE_AZURE_AD_REDIRECT_URI=http://localhost:5173     # OAuth redirect (defaults to window.location.origin)
```

Absence of `VITE_AZURE_AD_CLIENT_ID` = stub mode. No MSAL loaded, no login page, current behavior preserved.

### `.env.example` (new file, committed)

```
# Azure AD authentication (optional — omit for local dev with stub identity)
# VITE_AZURE_AD_CLIENT_ID=
# VITE_AZURE_AD_TENANT_ID=
# VITE_AZURE_AD_REDIRECT_URI=http://localhost:5173

# Server auth (must match client config)
# SIM_AUTH_PROVIDER=jwt
# SIM_AUTH_JWT_SECRET=
# SIM_AUTH_JWT_ISSUER=https://login.microsoftonline.com/<tenant-id>/v2.0
# SIM_AUTH_JWT_AUDIENCE=<client-id>
```

### Azure AD App Registration (documentation only — not implemented by SIM)

Prerequisites for MSAL mode:
1. Register an app in Azure AD / Entra ID
2. Add a **SPA** redirect URI pointing to SIM's URL
3. Enable `openid`, `profile`, `email` scopes
4. Note the client ID and tenant ID
5. Configure the collab server with matching `SIM_AUTH_JWT_ISSUER` and `SIM_AUTH_JWT_AUDIENCE`

---

## Testing Strategy

### Unit Tests

| File | Tests | Runner | Coverage |
|------|-------|--------|----------|
| `auth-client.test.js` | 8-10 | Vitest | Mode detection (3 modes), `identityFromToken` claim mapping, `getToken` per mode, `onTokenRefresh` callback, `signIn`/`signOut` state transitions |
| `LoginGate.test.jsx` | 4-5 | Vitest | Passthrough in stub mode, login card in MSAL unauthenticated, children rendered when authenticated, expired token banner, loading state |
| `identity.test.js` (extend) | 3 | Vitest | `identityFromToken()`: standard claims, missing claims fallback, writes to localStorage |

### Mock Strategy

`@azure/msal-browser` is mocked in tests:
```javascript
vi.mock('@azure/msal-browser', () => ({
  PublicClientApplication: vi.fn().mockImplementation(() => ({
    initialize: vi.fn().mockResolvedValue(undefined),
    handleRedirectPromise: vi.fn().mockResolvedValue(null),
    acquireTokenSilent: vi.fn().mockResolvedValue({ accessToken: 'mock-jwt' }),
    loginRedirect: vi.fn(),
    logout: vi.fn(),
    getAllAccounts: vi.fn().mockReturnValue([]),
  })),
}));
```

### Manual Test Procedure (Azure AD)

Not automatable without a real tenant. Document as a manual test:
1. Configure `.env` with real Azure AD client/tenant
2. Start dev server + collab server
3. Open `localhost:5173/?room=test`
4. Verify "Sign in with Microsoft" appears
5. Sign in, verify identity shows in toolbar and presence bar
6. Open second tab, verify both users appear
7. Wait for token expiry (or shorten token lifetime in Azure), verify re-auth banner

---

## Dependencies

| Package | Version | Purpose | Bundle impact |
|---------|---------|---------|--------------|
| `@azure/msal-browser` | ^3.x | Azure AD authentication | ~30KB gzipped, lazy-loaded only in MSAL mode |

No new server dependencies.

---

## Files Changed Summary

| File | Action | Lines (est.) |
|------|--------|-------------|
| `src/lib/auth-client.js` | Create | ~150 |
| `src/components/LoginGate.jsx` | Create | ~60 |
| `src/lib/identity.js` | Modify | +15 |
| `src/App.jsx` | Modify | +20, -10 |
| `src/main.jsx` | Modify | +5 (wrap with LoginGate) |
| `src/lib/collab.js` | Modify | +15 |
| `.env.example` | Create | ~10 |
| `src/lib/__tests__/auth-client.test.js` | Create | ~120 |
| `src/components/__tests__/LoginGate.test.jsx` | Create | ~60 |
| `src/lib/__tests__/identity.test.js` | Extend | +30 |
