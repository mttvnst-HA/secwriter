'use strict';
/**
 * One shared per-composite-key ACL read-modify-write mutex (#267 seam 4).
 * `.acl.json` has no compare-and-set and writeAcl is a full-object overwrite,
 * so the share route (HTTP) and promotePending (WS connect) MUST serialize
 * their RMWs through ONE Map instance — two Maps in two modules is not a mutex.
 * Owned by collab-server.cjs, threaded into createHttpHandler like flushRoom.
 * Single-instance-bound (ADR-0017): a multi-instance move needs a distributed
 * lock here too. Same chain shape as SecWriterDatabase._storeChains.
 */
function createAclMutex() {
  const chains = new Map();
  function withAclLock(key, fn) {
    const prev = chains.get(key) || Promise.resolve();
    // Swallow the prior result/error (both branches call fn) so one caller's
    // rejection can't reject the next; each caller still sees its OWN fn's
    // resolution/rejection via `run`.
    const run = prev.then(() => fn(), () => fn());
    // Settle-tracking chain that never rejects, so the Map stays healthy.
    const next = run.then(() => {}, () => {});
    chains.set(key, next);
    next.then(() => { if (chains.get(key) === next) chains.delete(key); });
    return run;
  }
  return { withAclLock };
}
module.exports = { createAclMutex };
