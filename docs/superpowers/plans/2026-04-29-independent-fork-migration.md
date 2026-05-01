# Independent Fork Migration: haleyaldrich/secwriter → mttvnst-HA/secwriter

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create an independent fork of secwriter under `mttvnst-HA/secwriter`, strip Azure-coupled deploy artifacts, replace the Azure Blob storage backend with an S3-compatible backend (Cloudflare R2), and bring up a fresh Render deployment that has zero dependency on the haleyaldrich Azure tenant or sysadmin.

**Architecture:**
- Mirror clone (`git clone --bare` + `git push --mirror`) preserves full git history without a GitHub fork relationship.
- New `server/storage-s3.cjs` implements the same interface as `storage-azure.cjs` and `storage-local.cjs` (writeRoom / readRoom / deleteRoom / listRooms / quarantineRoom / archiveRoom / restoreRoom / listArchivedRooms / deleteArchivedRoom / statRoom). `SIM_STORAGE_BACKEND=s3` selects it. Uses `@aws-sdk/client-s3` against Cloudflare R2 (free 10 GB tier, S3-compatible, no egress fees).
- Render Blueprint provisions both `secwriter-collab` (Node web service) and `secwriter-frontend` (static site) from `render.yaml`.
- Source repo `haleyaldrich/secwriter` is left untouched. All cleanup happens on the new repo.

**Tech Stack:** Node 20, `@aws-sdk/client-s3` v3, `aws-sdk-client-mock` (unit testing), Cloudflare R2, Render, Yjs, y-websocket.

---

## Phase 1: Mirror clone to mttvnst-HA/secwriter

### Task 1: Create empty target repo

**Files:** none (GitHub UI / `gh` CLI)

- [ ] **Step 1: Verify GitHub auth and org existence**

```bash
gh auth status
gh api orgs/mttvnst-HA 2>&1 | head -1
```

Expected: auth status shows authenticated user; org returns JSON (not 404). If org doesn't exist, create it via [github.com/organizations/new](https://github.com/organizations/new) (free) before proceeding.

- [ ] **Step 2: Create empty repo (no README, no .gitignore, no license)**

```bash
gh repo create mttvnst-HA/secwriter \
  --private \
  --description "SecWriter — UFGS .SEC editor (independent fork)"
```

Expected: prints `https://github.com/mttvnst-HA/secwriter`. **Do not** initialize with README/license — those create commits that conflict with `--mirror`.

### Task 2: Mirror push from haleyaldrich/secwriter

**Files:** none (temp directory)

- [ ] **Step 1: Bare clone source**

```bash
mkdir -p /c/tmp-mirror && cd /c/tmp-mirror
git clone --bare https://github.com/haleyaldrich/secwriter.git
cd secwriter.git
```

Expected: ~50 MB clone, no working tree.

- [ ] **Step 2: Mirror push**

```bash
git push --mirror https://github.com/mttvnst-HA/secwriter.git
```

Expected: pushes `main` and any feature branches + tags. No errors.

- [ ] **Step 3: Verify mirror**

```bash
gh repo view mttvnst-HA/secwriter --json defaultBranchRef,pushedAt
```

Expected: `defaultBranchRef.name = "main"`, recent `pushedAt`. Browse to the repo page in a browser and confirm the latest commit matches `af78daa` (the postcss/uuid fix from earlier today).

- [ ] **Step 4: Clean up bare clone**

```bash
cd /c/tmp-mirror && rm -rf secwriter.git
```

### Task 3: Create local working clone

**Files:** none

- [ ] **Step 1: Clone for local development**

```bash
cd /c/github
git clone https://github.com/mttvnst-HA/secwriter.git secwriter-mttvnst
cd secwriter-mttvnst
```

- [ ] **Step 2: Sanity check — install + build**

```bash
npm ci
npm run build
```

Expected: `npm ci` installs ~232 packages, `npm run build` completes in ~2-3s.

- [ ] **Step 3: Sanity check — server tests**

```bash
npm run test:server
```

Expected: 55 server tests pass.

---

## Phase 2: Strip Azure-coupled deploy artifacts

All work in this phase happens in `/c/github/secwriter-mttvnst`. We do everything via PRs against `main` so the repo's git history shows clean intent.

### Task 4: Branch off main

- [ ] **Step 1: Create feature branch**

```bash
git checkout main
git pull
git checkout -b chore/strip-azure-deploy
```

### Task 5: Delete Azure App Service workflow

**Files:**
- Delete: `.github/workflows/main_asp-app-specsintact-modern.yml`

- [ ] **Step 1: Delete the file**

```bash
git rm .github/workflows/main_asp-app-specsintact-modern.yml
```

- [ ] **Step 2: Verify ci.yml and collab-server-deploy.yml remain (the latter deleted next task)**

```bash
ls .github/workflows/
```

Expected: `ci.yml` and `collab-server-deploy.yml` listed; the deleted file is gone.

### Task 6: Delete Azure Container Apps workflow

**Files:**
- Delete: `.github/workflows/collab-server-deploy.yml`

- [ ] **Step 1: Delete the file**

```bash
git rm .github/workflows/collab-server-deploy.yml
```

- [ ] **Step 2: Confirm only `ci.yml` remains**

```bash
ls .github/workflows/
```

Expected: `ci.yml` (only).

### Task 7: Delete Azure deploy docs and update deploy/README.md

**Files:**
- Delete: `deploy/AZURE-DEPLOYMENT.md`
- Delete: `deploy/AZURE-SYSADMIN-CHECKLIST.md`
- Modify: `deploy/README.md`

- [ ] **Step 1: Inspect deploy/README.md for references to deleted docs**

```bash
cat deploy/README.md
```

Note any lines that reference `AZURE-DEPLOYMENT.md` or `AZURE-SYSADMIN-CHECKLIST.md` — these need to be removed.

- [ ] **Step 2: Delete the Azure docs**

```bash
git rm deploy/AZURE-DEPLOYMENT.md
git rm deploy/AZURE-SYSADMIN-CHECKLIST.md
```

- [ ] **Step 3: Edit deploy/README.md**

Use the Edit tool to remove every line that links to or describes the two deleted files. The remaining file should describe only the contents that survive (`Caddyfile`, `nginx.conf` reference configs) and point to `render.yaml` as the canonical deploy doc. If the README becomes essentially empty after edits, replace its content with a 5-line stub:

```markdown
# Deploy reference configs

This folder contains reference configurations for self-hosting the SecWriter collab server behind a reverse proxy:

- `Caddyfile` — Caddy reverse proxy with WebSocket upgrade
- `nginx.conf` — nginx with WebSocket upgrade

For Render-based hosting (recommended), see [`../render.yaml`](../render.yaml).
```

### Task 8: Verify CI passes locally before pushing

- [ ] **Step 1: Run all unit tests**

