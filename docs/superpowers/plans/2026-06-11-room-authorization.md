# Room Authorization — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add multi-tenant isolation + private-by-default room authorization to the collab server, so that with `SIM_AUTH_PROVIDER=jwt` a valid token can only reach rooms in its own tenant that it owns or has been shared.

**Architecture:** One always-namespaced composite room key `(tenant, roomId)`. Authorization data lives outside the CRDT in a cheap `.acl.json` sidecar artifact. Storage adapters take `(tenant, roomId, kind)`; the WS layer and in-memory maps key on a composite docName `<tenant>/<roomId>`; under `auth=none` everything runs under a reserved `_public` sentinel tenant so the demo stays open with zero special-casing. A single `authorize()` decision function gates every `/rooms*` HTTP route and the WS upgrade.

**Tech Stack:** Node.js CJS server (`server/`), Yjs + y-websocket v1.5.4, `jsonwebtoken`, three storage backends (local fs / S3 / Azure Blob) all extending `RoomStorageBase`. Tests use Node's built-in `node --test` runner.

**Source of truth:** `docs/superpowers/specs/2026-06-11-room-authorization-design.md`. Read it before starting.

---

## Canonical names (use these EXACTLY — type-consistency contract)

| Symbol | Defined in | Shape |
|---|---|---|
| `ARTIFACT_KIND_ACL` | `storage-shared.cjs` | `'acl'` |
| `PUBLIC_TENANT` | `storage-shared.cjs` | `'_public'` |
| `buildCompositeDocName(tenant, roomId)` | `storage-shared.cjs` | `` `${sanitize(tenant)}/${sanitize(roomId)}` `` |
| `splitCompositeDocName(docName)` | `storage-shared.cjs` | `{ tenant, roomId }` (no `/` → `{ tenant: '_public', roomId: docName }`) |
| `_keyForArtifact(tenant, roomId, kind, opts)` | each adapter | storage key string \| null |
| `_parseActiveKey(key, kind)` / `_parseArchiveKey(key, kind)` | each adapter | `{ tenant, roomId } \| null` |
| `readAcl(tenant, roomId)` | `room-storage.cjs` base | `{ ownerId, sharedWith } \| null` |
| `writeAcl(tenant, roomId, acl)` | `room-storage.cjs` base | `void` |
| `listRooms(tenant)` | base | `string[]` (bare roomIds in that tenant) |
| `listAllRooms()` | base (local overrides) | `[{ tenant, roomId }]` |
| `listArchivedRooms(tenant)` | base | `[{ id, archivedAt }]` |
| `listAllArchivedRooms()` | base (local overrides) | `[{ tenant, roomId, archivedAt }]` |
| `authorize({ authProvider, storage, user, roomId, action })` | `auth/authorize.cjs` | `{ ok: true } \| { ok: false, status }` |
| `checkPrincipal(authProvider, user)` | `auth/authorize.cjs` | `{ ok: true } \| { ok: false, status }` |
| `ACTION` | `auth/authorize.cjs` | `{ READ, DELETE, SHARE, LOCK_ADMIN }` |

