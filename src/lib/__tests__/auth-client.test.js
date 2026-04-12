import { describe, it, expect, vi, beforeEach } from 'vitest';

function fakeJwt(payload) {
  const header = btoa(JSON.stringify({ alg: 'none' }));
  const body = btoa(JSON.stringify(payload));
  return `${header}.${body}.fake-sig`;
}

const MOCK_JWT = fakeJwt({ oid: 'user-1', name: 'Test User', email: 'test@example.com' });

// Mock storage that supports clear()
function createMockStorage() {
  const store = {};
  return {
    getItem: (key) => store[key] ?? null,
    setItem: (key, val) => { store[key] = String(val); },
    removeItem: (key) => { delete store[key]; },
    clear: () => { Object.keys(store).forEach((k) => delete store[k]); },
    _store: store,
  };
}

const mockLocal = createMockStorage();
const mockSession = createMockStorage();

Object.defineProperty(globalThis, 'localStorage', { value: mockLocal, writable: true });
Object.defineProperty(globalThis, 'sessionStorage', { value: mockSession, writable: true });

describe('auth-client', () => {
  beforeEach(() => {
    mockLocal.clear();
    mockSession.clear();
    vi.resetModules();
  });

  it('detects external token mode when sessionStorage has token', async () => {
    mockSession.setItem('sim-auth-token', MOCK_JWT);
    const { initAuth } = await import('../auth-client.js');
    const result = await initAuth();
    expect(result.mode).toBe('external');
    expect(result.isAuthenticated).toBe(true);
    expect(result.identity.id).toBe('user-1');
  });

  it('detects stub mode when no token and no MSAL config', async () => {
    const { initAuth } = await import('../auth-client.js');
    const result = await initAuth();
    expect(result.mode).toBe('stub');
    expect(result.isAuthenticated).toBe(false);
  });

  it('getToken returns sessionStorage token in external mode', async () => {
    mockSession.setItem('sim-auth-token', MOCK_JWT);
    const { initAuth, getToken } = await import('../auth-client.js');
    await initAuth();
    const token = await getToken();
    expect(token).toBe(MOCK_JWT);
  });

  it('getToken returns null in stub mode', async () => {
    const { initAuth, getToken } = await import('../auth-client.js');
    await initAuth();
    expect(await getToken()).toBeNull();
  });

  it('getIdentity returns identity after external init', async () => {
    mockSession.setItem('sim-auth-token', MOCK_JWT);
    const { initAuth, getIdentity } = await import('../auth-client.js');
    await initAuth();
    expect(getIdentity().name).toBe('Test User');
  });

  it('getIdentity returns null before init', async () => {
    const { getIdentity } = await import('../auth-client.js');
    expect(getIdentity()).toBeNull();
  });

  it('onTokenRefresh fires callback and unsubscribe works', async () => {
    mockSession.setItem('sim-auth-token', MOCK_JWT);
    const { initAuth, onTokenRefresh, _notifyTokenRefresh } = await import('../auth-client.js');
    await initAuth();
    const cb = vi.fn();
    const unsub = onTokenRefresh(cb);
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
    mockSession.setItem('sim-auth-token', MOCK_JWT);
    const { initAuth, signOut, getIdentity } = await import('../auth-client.js');
    await initAuth();
    expect(getIdentity()).not.toBeNull();
    await signOut();
    expect(getIdentity()).toBeNull();
    expect(mockSession.getItem('sim-auth-token')).toBeNull();
  });
});
