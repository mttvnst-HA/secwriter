# Real Identity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace stub localStorage identity with JWT-based identity supporting three modes: Azure AD (MSAL.js), external token injection, and stub (dev fallback).

**Architecture:** A client-side auth orchestrator (`auth-client.js`) detects the identity source at startup, lazily loads MSAL.js when Azure AD is configured, and maps JWT claims to the existing identity system. A `LoginGate` component wraps the app to gate rendering on auth status. No server changes needed.

**Tech Stack:** @azure/msal-browser (lazy-loaded), React 18, Vitest

**Design spec:** `docs/superpowers/specs/2026-04-11-real-identity-design.md`

---

## File Structure

### New Files
- `src/lib/auth-client.js` — Auth orchestrator: mode detection, token management, MSAL integration
- `src/components/LoginGate.jsx` — App wrapper: gates rendering on auth, shows login card or expiry banner
- `.env.example` — Documented env vars for Azure AD + server auth
- `src/lib/__tests__/auth-client.test.js` — Auth orchestrator tests
- `src/components/__tests__/LoginGate.test.jsx` — LoginGate rendering tests

### Modified Files
- `src/lib/identity.js` — Add `identityFromToken(jwt)` function
- `src/main.jsx` — Wrap App with LoginGate
- `src/App.jsx` — Reactive token state, gate IdentityModal on stub mode, sign-out UI
- `src/lib/collab.js` — Add `getTokenFn` parameter for reconnect token refresh

---

## Task 1: Add `identityFromToken()` to identity.js

**Files:**
- Modify: `src/lib/identity.js`
- Test: `src/lib/__tests__/identity.test.js` (extend existing or create)

- [ ] **Step 1: Write failing tests for identityFromToken**