```bash
npm test
```

Expected: 630+ tests pass.

- [ ] **Step 2: Run compliance tests**

```bash
npm run test:compliance
```

Expected: 42 tests pass.

- [ ] **Step 3: Run server tests**

```bash
npm run test:server
```

Expected: 55 tests pass.

### Task 9: PR + merge

- [ ] **Step 1: Stage and commit**

```bash
git add deploy/README.md
git commit -m "chore(deploy): strip Azure-coupled deploy artifacts

- Remove .github/workflows/main_asp-app-specsintact-modern.yml
  (Azure App Service deploy, sysadmin-coupled publish profile)
- Remove .github/workflows/collab-server-deploy.yml
  (Azure Container Apps deploy, sysadmin-coupled OIDC + ACR)
- Remove deploy/AZURE-DEPLOYMENT.md, deploy/AZURE-SYSADMIN-CHECKLIST.md
- Reduce deploy/README.md to reference Render + reverse-proxy configs

This fork uses Render hosting + Cloudflare R2 storage instead of the
sysadmin-controlled Azure tenant."
```

- [ ] **Step 2: Push branch**

```bash
git push -u origin chore/strip-azure-deploy
```

- [ ] **Step 3: Open PR**

```bash
gh pr create --title "chore(deploy): strip Azure-coupled deploy artifacts" --body "$(cat <<'EOF'
## Summary
- Delete Azure App Service workflow (sysadmin-coupled publish profile secret)
- Delete Azure Container Apps workflow (sysadmin-coupled OIDC + ACR)
- Delete deploy/AZURE-*.md docs
- Trim deploy/README.md

## Why
This fork moves to Render hosting + Cloudflare R2 storage to escape the
sysadmin-controlled Azure tenant. The Azure workflows would never run
successfully on the new fork (their secrets don't exist).

## Test plan
- [x] `npm test`, `npm run test:compliance`, `npm run test:server` pass locally
- [ ] CI (`Unit & Compliance Tests`, Azure Integration via Azurite, Playwright E2E) green on this PR
EOF
)"
```

- [ ] **Step 4: Wait for CI**

```bash
gh pr checks --watch
```

