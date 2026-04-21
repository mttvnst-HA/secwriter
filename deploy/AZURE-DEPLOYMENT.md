# Azure Deployment Instructions — SecWriter (Multi-User)

## What You're Deploying

SecWriter is a web-based specification editor with real-time multi-user collaboration. It consists of two components:

1. **Static frontend** — A React SPA built with Vite (`npm run build` produces `dist/`). Serves on any static host.
2. **Collab server** — A Node.js process running two services:
   - **WebSocket** on port 1234 — Yjs CRDT sync for real-time co-editing
   - **HTTP API** on port 1235 — Room management, file upload/download, health check

Both server ports bind to `127.0.0.1`. A reverse proxy must sit in front for TLS termination and external access.

## Architecture

```
                          +---------------------+
  Browser ---- HTTPS ---->|  Reverse Proxy       |
  (wss://)                |  (nginx, Caddy, or   |
                          |   Azure App Gateway) |
                          |                      |
                          |  /ws/*  --> :1234    |  WebSocket (Yjs CRDT)
                          |  /api/* --> :1235    |  HTTP REST API
                          |  /*    --> dist/     |  Static frontend
                          +---------------------+
```

Reference configs are in `deploy/nginx.conf` and `deploy/Caddyfile`. Adapt the routing patterns for Azure Application Gateway or Azure Front Door if using those instead.

## Prerequisites

- Node.js 18+ on the collab server host
- `npm install` in the repo root (installs both frontend and server dependencies)
- Azure AD app registration for SSO (client ID + tenant ID)
- Azure Blob Storage account (if using cloud storage for room persistence)
- TLS certificate or Azure-managed TLS via App Service / Front Door

## Step 1: Build the Frontend

The frontend URLs are baked in at build time. Set these env vars to match your domain:

```bash
VITE_COLLAB_WS_URL=wss://sim.yourdomain.com/ws \
VITE_COLLAB_HTTP_URL=https://sim.yourdomain.com/api \
VITE_AZURE_AD_CLIENT_ID=<your-azure-ad-app-client-id> \
VITE_AZURE_AD_TENANT_ID=<your-azure-ad-tenant-id> \
npm run build
```

Output goes to `dist/`. Deploy this to Azure Static Web Apps, Azure Blob Storage (static website), or any static file host.

## Step 2: Start the Collab Server

Set these environment variables and start the server:

```bash
# Required -- Auth
SIM_AUTH_PROVIDER=jwt
SIM_AUTH_JWT_SECRET=<shared-secret>          # For HS256 tokens
# OR
SIM_AUTH_JWT_PUBLIC_KEY=/path/to/public.pem  # For RS256 tokens (Azure AD uses RS256)
SIM_AUTH_JWT_ISSUER=https://login.microsoftonline.com/<tenant-id>/v2.0
SIM_AUTH_JWT_AUDIENCE=<client-id>

# Required -- CORS (must match the frontend origin exactly)
SIM_COLLAB_ORIGIN=https://sim.yourdomain.com

# Storage -- use Azure Blob for production persistence
SIM_STORAGE_BACKEND=azure
SIM_AZURE_STORAGE_CONNECTION_STRING=<connection-string>
# OR for Managed Identity:
SIM_AZURE_STORAGE_ACCOUNT_URL=https://<account>.blob.core.windows.net
SIM_AZURE_STORAGE_CONTAINER=sim-collab-rooms    # default container name

# Operational
SIM_LOG_FORMAT=json
SIM_RATE_LIMIT_WS_PER_MIN=10
SIM_RATE_LIMIT_HTTP_READ_PER_MIN=60
SIM_RATE_LIMIT_HTTP_WRITE_PER_MIN=20
SIM_ROOM_ARCHIVE_DAYS=30
SIM_ROOM_DELETE_DAYS=90

# Keep loopback -- proxy handles external access
COLLAB_HOST=127.0.0.1
COLLAB_PORT=1234
COLLAB_HTTP_PORT=1235

node server/collab-server.cjs
```

Use a process manager (PM2, systemd, or Azure App Service) to keep it running.

## Step 3: Configure the Reverse Proxy