Add to `src/lib/__tests__/identity.test.js` (or create if it doesn't exist — check first):

```javascript
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { identityFromToken, loadIdentity } from '../identity.js';

// Helper: create a minimal JWT with the given payload (no signature verification — client-side decode only)
function fakeJwt(payload) {
  const header = btoa(JSON.stringify({ alg: 'none' }));
  const body = btoa(JSON.stringify(payload));
  return `${header}.${body}.fake-sig`;
}

describe('identityFromToken', () => {
  beforeEach(() => { localStorage.clear(); });

  it('extracts standard Azure AD claims', () => {
    const jwt = fakeJwt({ oid: 'user-abc', name: 'Matt V', email: 'matt@example.com' });
    const identity = identityFromToken(jwt);
    expect(identity.id).toBe('user-abc');
    expect(identity.name).toBe('Matt V');
    expect(identity.email).toBe('matt@example.com');
    expect(identity.color).toMatch(/^hsl\(/);
  });

  it('falls back through claim hierarchy when fields are missing', () => {
    const jwt = fakeJwt({ sub: 'sub-123', preferred_username: 'jdoe@corp.com' });
    const identity = identityFromToken(jwt);
    expect(identity.id).toBe('sub-123');
    expect(identity.name).toBe('jdoe@corp.com');
    expect(identity.email).toBeNull();
  });

  it('persists to localStorage', () => {
    const jwt = fakeJwt({ oid: 'u1', name: 'Test User', email: 'test@example.com' });
    identityFromToken(jwt);
    const stored = loadIdentity();
    expect(stored).not.toBeNull();
    expect(stored.id).toBe('u1');
    expect(stored.name).toBe('Test User');
  });

  it('handles completely empty payload gracefully', () => {
    const jwt = fakeJwt({});
    const identity = identityFromToken(jwt);
    expect(identity.id).toBe('unknown');
    expect(identity.name).toBe('Unknown');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --run src/lib/__tests__/identity.test.js`
Expected: FAIL — `identityFromToken` is not exported from `identity.js`.

- [ ] **Step 3: Implement identityFromToken**

Add to `src/lib/identity.js`, after the existing `initialsFor` function:

```javascript
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
  if (parts.length < 2) return saveIdentity({ name: 'Unknown' });
  const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
  const name = payload.name || payload.preferred_username || payload.email || payload.upn || 'Unknown';
  return saveIdentity({
    id: payload.oid || payload.sub || 'unknown',
    name,
    email: payload.email || payload.upn || null,
    color: colorForName(name),
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- --run src/lib/__tests__/identity.test.js`
Expected: All 4 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/identity.js src/lib/__tests__/identity.test.js
git commit -m "feat(auth): add identityFromToken — extract identity from JWT claims"
```

---

## Task 2: Create auth-client.js

**Files:**
- Create: `src/lib/auth-client.js`
- Create: `src/lib/__tests__/auth-client.test.js`

- [ ] **Step 1: Write failing tests**

Create `src/lib/__tests__/auth-client.test.js`:

```javascript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Helper: create a minimal JWT with the given payload
function fakeJwt(payload) {
  const header = btoa(JSON.stringify({ alg: 'none' }));
  const body = btoa(JSON.stringify(payload));
  return `${header}.${body}.fake-sig`;
}

const MOCK_JWT = fakeJwt({ oid: 'user-1', name: 'Test User', email: 'test@example.com' });

describe('auth-client', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    // Reset module state between tests
    vi.resetModules();
  });

  it('detects external token mode when sessionStorage has token', async () => {
    sessionStorage.setItem('sim-auth-token', MOCK_JWT);
    const { initAuth } = await import('../auth-client.js');
    const result = await initAuth();
    expect(result.mode).toBe('external');
    expect(result.isAuthenticated).toBe(true);
    expect(result.identity).not.toBeNull();
    expect(result.identity.id).toBe('user-1');
  });

  it('detects stub mode when no token and no MSAL config', async () => {
    const { initAuth } = await import('../auth-client.js');
    const result = await initAuth();
    expect(result.mode).toBe('stub');
    expect(result.isAuthenticated).toBe(false);
    expect(result.identity).toBeNull();
  });

  it('getToken returns sessionStorage token in external mode', async () => {
    sessionStorage.setItem('sim-auth-token', MOCK_JWT);
    const { initAuth, getToken } = await import('../auth-client.js');
    await initAuth();
    const token = await getToken();
    expect(token).toBe(MOCK_JWT);
  });

  it('getToken returns null in stub mode', async () => {
    const { initAuth, getToken } = await import('../auth-client.js');
    await initAuth();
    const token = await getToken();
    expect(token).toBeNull();
  });

  it('getIdentity returns identity after external init', async () => {
    sessionStorage.setItem('sim-auth-token', MOCK_JWT);
    const { initAuth, getIdentity } = await import('../auth-client.js');
    await initAuth();
    const identity = getIdentity();
    expect(identity.name).toBe('Test User');
  });

  it('getIdentity returns null before init', async () => {
    const { getIdentity } = await import('../auth-client.js');
    expect(getIdentity()).toBeNull();
  });

  it('onTokenRefresh fires callback when token changes', async () => {
    sessionStorage.setItem('sim-auth-token', MOCK_JWT);
    const { initAuth, onTokenRefresh } = await import('../auth-client.js');
    await initAuth();
    const cb = vi.fn();
    const unsub = onTokenRefresh(cb);
    // Simulate token change by calling the internal notify (exposed for testing)
    const { _notifyTokenRefresh } = await import('../auth-client.js');
    _notifyTokenRefresh('new-token');
    expect(cb).toHaveBeenCalledWith('new-token');
    unsub();
    _notifyTokenRefresh('another');
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('signIn is a no-op in stub mode', async () => {
    const { initAuth, signIn } = await import('../auth-client.js');
    await initAuth();
    await expect(signIn()).resolves.toBeUndefined();
  });

  it('signOut clears identity in external mode', async () => {
    sessionStorage.setItem('sim-auth-token', MOCK_JWT);
    const { initAuth, signOut, getIdentity } = await import('../auth-client.js');
    await initAuth();
    expect(getIdentity()).not.toBeNull();
    await signOut();
    expect(getIdentity()).toBeNull();
    expect(sessionStorage.getItem('sim-auth-token')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --run src/lib/__tests__/auth-client.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement auth-client.js**

Create `src/lib/auth-client.js`:

```javascript
/**
 * Client-side auth orchestrator.
 *
 * Supports three modes, detected at app load:
 *   1. 'external' — token already in sessionStorage (placed by portal/SSO host)
 *   2. 'msal'     — Azure AD via @azure/msal-browser (lazy-loaded)
 *   3. 'stub'     — no auth, current dev behavior (IdentityModal prompt)
 *
 * Detection order: external > msal > stub. First match wins.
 */

import { identityFromToken } from './identity.js';
import { loadIdentity, saveIdentity } from './identity.js';

const TOKEN_KEY = 'sim-auth-token';
const SCOPES = ['openid', 'profile', 'email'];

let _mode = null;       // 'external' | 'msal' | 'stub'
let _identity = null;
let _msalInstance = null;
let _msalAccount = null;
const _listeners = new Set();

/** Notify all token refresh subscribers. Exported as _notifyTokenRefresh for testing. */
export function _notifyTokenRefresh(token) {
  for (const cb of _listeners) {
    try { cb(token); } catch { /* listener error */ }
  }
}

/**
 * Initialize auth. Call once at app startup before rendering.
 */
export async function initAuth() {
  // Mode 1: external token
  const externalToken = sessionStorage.getItem(TOKEN_KEY);
  if (externalToken) {
    _mode = 'external';
    try {
      _identity = identityFromToken(externalToken);
    } catch {
      _identity = null;
    }
    return { mode: _mode, isAuthenticated: !!_identity, identity: _identity };
  }

  // Mode 2: MSAL (Azure AD)
  const clientId = import.meta.env.VITE_AZURE_AD_CLIENT_ID;
  if (clientId) {
    _mode = 'msal';
    try {
      const { PublicClientApplication } = await import('@azure/msal-browser');
      _msalInstance = new PublicClientApplication({
        auth: {
          clientId,
          authority: `https://login.microsoftonline.com/${import.meta.env.VITE_AZURE_AD_TENANT_ID || 'common'}`,
          redirectUri: import.meta.env.VITE_AZURE_AD_REDIRECT_URI || window.location.origin,
        },
        cache: { cacheLocation: 'sessionStorage' },
      });
      await _msalInstance.initialize();
      // Handle redirect callback (returns token response if returning from login)
      const redirectResult = await _msalInstance.handleRedirectPromise();
      if (redirectResult) {
        _msalAccount = redirectResult.account;
        sessionStorage.setItem(TOKEN_KEY, redirectResult.accessToken);
        _identity = identityFromToken(redirectResult.accessToken);
        return { mode: _mode, isAuthenticated: true, identity: _identity };
      }
      // Check for existing account in cache
      const accounts = _msalInstance.getAllAccounts();
      if (accounts.length > 0) {
        _msalAccount = accounts[0];
        try {
          const tokenResult = await _msalInstance.acquireTokenSilent({
            scopes: SCOPES,
            account: _msalAccount,
          });
          sessionStorage.setItem(TOKEN_KEY, tokenResult.accessToken);
          _identity = identityFromToken(tokenResult.accessToken);
          return { mode: _mode, isAuthenticated: true, identity: _identity };
        } catch {
          // Silent refresh failed — user needs to re-authenticate
          _msalAccount = null;
        }
      }
      return { mode: _mode, isAuthenticated: false, identity: null };
    } catch (err) {
      console.warn('[auth] MSAL initialization failed, falling back to stub:', err.message);
      _mode = 'stub';
      return { mode: 'stub', isAuthenticated: false, identity: null };
    }
  }

  // Mode 3: stub
  _mode = 'stub';
  _identity = loadIdentity();
  return { mode: _mode, isAuthenticated: false, identity: _identity };
}

