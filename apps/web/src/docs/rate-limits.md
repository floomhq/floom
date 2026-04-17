# Rate limits

Floom enforces per-IP, per-user, and per-(IP, app) caps on every run endpoint so a single hostile caller cannot drain a creator's upstream budget.

## Default limits

| Endpoint | Anon (per IP) | Authed (per user) | Per (IP, app) |
|----------|---------------|-------------------|----------------|
| `POST /api/run` | 20/hr | 200/hr | 50/hr |
| `POST /api/:slug/run` | 20/hr | 200/hr | 50/hr |
| `POST /api/:slug/jobs` | 20/hr | 200/hr | 50/hr |
| `POST /mcp/app/:slug` | 20/hr | 200/hr | 50/hr |
| `POST /mcp` — `ingest_app` tool | 10/day (per IP) | 10/day (per user) | — |

Reads like `GET /api/hub`, `GET /api/health`, `GET /api/me/runs`, and MCP `tools/list` are never throttled. Storage is in-memory per container; rolling counters reset on restart. For multi-replica production the limiter swaps to Redis without touching route handlers.

## 429 response shape

When a cap is exceeded the response is HTTP `429` with a `Retry-After` header and a JSON body:

```json
{
  "error": "rate_limit_exceeded",
  "retry_after_seconds": 2831,
  "scope": "ip"
}
```

`scope` is one of `ip`, `user`, `app`, or `mcp_ingest`. `Retry-After` is in seconds.

Clients should read `Retry-After`, back off, and retry. The MCP admin surface returns the same shape wrapped as a tool error so MCP clients can handle it idiomatically.

## Env overrides

Tune or disable the limits via environment variables:

| Var | Default | Scope |
|-----|---------|-------|
| `FLOOM_RATE_LIMIT_DISABLED` | — | Set to `true` to skip every check (tests, admin scripts) |
| `FLOOM_RATE_LIMIT_IP_PER_HOUR` | `20` | Anonymous IP cap across all apps |
| `FLOOM_RATE_LIMIT_USER_PER_HOUR` | `200` | Authenticated-user cap across all apps |
| `FLOOM_RATE_LIMIT_APP_PER_HOUR` | `50` | (IP, app) pair cap |
| `FLOOM_RATE_LIMIT_MCP_INGEST_PER_DAY` | `10` | MCP `ingest_app` per caller per day |

For local development, `FLOOM_RATE_LIMIT_DISABLED=true` skips every check. For shared demo instances, lower `FLOOM_RATE_LIMIT_IP_PER_HOUR` to `5` to make the anon cap visible in under a minute of clicking.

## Implementation

Source: `apps/server/src/lib/rate-limit.ts`. The middleware runs before every `/run`, `/jobs`, and MCP route. The per-endpoint keys are `ip:<ip>`, `user:<uid>`, `(ip, app):<ip>:<slug>`, and `mcp_ingest:<principal>`. Rolling-window counters use a simple in-memory Map with a 5-minute sweep.