Expected: all checks green. (Note: branch protection isn't set yet, so we *could* push directly. Doing it via PR establishes the clean-history pattern early.)

- [ ] **Step 5: Merge**

```bash
gh pr merge --squash --delete-branch
git checkout main
git pull
```

---

## Phase 3: Configure new repo settings

### Task 10: Apply branch protection on main

- [ ] **Step 1: Apply protection rule**

```bash
gh api -X PUT repos/mttvnst-HA/secwriter/branches/main/protection \
  --input - <<'EOF'
{
  "required_status_checks": {
    "strict": true,
    "contexts": ["Unit & Compliance Tests"]
  },
  "enforce_admins": false,
  "required_pull_request_reviews": {
    "required_approving_review_count": 0
  },
  "restrictions": null
}
EOF
```

Expected: returns the protection JSON (not an error). If you want code reviews required, change `required_approving_review_count` to `1`.

- [ ] **Step 2: Verify**

```bash
gh api repos/mttvnst-HA/secwriter/branches/main/protection | head -20
```

Expected: shows `required_status_checks` with `contexts: ["Unit & Compliance Tests"]`.

### Task 11: Confirm Dependabot alerts are enabled

- [ ] **Step 1: Check alerts status**

```bash
gh api repos/mttvnst-HA/secwriter/vulnerability-alerts -i 2>&1 | head -1
```

Expected: `HTTP/2 204` (alerts enabled). If `404`, enable via dashboard: Settings → Code security → Dependabot alerts → Enable.

- [ ] **Step 2: Check for `.github/dependabot.yml`**

```bash
ls .github/dependabot.yml 2>&1 || echo "missing"
```

If missing and you want automated dependency PRs (not just alerts):

```bash
git checkout -b chore/enable-dependabot
mkdir -p .github
cat > .github/dependabot.yml <<'EOF'
version: 2
updates:
  - package-ecosystem: npm
    directory: /
    schedule:
      interval: weekly
    open-pull-requests-limit: 5
EOF
git add .github/dependabot.yml
git commit -m "chore: enable Dependabot weekly npm updates"
git push -u origin chore/enable-dependabot
gh pr create --title "chore: enable Dependabot weekly npm updates" --body "Automates the security-fix workflow we ran manually for postcss/uuid."
gh pr merge --squash --delete-branch
git checkout main
git pull
```

- [ ] **Step 3: Confirm no open vulnerabilities**

```bash
npm audit
```

Expected: `found 0 vulnerabilities` (postcss/uuid patches mirrored across in commit `af78daa`).

---

## Phase 4: Implement S3/R2 storage backend

This phase implements `server/storage-s3.cjs`. All work on a single feature branch.

### Task 12: Branch + install dependencies

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`

- [ ] **Step 1: Create feature branch**

```bash
git checkout main
git pull
git checkout -b feat/s3-storage-backend
```

- [ ] **Step 2: Install runtime dependency + dev mock**

```bash
npm install @aws-sdk/client-s3
npm install --save-dev aws-sdk-client-mock
```

Expected: `package.json` gains `@aws-sdk/client-s3` in `dependencies` and `aws-sdk-client-mock` in `devDependencies`.

- [ ] **Step 3: Verify build still works**

```bash
npm run build
```

Expected: builds. Frontend bundle size unchanged (S3 client is server-only — never imported from `src/`).

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore(deps): add @aws-sdk/client-s3 + aws-sdk-client-mock for new R2 backend"
```

### Task 13: Stub out S3StorageBackend interface

**Files:**
- Create: `server/storage-s3.cjs`
- Reference: `server/storage-azure.cjs`, `server/storage-local.cjs`

- [ ] **Step 1: Read the existing backends to confirm the interface**

```bash
head -80 server/storage-azure.cjs
head -50 server/storage-local.cjs
```

Note the methods: `writeRoom(docName, artifacts)`, `readRoom(docName)`, `deleteRoom(docName)`, `listRooms()`, `quarantineRoom(docName, reason)`, `archiveRoom(docName)`, `restoreRoom(docName)`, `listArchivedRooms()`, `deleteArchivedRoom(docName)`, `statRoom(docName)`.

`artifacts` is `{ ydocBytes: Uint8Array, secBytes: Uint8Array | null, commentsJson: string | null }`.

`readRoom` returns `{ ydocBytes, secBytes, commentsJson } | null`. `null` means the room doesn't exist; partial data (e.g. only `ydocBytes`) means SEC and/or comments are missing — caller handles that.

- [ ] **Step 2: Create the stub file**

Create `server/storage-s3.cjs`:

```javascript
/**
 * S3-compatible blob storage backend (Cloudflare R2, AWS S3, MinIO).
 *
 * Mirrors AzureStorageBackend's interface. Each room produces three
 * objects keyed by room name:
 *   <name>.ydoc            (binary Y.Doc snapshot)
 *   <name>.SEC             (windows-1252 encoded .SEC bytes)
 *   <name>.comments.json   (UTF-8 JSON sidecar)
 *
 * Quarantined rooms: <name>.<reason>.ydoc (e.g. <name>.corrupt.ydoc).
 * Archived rooms: archive/<name>.* prefix.
 *
 * Configured via SIM_S3_ENDPOINT / SIM_S3_REGION / SIM_S3_ACCESS_KEY_ID /
 * SIM_S3_SECRET_ACCESS_KEY / SIM_S3_BUCKET. See server/collab-server.cjs
 * for the env-driven instantiation.
 */

const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand,
        ListObjectsV2Command, CopyObjectCommand, HeadObjectCommand } = require('@aws-sdk/client-s3');

class S3StorageBackend {
  constructor({ client, bucket }) {
    if (!client) throw new Error('S3StorageBackend requires { client }');
    if (!bucket) throw new Error('S3StorageBackend requires { bucket }');
    this.client = client;
    this.bucket = bucket;
  }

  async writeRoom(docName, artifacts) { throw new Error('not implemented'); }
  async readRoom(docName) { throw new Error('not implemented'); }
  async deleteRoom(docName) { throw new Error('not implemented'); }
  async listRooms() { throw new Error('not implemented'); }
  async quarantineRoom(docName, reason) { throw new Error('not implemented'); }
  async archiveRoom(docName) { throw new Error('not implemented'); }
  async restoreRoom(docName) { throw new Error('not implemented'); }
  async listArchivedRooms() { throw new Error('not implemented'); }
  async deleteArchivedRoom(docName) { throw new Error('not implemented'); }
  async statRoom(docName) { throw new Error('not implemented'); }
}

module.exports = { S3StorageBackend };
```

- [ ] **Step 3: Commit the stub**

```bash
git add server/storage-s3.cjs
git commit -m "feat(server): scaffold S3StorageBackend interface"
```

### Task 14: Test scaffold + constructor test

**Files:**
- Create: `server/__tests__/storage-s3.test.mjs`
- Modify: `package.json` (test:server script)

- [ ] **Step 1: Read the Azure test for shape**

```bash
head -60 server/__tests__/storage-azure.test.mjs
```

- [ ] **Step 2: Create the new test file**

Create `server/__tests__/storage-s3.test.mjs`:

```javascript
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mockClient } from 'aws-sdk-client-mock';
import { S3Client, PutObjectCommand, GetObjectCommand,
         ListObjectsV2Command, CopyObjectCommand, DeleteObjectCommand,
         HeadObjectCommand } from '@aws-sdk/client-s3';

const { S3StorageBackend } = await import('../storage-s3.cjs');

const s3Mock = mockClient(S3Client);

describe('S3StorageBackend', () => {
  beforeEach(() => {
    s3Mock.reset();
  });

  test('constructor requires client and bucket', () => {
    assert.throws(() => new S3StorageBackend({}), /requires \{ client \}/);
    assert.throws(
      () => new S3StorageBackend({ client: new S3Client({ region: 'auto' }) }),
      /requires \{ bucket \}/
    );
    const backend = new S3StorageBackend({ client: new S3Client({ region: 'auto' }), bucket: 'test' });
    assert.equal(backend.bucket, 'test');
  });
});
```

- [ ] **Step 3: Wire into npm script**

Use the Edit tool on `package.json`. Find:

```
"test:server": "node --test server/__tests__/dom-polyfill.test.mjs server/__tests__/storage-local.test.mjs server/__tests__/storage-azure.test.mjs server/__tests__/room-serializer.test.mjs server/__tests__/http-endpoints.test.mjs server/__tests__/auth-jwt.test.mjs",
```

Replace with:

```
"test:server": "node --test server/__tests__/dom-polyfill.test.mjs server/__tests__/storage-local.test.mjs server/__tests__/storage-azure.test.mjs server/__tests__/storage-s3.test.mjs server/__tests__/room-serializer.test.mjs server/__tests__/http-endpoints.test.mjs server/__tests__/auth-jwt.test.mjs",
```

- [ ] **Step 4: Run — expect PASS**

```bash
npm run test:server
```

Expected: 56 tests pass (55 existing + 1 new constructor test).

- [ ] **Step 5: Commit**

```bash
git add server/__tests__/storage-s3.test.mjs package.json
git commit -m "test(server): scaffold storage-s3 test suite with mock S3 client"
```

### Task 15: Implement writeRoom + readRoom (TDD)

**Files:**
- Modify: `server/storage-s3.cjs`
- Modify: `server/__tests__/storage-s3.test.mjs`

- [ ] **Step 1: Write failing test for writeRoom + readRoom roundtrip**

Append to `server/__tests__/storage-s3.test.mjs` inside the `describe` block:

```javascript
test('writeRoom + readRoom round-trips all three artifacts', async () => {
  const stored = new Map();
  s3Mock.on(PutObjectCommand).callsFake(async (input) => {
    stored.set(input.Key, input.Body);
    return {};
  });
  s3Mock.on(GetObjectCommand).callsFake(async (input) => {
    if (!stored.has(input.Key)) {
      const err = new Error('NoSuchKey'); err.name = 'NoSuchKey';
      throw err;
    }
    const body = stored.get(input.Key);
    return {
      Body: {
        transformToByteArray: async () =>
          body instanceof Uint8Array ? body : new Uint8Array(Buffer.from(body)),
      },
    };
  });

  const backend = new S3StorageBackend({ client: new S3Client({ region: 'auto' }), bucket: 'test' });
  const ydocBytes = new Uint8Array([1, 2, 3, 4]);
  const secBytes = new Uint8Array([5, 6, 7]);
  const commentsJson = '{"comments":[]}';

  await backend.writeRoom('myroom', { ydocBytes, secBytes, commentsJson });
  const result = await backend.readRoom('myroom');

  assert.deepEqual(Array.from(result.ydocBytes), [1, 2, 3, 4]);
  assert.deepEqual(Array.from(result.secBytes), [5, 6, 7]);
  assert.equal(result.commentsJson, commentsJson);
});

test('readRoom returns null when ydoc missing', async () => {
  s3Mock.on(GetObjectCommand).callsFake(async () => {
    const err = new Error('NoSuchKey'); err.name = 'NoSuchKey';
    throw err;
  });
  const backend = new S3StorageBackend({ client: new S3Client({ region: 'auto' }), bucket: 'test' });
  const result = await backend.readRoom('nope');
  assert.equal(result, null);
});

test('writeRoom with null secBytes/commentsJson writes only ydoc', async () => {
  const writes = [];
  s3Mock.on(PutObjectCommand).callsFake(async (input) => {
    writes.push(input.Key);
    return {};
  });
  const backend = new S3StorageBackend({ client: new S3Client({ region: 'auto' }), bucket: 'test' });
  await backend.writeRoom('myroom', { ydocBytes: new Uint8Array([1]), secBytes: null, commentsJson: null });
  assert.deepEqual(writes, ['myroom.ydoc']);
});
```

- [ ] **Step 2: Run — expect FAIL ("not implemented")**

```bash
npm run test:server
```

Expected: 3 new tests fail with "not implemented".

- [ ] **Step 3: Implement writeRoom + readRoom**

Edit `server/storage-s3.cjs`. Replace the `writeRoom` and `readRoom` stubs:

```javascript
async writeRoom(docName, artifacts) {
  const { ydocBytes, secBytes, commentsJson } = artifacts;
  const writes = [
    this.client.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: `${docName}.ydoc`,
      Body: ydocBytes,
      ContentType: 'application/octet-stream',
    })),
  ];
  if (secBytes) {
    writes.push(this.client.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: `${docName}.SEC`,
      Body: secBytes,
      ContentType: 'application/octet-stream',
    })));
  }
  if (commentsJson) {
    writes.push(this.client.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: `${docName}.comments.json`,
      Body: commentsJson,
      ContentType: 'application/json',
    })));
  }
  await Promise.all(writes);
}

async readRoom(docName) {
  const tryGet = async (key) => {
    try {
      const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      return await res.Body.transformToByteArray();
    } catch (err) {
      if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) return null;
      throw err;
    }
  };

  const ydocBytes = await tryGet(`${docName}.ydoc`);
  if (!ydocBytes) return null;

  const secBytes = await tryGet(`${docName}.SEC`);
  const commentsBytes = await tryGet(`${docName}.comments.json`);
  const commentsJson = commentsBytes ? Buffer.from(commentsBytes).toString('utf8') : null;

  return { ydocBytes, secBytes, commentsJson };
}
```

- [ ] **Step 4: Run — expect PASS**

```bash
npm run test:server
```

Expected: 59 tests pass.

- [ ] **Step 5: Commit**

```bash
git add server/storage-s3.cjs server/__tests__/storage-s3.test.mjs
git commit -m "feat(server): implement S3 writeRoom + readRoom with parallel object PUTs"
```

### Task 16: Implement deleteRoom

**Files:**
- Modify: `server/storage-s3.cjs`
- Modify: `server/__tests__/storage-s3.test.mjs`

- [ ] **Step 1: Write failing test**

Append to `storage-s3.test.mjs`:

```javascript
test('deleteRoom removes all three artifacts', async () => {
  const deleted = [];
  s3Mock.on(DeleteObjectCommand).callsFake(async (input) => {
    deleted.push(input.Key);
    return {};
  });

  const backend = new S3StorageBackend({ client: new S3Client({ region: 'auto' }), bucket: 'test' });
  await backend.deleteRoom('myroom');

  assert.deepEqual(deleted.sort(), ['myroom.SEC', 'myroom.comments.json', 'myroom.ydoc']);
});
```

- [ ] **Step 2: Run — expect FAIL**

```bash
npm run test:server
```

- [ ] **Step 3: Implement deleteRoom**

Replace `deleteRoom` stub in `storage-s3.cjs`:

```javascript
async deleteRoom(docName) {
  const keys = [`${docName}.ydoc`, `${docName}.SEC`, `${docName}.comments.json`];
  await Promise.all(keys.map(Key =>
    this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key })).catch(err => {
      // Swallow 404 — optional artifacts (SEC, comments) may legitimately not exist.
      if (err.name !== 'NoSuchKey' && err.$metadata?.httpStatusCode !== 404) throw err;
    })
  ));
}
```

- [ ] **Step 4: Run — expect PASS**

- [ ] **Step 5: Commit**

```bash
git add server/storage-s3.cjs server/__tests__/storage-s3.test.mjs
git commit -m "feat(server): implement S3 deleteRoom"
```

### Task 17: Implement listRooms

**Files:**
- Modify: `server/storage-s3.cjs`
- Modify: `server/__tests__/storage-s3.test.mjs`

- [ ] **Step 1: Write failing test**

Append to `storage-s3.test.mjs`:

```javascript
test('listRooms returns room names from .ydoc objects, excluding quarantine + archive', async () => {
  s3Mock.on(ListObjectsV2Command).resolves({
    Contents: [
      { Key: 'room1.ydoc' },
      { Key: 'room1.SEC' },
      { Key: 'room2.ydoc' },
      { Key: 'room2.comments.json' },
      { Key: 'room3.corrupt.ydoc' },     // quarantined - exclude
      { Key: 'room4.oversize.ydoc' },    // quarantined - exclude
      { Key: 'archive/room5.ydoc' },     // archived - exclude
    ],
  });

  const backend = new S3StorageBackend({ client: new S3Client({ region: 'auto' }), bucket: 'test' });
  const rooms = await backend.listRooms();

  assert.deepEqual(rooms.sort(), ['room1', 'room2']);
});
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement listRooms**

Replace `listRooms` stub:

```javascript
async listRooms() {
  const rooms = new Set();
  let continuationToken;
  do {
    const res = await this.client.send(new ListObjectsV2Command({
      Bucket: this.bucket,
      ContinuationToken: continuationToken,
    }));
    for (const obj of res.Contents || []) {
      const key = obj.Key;
      if (key.startsWith('archive/')) continue;
      // Match exactly <name>.ydoc — name must not contain '.' to exclude
      // <name>.<reason>.ydoc (quarantined).
      const m = key.match(/^([^./]+)\.ydoc$/);
      if (!m) continue;
      rooms.add(m[1]);
    }
    continuationToken = res.NextContinuationToken;
  } while (continuationToken);
  return [...rooms];
}
```

- [ ] **Step 4: Run — expect PASS**

- [ ] **Step 5: Commit**

```bash
git add server/storage-s3.cjs server/__tests__/storage-s3.test.mjs
git commit -m "feat(server): implement S3 listRooms (paginated, excludes quarantine/archive)"
```

### Task 18: Implement quarantineRoom

**Files:**
- Modify: `server/storage-s3.cjs`
- Modify: `server/__tests__/storage-s3.test.mjs`

- [ ] **Step 1: Write failing test**

Append to `storage-s3.test.mjs`:

```javascript
test('quarantineRoom copies .ydoc to .<reason>.ydoc and deletes original', async () => {
  const copies = [];
  const deletes = [];
  s3Mock.on(CopyObjectCommand).callsFake(async (input) => {
    copies.push({ from: input.CopySource, to: input.Key });
    return {};
  });
  s3Mock.on(DeleteObjectCommand).callsFake(async (input) => {
    deletes.push(input.Key);
    return {};
  });

  const backend = new S3StorageBackend({ client: new S3Client({ region: 'auto' }), bucket: 'test' });
  await backend.quarantineRoom('myroom', 'corrupt');

  assert.equal(copies.length, 1);
  assert.equal(copies[0].from, 'test/myroom.ydoc');
  assert.equal(copies[0].to, 'myroom.corrupt.ydoc');
  assert.deepEqual(deletes, ['myroom.ydoc']);
});
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement quarantineRoom**

Replace stub:

```javascript
async quarantineRoom(docName, reason) {
  const sourceKey = `${docName}.ydoc`;
  const targetKey = `${docName}.${reason}.ydoc`;
  await this.client.send(new CopyObjectCommand({
    Bucket: this.bucket,
    CopySource: `${this.bucket}/${sourceKey}`,
    Key: targetKey,
  }));
  await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: sourceKey }));
}
```

- [ ] **Step 4: Run — expect PASS**

- [ ] **Step 5: Commit**

```bash
git add server/storage-s3.cjs server/__tests__/storage-s3.test.mjs
git commit -m "feat(server): implement S3 quarantineRoom (copy + delete original)"
```

### Task 19: Implement archive lifecycle (archive / restore / listArchived / deleteArchived)

**Files:**
- Modify: `server/storage-s3.cjs`
- Modify: `server/__tests__/storage-s3.test.mjs`

- [ ] **Step 1: Write integrated lifecycle test**

Append to `storage-s3.test.mjs`:

```javascript
test('archive lifecycle: archive → list → restore → archive → delete', async () => {
  const objects = new Map();
  objects.set('myroom.ydoc', new Uint8Array([1]));
  objects.set('myroom.SEC', new Uint8Array([2]));

  s3Mock.on(ListObjectsV2Command).callsFake(async (input) => ({
    Contents: [...objects.keys()]
      .filter(k => !input.Prefix || k.startsWith(input.Prefix))
      .map(Key => ({ Key })),
  }));
  s3Mock.on(CopyObjectCommand).callsFake(async (input) => {
    const sourceKey = String(input.CopySource).split('/').slice(1).join('/');
    objects.set(input.Key, objects.get(sourceKey));
    return {};
  });
  s3Mock.on(DeleteObjectCommand).callsFake(async (input) => {
    objects.delete(input.Key);
    return {};
  });
  s3Mock.on(HeadObjectCommand).callsFake(async (input) => {
    if (!objects.has(input.Key)) {
      const err = new Error('NotFound'); err.name = 'NotFound'; err.$metadata = { httpStatusCode: 404 };
      throw err;
    }
    return { Metadata: { archivedat: '2026-04-29T00:00:00Z' } };
  });

  const backend = new S3StorageBackend({ client: new S3Client({ region: 'auto' }), bucket: 'test' });

  await backend.archiveRoom('myroom');
  assert.ok(objects.has('archive/myroom.ydoc'));
  assert.ok(objects.has('archive/myroom.SEC'));
  assert.ok(!objects.has('myroom.ydoc'));

  const archived = await backend.listArchivedRooms();
  assert.equal(archived.length, 1);
  assert.equal(archived[0].name, 'myroom');
  assert.ok(archived[0].archivedAt);

  await backend.restoreRoom('myroom');
  assert.ok(objects.has('myroom.ydoc'));
  assert.ok(!objects.has('archive/myroom.ydoc'));

  await backend.archiveRoom('myroom');
  await backend.deleteArchivedRoom('myroom');
  assert.ok(!objects.has('archive/myroom.ydoc'));
});
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement the four methods**

Replace the four stubs:

```javascript
async archiveRoom(docName) {
  const suffixes = ['.ydoc', '.SEC', '.comments.json'];
  const archivedAt = new Date().toISOString();
  for (const suffix of suffixes) {
    const sourceKey = `${docName}${suffix}`;
    const targetKey = `archive/${docName}${suffix}`;
    try {
      await this.client.send(new CopyObjectCommand({
        Bucket: this.bucket,
        CopySource: `${this.bucket}/${sourceKey}`,
        Key: targetKey,
        Metadata: { archivedat: archivedAt },
        MetadataDirective: 'REPLACE',
      }));
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: sourceKey }));
    } catch (err) {
      // Optional artifacts (SEC, comments) may not exist — skip silently.
      if (err.name !== 'NoSuchKey' && err.$metadata?.httpStatusCode !== 404) throw err;
    }
  }
}