/**
 * Get a valid access token. In MSAL mode, auto-refreshes via acquireTokenSilent.
 */
export async function getToken() {
  if (_mode === 'external') {
    return sessionStorage.getItem(TOKEN_KEY) || null;
  }
  if (_mode === 'msal' && _msalInstance && _msalAccount) {
    try {
      const result = await _msalInstance.acquireTokenSilent({
        scopes: SCOPES,
        account: _msalAccount,
      });
      const newToken = result.accessToken;
      sessionStorage.setItem(TOKEN_KEY, newToken);
      _notifyTokenRefresh(newToken);
      return newToken;
    } catch {
      // Refresh failed — session expired
      _notifyTokenRefresh(null);
      return null;
    }
  }
  return null;
}

/** Get current identity or null. */
export function getIdentity() {
  return _identity;
}

/** Get current auth mode. Returns null if initAuth hasn't been called. */
export function getAuthMode() {
  return _mode;
}

/** Subscribe to token refresh events. Returns unsubscribe function. */
export function onTokenRefresh(callback) {
  _listeners.add(callback);
  return () => _listeners.delete(callback);
}

/** Trigger interactive sign-in (MSAL redirect). No-op in external/stub. */
export async function signIn() {
  if (_mode === 'msal' && _msalInstance) {
    await _msalInstance.loginRedirect({ scopes: SCOPES });
  }
}

