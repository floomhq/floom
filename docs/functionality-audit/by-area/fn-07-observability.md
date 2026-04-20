# fn-07 — Observability (`metrics`, `og`, Sentry, server version, counters)

**Scope (workspace root `apps/server/src/`):** `routes/metrics.ts`, `routes/og.ts`, `lib/sentry.ts`, `lib/server-version.ts`, `lib/metrics-counters.ts`.

**Product lens (`docs/PRODUCT.md`):** Hosting and the three surfaces (web form, MCP, HTTP) depend on reliable ops signals without exposing end-user secrets. Observability here is operator- and platform-facing; OG images support discoverability of `/p/:slug` without becoming a covert data channel.

---

## Summary

| Area | Verdict |
|------|---------|
| Auth on `/api/metrics` | Strong when enabled: `METRICS_TOKEN` gates exposure; constant-time bearer compare; route hidden (404) when unset. |
| PII in OG images | Email addresses are not rendered; author line may show display name or local-part of email-derived handle—expected public-preview semantics; UGC title/description can appear. |
| Sentry scrubbing | Recursive key-based redaction for common secret-like names on `request`, `extra`, and `contexts`; gaps possible for nested string payloads and other event fields Sentry attaches. |
| Metric cardinality | Mostly bounded; `floom_mcp_tool_calls_total{tool_name}` grows with distinct tool names; `floom_runs_total{status}` can grow if non-canonical statuses exist in DB. |

---

## `routes/metrics.ts` — authentication

- **Enablement:** Metrics are off unless `METRICS_TOKEN` is set and non-empty. When unset, `GET /api/metrics` returns **404** (not an empty body), which avoids advertising the endpoint.
- **Credential:** `Authorization: Bearer <token>` only; comparison uses **constant-time** equality against the full expected token (mitigates timing leaks vs naive string compare).
- **Interaction with global auth:** `lib/auth.ts` exempts `/api/metrics` from `FLOOM_AUTH_TOKEN` so a scraper can authenticate **only** with `METRICS_TOKEN`. That is intentional: Prometheus does not need the hub-wide token. Security relies on `METRICS_TOKEN` being secret and TLS in transit.
- **Unauthenticated access:** When `METRICS_TOKEN` is set, anyone who knows the token can read aggregates; there is no per-user authorization—appropriate for an internal metrics scrape.

---

## `routes/metrics.ts` — cardinality and data sensitivity

- **Aggregate-only exposure:** Exported series are counts and gauges (`floom_apps_total`, `floom_runs_total`, `floom_active_users_last_24h`, uptime, MCP tool calls, rate-limit hits). No per-user IDs or raw request fields appear in the text exposition.
- **`floom_active_users_last_24h`:** Implements a distinct count over `(user_id, device_id)`-style identity in SQL; the **number** is emitted, not the identifiers.
- **`floom_runs_total{status}`:** Documented statuses `success`, `error`, `timeout` are always emitted; additional DB statuses are emitted with escaped labels—**unbounded or numerous distinct `status` values in `runs` would increase label cardinality**.
- **`floom_mcp_tool_calls_total{tool_name}`:** Labels come from MCP tool registration (`mcp.ts`: action names or sanitized app slug for `run`). **Cardinality scales with the number of distinct tool names** across deployed manifests (typically moderate; pathological manifests could add many series). A `_none` sentinel is used when there are zero entries.
- **`floom_rate_limit_hits_total{scope}`:** Four fixed scopes—**low cardinality**.
- **Caching:** 15s response cache reduces SQLite load under frequent scrapes; stale by at most one TTL—acceptable for Prometheus-style polling.

---

## `routes/og.ts` — PII and public surface

- **No auth:** `GET /og/main.svg` and `GET /og/:slug.svg` (pattern `[a-z0-9][a-z0-9-]*\.svg`) are **public**, `Cache-Control: public, max-age=300`, as required for crawlers and chat previews.
- **Database:** Loads app by slug; `LEFT JOIN users` for `author_name` and `author_email`.
- **Email in output:** Full **email is not** placed in the SVG. If display name is absent, the author line uses the **local-part** of the email (before `@`) as a handle—still potentially identifying but not the full mailbox address.
- **Other fields:** Title and description are app metadata (UGC). They are XML-escaped and truncated—appropriate for OG cards; operators should treat them as **public marketing text**, not secret.
- **Missing app:** Returns a generic Floom card (200) instead of 404—avoids broken images; no user data leaked beyond static copy.

---

## `lib/sentry.ts` — scrubbing

- **Activation:** No-op until `SENTRY_DSN` is set; `initSentry()` runs once.
- **Sampling:** `tracesSampleRate: 0.1` limits trace volume.
- **Custom scrubbing:** `beforeSend` runs `scrubSecrets` on `event.request`, `event.extra`, and `event.contexts`, redacting values whose **keys** match `(password|token|api[_-]?key|authorization|secret|cookie)` (case-insensitive). Recursion depth is capped at 8.
- **Strengths:** Catches nested objects under those keys; avoids throwing from `captureServerError`.
- **Limits:** Values that are secrets but stored under innocuous keys (e.g. a field literally named `value`) are **not** redacted by key pattern. `event.breadcrumbs` and some SDK-populated fields are **not** explicitly scrubbed in this file. Standard Sentry server defaults may still apply for some data classes—verify against deployment needs for strict PII policies.

---

## `lib/server-version.ts`

- **Behavior:** Reads `version` from `apps/server/package.json` via `createRequire`—single source for health/OpenAPI as documented.
- **PII / secrets:** None; semver string only.

---

## `lib/metrics-counters.ts`

- **Storage:** In-process `Map`s; **reset on process restart** (documented; aligns with rate-limit store semantics).
- **MCP:** `recordMcpToolCall(toolName)` keys by tool name string—feeds **`floom_mcp_tool_calls_total` label cardinality** as above.
- **Rate limits:** Fixed union of scopes—bounded.
- **Scale note:** Comment acknowledges Redis/StatsD for multi-instance or sharded deployments; current maps are **not shared across replicas**—each instance reports its own counters for MCP/rate-limit series, which matters if Prometheus scrapes multiple pods without aggregation logic.

---

## Cross-cutting notes

- **Operator ICP:** A non-developer hoster still sets env vars; `METRICS_TOKEN` and optional `SENTRY_DSN` fit that model. Missing token leaves metrics invisible (404), which is safe by default.
- **Three surfaces:** MCP tool counters tie to MCP usage; metrics do not replace per-request logs for HTTP/MCP/web form debugging—they complement aggregates.

---

## Suggested follow-ups (non-blocking)

1. Document or alert on **high-cardinality** `status` or `tool_name` in production if DB/manifest drift is observed.
2. If Sentry must meet strict PII policies, audit **breadcrumbs** and **default user/context** behavior and extend scrubbing beyond key-based recursion if needed.
3. For **multi-replica** deployments, plan aggregation or external counters so MCP/rate-limit counters reflect cluster-wide behavior.
