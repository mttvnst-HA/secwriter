/**
 * AzureStorageBackend — Azure Blob Storage persistence for SIM rooms.
 *
 * Drop-in replacement for LocalStorageBackend. Same interface, same semantics.
 *
 * Blob layout per room:
 *   <roomId>/room.ydoc            — binary Yjs state snapshot (Buffer)
 *   <roomId>/room.sec             — Windows-1252 encoded SEC XML (Buffer)
 *   <roomId>/room.comments.json   — JSON string
 *
 * The containerClient is injected via constructor for testability: tests pass
 * an in-memory mock, production passes the real Azure SDK client.
 *
 * CJS on purpose (see collab-server.cjs header comment).
 */

/** Sanitize a room name: keep only [a-zA-Z0-9_-], max 64 chars. */
function sanitize(name) {
  const safe = String(name).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
  return safe || 'default';
}

class AzureStorageBackend {
  /**
   * @param {{ containerClient: import('@azure/storage-blob').ContainerClient }} opts
   */
  constructor({ containerClient }) {
    this._container = containerClient;
    // Ensure container exists (no-op if already created)
    this._initPromise = containerClient.createIfNotExists();
  }

  /** Build blob names for a room. */
  _blobNames(roomId) {
    const id = sanitize(roomId);
    return {
      ydoc: `${id}/room.ydoc`,
      sec: `${id}/room.sec`,
      comments: `${id}/room.comments.json`,
    };
  }

  /**
   * Write all provided artifacts.
   *
   * .sec and .comments.json are written first; .ydoc is written LAST
   * (source of truth) so a partial failure leaves .ydoc stale rather than
   * ahead of the sidecar files.
   *
   * Each blob includes a `generation` metadata timestamp for consistency
   * checking.
   *
   * @param {string} roomId
   * @param {{ ydocBytes: Buffer, secBytes: Buffer|null, commentsJson: string|null }} artifacts
   */
  async writeRoom(roomId, { ydocBytes, secBytes, commentsJson }) {
    await this._initPromise;
    const names = this._blobNames(roomId);
    const metadata = { generation: String(Date.now()) };

    // Write sidecar files first
    if (secBytes != null) {
      const blob = this._container.getBlockBlobClient(names.sec);
      await blob.upload(secBytes, secBytes.length, { metadata });
    }

    if (commentsJson != null) {
      const buf = Buffer.from(commentsJson, 'utf-8');
      const blob = this._container.getBlockBlobClient(names.comments);
      await blob.upload(buf, buf.length, { metadata });
    }

    // .ydoc written LAST (source of truth)
    const blob = this._container.getBlockBlobClient(names.ydoc);
    await blob.upload(ydocBytes, ydocBytes.length, { metadata });
  }

  /**
   * Read a room's artifacts. Returns null if .ydoc doesn't exist.
   * Missing .sec or .comments.json are returned as null (legacy rooms).
   *
   * @param {string} roomId
   * @returns {{ ydocBytes: Buffer, secBytes: Buffer|null, commentsJson: string|null } | null}
   */
  async readRoom(roomId) {
    await this._initPromise;
    const names = this._blobNames(roomId);

    // Check .ydoc existence first
    let ydocBytes;
    try {
      const blob = this._container.getBlockBlobClient(names.ydoc);
      ydocBytes = await blob.downloadToBuffer();
    } catch (err) {
      if (err.statusCode === 404) return null;
      throw err;
    }

    let secBytes = null;
    try {
      const blob = this._container.getBlockBlobClient(names.sec);
      secBytes = await blob.downloadToBuffer();
    } catch (err) {
      if (err.statusCode !== 404) throw err;
    }

    let commentsJson = null;
    try {
      const blob = this._container.getBlockBlobClient(names.comments);
      const buf = await blob.downloadToBuffer();
      commentsJson = buf.toString('utf-8');
    } catch (err) {
      if (err.statusCode !== 404) throw err;
    }

    return { ydocBytes, secBytes, commentsJson };
  }

  /**
   * Delete all artifacts for a room.
   * @param {string} roomId
   */
  async deleteRoom(roomId) {
    await this._initPromise;
    const names = this._blobNames(roomId);
    for (const blobName of [names.ydoc, names.sec, names.comments]) {
      const blob = this._container.getBlockBlobClient(blobName);
      await blob.deleteIfExists();
    }
  }

  /**
   * List room IDs by scanning for room.ydoc blobs.
   * @returns {string[]}
   */
  async listRooms() {
    await this._initPromise;
    const rooms = new Set();
    const iter = this._container.listBlobsFlat({});
    for await (const item of iter) {
      // Pattern: <roomId>/room.ydoc
      if (item.name.endsWith('/room.ydoc')) {
        const roomId = item.name.slice(0, -'/room.ydoc'.length);
        if (roomId) rooms.add(roomId);
      }
    }
    return [...rooms];
  }