/** Sign out: clear token + identity. */
export async function signOut() {
  if (_mode === 'stub') return;
  sessionStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem('sim-identity');
  _identity = null;
  _msalAccount = null;
  if (_mode === 'msal' && _msalInstance) {
    try { await _msalInstance.logout(); } catch { /* ignore */ }
  }
  _notifyTokenRefresh(null);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- --run src/lib/__tests__/auth-client.test.js`
Expected: All 9 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/auth-client.js src/lib/__tests__/auth-client.test.js
git commit -m "feat(auth): add auth-client orchestrator — mode detection, token management, MSAL"
```

---

## Task 3: Create LoginGate component

**Files:**
- Create: `src/components/LoginGate.jsx`
- Create: `src/components/__tests__/LoginGate.test.jsx`

- [ ] **Step 1: Write failing tests**

Create `src/components/__tests__/LoginGate.test.jsx`:

```jsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';

// Mock auth-client before importing LoginGate
const mockInitAuth = vi.fn();
const mockOnTokenRefresh = vi.fn(() => () => {});
const mockSignIn = vi.fn();

vi.mock('../../lib/auth-client.js', () => ({
  initAuth: (...args) => mockInitAuth(...args),
  onTokenRefresh: (...args) => mockOnTokenRefresh(...args),
  signIn: (...args) => mockSignIn(...args),
  getAuthMode: () => 'stub',
}));

import LoginGate from '../LoginGate.jsx';

describe('LoginGate', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('renders children immediately in stub mode', async () => {
    mockInitAuth.mockResolvedValue({ mode: 'stub', isAuthenticated: false, identity: null });
    await act(async () => {
      render(<LoginGate><div>Editor</div></LoginGate>);
    });
    expect(screen.getByText('Editor')).toBeTruthy();
  });

  it('renders children when authenticated in external mode', async () => {
    mockInitAuth.mockResolvedValue({ mode: 'external', isAuthenticated: true, identity: { id: 'u1', name: 'Test' } });
    await act(async () => {
      render(<LoginGate><div>Editor</div></LoginGate>);
    });
    expect(screen.getByText('Editor')).toBeTruthy();
  });

  it('shows login card when MSAL mode and not authenticated', async () => {
    mockInitAuth.mockResolvedValue({ mode: 'msal', isAuthenticated: false, identity: null });
    await act(async () => {
      render(<LoginGate><div>Editor</div></LoginGate>);
    });
    expect(screen.getByText(/sign in with microsoft/i)).toBeTruthy();
    expect(screen.queryByText('Editor')).toBeNull();
  });

  it('shows loading state during init', () => {
    // Never-resolving promise to simulate loading
    mockInitAuth.mockReturnValue(new Promise(() => {}));
    render(<LoginGate><div>Editor</div></LoginGate>);
    expect(screen.queryByText('Editor')).toBeNull();
    expect(screen.queryByText(/sign in/i)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --run src/components/__tests__/LoginGate.test.jsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement LoginGate**

Create `src/components/LoginGate.jsx`:

```jsx
import { useState, useEffect } from 'react';
import { initAuth, onTokenRefresh, signIn } from '../lib/auth-client.js';

/**
 * Gates the app on authentication status.
 * - Stub mode: renders children immediately (IdentityModal handles name prompt inside App)
 * - External mode: renders children immediately (identity from token)
 * - MSAL mode, authenticated: renders children
 * - MSAL mode, not authenticated: shows "Sign in with Microsoft" card
 * - MSAL mode, expired: shows re-auth banner overlay
 */
export default function LoginGate({ children }) {
  const [authState, setAuthState] = useState({
    mode: null, isAuthenticated: false, identity: null, loading: true,
  });

  useEffect(() => {
    let cancelled = false;
    initAuth().then((result) => {
      if (!cancelled) {
        setAuthState({ ...result, loading: false });
      }
    });
    const unsub = onTokenRefresh((token) => {
      if (token === null) {
        // Token expired — session lost
        setAuthState((prev) => ({ ...prev, isAuthenticated: false }));
      }
    });
    return () => { cancelled = true; unsub(); };
  }, []);

  // Loading: show nothing (fast — <200ms)
  if (authState.loading) {
    return null;
  }

  // Stub or authenticated: render app
  if (authState.mode === 'stub' || authState.mode === 'external' || authState.isAuthenticated) {
    // If MSAL mode and token expired mid-session, show banner + children (read-only)
    if (authState.mode === 'msal' && !authState.isAuthenticated) {
      return (
        <>
          <div style={{
            position: 'fixed', top: 0, left: 0, right: 0, zIndex: 10000,
            padding: '8px 16px', backgroundColor: '#fef2f2',
            borderBottom: '2px solid #dc2626', display: 'flex',
            alignItems: 'center', gap: 12, fontSize: 13, fontWeight: 500,
          }}>
            <span>Session expired — please sign in again.</span>
            <button
              onClick={() => signIn()}
              style={{
                padding: '4px 12px', backgroundColor: '#2563eb', color: '#fff',
                border: 'none', borderRadius: 4, fontSize: 13, cursor: 'pointer',
              }}
            >Sign in</button>
          </div>
          <div style={{ marginTop: 40 }}>{children}</div>
        </>
      );
    }
    return <>{children}</>;
  }

  // MSAL mode, not authenticated: login card
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      minHeight: '100vh', fontFamily: "'Inter', 'Segoe UI', sans-serif",
      backgroundColor: '#f8fafc',
    }}>
      <div style={{
        background: '#fff', borderRadius: 12, padding: '40px 48px',
        boxShadow: '0 20px 40px rgba(15,23,42,0.12)', textAlign: 'center',
        maxWidth: 400,
      }}>
        <h1 style={{ fontSize: 22, color: '#1e293b', marginBottom: 8 }}>
          SpecsIntact Modern
        </h1>
        <p style={{ fontSize: 14, color: '#64748b', marginBottom: 24 }}>
          Sign in to access the collaborative editor.
        </p>
        <button
          onClick={() => signIn()}
          style={{
            padding: '10px 24px', fontSize: 14, fontWeight: 600,
            backgroundColor: '#2563eb', color: '#fff', border: 'none',
            borderRadius: 6, cursor: 'pointer', display: 'inline-flex',
            alignItems: 'center', gap: 8,
          }}
        >
          Sign in with Microsoft
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- --run src/components/__tests__/LoginGate.test.jsx`
Expected: All 4 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/LoginGate.jsx src/components/__tests__/LoginGate.test.jsx
git commit -m "feat(auth): add LoginGate component — gates app on auth status"
```

