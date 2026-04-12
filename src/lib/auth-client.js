/**
 * Auth orchestrator — detects identity mode and manages tokens.
 *
 * Three modes (detection order: external > msal > stub):
 *   - 'external' — JWT in sessionStorage (placed by SSO portal)
 *   - 'msal'     — Azure AD via @azure/msal-browser (lazy-loaded)
 *   - 'stub'     — no auth, current dev behavior
 */

import { identityFromToken, loadIdentity } from './identity.js';

const TOKEN_KEY = 'sim-auth-token';

// ── Module-level state ──────────────────────────────────────────────
let _mode = null;          // 'external' | 'msal' | 'stub' | null
let _identity = null;      // { id, name, email, color } | null
let _msalInstance = null;   // MSAL PublicClientApplication | null
let _msalAccount = null;    // MSAL account info | null
let _initResult = null;     // cached initAuth() result (idempotent under StrictMode)
let _lastNotifiedToken = null; // dedup token refresh notifications
const _listeners = new Set(); // token refresh callbacks

// ── Helpers ─────────────────────────────────────────────────────────

function _reset() {
  _mode = null;
  _identity = null;
  _msalInstance = null;
  _msalAccount = null;
}

// ── Public API ──────────────────────────────────────────────────────

/**
 * Initialise auth — detect mode, extract identity.
 * Safe to call multiple times (idempotent after first).
 * @returns {{ mode: string, isAuthenticated: boolean, identity: object|null }}
 */
export async function initAuth() {
  if (_initResult) return _initResult;

  // 1. External token in sessionStorage?
  const externalToken = sessionStorage.getItem(TOKEN_KEY);
  if (externalToken) {
    _mode = 'external';
    _identity = identityFromToken(externalToken);
    _initResult = { mode: _mode, isAuthenticated: true, identity: _identity };
    return _initResult;
  }

  // 2. MSAL configured via env var?
  const clientId = import.meta.env?.VITE_AZURE_AD_CLIENT_ID;
  if (clientId) {
    try {
      const msal = await import('@azure/msal-browser');
      _msalInstance = new msal.PublicClientApplication({
        auth: {
          clientId,
          authority: `https://login.microsoftonline.com/${import.meta.env.VITE_AZURE_AD_TENANT_ID || 'common'}`,
          redirectUri: window.location.origin,
        },
        cache: { cacheLocation: 'sessionStorage' },
      });
      await _msalInstance.initialize();

      // Check for redirect response first (returning from login)
      const resp = await _msalInstance.handleRedirectPromise();
      if (resp?.account) {
        _msalAccount = resp.account;
      } else {
        const accounts = _msalInstance.getAllAccounts();
        if (accounts.length > 0) _msalAccount = accounts[0];
      }

      if (_msalAccount) {
        _mode = 'msal';
        // Build identity from account claims
        const token = await _acquireMsalTokenSilent();
        if (token) {
          _identity = identityFromToken(token);
        } else {
          // Fallback: use account info directly
          _identity = {
            id: _msalAccount.localAccountId || _msalAccount.homeAccountId,
            name: _msalAccount.name || _msalAccount.username,
            email: _msalAccount.username || null,
            color: `hsl(${Math.abs(_msalAccount.username?.length * 31 || 0) % 360}, 70%, 45%)`,
          };
        }
        _initResult = { mode: _mode, isAuthenticated: true, identity: _identity };
        return _initResult;
      }

      // MSAL configured but no account — user not signed in yet
      _mode = 'msal';
      _initResult = { mode: _mode, isAuthenticated: false, identity: null };
      return _initResult;
    } catch {
      // MSAL import or init failed — fall through to stub
    }
  }

  // 3. Stub mode — no auth
  _mode = 'stub';
  _identity = loadIdentity() || null;
  _initResult = { mode: _mode, isAuthenticated: false, identity: _identity };
  return _initResult;
}

/**
 * Get current access token.
 * External: reads sessionStorage.  MSAL: acquires silently.  Stub: null.
 */
export async function getToken() {
  if (_mode === 'external') return sessionStorage.getItem(TOKEN_KEY);
  if (_mode === 'msal') return _acquireMsalTokenSilent();
  return null;
}

/** Current identity or null (synchronous). */
export function getIdentity() {
  return _identity;
}

/** Current auth mode or null if not initialised. */
export function getAuthMode() {
  return _mode;
}

/**
 * Subscribe to token refresh events. Returns unsubscribe function.
 * Useful for updating WebSocket auth headers on silent refresh.
 */
export function onTokenRefresh(cb) {
  _listeners.add(cb);
  return () => _listeners.delete(cb);
}

/** Trigger sign-in. Only meaningful in MSAL mode (redirect flow). */
export async function signIn() {
  if (_mode === 'msal' && _msalInstance) {
    await _msalInstance.loginRedirect({
      scopes: ['openid', 'profile', 'email'],
    });
  }
  // No-op in external and stub modes
}

/** Clear auth state, sign out. */
export async function signOut() {
  if (_mode === 'stub') return;
  if (_mode === 'msal' && _msalInstance) {
    try {
      await _msalInstance.logoutRedirect();
    } catch {
      /* redirect will navigate away */
    }
  }

  sessionStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem('sim-identity');
  _reset();
  _initResult = null;
  _lastNotifiedToken = null;
}

// ── Test helper ─────────────────────────────────────────────────────

/** Fire all token refresh listeners. Exported for tests only. */
export function _notifyTokenRefresh(token) {
  for (const cb of _listeners) cb(token);
}

// ── Internal ────────────────────────────────────────────────────────

async function _acquireMsalTokenSilent() {
  if (!_msalInstance || !_msalAccount) return null;
  try {
    const result = await _msalInstance.acquireTokenSilent({
      scopes: ['openid', 'profile', 'email'],
      account: _msalAccount,
    });
    if (result?.accessToken) {
      // I3: Only notify when the token actually changed
      if (result.accessToken !== _lastNotifiedToken) {
        _lastNotifiedToken = result.accessToken;
        _notifyTokenRefresh(result.accessToken);
      }
      return result.accessToken;
    }
    return null;
  } catch {
    // I5: Silent refresh failed — session expired
    _identity = null;
    _notifyTokenRefresh(null);
    return null;
  }
}
