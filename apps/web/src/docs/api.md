# API reference

Floom exposes three admin endpoints, a per-app run endpoint, an async job queue per app, an in-app feedback channel, plus two MCP surfaces. All JSON in, JSON out. Every run endpoint is rate-limited (see [Rate limits](/docs/rate-limits)).

A machine-readable `openapi.json` document is served at `http://localhost:3051/openapi.json` on every self-hosted instance.

## `GET /api/hub`

List every registered app on the instance. Public, never rate-limited.

```bash
curl http://localhost:3051/api/hub
```

Response:

```json
[
  {
    "slug": "petstore",
    "display_name": "Petstore",
    "description": "OpenAPI 3.0 reference pet store.",
    "category": "developer-tools",
    "actions_count": 19,
    "visibility": "public"
  }
]
```

## `POST /api/hub/ingest`

Create or update an app from an OpenAPI spec. In Cloud mode, gated by Better Auth session; in OSS mode, open.

Request:

```bash
curl -sX POST http://localhost:3051/api/hub/ingest \
  -H 'content-type: application/json' \
  -d '{
    "openapi_url": "https://petstore3.swagger.io/api/v3/openapi.json",
    "slug": "petstore",
    "display_name": "Petstore"
  }'
```

Accepts either `openapi_url` (fetched server-side) or inline `openapi_spec` (full JSON object). Returns:

```json
{
  "slug": "petstore-a1b2c3",
  "permalink": "http://localhost:3051/p/petstore-a1b2c3",
  "mcp_url": "http://localhost:3051/mcp/app/petstore-a1b2c3",
  "created": true
}
```

## `GET /api/hub/:slug`

Fetch one app by slug with full manifest, every operation's input schema, outputs, and required secrets.

## `POST /api/:slug/run`

Run an operation synchronously. Returns when the upstream call completes, times out, or errors.

Request shape:

```json
{
  "action": "listPets",
  "inputs": { "limit": 3 }
}
```

cURL:

```bash
curl -sX POST http://localhost:3051/api/petstore/run \
  -H 'content-type: application/json' \
  -d '{"action":"listPets","inputs":{"limit":3}}'
```

Response:

```json
{
  "run_id": "run_01HXYK...",
  "status": "succeeded",
  "output": { "pets": [...] },
  "error": null,
  "duration_ms": 820
}
```

Status is `succeeded`, `error`, or (when rate-limited) `rate_limit_exceeded`. Rate-limited responses are HTTP `429` with a `Retry-After` header. Limits: 20/hr per anon IP, 200/hr per authenticated user, 50/hr per (IP, app). See [Rate limits](/docs/rate-limits).

## `POST /api/:slug/jobs`

Enqueue a long-running run on the async job queue. Returns `202 Accepted` in a few ms with a `job_id` to poll. Only available for apps that declared `async: true` in their manifest.

```bash
curl -sX POST http://localhost:3051/api/openpaper/jobs \
  -H 'content-type: application/json' \
  -d '{
    "action": "start_paper_generation",
    "inputs": { "topic": "Graph neural networks for molecular design" },
    "webhook_url": "https://my-collector/hook"
  }'
```

Response:

```json
{
  "job_id": "job_abc123",
  "status": "queued",
  "poll_url": "http://localhost:3051/api/openpaper/jobs/job_abc123",
  "cancel_url": "http://localhost:3051/api/openpaper/jobs/job_abc123/cancel"
}
```

Poll `GET /api/:slug/jobs/:job_id` for status. Statuses: `queued` → `running` → `succeeded` | `failed` | `cancelled`. When a job reaches a terminal state, Floom POSTs to `webhook_url` with the full output. Headers: `content-type: application/json`, `x-floom-event: job.completed`, `user-agent: Floom-Webhook/0.3.0`. Delivery retries on 5xx and network errors with exponential backoff.

Per-call overrides: `webhook_url`, `timeout_ms`, `max_retries` in the request body win over the `apps.yaml` defaults.

## `GET /api/me/runs`

Fetch the signed-in user's run history across every app on the instance. Paginated by `?limit=20&cursor=<run_id>`. Returns `{runs: [...], next_cursor}`. Requires a Better Auth session (Cloud mode) or the device cookie (OSS solo mode).

## `POST /api/feedback`

In-app feedback channel (the floating feedback button on preview calls this). Body `{message, context?}`. Stored in the local SQLite DB and mirrored to Slack when `FLOOM_FEEDBACK_SLACK_WEBHOOK` is set.

## `POST /mcp` (MCP admin surface)

Admin MCP server at the root `/mcp` path (no slug suffix). Four tools:

| Tool | Auth | Purpose |
|---|---|---|
| `ingest_app` | Cloud: signed-in. OSS: open. | Create or update an app from an OpenAPI spec. `openapi_url` or inline `openapi_spec`. Returns `{slug, permalink, mcp_url, created}`. Rate-limited 10/day per caller. |
| `list_apps` | Public | List active apps, filterable by `category` (exact) or `keyword` (substring). |
| `search_apps` | Public | Natural-language search. OpenAI embeddings when `OPENAI_API_KEY` is set; keyword fallback otherwise. |
| `get_app` | Public | Fetch one app by slug with the full manifest. |

Use with any MCP client:

```bash
curl -X POST http://localhost:3051/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

In Cloud mode, anonymous `ingest_app` calls return `{error: "auth_required"}` rather than 401 so MCP clients surface the friction correctly.

## `POST /mcp/app/:slug` (per-app MCP surface)

Every registered app is also its own MCP server. MCP Streamable HTTP transport, protocol version `2024-11-05`. Required headers:

```
content-type: application/json
accept: application/json, text/event-stream
```

Example `tools/list`:

```bash
curl -X POST http://localhost:3051/mcp/app/petstore \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

Each OpenAPI operation becomes one MCP tool with the full JSON Schema as `inputSchema`. Apps that declare `secrets` in their manifest get an optional `_auth` object on every tool so MCP clients can inject per-call credentials:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "send_email",
    "arguments": {
      "to": "user@example.com",
      "_auth": { "RESEND_API_KEY": "re_xxx" }
    }
  }
}
```

Values in `_auth` are used for that single call only and never persisted server-side.

For apps with `async: true`, `tools/call` returns immediately with a job-started payload instead of blocking. The MCP client picks up the `job_id` and either polls or waits for the webhook. This lets Claude Desktop kick off a 20-minute paper generation and come back to it later without holding the connection open.
