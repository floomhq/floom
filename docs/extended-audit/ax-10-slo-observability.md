# ax-10 — SLO & observability

**Scope:** `apps/server/src/routes/health.ts`, `apps/server/src/routes/metrics.ts`, `apps/server/src/lib/sentry.ts`, `apps/server/src/index.ts` (global error handlers and boot).  
**Goal:** Map what the server exposes for health, metrics, and error reporting; propose **alerts**, **sampling / limits**, **blind spots** (especially job worker and triggers), and **mini runbooks** by failure class.  
**Method:** Direct file read; cross-check worker modules for error paths vs Sentry.

**Related:** `docs/PRODUCT.md` (three surfaces: web, MCP, HTTP); async jobs and triggers are product-critical paths that share the HTTP process.

---

## Executive summary

The server exposes a **lightweight liveness JSON** at `GET /api/health`, **Prometheus text** at `GET /api/metrics` when `METRICS_TOKEN` is set (otherwise **404**), and **optional Sentry** when `SENTRY_DSN` is set. **HTTP-layer** failures that reach Hono’s `onError` and **process-level** `unhandledRejection` / `uncaughtException` are forwarded to Sentry with path/method context where applicable. **Background workers** (job queue poller, schedule triggers poller) run **in the same Node process**; their tick-level errors are **logged only** and do **not** call `captureServerError` today.

**Implication:** You can alert credibly on **availability** (health), **aggregate run outcomes** and **rate-limit pressure** (metrics), and **uncaught HTTP/process errors** (Sentry). You **cannot** infer worker health from Sentry alone, and **per-request latency SLOs** are not first-class in the metrics export.

---

## 1. What exists today (short)

### 1.1 Health (`routes/health.ts`)

- **Route:** mounted at `/api/health` (see `index.ts`).
- **Behavior:** `200` + JSON: `status: 'ok'`, `service`, `version`, `apps` / `threads` counts from SQLite `COUNT(*)`, `timestamp`.
- **Strength:** Cheap probe that proves the process answers and the DB is readable for trivial queries.
- **Limit:** Not a deep readiness check (no write probe, no dependency checks, no distinction between “degraded” and “ok”).

### 1.2 Metrics (`routes/metrics.ts`)

- **Gated:** If `METRICS_TOKEN` is unset or empty → **404** (route hidden). If set → Bearer token required (**constant-time** compare), else **401**.
- **Cache:** Responses cached **15s** to avoid hammering SQLite on frequent scrapes.
- **Series (representative):**
  - `floom_apps_total` — gauge from DB.
  - `floom_runs_total{status="success|error|timeout|..."}` — cumulative counts from SQLite `runs` (not a Prometheus counter reset model; **process restart does not reset** these).
  - `floom_active_users_last_24h` — gauge, distinct `(user_id, device_id)`-style pairs in last 24h.
  - `floom_mcp_tool_calls_total{tool_name}` — **in-memory since process start** (`lib/metrics-counters.ts`).
  - `floom_rate_limit_hits_total{scope}` — **in-memory since process start** for scopes `ip`, `user`, `app`, `mcp_ingest`.
  - `floom_process_uptime_seconds` — **since process start**.

### 1.3 Sentry (`lib/sentry.ts`)

- **Init:** Only when `SENTRY_DSN` is set; `environment` from `NODE_ENV`.
- **Tracing:** `tracesSampleRate: 0.1` (10% of traces, when tracing is used by the SDK).
- **Privacy:** `beforeSend` recursively scrubs object keys matching secret-like patterns (`password`, `token`, `api_key`, etc.) on `request`, `extra`, `contexts`.
- **Public API:** `captureServerError(err, context?)` — no-op if Sentry never initialized.

### 1.4 Global errors (`index.ts`)

- **`app.onError`:** Calls `captureServerError(err, { path, method })`, logs to stderr, returns `500` + `{ error: 'internal_server_error' }`.
- **`process.on('unhandledRejection')`:** `captureServerError(reason)` + log.
- **`process.on('uncaughtException')`:** `captureServerError(err)` + log.

**Note:** `grep` shows `captureServerError` is **only** imported/used in `index.ts` — not in worker or trigger modules.

---

## 2. What to alert on (recommended)

