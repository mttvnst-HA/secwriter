/**
 * Auth provider factory — reads environment variables and returns the
 * appropriate auth provider.
 *
 * SIM_AUTH_PROVIDER=none (default) → auth-none (all connections allowed)
 * SIM_AUTH_PROVIDER=jwt → auth-jwt (validates Bearer tokens)
 */
const fs = require('node:fs');

function createAuthProvider() {
  const provider = (process.env.SIM_AUTH_PROVIDER || 'none').toLowerCase();

  if (provider === 'jwt') {
    const { createAuthJwt } = require('./auth-jwt.cjs');
    const secret = process.env.SIM_AUTH_JWT_SECRET || null;
    let publicKey = null;
    const keyPath = process.env.SIM_AUTH_JWT_PUBLIC_KEY || null;
    if (keyPath) {
      try { publicKey = fs.readFileSync(keyPath, 'utf-8'); }
      catch (err) { throw new Error(`Failed to read JWT public key from ${keyPath}: ${err.message}`); }
    }
    if (!secret && !publicKey) throw new Error('auth-jwt requires SIM_AUTH_JWT_SECRET or SIM_AUTH_JWT_PUBLIC_KEY');
    return createAuthJwt({
      secret, publicKey,
      issuer: process.env.SIM_AUTH_JWT_ISSUER || undefined,
      audience: process.env.SIM_AUTH_JWT_AUDIENCE || undefined,
    });
  }

  const { createAuthNone } = require('./auth-none.cjs');
  return createAuthNone();
}

module.exports = { createAuthProvider };
