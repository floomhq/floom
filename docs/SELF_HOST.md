# Self-host Floom

Run a full Floom instance — web form + output renderer, MCP server, HTTP endpoint, CLI — on any machine with Docker.

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
  ghcr.io/floomhq/floom-monorepo:v0.4.0-minimal.6

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
| `FLOOM_RATE_LIMIT_DISABLED` | — | When `true`, skips all rate limits (tests, admin tooling). Otherwise every run endpoint enforces the caps below |
| `FLOOM_RATE_LIMIT_IP_PER_HOUR` | `20` | Max runs per IP per hour for anonymous callers across all apps |
| `FLOOM_RATE_LIMIT_USER_PER_HOUR` | `200` | Max runs per authenticated user per hour across all apps |
| `FLOOM_RATE_LIMIT_APP_PER_HOUR` | `50` | Max runs per (IP, app) pair per hour. Prevents one hot app from draining a visitor's IP budget |
| `FLOOM_RATE_LIMIT_MCP_INGEST_PER_DAY` | `10` | Max MCP `ingest_app` calls per user per day (anon: per IP). Stops scripted gallery spam |
| `OPENAI_API_KEY` | — | Optional. Enables embedding-based app search. Without it, search falls back to keyword matching |
| `COMPOSIO_API_KEY` | — | Optional. API key from [composio.dev](https://composio.dev) (free tier: 20K calls/mo). Enables the `/build` Connect-a-tool ramp via `/api/connections`. Without it, connection routes return `400 code=composio_config_missing`. See docs/connections.md |
| `COMPOSIO_AUTH_CONFIG_<PROVIDER>` | — | Per-toolkit Composio auth config id (e.g. `COMPOSIO_AUTH_CONFIG_GMAIL=ac_xxx`). One per provider you want surfaced on `/build`. Create each in the Composio dashboard with the Floom callback URL |

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

### MCP admin surface (v0.4.0-mvp.5)

A separate admin MCP server lives at `/mcp` (no slug suffix) and exposes four
tools for gallery management and app creation:

| Tool | Auth | Purpose |
|---|---|---|
| `ingest_app` | Cloud mode: signed-in only. OSS: open. | Create or update an app from an OpenAPI spec. Accepts either `openapi_url` (fetched server-side) or `openapi_spec` (inline JSON object). Returns `{slug, permalink, mcp_url, created}`. |
| `list_apps` | Public | List active apps, optionally filtered by `category` (exact match) or `keyword` (case-insensitive substring on name + description). |
| `search_apps` | Public | Natural-language search across the hub. Uses OpenAI embeddings when `OPENAI_API_KEY` is set; keyword fallback otherwise. |
| `get_app` | Public | Fetch one app by slug, returning the full manifest including every action's input schema, outputs, and required secrets. |

Point an MCP client at `http://localhost:3051/mcp` to discover and drive these tools. Example `tools/list` call:

```bash
curl -X POST http://localhost:3051/mcp \
  -H "content-type: application/json" \
  -H "accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

`ingest_app` mirrors the HTTP `/api/hub/ingest` auth rules. In Cloud mode the
caller's Better Auth session is resolved before the ingest runs; anonymous
calls receive a structured `{error: "auth_required"}` tool response.

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

## Rate limits

Floom enforces per-IP, per-user, and per-(IP, app) caps on every run endpoint
so a single hostile caller cannot drain a creator's upstream budget:

| Endpoint | Anon (per IP) | Authed (per user) | Per (IP, app) |
|----------|---------------|-------------------|----------------|
| `POST /api/run` | 20/hr | 200/hr | 50/hr |
| `POST /api/:slug/run` | 20/hr | 200/hr | 50/hr |
| `POST /api/:slug/jobs` | 20/hr | 200/hr | 50/hr |
| `POST /mcp/app/:slug` | 20/hr | 200/hr | 50/hr |
| `POST /mcp` — `ingest_app` tool | 10/day (per IP) | 10/day (per user) | — |

When a cap is exceeded the response is HTTP `429` with a `Retry-After` header
and a JSON body:

```json
{
  "error": "rate_limit_exceeded",
  "retry_after_seconds": 2831,
  "scope": "ip"
}
```

`scope` is one of `ip`, `user`, `app`, or `mcp_ingest`.

Override defaults via `FLOOM_RATE_LIMIT_IP_PER_HOUR`,
`FLOOM_RATE_LIMIT_USER_PER_HOUR`, `FLOOM_RATE_LIMIT_APP_PER_HOUR`, and
`FLOOM_RATE_LIMIT_MCP_INGEST_PER_DAY`. Set `FLOOM_RATE_LIMIT_DISABLED=true`
to skip every check (tests, admin scripts). Reads like `GET /api/hub`,
`GET /api/health`, `GET /api/me/runs`, and `tools/list` are never throttled.

Storage is in-memory per container; rolling counters reset on restart. For
multi-replica production deployments the limiter swaps out to Redis without
touching route handlers (see `apps/server/src/lib/rate-limit.ts`).

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

For proxied apps, `timeout_ms` also controls the upstream HTTP request ceiling
inside the worker. Long-running upstream APIs must set this above the default
30-second fetch timeout.

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
    image: ghcr.io/floomhq/floom-monorepo:v0.4.0-minimal.6
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

## Multi-tenant model (v0.3.1)

Floom ships a multi-tenant schema from day one. Solo mode is a special case:
everything runs against a synthetic `workspace_id='local'` + `user_id='local'`
row that Floom bootstraps on first boot. Cloud (W3.1) will add real users on
top of the exact same schema — no feature flag, no branching, no migration
pain.

### The 5 new tables

| Table | Purpose |
|---|---|
| `workspaces` | Tenant container. `wrapped_dek` holds the per-workspace data encryption key wrapped under the master KEK. |
| `users` | Global identity. `auth_provider` is `local` in OSS mode; Cloud will add `google`, `github`, `oidc`, etc. |
| `workspace_members` | `(workspace_id, user_id, role)` mapping. Role = `admin`/`editor`/`viewer`. |
| `app_memory` | `(workspace_id, app_slug, user_id, key)` → JSON blob. Gated by the app manifest's `memory_keys` declaration. |
| `user_secrets` | `(workspace_id, user_id, key)` → AES-256-GCM ciphertext. Per-workspace DEK wrapped with `FLOOM_MASTER_KEY`. |

Existing tables (`apps`, `runs`, `run_threads`) gained `workspace_id` + `user_id`
+ `device_id` columns, all idempotent, all defaulting to `'local'` for backward
compatibility with v0.2/v0.3 databases.

### Per-user app memory

Creators declare `memory_keys` in their manifest:

```yaml
apps:
  - slug: flyfast
    memory_keys:
      - last_search_destination
      - preferred_currency
```

At runtime the app's handler can read and write these values through
`/api/memory/:app_slug`. Keys not in the declared list are rejected with
a 403 `memory_key_not_allowed`. Every row is scoped by `(workspace_id,
app_slug, user_id)`, so two users of the same app never see each other's
state, and two apps on the same account never leak memory across the
installed-app boundary.

### Per-user secrets vault

The secrets vault uses AES-256-GCM envelope encryption:

```
FLOOM_MASTER_KEY (32-byte hex, env or ./.floom-master-key file)
        │
        └─ wraps ─► per-workspace DEK (32 bytes, random, in workspaces.wrapped_dek)
                           │
                           └─ encrypts ─► each user_secrets row
```

Resolution order at runtime (lowest → highest precedence):

1. Global admin secrets (`secrets` table, `app_id IS NULL`)
2. Per-app admin secrets (`secrets` table, `app_id = this app`)
3. Per-user persisted secrets (`user_secrets` table, W2.1)
4. Per-call MCP `_auth` override

So a creator can ship a default `OPENAI_API_KEY` for their app, a user can
bring their own (overriding the default), and an MCP client can still
override both for a single invocation.

### Session re-key (anonymous → authenticated)

Before auth lands (W3.1), every request carries a `floom_device` cookie
(HttpOnly, SameSite=Lax, 10-year TTL). All memory/runs/threads created
during an anonymous session are bound to that device_id.

When auth ships, the login handler calls `rekeyDevice(device_id, user_id,
workspace_id)` once on the first authenticated request. This runs an
atomic transaction that rewrites `user_id` on every row matching the
device_id. Idempotent — re-running is a no-op. Same pattern Linear
documented in 2022. No force migration, no data loss, no leftover orphans.

### Migration path to Cloud

1. Dump SQLite: `sqlite3 data/floom-chat.db .dump > floom.sql`
2. Convert to Postgres: `pgloader floom.db postgres://...` (or manual `.dump`
   tweaks — both work because the schemas are byte-for-byte identical).
