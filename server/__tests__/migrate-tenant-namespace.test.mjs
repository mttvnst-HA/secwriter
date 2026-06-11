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
const { migrateLocalFlatToTenant } = require('../migrate-tenant-namespace.cjs');

describe('tenant-namespace migration (local)', () => {
  it('relocates flat <id>.ydoc under <tenant>/ and writes an ACL sidecar', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sim-migrate-'));
    // Seed a legacy FLAT room: <dir>/legacy1.ydoc + <dir>/legacy1.SEC
    const doc = new Y.Doc();
    fs.writeFileSync(path.join(dir, 'legacy1.ydoc'), Buffer.from(Y.encodeStateAsUpdate(doc)));
    fs.writeFileSync(path.join(dir, 'legacy1.SEC'), Buffer.from('SEC-CONTENT', 'latin1'));
    doc.destroy();

    const moved = await migrateLocalFlatToTenant({ dir, tenant: '_public', owner: 'admin' });
    assert.equal(moved, 1);

    // Old flat key gone; new composite key present + readable via the backend
    assert.equal(fs.existsSync(path.join(dir, 'legacy1.ydoc')), false);
    const backend = new LocalStorageBackend(dir);
    assert.ok(await backend.readRoom('_public', 'legacy1'));
    assert.deepEqual(await backend.readAcl('_public', 'legacy1'), { ownerId: 'admin', sharedWith: [] });

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('writes the ACL sidecar BEFORE renaming the .ydoc (crash-order invariant)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sim-migrate-order-'));
    const doc = new Y.Doc();
    fs.writeFileSync(path.join(dir, 'legacy1.ydoc'), Buffer.from(Y.encodeStateAsUpdate(doc)));
    doc.destroy();

    // Record the order of the relevant filesystem ops. The script shares this
    // cached fs module, so patching here observes its calls.
    const ops = [];
    const realWrite = fs.writeFileSync;
    const realRename = fs.renameSync;
    fs.writeFileSync = (file, ...rest) => {
      if (String(file).endsWith('.acl.json')) ops.push('acl-write');
      return realWrite(file, ...rest);
    };
    fs.renameSync = (src, dst, ...rest) => {
      if (String(dst).endsWith('.ydoc')) ops.push('ydoc-rename');
      return realRename(src, dst, ...rest);
    };
    try {
      await migrateLocalFlatToTenant({ dir, tenant: '_public', owner: 'admin' });
    } finally {
      fs.writeFileSync = realWrite;
      fs.renameSync = realRename;
    }

    // A crash between these two ops must leave a reclaimable orphan ACL, never
    // an ownerless .ydoc — so the ACL write must come first.
    assert.ok(
      ops.indexOf('acl-write') < ops.indexOf('ydoc-rename'),
      `.acl.json must be written before .ydoc is renamed (saw ${JSON.stringify(ops)})`,
    );

    fs.rmSync(dir, { recursive: true, force: true });
  });
});
