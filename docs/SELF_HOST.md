# Self-host Floom

Run a full Floom instance — chat UI, MCP server, HTTP endpoint — on any machine with Docker.

## Quick start

```bash
# 1. Create your apps config
cat > apps.yaml <<'EOF'
apps:
  - slug: petstore
    type: proxied
    openapi_spec_url: https://petstore3.swagger.io/api/v3/openapi.json
    display_name: Petstore
    description: "OpenAPI 3.0 reference pet store."
    category: developer-tools

  - slug: resend
    type: proxied
    openapi_spec_url: https://raw.githubusercontent.com/resend/resend-openapi/main/resend.yaml
    auth: bearer
    secrets: [RESEND_API_KEY]
    display_name: Resend
    description: "Transactional email API."
EOF

# 2. Run Floom with a named volume for persistence and the apps.yaml mount
docker run -d --name floom \
  -p 3051:3051 \
  -v floom_data:/data \
  -v "$(pwd)/apps.yaml:/app/config/apps.yaml:ro" \
  -e FLOOM_APPS_CONFIG=/app/config/apps.yaml \
  -e RESEND_API_KEY=re_xxx \
  ghcr.io/floomhq/floom-monorepo:v0.2.0

# 3. Verify
sleep 5
curl http://localhost:3051/api/health
curl http://localhost:3051/api/hub | jq 'length'
```

Open `http://localhost:3051` in your browser or point an MCP client at `http://localhost:3051/mcp/app/petstore`.

**Notice:** as of v0.2.0 the default image boots with an **empty hub**. You declare what apps you want via `apps.yaml`. No Docker socket mount is needed for proxied apps.

## Environment variables

| Var | Default | Description |
|-----|---------|-------------|
| `PORT` | `3051` | HTTP port inside the container |
| `DATA_DIR` | `/data` | Where SQLite + per-app state live. Mount a volume here to persist across restarts |
| `PUBLIC_URL` | `http://localhost:$PORT` | What the server advertises as its own URL in MCP payloads |
| `FLOOM_APPS_CONFIG` | — | Path to an `apps.yaml` file. When set, Floom ingests it on boot |
| `FLOOM_SEED_APPS` | `false` | Set to `true` to seed the 15 bundled docker apps (flyfast, blast-radius, etc.). Requires `/var/run/docker.sock` mounted |
| `FLOOM_AUTH_TOKEN` | — | When set, all `/api/*`, `/mcp/*`, `/p/*` requests require `Authorization: Bearer <token>`. `/api/health` stays open |
| `FLOOM_MAX_ACTIONS_PER_APP` | `200` | Hard cap on how many operations one OpenAPI spec can expose. Set to `0` for unlimited (needed for Stripe, GitHub, etc.) |
| `FLOOM_JOB_POLL_MS` | `1000` | Interval in ms at which the background worker polls the async job queue. Lower = faster pickup, more CPU |
| `FLOOM_DISABLE_JOB_WORKER` | — | When set to `true`, the background worker does not start. Used by tests that drive the worker deterministically |
| `OPENAI_API_KEY` | — | Optional. Enables embedding-based app search. Without it, search falls back to keyword matching |

Any other env var matching a name in an app's `secrets` list (e.g. `RESEND_API_KEY`) is picked up as a server-side secret for that app.

## apps.yaml schema

```yaml
apps:
  - slug: petstore           # required, unique, used in URLs
    type: proxied            # 'proxied' (HTTP) or 'hosted' (docker, advanced)
    openapi_spec_url: https://petstore3.swagger.io/api/v3/openapi.json
    # base_url: optional — auto-read from spec.servers[] if omitted
    auth: none               # none | bearer | apikey | basic | oauth2_client_credentials
    # apikey_header: X-Custom-Key   # custom header for apikey auth (default: X-API-Key)
    # oauth2_token_url: ...         # required when auth: oauth2_client_credentials
    # oauth2_scopes: "read write"   # optional scopes
    secrets: [PETSTORE_TOKEN]       # env var names to pick up as per-app secrets
    visibility: public       # public | auth-required (requires FLOOM_AUTH_TOKEN)
    display_name: Petstore
    description: "OpenAPI 3.0 reference pet store."
    category: developer-tools
    icon: https://example.com/icon.svg
```