Route these paths (strip prefixes before forwarding):

| External Path | External Protocol | Backend | Notes |
|---------------|-------------------|---------|-------|
| `/ws/*` | WSS (WebSocket over TLS) | `127.0.0.1:1234` | Strip `/ws` prefix. Set read timeout to 24h+ for long-lived connections. |
| `/api/*` | HTTPS | `127.0.0.1:1235` | Strip `/api` prefix. Allow 10MB body for file uploads. |
| `/*` | HTTPS | `dist/` static files | SPA fallback: serve `/index.html` for unmatched routes. |

**Critical: Log sanitization.** WebSocket URLs contain JWT tokens as query parameters (`?token=eyJ...`). Configure the proxy to strip or redact `?token=...` from access logs. See `deploy/nginx.conf` lines 13-22 for the regex pattern.

**Do NOT add CORS headers in the proxy.** The Node.js server handles CORS via `SIM_COLLAB_ORIGIN`. Duplicate headers cause browser errors.

## Step 4: Health Check

```
GET https://sim.yourdomain.com/api/health
```

Returns `200 OK` with `{ status, rooms, connections }`. Unauthenticated -- suitable for Azure load balancer health probes.

## Step 5: Verify

1. Open `https://sim.yourdomain.com` -- should load the editor
2. Open `https://sim.yourdomain.com/?room=test` -- should prompt for Azure AD login, then show the editor with collab features
3. Open the same room URL in a second browser/incognito tab -- both tabs should show each other in the presence bar and sync edits in real-time

## Azure-Specific Hosting Options

| Option | Frontend | Collab Server | Notes |
|--------|----------|---------------|-------|
| App Service + Static Web Apps | Static Web Apps | App Service (Node.js) | Simplest. App Service handles TLS. Enable WebSocket support in App Service settings. Single-port ingress — needs server refactor or Application Gateway for WS. |
| **Container Apps (recommended)** | App Service | Container Apps via ACR | See `Dockerfile.collab` + `.github/workflows/collab-server-deploy.yml`. Single-port ingress target 1235 covers HTTP + `/health`. WebSocket on 1234 needs routing work (see limitations note in the workflow header). |
| Container Instance | Blob Storage static website | Container Instance | Reuse `Dockerfile.collab`. No managed identity support — pass `SIM_AZURE_STORAGE_CONNECTION_STRING`. |
| VM | Served by nginx on VM | Node.js on VM | Most control. Use the `deploy/nginx.conf` directly. |

For a fully-Azure provisioning plan (resource groups, RBAC, federated OIDC credentials, GitHub repo secrets), see [`AZURE-SYSADMIN-CHECKLIST.md`](AZURE-SYSADMIN-CHECKLIST.md).

If using Azure App Service for the collab server, enable **WebSockets** in Configuration > General settings, and set the **Web socket idle timeout** to the maximum (currently 240 minutes).

---

## How Persistent Storage Works

### Overview

Each collaborative editing room persists three artifacts to storage:

| Artifact | Format | Purpose |
|----------|--------|---------|
| `<roomId>.ydoc` | Binary (Yjs CRDT snapshot) | Source of truth. Full document state for recovery. |
| `<roomId>.SEC` | Windows-1252 XML | Human-readable spec file, ready for SpecsIntact. |
| `<roomId>.comments.json` | UTF-8 JSON | Comment thread metadata (author, status, replies). |

### When Writes Happen

Persistence is debounced at 500ms. Every time a user makes an edit via WebSocket, a timer resets. When 500ms pass with no new edits, the server serializes the Y.Doc into all three artifacts and writes them atomically. This batches rapid keystrokes into a single persist operation.

Additionally:
- **File uploads** (`POST /rooms/:id/upload`) flush synchronously before returning 200 -- the response guarantees durability.
- **Graceful shutdown** (SIGINT/SIGTERM) flushes all dirty rooms before the process exits, so up to 500ms of final edits are not lost.
- An **8MB hard cap** prevents runaway documents from consuming storage. Oversized docs are quarantined for forensic inspection.

### Server Restart Recovery