async restoreRoom(docName) {
  const suffixes = ['.ydoc', '.SEC', '.comments.json'];
  for (const suffix of suffixes) {
    const sourceKey = `archive/${docName}${suffix}`;
    const targetKey = `${docName}${suffix}`;
    try {
      await this.client.send(new CopyObjectCommand({
        Bucket: this.bucket,
        CopySource: `${this.bucket}/${sourceKey}`,
        Key: targetKey,
      }));
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: sourceKey }));
    } catch (err) {
      if (err.name !== 'NoSuchKey' && err.$metadata?.httpStatusCode !== 404) throw err;
    }
  }
}

async listArchivedRooms() {
  const result = [];
  let continuationToken;
  do {
    const res = await this.client.send(new ListObjectsV2Command({
      Bucket: this.bucket,
      Prefix: 'archive/',
      ContinuationToken: continuationToken,
    }));
    for (const obj of res.Contents || []) {
      const m = obj.Key.match(/^archive\/([^./]+)\.ydoc$/);
      if (!m) continue;
      const name = m[1];
      let archivedAt = null;
      try {
        const head = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: obj.Key }));
        archivedAt = head.Metadata?.archivedat || null;
      } catch { /* ignore */ }
      result.push({ name, archivedAt });
    }
    continuationToken = res.NextContinuationToken;
  } while (continuationToken);
  return result;
}