**ACL JSON shape:** `{ "ownerId": "<sub>", "sharedWith": ["<sub>", ...] }`. This is the security floor; graded roles ([#239](https://github.com/mttvnst-HA/secwriter/issues/239)) evolve it later — do not add a `roles` map here.

---

# Phase A — Storage substrate: composite keys + ACL sidecar

This phase is self-contained: it changes storage signatures and the cross-backend contract test. Nothing above storage is touched yet, so `storage-contract.test.mjs` is the gate for the whole phase.

## Task 1: Storage-shared constants + composite-key helpers

**Files:**
- Modify: `server/storage-shared.cjs`
- Test: `server/__tests__/storage-shared.test.mjs` (create)

- [ ] **Step 1: Write the failing test**

Create `server/__tests__/storage-shared.test.mjs`:

```javascript
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
    assert.equal(buildCompositeDocName('a/b', '../x'), 'a_b/__x'); // / and . collapse per-half
  });

  it('splitCompositeDocName splits on first slash; bare id defaults to _public', () => {
    assert.deepEqual(splitCompositeDocName('acme/room1'), { tenant: 'acme', roomId: 'room1' });
    assert.deepEqual(splitCompositeDocName('legacyroom'), { tenant: '_public', roomId: 'legacyroom' });
    // roomId may itself contain no slash after sanitize, so only the FIRST slash splits
    assert.deepEqual(splitCompositeDocName('t/a/b'), { tenant: 't', roomId: 'a/b' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test server/__tests__/storage-shared.test.mjs`
Expected: FAIL — `PUBLIC_TENANT`, `ARTIFACT_KIND_ACL`, `buildCompositeDocName`, `splitCompositeDocName` are undefined.

- [ ] **Step 3: Implement in `server/storage-shared.cjs`**

Add the constant immediately after the existing `ARTIFACT_KIND_*` constants (after `ARTIFACT_KIND_LINT`):

```javascript
const ARTIFACT_KIND_ACL = 'acl';
const PUBLIC_TENANT = '_public';
```

Insert the ACL entry into `ARTIFACT_CATALOG` **immediately before** the `ydoc` entry so `.ydoc` stays the tail/source-of-truth:

```javascript
const ARTIFACT_CATALOG = Object.freeze([
  Object.freeze({ kind: ARTIFACT_KIND_SEC,      optional: true,  contentType: 'application/octet-stream' }),
  Object.freeze({ kind: ARTIFACT_KIND_COMMENTS, optional: true,  contentType: 'application/json' }),
  Object.freeze({ kind: ARTIFACT_KIND_LINT,     optional: true,  contentType: 'application/json' }),
  Object.freeze({ kind: ARTIFACT_KIND_ACL,      optional: true,  contentType: 'application/json' }),
  Object.freeze({ kind: ARTIFACT_KIND_YDOC,     optional: false, contentType: 'application/octet-stream' }),
]);
```

`planArtifactWrites` is UNCHANGED — it never emits ACL bytes (ACL is written only via `writeAcl`). The catalog entry exists so `deleteRoom`/`archiveRoom`/`quarantineRoom`/`restoreRoom` (which iterate the full catalog) carry the sidecar along automatically.

Add the composite helpers after `toBuffer`:

```javascript
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
```

Add all four new names to `module.exports`:

```javascript
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test server/__tests__/storage-shared.test.mjs`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add server/storage-shared.cjs server/__tests__/storage-shared.test.mjs
git commit -m "feat(storage): add ACL kind, _public sentinel, composite-key helpers"
```

---

## Task 2: Base class — thread (tenant, roomId), add ACL + tenant-list primitives

**Files:**
- Modify: `server/room-storage.cjs`

This task only changes the base class. Adapter primitives still have the OLD `(roomId, kind)` signature, so the contract test will be red until Tasks 3–5 land — that's expected; this task has no standalone test gate (it's exercised by Task 6's rewritten contract test). Verify by running the full server suite at the END of Task 6.

- [ ] **Step 1: Update the require block** to pull in the new names:

```javascript
const {
  ARTIFACT_CATALOG,
  ARTIFACT_KIND_YDOC,
  ARTIFACT_KIND_SEC,
  ARTIFACT_KIND_COMMENTS,
  ARTIFACT_KIND_LINT,
  ARTIFACT_KIND_ACL,
  sanitize,
  planArtifactWrites,
} = require('./storage-shared.cjs');
```

- [ ] **Step 2: Rewrite every public method to take `(tenant, roomId, ...)`** and pass `(tenant, roomId, kind, opts)` into `_keyForArtifact`. Replace the whole public-methodset block (current lines 53–195) with:

```javascript
  // ── Public methodset (all keyed by composite (tenant, roomId)) ───────────

  async writeRoom(tenant, roomId, artifacts) {
    const plan = planArtifactWrites(artifacts);
    for (const { kind, bytes } of plan) {
      const entry = ARTIFACT_CATALOG.find(c => c.kind === kind);
      const key = this._keyForArtifact(tenant, roomId, kind);
      await this._putBytes(key, bytes, { contentType: entry.contentType });
    }
  }

  async readRoom(tenant, roomId) {
    const ydocKey = this._keyForArtifact(tenant, roomId, ARTIFACT_KIND_YDOC);
    const ydocBytes = await this._getBytes(ydocKey);
    if (ydocBytes == null) return null;

    const secBytes = await this._getBytes(this._keyForArtifact(tenant, roomId, ARTIFACT_KIND_SEC));

    const commentsBuf = await this._getBytes(this._keyForArtifact(tenant, roomId, ARTIFACT_KIND_COMMENTS));
    const commentsJson = commentsBuf == null ? null : commentsBuf.toString('utf-8');

    const lintKey = this._keyForArtifact(tenant, roomId, ARTIFACT_KIND_LINT);
    const lintBuf = lintKey == null ? null : await this._getBytes(lintKey);
    const lintJson = lintBuf == null ? null : lintBuf.toString('utf-8');

    return { ydocBytes, secBytes, commentsJson, lintJson };
  }

  /** Cheap single-artifact ACL read — used by authorize() before any doc load. */
  async readAcl(tenant, roomId) {
    const key = this._keyForArtifact(tenant, roomId, ARTIFACT_KIND_ACL);
    const bytes = await this._getBytes(key);
    if (bytes == null) return null;
    try { return JSON.parse(bytes.toString('utf-8')); }
    catch { return null; }
  }

  /** Single-artifact ACL write — used by POST /rooms (create) and the share route. */
  async writeAcl(tenant, roomId, acl) {
    const entry = ARTIFACT_CATALOG.find(c => c.kind === ARTIFACT_KIND_ACL);
    const key = this._keyForArtifact(tenant, roomId, ARTIFACT_KIND_ACL);
    await this._putBytes(key, Buffer.from(JSON.stringify(acl), 'utf-8'), { contentType: entry.contentType });
  }

  async deleteRoom(tenant, roomId) {
    for (const { kind } of ARTIFACT_CATALOG) {
      await this._deleteKey(this._keyForArtifact(tenant, roomId, kind));
    }
  }

  async statRoom(tenant, roomId) {
    return this._statKey(this._keyForArtifact(tenant, roomId, ARTIFACT_KIND_YDOC));
  }

  /** Bare roomIds in ONE tenant. */
  async listRooms(tenant) {
    const t = sanitize(tenant);
    const keys = await this._listKeys({ prefix: this._listPrefix(false, t) });
    const rooms = new Set();
    for (const key of keys) {
      const parsed = this._parseActiveKey(key, ARTIFACT_KIND_YDOC);
      if (parsed && parsed.tenant === t) rooms.add(parsed.roomId);
    }
    return [...rooms];
  }

  /** Cross-tenant: [{ tenant, roomId }]. Used by the server sweep only. */
  async listAllRooms() {
    const keys = await this._listKeys({ prefix: this._listPrefix(false) });
    const seen = new Set();
    const out = [];
    for (const key of keys) {
      const parsed = this._parseActiveKey(key, ARTIFACT_KIND_YDOC);
      if (!parsed) continue;
      const ck = `${parsed.tenant}/${parsed.roomId}`;
      if (seen.has(ck)) continue;
      seen.add(ck);
      out.push(parsed);
    }
    return out;
  }

  async quarantineRoom(tenant, roomId, reason) {
    const ts = Date.now();
    for (const { kind } of ARTIFACT_CATALOG) {
      const srcKey = this._keyForArtifact(tenant, roomId, kind);
      const dstKey = this._keyForArtifact(tenant, roomId, kind, { quarantine: { reason, ts } });
      if (dstKey == null) continue;
      const exists = (await this._statKey(srcKey)) != null;
      if (!exists) continue;
      try {
        await this._copyKey(srcKey, dstKey, {
          metadata: { quarantineReason: String(reason), quarantineTime: String(ts) },
        });
        await this._deleteKey(srcKey);
      } catch (err) {
        this._onPartialOp('quarantine', { roomId, kind, err });
      }
    }
  }

  async archiveRoom(tenant, roomId) {
    const archivedAt = new Date().toISOString();
    let copied = false;
    for (const { kind } of ARTIFACT_CATALOG) {
      const srcKey = this._keyForArtifact(tenant, roomId, kind);
      const dstKey = this._keyForArtifact(tenant, roomId, kind, { archived: true });
      const exists = (await this._statKey(srcKey)) != null;
      if (!exists) continue;
      try {
        await this._copyKey(srcKey, dstKey, { metadata: { archivedat: archivedAt } });
        copied = true;
      } catch (err) {
        this._onPartialOp('archive', { roomId, kind, err });
        continue;
      }
      try { await this._deleteKey(srcKey); }
      catch (err) { this._onPartialOp('archive', { roomId, kind, err }); }
    }
    if (copied) await this._writeArchiveMarker(tenant, roomId, archivedAt);
  }

  async restoreRoom(tenant, roomId) {
    for (const { kind } of ARTIFACT_CATALOG) {
      const srcKey = this._keyForArtifact(tenant, roomId, kind, { archived: true });
      const dstKey = this._keyForArtifact(tenant, roomId, kind);
      const exists = (await this._statKey(srcKey)) != null;
      if (!exists) continue;
      try { await this._copyKey(srcKey, dstKey); }
      catch (err) { this._onPartialOp('restore', { roomId, kind, err }); continue; }
      try { await this._deleteKey(srcKey); }
      catch (err) { this._onPartialOp('restore', { roomId, kind, err }); }
    }
    await this._deleteArchiveMarker(tenant, roomId);
  }

  /** Archived rooms in ONE tenant: [{ id, archivedAt }]. */
  async listArchivedRooms(tenant) {
    const t = sanitize(tenant);
    const keys = await this._listKeys({ prefix: this._listPrefix(true, t) });
    const seen = new Set();
    const result = [];
    for (const key of keys) {
      const parsed = this._parseArchiveKey(key, ARTIFACT_KIND_YDOC);
      if (!parsed || parsed.tenant !== t || seen.has(parsed.roomId)) continue;
      seen.add(parsed.roomId);
      const archivedAt = await this._readArchiveMarker(parsed.tenant, parsed.roomId, key);
      result.push({ id: parsed.roomId, archivedAt });
    }
    return result;
  }

  /** Cross-tenant archived: [{ tenant, roomId, archivedAt }]. Sweep only. */
  async listAllArchivedRooms() {
    const keys = await this._listKeys({ prefix: this._listPrefix(true) });
    const seen = new Set();
    const out = [];
    for (const key of keys) {
      const parsed = this._parseArchiveKey(key, ARTIFACT_KIND_YDOC);
      if (!parsed) continue;
      const ck = `${parsed.tenant}/${parsed.roomId}`;
      if (seen.has(ck)) continue;
      seen.add(ck);
      const archivedAt = await this._readArchiveMarker(parsed.tenant, parsed.roomId, key);
      out.push({ tenant: parsed.tenant, roomId: parsed.roomId, archivedAt });
    }
    return out;
  }

  async deleteArchivedRoom(tenant, roomId) {
    for (const { kind } of ARTIFACT_CATALOG) {
      await this._deleteKey(this._keyForArtifact(tenant, roomId, kind, { archived: true }));
    }
    await this._deleteArchiveMarker(tenant, roomId);
  }
```

- [ ] **Step 3: Update the optional-override signatures** (archive-marker hooks now take `(tenant, roomId, ...)`). Replace the three default hooks:

```javascript
  /** Default: no-op. Local overrides to write a sidecar marker file. */
  async _writeArchiveMarker(_tenant, _roomId, _archivedAt) { /* no-op */ }

  /** Default: read `archivedat` metadata from the archived `.ydoc`. Local overrides. */
  async _readArchiveMarker(_tenant, _roomId, _archiveYdocKey) { return null; }

  /** Default: no-op. Local overrides to remove the sidecar marker. */
  async _deleteArchiveMarker(_tenant, _roomId) { /* no-op */ }
```

- [ ] **Step 4: Update the adapter-contract doc comment** (the block at lines 1–36 and 197–209) to reflect the new signatures: `_keyForArtifact(tenant, roomId, kind, opts)`, `_parseActiveKey/_parseArchiveKey → { tenant, roomId }`, `_listPrefix(archived, tenant?)`, plus the note that `listAllRooms`/`listAllArchivedRooms` default to a flat parse and Local overrides them for its directory layout.

- [ ] **Step 5: Commit**

```bash
git add server/room-storage.cjs
git commit -m "refactor(storage): base methods take (tenant, roomId); add ACL + tenant-list primitives"
```

---

## Task 3: Local backend — tenant subdirectories + ACL ext

**Files:**
- Modify: `server/storage-local.cjs`

Active layout becomes `<dir>/<tenant>/<roomId>.<ext>`; archive `<dir>/archive/<tenant>/<roomId>.<ext>`. Local's `_listKeys` is a non-recursive `readdirSync`, so `listAllRooms`/`listAllArchivedRooms` MUST be overridden to walk tenant subdirs.

- [ ] **Step 1: Add the ACL extension** to `EXT_BY_KIND`:

```javascript
const EXT_BY_KIND = {
  [ARTIFACT_KIND_YDOC]: '.ydoc',
  [ARTIFACT_KIND_SEC]: '.SEC',
  [ARTIFACT_KIND_COMMENTS]: '.comments.json',
  [ARTIFACT_KIND_LINT]: '.lint.json',
  [ARTIFACT_KIND_ACL]: '.acl.json',
};
```

Update the require to include `ARTIFACT_KIND_ACL` and `sanitize` (already imported).

- [ ] **Step 2: Rewrite `writeRoom` override + `_putBytes`** so the tenant subdir is created before any write. Replace the `writeRoom` override (lines 62–95) — the only change is the per-item `target`/`tmp` now living in a tenant subdir, so add an mkdir of each target's directory:

```javascript
  async writeRoom(tenant, roomId, artifacts) {
    const plan = planArtifactWrites(artifacts).map(({ kind, bytes }) => {
      const target = this._keyForArtifact(tenant, roomId, kind);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      return {
        target,
        tmp: `${target}.tmp`,
        bytes,
        backup: fs.existsSync(target) ? fs.readFileSync(target) : null,
      };
    });

    for (const item of plan) fs.writeFileSync(item.tmp, item.bytes);

    const renamed = [];
    try {
      for (const item of plan) {
        fs.renameSync(item.tmp, item.target);
        renamed.push(item);
      }
    } catch (err) {
      for (const done of renamed) {
        try {
          if (done.backup != null) fs.writeFileSync(done.target, done.backup);
          else fs.unlinkSync(done.target);
        } catch { /* best effort */ }
      }
      for (const item of plan) {
        try { fs.unlinkSync(item.tmp); } catch { /* may not exist */ }
      }
      throw err;
    }
  }
```

Replace `_putBytes` so `writeAcl` (which routes through `_putBytes`) also creates the tenant dir:

```javascript
  async _putBytes(key, bytes) {
    fs.mkdirSync(path.dirname(key), { recursive: true });
    fs.writeFileSync(key, bytes);
  }
```

- [ ] **Step 3: Rewrite naming + listing** (replace lines 131–166):

```javascript
  _keyForArtifact(tenant, roomId, kind, opts = {}) {
    const t = sanitize(tenant);
    const safe = sanitize(roomId);
    const ext = EXT_BY_KIND[kind];
    if (opts.archived) return path.join(this._dir, 'archive', t, `${safe}${ext}`);
    if (opts.quarantine) {
      const { reason, ts } = opts.quarantine;
      return path.join(this._dir, t, `${safe}${ext}.${reason}.${ts}`);
    }
    return path.join(this._dir, t, `${safe}${ext}`);
  }

  _listPrefix(archived, tenant) {
    if (archived) {
      return tenant ? path.join(this._dir, 'archive', sanitize(tenant)) : path.join(this._dir, 'archive');
    }
    return tenant ? path.join(this._dir, sanitize(tenant)) : this._dir;
  }

  _parseActiveKey(fullKey, kind) {
    if (kind !== ARTIFACT_KIND_YDOC) return null;
    const name = path.basename(fullKey);
    if (!name.endsWith('.ydoc') || name.includes('.ydoc.')) return null;
    const roomId = name.slice(0, -'.ydoc'.length);
    if (!roomId) return null;
    const tenant = path.basename(path.dirname(fullKey));
    if (!tenant || tenant === 'archive') return null;
    return { tenant, roomId };
  }

  _parseArchiveKey(fullKey, kind) {
    if (kind !== ARTIFACT_KIND_YDOC) return null;
    const name = path.basename(fullKey);
    if (!name.endsWith('.ydoc') || name.includes('.ydoc.')) return null;
    const roomId = name.slice(0, -'.ydoc'.length);
    if (!roomId) return null;
    const tenant = path.basename(path.dirname(fullKey));
    if (!tenant) return null;
    return { tenant, roomId };
  }

  /** Tenant subdirs under the data dir (excludes the shared `archive` dir). */
  _listTenants() {
    if (!fs.existsSync(this._dir)) return [];
    return fs.readdirSync(this._dir, { withFileTypes: true })
      .filter(d => d.isDirectory() && d.name !== 'archive')
      .map(d => d.name);
  }

  /** Tenant subdirs under <dir>/archive. */
  _listArchivedTenants() {
    const archiveDir = path.join(this._dir, 'archive');
    if (!fs.existsSync(archiveDir)) return [];
    return fs.readdirSync(archiveDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);
  }

  /** Local readdir is non-recursive — walk tenant subdirs for the cross-tenant list. */
  async listAllRooms() {
    const out = [];
    for (const t of this._listTenants()) {
      for (const roomId of await this.listRooms(t)) out.push({ tenant: t, roomId });
    }
    return out;
  }

  async listAllArchivedRooms() {
    const out = [];
    for (const t of this._listArchivedTenants()) {
      for (const r of await this.listArchivedRooms(t)) {
        out.push({ tenant: t, roomId: r.id, archivedAt: r.archivedAt });
      }
    }
    return out;
  }
```

- [ ] **Step 4: Rewrite the archive-marker hooks** to take `(tenant, roomId, ...)` and live in the tenant archive subdir (replace lines 168–197):

```javascript
  async _writeArchiveMarker(tenant, roomId, archivedAt) {
    const dir = path.join(this._dir, 'archive', sanitize(tenant));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${sanitize(roomId)}.archivedAt`), archivedAt, 'utf-8');
  }

  async _readArchiveMarker(tenant, roomId) {
    const markerPath = path.join(this._dir, 'archive', sanitize(tenant), `${sanitize(roomId)}.archivedAt`);
    if (!fs.existsSync(markerPath)) return null;
    try { return fs.readFileSync(markerPath, 'utf-8').trim(); }
    catch { return null; }
  }

  async _deleteArchiveMarker(tenant, roomId) {
    const markerPath = path.join(this._dir, 'archive', sanitize(tenant), `${sanitize(roomId)}.archivedAt`);
    try { fs.unlinkSync(markerPath); } catch { /* may not exist */ }
  }

  async archiveRoom(tenant, roomId) {
    fs.mkdirSync(path.join(this._dir, 'archive', sanitize(tenant)), { recursive: true });
    return super.archiveRoom(tenant, roomId);
  }
```

- [ ] **Step 5: Commit**

```bash
git add server/storage-local.cjs
git commit -m "feat(storage-local): tenant subdirectory layout + ACL artifact"
```

---

## Task 4: S3 backend — tenant prefix + ACL + quarantine sidecar

**Files:**
- Modify: `server/storage-s3.cjs`

Active layout `<tenant>/<roomId>.<ext>`; archive `archive/<tenant>/<roomId>.<ext>`. S3's flat `_listKeys` works with the base `listAllRooms`/`listAllArchivedRooms` — no override needed.

- [ ] **Step 1: Add ACL extension + import.** Add to `EXT_BY_KIND`:

```javascript
  [ARTIFACT_KIND_ACL]: '.acl.json',
```

Add `ARTIFACT_KIND_ACL` to the `require('./storage-shared.cjs')` destructure.

- [ ] **Step 2: Rewrite naming + parsing** (replace lines 134–175):

```javascript
  _keyForArtifact(tenant, roomId, kind, opts = {}) {
    const t = sanitize(tenant);
    const safe = sanitize(roomId);
    const ext = EXT_BY_KIND[kind];
    if (opts.archived) return `archive/${t}/${safe}${ext}`;
    if (opts.quarantine) {
      // S3 historical: suffix BEFORE the extension, no timestamp. Quarantine
      // .ydoc AND .acl.json (the sidecar must travel with a quarantined room
      // so authorize() can't resolve a half-deleted room). Other kinds skip.
      if (kind !== ARTIFACT_KIND_YDOC && kind !== ARTIFACT_KIND_ACL) return null;
      const { reason } = opts.quarantine;
      return `${t}/${safe}.${reason}${ext}`;
    }
    return `${t}/${safe}${ext}`;
  }

  _listPrefix(archived, tenant) {
    if (archived) return tenant ? `archive/${sanitize(tenant)}/` : 'archive/';
    return tenant ? `${sanitize(tenant)}/` : undefined;
  }

  _parseActiveKey(key, kind) {
    if (kind !== ARTIFACT_KIND_YDOC) return null;
    if (key.startsWith('archive/')) return null;
    // <tenant>/<roomId>.ydoc — roomId has no '.' so quarantined
    // <tenant>/<roomId>.<reason>.ydoc is excluded.
    const m = key.match(/^([^/]+)\/([^./]+)\.ydoc$/);
    if (!m) return null;
    const [, tenant, roomId] = m;
    if (sanitize(tenant) !== tenant || sanitize(roomId) !== roomId) return null;
    return { tenant, roomId };
  }

  _parseArchiveKey(key, kind) {
    if (kind !== ARTIFACT_KIND_YDOC) return null;
    const m = key.match(/^archive\/([^/]+)\/([^./]+)\.ydoc$/);
    if (!m) return null;
    const [, tenant, roomId] = m;
    if (sanitize(tenant) !== tenant || sanitize(roomId) !== roomId) return null;
    return { tenant, roomId };
  }
```

- [ ] **Step 3: Update `_readArchiveMarker`** signature (it now receives `(tenant, roomId, archiveYdocKey)`; the body still reads metadata from the key, so only the param list changes):

```javascript
  async _readArchiveMarker(_tenant, _roomId, archiveYdocKey) {
    try {
      const head = await this.client.send(new HeadObjectCommand({
        Bucket: this.bucket,
        Key: archiveYdocKey,
      }));
      return head.Metadata?.archivedat || null;
    } catch {
      return null;
    }
  }
```

- [ ] **Step 4: Commit**

```bash
git add server/storage-s3.cjs
git commit -m "feat(storage-s3): tenant prefix layout + ACL artifact + sidecar quarantine"
```

---

## Task 5: Azure backend — tenant prefix + ACL

**Files:**
- Modify: `server/storage-azure.cjs`

Active layout `<tenant>/<roomId>/room.<ext>`; archive `archive/<tenant>/<roomId>/room.<ext>`. The parser splits on the FIRST `/` (tenant) and the trailing `/room.ydoc`. Azure's flat `listBlobsFlat` works with base `listAll*`.

- [ ] **Step 1: Add ACL suffix + import.** Add to `SUFFIX_BY_KIND`:

```javascript
  [ARTIFACT_KIND_ACL]: 'room.acl.json',
```

Add `ARTIFACT_KIND_ACL` to the `require('./storage-shared.cjs')` destructure.

- [ ] **Step 2: Update `writeRoom` override** — the only change is the `_keyForArtifact` call now passes `(tenant, roomId, ...)`. Replace line 50 and the lease-key line:

```javascript
  async writeRoom(tenant, roomId, artifacts) {
    await this._initPromise;
    const plan = planArtifactWrites(artifacts);

    const ydocKey = this._keyForArtifact(tenant, roomId, ARTIFACT_KIND_YDOC);
    const ydocBlob = this._container.getBlockBlobClient(ydocKey);

    let leaseClient = null;
    let leaseId = null;
    try {
      leaseClient = ydocBlob.getBlobLeaseClient();
      const leaseResult = await leaseClient.acquireLease(30);
      leaseId = leaseResult.leaseId;
    } catch {
      leaseClient = null;
    }

    const metadata = { generation: String(Date.now()) };

    try {
      for (const { kind, bytes } of plan) {
        const key = this._keyForArtifact(tenant, roomId, kind);
        const blob = this._container.getBlockBlobClient(key);
        const opts = { metadata };
        if (kind === ARTIFACT_KIND_YDOC && leaseId) opts.conditions = { leaseId };
        await blob.upload(bytes, bytes.length, opts);
      }
    } finally {
      if (leaseClient && leaseId) {
        try { await leaseClient.releaseLease(); } catch { /* ignore */ }
      }
    }
  }
```

- [ ] **Step 3: Rewrite naming + parsing** (replace lines 150–182):

```javascript
  _keyForArtifact(tenant, roomId, kind, opts = {}) {
    const t = sanitize(tenant);
    const id = sanitize(roomId);
    const suffix = SUFFIX_BY_KIND[kind];
    if (opts.archived) return `archive/${t}/${id}/${suffix}`;
    if (opts.quarantine) {
      const { reason, ts } = opts.quarantine;
      return `${t}/${id}/${suffix}.${reason}.${ts}`;
    }
    return `${t}/${id}/${suffix}`;
  }

  _listPrefix(archived, tenant) {
    if (archived) return tenant ? `archive/${sanitize(tenant)}/` : 'archive/';
    return tenant ? `${sanitize(tenant)}/` : undefined;
  }

  _parseActiveKey(key, kind) {
    if (kind !== ARTIFACT_KIND_YDOC) return null;
    if (key.startsWith('archive/')) return null;
    if (!key.endsWith('/room.ydoc')) return null;
    const i = key.indexOf('/');
    if (i < 0) return null;
    const tenant = key.slice(0, i);
    const rest = key.slice(i + 1);                 // <id>/room.ydoc
    const roomId = rest.slice(0, -'/room.ydoc'.length);
    if (!tenant || !roomId || roomId.includes('/')) return null;
    return { tenant, roomId };
  }

  _parseArchiveKey(key, kind) {
    if (kind !== ARTIFACT_KIND_YDOC) return null;
    if (!key.startsWith('archive/')) return null;
    if (!key.endsWith('/room.ydoc')) return null;
    const rest = key.slice('archive/'.length);     // <tenant>/<id>/room.ydoc
    const i = rest.indexOf('/');
    if (i < 0) return null;
    const tenant = rest.slice(0, i);
    const roomId = rest.slice(i + 1).slice(0, -'/room.ydoc'.length);
    if (!tenant || !roomId || roomId.includes('/')) return null;
    return { tenant, roomId };
  }
```

- [ ] **Step 4: Update `_readArchiveMarker`** signature to `(tenant, roomId, archiveYdocKey)` (body unchanged):

```javascript
  async _readArchiveMarker(_tenant, _roomId, archiveYdocKey) {
    await this._initPromise;
    try {
      const blob = this._container.getBlockBlobClient(archiveYdocKey);
      const props = await blob.getProperties();
      const meta = (props && props.metadata) || {};
      return meta.archivedat || meta.archivedAt || null;
    } catch {
      return null;
    }
  }
```

- [ ] **Step 5: Commit**

```bash
git add server/storage-azure.cjs
git commit -m "feat(storage-azure): tenant prefix layout + ACL artifact"
```

---

## Task 5b: Split the composite docName inside the migration broker (BLOCKER — Phase A gate)

**Files:**
- Modify: `server/migrate-pm-substrate.cjs`
- Modify: `server/__tests__/migrate-pm-substrate.test.mjs` (fake-storage signature only — do NOT add a 31st `it()`; this file is at the 30-cap)

The broker's `runMigration` calls `storage.archiveRoom(docName)` at `migrate-pm-substrate.cjs:373`. After Task 2 the base signature is `archiveRoom(tenant, roomId)`, so passing the composite as a single arg archives to `<tenant>/undefined.ydoc` — the room is NOT archived, the four migration-broker assertions in `storage-contract.test.mjs` (the nested `describe`) fail, and at runtime the pre-migration room is silently lost before the v2 mutation. The broker receives the composite docName from the WS upgrade (Task 14) and must split it before any storage call.

- [ ] **Step 1: Add the import** at the top of `migrate-pm-substrate.cjs`:

```javascript
const { splitCompositeDocName } = require('./storage-shared.cjs');
```

- [ ] **Step 2: Split in `runMigration`** (replace the `storage.archiveRoom(docName)` call at line 373):

```javascript
  async function runMigration(docName, ydoc) {
    let archived = false;
    try {
      const { tenant, roomId } = splitCompositeDocName(docName);
      await storage.archiveRoom(tenant, roomId);
      archived = true;
      log.info('migrate.archived', { roomId: docName });
    } catch (err) {
```

(`docName` stays the composite for `inFlight`/`forget`/log keys — only the storage call splits. No other storage call exists in this file.)

- [ ] **Step 3: Update the fake-storage in `migrate-pm-substrate.test.mjs`** so its `archiveRoom` records `(tenant, roomId)` and the existing assertion checks both. Find the fake (search `archiveRoom` / `archiveCalls`) and change the signature to `async archiveRoom(tenant, roomId) { this.archiveCalls.push([tenant, roomId]); }` (or `{ tenant, roomId }`), updating the matching `assert` to expect the split pair (e.g. `['_public', 'room1']` if the test drives the broker with a bare docName, or the composite-split pair the test actually passes). Do NOT add a new `it()` — fold the two-arg assertion into the existing migration test.

- [ ] **Step 4: Run the broker + contract tests**

Run: `node --test server/__tests__/migrate-pm-substrate.test.mjs`
Expected: PASS. (The contract-test broker `describe` is exercised in Task 6.)

- [ ] **Step 5: Commit**

```bash
git add server/migrate-pm-substrate.cjs server/__tests__/migrate-pm-substrate.test.mjs
git commit -m "fix(migrate): split composite docName before storage.archiveRoom in broker"
```

---

## Task 6: Rewrite storage-contract test for composite keys + add ACL round-trip

**Files:**
- Modify: `server/__tests__/storage-contract.test.mjs`

The existing `it()` calls pass a single `roomId`; every storage call must become `(TENANT, roomId)`. Then add ONE new `it()` for the ACL sidecar + crash-order. **Actual count: 17 `it()` (13 shared-contract + 4 in the nested `migration broker` describe) → 18 × 3 backends after the addition** (the spec's "18→19×3" was a miscount; either way it stays well under the 30 cap).

- [ ] **Step 1: Add a tenant constant** near the top of the shared `describe` body and thread it through every `backend.X(...)` call in the contract suite. Use:

```javascript
const T = 'acme'; // tenant for all contract assertions
```

Mechanically update each call: `backend.writeRoom(id, artifacts)` → `backend.writeRoom(T, id, artifacts)`; `readRoom(id)` → `readRoom(T, id)`; `deleteRoom`, `statRoom`, `archiveRoom`, `restoreRoom`, `quarantineRoom`, `deleteArchivedRoom` likewise. `listRooms()` → `listRooms(T)`. `listArchivedRooms()` → `listArchivedRooms(T)` (still returns `[{ id, archivedAt }]`). The migration-broker nested `describe` (line 341) also calls `writeRoom`/`readRoom` — thread `T` there too.

- [ ] **Step 2: Add the ACL round-trip + crash-order test** inside the shared `describe(\`Storage contract: ${name}\`, ...)` block (so it runs × 3 backends):

```javascript
    it('ACL sidecar round-trips via readAcl/writeAcl and is independent of .ydoc', async () => {
      // writeAcl with NO .ydoc → readRoom is still null (partial create = absent)
      await backend.writeAcl(T, 'r-acl', { ownerId: 'u1', sharedWith: ['u2'] });
      assert.equal(await backend.readRoom(T, 'r-acl'), null, 'no .ydoc → room absent (404 semantics)');
      assert.deepEqual(await backend.readAcl(T, 'r-acl'), { ownerId: 'u1', sharedWith: ['u2'] });

      // missing ACL → null
      assert.equal(await backend.readAcl(T, 'no-such'), null);

      // full create: acl THEN ydoc; both readable; deleteRoom removes both
      const Y2 = require('../../node_modules/yjs');
      const doc = new Y2.Doc();
      const ydocBytes = Buffer.from(Y2.encodeStateAsUpdate(doc));
      doc.destroy();
      await backend.writeRoom(T, 'r-full', { ydocBytes, secBytes: null, commentsJson: null });
      await backend.writeAcl(T, 'r-full', { ownerId: 'owner', sharedWith: [] });
      assert.ok(await backend.readRoom(T, 'r-full'));
      assert.deepEqual(await backend.readAcl(T, 'r-full'), { ownerId: 'owner', sharedWith: [] });
      await backend.deleteRoom(T, 'r-full');
      assert.equal(await backend.readAcl(T, 'r-full'), null, 'deleteRoom removes the ACL sidecar');
    });
```

(If `require('../../node_modules/yjs')` differs from the file's existing `Y` import, reuse the file's existing `const Y = require('yjs')` instead — match what's already imported at the top.)

- [ ] **Step 3: Run the storage tests**

Run: `node --test server/__tests__/storage-contract.test.mjs server/__tests__/storage-shared.test.mjs`
Expected: PASS — 19 × 3 contract assertions + the shared-helper tests. If a backend fails parse/list, re-check Tasks 3–5 against the layout table.

- [ ] **Step 4: Fix every backend-specific test broken by the signature + layout change.** This is NOT purely mechanical — budget for it. Two distinct edit classes across SIX files:

  **(a) Mechanical (add a tenant arg):** every `backend.X(roomId, ...)` → `backend.X(T, roomId, ...)`. Affects all six files below.

  **(b) Layout-coupled (rewrite the expected key/path string):** tests that assert on the *raw storage key or filesystem path* must inject the tenant prefix into the expectation — the active layout moved from flat to tenant-namespaced. These are NOT arg additions.

  Files and the layout-coupled hotspots to expect:
  - `server/__tests__/storage-local.test.mjs` — flat-path assertions (`path.join(dir, '<id>.ydoc')`, `readdirSync(dir)`, archive-dir `existsSync`, the `.ydoc.tmp`/`.ydoc.corrupt.<ts>` list-exclusion seeds) must move under `<dir>/<T>/` and `<dir>/archive/<T>/`. The exclusion-seed tests in particular pass *vacuously* if left flat (the new `listRooms(T)` never scans the root), so they MUST be moved or they stop testing anything.
  - `server/__tests__/storage-azure.test.mjs` — ~20 exact blob-key assertions (`'<id>/room.ydoc'`, `'archive/<id>/room.ydoc'`, quarantine keys) → prefix with `<T>/`.
  - `server/__tests__/storage-s3.test.mjs` — exact-key assertions (`'<id>.ydoc'`, catalog-order delete list, quarantine `'<id>.<reason>.ydoc'`, archive keys, pagination input keys) → prefix with `<T>/`.
  - `server/__tests__/storage-azure.integration.test.mjs` — ~35 single-arg calls (Azurite-gated; only runs when Azurite is up, but fix the signatures so it compiles).
  - `server/__tests__/http-endpoints.test.mjs` — seeding `storage.writeRoom(...)` calls (mechanical tenant arg; the auth=none tests seed under `'_public'`).
  - `server/__tests__/migrate-pm-substrate.test.mjs` — already handled in Task 5b.

  Estimate ~40+ layout-coupled assertion edits plus the mechanical arg additions. Do NOT change behavior — only keys/paths/args. After editing, run `npm run test:server` and iterate until green.

Run: `npm run test:server`
Expected: PASS once all six files are updated. Any remaining failure is a missed call site or a not-yet-prefixed expected key.

- [ ] **Step 5: Commit**

```bash
git add server/__tests__/
git commit -m "test(storage): thread tenant through contract suite + ACL round-trip"
```

---

# Phase B — Auth identity

## Task 7: auth-jwt — extract tenant + require a stable subject

**Files:**
- Modify: `server/auth/auth-jwt.cjs`
- Test: `server/__tests__/auth-jwt.test.mjs` (EXISTS — 8 `it()`s, already registered in `test:server`; ADD to it, do not create a new file)

> The existing auth-jwt tests all supply `sub`, so the `id: sub||oid||null` change (dropping the `email`/`'unknown'` fallback) does NOT break them. Append the new tests into a fresh `describe` in that file.

- [ ] **Step 1: Write the failing test**

Add to the existing `server/__tests__/auth-jwt.test.mjs` (it already has `createRequire` + a `jsonwebtoken` import — reuse them; do not redeclare). New `describe`:

```javascript
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const jwt = require('jsonwebtoken');
const { createAuthJwt } = require('../auth-jwt.cjs');

const SECRET = 'test-secret';
const provider = createAuthJwt({ secret: SECRET });
const sign = (claims) => jwt.sign(claims, SECRET, { algorithm: 'HS256' });

describe('auth-jwt tenant + stable subject', () => {
  it('extracts tenant from tenant/org/tid and id from sub/oid', async () => {
    assert.equal((await provider.validateToken(sign({ sub: 's1', tenant: 'acme' }))).tenant, 'acme');
    assert.equal((await provider.validateToken(sign({ sub: 's1', org: 'beta' }))).tenant, 'beta');
    assert.equal((await provider.validateToken(sign({ oid: 'o1', tid: 'azure-t' }))).id, 'o1');
    assert.equal((await provider.validateToken(sign({ oid: 'o1', tid: 'azure-t' }))).tenant, 'azure-t');
  });

  it('does NOT fall back to email/unknown for id (distinct users must not collapse)', async () => {
    const u = await provider.validateToken(sign({ email: 'a@b.com', tenant: 'acme' })); // no sub/oid
    assert.equal(u.id, null, 'id is null without sub/oid');
    assert.equal(u.email, 'a@b.com', 'email still populates display identity');
  });

  it('tenant is null when no tenant/org/tid claim present', async () => {
    assert.equal((await provider.validateToken(sign({ sub: 's1' }))).tenant, null);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test server/__tests__/auth-jwt.test.mjs`
Expected: FAIL — current code returns `id: ...|| email || 'unknown'` and has no `tenant`.

- [ ] **Step 3: Implement** — replace the returned identity object in `auth-jwt.cjs` (lines 22–27):

```javascript
        return {
          // Stable subject ONLY — no email/'unknown' fallback. authorize()
          // rejects a null id under requiresAuth so distinct users can never
          // collapse onto one ownerId.
          id: payload.sub || payload.oid || null,
          tenant: payload.tenant || payload.org || payload.tid || null,
          name: payload.name || payload.preferred_username || payload.email || 'Unknown',
          email: payload.email || null,
          color: payload.color || null,
        };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test server/__tests__/auth-jwt.test.mjs`
Expected: PASS (8 existing + 3 new).

- [ ] **Step 5: Commit**

```bash
git add server/auth/auth-jwt.cjs server/__tests__/auth-jwt.test.mjs
git commit -m "feat(auth): extract tenant claim + require stable subject (no email/unknown id fallback)"
```

---

# Phase C — Authorization core

## Task 8: `authorize()` decision module

**Files:**
- Create: `server/auth/authorize.cjs`
- Test: `server/auth/__tests__/authorize.test.mjs` (create)

- [ ] **Step 1: Write the failing test**

Create `server/auth/__tests__/authorize.test.mjs`:

```javascript
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { authorize, checkPrincipal, ACTION } = require('../authorize.cjs');

const authOn = { requiresAuth: true };
const authOff = { requiresAuth: false };

// Fake storage: ACLs keyed by `${tenant}/${roomId}`.
function fakeStorage(acls) {
  return { async readAcl(tenant, roomId) { return acls[`${tenant}/${roomId}`] || null; } };
}

describe('checkPrincipal', () => {
  it('auth off → always ok', () => {
    assert.deepEqual(checkPrincipal(authOff, null), { ok: true });
  });
  it('auth on: no user → 401; no tenant → 403; no id → 403; sentinel tenant → 403', () => {
    assert.equal(checkPrincipal(authOn, null).status, 401);
    assert.equal(checkPrincipal(authOn, { id: 'u1' }).status, 403);            // no tenant
    assert.equal(checkPrincipal(authOn, { tenant: 'acme' }).status, 403);      // no id
    assert.equal(checkPrincipal(authOn, { id: 'u1', tenant: '_public' }).status, 403); // sentinel
    assert.equal(checkPrincipal(authOn, { id: 'u1', tenant: '../etc' }).status, 403);  // sanitizes to _.. ≠ _public, so OK? see next
    assert.deepEqual(checkPrincipal(authOn, { id: 'u1', tenant: 'acme' }), { ok: true });
  });
});

describe('authorize', () => {
  const storage = fakeStorage({
    'acme/r1': { ownerId: 'owner', sharedWith: ['friend'] },
  });
  const owner = { id: 'owner', tenant: 'acme' };
  const friend = { id: 'friend', tenant: 'acme' };
  const stranger = { id: 'stranger', tenant: 'acme' };
  const otherTenant = { id: 'owner', tenant: 'evilcorp' };

  it('auth off → allow', async () => {
    assert.deepEqual(await authorize({ authProvider: authOff, storage, user: null, roomId: 'r1', action: ACTION.DELETE }), { ok: true });
  });
  it('owner can read + delete + share', async () => {
    for (const a of [ACTION.READ, ACTION.DELETE, ACTION.SHARE, ACTION.LOCK_ADMIN]) {
      assert.deepEqual(await authorize({ authProvider: authOn, storage, user: owner, roomId: 'r1', action: a }), { ok: true }, a);
    }
  });
  it('shared user can read but NOT delete/share', async () => {
    assert.deepEqual(await authorize({ authProvider: authOn, storage, user: friend, roomId: 'r1', action: ACTION.READ }), { ok: true });
    assert.equal((await authorize({ authProvider: authOn, storage, user: friend, roomId: 'r1', action: ACTION.DELETE })).status, 404);
  });
  it('stranger same-tenant → 404 (no existence leak)', async () => {
    assert.equal((await authorize({ authProvider: authOn, storage, user: stranger, roomId: 'r1', action: ACTION.READ })).status, 404);
  });
  it('cross-tenant → 404 structurally (reads ACL under caller tenant, which is absent)', async () => {
    assert.equal((await authorize({ authProvider: authOn, storage, user: otherTenant, roomId: 'r1', action: ACTION.READ })).status, 404);
  });
  it('missing ACL → 404', async () => {
    assert.equal((await authorize({ authProvider: authOn, storage, user: owner, roomId: 'ghost', action: ACTION.READ })).status, 404);
  });
});
```

Note on the `'../etc'` line: `sanitize('../etc')` = `___etc` (each disallowed char → `_`), which is NOT `_public`, so `checkPrincipal` returns ok there — that hostile tenant simply addresses its own sanitized namespace, harmlessly. The assertion above expects ok; fix the test line to `assert.deepEqual(checkPrincipal(authOn, { id: 'u1', tenant: '../etc' }), { ok: true })`.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test server/auth/__tests__/authorize.test.mjs`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `server/auth/authorize.cjs`**

```javascript
/**
 * Room authorization decision function. See ADR-0015 + the design spec
 * (docs/superpowers/specs/2026-06-11-room-authorization-design.md).
 *
 * Returns { ok: true } or { ok: false, status } where status is one of
 * 401 (no token) / 403 (bad principal) / 404 (cross-tenant, not-shared,
 * missing ACL — existence is hidden). Demo (auth=none) early-returns allow.
 */
'use strict';

const { sanitize, PUBLIC_TENANT } = require('../storage-shared.cjs');

const ACTION = Object.freeze({
  READ: 'read',         // open WS, GET /sec, GET /comments, POST /upload, content PATCH
  DELETE: 'delete',
  SHARE: 'share',       // share-grant (PATCH /rooms/:id/share)
  LOCK_ADMIN: 'lock',   // lock fields on PATCH /rooms/:id
});

/**
 * Principal-level checks that need no room: token presence, tenant claim,
 * stable subject, and the _public sentinel reservation. Used directly by
 * routes without a room (GET /rooms) and as the first step of authorize().
 */
function checkPrincipal(authProvider, user) {
  if (!authProvider || !authProvider.requiresAuth) return { ok: true };
  if (!user) return { ok: false, status: 401 };
  if (!user.tenant) return { ok: false, status: 403 };
  if (!user.id) return { ok: false, status: 403 };
  // Sentinel reservation: a token whose tenant sanitizes to _public would
  // address the auth=none demo namespace — a cross-tenant leak. Reject it.
  if (sanitize(user.tenant) === PUBLIC_TENANT) return { ok: false, status: 403 };
  return { ok: true };
}

async function authorize({ authProvider, storage, user, roomId, action }) {
  const pre = checkPrincipal(authProvider, user);
  if (!pre.ok) return pre;
  if (!authProvider || !authProvider.requiresAuth) return { ok: true }; // demo open

  // Cross-tenant is structural: the ACL is read under the CALLER's own tenant,
  // so a caller can only ever resolve rooms in its own namespace.
  // NOTE: user.tenant is passed RAW here — every adapter's _keyForArtifact is
  // the single place sanitize() is applied to tenant, and the WS docName is
  // built from sanitize(user.tenant) too, so the ACL-read key and the bound
  // doc agree (sanitize is idempotent). Do NOT move sanitize out of the
  // adapter, or this read diverges from the docName.
  const acl = await storage.readAcl(user.tenant, roomId);
  if (!acl) return { ok: false, status: 404 };

  const isOwner = acl.ownerId === user.id;
  const isShared = Array.isArray(acl.sharedWith) && acl.sharedWith.includes(user.id);

  if (action === ACTION.READ) {
    return (isOwner || isShared) ? { ok: true } : { ok: false, status: 404 };
  }
  // DELETE / SHARE / LOCK_ADMIN are owner-only.
  return isOwner ? { ok: true } : { ok: false, status: 404 };
}

module.exports = { authorize, checkPrincipal, ACTION };
```

- [ ] **Step 4: Fix the `'../etc'` assertion** in the test (Step 1 note) and run:

Run: `node --test server/auth/__tests__/authorize.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/auth/authorize.cjs server/auth/__tests__/authorize.test.mjs
git commit -m "feat(auth): authorize() decision function with tenant + ACL + 404-not-403"
```

---

# Phase D — HTTP enforcement

## Task 9: Tenant resolution + authorize wiring into `createHttpHandler`

**Files:**
- Modify: `server/http-handler.cjs`

This task adds the shared plumbing (imports, `resolveTenant`, a `denyOrContinue` helper, composite-key derivation) used by Tasks 10–13. No new route behavior lands until the per-route edits, so verify with `npm run test:server` at the end of Task 13.

- [ ] **Step 1: Add imports** at the top of `http-handler.cjs` (after the existing requires):

```javascript
const { authorize, checkPrincipal, ACTION } = require('./auth/authorize.cjs');
const { sanitize, PUBLIC_TENANT, buildCompositeDocName } = require('./storage-shared.cjs');
```

- [ ] **Step 2: Add `resolveTenant` + `composite` helpers** inside `createHttpHandler`, near `getActorId` (after line 71). `resolveTenant` is only valid AFTER `checkPrincipal` has passed (so `req.user.tenant` is present + non-sentinel under auth):

```javascript
  // Tenant for storage keys: the validated token's tenant under auth, else the
  // reserved _public sentinel under auth=none. NEVER derived from body/header.
  function resolveTenant(req) {
    if (authProvider?.requiresAuth) return sanitize(req.user.tenant);
    return PUBLIC_TENANT;
  }

  // Map an authorize()/checkPrincipal() denial to an HTTP response. Returns
  // true if the request was denied (caller should `return`).
  function denied(res, decision) {
    if (decision.ok) return false;
    const map = { 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not found' };
    res.writeHead(decision.status, { 'Content-Type': 'text/plain' });
    res.end(map[decision.status] || 'Error');
    return true;
  }
```

- [ ] **Step 3: Commit** (helpers only, no behavior change yet):

```bash
git add server/http-handler.cjs
git commit -m "feat(http): tenant-resolution + authorize helpers in createHttpHandler"
```

---

## Task 10: Enforce authorize on read/write/delete/patch routes + composite storage keys

**Files:**
- Modify: `server/http-handler.cjs`

Every `/rooms/:id*` route must (a) authorize before acting and (b) call storage with `(tenant, roomId)` and `boundDocs`/`flushRoom`/`migrationCoordinator` with the composite. Edit each route in place.

- [ ] **Step 1: `POST /rooms/:roomId/upload`** (READ action — upload is a content write, gated by READ per spec §5). Inside the `uploadMatch` branch, after `const roomId = uploadMatch[1];`, the work happens in `req.on('end', ...)`. At the very start of that async handler (after `if (aborted) return;`), insert:

```javascript
        const tenant = resolveTenant(req);
        const dec = await authorize({ authProvider, storage, user: req.user, roomId, action: ACTION.READ });
        if (denied(res, dec)) return;
        const composite = buildCompositeDocName(tenant, roomId);
```

Then change `boundDocs.get(roomId)` → `boundDocs.get(composite)`, `readRoomLock(roomId, null)` → `readRoomLock(composite, null)` (see Task 12 for `readRoomLock`'s composite arg), and `flushRoom(roomId)` → `flushRoom(composite)`.

- [ ] **Step 2: `GET /rooms/:roomId/(sec|comments)`** — add authorize + composite storage key. After `const [, roomId, artifact] = dlMatch;`:

```javascript
      const tenant = resolveTenant(req);
      const dec = await authorize({ authProvider, storage, user: req.user, roomId, action: ACTION.READ });
      if (denied(res, dec)) return;
```

Change `storage.readRoom(roomId)` → `storage.readRoom(tenant, roomId)` and the `boundDocs.get(roomId)` (filename lookup) → `boundDocs.get(buildCompositeDocName(tenant, roomId))`.

- [ ] **Step 3: `DELETE /rooms/:roomId`** (DELETE action — owner-only). After `const roomId = deleteMatch[1];`:

```javascript
      const tenant = resolveTenant(req);
      const dec = await authorize({ authProvider, storage, user: req.user, roomId, action: ACTION.DELETE });
      if (denied(res, dec)) return;
      const composite = buildCompositeDocName(tenant, roomId);
```

Change `storage.readRoom(roomId)` → `storage.readRoom(tenant, roomId)`; `readRoomLock(roomId, existing.ydocBytes)` → `readRoomLock(composite, existing.ydocBytes)`; `storage.deleteRoom(roomId)` → `storage.deleteRoom(tenant, roomId)`; `migrationCoordinator.forget(roomId)` → `migrationCoordinator.forget(composite)` (fixes the stale-cache call site noted in the spec).

**Existing-test update (do not skip):** the DELETE-cache regression test in `server/__tests__/http-endpoints.test.mjs` (search `coordCalls` / `forget`) currently asserts `[['forget', 'to-delete']]`. Under auth=none the composite is `_public/to-delete`, so update that assertion to expect `[['forget', '_public/to-delete']]` (or `buildCompositeDocName('_public', 'to-delete')`). This is the one existing auth=none test the composite change is observable in.

- [ ] **Step 4: `PATCH /rooms/:roomId`** — lock fields are LOCK_ADMIN (owner-only); a content/displayName-only PATCH is READ. Gate on the strictest field present. After parsing `body` and before `storage.readRoom`:

```javascript
          const tenant = resolveTenant(req);
          const touchesLock = body.locked !== undefined || body.lockedBy !== undefined || body.lockedByName !== undefined;
          const dec = await authorize({
            authProvider, storage, user: req.user, roomId,
            action: touchesLock ? ACTION.LOCK_ADMIN : ACTION.READ,
          });
          if (denied(res, dec)) return;
          const composite = buildCompositeDocName(tenant, roomId);
```

Change `storage.readRoom(roomId)` → `storage.readRoom(tenant, roomId)`; `readRoomLock(roomId, existing.ydocBytes)` → `readRoomLock(composite, existing.ydocBytes)`; `storage.writeRoom(roomId, {...})` → `storage.writeRoom(tenant, roomId, {...})`; `boundDocs.get(roomId)` → `boundDocs.get(composite)`.

**Body-derived actor (spec §5):** `getActorId(req, url)` falls back to `?actorId=`/`X-Actor-Id`. Under `requiresAuth` the lock actor MUST be the token subject only. In `isLockBlocked` call sites under PATCH/DELETE/upload, when `authProvider?.requiresAuth`, pass `req.user.id` instead of `getActorId(...)`. Add a helper:

```javascript
  function lockActor(req, url) {
    return authProvider?.requiresAuth ? String(req.user.id) : getActorId(req, url);
  }
```

and replace `getActorId(req, url)` with `lockActor(req, url)` in the three lock checks (upload, DELETE, PATCH).

- [ ] **Step 5: Commit**

```bash
git add server/http-handler.cjs
git commit -m "feat(http): authorize + composite keys on sec/comments/upload/DELETE/PATCH"
```

---

## Task 11: `POST /rooms` create — per-tenant key + ACL sidecar before .ydoc; `GET /rooms` tenant filter

**Files:**
- Modify: `server/http-handler.cjs`

- [ ] **Step 1: `POST /rooms`** — write the ACL sidecar (owner = caller) BEFORE the `.ydoc`, keyed under the caller's tenant; the 409-exists check becomes per-tenant. In the `req.on('end', ...)` handler, after computing `id` (the sanitized roomId) and before the existence check, add the principal gate (create needs a valid principal but no room ACL yet):

```javascript
          const pre = checkPrincipal(authProvider, req.user);
          if (denied(res, pre)) return;
          const tenant = resolveTenant(req);
```

**Existence check must cover the ACL too (ownership-hijack fix).** Because the ACL is written before the `.ydoc`, a crash between the two leaves an orphaned ACL with no `.ydoc`. If the 409-exists check only reads `readRoom` (null in that window), a second same-tenant caller could re-create the id and `writeAcl` a NEW owner over the orphan — an ownership takeover, contradicting the spec's "never hijackable" guarantee. Gate on BOTH. Replace the existence check (`const existing = await storage.readRoom(id); if (existing) {...409...}`) with:

```javascript
          const existing = await storage.readRoom(tenant, id);
          const existingAcl = authProvider?.requiresAuth ? await storage.readAcl(tenant, id) : null;
          if (existing || existingAcl) {
            res.writeHead(409, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: `Room "${id}" already exists` }));
            return;
          }
```

(The orphaned-ACL owner can still reclaim the id: their token authorizes `DELETE` via the orphan ACL — `authorize(DELETE)` reads the ACL, sees `ownerId === them`, allows it — `deleteRoom` removes the sidecar, then they re-create cleanly.)

Replace the final write block (current lines 322–327) with:

```javascript
          const ydocBytes = Buffer.from(Y.encodeStateAsUpdate(ydoc));
          ydoc.destroy();

          // Crash-order (ADR-0005 amendment): ACL sidecar FIRST, then .ydoc.
          // A crash between the two leaves the room absent (no .ydoc → 404),
          // never an ownerless/hijackable room.
          if (authProvider?.requiresAuth) {
            await storage.writeAcl(tenant, id, { ownerId: req.user.id, sharedWith: [] });
          }
          await storage.writeRoom(tenant, id, { ydocBytes, secBytes: null, commentsJson: null });
          res.writeHead(201, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ id, ok: true }));
```

(Under auth=none no ACL is written — `_public` rooms have no ACL and `authorize` early-returns allow, so reads still work.)

- [ ] **Step 2: `GET /rooms`** — principal-gate, then list ONLY the caller's tenant, and filter the live `boundDocs` enumeration by composite prefix. Replace the start of the `GET /rooms` branch (after `try {`):

```javascript
      try {
        const pre = checkPrincipal(authProvider, req.user);
        if (denied(res, pre)) return;
        const tenant = resolveTenant(req);
        const roomIds = await storage.listRooms(tenant);
        const Y = require('yjs');
        const rooms = [];
```

Inside the loop, every `boundDocs.get(id)` and `storage.readRoom(id)`/`storage.statRoom(id)` must use the composite / `(tenant, id)`:

```javascript
          const composite = buildCompositeDocName(tenant, id);
          const liveDoc = boundDocs.get(composite);
          // ...
          // fallback read:
          const data = await storage.readRoom(tenant, id);
          // ...
          // stats:
          const stat = await storage.statRoom(tenant, id);
          // ...
          // active users keyed by composite:
          if (typeof getActiveUsers === 'function') entry.activeUsers = getActiveUsers(composite);
```

`storage.listRooms(tenant)` already restricts to the tenant's own rooms, and the per-id composite lookups can only hit that tenant's live docs — so there is no leak via resident docs. The `id` returned to the client stays bare (tenant stripped).

- [ ] **Step 3: Commit**

```bash
git add server/http-handler.cjs
git commit -m "feat(http): per-tenant create+ACL (acl before ydoc) and tenant-filtered GET /rooms"
```

---

## Task 12: Share route + `readRoomLock` composite + `/health` redaction

**Files:**
- Modify: `server/http-handler.cjs`

- [ ] **Step 1: `readRoomLock` takes the composite docName** for its `boundDocs` lookup. Change the signature + the live lookup (lines 35–37):

```javascript
  function readRoomLock(composite, ydocBytes) {
    const live = boundDocs && boundDocs.get(composite);
```

(All call sites in Tasks 10 already pass `composite`.)

- [ ] **Step 2: Add `PATCH /rooms/:roomId/share`** (owner-only; mutates the ACL sidecar via `writeAcl`). Add this route BEFORE the generic `PATCH /rooms/:roomId` branch (so `/share` isn't captured by `/^\/rooms\/([^/]+)$/`):

```javascript
    // PATCH /rooms/:roomId/share — owner-only; add/remove a sharee subject id.
    const shareMatch = url.pathname.match(/^\/rooms\/([^/]+)\/share$/);
    if (shareMatch && req.method === 'PATCH') {
      const roomId = shareMatch[1];
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', async () => {
        try {
          const tenant = resolveTenant(req);
          const dec = await authorize({ authProvider, storage, user: req.user, roomId, action: ACTION.SHARE });
          if (denied(res, dec)) return;

          const body = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
          const userId = body && body.userId;
          const action = body && body.action;
          if (typeof userId !== 'string' || !userId || (action !== 'add' && action !== 'remove')) {
            res.writeHead(400, { 'Content-Type': 'text/plain' });
            res.end('Body must be { userId: string, action: "add" | "remove" }');
            return;
          }

          const acl = await storage.readAcl(tenant, roomId);
          // authorize() already confirmed acl exists + caller is owner.
          const set = new Set(Array.isArray(acl.sharedWith) ? acl.sharedWith : []);
          // Same-tenant is enforced STRUCTURALLY: the room lives under the
          // owner's tenant, so a cross-tenant userId is inert — it can never
          // resolve the room. Store the opaque id as-is (no directory check).
          if (action === 'add') set.add(userId); else set.delete(userId);
          // Never let a sharee entry equal the owner (no-op, keeps shape clean).
          set.delete(acl.ownerId);
          await storage.writeAcl(tenant, roomId, { ownerId: acl.ownerId, sharedWith: [...set] });

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, sharedWith: [...set] }));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end(`Share failed: ${err.message}`);
        }
      });
      return;
    }