Prioritize **user-visible failure modes** and **abuse signals**; keep **noise** down by combining rates over windows and using Sentry’s built-in grouping.

| Signal | Source | Suggested condition (indicative) | Rationale |
|--------|--------|-----------------------------------|-----------|
| **Availability** | Synthetic or LB probe → `GET /api/health` | Non-2xx or p95 latency above budget (e.g. > 2s) | Primary SLO for “service up”; health does DB reads. |
| **Run failure rate** | `floom_runs_total{status="error"}` vs `success` (or error / (success+error+timeout)) | Error share **spikes** vs 24h baseline, or sustained above threshold | Captures app/runtime failures persisted in DB; not the same as HTTP 5xx. |
| **Timeout rate** | `floom_runs_total{status="timeout"}` | Rate increase vs baseline | User-perceived “hang” outcomes; tune app timeouts vs SLO. |
| **Rate limit pressure** | `floom_rate_limit_hits_total` by `scope` | Sharp increase or sustained high **derivative** | Abuse, misconfigured clients, or legitimate traffic spike; scope tells you where to look. |
| **Process instability** | `floom_process_uptime_seconds` per instance | Resets / low uptime in a rolling window | Crash loops or frequent deploys; pair with platform logs. |
| **Sentry — new issues or volume** | Sentry project | New issue on release, or event volume anomaly | Catches uncaught exceptions and unhandled rejections including outside request path. |
| **Metrics auth noise** | LB or app logs if scraped | Spike in **401** on `/api/metrics` | Scanners or wrong token; usually not user-facing. |
| **Business anomaly (optional)** | `floom_active_users_last_24h` | Drop vs baseline | Product/infra signal; noisy for small tenants — use with care. |

**Not directly alertable from current export:** HTTP request latency percentiles, per-route error rates, queue depth, job age, trigger fire success — **see blind spots**.

---

## 3. Sampling limits & data semantics

| Mechanism | Limit / behavior | Operational note |
|-----------|------------------|------------------|
| **Sentry traces** | `tracesSampleRate: 0.1` | ~10% of **traced** transactions (exact behavior depends on SDK usage and whether spans are created). **Errors are not sampled away** by this rate; it is for performance traces. |
| **Sentry errors** | Full capture when `captureException` runs | `captureServerError` does not throttle; volume is driven by exception rate. Use Sentry **rate limits** / **inbound filters** at the project if needed. |
| **Metrics scrape cache** | **15s TTL** | Alerts on “last scrape” see up to 15s staleness; fine for minute-level SLOs. |
| **MCP / rate-limit counters** | **In-memory, per process** | **Reset on restart**; multi-replica **sum** across instances for totals. Not durable across crashes. |
| **`floom_runs_total`** | **SQLite-backed** | Survives restarts; reflects **historical** totals — use **derivatives** (increase over window) for “failures per minute”, not raw gauge logic. |
| **Metrics route** | **404** when `METRICS_TOKEN` unset | OSS / preview images may ship **without** metrics — alerts depending on Prometheus must **fail closed** (no silent “no data = ok”). |

---

## 4. Blind spots

### 4.1 Job worker (`services/worker.ts`)

- Runs a **polling loop** (`FLOOM_JOB_POLL_MS`, default 1000ms); `processOneJob` errors are **caught**, logged (`[worker] processOneJob error`), and the loop continues — **no `captureServerError`**.
- **Impact:** Systemic worker failures (e.g. repeated dispatch errors) may show up only in **logs** and indirectly as **stuck jobs** or **run rows** unless you alert on DB state or user reports.

### 4.2 Triggers worker (`services/triggers-worker.ts`)

- **Poll interval** `FLOOM_TRIGGERS_POLL_MS` (default 30s). Per-trigger failures log `[triggers-worker] failed trigger=...`; tick-level errors log `[triggers-worker] tick error`.
- **Catch-up policy:** If `next_run_at` is **> 1 hour** in the past, the trigger **skips fire** and resets schedule — only a **console.warn** path for drift.
- **Impact:** Missed schedules and silent skips are **not** visible in Sentry or Prometheus metrics as first-class series.

### 4.3 Same-process coupling

