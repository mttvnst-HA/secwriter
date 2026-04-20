/**
 * JWT auth provider — validates HS256 (shared secret) or RS256 (public key) tokens.
 * Supports standard claims: sub, name, email, oid (Azure AD), preferred_username.
 */
const jwt = require('jsonwebtoken');

function createAuthJwt({ secret, publicKey, issuer, audience } = {}) {
  const key = publicKey || secret;
  if (!key) throw new Error('auth-jwt requires either secret or publicKey');

  const algorithms = publicKey ? ['RS256'] : ['HS256'];
  const verifyOpts = { algorithms };
  if (issuer) verifyOpts.issuer = issuer;
  if (audience) verifyOpts.audience = audience;

  return {
    requiresAuth: true,
    async validateToken(token) {
      if (!token) return null;
      try {
        const payload = jwt.verify(token, key, verifyOpts);
        return {
          id: payload.sub || payload.oid || payload.email || 'unknown',
          name: payload.name || payload.preferred_username || payload.email || 'Unknown',
          email: payload.email || null,
          color: payload.color || null,
        };
      } catch {
        return null;
      }
    },
    getLoginUrl(returnUrl) {
      return null;
    },
    extractToken(req) {
      const auth = req.headers?.authorization;
      if (!auth || !auth.startsWith('Bearer ')) return null;
      return auth.slice(7);
    },
  };
}

module.exports = { createAuthJwt };