async deleteArchivedRoom(docName) {
  const keys = [`archive/${docName}.ydoc`, `archive/${docName}.SEC`, `archive/${docName}.comments.json`];
  for (const Key of keys) {
    try {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key }));
    } catch (err) {
      if (err.name !== 'NoSuchKey' && err.$metadata?.httpStatusCode !== 404) throw err;
    }
  }
}
```

- [ ] **Step 4: Run — expect PASS**

- [ ] **Step 5: Commit**

```bash
git add server/storage-s3.cjs server/__tests__/storage-s3.test.mjs
git commit -m "feat(server): implement S3 archive lifecycle (archive/restore/list/delete)"
```

### Task 20: Implement statRoom

**Files:**
- Modify: `server/storage-s3.cjs`
- Modify: `server/__tests__/storage-s3.test.mjs`

- [ ] **Step 1: Write failing test**

Append to `storage-s3.test.mjs`:

```javascript
test('statRoom returns lastModified or null', async () => {
  s3Mock.on(HeadObjectCommand).callsFake(async (input) => {
    if (input.Key === 'myroom.ydoc') return { LastModified: new Date('2026-04-29T12:00:00Z') };
    const err = new Error('NotFound'); err.name = 'NotFound'; err.$metadata = { httpStatusCode: 404 };
    throw err;
  });
  const backend = new S3StorageBackend({ client: new S3Client({ region: 'auto' }), bucket: 'test' });
  const stat = await backend.statRoom('myroom');
  assert.ok(stat.lastModified);
  const missing = await backend.statRoom('nope');
  assert.equal(missing, null);
});
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement statRoom**