3. Every row already has `workspace_id='local'` — you're now a legal
   multi-tenant Postgres instance with one workspace.
4. Rename: `UPDATE workspaces SET slug='my-team' WHERE id='local';`
5. Invite real users; their `rekeyDevice` calls migrate the anonymous rows
   into their new accounts on first login.

Same flow Plausible and n8n ship today.

### Master key back-up

If you lose `FLOOM_MASTER_KEY` (or the `.floom-master-key` file), every
`user_secrets` row is unrecoverable. Back it up. Rotate by rewrapping each
workspace DEK with the new key (operational runbook forthcoming).

## Custom renderers (v0.3.1)

Every Floom app ships with a default renderer for its response — a table for array-of-objects, markdown for `type: string, format: markdown`, a syntax-highlighted code block when the schema has `x-floom-language`, a PDF viewer for `application/pdf`, and so on. The full shape discriminator is in `packages/renderer/src/contract/index.ts`.

When the default isn't enough (e.g. FlyFast wants flight cards, Claude Wrapped wants a chart, OpenSlides wants a PPTX download button), creators ship a `renderer.tsx` alongside their OpenAPI spec and declare it in `apps.yaml`:

```yaml
apps:
  - slug: flyfast
    type: proxied
    openapi_spec_url: ./openapi.yaml
    display_name: FlyFast
    renderer:
      kind: component         # or "default" (skip compilation)
      entry: ./renderer.tsx   # path relative to this manifest
      output_shape: table     # crash fallback — default used when renderer.tsx throws
```

