#!/usr/bin/env node
/**
 * One-time migration: relocate pre-tenant FLAT room artifacts under a tenant
 * namespace + write an ACL sidecar. See ADR-0015 and the design spec.
 *
 * Run once when turning auth ON for a deploy that has pre-existing rooms, OR
 * for an auth=none demo whose rooms predate the composite-key scheme (use
 * SIM_DEFAULT_TENANT=_public). Idempotent: a room already under a tenant
 * prefix is skipped.
 *
 *   SIM_DEFAULT_TENANT=<tenant> SIM_DEFAULT_OWNER=<sub> \
 *     node server/migrate-tenant-namespace.cjs
 *
 * CJS on purpose (see ADR-0001).
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { sanitize } = require('./storage-shared.cjs');

// Flat-layout extensions (pre-tenant local naming). '.acl.json' is NOT a
// legacy artifact — skip it if somehow present.
const FLAT_EXTS = ['.ydoc', '.SEC', '.comments.json', '.lint.json'];

/**
 * Move every flat `<dir>/<id><ext>` to `<dir>/<tenant>/<id><ext>` and write
 * `<dir>/<tenant>/<id>.acl.json`. Returns the count of distinct rooms moved.
 */
async function migrateLocalFlatToTenant({ dir, tenant, owner }) {
  const t = sanitize(tenant);
  if (!fs.existsSync(dir)) return 0;
  const tenantDir = path.join(dir, t);

  // Distinct room ids that have a flat .ydoc at the top level.
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const roomIds = new Set();
  for (const e of entries) {
    if (!e.isFile()) continue;            // tenant subdirs + 'archive' are dirs — skip
    if (e.name.endsWith('.ydoc') && !e.name.includes('.ydoc.')) {
      roomIds.add(e.name.slice(0, -'.ydoc'.length));
    }
  }
  if (roomIds.size === 0) return 0;

  fs.mkdirSync(tenantDir, { recursive: true });
  let moved = 0;
  for (const id of roomIds) {
    const safe = sanitize(id);
    for (const ext of FLAT_EXTS) {
      const src = path.join(dir, `${id}${ext}`);
      if (!fs.existsSync(src)) continue;
      fs.renameSync(src, path.join(tenantDir, `${safe}${ext}`));
    }
    // ACL sidecar (acl-before-ydoc invariant is irrelevant here — the .ydoc
    // already exists from the rename above).
    fs.writeFileSync(
      path.join(tenantDir, `${safe}.acl.json`),
      JSON.stringify({ ownerId: owner, sharedWith: [] }),
      'utf-8',
    );
    moved++;
  }
  return moved;
}

async function runFromEnv() {
  const tenant = process.env.SIM_DEFAULT_TENANT;
  const owner = process.env.SIM_DEFAULT_OWNER;
  if (!tenant || !owner) {
    throw new Error('migrate-tenant-namespace requires SIM_DEFAULT_TENANT and SIM_DEFAULT_OWNER');
  }
  const backend = (process.env.SIM_STORAGE_BACKEND || 'local').toLowerCase();
  if (backend !== 'local') {
    // S3/Azure relocation follows the same shape (list flat keys, copy under
    // <tenant>/ prefix, put .acl.json, delete originals) but is left as an
    // operator-run follow-up; local is the documented default + demo backend.
    throw new Error(`migrate-tenant-namespace: backend '${backend}' not yet supported by this script — see ADR-0015`);
  }
  const dir = path.resolve(process.cwd(), process.env.SIM_LOCAL_STORAGE_DIR || 'server/collab-db');
  const moved = await migrateLocalFlatToTenant({ dir, tenant, owner });
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ migrated: moved, tenant: sanitize(tenant), dir }));
}

module.exports = { migrateLocalFlatToTenant, runFromEnv };

if (require.main === module) {
  runFromEnv().catch(err => { console.error(err.message); process.exit(1); });
}
