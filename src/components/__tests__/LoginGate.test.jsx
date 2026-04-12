// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, cleanup } from '@testing-library/react';

const mockInitAuth = vi.fn();
const mockInitAuthSync = vi.fn();
const mockOnTokenRefresh = vi.fn(() => () => {});
const mockSignIn = vi.fn();

vi.mock('../../lib/auth-client.js', () => ({
  initAuth: (...args) => mockInitAuth(...args),
  initAuthSync: (...args) => mockInitAuthSync(...args),
  onTokenRefresh: (...args) => mockOnTokenRefresh(...args),
  signIn: (...args) => mockSignIn(...args),
  getAuthMode: () => 'stub',
}));

import LoginGate from '../LoginGate.jsx';

describe('LoginGate', () => {
  beforeEach(() => { vi.clearAllMocks(); });
  afterEach(() => { cleanup(); });

  it('renders children immediately in stub mode (synchronous fast path)', () => {
    mockInitAuthSync.mockReturnValue({ mode: 'stub', isAuthenticated: false, identity: null });
    render(<LoginGate><div>Editor</div></LoginGate>);
    // Renders on first paint — no async wait needed
    expect(screen.getByText('Editor')).toBeTruthy();
  });

  it('renders children when authenticated in external mode (synchronous fast path)', () => {
    mockInitAuthSync.mockReturnValue({ mode: 'external', isAuthenticated: true, identity: { id: 'u1', name: 'Test' } });
    render(<LoginGate><div>Editor</div></LoginGate>);
    expect(screen.getByText('Editor')).toBeTruthy();
  });

  it('shows login card when MSAL mode and not authenticated', async () => {
    mockInitAuthSync.mockReturnValue(null); // MSAL requires async
    mockInitAuth.mockResolvedValue({ mode: 'msal', isAuthenticated: false, identity: null });
    await act(async () => {
      render(<LoginGate><div>Editor</div></LoginGate>);
    });
    expect(screen.getByText(/sign in with microsoft/i)).toBeTruthy();
    expect(screen.queryByText('Editor')).toBeNull();
  });

  it('shows nothing during loading (MSAL async path)', () => {
    mockInitAuthSync.mockReturnValue(null); // MSAL requires async
    mockInitAuth.mockReturnValue(new Promise(() => {}));
    render(<LoginGate><div>Editor</div></LoginGate>);
    expect(screen.queryByText('Editor')).toBeNull();
    expect(screen.queryByText(/sign in/i)).toBeNull();
  });
});