- HTTP server, job worker, and triggers worker share **one process** and **one** `floom_process_uptime_seconds`. **Health can be 200** while workers are **stuck** or **failing silently** (until DB or logs show pain).

### 4.4 HTTP vs run outcomes

- **`500` + Sentry:** Request-level uncaught errors in Hono pipeline.
- **Run `status=error`:** Recorded in DB for executed runs; may include **business/runtime** failures that returned structured errors **without** throwing to `onError`. Alert on **metrics/DB**, not only Sentry.

### 4.5 Missing first-class metrics

- No **histogram** of request latency or **run duration** in the Prometheus text export.
- No **queue depth**, **oldest queued job age**, or **worker heartbeat** counter.
- No **per-slug** or **per-trigger** failure series exposed on `/api/metrics`.

### 4.6 Multi-replica

- SQLite counters are **per deployment** (shared DB file in single-node setups). In any **multi-instance** story, **in-memory** metrics are **per replica**; aggregate in the scraper or TSDB.

---

## 5. Mini runbook (by failure class)

### 5.1 Health probe failing (non-200 / timeout)

- Confirm process: container / systemd / platform **restart policy** and last exit reason.
- Check **database** file path, permissions, and disk full (health runs `COUNT` on SQLite).
- Review **stderr** for boot failures (`boot()` in `index.ts` exits on **auth migration failure** in cloud mode).
- If behind a load balancer: verify **only one instance** or **shared DB** assumptions for your topology.

### 5.2 High `floom_runs_total` error rate

- Sample failing runs in DB (status, app_id, timestamps) and **user-facing output** if stored.
- Compare with **Sentry** for the same window — if **no** matching issues, failures are likely **inside the run pipeline** without throwing to `onError`.
- Check **recent deploys**, **manifest** changes, and **external dependencies** (OpenAPI targets, user secrets).

### 5.3 High timeout rate

- Inspect **timeout** configuration for jobs vs runs; check **slow upstream** APIs.
- Correlate with **trigger-scheduled** runs vs interactive runs (different expectations).

### 5.4 Spike in `floom_rate_limit_hits_total`

- Identify **scope** (`ip` vs `user` vs `app` vs `mcp_ingest`).
- **ip:** possible abuse or shared NAT; **user:** account-level automation; **app:** hot slug; **mcp_ingest:** admin ingest tool pressure.
- Validate **FLOOM_RATE_LIMIT_DISABLED** not set in prod by mistake; tune limits only after confirming legitimacy.

### 5.5 Sentry noise / PII concerns

- Confirm **`beforeSend`** scrubbing is sufficient for your payloads; avoid putting secrets in **non-matching** keys.
- Use Sentry **environment** and **release** tags for deployment correlation.
- If event volume is high, configure **inbound filters**, **quota**, or **alert rules** on **new** issues first.

### 5.6 Metrics endpoint 401 / 404

- **401:** Wrong or missing `Authorization: Bearer` — fix scraper secret rotation; expect **some** 401s from internet scanners if the URL is exposed.
- **404:** `METRICS_TOKEN` unset — intentionally **disabled**; enable metrics by setting token and redeploying.

### 5.7 Jobs not completing / triggers not firing (symptom, not a metric)

- **Workers:** Search logs for `[worker]` and `[triggers-worker]`; confirm `FLOOM_DISABLE_JOB_WORKER` / `FLOOM_DISABLE_TRIGGERS_WORKER` are **not** `true` in prod.
- **DB:** Inspect `jobs` and `runs` for stuck states; triggers table for `next_run_at` and `enabled`.
- **Recall:** Long downtime may trigger **catch-up skip** (>1h drift) — see `triggers-worker` warnings in logs.

### 5.8 `unhandledRejection` / `uncaughtException` in Sentry

- Treat as **critical**: may indicate **missing await**, **broken promise chains**, or **fatal** library errors.
- Correlate with **Node version** and **dependency** updates; reproduce locally with same `NODE_OPTIONS` if needed.

---

## 6. Closing note

This audit describes **as shipped**. Closing the largest gaps for SLO maturity usually means: **structured worker metrics + optional Sentry in worker catch paths**, **queue-age / depth signals**, and **HTTP latency histograms** — without changing product surfaces — so alerts can target **async** and **trigger** paths as clearly as the **request** path.