---

## Task 4: Wire LoginGate into main.jsx

**Files:**
- Modify: `src/main.jsx`

- [ ] **Step 1: Update main.jsx to wrap App with LoginGate**

Replace the current render tree:

```javascript
import React from 'react'
import ReactDOM from 'react-dom/client'
import SpecEditor from './App.jsx'
import LoginGate from './components/LoginGate.jsx'
import './styles/editor.css'
```

And update the render:

```jsx
ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ErrorBoundary>
      <LoginGate>
        <SpecEditor />
      </LoginGate>
    </ErrorBoundary>
  </React.StrictMode>,
)
```

- [ ] **Step 2: Run full test suite**

Run: `npm test -- --run`
Expected: All tests pass. No regression — LoginGate in stub mode passes through immediately.

- [ ] **Step 3: Commit**

```bash
git add src/main.jsx
git commit -m "feat(auth): wrap App with LoginGate in main.jsx"
```

---

## Task 5: Update App.jsx — reactive token + sign-out + gate IdentityModal

**Files:**
- Modify: `src/App.jsx`

- [ ] **Step 1: Add auth-client imports**

At the top of App.jsx, add:

```javascript
import { getToken, onTokenRefresh, getAuthMode, signOut as authSignOut } from './lib/auth-client.js';
```

- [ ] **Step 2: Replace static authToken with reactive state**

Find lines 169-171:

```javascript
  // Auth token for collab server (placed in sessionStorage by external login/SSO)
  const authToken = typeof sessionStorage !== 'undefined' ? sessionStorage.getItem('sim-auth-token') : null;
  const authHeaders = authToken ? { 'Authorization': `Bearer ${authToken}` } : {};
```

