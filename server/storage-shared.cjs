/**
 * Shared storage primitives for SecWriter room backends.
 *
 * Owns the cross-backend room-persistence vocabulary so the three concrete
 * backends (local, azure, s3) don't independently re-derive it:
 *
 *   - sanitize() — single source of truth for room-id normalization
 *   - ARTIFACT_CATALOG — the three artifact kinds and their write-order
 *     contract (.ydoc LAST = source of truth)
 *   - ARTIFACT_KIND_* — kind constants used by the base class and adapters
 *
 * CJS on purpose (see ADR-0001).
 */
'use strict';

/**
 * Sanitize a room name: keep only [a-zA-Z0-9_-], max 64 chars.
 * Empty/all-stripped names fall back to 'default'.
 */
function sanitize(name) {
  const safe = String(name).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
  return safe || 'default';
}

const ARTIFACT_KIND_YDOC = 'ydoc';
const ARTIFACT_KIND_SEC = 'sec';
const ARTIFACT_KIND_COMMENTS = 'comments';
const ARTIFACT_KIND_LINT = 'lint';
const ARTIFACT_KIND_ACL = 'acl';
const PUBLIC_TENANT = '_public';

/**
 * The five artifacts persisted per room, in the order they must be written.
 *
 *   1. SEC     (optional sidecar — windows-1252 SEC XML)
 *   2. comments (optional sidecar — JSON)
 *   3. lint    (optional sidecar — JSON block-granular linting cache, issue #138)
 *   4. acl     (optional sidecar — JSON room access-control list)
 *   5. ydoc    (REQUIRED, source of truth — Yjs binary snapshot)
 *
 * `.ydoc` is written LAST so a sidecar failure leaves `.ydoc` at the older
 * consistent state rather than ahead of stale sidecars. The base class
 * iterates this array; adapters never decide the order themselves. Adding a
 * new artifact is a one-line edit here — RoomStorageBase fans out
 * automatically.
 */
const ARTIFACT_CATALOG = Object.freeze([
  Object.freeze({ kind: ARTIFACT_KIND_SEC,      optional: true,  contentType: 'application/octet-stream' }),
  Object.freeze({ kind: ARTIFACT_KIND_COMMENTS, optional: true,  contentType: 'application/json' }),
  Object.freeze({ kind: ARTIFACT_KIND_LINT,     optional: true,  contentType: 'application/json' }),
  Object.freeze({ kind: ARTIFACT_KIND_ACL,      optional: true,  contentType: 'application/json' }),
  Object.freeze({ kind: ARTIFACT_KIND_YDOC,     optional: false, contentType: 'application/octet-stream' }),
]);

/**
 * Map an `artifacts` argument to writeRoom into a normalized array of
 * { kind, bytes } entries in catalog order, skipping optional artifacts
 * that are null/undefined.
 *
 * Bytes are coerced to Buffer (commentsJson / lintJson strings → utf-8 buffer).
 */
function planArtifactWrites({ ydocBytes, secBytes, commentsJson, lintJson }) {
  if (ydocBytes == null) {
    throw new Error('writeRoom: ydocBytes is required');
  }
  const plan = [];
  if (secBytes != null) {
    plan.push({ kind: ARTIFACT_KIND_SEC, bytes: toBuffer(secBytes) });
  }
  if (commentsJson != null) {
    plan.push({ kind: ARTIFACT_KIND_COMMENTS, bytes: Buffer.from(commentsJson, 'utf-8') });
  }
  if (lintJson != null) {
    plan.push({ kind: ARTIFACT_KIND_LINT, bytes: Buffer.from(lintJson, 'utf-8') });
  }
  plan.push({ kind: ARTIFACT_KIND_YDOC, bytes: toBuffer(ydocBytes) });
  return plan;
}

function toBuffer(bytes) {
  if (Buffer.isBuffer(bytes)) return bytes;
  if (bytes instanceof Uint8Array) return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return Buffer.from(bytes);
}

/**
 * The internal docName / storage namespace is ALWAYS composite:
 * `<tenant>/<roomId>` — two independently-sanitized halves joined by a
 * structural `/`. Under auth=none the tenant is the reserved PUBLIC_TENANT.
 * There is exactly one key shape; no flat-vs-prefixed fork.
 */
function buildCompositeDocName(tenant, roomId) {
  return `${sanitize(tenant)}/${sanitize(roomId)}`;
}

/** Split a composite docName back into { tenant, roomId } on the FIRST slash. */
function splitCompositeDocName(docName) {
  const i = String(docName).indexOf('/');
  if (i < 0) return { tenant: PUBLIC_TENANT, roomId: String(docName) };
  return { tenant: docName.slice(0, i), roomId: docName.slice(i + 1) };
}

module.exports = {
  sanitize,
  toBuffer,
  PUBLIC_TENANT,
  ARTIFACT_KIND_YDOC,
  ARTIFACT_KIND_SEC,
  ARTIFACT_KIND_COMMENTS,
  ARTIFACT_KIND_LINT,
  ARTIFACT_KIND_ACL,
  ARTIFACT_CATALOG,
  planArtifactWrites,
  buildCompositeDocName,
  splitCompositeDocName,
};