```

- [ ] **Step 3: `/health` redaction** — when `requiresAuth`, return counts only (room ids are cross-tenant data). Replace the `unhealthyRooms` build + body (lines 112–135):

```javascript
      const unhealthyRooms = [];
      let unhealthyCount = 0;
      if (roomHealth) {
        for (const [name, h] of roomHealth) {
          if (h.persistFailures >= 3) { unhealthyCount++; unhealthyRooms.push(name); }
        }
      }
      const status = unhealthyCount === 0 ? 'ok' : 'degraded';

      let activeConnections = 0;
      try {
        if (getActiveUsers) {
          for (const id of boundDocs.keys()) activeConnections += getActiveUsers(id).length;
        }
      } catch { /* ignore */ }

      const body = JSON.stringify({
        status,
        uptime: process.uptime(),
        rooms: { active: boundDocs ? boundDocs.size : 0, connections: activeConnections },
        // Redact room names under auth — they are cross-tenant. Counts only.
        ...(authProvider?.requiresAuth ? { unhealthyCount } : { unhealthyRooms }),
      });
      res.writeHead(status === 'ok' ? 200 : 503, { 'Content-Type': 'application/json' });
      res.end(body);
      return;
```

- [ ] **Step 4: Commit**

```bash
git add server/http-handler.cjs
git commit -m "feat(http): owner-only share route, composite readRoomLock, /health name redaction"
```

---

## Task 13: HTTP endpoint tests — cross-tenant + ownership + share

**Files:**
- Modify: `server/__tests__/http-endpoints.test.mjs`

Currently 25 `it()`; cap is 30. Add ≤5, batching where natural. Build a JWT-auth handler in the test via `createAuthJwt`.

- [ ] **Step 1: Add a JWT-auth test harness** near the existing helpers. Reuse the file's `createHttpHandler` import and `LocalStorageBackend`:

> **Scope note:** in this file `LocalStorageBackend`, `createHttpHandler`, etc. are `require`d LOCALLY inside each `before`/`it` block, NOT at module scope. The `createRequire`-based `require` IS module-level (top of file). So `makeAuthServer` must pull its own requires via that module-level `require`.

```javascript
const { createAuthJwt } = require('../auth/auth-jwt.cjs');
const { LocalStorageBackend } = require('../storage-local.cjs');
const { createHttpHandler } = require('../http-handler.cjs');
const jwt = require('jsonwebtoken');
const SECRET = 'http-test-secret';
function bearer(claims) {
  return { Authorization: `Bearer ${jwt.sign(claims, SECRET, { algorithm: 'HS256' })}` };
}
// Spin a handler with auth ON, backed by a temp LocalStorageBackend + boundDocs Map.
function makeAuthServer() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sim-authz-'));
  const storage = new LocalStorageBackend(dir);
  const boundDocs = new Map();
  const handler = createHttpHandler({
    storage, boundDocs,
    flushRoom: async () => {},
    maxDocBytes: 8 * 1024 * 1024,
    authProvider: createAuthJwt({ secret: SECRET }),
    migrationCoordinator: { forget() {} },
  });
  const server = http.createServer(handler);
  return { server, storage, dir, cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} } };
}
```

- [ ] **Step 2: Add the authz tests** in a new `describe('room authorization (auth=jwt)', ...)`. Batch the matrix into a few `it()`s:

```javascript
describe('room authorization (auth=jwt)', () => {
  it('create writes owner ACL; owner reads, strangers + cross-tenant get 404', async () => {
    const h = makeAuthServer();
    await new Promise(r => h.server.listen(0, r));
    const base = `http://127.0.0.1:${h.server.address().port}`;
    try {
      // owner creates room
      let res = await httpJson(`${base}/rooms`, 'POST', { id: 'r1' }, bearer({ sub: 'owner', tenant: 'acme' }));
      assert.equal(res.status, 201);
      assert.deepEqual(await h.storage.readAcl('acme', 'r1'), { ownerId: 'owner', sharedWith: [] });

      // owner DELETE allowed (200); stranger same-tenant 404; cross-tenant 404
      res = await httpJson(`${base}/rooms/r1`, 'DELETE', null, bearer({ sub: 'stranger', tenant: 'acme' }));
      assert.equal(res.status, 404);
      res = await httpJson(`${base}/rooms/r1`, 'DELETE', null, bearer({ sub: 'owner', tenant: 'evil' }));
      assert.equal(res.status, 404);
      res = await httpJson(`${base}/rooms/r1`, 'DELETE', null, bearer({ sub: 'owner', tenant: 'acme' }));
      assert.equal(res.status, 200);
    } finally { h.server.close(); h.cleanup(); }
  });

  it('missing tenant → 403, missing stable subject → 403, hostile tenant cannot escape', async () => {
    const h = makeAuthServer();
    await new Promise(r => h.server.listen(0, r));
    const base = `http://127.0.0.1:${h.server.address().port}`;
    try {
      assert.equal((await httpJson(`${base}/rooms`, 'GET', null, bearer({ sub: 's' }))).status, 403);          // no tenant
      assert.equal((await httpJson(`${base}/rooms`, 'GET', null, bearer({ tenant: 'acme' }))).status, 403);    // no sub/oid
      assert.equal((await httpJson(`${base}/rooms`, 'GET', null, bearer({ sub: 's', tenant: '_public' }))).status, 403); // sentinel
      // hostile tenant '../x' sanitizes to its own namespace; create lands there, not in _public
      const r = await httpJson(`${base}/rooms`, 'POST', { id: 'h' }, bearer({ sub: 's', tenant: '../x' }));
      assert.equal(r.status, 201);
      assert.equal(await h.storage.readAcl('___x', 'h') !== null, true); // sanitize('../x') === '___x'
    } finally { h.server.close(); h.cleanup(); }
  });

  it('share route: owner adds sharee → sharee reads /comments; non-owner share → 404; shared user cannot DELETE', async () => {
    const h = makeAuthServer();
    await new Promise(r => h.server.listen(0, r));
    const base = `http://127.0.0.1:${h.server.address().port}`;
    try {
      await httpJson(`${base}/rooms`, 'POST', { id: 'r1' }, bearer({ sub: 'owner', tenant: 'acme' }));
      // non-owner cannot share
      assert.equal((await httpJson(`${base}/rooms/r1/share`, 'PATCH', { userId: 'x', action: 'add' }, bearer({ sub: 'stranger', tenant: 'acme' }))).status, 404);
      // owner shares with 'friend'
      const s = await httpJson(`${base}/rooms/r1/share`, 'PATCH', { userId: 'friend', action: 'add' }, bearer({ sub: 'owner', tenant: 'acme' }));
      assert.equal(s.status, 200);
      assert.deepEqual((await h.storage.readAcl('acme', 'r1')).sharedWith, ['friend']);
      // friend can read comments (room has no .comments yet → empty list, 200)
      assert.equal((await httpJson(`${base}/rooms/r1/comments`, 'GET', null, bearer({ sub: 'friend', tenant: 'acme' }))).status, 200);
      // friend cannot DELETE (owner-only)
      assert.equal((await httpJson(`${base}/rooms/r1`, 'DELETE', null, bearer({ sub: 'friend', tenant: 'acme' }))).status, 404);
    } finally { h.server.close(); h.cleanup(); }
  });

  it('GET /rooms returns ONLY the caller tenant', async () => {
    const h = makeAuthServer();
    await new Promise(r => h.server.listen(0, r));
    const base = `http://127.0.0.1:${h.server.address().port}`;
    try {
      await httpJson(`${base}/rooms`, 'POST', { id: 'a1' }, bearer({ sub: 'o', tenant: 'acme' }));
      await httpJson(`${base}/rooms`, 'POST', { id: 'b1' }, bearer({ sub: 'o', tenant: 'beta' }));
      const res = await httpJson(`${base}/rooms`, 'GET', null, bearer({ sub: 'o', tenant: 'acme' }));
      const ids = JSON.parse(res.body.toString()).rooms.map(r => r.id);
      assert.deepEqual(ids.sort(), ['a1']);
    } finally { h.server.close(); h.cleanup(); }
  });
});
```

(If `httpJson` does not yet accept a method+headers signature like `httpJson(url, method, body, headers)`, extend the existing helper at the top of the file to forward `extraHeaders` — it already takes `extraHeaders` per the read of lines 53+.)

- [ ] **Step 3: Verify count ≤ 30**

Run: `grep -c "it(" server/__tests__/http-endpoints.test.mjs`
Expected: ≤ 30 (25 + 4 new batched = 29). If at 30, merge two assertions into one `it()`.

- [ ] **Step 4: Run the HTTP + full server suite**

Run: `npm run test:server`
Expected: PASS. Existing auth=none tests still pass (no ACL written, `authorize` early-returns allow). New authz tests pass.

- [ ] **Step 5: Commit**

```bash
git add server/__tests__/http-endpoints.test.mjs
git commit -m "test(http): cross-tenant, ownership, share-route, GET /rooms tenant-filter"
```

---

# Phase E — WS upgrade + composite docName across the relay

## Task 14: Composite docName + WS-upgrade authorize in collab-server

**Files:**
- Modify: `server/collab-server.cjs`

The WS upgrade must build the composite docName from `(token tenant | _public, bareRoomId)`, authorize from the cheap ACL sidecar BEFORE `getYDoc`/preload, and key every in-memory map on the composite. The persistence hooks (`bindState`, `flushRoom`) split the composite back to `(tenant, roomId)` for storage calls.

- [ ] **Step 1: Add imports** (after the existing requires, ~line 42):

```javascript
const { authorize, ACTION } = require('./auth/authorize.cjs');
const { buildCompositeDocName, splitCompositeDocName, PUBLIC_TENANT, sanitize } = require('./storage-shared.cjs');
```

- [ ] **Step 2: Split the composite in `flushRoom`** (storage write). In `flushRoom(docName)` replace `await storage.writeRoom(docName, artifacts);` with:

```javascript
      const { tenant, roomId } = splitCompositeDocName(docName);
      await storage.writeRoom(tenant, roomId, artifacts);