```javascript
async statRoom(docName) {
  try {
    const res = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: `${docName}.ydoc` }));
    return { lastModified: res.LastModified?.toISOString() || null };
  } catch (err) {
    if (err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404) return null;
    throw err;
  }
}
```

- [ ] **Step 4: Run — expect PASS**

- [ ] **Step 5: Commit**

```bash
git add server/storage-s3.cjs server/__tests__/storage-s3.test.mjs
git commit -m "feat(server): implement S3 statRoom"
```

### Task 21: Wire SIM_STORAGE_BACKEND=s3 into collab-server.cjs

**Files:**
- Modify: `server/collab-server.cjs` (around lines 40-61, the storage-backend selection block)

- [ ] **Step 1: Read current backend-selection block**

```bash
sed -n '38,65p' server/collab-server.cjs
```

- [ ] **Step 2: Add the s3 branch**

Use the Edit tool. Find the block:

```javascript
let storage;
if (process.env.SIM_STORAGE_BACKEND === 'azure') {
  // ... azure setup ...
  storage = new AzureStorageBackend({ containerClient: blobServiceClient.getContainerClient(containerName) });
  log.info('storage.backend', { backend: 'azure', container: containerName });
} else {
  const { LocalStorageBackend } = require('./storage-local.cjs');
  storage = new LocalStorageBackend(DATA_DIR);
  log.info('storage.backend', { backend: 'local', dir: DATA_DIR });
}
```

Insert a new `else if` for s3 *before* the local fallback. The full new block:

```javascript
let storage;
if (process.env.SIM_STORAGE_BACKEND === 'azure') {
  const { BlobServiceClient } = require('@azure/storage-blob');
  const { DefaultAzureCredential } = require('@azure/identity');
  const connectionString = process.env.SIM_AZURE_STORAGE_CONNECTION_STRING;
  const containerName = process.env.SIM_AZURE_STORAGE_CONTAINER || 'sim-collab-rooms';
  let blobServiceClient;
  if (connectionString) {
    blobServiceClient = BlobServiceClient.fromConnectionString(connectionString);
  } else {
    const accountUrl = process.env.SIM_AZURE_STORAGE_ACCOUNT_URL;
    if (!accountUrl) throw new Error('Azure storage requires SIM_AZURE_STORAGE_CONNECTION_STRING or SIM_AZURE_STORAGE_ACCOUNT_URL');
    blobServiceClient = new BlobServiceClient(accountUrl, new DefaultAzureCredential());
  }
  const { AzureStorageBackend } = require('./storage-azure.cjs');
  storage = new AzureStorageBackend({ containerClient: blobServiceClient.getContainerClient(containerName) });
  log.info('storage.backend', { backend: 'azure', container: containerName });
} else if (process.env.SIM_STORAGE_BACKEND === 's3') {
  const { S3Client } = require('@aws-sdk/client-s3');
  const endpoint = process.env.SIM_S3_ENDPOINT;
  const region = process.env.SIM_S3_REGION || 'auto';
  const accessKeyId = process.env.SIM_S3_ACCESS_KEY_ID;
  const secretAccessKey = process.env.SIM_S3_SECRET_ACCESS_KEY;
  const bucket = process.env.SIM_S3_BUCKET || 'sim-collab-rooms';
  if (!endpoint) throw new Error('S3 storage requires SIM_S3_ENDPOINT (e.g. https://<account-id>.r2.cloudflarestorage.com)');
  if (!accessKeyId || !secretAccessKey) throw new Error('S3 storage requires SIM_S3_ACCESS_KEY_ID and SIM_S3_SECRET_ACCESS_KEY');
  const client = new S3Client({
    endpoint,
    region,
    credentials: { accessKeyId, secretAccessKey },
    forcePathStyle: true,  // Required for R2 and MinIO; harmless on AWS S3.
  });
  const { S3StorageBackend } = require('./storage-s3.cjs');
  storage = new S3StorageBackend({ client, bucket });
  log.info('storage.backend', { backend: 's3', bucket, endpoint });
} else {
  const { LocalStorageBackend } = require('./storage-local.cjs');
  storage = new LocalStorageBackend(DATA_DIR);
  log.info('storage.backend', { backend: 'local', dir: DATA_DIR });
}
```

- [ ] **Step 3: Run server tests**

```bash
npm run test:server
```

Expected: 65 tests pass.

- [ ] **Step 4: Smoke test — server should fail fast on missing env vars**

```bash
SIM_STORAGE_BACKEND=s3 node server/collab-server.cjs 2>&1 | head -3
```

Expected: throws `Error: S3 storage requires SIM_S3_ENDPOINT...`. Process exits non-zero.

- [ ] **Step 5: Commit**

```bash
git add server/collab-server.cjs
git commit -m "feat(server): wire S3StorageBackend behind SIM_STORAGE_BACKEND=s3"
```

### Task 22: Update .env.example and CLAUDE.md

**Files:**
- Modify: `.env.example`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Append S3 env vars to .env.example**

Use the Edit tool. After the existing `SIM_AZURE_*` block, add:

```
# S3-compatible storage (Cloudflare R2, AWS S3, MinIO)
# SIM_STORAGE_BACKEND=s3
# SIM_S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
# SIM_S3_REGION=auto
# SIM_S3_ACCESS_KEY_ID=
# SIM_S3_SECRET_ACCESS_KEY=
# SIM_S3_BUCKET=sim-collab-rooms
```

- [ ] **Step 2: Add a brief note to CLAUDE.md**

Find a location near the existing storage-backend documentation (search for `SIM_STORAGE_BACKEND` or `storage-azure` in CLAUDE.md). Add a sentence:

```
Three storage backends are wired: `local` (default, disk under `server/collab-db/`),
`azure` (Azure Blob, see `server/storage-azure.cjs`), and `s3` (S3-compatible
including Cloudflare R2 and MinIO, see `server/storage-s3.cjs`). Selected via
`SIM_STORAGE_BACKEND`. S3 backend uses the `SIM_S3_*` env vars.
```

- [ ] **Step 3: Commit**

```bash
git add .env.example CLAUDE.md
git commit -m "docs: document SIM_S3_* env vars and S3 storage backend"
```

