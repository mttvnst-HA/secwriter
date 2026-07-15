import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createAclMutex } = require('../acl-mutex.cjs');

describe('createAclMutex (#267 seam 4)', () => {
  it('serializes two RMWs on the same key (no lost update)', async () => {
    const { withAclLock } = createAclMutex();
    let shared = { n: 0 };
    const order = [];
    const rmw = (tag, delayMs) => withAclLock('acme/r1', async () => {
      const snap = shared.n;               // read
      await new Promise(r => setTimeout(r, delayMs)); // yield mid-RMW
      shared = { n: snap + 1 };            // write-back
      order.push(tag);
    });
    await Promise.all([rmw('A', 20), rmw('B', 1)]);
    // Without serialization both read n=0 and shared.n ends at 1. Serialized → 2.
    assert.equal(shared.n, 2);
    assert.deepEqual(order, ['A', 'B']); // FIFO
  });
  it('a rejecting fn does not poison the next caller', async () => {
    const { withAclLock } = createAclMutex();
    await assert.rejects(withAclLock('k', async () => { throw new Error('boom'); }));
    const ok = await withAclLock('k', async () => 'ok');
    assert.equal(ok, 'ok');
  });
  it('different keys run independently', async () => {
    const { withAclLock } = createAclMutex();
    const a = withAclLock('k1', async () => 1);
    const b = withAclLock('k2', async () => 2);
    assert.deepEqual(await Promise.all([a, b]), [1, 2]);
  });
});