### Auth modes

#### No auth
```yaml
auth: none
```

#### Bearer token
```yaml
auth: bearer
secrets: [MY_SERVICE_TOKEN]
```
The first secret value wins. Prefer names containing `token`, `api_key`, or `bearer`.

#### API key header
```yaml
auth: apikey
apikey_header: X-API-Key   # or 'Authorization', or any custom header
secrets: [MY_API_KEY]
```

#### HTTP Basic
```yaml
auth: basic
secrets: [MY_USER, MY_PASSWORD]
```
Secret names are matched case-insensitively by substring (`user`, `pass`).

#### OAuth2 client credentials
```yaml
auth: oauth2_client_credentials
oauth2_token_url: https://auth.example.com/oauth2/token
oauth2_scopes: "read write"
secrets: [MY_CLIENT_ID, MY_CLIENT_SECRET]
```
Tokens are fetched on first call and cached in-memory for 60s before expiry.

**Note:** OAuth2 authorization_code flow (user-consent) is not supported for proxied apps. Use the MCP `_auth` meta param to inject per-user tokens from your MCP client instead.

## MCP client integration

Every registered app exposes an MCP server at `/mcp/app/:slug`. Protocol version 2024-11-05 (Claude Desktop compatible).

### Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "floom-petstore": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "http://localhost:3051/mcp/app/petstore"]
    }
  }
}
```

Claude Desktop as of April 2026 does not natively dial HTTP MCP servers, so `mcp-remote` bridges stdio → HTTP for you.

### Per-user secrets (Floom MCP extension)

When an app declares `secrets_needed` in its manifest, the tool's `inputSchema` includes an optional `_auth` object. Supply secrets per call:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "send_email",
    "arguments": {
      "to": "user@example.com",
      "subject": "hi",
      "_auth": { "RESEND_API_KEY": "re_xxx" }
    }
  }
}
```

Values passed via `_auth` are used for that single call only and never persisted server-side. If no `_auth` is provided and the app needs secrets, the tool returns a structured `{error: "missing_secrets", required: [...], help: "..."}` response so the MCP client can prompt the user.

### Any MCP client

The endpoint uses the MCP Streamable HTTP transport. Required headers:
```
content-type: application/json
accept: application/json, text/event-stream
```

Example:
```bash
curl -X POST http://localhost:3051/mcp/app/petstore \
  -H "content-type: application/json" \
  -H "accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

## HTTP endpoint

Every app also exposes a direct HTTP endpoint:

```
POST /api/:slug/run
Content-Type: application/json

{ "action": "actionName", "inputs": { ... } }
```

Returns `{ run_id, status }` immediately. Poll `GET /api/run/:run_id` for the result, or subscribe to `GET /api/run/:run_id/stream` for live logs via SSE.

## Long-running apps (async job queue, v0.3.0+)

Some apps (OpenPaper, research agents, slow ML pipelines) take 10-20 minutes to
finish. Blocking an HTTP request that long is wrong: proxies kill the connection,
MCP clients time out, and users get no feedback. Declare `async: true` in your
`apps.yaml` entry and Floom wraps the call in a job queue with poll + webhook
semantics.

```yaml
apps:
  - slug: openpaper
    type: proxied
    openapi_spec_url: https://api.openpaper.dev/openapi.json
    auth: bearer
    secrets: [OPENPAPER_API_TOKEN]
    async: true                                  # <-- enable the queue
    async_mode: poll                             # poll | webhook | stream
    timeout_ms: 1800000                          # 30 minutes (default)
    retries: 2                                   # re-queue on failure up to 2x
    webhook_url: https://my-collector/hook       # optional: POST on completion