```

- [ ] **Step 3: Split the composite in `bindState`** (storage read + quarantine). In the `loadPromise` IIFE inside `bindState`, replace `const roomData = await storage.readRoom(docName);` with a split and use `(tenant, roomId)` for read + both quarantine calls:

```javascript
          const { tenant, roomId } = splitCompositeDocName(docName);
          const roomData = await storage.readRoom(tenant, roomId);
          // ...
          // both quarantine calls:
          await storage.quarantineRoom(tenant, roomId, 'oversize');
          // ...
          await storage.quarantineRoom(tenant, roomId, 'corrupt');
```

(`docName` stays the composite for `boundDocs.set(docName, ydoc)`, `docLoadPromises`, the `ydoc.on('update')` timer — all map keys remain composite.)

- [ ] **Step 4: Build composite + authorize in the upgrade handler.** In `httpServer.on('upgrade', ...)`, after the rate-limit check, replace the docName + token + user block (current lines 328–340) with:

```javascript
    const bareRoomId = extractDocName(req.url);

    const tokenMatch = (req.url || '').match(/[?&]token=([^&]*)/);
    const token = tokenMatch ? decodeURIComponent(tokenMatch[1]) : null;

    let user = null;
    if (authProvider.requiresAuth) {
      if (!token) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return; }
      user = await authProvider.validateToken(token);
      if (!user) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return; }
    } else if (token) {
      user = await authProvider.validateToken(token);
    }

    // Authorize from the cheap ACL sidecar BEFORE any doc load — an
    // unauthorized caller never triggers getYDoc/preload, sidestepping the
    // eviction-guard await windows (ADR-0014 pattern #2). Unconditional: never
    // skipped because the doc is already resident (live-session revocation).
    const dec = await authorize({ authProvider, storage, user, roomId: bareRoomId, action: ACTION.READ });
    if (!dec.ok) {
      const line = { 401: '401 Unauthorized', 403: '403 Forbidden', 404: '404 Not Found' }[dec.status] || '403 Forbidden';
      socket.write(`HTTP/1.1 ${line}\r\n\r\n`);
      socket.destroy();
      return;
    }

    // Composite docName keys ALL in-memory maps + the migration coordinator.
    const tenant = authProvider.requiresAuth ? sanitize(user.tenant) : PUBLIC_TENANT;
    const docName = buildCompositeDocName(tenant, bareRoomId);
