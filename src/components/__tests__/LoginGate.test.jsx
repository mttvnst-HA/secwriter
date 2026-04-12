// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, cleanup } from '@testing-library/react';

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
  afterEach(() => { cleanup(); });

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

  it('shows nothing during loading', () => {
    mockInitAuth.mockReturnValue(new Promise(() => {}));
    render(<LoginGate><div>Editor</div></LoginGate>);
    expect(screen.queryByText('Editor')).toBeNull();
    expect(screen.queryByText(/sign in/i)).toBeNull();
  });
});