### Task 23: PR and merge

- [ ] **Step 1: Push branch**

```bash
git push -u origin feat/s3-storage-backend
```

- [ ] **Step 2: Open PR**

```bash
gh pr create --title "feat(server): S3-compatible storage backend (Cloudflare R2)" --body "$(cat <<'EOF'
## Summary
- New `server/storage-s3.cjs` implements the storage interface using `@aws-sdk/client-s3`
- Selected via `SIM_STORAGE_BACKEND=s3` + `SIM_S3_*` env vars
- 10 new server tests (constructor, write/read roundtrip, partial reads, delete, list with quarantine/archive exclusion, quarantine, archive lifecycle, statRoom)
- Compatible with Cloudflare R2 (free 10 GB tier, no egress fees)
- Existing Azure backend unchanged

## Test plan
- [x] `npm run test:server` passes (65 tests)
- [x] `SIM_STORAGE_BACKEND=s3 node server/collab-server.cjs` fails fast on missing env vars (verified)
- [ ] Render deploy with real R2 credentials persists rooms across restarts (Phase 5)
EOF
)"
```

- [ ] **Step 3: Wait for CI**

```bash
gh pr checks --watch
```

- [ ] **Step 4: Merge**

```bash
gh pr merge --squash --delete-branch
git checkout main
git pull
```

---

## Phase 5: Provision R2 + deploy on Render

### Task 24: Create Cloudflare R2 bucket + API token

**Files:** none (Cloudflare dashboard)

- [ ] **Step 1: Sign in to Cloudflare**

If you don't have an account, create one at [dash.cloudflare.com/sign-up](https://dash.cloudflare.com/sign-up). Free tier is sufficient (10 GB storage, 10M Class A operations/month).

- [ ] **Step 2: Enable R2**

Dashboard → R2 Object Storage → Purchase R2 Plan (the free tier still requires entering the plan; no payment needed).

- [ ] **Step 3: Create bucket**