```

The rest of the handler (`getYDoc(docName, true)`, eviction guard `ywsDocs.get(docName)`, `migrationCoordinator.ensureMigrated(docName, doc)`, `setupWSConnection(conn, req, { docName, gc: true })`) is unchanged — `docName` is now the composite and threads through correctly.

- [ ] **Step 5: Commit**

```bash
git add server/collab-server.cjs
git commit -m "feat(collab): composite docName + WS-upgrade authorize before doc load"
```

---

## Task 15: Sweep across all tenants

**Files:**
- Modify: `server/collab-server.cjs`

`sweepRooms` (in `startFromEnv`) iterates `storage.listRooms()` (now requires a tenant) and `storage.statRoom(id)` / `archiveRoom(id)` / `listArchivedRooms()` / `deleteArchivedRoom(id)`. Switch it to the cross-tenant helpers.

- [ ] **Step 1: Rewrite the archive pass** (lines 552–567):

```javascript
    try {
      const rooms = await storage.listAllRooms(); // [{ tenant, roomId }]
      for (const { tenant, roomId } of rooms) {
        const composite = buildCompositeDocName(tenant, roomId);
        if (server.boundDocs.has(composite)) continue;
        const stat = await storage.statRoom(tenant, roomId);
        if (!stat || !stat.lastModified) continue;
        const idleMs = now - new Date(stat.lastModified).getTime();
        const idleDays = idleMs / (24 * 60 * 60 * 1000);
        if (idleDays >= ARCHIVE_DAYS) {
          log.info('sweep.archive', { roomId: composite, idleDays: Math.round(idleDays) });
          await storage.archiveRoom(tenant, roomId);
        }
      }
    } catch (err) {
      log.error('sweep.archive.failed', { err: err.message });
    }
