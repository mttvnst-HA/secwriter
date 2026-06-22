/**
 * Hocuspocus onAuthenticate builder — the validate-AND-reject-non-canonical
 * tenant keying chokepoint (#128, spec §3). Because documentName is
 * client-supplied AND Hocuspocus keys its in-memory documents Map on the raw
 * client name, isolation cannot rewrite the name: it must REJECT any raw name
 * not already in canonical `<tenant>/<roomId>` form, so the Map key, the
 * SecWriterDatabase fetch/store key, the ACL-read key, and the broker key are
 * provably the same string.
 *
 * Throws AuthReject (carrying an HTTP-ish status for logging) to reject; the
 * client always sees the SAME opaque close (no tenant-mismatch vs
 * can't-see-room distinction) — preserving the 404-not-403 no-existence-leak
 * posture. Bad-principal stays 403; no-token stays 401.
 *
 * CJS on purpose (ADR-0001).
 */
'use strict';

const { sanitize, PUBLIC_TENANT } = require('./storage-shared.cjs');
const { checkPrincipal, aclAllowsRead } = require('./auth/authorize.cjs');

class AuthReject extends Error {
  constructor(status, reason) {
    super(`auth-reject:${status}`);
    this.name = 'AuthReject';
    this.status = status;
    this.reason = reason; // internal only — never surfaced to the client
  }
}

function buildOnAuthenticate({ authProvider, storage }) {
  const authRequired = !!(authProvider && authProvider.requiresAuth);

  function parseCanonical(documentName, tenant) {
    const raw = String(documentName);
    const i = raw.indexOf('/');
    if (i <= 0 || i === raw.length - 1) throw new AuthReject(404, 'malformed-name');
    const rawTenant = raw.slice(0, i);
    const rawRoom = raw.slice(i + 1);
    if (!rawTenant || !rawRoom) throw new AuthReject(404, 'malformed-name');
    if (rawTenant !== tenant) throw new AuthReject(404, 'cross-tenant');
    if (rawRoom !== sanitize(rawRoom)) throw new AuthReject(404, 'non-canonical-room');
    return rawRoom;
  }

  return async function onAuthenticate({ documentName, token }) {
    if (!authRequired) {
      const roomId = parseCanonical(documentName, PUBLIC_TENANT);
      return { user: { id: PUBLIC_TENANT, tenant: PUBLIC_TENANT }, tenant: PUBLIC_TENANT, roomId, acl: null };
    }

    if (!token) throw new AuthReject(401, 'no-token');
    const user = await authProvider.validateToken(token);
    if (!user) throw new AuthReject(401, 'bad-token');

    const pre = checkPrincipal(authProvider, user);
    if (!pre.ok) throw new AuthReject(pre.status, 'principal');

    const tenant = sanitize(user.tenant);
    const roomId = parseCanonical(documentName, tenant);

    const acl = await storage.readAcl(tenant, roomId);
    if (!acl) throw new AuthReject(404, 'no-acl');
    if (!aclAllowsRead(acl, user.id)) throw new AuthReject(404, 'not-shared');

    return { user, tenant, roomId, acl };
  };
}

module.exports = { buildOnAuthenticate, AuthReject };