```

### Protocol

#### POST /api/:slug/jobs — enqueue

```bash
curl -sX POST http://localhost:3051/api/openpaper/jobs \
  -H 'content-type: application/json' \
  -d '{
    "action": "start_paper_generation",
    "inputs": { "topic": "Graph neural networks for molecular design" },
    "webhook_url": "https://my-collector/hook"
  }'
```

Returns `202 Accepted` within a few ms:

```json
{
  "job_id": "job_abc123",
  "status": "queued",
  "poll_url": "http://localhost:3051/api/openpaper/jobs/job_abc123",
  "webhook_url_template": "http://localhost:3051/api/openpaper/jobs/job_abc123",
  "cancel_url": "http://localhost:3051/api/openpaper/jobs/job_abc123/cancel"
}
```

The `webhook_url`, `timeout_ms`, and `max_retries` fields in the request body
are per-call overrides — they win over the `apps.yaml` defaults.

#### GET /api/:slug/jobs/:job_id — poll

```json
{
  "id": "job_abc123",
  "slug": "openpaper",
  "action": "start_paper_generation",
  "status": "succeeded",
  "input": { "topic": "..." },
  "output": { "pdf_url": "https://...", "docx_url": "https://..." },
  "error": null,
  "attempts": 1,
  "created_at": "2026-04-15 00:42:11",
  "started_at": "2026-04-15 00:42:11",
  "finished_at": "2026-04-15 00:58:47"
}
```

Statuses: `queued` → `running` → `succeeded` | `failed` | `cancelled`.

#### POST /api/:slug/jobs/:job_id/cancel — cancel

Flips a queued or running job to `cancelled`. Terminal jobs stay terminal.

### Webhook delivery

When a job reaches a terminal state Floom POSTs to `webhook_url` with:

```json
{
  "job_id": "job_abc123",
  "slug": "openpaper",
  "status": "succeeded",
  "output": { ... },
  "error": null,
  "duration_ms": 996345,
  "attempts": 1
}
```

Headers: `content-type: application/json`, `x-floom-event: job.completed`,
`user-agent: Floom-Webhook/0.3.0`.

Delivery retries on 5xx and network errors with exponential backoff (500ms,
1s, 2s by default). 4xx responses are permanent failures — fix your endpoint
and requeue by re-enqueuing.

### MCP clients

For async apps, `tools/call` returns immediately with a job-started text
payload instead of waiting 20 minutes:

```json
{
  "content": [{
    "type": "text",
    "text": "{\"job_id\":\"job_abc123\",\"status\":\"queued\",\"poll_url\":\"...\",\"message\":\"Job started: job_abc123. Poll ... for status.\"}"
  }]
}
```

The MCP client picks up the `job_id` from the text and either polls the job
endpoint or waits for the webhook. This lets Claude Desktop / Cursor kick off
a 20-minute paper generation and come back to it later without holding the
connection open.

### Worked example

`examples/slow-echo/` ships a tiny Node app that sleeps 5s and echoes its
input. It's the canonical "did my async setup work" smoke test:

```bash
# Terminal 1
node examples/slow-echo/server.mjs

# Terminal 2
FLOOM_APPS_CONFIG=examples/slow-echo/apps.yaml \
  DATA_DIR=/tmp/floom-slow-echo \
  node apps/server/dist/index.js

# Terminal 3
curl -sX POST http://localhost:3051/api/slow-echo/jobs \
  -H 'content-type: application/json' \
  -d '{"inputs": {"message": "hi"}}' | jq
# { "job_id": "job_xxx", "status": "queued", ... }