At ingest time Floom compiles the renderer via `esbuild` (ESM / browser target, React + @floom/renderer marked as externals) and writes the bundle to `DATA_DIR/renderers/<slug>.js`. The size cap is 256 KB per bundle — trim or split if you hit it.

### What the renderer receives

Creators import only the `RenderProps` type from `@floom/renderer/contract`. The shape follows the Vercel AI SDK `parts` state machine:

```tsx
import React from 'react';
import type { RenderProps } from '@floom/renderer/contract';

interface Flight { /* matches your openapi response schema */ }

export default function FlyFastRenderer({ state, data, error }: RenderProps) {
  if (state === 'input-available') return <div>Searching flights…</div>;
  if (state === 'output-error')    return <div>Error: {error?.message}</div>;

  const flights = (data as { results: Flight[] })?.results ?? [];
  return (
    <div>
      {flights.sort((a, b) => a.price_eur - b.price_eur).map((f, i) => (
        <FlightCard key={i} flight={f} />
      ))}
    </div>
  );
}
```

Three invocation states are mutually exclusive: `input-available`, `output-available`, `output-error`. Every render receives these four props: `state`, `data` (parsed response body), `schema` (optional JSON Schema), `error`. A `loading` boolean is also provided for renderers that care about stream mode.

### Serving + loading the bundle

The server exposes two routes per slug:

```bash
# Metadata about the compiled bundle
curl http://localhost:3051/renderer/flyfast/meta
# → { slug, output_shape, bytes, source_hash, compiled_at }

# The ESM bundle itself (served with x-floom-renderer-hash + x-floom-renderer-shape headers)
curl http://localhost:3051/renderer/flyfast/bundle.js
```

The web client lazy-loads the bundle with `React.lazy(() => import('/renderer/flyfast/bundle.js'))` when a run completes, wraps it in an `ErrorBoundary`, and falls back to the default shape renderer (`output_shape: table` in the example above) if the component crashes at runtime.

### Error boundary + fallbacks

Creators never have to worry about breaking a hub. If `renderer.tsx`:

- fails to compile at ingest → Floom logs and keeps going (the app falls back to the default renderer for its schema)
- exceeds 256 KB after minification → ingest throws per-app, other apps continue
- crashes at render time in the user's browser → `RendererShell`'s error boundary catches it and swaps in the default for `output_shape`
- returns an `output-error` state → Floom always uses its default `ErrorOutput` card (the custom renderer never gets a chance to re-style errors, which keeps the UX consistent across apps)

### Reference implementation

Check `examples/flyfast/` for a complete working example: `apps.yaml` + `openapi.yaml` + `renderer.tsx`. Point Floom at it with:

```bash
FLOOM_APPS_CONFIG=./examples/flyfast/apps.yaml pnpm --filter @floom/server dev
curl http://localhost:3051/renderer/flyfast/meta
```

## Connect a tool (Composio OAuth, v0.3.2+)

Floom's `/build` page has a "Connect a tool" tile grid (Gmail, Notion, Stripe, Slack, Sheets, Airtable, Shopify, HubSpot, Calendar, Linear, Figma, GitHub). Each tile kicks off a Composio-backed OAuth flow so a self-hosting operator (or, in Cloud, an end user) can grant Floom scoped access to the upstream provider and have every app on Floom reuse those credentials.