When a WebSocket client connects to a room:
1. The server reads the `.ydoc` from storage
2. Decodes it into a scratch Y.Doc (isolated from the live doc in case of corruption)
3. If valid, merges the state into the live Y.Doc -- the client receives the restored content via Yjs sync
4. If corrupt, quarantines the file and starts a fresh room

The `.SEC` and `.comments.json` files are regenerated from the `.ydoc` on every flush, so they do not need to be read on restart. They exist so the spec file can be downloaded or processed externally without running the server.

### Local Storage Backend

Used when `SIM_STORAGE_BACKEND=local` (the default). Stores files in `server/collab-db/` on the filesystem. Uses atomic multi-file writes:
1. All artifacts are written to `.tmp` files first
2. Renamed to final names in sequence, with `.ydoc` last (since it is the recovery source)
3. If any rename fails, already-renamed files are rolled back from backup

On startup, orphaned `.tmp` files from a mid-write crash are cleaned up.

### Azure Blob Storage Backend

Used when `SIM_STORAGE_BACKEND=azure`. Drop-in replacement with the same interface. Blobs are stored under a configurable container (default: `sim-collab-rooms`):

```
<roomId>/room.ydoc
<roomId>/room.sec
<roomId>/room.comments.json
```

Multi-instance safety: before writing `.ydoc`, the backend acquires a 30-second blob lease. If two server instances try to write the same room simultaneously, the lease prevents data corruption. The lease is released after the write completes.

Archived rooms move under an `archive/` prefix and are permanently deleted after a configurable TTL (default: 90 days).

### Room Lifecycle

| Phase | Trigger | Action |
|-------|---------|--------|
| Active | User edits | Debounced 500ms flush to storage |
| Idle | No edits for 30 days (configurable via `SIM_ROOM_ARCHIVE_DAYS`) | Moved to archive |
| Archived | In archive for 90 days (configurable via `SIM_ROOM_DELETE_DAYS`) | Permanently deleted |

A sweep runs every 24 hours to process archival and deletion.

---

## Remaining Roadmap Items

These items are NOT blockers for initial deployment but should be addressed for production readiness.

### Azure Integration Testing (priority)

The Azure Blob Storage backend (`server/storage-azure.cjs`) was developed against mocked Azure SDK responses, not a real storage account. After deployment, verify:

- Room persistence survives server restart
- Blob lease contention works under concurrent writes
- Archive/delete lifecycle runs correctly (archive after 30 days idle, delete after 90 days archived)

Test with `SIM_STORAGE_BACKEND=azure` and a real connection string.

### CI/CD Pipeline

Two workflows now exist in `.github/workflows/`:

- `ci.yml` — Unit + compliance + corpus + server + Playwright E2E + the
  Azurite integration job. Runs on every PR and push to `main`.
- `collab-server-deploy.yml` — Builds `Dockerfile.collab`, pushes to ACR,
  deploys to a Container App, and smoke-tests `/health`. Triggers on
  `server/**` changes in `main` and via `workflow_dispatch`.
- `main_asp-app-specsintact-modern.yml` — Existing frontend build +
  deploy to App Service (from PR #17).

Test commands run by CI:

```bash
npm test                      # 630 Vitest unit tests
npm run test:server           # 55 server-side tests (Node runner)
npm run test:compliance       # 42 compliance rule tests (Node runner)
npm run test:corpus           # 17 corpus precision/recall tests (Node runner)
npm run test:e2e              # 151 Playwright E2E tests (requires browser)
npm run test:azure:integration # 14 Azurite tests (Node runner, gated by env var)
```

Still not in CI:

```bash
npm run test:ufgs             # 12 UFGS tag coverage tests (Node runner)
npm run test:interop          # 28 interop roundtrip tests (Node runner)
npm run test:interop:encoding # 11 encoding fidelity tests (Node runner)
```

### User Acceptance Testing

Have an engineer use SecWriter for an actual spec editing task to identify workflow gaps. The tool replaces the Word-to-SpecsIntact round-trip workflow -- test that full cycle.

### Performance Profiling

Test with a large spec (1000+ blocks) to identify rendering bottlenecks. The parser is validated against 690 UFGS master set files, but UI performance under heavy editing load has not been profiled.