```

- [ ] **Step 2: Rewrite the delete pass** (lines 568–583):

```javascript
    try {
      if (typeof storage.listAllArchivedRooms === 'function') {
        const archived = await storage.listAllArchivedRooms(); // [{ tenant, roomId, archivedAt }]
        for (const { tenant, roomId, archivedAt } of archived) {
          if (!archivedAt) continue;
          const archivedDays = (now - new Date(archivedAt).getTime()) / (24 * 60 * 60 * 1000);
          if (archivedDays >= DELETE_DAYS) {
            log.info('sweep.delete', { roomId: buildCompositeDocName(tenant, roomId), archivedDays: Math.round(archivedDays) });
            await storage.deleteArchivedRoom(tenant, roomId);
          }
        }
      }
    } catch (err) {
      log.error('sweep.delete.failed', { err: err.message });
    }
```

- [ ] **Step 3: Commit**

```bash
git add server/collab-server.cjs
git commit -m "feat(collab): room sweep iterates all tenants via listAllRooms"
```

---

## Task 16: Collab-server WS authz + composite-key tests

**Files:**
- Modify: `server/__tests__/collab-server.test.mjs`

Add WS-upgrade authz assertions. Verify the existing eviction-guard / preload tests still pass with the new pre-load authorize read. Respect the file's test-count discipline (batch into existing `describe`s).

- [ ] **Step 1: Inspect the file's harness** (how it constructs `createCollabServer`, connects a `WebsocketProvider` or raw `ws`, and how it injects `authProvider`/`migrationCoordinator`). Match that style — do NOT introduce a new harness shape.

Run: `grep -n "createCollabServer\|authProvider\|new WebSocket\|WebsocketProvider\|migrationCoordinator" server/__tests__/collab-server.test.mjs`

- [ ] **Step 2: Add a WS-authz `describe`** that boots a server with `authProvider: createAuthJwt({ secret })` and a `LocalStorageBackend` in a temp dir, seeds an ACL via `storage.writeAcl('acme', 'r1', { ownerId: 'owner', sharedWith: [] })` + a `.ydoc` via `storage.writeRoom('acme','r1', { ydocBytes, secBytes:null, commentsJson:null })`, then attempts upgrades.

**Use a RAW `ws` client, NOT `WebsocketProvider`.** `WebsocketProvider` swallows the upgrade HTTP status (it just retries on close), so it cannot distinguish 401 vs 404. `ws` is already imported in this file (`const WS = require('ws')` or similar — match the existing import). A raw socket surfaces the rejection status via the `'unexpected-response'` event:

```javascript
// Helper: resolve to { status } on a rejected upgrade, or { open: true } on success.
function tryUpgrade(port, room, token) {
  const url = `ws://127.0.0.1:${port}/${room}${token ? `?token=${token}` : ''}`;
  const sock = new WS(url); // WS = the file's existing ws import
  return new Promise((resolve) => {
    sock.on('unexpected-response', (_req, res) => { sock.terminate(); resolve({ status: res.statusCode }); });
    sock.on('open', () => { sock.close(); resolve({ open: true }); });
    sock.on('error', () => resolve({ status: 'error' })); // some rejections surface as error
  });
}