**Composio** is a closed-source, cloud-only OAuth broker ([composio.dev](https://composio.dev)) with a 982-toolkit catalog, per-user connection keying, and automatic token refresh. Floom talks to it via the MIT-licensed `@composio/core` SDK pinned at `0.6.10`. Docs: `docs/connections.md`.

### Setup

1. **Create a free Composio account** at [composio.dev](https://composio.dev). Free tier is 20,000 tool calls per month.
2. **Copy your API key** from the dashboard and set it as an env var:
   ```
   COMPOSIO_API_KEY=cmp_xxx
   ```
3. **Create an auth_config per toolkit** you want to surface. In the Composio dashboard, create an OAuth auth config for each provider (Gmail, Notion, Stripe, ...) and set the callback URL to:
   ```
   https://<your-floom-host>/api/connections/callback
   ```
4. **Set the auth_config ids on Floom** as env vars (one per toolkit):
   ```
   COMPOSIO_AUTH_CONFIG_GMAIL=ac_xxx
   COMPOSIO_AUTH_CONFIG_NOTION=ac_xxx
   COMPOSIO_AUTH_CONFIG_STRIPE=ac_xxx
   # ... one per provider you want to surface
   ```
5. **Restart Floom**. Connections appear at `/api/connections` immediately.

Providers without a `COMPOSIO_AUTH_CONFIG_*` env var return `400 code=composio_config_missing` when a user tries to connect, so only the providers you explicitly configure become clickable.

### Device-id fallback

v0.3.2 ships before W3.1 multi-user auth. Until Better Auth lands, every visitor is keyed by an anonymous `floom_device` cookie (HttpOnly, SameSite=Lax, 10-year TTL). Connections are owned by `device:<uuid>` in Composio's keyspace. On first login after W3.1, `rekeyDevice` atomically flips every device-owned row to `user:<id>` (same transaction that re-keys `app_memory`, `runs`, `run_threads`), and persists the legacy Composio user id on `users.composio_user_id` so Composio itself never needs a rename API call.

### Endpoints

| Method | Path | Description |
|---|---|---|
| POST | `/api/connections/initiate` | Body `{provider, callback_url?}` → returns `{auth_url, connection_id, provider, expires_at}` |
| POST | `/api/connections/finish` | Body `{connection_id}` → polls Composio, persists row, returns `{connection}` |
| GET | `/api/connections` | Optional `?status=active` → returns `{connections: [...]}` |
| DELETE | `/api/connections/:provider` | Revokes upstream + flips local row to `revoked` |

All four are gated by the same auth middleware as the rest of `/api/*`. In OSS solo mode (no `FLOOM_AUTH_TOKEN` set) they're open; with a token set, every call needs a `Bearer` header.

Full per-call reference: `docs/connections.md`.

## Creator monetization (Stripe Connect, v0.4.0-alpha.2+)

Floom ships a Stripe Connect partner app at `/api/stripe/*` so creators on a
self-hosted Floom can monetize their apps via Stripe Express accounts. Floom
takes a 5% application fee, the rest auto-payouts to the creator's bank.

**Quick setup:**

```bash
# 1. Sign up for Stripe Connect (one-time, ~10 min)
#    https://dashboard.stripe.com/connect — create a Connect platform application
#    in test mode. Copy the platform secret key (sk_test_...).
#
# 2. Add to .env
echo 'STRIPE_SECRET_KEY=sk_test_...' >> .env
echo 'STRIPE_WEBHOOK_SECRET=whsec_...' >> .env
echo 'STRIPE_CONNECT_ONBOARDING_RETURN_URL=https://your-floom.example.com/billing/return' >> .env
echo 'STRIPE_CONNECT_ONBOARDING_REFRESH_URL=https://your-floom.example.com/billing/refresh' >> .env

# 3. Restart the container
docker restart floom

# 4. Register your webhook in the Stripe dashboard
#    Dashboard → Developers → Webhooks → Add endpoint
#    URL: https://your-floom.example.com/api/stripe/webhook
#    Events: account.updated, payment_intent.succeeded, charge.refunded,
#            invoice.paid, payout.created, payout.paid, payout.failed

# 5. Onboard your first creator
curl -X POST https://your-floom.example.com/api/stripe/connect/onboard \
  -H 'content-type: application/json' \
  -d '{"country":"DE","email":"creator@example.com"}'
# → returns {account_id, onboarding_url, expires_at, account}
#   open onboarding_url to finish KYC
```

**Endpoints:**

| Method | Path | Description |
|---|---|---|
| POST | `/api/stripe/connect/onboard` | Create an Express account + return hosted onboarding URL. Idempotent. |
| GET | `/api/stripe/connect/status` | Get the caller's current account state (poll Stripe live with `?refresh=true`). |
| POST | `/api/stripe/payments` | Create a direct charge with `application_fee_amount = floor(amount * 0.05)`. |
| POST | `/api/stripe/refunds` | Refund a payment intent. Within 30d, the 5% fee is refunded too. |
| POST | `/api/stripe/subscriptions` | Create a subscription with `application_fee_percent = 5`. |
| POST | `/api/stripe/webhook` | Stripe webhook receiver. Raw body, signature verified, dedupes by event id. |

**Self-host vs Cloud:** A self-hosted Floom acts as its own Stripe Connect
platform — the operator (you) signs up for Connect once, every creator on
your instance becomes a connected Express account on **your** platform. No
creator ever sees a Stripe API key. On Floom Cloud, the platform is owned
by Floom Inc. and creators onboard against Floom's platform key.

**Demo app:** `examples/stripe-checkout/` is a 3-operation Floom app
(`create_checkout`, `list_payments`, `refund_payment`) that demonstrates
the per-user secret stack — each user brings their own Stripe key via the
W2.1 user_secrets table, and the runner injects it as
`Authorization: Bearer sk_test_...`. Read `examples/stripe-checkout/README.md`
for the full walkthrough.

**Full reference:** `docs/monetization.md`.

## Version info

- **v0.4.0-alpha.2** (April 2026): **Stripe Connect partner app (W3.3)** — `/api/stripe/*` routes for creator monetization. Express account onboarding (idempotent, hosted onboarding URL), direct charges with 5% `application_fee_amount`, refunds with 30-day fee window, subscriptions with `application_fee_percent=5`, webhook receiver with signature verify + event_id dedupe ledger. Two new tables (`stripe_accounts`, `stripe_webhook_events`), `user_version=6`. Auth boundary scoped by `(workspace_id, owner_id)` where `owner_id = is_authenticated ? user_id : "device:" + device_id` (W2.1 device fallback pattern). 163 new unit + integration tests. `examples/stripe-checkout/` demo app shipping a 3-operation creator surface that pulls per-user Stripe keys from `user_secrets`. See "Creator monetization" section above and `docs/monetization.md` for the full reference.
- **v0.3.2** (April 2026): **Composio OAuth integration** — `/api/connections` routes, `connections` table (per-user per-provider OAuth state with device_id fallback pattern), `users.composio_user_id` column, extended `rekeyDevice` transaction (now 4-table atomic), thin wrapper service at `services/composio.ts` around `@composio/core` 0.6.10 (initiate / finish / list / revoke / executeAction). 135 new unit + integration tests. See "Connect a tool" section above.
- **v0.3.1** (April 2026): **Multi-tenant schema foundation** — 5 new tables (`workspaces`, `users`, `workspace_members`, `app_memory`, `user_secrets`) + `workspace_id`/`user_id`/`device_id` columns on `apps`/`runs`/`run_threads`. Per-user app memory gated by manifest `memory_keys`. AES-256-GCM envelope-encrypted secrets vault. Session cookie (`floom_device`) with atomic rekey transaction for the upcoming W3.1 auth migration. New endpoints: `/api/memory/:app_slug`, `/api/secrets`. Single-codepath multi-tenant (OSS solo mode = synthetic `workspace_id='local'`). **Custom renderers** — creators can ship a `renderer.tsx` alongside their OpenAPI spec; Floom compiles it via esbuild and serves at `/renderer/:slug/bundle.js` with an ErrorBoundary fallback to the default shape renderer. Ships 10 default output components (text/markdown/code/table/object/image/pdf/audio/stream/error) + 13 default input components.
- **v0.3.0** (April 2026): Async job queue primitive. `async: true` in `apps.yaml` wraps long-running apps (OpenPaper, research agents) in POST /jobs → GET /jobs/:id → webhook pattern. Background worker polls, claims, dispatches, enforces `timeout_ms`, retries N times, delivers webhooks with 5xx backoff. MCP `tools/call` on async apps returns immediately with a job-started payload.
- **v0.2.0** (April 2026): OpenAPI ingest rewrite. $ref resolution, allOf/oneOf/anyOf flattening, spec.servers[] auto-detection, header/cookie/multipart support, OAuth2 client credentials, basic auth, FLOOM_AUTH_TOKEN gate, per-user MCP secrets via _auth extension, FLOOM_SEED_APPS opt-in for hosted apps, fixed base_url path-stripping, fixed SPA wildcard swallowing /openapi.json.
- **v0.1.0** (April 2026): Initial self-host release. Proxied + hosted modes, MCP Streamable HTTP, SPA web form + output renderer.
