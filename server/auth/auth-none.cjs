/**
 * Stub auth provider — allows all connections without validation.
 * When SIM_AUTH_PROVIDER is unset or 'none', this provider is used.
 */
function createAuthNone() {
  return {
    requiresAuth: false,
    async validateToken(token) {
      return { id: 'anonymous', name: 'Anonymous', email: null };
    },
    getLoginUrl(returnUrl) {
      return null;
    },
    extractToken(req) {
      return null;
    },
  };
}

module.exports = { createAuthNone };