// 1. No token                         → { status: 401 }
// 2. tenant=acme, sub=stranger        → { status: 404 }
// 3. tenant=evil,  sub=owner          → { status: 404 } (cross-tenant structural)
// 4. tenant=acme,  sub=owner          → { open: true }; then assert boundDocs has 'acme/r1'
```

For case 4, after `open` give the bind a tick, then assert `server.boundDocs.has('acme/r1') === true` — this pins the composite-keying invariant. Mint tokens with `jwt.sign({ sub, tenant }, secret, { algorithm: 'HS256' })`.

- [ ] **Step 3: Confirm the eviction-guard + preload race tests still pass.** Those tests run with `authProvider` defaulting to auth=none (no token), so `authorize` early-returns allow and the docName is `_public/<id>`. If a test asserts `boundDocs.has('<bareId>')`, update it to the composite `_public/<bareId>` (or `buildCompositeDocName('_public', bareId)`). This is the one place the composite change is observable in existing tests.

- [ ] **Step 4: Run the collab-server suite**

Run: `node --test server/__tests__/collab-server.test.mjs`
Expected: PASS — new authz rejections + the deterministic stale-closeConn race tests (now keyed on composite docNames).

- [ ] **Step 5: Run the full server suite**

Run: `npm run test:server`
Expected: PASS across all server tests.

- [ ] **Step 6: Commit**

```bash
git add server/__tests__/collab-server.test.mjs
git commit -m "test(collab): WS-upgrade authz rejection + composite-key invariants"
```

---

# Phase F — Legacy migration + documentation

## Task 17: One-time tenant-namespace migration script

**Files:**
- Create: `server/migrate-tenant-namespace.cjs`
- Test: `server/__tests__/migrate-tenant-namespace.test.mjs` (create)

Relocates pre-existing FLAT artifacts (`<id>.<ext>` local / `<id>.<ext>` S3 / `<id>/room.<ext>` Azure WITHOUT a tenant prefix) under `<SIM_DEFAULT_TENANT>/<id>` and writes an ACL sidecar `{ ownerId: SIM_DEFAULT_OWNER, sharedWith: [] }`. Gated by both env vars. For `auth=none` demos, set `SIM_DEFAULT_TENANT=_public` and any owner (ACL is inert under auth=none, but the relocation under `_public/` is required so WS + HTTP agree on the composite key).

- [ ] **Step 1: Write the failing test** (local backend — the documented default + demo shape):

Create `server/__tests__/migrate-tenant-namespace.test.mjs`:

```javascript
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
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test server/__tests__/migrate-tenant-namespace.test.mjs`
Expected: FAIL — module/function does not exist.

- [ ] **Step 3: Implement `server/migrate-tenant-namespace.cjs`**

```javascript
#!/usr/bin/env node
/**
 * One-time migration: relocate pre-tenant FLAT room artifacts under a tenant
 * namespace + write an ACL sidecar. See ADR-0015 and the design spec.
 *
 * Run once when turning auth ON for a deploy that has pre-existing rooms, OR
 * for an auth=none demo whose rooms predate the composite-key scheme (use
 * SIM_DEFAULT_TENANT=_public). Idempotent: a room already under a tenant
 * prefix is skipped.
 *
 *   SIM_DEFAULT_TENANT=<tenant> SIM_DEFAULT_OWNER=<sub> \
 *     node server/migrate-tenant-namespace.cjs
 *
 * CJS on purpose (see ADR-0001).
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { sanitize } = require('./storage-shared.cjs');

// Flat-layout extensions (pre-tenant local naming). '.acl.json' is NOT a
// legacy artifact — skip it if somehow present.
const FLAT_EXTS = ['.ydoc', '.SEC', '.comments.json', '.lint.json'];

/**
 * Move every flat `<dir>/<id><ext>` to `<dir>/<tenant>/<id><ext>` and write
 * `<dir>/<tenant>/<id>.acl.json`. Returns the count of distinct rooms moved.
 */
async function migrateLocalFlatToTenant({ dir, tenant, owner }) {
  const t = sanitize(tenant);
  if (!fs.existsSync(dir)) return 0;
  const tenantDir = path.join(dir, t);

  // Distinct room ids that have a flat .ydoc at the top level.
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const roomIds = new Set();
  for (const e of entries) {
    if (!e.isFile()) continue;            // tenant subdirs + 'archive' are dirs — skip
    if (e.name.endsWith('.ydoc') && !e.name.includes('.ydoc.')) {
      roomIds.add(e.name.slice(0, -'.ydoc'.length));
    }
  }
  if (roomIds.size === 0) return 0;

  fs.mkdirSync(tenantDir, { recursive: true });
  let moved = 0;
  for (const id of roomIds) {
    const safe = sanitize(id);
    for (const ext of FLAT_EXTS) {
      const src = path.join(dir, `${id}${ext}`);
      if (!fs.existsSync(src)) continue;
      fs.renameSync(src, path.join(tenantDir, `${safe}${ext}`));
    }
    // ACL sidecar (acl-before-ydoc invariant is irrelevant here — the .ydoc
    // already exists from the rename above).
    fs.writeFileSync(
      path.join(tenantDir, `${safe}.acl.json`),
      JSON.stringify({ ownerId: owner, sharedWith: [] }),
      'utf-8',
    );
    moved++;
  }
  return moved;
}

