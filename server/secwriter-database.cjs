/**
 * SecWriterDatabase — Hocuspocus persistence extension (#128, spec §2).
 *
 * Wraps the existing RoomStorageBase adapters UNCHANGED. store() runs the FULL
 * room-serializer.serializeRoom (NOT a bare encodeStateAsUpdate), so the
 * .SEC/.comments/.lint sidecars keep regenerating. Write order (.ydoc last) is
 * owned by ARTIFACT_CATALOG/planArtifactWrites in the storage layer.
 *
 * Carries over from the old flushRoom: the 8 MB MAX_DOC_BYTES pre-serialize
 * refusal, roomHealth.persistFailures tracking, the deferred CJS serializer
 * require (first store pays the latency), and per-key store re-entrancy safety
 * (§2/§8 — no two overlapping stores race the same .ydoc into S3/Azure).
 *
 * CJS on purpose (ADR-0001).
 */
'use strict';

const Y = require('yjs');
const { Database } = require('@hocuspocus/extension-database');
const { splitCompositeDocName } = require('./storage-shared.cjs');

class SecWriterDatabase extends Database {
  constructor({ storage, roomHealth, maxDocBytes, log }) {
    super({
      fetch: (data) => this.fetch(data),
      store: (data) => this.store(data),
    });
    this.storage = storage;
    this.roomHealth = roomHealth;
    this.maxDocBytes = maxDocBytes;
    this.log = log;
    this._serializeRoom = null;
    this._storeChains = new Map();
    // Resurrection tombstones (ADR-0017 "Live-session revocation" follow-up).
    // Composite docNames the DELETE route has torn down. Any pending/in-flight
    // debounced store for a tombstoned name no-ops in store() instead of
    // re-persisting the just-deleted room. Cleared by fetch() on a fresh load.
    this._deleted = new Set();
  }

  _getHealth(docName) {
    let h = this.roomHealth.get(docName);
    if (!h) { h = { persistFailures: 0, lastPersistSuccess: null }; this.roomHealth.set(docName, h); }
    return h;
  }

  // Deferred CJS require — the room-serializer pulls in heavy ESM-bridged deps,
  // so the first store (not server boot) pays the load. Synchronous require, so
  // no await is needed; kept async only so the call site reads uniformly.
  async _getSerializeRoom() {
    if (!this._serializeRoom) {
      this._serializeRoom = require('./room-serializer.cjs').serializeRoom;
    }
    return this._serializeRoom;
  }

  async fetch({ documentName }) {
    // A fresh load supersedes any prior deletion of this composite key (an
    // operator recreated the room with the same id) — lift the resurrection
    // tombstone so the new doc's stores are not suppressed. Hocuspocus calls
    // fetch() during loadDocument, so this fires exactly when a new doc for the
    // name comes alive. (Delete-resurrection follow-up, ADR-0017.)
    this._deleted.delete(documentName);
    const { tenant, roomId } = splitCompositeDocName(documentName);
    const roomData = await this.storage.readRoom(tenant, roomId);
    if (!roomData || !roomData.ydocBytes) return null;
    return roomData.ydocBytes instanceof Uint8Array
      ? roomData.ydocBytes
      : new Uint8Array(roomData.ydocBytes);
  }

  // Resolves to true iff the room was durably written, false if the store was
  // refused (over cap) or failed (storage fault — _doStore counts it). Callers
  // that gate a durability promise on the write (the upload route, the migration
  // explicit-persist) MUST check the result; the debounced auto-store path may
  // ignore it. #249 review.
  async store({ documentName, document, instance }) {
    // Resurrection guard (ADR-0017 "Live-session revocation" follow-up). Under
    // unloadImmediately:false a room's live Y.Doc lingers after DELETE, and a
    // debounced onStoreDocument armed by prior edits (or a disconnect-triggered
    // store) can fire AFTER storage.deleteRoom and re-persist — silently
    // resurrecting the just-deleted room. Two independent checks skip the write:
    //   1. `_deleted` tombstone — set by the DELETE route via markDeleted()
    //      BEFORE it clears storage; covers a pending debounce timer that has
    //      not yet called store(), and callers that don't thread `instance`
    //      (flushRoom, the migration explicit-persist).
    //   2. identity guard — a store whose `document` is no longer the resident
    //      doc for this name (evicted on delete, or replaced by a same-id
    //      recreate) is stale. Hocuspocus threads `instance` on the
    //      onStoreDocument payload; the resident doc lives in instance.documents.
    // The tombstone is cleared by fetch() when the name is loaded fresh again.
    if (this._deleted.has(documentName)) return false;
    if (instance && instance.documents && instance.documents.get(documentName) !== document) return false;
    const prev = this._storeChains.get(documentName) || Promise.resolve();
    // _doStore never throws (it counts its own failures and returns false), so
    // the .catch is a backstop against an unexpected throw ABOVE its try — it
    // also keeps the per-key chain alive so the next queued store still runs.
    const next = prev.then(() => this._doStore(documentName, document)).catch(() => false);
    this._storeChains.set(documentName, next);
    const ok = await next;
    if (this._storeChains.get(documentName) === next) this._storeChains.delete(documentName);
    return ok;
  }