Replace with:

```javascript
  // Reactive auth token — refreshed by MSAL silent renewal or external host
  const [authToken, setAuthToken] = useState(null);
  const authHeaders = useMemo(
    () => authToken ? { 'Authorization': `Bearer ${authToken}` } : {},
    [authToken]
  );

  useEffect(() => {
    getToken().then(t => { if (t) setAuthToken(t); });
    return onTokenRefresh((t) => setAuthToken(t));
  }, []);
```

Add `useMemo` to the existing React import if not already present.

- [ ] **Step 3: Gate IdentityModal on stub mode**

Find line 2764:

```jsx
      {inRoom && !identity && (
        <IdentityModal roomId={roomId} onIdentity={setIdentity} />
      )}
```

Replace with:

```jsx
      {inRoom && !identity && getAuthMode() === 'stub' && (
        <IdentityModal roomId={roomId} onIdentity={setIdentity} />
      )}
```

- [ ] **Step 4: Add sign-out UI in toolbar**

Find the PresenceBar render (around line 1830, `{inRoom && (<PresenceBar ...`). After the PresenceBar, add:

```jsx
            {getAuthMode() !== 'stub' && identity && (
              <span style={{ fontSize: 12, color: '#6b7280', display: 'flex', alignItems: 'center', gap: 4 }}>
                {identity.name}
                <span style={{ color: '#d1d5db' }}>·</span>
                <button
                  onClick={() => authSignOut().then(() => window.location.reload())}
                  style={{
                    background: 'none', border: 'none', color: '#6b7280',
                    cursor: 'pointer', fontSize: 12, textDecoration: 'underline',
                    padding: 0,
                  }}
                >Sign out</button>
              </span>
            )}
```

- [ ] **Step 5: Load identity from auth-client on mount for non-stub modes**

In the identity initialization (around line 159), add a fallback that loads identity from auth-client when not in stub mode:

Find:
```javascript
  const [identity, setIdentity] = useState(() => (inRoom ? loadIdentity() : null));
```

This already works because `identityFromToken` calls `saveIdentity` which writes to localStorage, and `loadIdentity` reads from localStorage. No change needed — the identity is available by the time App renders because LoginGate runs `initAuth()` first.

- [ ] **Step 6: Run full test suite**