async function runFromEnv() {
  const tenant = process.env.SIM_DEFAULT_TENANT;
  const owner = process.env.SIM_DEFAULT_OWNER;
  if (!tenant || !owner) {
    throw new Error('migrate-tenant-namespace requires SIM_DEFAULT_TENANT and SIM_DEFAULT_OWNER');
  }
  const backend = (process.env.SIM_STORAGE_BACKEND || 'local').toLowerCase();
  if (backend !== 'local') {
    // S3/Azure relocation follows the same shape (list flat keys, copy under
    // <tenant>/ prefix, put .acl.json, delete originals) but is left as an
    // operator-run follow-up; local is the documented default + demo backend.
    throw new Error(`migrate-tenant-namespace: backend '${backend}' not yet supported by this script — see ADR-0015`);
  }
  const dir = path.resolve(process.cwd(), process.env.SIM_LOCAL_STORAGE_DIR || 'server/collab-db');
  const moved = await migrateLocalFlatToTenant({ dir, tenant, owner });
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ migrated: moved, tenant: sanitize(tenant), dir }));
}

module.exports = { migrateLocalFlatToTenant, runFromEnv };

if (require.main === module) {
  runFromEnv().catch(err => { console.error(err.message); process.exit(1); });
}
```

(S3/Azure relocation is explicitly scoped out of this script per the spec's "Legacy" section — production R2 deployments either start fresh under the new scheme or run an operator script following the documented shape. ADR-0015 records this.)

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test server/__tests__/migrate-tenant-namespace.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/migrate-tenant-namespace.cjs server/__tests__/migrate-tenant-namespace.test.mjs
git commit -m "feat(server): one-time tenant-namespace migration (local backend)"
```

---

## Task 18: New ADR-0015 — room authorization model

**Files:**
- Create: `docs/adr/0015-room-authorization-model.md`

- [ ] **Step 1: Write the ADR.** Use the repo's existing ADR format (open one of `docs/adr/0013-*.md` / `0014-*.md` first to match the heading/section style). Content must record, in the project's voice:

```markdown
# ADR-0015: Room authorization model — multi-tenant isolation + private-by-default

## Status
Accepted (2026-06-11). Implements issue #211. Graded roles deferred to #239.

## Context
With SIM_AUTH_PROVIDER=jwt the collab server authenticated but did not
authorize: any valid token reached any room. The public Render demo
(auth=none) is intentionally open with no CUI; this ADR targets a real
production (SaaS, many orgs, private-by-default within an org).

## Decision
1. **One always-namespaced composite room key (tenant, roomId).** Internal
   docName = `<tenant>/<roomId>`; storage adapters take (tenant, roomId, kind).
   Under auth=none everything runs under a reserved `_public` sentinel tenant
   — no flat-vs-prefixed fork.
2. **`_public` sentinel reservation.** A token whose tenant sanitizes to
   `_public` is rejected (403) under requiresAuth, so the demo namespace is
   reachable only via the auth=none path.
3. **ACL sidecar artifact** `<tenant>/<roomId>.acl.json` =
   `{ ownerId, sharedWith[] }`, NOT stored in yMeta (avoids the yMeta.size===0
   seed-gate break and a per-request multi-MB decode). Read cheaply before any
   doc load.
4. **Crash-order: `.acl.json` BEFORE `.ydoc`** in ARTIFACT_CATALOG. A crash
   between writes leaves the room absent (404), never ownerless/hijackable.
5. **authorize(user, tenant, roomId, action).** read = owner OR shared;
   delete/share/lock-admin = owner only; gated on requiresAuth (demo open);
   missing tenant/stable-subject/sentinel → 403; not-owner/not-shared/missing
   ACL → 404 (no existence leak). Runs on every /rooms* route AND at WS upgrade,
   before getYDoc.
6. **Required JWT claims:** a tenant claim (tenant|org|tid) and a stable subject
   (sub|oid). No email/'unknown' fallback for the owner id.
7. **Binary collaborator model** (owner + share-set). Graded viewer/editor/owner
   is #239.

## Consequences
- **Live-session revocation limitation:** authorize runs at every WS upgrade
  (unconditional), so share-removal takes effect on the sharee's NEXT connect;
  an already-open session is not force-disconnected. Accepted.
- **Share discovery limitation:** no user-directory endpoint; an owner must
  know the sharee's subject id. Share-by-email is a follow-up.
- **Legacy:** auth-on deploys with pre-existing rooms either start fresh or run
  server/migrate-tenant-namespace.cjs (SIM_DEFAULT_TENANT + SIM_DEFAULT_OWNER).
  The script supports the local backend; S3/Azure relocation follows the same
  shape as an operator-run follow-up.
- **Demo unchanged:** auth=none runs under `_public`, authorize is inert.

## Cross-references
ADR-0005 (acl write-order amendment), ADR-0013 (artifact + composite key),
ADR-0014 (composite docName + WS authz ordering), #239 (graded roles).
```

- [ ] **Step 2: Commit**

```bash
git add docs/adr/0015-room-authorization-model.md
git commit -m "docs(adr): ADR-0015 room authorization model"
```

---

## Task 19: Register new test files + amend ADR-0005 / ADR-0013 / ADR-0014 + CLAUDE.md

**Files:**
- Modify: `package.json`
- Modify: `docs/adr/0005-storage-adapter-atomicity-per-backend.md`
- Modify: `docs/adr/0013-storage-backends.md`
- Modify: `docs/adr/0014-collab-server-yjs-relay.md`
- Modify: `CLAUDE.md`

- [ ] **Step 0: Register the new test files in `test:server` (CRITICAL — `test:server` is an explicit file list, NOT a glob).** Open `package.json`, find the `"test:server"` script (a `node --test --test-force-exit <space-separated file list>`), and append the three NEW test files so CI actually runs them:
  - `server/__tests__/storage-shared.test.mjs` (Task 1)
  - `server/auth/__tests__/authorize.test.mjs` (Task 8)
  - `server/__tests__/migrate-tenant-namespace.test.mjs` (Task 17)

  (`server/__tests__/auth-jwt.test.mjs` is already listed — Task 7 added to it, not a new file. `storage-shared`/`authorize`/`migrate-tenant-namespace` are new and must be added or every `npm run test:server` gate silently skips them.)

- [ ] **Step 1: Amend ADR-0005.** Add a section recording the `.acl.json` write-order (positioned before `.ydoc` in ARTIFACT_CATALOG) and the crash-consistency outcome (partial create = absent, never ownerless). Also reconcile the stale "12 assertions × 3 backends" consequence text with the actual count after this change (19 × 3 — the contract suite gained the ACL round-trip test). Quote the exact line being corrected so the diff is reviewable.

- [ ] **Step 2: Amend ADR-0013.** Document the new `.acl.json` artifact and the composite `(tenant, roomId)` key scheme, including the three per-backend tenant-list shapes (local readdir subdirs; S3/Azure flat-parse via base `listAllRooms`; local overrides `listAllRooms`/`listAllArchivedRooms`/`_listTenants`/`_listArchivedTenants`).

- [ ] **Step 3: Amend ADR-0014.** Document the composite docName across the five in-memory maps + migration coordinator, and the WS-upgrade authorization ordering: authorize from the cheap ACL sidecar BEFORE getYDoc/preload, so the eviction-guard await windows (pattern #2) are never reached by an unauthorized caller. Note `migrationCoordinator.forget(composite)` now takes the composite.

- [ ] **Step 4: Update CLAUDE.md.** In the "Collab Publish Path" / "Collaboration Server" / "Storage Backends" sections, add brief notes: composite `(tenant, roomId)` key, `.acl.json` sidecar + `readAcl`/`writeAcl`, `authorize()` at both gates, `_public` sentinel under auth=none, required JWT claims (tenant + stable subject). Keep it terse — these are pointers to ADR-0015, not a re-explanation.

- [ ] **Step 5: Commit**

```bash
git add package.json docs/adr/0005-storage-adapter-atomicity-per-backend.md docs/adr/0013-storage-backends.md docs/adr/0014-collab-server-yjs-relay.md CLAUDE.md
git commit -m "chore: register authz tests + amend ADR-0005/0013/0014 + CLAUDE.md"
```

---

# Final verification

- [ ] **Run the full server suite:** `npm run test:server` → all green.
- [ ] **Run the storage + auth unit tests explicitly:** `node --test server/__tests__/storage-shared.test.mjs server/__tests__/storage-contract.test.mjs server/__tests__/auth-jwt.test.mjs server/auth/__tests__/authorize.test.mjs server/__tests__/migrate-tenant-namespace.test.mjs`
- [ ] **E2E smoke (auth=none must still be fully open):** the E2E suite runs against `SIM_AUTH_PROVIDER=none`. Run the collab E2E to confirm `_public`-namespaced rooms work end-to-end: `npm run test:e2e -- --project=chromium collab.spec.js`. Expect the baseline flake set ([#194](https://github.com/mttvnst-HA/secwriter/issues/194)) only — re-run any failure in isolation to distinguish flake from regression (CLAUDE.md rule #10).
- [ ] **Manual auth=on smoke (optional but recommended):** start the server with `SIM_AUTH_PROVIDER=jwt SIM_AUTH_JWT_SECRET=dev`, mint two tokens with different `tenant` claims, confirm cross-tenant `GET /rooms/:id/sec` returns 404 and same-owner returns 200.

---

# Self-review notes (plan authoring + 3 independent review passes applied)

- **Spec coverage:** keystone composite key (Tasks 1–6, 14), `_public` sentinel + reservation (Tasks 1, 8, 14), ACL sidecar + readAcl/writeAcl + crash-order (Tasks 1, 2, 6, 11), auth-jwt tenant + stable subject (Task 7), authorize() with all six error cases (Task 8), all enforcement points — sec/comments/upload/DELETE/PATCH/share/GET-rooms/WS/health (Tasks 10–13, 14), body-derived-actor fix (Task 10), per-backend tenant-list (Tasks 2–5), migration broker composite split (Task 5b), migration coordinator forget(composite) (Task 10), sweep across tenants (Task 15), legacy migration (Task 17), test-runner registration + four ADR doc actions (Tasks 18–19). Test-count caps verified: http-endpoints 25→29 (≤30), storage-contract 17→18×3, migrate-pm-substrate untouched (at 30-cap).

- **Review fixes folded in (3 independent passes):**
  - *Blocker* — migration broker `archiveRoom(docName)` was never split → added **Task 5b** (broker splits the composite before storage; fixes the Phase A gate + a runtime mis-archive).
  - *Blocker* — `POST /rooms` 409 now checks `readAcl` AND `readRoom`, closing an orphaned-ACL ownership-hijack window (Task 11).
  - *Major* — new test files registered in `test:server` (Task 19 Step 0); `test:server` is an explicit file list, not a glob.
  - *Major* — auth-jwt tests append to the EXISTING `server/__tests__/auth-jwt.test.mjs` (Task 7), not a new path.
  - *Major* — existing DELETE-cache test expectation updated to the composite key (Task 10).
  - *Major* — Task 16 specifies a raw `ws` client for upgrade-rejection status (WebsocketProvider can't see it).
  - *Major* — Task 6 Step 4 rewritten: 6 affected backend-test files, ~40 layout-coupled assertion edits (not "mechanical").
  - *Minors* — dropped dead `compositeFor` helper; `makeAuthServer` requires added; sanitize-locality comment in authorize.cjs; corrected storage-contract count.

- **Deferred correctly:** graded roles (#239), share-by-email/directory, live-session force-revocation, IdP token issuance — all out of scope per spec, none implemented here.

- **Accepted limitations (documented, not bugs):** share-route lost-update under two concurrent owner edits (both writers are the authorized owner — no privilege boundary crossed; last-writer-wins, acceptable for the floor); live-session revocation takes effect on next connect.

- **Known approximation:** the migration script (Task 17) implements the local backend only; S3/Azure relocation is documented as an operator follow-up (spec "Legacy" allows auth-on deploys to start fresh — so the R2 production target starts fresh under the new scheme). Flagged in ADR-0015 and the script's error message — not a silent cap.
