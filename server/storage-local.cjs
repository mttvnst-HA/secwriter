/**
 * LocalStorageBackend — atomic multi-artifact persistence for SIM rooms.
 *
 * Each room stores up to three files:
 *   <room>.ydoc          — binary Yjs state snapshot (Buffer)
 *   <room>.SEC           — Windows-1252 encoded SEC XML (Buffer)
 *   <room>.comments.json — JSON string
 *
 * Writes are staged to .tmp files, then renamed in sequence. If any rename
 * fails, already-renamed artifacts are rolled back and .tmp files cleaned up.
 * .ydoc is renamed LAST because it is the source of truth — the other two
 * can be regenerated from it.
 *
 * CJS on purpose (see collab-server.cjs header comment).
 */

const fs = require('node:fs');
const path = require('node:path');

/** Sanitize a room name: keep only [a-zA-Z0-9_-], max 64 chars. */
function sanitize(name) {
  const safe = String(name).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
  return safe || 'default';
}

class LocalStorageBackend {
  /**
   * @param {string} dataDir — directory for room files (created if absent)
   */
  constructor(dataDir) {
    this._dir = path.resolve(dataDir);
    fs.mkdirSync(this._dir, { recursive: true });
  }

  /** Return the base path (no extension) for a sanitized room. */
  _base(roomId) {
    return path.join(this._dir, sanitize(roomId));
  }

  /**
   * Write all provided artifacts atomically.
   *
   * Order: stage all to .tmp → rename .SEC → rename .comments.json → rename .ydoc.
   * If any rename fails, roll back prior renames and clean up .tmp files.
   *
   * @param {string} roomId
   * @param {{ ydocBytes: Buffer, secBytes: Buffer|null, commentsJson: string|null }} artifacts
   */
  async writeRoom(roomId, { ydocBytes, secBytes, commentsJson }) {
    const base = this._base(roomId);

    // Collect artifacts to write: [targetPath, tmpPath, bytes, backupBytes|null]
    // Ordered so .ydoc is LAST (source of truth).
    const plan = [];

    if (secBytes != null) {
      const target = `${base}.SEC`;
      const tmp = `${target}.tmp`;
      const backup = fs.existsSync(target) ? fs.readFileSync(target) : null;
      plan.push({ target, tmp, bytes: secBytes, backup });
    }

    if (commentsJson != null) {
      const target = `${base}.comments.json`;
      const tmp = `${target}.tmp`;
      const backup = fs.existsSync(target) ? fs.readFileSync(target) : null;
      plan.push({ target, tmp, bytes: Buffer.from(commentsJson, 'utf-8'), backup });
    }

    // .ydoc always written (required)
    {
      const target = `${base}.ydoc`;
      const tmp = `${target}.tmp`;
      const backup = fs.existsSync(target) ? fs.readFileSync(target) : null;
      plan.push({ target, tmp, bytes: ydocBytes, backup });
    }

    // Stage: write all .tmp files
    for (const item of plan) {
      fs.writeFileSync(item.tmp, item.bytes);
    }

    // Rename phase: track which renames succeeded for rollback
    const renamed = [];
    try {
      for (const item of plan) {
        fs.renameSync(item.tmp, item.target);
        renamed.push(item);
      }
    } catch (err) {
      // Rollback: restore already-renamed files from backup
      for (const done of renamed) {
        try {
          if (done.backup != null) {
            fs.writeFileSync(done.target, done.backup);
          } else {
            fs.unlinkSync(done.target);
          }
        } catch (_) { /* best effort */ }
      }
      // Clean up any remaining .tmp files
      for (const item of plan) {
        try { fs.unlinkSync(item.tmp); } catch (_) { /* may not exist */ }
      }
      throw err;
    }
  }

  /**
   * Read a room's artifacts. Returns null if .ydoc doesn't exist.
   * Missing .SEC or .comments.json are returned as null (legacy rooms).
   *
   * @param {string} roomId
   * @returns {{ ydocBytes: Buffer, secBytes: Buffer|null, commentsJson: string|null } | null}
   */
  async readRoom(roomId) {
    const base = this._base(roomId);
    const ydocPath = `${base}.ydoc`;

    if (!fs.existsSync(ydocPath)) return null;

    const ydocBytes = fs.readFileSync(ydocPath);

    const secPath = `${base}.SEC`;
    const secBytes = fs.existsSync(secPath) ? fs.readFileSync(secPath) : null;

    const commentsPath = `${base}.comments.json`;
    const commentsJson = fs.existsSync(commentsPath)
      ? fs.readFileSync(commentsPath, 'utf-8')
      : null;

    return { ydocBytes, secBytes, commentsJson };
  }

  /**
   * Quarantine a room's artifacts by renaming them with a reason + timestamp suffix.
   * Used for oversized or corrupt snapshots that should be preserved for inspection.
   * @param {string} roomId
   * @param {'oversize'|'corrupt'} reason
   */
  async quarantineRoom(roomId, reason) {
    const base = this._base(roomId);
    const suffix = `.${reason}.${Date.now()}`;
    for (const ext of ['.ydoc', '.SEC', '.comments.json']) {
      const src = `${base}${ext}`;
      if (fs.existsSync(src)) {
        try { fs.renameSync(src, `${src}${suffix}`); } catch { /* ignore */ }
      }
    }
  }

  /**
   * Delete all artifacts for a room.
   * @param {string} roomId
   */
  async deleteRoom(roomId) {
    const base = this._base(roomId);
    const exts = ['.ydoc', '.SEC', '.comments.json'];
    for (const ext of exts) {
      const p = `${base}${ext}`;
      try { fs.unlinkSync(p); } catch (_) { /* may not exist */ }
    }
  }

  /**
   * List room names by scanning for .ydoc files.
   * Excludes .tmp, .corrupt, .oversize variants.
   * @returns {string[]}
   */
  async listRooms() {
    const entries = fs.readdirSync(this._dir);
    const rooms = [];
    for (const entry of entries) {
      // Match exactly "<name>.ydoc" — no further extension
      if (entry.endsWith('.ydoc') && !entry.includes('.ydoc.')) {
        // Exclude files like "room.ydoc.tmp" — but those end with .tmp, not .ydoc
        // The pattern "name.ydoc" is what we want; "name.ydoc.corrupt.123" won't match
        const name = entry.slice(0, -5); // strip ".ydoc"
        if (name.length > 0) rooms.push(name);
      }
    }
    return rooms;
  }
}

module.exports = { LocalStorageBackend, sanitize };
