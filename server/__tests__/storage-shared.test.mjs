import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  sanitize, PUBLIC_TENANT, ARTIFACT_KIND_ACL, ARTIFACT_CATALOG,
  buildCompositeDocName, splitCompositeDocName,
} = require('../storage-shared.cjs');

describe('storage-shared composite key helpers', () => {
  it('PUBLIC_TENANT is the reserved sentinel', () => {
    assert.equal(PUBLIC_TENANT, '_public');
    assert.equal(sanitize('_public'), '_public'); // sentinel survives sanitize unchanged
  });

  it('ACL kind is in the catalog BEFORE ydoc (ydoc stays tail)', () => {
    const kinds = ARTIFACT_CATALOG.map(c => c.kind);
    assert.ok(kinds.includes(ARTIFACT_KIND_ACL));
    assert.ok(kinds.indexOf(ARTIFACT_KIND_ACL) < kinds.indexOf('ydoc'));
    assert.equal(kinds[kinds.length - 1], 'ydoc');
    const acl = ARTIFACT_CATALOG.find(c => c.kind === ARTIFACT_KIND_ACL);
    assert.equal(acl.optional, true);
    assert.equal(acl.contentType, 'application/json');
  });

  it('buildCompositeDocName sanitizes each half and joins structurally', () => {
    assert.equal(buildCompositeDocName('acme', 'room1'), 'acme/room1');
    assert.equal(buildCompositeDocName('a/b', '../x'), 'a_b/___x'); // / and . collapse per-half
  });

  it('splitCompositeDocName splits on first slash; bare id defaults to _public', () => {
    assert.deepEqual(splitCompositeDocName('acme/room1'), { tenant: 'acme', roomId: 'room1' });
    assert.deepEqual(splitCompositeDocName('legacyroom'), { tenant: '_public', roomId: 'legacyroom' });
    // roomId may itself contain no slash after sanitize, so only the FIRST slash splits
    assert.deepEqual(splitCompositeDocName('t/a/b'), { tenant: 't', roomId: 'a/b' });
  });
});
