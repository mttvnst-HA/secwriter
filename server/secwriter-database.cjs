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
    const { tenant, roomId } = splitCompositeDocName(documentName);
    const roomData = await this.storage.readRoom(tenant, roomId);
    if (!roomData || !roomData.ydocBytes) return null;
    return roomData.ydocBytes instanceof Uint8Array
      ? roomData.ydocBytes
      : new Uint8Array(roomData.ydocBytes);
  }

  async store({ documentName, document }) {
    const prev = this._storeChains.get(documentName) || Promise.resolve();
    // The .catch keeps the per-key chain alive — _doStore swallows + counts its
    // own failures, so a rejection here would only mean a defect above the try;
    // either way the next queued store must still run.
    const next = prev.then(() => this._doStore(documentName, document)).catch(() => {});
    this._storeChains.set(documentName, next);
    await next;
    if (this._storeChains.get(documentName) === next) this._storeChains.delete(documentName);
  }

  async _doStore(documentName, document) {
    const health = this._getHealth(documentName);
    try {
      const snapshot = Y.encodeStateAsUpdate(document);
      if (snapshot.byteLength > this.maxDocBytes) {
        this.log.warn('flush.refused', { roomId: documentName, bytes: snapshot.byteLength, cap: this.maxDocBytes });
        return;
      }
      const serializeRoom = await this._getSerializeRoom();
      const artifacts = await serializeRoom(document);
      const { tenant, roomId } = splitCompositeDocName(documentName);
      await this.storage.writeRoom(tenant, roomId, artifacts);
      health.persistFailures = 0;
      health.lastPersistSuccess = Date.now();
    } catch (err) {
      health.persistFailures = (health.persistFailures || 0) + 1;
      this.log.warn('persist.failed', { roomId: documentName, failures: health.persistFailures, err: err.message });
      if (health.persistFailures >= 3) this.log.error('persist.alert', { roomId: documentName, failures: health.persistFailures });
    }
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
