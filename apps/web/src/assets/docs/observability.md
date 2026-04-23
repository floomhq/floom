# Observability and debugging

Floom ships basic operator observability now, plus per-run logs for users. It does **not** yet ship a full creator-facing per-app dashboard in the product.

## What ships today

- `GET /api/health` for a simple liveness check.
- `GET /api/metrics` for Prometheus-style metrics when `METRICS_TOKEN` is configured.
- Optional **Sentry** on the server when `SENTRY_DSN` is set.
- Per-run logs and status on the run detail surfaces.

## Metrics

When `METRICS_TOKEN` is set, `/api/metrics` exposes:

- total registered apps
- total runs by status
- active users in the last 24 hours
- MCP tool calls since process start
- process uptime
- rate-limit hits by scope

The metrics response is cached for 15 seconds so a busy scrape does not hammer SQLite.

## Error tracking

- Sentry is **off by default**.
- When enabled, server exceptions are captured with secret scrubbing on common key names like `token`, `api_key`, `authorization`, and `cookie`.
- The current repo does **not** claim full worker-level error coverage in Sentry for every background path.

## User and creator debugging

- Run detail pages show final status, outputs, and a **log tail** of captured stdout and stderr.
- Public shared runs are redacted and do **not** expose live logs.
- A creator-facing per-app logs and error-rate dashboard is still tracked separately as product work.

## What is missing today

- No public status page is linked from the product.
- No shipped per-app alert routing for creators.
- No first-class latency SLO page in the product.

## Related pages

- [/docs/security](/docs/security)
- [/docs/workflow](/docs/workflow)
- [/docs/reliability](/docs/reliability)
