# Azure Sysadmin Checklist — SpecsIntact Modern

Everything the sysadmin needs to provision and configure on the Azure
tenant so the two GitHub Actions workflows can build, deploy, and verify
SpecsIntact Modern. Tick each item off in order; later steps depend on
earlier ones.

This checklist assumes a fresh tenant. If some resources already exist,
skip the creation step but still verify the identity/role assignments.

---

## 0. Inventory

| Component | Artifact | Owner |
|-----------|----------|-------|
| Frontend static site | `dist/` from Vite build | `asp-app-specsintact-modern` App Service (already deployed via PR #17) |
| Collab server | `Dockerfile.collab` → container image | Azure Container Apps (to be provisioned) |
| Room persistence | `.ydoc` / `.SEC` / `.comments.json` blobs | Azure Blob Storage |
| SSO identity | JWT validation against Entra | Azure Entra ID (deferred until tenant config is ready) |

---

## 1. Resource Group & Naming

- [ ] Create (or reuse) a resource group in a region close to users, e.g.
      `rg-specsintact-modern` in `northcentralus`.
- [ ] Decide a short prefix for resource names. Examples below use `sim-`.

---

## 2. Azure Container Registry (ACR)

- [ ] Create an ACR: `sim<env>acr` (3–50 chars, lowercase alphanumeric).
      - SKU `Basic` is sufficient for a single image.
      - Enable **admin user = disabled**. Use RBAC instead.
- [ ] Record `<acr>.azurecr.io` as `ACR_LOGIN_SERVER`.

---

## 3. Storage Account (room persistence)

- [ ] Create a general-purpose v2 storage account: `sim<env>store`.
      - Replication: LRS (can upgrade later).
      - **Disable** public blob access at the account level.
      - **Enable** soft delete for blobs (≥ 7 days) — protects against
        accidental `deleteRoom`.
- [ ] Create a blob container: **`sim-collab-rooms`**.
      (The default `SIM_AZURE_STORAGE_CONTAINER` value.)
- [ ] Record the blob endpoint URL, e.g.
      `https://sim<env>store.blob.core.windows.net`.

---

## 4. Container Apps Environment + Container App

- [ ] Create a Container Apps environment: `sim-cae` in the same region.
- [ ] Create the Container App: `sim-collab-server`.
      - Image: pull from the ACR above (start with a public `nginx`
        placeholder; the deploy workflow will replace it).
      - **Ingress**: enabled, **external**, **target port = 1235**.
      - **Transport**: `http` (Container Apps auto-detects WebSockets on
        the same port).
      - **Allow insecure traffic**: off.
      - Scale rules: minimum 1 replica (collab state lives in-memory per
        room; scaling to 0 drops active sessions).
      - CPU/memory: start with 0.5 vCPU / 1 GiB; raise if `/health`
        latency climbs.
- [ ] Enable **system-assigned managed identity** on the Container App.
      (Record the principal ID — referenced in Section 5.)

> **Single-port ingress note.** Container Apps exposes one HTTP ingress
> port per app. Pointing it at 1235 makes the REST API and `/health`
> reachable. The WebSocket listener on 1234 is NOT reachable through the
> same FQDN until one of:
>
> 1. Server refactor to share a single `http.Server` between the HTTP
>    handler and the `ws.WebSocketServer({ noServer: true })` upgrade
>    handler (small, preferred).
> 2. Azure Front Door or Application Gateway in front with path-based
>    routing (`/ws/*` → 1234, `/api/*` → 1235).
>
> Neither is blocking for the initial deploy.

---

## 5. Identity & RBAC

Use a single **GitHub OIDC federated identity** for the workflow. No
long-lived secrets in the repo.

- [ ] Create an Entra ID app registration: `sim-github-deploy`.
- [ ] Add a **federated credential** on that app:
      - Scenario: GitHub Actions
      - Org: `haleyaldrich`
      - Repo: `specsintact-modern`
      - Entity type: Branch
      - Branch: `main`
- [ ] Optionally add a second federated credential for the deploy branch
      (`claude/project-status-summary-DrVWn`) or for pull-request runs.
- [ ] Record the app's **Application (client) ID** and **Tenant ID**.
- [ ] Assign the following roles (scoped as narrowly as possible):

| Principal | Role | Scope |
|-----------|------|-------|
| `sim-github-deploy` app | **AcrPush** | ACR from Section 2 |
| `sim-github-deploy` app | **Contributor** | Container App from Section 4 |
| Container App's managed identity | **AcrPull** | ACR from Section 2 |
| Container App's managed identity | **Storage Blob Data Contributor** | Storage account from Section 3 (or just the container) |

---

## 6. GitHub Repository Secrets

Add these under **Settings → Secrets and variables → Actions → New
repository secret**. All values are non-sensitive for the Azurite job; the
production secrets are identifiers, not credentials.

- [ ] `AZURE_CLIENT_ID` — from Section 5
- [ ] `AZURE_TENANT_ID` — from Section 5
- [ ] `AZURE_SUBSCRIPTION_ID` — the subscription holding all resources
- [ ] `ACR_LOGIN_SERVER` — e.g. `simprdacr.azurecr.io`
- [ ] `AZURE_RESOURCE_GROUP` — e.g. `rg-specsintact-modern`
- [ ] `COLLAB_CONTAINER_APP_NAME` — e.g. `sim-collab-server`
- [ ] `SIM_COLLAB_ORIGIN` — exact frontend URL, e.g.
      `https://asp-app-specsintact-modern-ehfnenhdd3h4avaf.northcentralus-01.azurewebsites.net`

Entra ID secrets (deferred, add once Section 10 is done):

- [ ] `VITE_AZURE_AD_CLIENT_ID`
- [ ] `VITE_AZURE_AD_TENANT_ID`

---

## 7. App Service (Frontend) Configuration

The existing `asp-app-specsintact-modern` App Service already runs the
Vite-built frontend. Verify these settings:

- [ ] **Configuration → Application settings**:
      - `WEBSITES_ENABLE_APP_SERVICE_STORAGE` = `false` (default is fine)
      - Once the collab server FQDN is known, add:
        - `VITE_COLLAB_WS_URL` = `wss://<collab-fqdn>` (build-time)
        - `VITE_COLLAB_HTTP_URL` = `https://<collab-fqdn>` (build-time)
      - (These are consumed by `npm run build`; if the current deploy
        pipeline builds on the App Service host, add as env vars;
        otherwise bake them into the GitHub Actions build step.)
- [ ] **Configuration → General settings → Web sockets** = **On**
      (needed only if the frontend app serves the WS path itself; N/A
      once the collab server lives on Container Apps).
- [ ] TLS is handled automatically by App Service (managed cert on
      `*.azurewebsites.net`). Confirm HTTPS-only is **on**.

---

## 8. Collab Server Runtime Configuration

The deploy workflow sets these on each revision, but the sysadmin should
verify they appear after the first run:

| Env var | Value | Notes |
|---------|-------|-------|
| `SIM_AUTH_PROVIDER` | `none` | Placeholder until Entra is wired (Section 10) |
| `SIM_STORAGE_BACKEND` | `azure` | |
| `SIM_AZURE_STORAGE_CONTAINER` | `sim-collab-rooms` | |
| `SIM_AZURE_STORAGE_ACCOUNT_URL` | `https://sim<env>store.blob.core.windows.net` | Set this **manually** — not in the workflow. Enables Managed Identity auth from the Container App. |
| `SIM_COLLAB_ORIGIN` | Frontend App Service URL | |
| `SIM_LOG_FORMAT` | `json` | |
| `SIM_RATE_LIMIT_*` | Defaults (10 / 60 / 20 per min) | Raise if E2E bots need more |
| `COLLAB_HOST` | `0.0.0.0` | |
| `COLLAB_PORT` | `1234` | |
| `COLLAB_HTTP_PORT` | `1235` | Must match the Container App ingress target port |

---

## 9. Observability

- [ ] Enable **Log Analytics** on the Container Apps environment (default
      during creation).
- [ ] Add a Log Analytics query alert for:
      - `ContainerAppConsoleLogs_CL | where Log_s contains "persist-failed"`
        for ≥ 3 events in 10 min.
- [ ] Set up an Azure Monitor availability test hitting
      `https://<collab-fqdn>/health` every 5 minutes from 2+ regions.
- [ ] Enable **diagnostic settings** on the storage account sending logs
      to the same Log Analytics workspace (captures blob-lease failures).

---

## 10. Entra ID / MSAL SSO (deferred — flip to `jwt` when ready)

- [ ] Create an Entra ID app registration: `sim-webapp`.
      - Platform: Single-page application.
      - Redirect URI: the frontend App Service URL (`https://...`).
      - Expose an API scope like `user_impersonation`.
      - Note `Application (client) ID` and `Directory (tenant) ID`.
- [ ] Add those IDs as GitHub repo secrets
      (`VITE_AZURE_AD_CLIENT_ID`, `VITE_AZURE_AD_TENANT_ID`).
- [ ] Rebuild the frontend with those env vars set.
- [ ] On the collab server, switch env:
      - `SIM_AUTH_PROVIDER` = `jwt`
      - `SIM_AUTH_JWT_ISSUER` = `https://login.microsoftonline.com/<tenant-id>/v2.0`
      - `SIM_AUTH_JWT_AUDIENCE` = `<client-id>` (the API app if you
        separated SPA ↔ API, otherwise the SPA's client ID)
      - `SIM_AUTH_JWT_PUBLIC_KEY` or switch to JWKS fetch if the server
        is extended to support it (currently `auth-jwt.cjs` expects a
        static HS256 secret or RS256 PEM path).

---

## 11. First Deploy — Verification

Once secrets are in and Section 4's Container App exists (even with a
placeholder image):

- [ ] Trigger `collab-server-deploy` via **Actions → Run workflow**.
- [ ] Watch the "Smoke test /health" step pass (HTTP 200, `status: ok`).
- [ ] Manually curl from a laptop:
      `curl https://<fqdn>/health` → `{"status":"ok",...}`.
- [ ] Open the frontend URL with `?room=smoke` in two browser tabs; each
      should see the other via the Presence Bar and edits should sync.

---

## 12. Ongoing Maintenance

- [ ] Quarterly: rotate the GitHub OIDC federated credential if the
      federated identity scope changes (branch renames, new protected
      branches, etc.).
- [ ] Monthly: review the `archive/` prefix in the storage container;
      confirm archival/deletion cadence matches `SIM_ROOM_ARCHIVE_DAYS`
      and `SIM_ROOM_DELETE_DAYS`.
- [ ] Before a release: trigger the Azurite integration job on a PR;
      green indicates the Azure SDK contract is unchanged.
