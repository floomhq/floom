# fn-01 — Bootstrap (`apps/server/src/index.ts`)

**Scope:** `apps/server/src/index.ts` only (full file read). **Lens:** `docs/PRODUCT.md` (ICP, three surfaces: web `/p/:slug`, MCP `/mcp`, HTTP `/api/:slug/run`), security, operability. **Code changes:** none (audit only).

---

## Summary

- **S1 — Edge policy:** CORS is split into restricted (credentials + allow-listed origins) vs open (`origin: '*'`, no credentials) for different path prefixes; `securityHeaders` wraps all responses before route bodies, with renderer CSP ownership deferred to `middleware/security.ts` (exempt prefixes). This matches a defense-in-depth posture for cookie-bearing surfaces vs public run/MCP discovery.
- **S2 — Auth and limits:** `FLOOM_AUTH_TOKEN` gates `/api/*`, `/mcp/*`, and `/p/*` via `globalAuthMiddleware` (with documented exceptions only for `/api/health` and `/api/metrics` in `lib/auth.ts`). Rate limiting is mounted after that gate on POST-heavy run/job/MCP app paths.
- **S3 — Routing and collisions:** Explicit `/api/run` registration precedes `/api/:slug/run` to avoid param shadowing; `/hook` is mounted outside `/api/*` so external webhooks are not subject to the global bearer gate. Several public endpoints (`/openapi.json`, optional static `/*`) sit outside the `/api/*` middleware prefix.
- **S4 — Startup:** `boot()` runs cloud auth migrations (fail-fast), `seedFromFile()` (errors logged, boot continues), optional async `ingestOpenApiApps`, fire-and-forget `backfillAppEmbeddings`, job and triggers workers (env opt-out), and `startFastApps()` before `serve()`. Sentry is initialized at module load; `onError` and `process` handlers report to Sentry when configured.

---

## Findings

### 1 — `/p/*` global bearer gate vs web form surface (ICP / three surfaces)

- **Severity:** High  
- **Evidence:** `apps/server/src/index.ts:140–145` (`app.use('/p/*', globalAuthMiddleware)`); `apps/server/src/lib/auth.ts:54–69` (token required for all paths except `/api/health` and `/api/metrics`; `?access_token=` documented for GET).  
- **Issue:** With `FLOOM_AUTH_TOKEN` set, ordinary browser navigation to `/p/:slug` does not send `Authorization` or `?access_token=`, so the HTML shell for the web form surface is rejected with 401 before the SPA static handler runs. `docs/PRODUCT.md:27–28` states all paths must expose the same three surfaces; a shared install token intended to lock APIs unintentionally breaks the primary web permalink for operators who follow “lock down the server” guidance.  
- **Recommended fixes:** Narrow `globalAuthMiddleware` on `/p/*` to API-only subpaths if any exist, or exempt `GET /p/*` HTML (same risk tradeoff as metrics), or document that public permalinks require `?access_token=` / reverse-proxy path splits; align product docs with whichever contract is chosen.

### 2 — Stripe webhook vs comment and `FLOOM_AUTH_TOKEN`

- **Severity:** High  
- **Evidence:** `apps/server/src/index.ts:143` (all `/api/*` through `globalAuthMiddleware`); `apps/server/src/index.ts:198–202` (comment claims `/api/stripe` webhook is not gated by `FLOOM_AUTH_TOKEN`); `apps/server/src/lib/auth.ts:58–69` (no exemption for `/api/stripe/webhook`).  
- **Issue:** When the global token is set, `POST /api/stripe/webhook` still hits the bearer middleware first; Stripe does not send `FLOOM_AUTH_TOKEN`. The in-file comment is misleading and live Stripe Connect webhooks likely return 401 in that configuration.  
- **Recommended fixes:** Exempt `POST /api/stripe/webhook` in `globalAuthMiddleware` (signature verification remains the auth), or mount the webhook under `/hook`/`/webhook` like the generic webhook router (`apps/server/src/index.ts:217–220`); update the comment to match behavior.

### 3 — CORS comment vs implementation for `/api/hub`

- **Severity:** Medium  
- **Evidence:** `apps/server/src/index.ts:54–64` (comment: restricted for “POST/PATCH/DELETE on /api/hub”); `apps/server/src/index.ts:107–109` (`app.use('/api/hub/*', openCors)` and `app.use('/api/hub', openCors)`).  
- **Issue:** Hub mutations use the same open CORS policy as public GETs. Credentialed cross-origin abuse is mitigated by `credentials: false` and `origin: '*'`, but the comment promises a stricter split than the code implements; future changes might assume restricted CORS for mutations.  
- **Recommended fixes:** Either implement method-based or mutation-only restricted CORS for hub writes, or revise the header comment to match the deliberate “hub entirely public CORS” design.

### 4 — `uncaughtException` / `unhandledRejection` handlers do not exit