  /**
   * Quarantine a room's artifacts by copying them to new blob names with a
   * reason + timestamp suffix, then deleting the originals.
   *
   * @param {string} roomId
   * @param {'oversize'|'corrupt'} reason
   */
  async quarantineRoom(roomId, reason) {
    await this._initPromise;
    const names = this._blobNames(roomId);
    const suffix = `.${reason}.${Date.now()}`;

    for (const blobName of [names.ydoc, names.sec, names.comments]) {
      const srcBlob = this._container.getBlockBlobClient(blobName);
      const exists = await srcBlob.exists();
      if (!exists) continue;

      // Copy content to quarantine blob, then delete original
      const quarantineName = `${blobName}${suffix}`;
      const dstBlob = this._container.getBlockBlobClient(quarantineName);
      try {
        const content = await srcBlob.downloadToBuffer();
        await dstBlob.upload(content, content.length, {
          metadata: { quarantineReason: reason, quarantineTime: String(Date.now()) },
        });
        await srcBlob.deleteIfExists();
      } catch {
        /* best effort — if copy fails, leave original in place */
      }
    }
  }

  /**
   * Archive a room: copy all artifacts to archive/<roomId>/room.* with
   * archivedAt metadata, then delete the originals.
   * @param {string} roomId
   */
  async archiveRoom(roomId) {
    await this._initPromise;
    const names = this._blobNames(roomId);
    const id = sanitize(roomId);
    const archivedAt = String(Date.now());

    const archiveMap = {
      [names.ydoc]: `archive/${id}/room.ydoc`,
      [names.sec]: `archive/${id}/room.sec`,
      [names.comments]: `archive/${id}/room.comments.json`,
    };

    for (const [srcName, dstName] of Object.entries(archiveMap)) {
      const srcBlob = this._container.getBlockBlobClient(srcName);
      const exists = await srcBlob.exists();
      if (!exists) continue;

      const content = await srcBlob.downloadToBuffer();
      const dstBlob = this._container.getBlockBlobClient(dstName);
      await dstBlob.upload(content, content.length, {
        metadata: { archivedAt },
      });
      await srcBlob.deleteIfExists();
    }
  }

  /**
   * Restore a room from archive: copy archive/<roomId>/room.* back to
   * <roomId>/room.*, then delete the archive blobs.
   * @param {string} roomId
   */
  async restoreRoom(roomId) {
    await this._initPromise;
    const names = this._blobNames(roomId);
    const id = sanitize(roomId);

    const restoreMap = {
      [`archive/${id}/room.ydoc`]: names.ydoc,
      [`archive/${id}/room.sec`]: names.sec,
      [`archive/${id}/room.comments.json`]: names.comments,
    };

    for (const [srcName, dstName] of Object.entries(restoreMap)) {
      const srcBlob = this._container.getBlockBlobClient(srcName);
      const exists = await srcBlob.exists();
      if (!exists) continue;

      const content = await srcBlob.downloadToBuffer();
      const dstBlob = this._container.getBlockBlobClient(dstName);
      await dstBlob.upload(content, content.length, {
        metadata: { generation: String(Date.now()) },
      });
      await srcBlob.deleteIfExists();
    }
  }

  /**
   * List archived rooms by scanning for archive/<roomId>/room.ydoc blobs.
   * Reads archivedAt from blob metadata.
   * @returns {{ id: string, archivedAt: string }[]}
   */
  async listArchivedRooms() {
    await this._initPromise;
    const results = [];
    const iter = this._container.listBlobsFlat({ prefix: 'archive/' });
    for await (const item of iter) {
      // Pattern: archive/<roomId>/room.ydoc
      if (item.name.endsWith('/room.ydoc')) {
        const withoutPrefix = item.name.slice('archive/'.length);
        const id = withoutPrefix.slice(0, -'/room.ydoc'.length);
        if (!id) continue;

        let archivedAt = '';
        try {
          const blob = this._container.getBlockBlobClient(item.name);
          const props = await blob.getProperties();
          archivedAt = (props.metadata && props.metadata.archivedAt) || '';
        } catch {
          /* best effort */
        }
        results.push({ id, archivedAt });
      }
    }
    return results;
  }

  /**
   * Permanently delete all archive blobs for a room.
   * @param {string} roomId
   */
  async deleteArchivedRoom(roomId) {
    await this._initPromise;
    const id = sanitize(roomId);
    const archiveBlobs = [
      `archive/${id}/room.ydoc`,
      `archive/${id}/room.sec`,
      `archive/${id}/room.comments.json`,
    ];
    for (const blobName of archiveBlobs) {
      const blob = this._container.getBlockBlobClient(blobName);
      await blob.deleteIfExists();
    }
  }

  /**
   * Return stats for a room (lastModified). Returns null if .ydoc doesn't exist.
   * @param {string} roomId
   * @returns {{ lastModified: string } | null}
   */
  async statRoom(roomId) {
    await this._initPromise;
    const names = this._blobNames(roomId);
    try {
      const blob = this._container.getBlockBlobClient(names.ydoc);
      const props = await blob.getProperties();
      return { lastModified: props.lastModified.toISOString() };
    } catch (err) {
      if (err.statusCode === 404) return null;
      throw err;
    }
  }
}

module.exports = { AzureStorageBackend, sanitize };