Run: `npm test -- --run`
Expected: All tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/App.jsx
git commit -m "feat(auth): reactive token state, sign-out UI, gate IdentityModal on stub mode"
```

---

## Task 6: Add getTokenFn to collab.js for reconnect token refresh

**Files:**
- Modify: `src/lib/collab.js`
- Modify: `src/App.jsx` (pass getTokenFn)

- [ ] **Step 1: Add getTokenFn parameter to createCollabSession**

In `src/lib/collab.js`, update the function signature at line 590:

```javascript
export function createCollabSession({
  room,
  wsUrl = DEFAULT_WS_URL,
  token = null,
  getTokenFn = null,  // async () => string|null — called on reconnect for fresh token
  identity,
  // ... rest unchanged
}) {
```

- [ ] **Step 2: Hook into reconnect to refresh token**

In the `handleStatus` function (around line 699), add token refresh logic before the existing status handling:

```javascript
  const handleStatus = ({ status }) => {
    // Refresh token on reconnect attempt (MSAL silent refresh)
    if (status === 'connecting' && getTokenFn) {
      getTokenFn().then(freshToken => {
        if (freshToken && freshToken !== token) {
          token = freshToken;
          // Update the URL y-websocket will reconnect to
          const newRoom = `${room}?token=${encodeURIComponent(freshToken)}`;
          provider.url = `${wsUrl}/${newRoom}`;
        }
      }).catch(() => { /* token refresh failed — reconnect with stale token */ });
    }
    if (status === 'connecting') {
      onStatusChange?.('connecting', { reconnectIn: computeReconnectIn() });
    } else if (status === 'disconnected') {
      onStatusChange?.('disconnected', { reconnectIn: computeReconnectIn() });
    }
  };
```

Note: `token` is a `let` variable (changed from `const` by the token parameter) that is captured in the closure. Updating it updates what's used on the next reconnect.

Wait — currently `token` comes in as a parameter, which is `const` by default in destructuring. We need to make it mutable. Change the setup code:

At line 613, where the effectiveRoom is computed:
```javascript
  let currentToken = token;  // mutable for reconnect refresh
  const effectiveRoom = currentToken ? `${room}?token=${encodeURIComponent(currentToken)}` : room;
  const provider = new WebsocketProvider(wsUrl, effectiveRoom, ydoc);
```

And in handleStatus:
```javascript
    if (status === 'connecting' && getTokenFn) {
      getTokenFn().then(freshToken => {
        if (freshToken && freshToken !== currentToken) {
          currentToken = freshToken;
          const newRoom = `${room}?token=${encodeURIComponent(freshToken)}`;
          provider.url = `${wsUrl}/${newRoom}`;
        }
      }).catch(() => {});
    }
```

- [ ] **Step 3: Pass getTokenFn from App.jsx**

In `src/App.jsx`, update the `createCollabSession` call (around line 1289):

```javascript
    const session = createCollabSession({
      room: roomId,
      token: authToken,
      getTokenFn: getToken,  // from auth-client — returns fresh token on each call
      identity,
      // ... rest unchanged
    });
```

- [ ] **Step 4: Run full test suite**

Run: `npm test -- --run`
Expected: All tests pass. Existing collab tests don't use getTokenFn (defaults to null).

- [ ] **Step 5: Commit**

```bash
git add src/lib/collab.js src/App.jsx
git commit -m "feat(auth): add getTokenFn to collab session for reconnect token refresh"
```

---

## Task 7: Create .env.example and install MSAL dependency

**Files:**
- Create: `.env.example`
- Modify: `package.json` (install @azure/msal-browser)

- [ ] **Step 1: Install @azure/msal-browser**

```bash
npm install @azure/msal-browser
```

- [ ] **Step 2: Create .env.example**

Create `.env.example` at the project root:

```
# Azure AD authentication (optional — omit for local dev with stub identity)
# When VITE_AZURE_AD_CLIENT_ID is set, SIM shows "Sign in with Microsoft"
# When absent, SIM uses the display name prompt (stub mode)
# VITE_AZURE_AD_CLIENT_ID=
# VITE_AZURE_AD_TENANT_ID=
# VITE_AZURE_AD_REDIRECT_URI=http://localhost:5173

# Server auth — must match client Azure AD config
# SIM_AUTH_PROVIDER=jwt
# SIM_AUTH_JWT_SECRET=
# SIM_AUTH_JWT_ISSUER=https://login.microsoftonline.com/<tenant-id>/v2.0
# SIM_AUTH_JWT_AUDIENCE=<client-id>

# Storage backend
# SIM_STORAGE_BACKEND=local
# SIM_AZURE_STORAGE_CONNECTION_STRING=
# SIM_AZURE_STORAGE_ACCOUNT_URL=
# SIM_AZURE_STORAGE_CONTAINER=sim-collab-rooms
```

- [ ] **Step 3: Run full test suite**

Run: `npm test -- --run && npm run test:server`
Expected: All tests pass.

- [ ] **Step 4: Commit**

```bash
git add .env.example package.json package-lock.json
git commit -m "feat(auth): install @azure/msal-browser, add .env.example"
```

---

## Task 8: Update CLAUDE.md

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Update architecture tree**

Add `auth-client.js` to `src/lib/` section and `LoginGate.jsx` to `src/components/` section in the architecture tree.

- [ ] **Step 2: Update identity.js description**

Change from:
```
    identity.js            # Stub user identity: id/name/color in localStorage, HSL hash ~95 lines
```
To:
```
    identity.js            # User identity: JWT claim extraction + localStorage fallback, HSL hash ~110 lines
```

- [ ] **Step 3: Update Dependencies section**

Add `@azure/msal-browser` to Production dependencies:
```
**Production:** ..., @azure/msal-browser (lazy-loaded for Azure AD SSO)
```

- [ ] **Step 4: Update collab section**

Update the "Remaining gaps" line to remove "Stub identity" since it's now real identity (with stub as fallback).

- [ ] **Step 5: Update roadmap**

Mark "Real Identity" as completed in the production readiness roadmap.

- [ ] **Step 6: Run tests**

Run: `npm test -- --run`
Expected: All pass.

- [ ] **Step 7: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: update CLAUDE.md for real identity feature"
```
