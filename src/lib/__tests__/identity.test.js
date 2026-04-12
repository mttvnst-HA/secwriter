// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { identityFromToken, loadIdentity } from '../identity.js';

// Helper: create a minimal JWT with the given payload (no signature verification -- client-side decode only)
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
