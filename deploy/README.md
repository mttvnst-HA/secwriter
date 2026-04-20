# Deployment Guide

Reference configs for deploying SpecsIntact Modern with TLS termination.

## Architecture

```
                          ┌─────────────────────┐
  Browser ──── HTTPS ────►│  Reverse Proxy       │
  (wss://)                │  (nginx or Caddy)    │
                          │                      │
                          │  /ws/*  ──► :1234    │  WebSocket (Yjs CRDT)
                          │  /api/* ──► :1235    │  HTTP REST API
                          │  /*    ──► dist/     │  Static frontend
                          └─────────────────────┘
```

Both collab server ports bind to `127.0.0.1` — the reverse proxy is the only external entry point.

## Quick Start

```bash
# 1. Build the frontend
VITE_COLLAB_WS_URL=wss://collab.example.com/ws \
VITE_COLLAB_HTTP_URL=https://collab.example.com/api \
npm run build

# 2. Start the collab server
SIM_AUTH_PROVIDER=jwt \
SIM_AUTH_JWT_SECRET=your-secret-here \
SIM_COLLAB_ORIGIN=https://collab.example.com \
SIM_LOG_FORMAT=json \
node server/collab-server.cjs

# 3. Start the reverse proxy
#    nginx: sudo nginx -c /path/to/deploy/nginx.conf
#    Caddy: caddy run --config /path/to/deploy/Caddyfile
```

## Client URL Configuration

The frontend reads collab server URLs from Vite env vars at build time:

| Variable | Example | Default (dev) |
|----------|---------|---------------|
| `VITE_COLLAB_WS_URL` | `wss://collab.example.com/ws` | `ws://127.0.0.1:1234` |
| `VITE_COLLAB_HTTP_URL` | `https://collab.example.com/api` | `http://127.0.0.1:1235` |

Set these before `npm run build`. Vite inlines them into the JS bundle.

## Server Environment Variables

| Variable | Production value | Default |
|----------|-----------------|---------|
| `COLLAB_HOST` | `127.0.0.1` (keep loopback) | `127.0.0.1` |
| `COLLAB_PORT` | `1234` | `1234` |
| `COLLAB_HTTP_PORT` | `1235` | `1235` |
| `SIM_AUTH_PROVIDER` | `jwt` | `none` |
| `SIM_AUTH_JWT_SECRET` | (your HS256 secret) | - |
| `SIM_AUTH_JWT_PUBLIC_KEY` | (path to RS256 PEM) | - |
| `SIM_AUTH_JWT_ISSUER` | (expected issuer) | - |
| `SIM_AUTH_JWT_AUDIENCE` | (expected audience) | - |
| `SIM_COLLAB_ORIGIN` | `https://collab.example.com` | `*` |
| `SIM_LOG_FORMAT` | `json` | `text` |
| `SIM_STORAGE_BACKEND` | `local` or `azure` | `local` |
| `SIM_RATE_LIMIT_WS_PER_MIN` | `10` | `10` |
| `SIM_RATE_LIMIT_HTTP_READ_PER_MIN` | `60` | `60` |
| `SIM_RATE_LIMIT_HTTP_WRITE_PER_MIN` | `20` | `20` |
| `SIM_ROOM_ARCHIVE_DAYS` | `30` | `30` |
| `SIM_ROOM_DELETE_DAYS` | `90` | `90` |

**Security notes:**
- Keep `COLLAB_HOST=127.0.0.1`. Setting `0.0.0.0` exposes the server directly, bypassing TLS.
- Set `SIM_COLLAB_ORIGIN` to the exact origin (not `*`) to restrict CORS.
- The Node.js server handles CORS headers. Do not add CORS headers in the proxy config — duplicate headers cause browser errors.

## Log Sanitization

y-websocket v1 passes JWT tokens as `?token=<JWT>` in WebSocket URLs (see `server/collab-server.cjs` line 267). Without log sanitization, tokens appear in reverse proxy access logs.

- **nginx**: A `map` directive rewrites `?token=...` to `?token=[REDACTED]` in a custom `log_format`.
- **Caddy**: The `log` directive uses a field filter to delete the `token` query parameter.

HTTP API requests use the standard `Authorization: Bearer <token>` header, which is not logged by default.

## Health Check

```
GET https://collab.example.com/api/health
```

Returns `200 OK` with `{ status, rooms, connections }`. Unauthenticated — suitable for load balancer probes.

## Configs

- [`nginx.conf`](nginx.conf) — nginx 1.18+. Requires manual TLS certificate setup.
- [`Caddyfile`](Caddyfile) — Caddy 2.6+. Auto-provisions TLS via Let's Encrypt.

Both configs serve the frontend static build from `dist/` with SPA fallback (`try_files` to `/index.html`).
