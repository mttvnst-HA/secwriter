import { useState, useEffect } from 'react';
import { initAuth, onTokenRefresh, signIn } from '../lib/auth-client.js';

export default function LoginGate({ children }) {
  const [authState, setAuthState] = useState({
    mode: null, isAuthenticated: false, identity: null, loading: true,
  });

  useEffect(() => {
    let cancelled = false;
    initAuth().then((result) => {
      if (!cancelled) setAuthState({ ...result, loading: false });
    });
    const unsub = onTokenRefresh((token) => {
      if (token === null) {
        setAuthState((prev) => ({ ...prev, isAuthenticated: false }));
      }
    });
    return () => { cancelled = true; unsub(); };
  }, []);

  if (authState.loading) return null;

  // Stub or authenticated: render app
  if (authState.mode === 'stub' || authState.mode === 'external' || authState.isAuthenticated) {
    // MSAL expired mid-session: banner + children read-only
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
            <button onClick={() => signIn()} style={{
              padding: '4px 12px', backgroundColor: '#2563eb', color: '#fff',
              border: 'none', borderRadius: 4, fontSize: 13, cursor: 'pointer',
            }}>Sign in</button>
          </div>
          <div style={{ marginTop: 40 }}>{children}</div>
        </>
      );
    }
    return <>{children}</>;
  }

  // MSAL not authenticated: login card
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
        <h1 style={{ fontSize: 22, color: '#1e293b', marginBottom: 8 }}>SpecsIntact Modern</h1>
        <p style={{ fontSize: 14, color: '#64748b', marginBottom: 24 }}>Sign in to access the collaborative editor.</p>
        <button onClick={() => signIn()} style={{
          padding: '10px 24px', fontSize: 14, fontWeight: 600,
          backgroundColor: '#2563eb', color: '#fff', border: 'none',
          borderRadius: 6, cursor: 'pointer',
        }}>Sign in with Microsoft</button>
      </div>
    </div>
  );
}