- **Severity:** Medium  
- **Evidence:** `apps/server/src/index.ts:132–139` (handlers log and `captureServerError` only).  
- **Issue:** After `uncaughtException`, the Node process may be in an undefined state; continuing to serve traffic can mask corruption and duplicate Sentry noise. `unhandledRejection` similarly leaves the process running.  
- **Recommended fixes:** After logging/Sentry for `uncaughtException`, call `process.exit(1)` (or delegate to a supervisor); for `unhandledRejection`, either exit in production or document intentional continuation and monitor.

### 5 — `onError` envelope vs JSON-RPC / MCP clients

- **Severity:** Low  
- **Evidence:** `apps/server/src/index.ts:126–131` (`return c.json({ error: 'internal_server_error' }, 500)`).  
- **Issue:** MCP and some HTTP clients expect JSON-RPC-shaped errors; a generic wrapper is fine for many REST routes but may surprise MCP integrators debugging “non-RPC” 500 bodies.  
- **Recommended fixes:** Optionally branch on `Accept` or path prefix (`/mcp`) in `onError` to return an MCP-consistent error shape; at minimum document the generic envelope in operator docs.

### 6 — `/openapi.json` outside global auth

- **Severity:** Low  
- **Evidence:** `apps/server/src/index.ts:246–599` (`app.get('/openapi.json', ...)` — not under `/api/*`).  
- **Issue:** With `FLOOM_AUTH_TOKEN` set, API routes are gated but the hand-written OpenAPI document remains unauthenticated, slightly widening reconnaissance surface for a “locked” demo host.  
- **Recommended fixes:** If parity with “all APIs gated” is desired, move under `/api/openapi.json` and exempt only health/metrics as today, or add optional shared-token check.

### 7 — OpenAPI ingest and embeddings failures are non-fatal at boot

- **Severity:** Low (operability)  
- **Evidence:** `apps/server/src/index.ts:943–955` (`ingestOpenApiApps` `.catch` logs only); `957–960` (`backfillAppEmbeddings().catch`).  
- **Issue:** Server listens even if config-driven ingest never succeeded; operators may think apps are registered when they are not. Aligns with ICP “don’t need infra fluency” only if surfaced clearly in UI/logs.  
- **Recommended fixes:** Stronger startup banner when `FLOOM_APPS_CONFIG` is set but ingest fails; optional fail-fast flag for strict deployments.

### 8 — Dual mount on `/api/hub` (`hubRouter` + `hubTriggersRouter`)

- **Severity:** Low  
- **Evidence:** `apps/server/src/index.ts:171,216` (`app.route('/api/hub', hubRouter)` then `app.route('/api/hub', hubTriggersRouter)`).  
- **Issue:** Depends on Hono merging sub-apps correctly; accidental overlapping routes could cause subtle ordering bugs.  
- **Recommended fixes:** Consolidate triggers under one router or add an integration test that hits both hub and hub-triggers paths after a single mount.

---

## Evidence index (this file)

| Topic | Lines |
|--------|--------|
| CORS split (restricted vs open) | `54–117` |
| `securityHeaders` | `119–122` |
| `onError` | `126–131` |
| `process` handlers | `132–139` |
| `globalAuthMiddleware` + `/p/*` | `140–148` |
| Rate limit mounts | `150–164` |
| Route registration order (`/api/run` before `:slug`) | `166–181` |
| `/hook` outside `/api/*` | `217–220` |
| Better Auth cloud mount | `224–241` |
| Static SPA + exclusions | `623–627`, `804–814` |
| `boot()` sequence | `918–988` |

---

## Alignment with `docs/PRODUCT.md`

- **ICP / three surfaces:** Bootstrap explicitly wires HTTP run (`/api/:slug/run`), MCP (`/mcp`), and web assets + `/p/:slug` SSR rewrites (`630–905`). Finding **#1** flags tension between `FLOOM_AUTH_TOKEN` and the web permalink pillar.  
- **Load-bearing paths:** This file does not delete anything; it **mounts** MCP (`routes/mcp.ts`), jobs/run (`routes/jobs.ts`, `routes/run.ts`), seed/docker-related startup (`seedFromFile`, workers). Per PRODUCT table, those routes/services remain load-bearing; audit notes operational coupling only.  
- **Host / Docker:** PRODUCT warns self-hosted-in-container repo deploy is unsupported; `boot()` still starts workers and fast-apps sidecar unconditionally (modulo env flags), which is correct for “host runs Floom” but worth documenting for operators who confuse container roles.

---

## Recommended fixes (rollup)

1. Reconcile **`FLOOM_AUTH_TOKEN`** with **Stripe webhook** and **`/p/:slug` GET** (code or docs; prefer code if webhooks and permalinks must work with a global lock).  
2. Tighten **process-level error policy** for production hardening.  
3. Align **CORS comments** with behavior or implement the described hub mutation split.  
4. Optional: **MCP-aware `onError`**, **OpenAPI.json** auth parity, **stricter ingest observability**.