# A few seconds later
curl -s http://localhost:3051/api/slow-echo/jobs/job_xxx | jq
# { "status": "succeeded", "output": { "echoed": "hi", ... }, ... }
```

## Proxied vs hosted mode

| Mode | How it works | When to use |
|------|-------------|-------------|
| `proxied` | Floom fetches the OpenAPI spec, walks `$refs`, auto-resolves `base_url`, and routes requests to the upstream API with secrets injected | Any public or private API with an OpenAPI 3.x spec (or Swagger 2) |
| `hosted` | Floom runs a Docker image with the app's code. Requires `/var/run/docker.sock` mounted into the container | Custom apps that need code execution inside Floom |

The 15 historic bundled apps (flyfast, bouncer, blast-radius, etc.) are hosted-mode and opt-in via `FLOOM_SEED_APPS=true`. The default v0.2 self-host path is proxied-only.

## Docker compose

```yaml
version: "3.9"
services:
  floom:
    image: ghcr.io/floomhq/floom-monorepo:v0.2.0
    ports:
      - "3051:3051"
    volumes:
      - floom_data:/data
      - ./apps.yaml:/app/config/apps.yaml:ro
    environment:
      FLOOM_APPS_CONFIG: /app/config/apps.yaml
      # FLOOM_AUTH_TOKEN: "choose_a_long_random_string"
      # RESEND_API_KEY: "re_..."
    restart: unless-stopped

volumes:
  floom_data:
```

## Persistence

Everything lives at `/data`:
- `floom-chat.db` + `floom-chat.db-wal` + `floom-chat.db-shm` — SQLite database
- `apps/` — Per-app working directories (only used for hosted apps)

Always mount `/data` to a named volume or a host directory. `docker run --rm` without a volume throws away all state including ingested apps.

## Security

- **Never expose port 3051 to the public internet without setting `FLOOM_AUTH_TOKEN`.** With no auth, anyone with your URL can call any app and exhaust your API quotas / secrets.
- **Avoid `-v /var/run/docker.sock:/var/run/docker.sock` unless you trust everyone who can reach port 3051.** Mounting the Docker socket inside a container exposed to the network grants host root.
- **FLOOM_SEED_APPS is off by default** for exactly this reason: it requires the Docker socket mount.
- **Per-app visibility** (`visibility: auth-required` in apps.yaml) lets you keep some apps public while gating specific ones behind `FLOOM_AUTH_TOKEN`.

## Troubleshooting

**"App not found" on /api/:slug/run**
Check `GET /api/hub` for the list of slugs. Slug comparison is case-sensitive.

**Proxied app returns 404 but the upstream API works**
Before v0.2, the runner dropped the path prefix of `base_url`. Upgrade to v0.2.0 or later. If you're already on v0.2, check `docker logs floom` — the `[proxied] GET <url>` line shows the exact URL being requested.

**OpenAPI spec fetch fails**
Verify the URL is reachable from inside the container: `docker exec floom wget -qO- <url>`. Firewalls and VPN-only endpoints will need extra network config.

**$ref dereference errors**
Very large specs (Stripe: 3,778 refs) can take 1-2 seconds to dereference. Cyclic refs are handled via `{circular: 'ignore'}` — the original `$ref` is left in place rather than throwing.

**Large specs are truncated to 200 actions**
Set `FLOOM_MAX_ACTIONS_PER_APP=0` to lift the cap. Check logs for the truncation warning, which includes the spec's total operation count.

**OPENAI_API_KEY missing warning**
Embeddings-based app search needs it. Safe to ignore — picker falls back to keyword matching.

**Port already in use**
`docker run -p 8080:3051 ...`

## Version info

- **v0.3.0** (April 2026): Async job queue primitive. `async: true` in `apps.yaml` wraps long-running apps (OpenPaper, research agents) in POST /jobs → GET /jobs/:id → webhook pattern. Background worker polls, claims, dispatches, enforces `timeout_ms`, retries N times, delivers webhooks with 5xx backoff. MCP `tools/call` on async apps returns immediately with a job-started payload.
- **v0.2.0** (April 2026): OpenAPI ingest rewrite. $ref resolution, allOf/oneOf/anyOf flattening, spec.servers[] auto-detection, header/cookie/multipart support, OAuth2 client credentials, basic auth, FLOOM_AUTH_TOKEN gate, per-user MCP secrets via _auth extension, FLOOM_SEED_APPS opt-in for hosted apps, fixed base_url path-stripping, fixed SPA wildcard swallowing /openapi.json.
- **v0.1.0** (April 2026): Initial self-host release. Proxied + hosted modes, MCP Streamable HTTP, SPA chat UI.
