/**
 * SecWriterDatabase — Hocuspocus persistence extension (#128, spec §2).
 *
 * Wraps the existing RoomStorageBase adapters UNCHANGED. store() runs the FULL
 * room-serializer.serializeRoom (NOT a bare encodeStateAsUpdate), so the
 * .SEC/.comments/.lint sidecars keep regenerating. Write order (.ydoc last) is
 * owned by ARTIFACT_CATALOG/planArtifactWrites in the storage layer.
 *
 * Carries over from the old flushRoom: the 8 MB MAX_DOC_BYTES pre-serialize
 * refusal, roomHealth.persistFailures tracking, the deferred ESM serializer
 * import (first store pays the latency), and per-key store re-entrancy safety
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
    for (let i = 0; i < 5 && this._storeChains.size > 0; i++) {
      await Promise.allSettled([...this._storeChains.values()]);
    }
  }
}

module.exports = { SecWriterDatabase };