  async _doStore(documentName, document) {
    const health = this._getHealth(documentName);
    try {
      const snapshot = Y.encodeStateAsUpdate(document);
      if (snapshot.byteLength > this.maxDocBytes) {
        this.log.warn('flush.refused', { roomId: documentName, bytes: snapshot.byteLength, cap: this.maxDocBytes });
        return false;
      }
      const serializeRoom = await this._getSerializeRoom();
      const artifacts = await serializeRoom(document);
      const { tenant, roomId } = splitCompositeDocName(documentName);
      await this.storage.writeRoom(tenant, roomId, artifacts);
      health.persistFailures = 0;
      health.lastPersistSuccess = Date.now();
      return true;
    } catch (err) {
      health.persistFailures = (health.persistFailures || 0) + 1;
      this.log.warn('persist.failed', { roomId: documentName, failures: health.persistFailures, err: err.message });
      if (health.persistFailures >= 3) this.log.error('persist.alert', { roomId: documentName, failures: health.persistFailures });
      return false;
    }
  }

  /**
   * Tombstone a composite docName so any pending/in-flight debounced store for
   * it no-ops instead of resurrecting a just-deleted room (ADR-0017 follow-up).
   * The DELETE route (via collab-server's evictRoom) calls this BEFORE
   * storage.deleteRoom. Cleared by fetch() on the next fresh load of the same
   * name (an operator recreated the room with the same id).
   */
  markDeleted(documentName) {
    this._deleted.add(documentName);
  }

  /**
   * Resolve when the currently-executing store for `documentName` (if any)
   * settles. evictRoom awaits this so an in-flight store that already passed
   * the resurrection guard finishes its write BEFORE storage.deleteRoom runs —
   * making deleteRoom the last writer. A merely-pending (un-fired) debounced
   * store has no chain entry yet and is handled by the tombstone instead.
   */
  awaitPendingStore(documentName) {
    return Promise.resolve(this._storeChains.get(documentName)).then(() => {}, () => {});
  }

  /**
   * Await all in-flight per-key store chains. The shutdown path (Phase 5)
   * calls hocuspocus.flushPendingStores() then awaits this, since the bare
   * Hocuspocus class has no awaitable destroy(). flushPendingStores() returns
   * void, so this is how we know every store actually completed.
   */
  async drain() {
    // Loop until quiescent. flushPendingStores() does NOT call our store()
    // directly — it kicks an async chain (debouncer.executeNow →
    // saveMutex.runExclusive → hooks → database.onStoreDocument → this.store)
    // that registers each room's _storeChains entry across several event-loop
    // turns. store()'s FIRST synchronous statement is _storeChains.set, so drain
    // is correct iff every dirty room's store() is REACHED before we observe an
    // empty map.
    //
    // The setImmediate runs at the TOP of EVERY iteration, not just once. A
    // single leading yield covers the common case (a purely-debounced room
    // reaches store() via microtasks only). But a room with an in-flight store
    // at shutdown re-flushes BEHIND that store's writeRoom IO (a macrotask): its
    // chain entry is deleted when the in-flight store settles and only re-set a
    // macrotask later. Yielding a full macrotask turn before each emptiness
    // check gives that re-flush a window to re-register, closing the lost-write
    // gap. Terminates because closeConnections() ran first (no new external
    // edits) and each room re-flushes at most once → the map strictly drains.
    // The iteration cap is a backstop against a future invariant violation, not
    // the normal exit.
    for (let i = 0; i < 1000; i++) {
      await new Promise((r) => setImmediate(r));
      if (this._storeChains.size === 0) break;
      await Promise.allSettled([...this._storeChains.values()]);
    }
  }
}

module.exports = { SecWriterDatabase };
