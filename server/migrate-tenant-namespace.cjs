#!/usr/bin/env node
/**
 * One-time migration: relocate pre-tenant FLAT room artifacts under a tenant
 * namespace + write an ACL sidecar. See ADR-0017 and the design spec.
 *
 * Run once when turning auth ON for a deploy that has pre-existing rooms.
 * (An auth=none deploy doesn't need this script — the server boot path
 * relocates flat rooms into '_public' automatically; see startFromEnv.)
 * Idempotent: a room already under a tenant prefix is skipped.
 *
 * Supports every configured backend — the storage adapter is built from env
 * exactly like the server's own (storage-factory.cjs), and the relocation
 * itself is RoomStorageBase.migrateLegacyFlatRooms, which honors the
 * acl-before-ydoc crash-order invariant (ADR-0005 / ADR-0017): the ACL
 * sidecar is written first and the flat `.ydoc` is moved LAST, so a crash
 * mid-room leaves the flat `.ydoc` in place (re-migratable on re-run) and at
 * worst an orphan ACL (reclaimable) — never an ownerless relocated `.ydoc`.
 *
 *   SIM_DEFAULT_TENANT=<tenant> SIM_DEFAULT_OWNER=<sub> \
 *     [SIM_STORAGE_BACKEND=local|s3|azure + backend env vars] \
 *     node server/migrate-tenant-namespace.cjs
 *
 * CJS on purpose (see ADR-0001).
 */
'use strict';

const { sanitize, PUBLIC_TENANT } = require('./storage-shared.cjs');
const { createStorageFromEnv } = require('./storage-factory.cjs');

async function runFromEnv() {
  const tenant = process.env.SIM_DEFAULT_TENANT;
  const owner = process.env.SIM_DEFAULT_OWNER;
  if (!tenant || !owner) {
    throw new Error('migrate-tenant-namespace requires SIM_DEFAULT_TENANT and SIM_DEFAULT_OWNER');
  }
  const { storage, backend, dataDir } = createStorageFromEnv(process.env);
  // Under '_public' no ACL is meaningful (authorize early-allows when auth is
  // off, and the sentinel tenant is rejected under auth) — skip the owner.
  const effectiveOwner = sanitize(tenant) === PUBLIC_TENANT ? null : owner;
  const moved = await storage.migrateLegacyFlatRooms({ tenant, owner: effectiveOwner });
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ migrated: moved, tenant: sanitize(tenant), backend, dir: dataDir }));
}

module.exports = { runFromEnv };

if (require.main === module) {
  runFromEnv().catch(err => { console.error(err.message); process.exit(1); });
}