R2 → Create bucket. Name: `sim-collab-rooms`. Location: Automatic (or pick a region close to Render — Render's default region is Oregon `us-west`).

- [ ] **Step 4: Note Account ID**

Visible top-right in dashboard, or on the R2 overview page. Format: 32-char hex. The endpoint URL is `https://<account-id>.r2.cloudflarestorage.com`.

- [ ] **Step 5: Create API token**

R2 → Manage R2 API Tokens → Create API Token. Settings:
- Permissions: **Object Read & Write**
- Bucket: scope to `sim-collab-rooms` only (avoid blanket account-wide access)
- TTL: forever (or set as you prefer)

Click Create Token.

- [ ] **Step 6: Save credentials immediately**

The token page shows:
- **Access Key ID** (~ 32 chars)
- **Secret Access Key** (~ 64 chars)

Save both to a password manager **now**. The Secret Access Key cannot be retrieved later — only regenerated.

### Task 25: Update render.yaml for S3 backend

**Files:**
- Modify: `render.yaml`

- [ ] **Step 1: Branch off**

```bash
git checkout main
git pull
git checkout -b chore/render-r2
```

- [ ] **Step 2: Edit render.yaml**

Use the Edit tool. In the `secwriter-collab` `envVars` section, replace this block:

```yaml
      - key: SIM_STORAGE_BACKEND
        value: azure           # Use Azure Blob — persistent across redeploys, tests the production backend
      - key: SIM_AZURE_STORAGE_CONNECTION_STRING
        sync: false            # Paste your Azure storage account connection string from the portal
      - key: SIM_AZURE_STORAGE_CONTAINER
        value: sim-collab-rooms
```

with:

```yaml
      - key: SIM_STORAGE_BACKEND
        value: s3              # Cloudflare R2 (S3-compatible) — persistent across redeploys
      - key: SIM_S3_ENDPOINT
        sync: false            # https://<r2-account-id>.r2.cloudflarestorage.com
      - key: SIM_S3_REGION
        value: auto
      - key: SIM_S3_ACCESS_KEY_ID
        sync: false
      - key: SIM_S3_SECRET_ACCESS_KEY
        sync: false
      - key: SIM_S3_BUCKET
        value: sim-collab-rooms
```

- [ ] **Step 3: Update the deploy-step preamble at the top of render.yaml**

Replace lines 4-13 (the `Deploy sequence` comment block). Old text references `SIM_AZURE_STORAGE_CONNECTION_STRING`; new text should describe setting `SIM_S3_ENDPOINT`, `SIM_S3_ACCESS_KEY_ID`, `SIM_S3_SECRET_ACCESS_KEY` from the Cloudflare R2 dashboard.

New preamble:

```yaml
# Deploy sequence:
#   1. Connect this repo in the Render dashboard → "New Blueprint"
#   2. Before first deploy, set these env vars on secwriter-collab in the dashboard:
#        SIM_S3_ENDPOINT             = https://<account-id>.r2.cloudflarestorage.com
#        SIM_S3_ACCESS_KEY_ID        = <R2 API token Access Key ID>
#        SIM_S3_SECRET_ACCESS_KEY    = <R2 API token Secret Access Key>
#          (Cloudflare dashboard → R2 → Manage R2 API Tokens → Create API Token,
#           scope: Object Read & Write on bucket sim-collab-rooms)
#   3. Both services deploy. Note the collab service URL.
#   4. Set these two env vars on secwriter-frontend in the dashboard:
#        VITE_COLLAB_WS_URL  = wss://<secwriter-collab-url>/ws
#        VITE_COLLAB_HTTP_URL = https://<secwriter-collab-url>/api
#   5. Trigger a manual redeploy of secwriter-frontend so Vite inlines the URLs.
```

- [ ] **Step 4: Commit + push + PR + merge**

```bash
git add render.yaml
git commit -m "chore(deploy): point render.yaml at S3/R2 instead of Azure Blob"
git push -u origin chore/render-r2
gh pr create --title "chore(deploy): switch render.yaml to R2 storage" --body "Replaces SIM_AZURE_* env vars with SIM_S3_*. The new fork has no access to the haleyaldrich Azure tenant; collab persistence now uses Cloudflare R2."
gh pr checks --watch
gh pr merge --squash --delete-branch
git checkout main
git pull
```

### Task 26: Create Render Blueprint pointing at new repo

**Files:** none (Render dashboard)

- [ ] **Step 1: Sign in to Render** — [render.com](https://render.com).

- [ ] **Step 2: Connect GitHub** — if not already, Settings → GitHub → Connect. You'll need to grant Render's GitHub App access to the `mttvnst-HA` org.

- [ ] **Step 3: Create Blueprint**

Dashboard → **New +** → **Blueprint** → connect repo `mttvnst-HA/secwriter` → branch `main` → Render reads `render.yaml`. You should see a preview of two services: `secwriter-collab` (Web Service, Node, free) and `secwriter-frontend` (Static Site, free). Click Apply.

- [ ] **Step 4: Wait for first build**

Render starts deploying both. Expected outcome:
- `secwriter-collab` builds successfully (npm install, no compile step). Boot fails with `Error: S3 storage requires SIM_S3_ENDPOINT...` — that's expected; we set the secrets in the next task.
- `secwriter-frontend` builds successfully but won't function (VITE_COLLAB_* env vars unset).

### Task 27: Set R2 secrets on secwriter-collab

**Files:** none (Render dashboard)

- [ ] **Step 1: Open the service**

Render dashboard → `secwriter-collab` → Environment.

- [ ] **Step 2: Set the four `sync: false` vars**

| Key | Value |
|---|---|
| `SIM_S3_ENDPOINT` | `https://<account-id>.r2.cloudflarestorage.com` (from R2 step 4) |
| `SIM_S3_ACCESS_KEY_ID` | Access Key ID from R2 token (Task 24 step 6) |
| `SIM_S3_SECRET_ACCESS_KEY` | Secret Access Key from R2 token (Task 24 step 6) |

`SIM_S3_REGION=auto` and `SIM_S3_BUCKET=sim-collab-rooms` come from `render.yaml` automatically.

- [ ] **Step 3: Save**

Render auto-triggers a redeploy.

- [ ] **Step 4: Watch logs**

Logs tab. Expected sequence:
1. `npm install` completes
2. `node server/collab-server.cjs` starts
3. `storage.backend` log line with `backend: 's3'`
4. (No "Listening" log because the server uses an internal http.createServer — but the absence of crash + presence of the `storage.backend` line means it's up. Confirm via /health below.)

- [ ] **Step 5: /health smoke test**

The collab service URL is at the top of the service page (e.g. `https://secwriter-collab.onrender.com` or with a hash suffix). Run from your laptop:

```bash
curl https://<your-collab-url>/health
```

Expected: `{"status":"ok",...}` JSON. If 404 on `/health`, double-check the URL and that the service is in "Live" status.

### Task 28: Set frontend env vars and redeploy

**Files:** none (Render dashboard)

- [ ] **Step 1: Copy collab service URL**

From `secwriter-collab` overview, copy the full URL (e.g. `https://secwriter-collab-abc1.onrender.com`).

- [ ] **Step 2: Set frontend env vars**

Render dashboard → `secwriter-frontend` → Environment. Set:

| Key | Value |
|---|---|
| `VITE_COLLAB_WS_URL` | `wss://<your-collab-url-host>/ws` |
| `VITE_COLLAB_HTTP_URL` | `https://<your-collab-url-host>/api` |

(host = the URL minus `https://`, e.g. `secwriter-collab-abc1.onrender.com`)

- [ ] **Step 3: Trigger manual redeploy**

`secwriter-frontend` page → **Manual Deploy** → Deploy latest commit. Vite inlines these vars at build time, so they don't take effect without a rebuild.

- [ ] **Step 4: Wait for deploy** (~30-60s)

### Task 29: End-to-end smoke test

**Files:** none (browser)

- [ ] **Step 1: Open frontend URL**

Open `https://secwriter-frontend.onrender.com` (or the URL Render assigned). Confirm the SecWriter editor UI loads.

- [ ] **Step 2: Confirm WebSocket connects**

Open browser DevTools → Network tab → filter "WS". Look for a connection to `wss://<collab>/ws/<room-name>` with status 101 (Switching Protocols). If it shows red/failed, the env vars didn't inline correctly — re-check Task 28.

- [ ] **Step 3: Type something in a new room**

Click into a room, type a sentence in the editor.

- [ ] **Step 4: Reload and verify persistence**

Hard reload the page (Ctrl+Shift+R). The text you typed should still be there. **This is the critical R2 persistence test.**

- [ ] **Step 5: Verify R2 storage from Cloudflare dashboard**

Cloudflare dashboard → R2 → `sim-collab-rooms`. You should see 1-3 objects: `<room-name>.ydoc`, optionally `<room-name>.SEC` and `<room-name>.comments.json`.

- [ ] **Step 6: Two-tab collab test**

Open the same room in a second browser tab. Type from one tab — text should appear in the other within ~1s. (This validates the WebSocket path, separately from R2 persistence.)

- [ ] **Step 7: Cold-start test (optional)**

Wait 15+ minutes (Render free tier idle threshold). Reload the page. First WS connect will take ~30s (Render spinning the dyno back up). Confirm the room content is still there after the cold start completes.

---

## Phase 6: Cosmetic cleanup (deferred — optional)

Do these in a single PR after Phase 5 succeeds, or skip entirely.

### Task 30: Update onboarding.md and stale repo references

**Files:**
- Modify: `onboarding.md` (and any other .md files referencing the old org)

- [ ] **Step 1: Find references**

```bash
grep -rln 'haleyaldrich/secwriter\|specsintact-modern' --include='*.md' .
```

- [ ] **Step 2: Edit each match**

Use the Edit tool. Replace `haleyaldrich/secwriter` with `mttvnst-HA/secwriter`. Replace `specsintact-modern` with `secwriter` where the context describes this repo (NOT in the legacy-product/EULA explanations, where "SpecsIntact" still refers to the legacy desktop app — this terminology is documented in CLAUDE.md and must be preserved).

- [ ] **Step 3: Commit + PR + merge**

```bash
git checkout -b docs/update-repo-references
git commit -am "docs: update repo URL references to mttvnst-HA/secwriter"
git push -u origin docs/update-repo-references
gh pr create --title "docs: update repo URL references" --body "Cosmetic post-fork cleanup."
gh pr merge --squash --delete-branch
git checkout main
git pull
```

---

## Done criteria

- [ ] `mttvnst-HA/secwriter` repo exists with full git history mirrored from `haleyaldrich/secwriter`
- [ ] No Azure deploy workflows remain on default branch (`ci.yml` only)
- [ ] No `deploy/AZURE-*.md` docs on default branch
- [ ] Branch protection on `main` requires PR + `Unit & Compliance Tests` status check
- [ ] Dependabot alerts enabled; `npm audit` reports 0 vulnerabilities
- [ ] `server/storage-s3.cjs` implemented + tested (10 unit tests via `aws-sdk-client-mock`); merged to main
- [ ] Cloudflare R2 bucket `sim-collab-rooms` provisioned; API token saved in password manager
- [ ] Render Blueprint deployed: `secwriter-collab` healthy (responds 200 on `/health`), `secwriter-frontend` accessible
- [ ] End-to-end smoke test passes: room persists across reload (proves R2), WebSocket connects, two-tab collab syncs
- [ ] Zero references to haleyaldrich Azure resources in active code paths (workflows, render.yaml, CLAUDE.md)
