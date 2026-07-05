import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
require('../dom-polyfill.cjs');
const Y = require('yjs');
const { LocalStorageBackend } = require('../storage-local.cjs');
const { runFromEnv } = require('../migrate-tenant-namespace.cjs');

// The relocation mechanics (idempotency, ACL-before-ydoc crash order,
// composite-key readability) are pinned per-backend in
// storage-contract.test.mjs ('migrateLegacyFlatRooms relocates…'). This file
// covers the SCRIPT layer: env wiring through storage-factory and the
// '_public' owner-skip rule.

const ENV_KEYS = ['SIM_DEFAULT_TENANT', 'SIM_DEFAULT_OWNER', 'SIM_STORAGE_BACKEND', 'SIM_LOCAL_STORAGE_DIR'];

async function withEnv(vars, fn) {
  const saved = {};
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  Object.assign(process.env, vars);
  try { return await fn(); }
  finally {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

function seedFlatRoom(dir, id) {
  const doc = new Y.Doc();
  fs.writeFileSync(path.join(dir, `${id}.ydoc`), Buffer.from(Y.encodeStateAsUpdate(doc)));
  fs.writeFileSync(path.join(dir, `${id}.SEC`), Buffer.from('SEC-CONTENT', 'latin1'));
  doc.destroy();
}

describe('tenant-namespace migration script (env wiring)', () => {
  it('runFromEnv relocates flat rooms via the env-configured backend and writes the owner ACL', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sim-migrate-'));
    seedFlatRoom(dir, 'legacy1');

    await withEnv({ SIM_DEFAULT_TENANT: 'acme', SIM_DEFAULT_OWNER: 'admin', SIM_LOCAL_STORAGE_DIR: dir }, runFromEnv);

    // Old flat key gone; new composite key present + readable via the backend
    assert.equal(fs.existsSync(path.join(dir, 'legacy1.ydoc')), false);
    const backend = new LocalStorageBackend(dir);
    assert.ok(await backend.readRoom('acme', 'legacy1'));
    assert.deepEqual(await backend.readAcl('acme', 'legacy1'), { ownerId: 'admin', roles: {} }); // #239 graded shape

    // Missing env vars → refuse (no guessing tenants/owners)
    await assert.rejects(
      withEnv({ SIM_LOCAL_STORAGE_DIR: dir }, runFromEnv),
      /SIM_DEFAULT_TENANT and SIM_DEFAULT_OWNER/,
    );

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("relocates under '_public' WITHOUT an ACL (sentinel tenant — authorize never reads one)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sim-migrate-public-'));
    seedFlatRoom(dir, 'legacy2');

    await withEnv({ SIM_DEFAULT_TENANT: '_public', SIM_DEFAULT_OWNER: 'admin', SIM_LOCAL_STORAGE_DIR: dir }, runFromEnv);

    const backend = new LocalStorageBackend(dir);
    assert.ok(await backend.readRoom('_public', 'legacy2'));
    // Matches POST /rooms under auth=none: no ACL is written for _public
    // rooms ('_public' is rejected as a real tenant under auth, so an owner
    // claim here would be meaningless and unverifiable).
    assert.equal(await backend.readAcl('_public', 'legacy2'), null);

    fs.rmSync(dir, { recursive: true, force: true });
  });
});
