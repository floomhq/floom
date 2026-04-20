# The Floom Protocol

Version: 0.1-draft · Last updated: 2026-04-19

This document describes the Floom protocol — the on-the-wire contracts a Floom server speaks and a Floom client consumes — independently of the reference server in this repository. The reference implementation lives at [`apps/server/`](../apps/server/); this spec is what any alternative server or client MUST implement to interoperate.

---

## 1. Overview

Floom is a protocol for packaging AI app inputs and outputs, running them, and sharing results. A Floom app is described by a **manifest** (inputs, outputs, declared secrets, optional renderer hints). A Floom server accepts runs by app slug and action name, validates inputs against the manifest, executes the app, and returns outputs. Apps are callable over HTTP and over MCP; results can be exposed at a public permalink. Long-running work goes through an async job queue with optional webhook delivery.

---

## 2. Versioning

Every manifest declares `manifest_version`. Two values are currently accepted:

- `"1.0"` — single-action flat layout. `inputs` / `outputs` at top level; normalized to an implicit `run` action.
- `"2.0"` — multi-action layout. `actions` is an object keyed by action name.

New manifests SHOULD declare `"2.0"`. The reference server normalizes `1.0` into the `2.0` shape at load time ([`services/manifest.ts`](../apps/server/src/services/manifest.ts)).

**Deprecation policy.** Additive changes bump the minor version (e.g. `2.0` → `2.1`); clients MUST ignore unknown fields and accept manifests missing newly-added optional fields. Breaking changes bump the major version; servers SHOULD keep reading older major versions for at least one minor release.

**Unknown versions.** A server encountering an unknown `manifest_version` MUST reject with a 400 `ManifestError` and MUST NOT guess a compatible shape. Clients encountering unknown response fields MUST ignore them.

The reference server does not expose a protocol-version endpoint. The MCP surface advertises a server version on the `McpServer` (`0.3.0` for per-app, `0.4.0` for the admin root).

---

## 3. Manifest

The normalized manifest shape (v2.0):

```json
{
  "name": "Blast Radius",
  "description": "Find all files affected by your changes.",
  "manifest_version": "2.0",
  "runtime": "python",
  "apt_packages": ["jq"],
  "secrets_needed": [],
  "actions": {
    "analyze": {
      "label": "Analyze Repo",
      "description": "Clone a public git repo and report which files are touched by a branch diff.",
      "inputs": [
        { "name": "repo_url", "label": "Repo URL", "type": "url", "required": true },
        { "name": "base_branch", "label": "Base Branch", "type": "text", "default": "HEAD~5" }
      ],
      "outputs": [
        { "name": "summary", "label": "Summary", "type": "text" },
        { "name": "changed", "label": "Changed Files", "type": "json" }
      ]
    }
  }
}
```

### Top-level fields

| Field | Type | Required | Notes |
|---|---|---|---|
| `name` | string | yes | Display name. |
| `description` | string | yes | One-line description. |
| `manifest_version` | `"1.0"` \| `"2.0"` | yes | See §2. |
| `runtime` | `"python"` \| `"node"` | no | Defaults to `"python"`. |
| `actions` | `Record<string, ActionSpec>` | yes (v2) | Keys MUST match `/^[a-zA-Z_][a-zA-Z0-9_]*$/`. At least one action required. |
| `inputs` / `outputs` | `InputSpec[]` / `OutputSpec[]` | yes (v1 only) | Flat v1 layout, normalized to a `run` action. |
| `python_dependencies` | `string[]` | no | pip requirement strings. |
| `node_dependencies` | `Record<string, string>` | no | Package → version map. |
| `apt_packages` | `string[]` | no | OS packages available at runtime. |
| `secrets_needed` | `string[]` | no | Names of env vars the app needs (§9). |
| `memory_keys` | `string[]` | no | Keys writable to per-user app memory. |
| `blocked_reason` | string | no | Free-text reason the app can't run (surfaced on the store). |
| `license` | string | no | SPDX identifier (e.g. `"MIT"`), set from `info.license` at ingest. |
| `render` | `RenderConfig` | no | Renderer hints (§3.3). |
| `primary_action` | string | no | Key of the action the /p/:slug runner should select by default on multi-action apps. Must match a key in `actions` (invalid values are ignored, falling back to the first action). Surfaced as a "Primary" pill on the tab. Creators set this from `/studio/:slug`. |

### 3.1 `ActionSpec`

Fields: `label` (string, required), `description?` (string), `inputs` (InputSpec[]), `outputs` (OutputSpec[]), `secrets_needed?` (string[], per-action override of the top-level list).

### 3.2 Inputs and outputs

**`InputSpec`** — one field in the action's input form. Fields: `name` (string, key used in `inputs` at run time), `label` (string), `type` (InputType), `required?` (boolean, default false), `default?` (any), `placeholder?` (string), `description?` (string), `options?` (string[], required when `type: "enum"`).

`InputType` is exactly: `text`, `textarea`, `url`, `number`, `enum`, `boolean`, `date`, `file` (see [`types.ts`](../apps/server/src/types.ts)). Servers MUST reject unknown types with a validation error. Types mentioned in some product copy (`email`, `password`, `json`, `list`) are NOT in the validator; `password` is rendered specially by the default web form for any input whose `name` contains `password` or `secret`, but there is no dedicated schema type.

**`OutputSpec`** — one field in the action's output. Fields: `name`, `label`, `type`, `description?`. Types: `text`, `json`, `table`, `number`, `html`, `markdown`, `pdf`, `image`, `file`.

### 3.3 `RenderConfig`

Creator-declared hints for the default web renderer. All fields optional; unknown keys pass through as props to the chosen component.

```json
"render": {
  "output_component": "FileDownload",
  "bytes_field": "pdf_base64",
  "filename": "slides.pdf",
  "mime": "application/pdf",
  "previewHtml_field": "preview",
  "refinable": true
}
```

- `output_component` — one of `TextBig`, `CodeBlock`, `Markdown`, `FileDownload`. Chosen at Layer 2 of the cascade, before auto-pick.
- `*_field` props — resolve a named key in the run's `outputs` payload.
- `refinable: true` — the output supports follow-up prompts.

For full custom UI, creators upload a TSX bundle via `POST /api/hub/:slug/renderer`; see §10.

---

## 4. Run contract

A run is a single invocation of one action on one app. Two routes exist:

- `POST /api/run` — the body carries `app_slug`.
- `POST /api/:slug/run` — the slug comes from the path.

Both accept the same body (minus `app_slug` on the slug route) and produce the same response.

### Request

```json
{
  "app_slug": "blast-radius",
  "action": "analyze",
  "inputs": { "repo_url": "https://github.com/floomhq/floom" },
  "thread_id": "thr_..."
}
```

- `action` is optional. When omitted, the server selects `"run"` if the manifest has that action, otherwise the first action in iteration order.
- `inputs` is validated against the action's `InputSpec[]`. Missing required fields, wrong-typed values, or non-`options` enums produce a 400.
- `thread_id` (optional) groups runs into a conversation thread.

### Response — 200 OK

```json
{ "run_id": "run_...", "status": "pending" }
```

The response returns immediately. Runs are asynchronous under the hood; the caller observes progress via:

- **SSE**: `GET /api/run/:id/stream` — events `log` (`{ stream: "stdout" | "stderr", text, ts }`) and `status` (full run snapshot). Connection stays open up to 10 minutes.
- **Poll**: `GET /api/run/:id` — returns the current snapshot.

Run snapshot shape: `{ id, app_id, app_slug, thread_id, action, inputs, outputs, logs, status, error, error_type, duration_ms, started_at, finished_at }`. `status` ∈ `pending`, `running`, `success`, `error`, `timeout`.

### Error responses

- **400** — `{ "error": "...", "field"?: "..." }` — invalid input (`field` set when one specific input failed), missing `app_slug`, or unknown `action`.
- **401** — `{ "error": "Unauthorized: missing or invalid Floom token" }` — global auth token mismatch.
- **404** — `{ "error": "App not found: <slug>" }` — unknown slug, or private app not owned by caller (404 to avoid leaking existence).
- **409** — `{ "error": "App is <status>, cannot run" }` — app not `active` (e.g. `deploying`).
- **429** — `{ "error": "rate_limit_exceeded", "retry_after_seconds": N, "scope": "ip" | "user" | "app" }`.
- **500** — `{ "error": "App manifest is corrupted" }` — manifest failed JSON parse on the server.

Terminal `error_type` values on a failed run snapshot: `timeout`, `runtime_error`, `missing_secret`, `oom`, `build_error`.

### Headers

Rate-limited routes (`/api/run`, `/api/:slug/run`, `/api/:slug/jobs`, `/mcp/app/:slug`) set `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`, `X-RateLimit-Scope` on every response; 429 also sets `Retry-After`. Defaults: anon 60/hr per IP, authed 300/hr per user, 500/hr per (IP, app). Override via `FLOOM_RATE_LIMIT_{IP,USER,APP}_PER_HOUR`. Kill switch: `FLOOM_RATE_LIMIT_DISABLED=true`.

### Auth

Three layers, in order:

1. **Global** — when `FLOOM_AUTH_TOKEN` is set, every `/api/*`, `/mcp/*`, `/p/*` request MUST carry a matching `Authorization: Bearer <token>`. `/api/health` and `/api/metrics` are exempt.
2. **App visibility** — `public` (no gate), `auth-required` (same bearer check per app), `private` (only the app's `author` user id passes; others get 404).
3. **Cloud mode** (optional) — with Better Auth enabled, writes (`POST /api/hub/ingest`, `DELETE /api/hub/:slug`, `PATCH /api/hub/:slug`, `POST /api/hub/:slug/renderer`, etc.) require an authenticated session.

Source: [`routes/run.ts`](../apps/server/src/routes/run.ts), [`lib/auth.ts`](../apps/server/src/lib/auth.ts), [`lib/rate-limit.ts`](../apps/server/src/lib/rate-limit.ts).

---

## 5. Jobs contract (async)

Apps declared `is_async: true` run through a durable queue instead of fire-and-forget dispatch. The run contract above still works but returns the pending run immediately; the jobs contract gives webhook delivery, retries, and explicit timeouts.

### `POST /api/:slug/jobs` — enqueue

Request body: `{ action?, inputs, webhook_url?, timeout_ms?, max_retries?, _auth? }`. `webhook_url`, `timeout_ms`, `max_retries` override app defaults for this job only. `_auth` injects per-call secrets (not persisted).

Response — **HTTP 202**: `{ job_id, status: "queued", poll_url, cancel_url, webhook_url_template }`.

- Calling `/jobs` on a non-async app returns 400 with a message pointing to `/run`.
- Default timeout is 30 minutes. Retries apply to worker-level failures only, not 4xx validation errors.

### `GET /api/:slug/jobs/:job_id` — poll

Returns the current job snapshot. Status values: `queued`, `running`, `succeeded`, `failed`, `cancelled`. Shape: `{ id, slug, app_id, action, status, input, output, error, run_id, webhook_url, timeout_ms, max_retries, attempts, created_at, started_at, finished_at }`.

### `POST /api/:slug/jobs/:job_id/cancel` — cancel

Flips a `queued` or `running` job to `cancelled`. Terminal states (`succeeded`, `failed`, `cancelled`) are immutable; calling cancel on them is a no-op that returns the current snapshot.

### Webhook delivery

On each terminal transition, the server POSTs to the job's `webhook_url`:

- Headers: `content-type: application/json`, `user-agent: Floom-Webhook/0.3.0`, `x-floom-event: job.completed`
- Body: `{ job_id, slug, status, output, error, duration_ms, attempts }`. `status` ∈ `succeeded`, `failed`, `cancelled`.

Delivery retries up to 3 times on 5xx / network errors with exponential backoff (500ms doubling). 2xx is success; 4xx is permanent and not retried.

Source: [`routes/jobs.ts`](../apps/server/src/routes/jobs.ts), [`services/jobs.ts`](../apps/server/src/services/jobs.ts), [`services/webhook.ts`](../apps/server/src/services/webhook.ts).

---

## 6. Share contract

Every app has a public permalink at `/p/:slug`. Appending `?run=<run_id>` renders a previously-captured run read-only, so shared links show the same inputs + outputs the author saw.

- **Anonymous, public app** — can load the app definition (`GET /api/hub/:slug`) and a specific run (`GET /api/run/:id`).
- **Anonymous, private app** — both the `/p/:slug` page and the hub endpoint return 404. Existence is not leaked.
- **Anonymous, `auth-required` app** — request must carry the global bearer token.

Run visibility follows app visibility. Runs on public apps are viewable by their run id; servers MUST NOT expose other users' run inputs or outputs through list endpoints. The per-app creator feed (`GET /api/hub/:slug/runs`) is scoped to the caller's own rows even for the app owner (see issue #124).

Source: [`routes/run.ts`](../apps/server/src/routes/run.ts), [`routes/hub.ts`](../apps/server/src/routes/hub.ts).

---

## 7. MCP surface

Floom exposes three MCP endpoints, each a full MCP server:

| Path | Tools | Transport |
|---|---|---|
| `/mcp` | admin — `ingest_app`, `list_apps`, `search_apps`, `get_app` | Streamable HTTP (JSON response mode) |
| `/mcp/search` | `search_apps` only (gallery-wide) | Streamable HTTP |
| `/mcp/app/:slug` | one tool per action on the app | Streamable HTTP |

The reference server uses MCP SDK's `WebStandardStreamableHTTPServerTransport` with `enableJsonResponse: true`. Both JSON-RPC request/response and SSE notifications ride over the same HTTP endpoint. JSON-RPC envelope errors (e.g. unknown slug) return HTTP 200 with an `{ "jsonrpc": "2.0", "error": { ... }, "id": null }` body per the spec.

### 7.1 Admin tools (`/mcp`)

- **`ingest_app`** — create/update an app from an OpenAPI spec. Accepts `openapi_url` OR inline `openapi_spec`; optional overrides `name`, `description`, `slug`, `category`. Auth required in Cloud mode. Rate-limited: 10/user/day. Returns `{ ok, slug, name, created, permalink, mcp_url }`.
- **`list_apps`** — public active apps only. Args: `category?`, `keyword?`, `limit?` (≤200, default 50). Returns `{ total, returned, apps }`.
- **`search_apps`** — natural-language search. Args: `query`, `limit?` (≤50, default 5). Uses OpenAI embeddings when `OPENAI_API_KEY` is set; otherwise keyword scoring. Returns matches with `confidence` 0..1.
- **`get_app`** — fetch one app by slug. Returns the serialized row + full `manifest`.

### 7.2 Per-app tools (`/mcp/app/:slug`)

One tool per action. Naming: action `"run"` → tool = the app slug (non-`[a-z0-9_]` replaced with `_`); any other action → tool = the action name verbatim.

`inputSchema` is derived from `ActionSpec.inputs` as a Zod shape: `number` → `z.number()`, `boolean` → `z.boolean()`, `enum` → `z.enum(options)`, else `z.string()`. Optional inputs get `.optional()`. When `secrets_needed` is non-empty, an optional `_auth` object is appended with one string-typed key per secret name; values are per-call-only and never persisted.

Behavior:

- **Sync apps** — the tool call blocks, polls the run up to 10 minutes, and returns `{ isError, content: [{ type: 'text', text: <JSON snapshot> }] }`.
- **Async apps** — creates a job and returns `{ job_id, status: 'queued', slug, action, poll_url, cancel_url, message }` immediately.
- **Missing secrets** — pre-dispatch, the server checks every `secrets_needed` entry is available (server vault or `_auth`). When any are missing, returns `{ error: 'missing_secrets', required: [...], help: '...' }`.

### 7.3 stdio transport

An alternative stdio MCP surface at [`packages/floom-mcp-stdio/`](../packages/floom-mcp-stdio/) proxies the admin tools to a running Floom server (Claude Desktop wiring: [`docs/CLAUDE_DESKTOP_SETUP.md`](../docs/CLAUDE_DESKTOP_SETUP.md)).

Source: [`routes/mcp.ts`](../apps/server/src/routes/mcp.ts).

---

## 8. Triggers

A trigger fires an app run from an external event. Two dispatcher shapes share one table; the difference is how the run is initiated:

- **`schedule`** — a scheduler worker wakes every 30s, finds triggers whose `next_run_at <= NOW()`, and enqueues a job. `cron_expression` is a standard 5-field crontab (e.g. `0 9 * * 1` = 09:00 every Monday). `tz` is an IANA zone (default `UTC`). Cron parsing follows `cron-parser` semantics (DST-aware).
- **`webhook`** — an external sender POSTs to `/hook/:webhook_url_path` with an HMAC-SHA256 signature. Valid signature + enabled trigger + active app ⇒ 204 No Content and a job is enqueued.

Both shapes converge on the same job-queue dispatch path (§5), so outgoing webhook delivery, retries, and timeouts are reused.

### 8.1. Management endpoints (owner-only)

- **`POST /api/hub/:slug/triggers`** — create a trigger for an owned app. Body: `{ action, inputs?, trigger_type: 'schedule' | 'webhook', cron_expression?, tz? }`. For `webhook`, the server generates and returns `{ webhook_url, webhook_secret, webhook_url_path }` **once** — the secret is never returned again (subsequent GETs mask it). For `schedule`, `cron_expression` is required; `tz` defaults to `UTC`.
- **`GET /api/me/triggers`** — list the caller's triggers (across all their apps).
- **`PATCH /api/me/triggers/:id`** — update `enabled`, `cron_expression`, `tz`, `inputs`, or `action`. Cron changes recompute `next_run_at`.
- **`DELETE /api/me/triggers/:id`** — remove. App deletion cascades (FK ON DELETE CASCADE).

### 8.2. Incoming webhook contract

- **`POST /hook/:webhook_url_path`** — public. Headers:
  - `X-Floom-Signature: sha256=<hex>` (required) — HMAC-SHA256 of the raw request body using `webhook_secret` as the key.
  - `X-Request-ID` (optional) — idempotency key; duplicates within 24h return 200 with `{ deduped: true, request_id }`.
- Returns `204 No Content` on success; the `Location` header points at the created job. 401 on signature mismatch. 404 on unknown path. 204 silently on disabled trigger (no-op, prevents retry storms).
- Body may be empty. If the body is a JSON object with a top-level `inputs` key, those inputs override the stored inputs for this run. Otherwise the stored inputs are used as-is; non-JSON bodies are accepted and ignored.

### 8.3. Outgoing webhook payload (on completion)

When a job finishes, the server POSTs to the app's `webhook_url` (if set) with `{ job_id, slug, status, output, error, duration_ms, attempts, triggered_by, trigger_id? }`. `triggered_by` is `'schedule'`, `'webhook'`, or `'manual'` (direct API call). `trigger_id` is present when `triggered_by !== 'manual'`.

Source: [`routes/triggers.ts`](../apps/server/src/routes/triggers.ts), [`routes/webhook.ts`](../apps/server/src/routes/webhook.ts), [`services/triggers.ts`](../apps/server/src/services/triggers.ts), [`services/triggers-worker.ts`](../apps/server/src/services/triggers-worker.ts).

---

## 9. Hub API

- **`GET /api/hub`** — list every active public app. Query: `category`, `sort` (`default` = featured then `avg_run_ms` asc then newest; also `name`, `newest`, `category`), `include_fixtures=true` to bypass the E2E fixture filter. Returns `[{ slug, name, description, category, author, author_display, icon, actions, runtime, featured, avg_run_ms, created_at }]`. Private apps are NEVER listed; `auth-required` apps ARE listed but still require the bearer token to run.
- **`GET /api/hub/:slug`** — single-app detail. Returns `{ slug, name, description, category, author, author_display, creator_handle, version, version_status, published_at, icon, manifest, visibility, is_async, async_mode, timeout_ms, renderer, created_at }`. Private apps return 404 unless the caller is the owner. `renderer` is `{ source_hash, bytes, output_shape, compiled_at }` when a custom renderer is compiled, else `null`.
- **`GET /api/hub/mine`** — apps owned by the caller's session. Adds `run_count`, `last_run_at`, `visibility`, `is_async`.
- **`GET /api/hub/:slug/runs`** — creator activity feed. Owner-only (Cloud mode requires auth). Runs are scoped to the caller's OWN rows even for the owner, to avoid leaking other users' inputs.
- **`PATCH /api/hub/:slug`** — owner-only. Currently supports only `{ visibility }`.
- **`DELETE /api/hub/:slug`** — owner-only. Runs cascade.
- **`POST /api/hub/detect`** — pre-flight preview. Body: `{ openapi_url, slug?, name? }`. Returns the candidate manifest without persisting.
- **`POST /api/hub/ingest`** — create/update an app from an OpenAPI spec. Body: `{ openapi_url, name?, description?, slug?, category?, visibility? }`. Requires auth in Cloud mode. Returns `{ slug, name, created }` (201 on create, 200 on update).

Source: [`routes/hub.ts`](../apps/server/src/routes/hub.ts).

---

## 10. Secrets

An app declares env vars it needs in `secrets_needed` (top-level) and/or per-action (`ActionSpec.secrets_needed` overrides the top-level list for that action). Example: `{ "secrets_needed": ["GEMINI_API_KEY"] }`.

At run time, the server resolves each name in precedence order:

1. Per-call `_auth` object (job body or MCP `_auth` tool arg) — not persisted.
2. Creator-override value, when the app's `AppSecretPolicyRecord` is `creator_override`.
3. The calling user's vault (`user_secrets`).
4. The process environment (OSS/self-host single-user fallback).

Resolved values are injected into the runner as env vars for the duration of the run. The protocol does not mandate a storage backend.

Source: [`services/runner.ts`](../apps/server/src/services/runner.ts), [`services/user_secrets.ts`](../apps/server/src/services/user_secrets.ts), [`services/app_creator_secrets.ts`](../apps/server/src/services/app_creator_secrets.ts).

---

## 11. Extensibility — what's replaceable

Floom is a protocol, not a single implementation. Adapter interfaces for the five pluggable concerns are formalized in [adapters.md](./adapters.md). The reference implementation ships in this repo (Docker + HTTP proxy runtime, SQLite storage, Better Auth, encrypted-column secrets, in-process metrics + Sentry). Alternate implementations welcome via PRs that conform to the interface contracts.

| Concern | Reference impl | Interface |
|---|---|---|
| Runtime | Docker (Python/Node images) for hosted apps; HTTP proxy for `app_type: "proxied"` | [`RuntimeAdapter`](./adapters.md#runtimeadapter) · [`services/runner.ts`](../apps/server/src/services/runner.ts), [`services/proxied-runner.ts`](../apps/server/src/services/proxied-runner.ts) |
| Storage | SQLite via `better-sqlite3` | [`StorageAdapter`](./adapters.md#storageadapter) · [`db.ts`](../apps/server/src/db.ts) |
| Auth | Synthetic local user in OSS mode; Better Auth (email+password, GitHub/Google, API keys, organizations) in Cloud mode | [`AuthAdapter`](./adapters.md#authadapter) · [`lib/better-auth.ts`](../apps/server/src/lib/better-auth.ts) |
| Secrets | Encrypted SQLite rows (per-workspace DEK, AES-256-GCM) | [`SecretsAdapter`](./adapters.md#secretsadapter) · [`services/user_secrets.ts`](../apps/server/src/services/user_secrets.ts) |
| Observability | In-process counters + `/api/metrics` Prometheus text; optional Sentry | [`ObservabilityAdapter`](./adapters.md#observabilityadapter) · [`lib/sentry.ts`](../apps/server/src/lib/sentry.ts), [`lib/metrics-counters.ts`](../apps/server/src/lib/metrics-counters.ts) |
| **Renderer** | Default cascade of stock components + opt-in per-app TSX bundle | **Runtime-swappable per app.** `POST /api/hub/:slug/renderer` uploads a creator bundle; served sandboxed at `/renderer/:slug/bundle.js` (iframe `sandbox="allow-scripts"`, no `allow-same-origin`, strict CSP). |

The renderer is the only concern that is currently swappable *at runtime* (per-app bundle upload). The other five are *compile-time swappable*: change the adapter import at the server bootstrap and rebuild. The protocol does not require Docker, SQLite, Better Auth, or any specific observability backend — any alternate server MAY implement each concern differently as long as the HTTP and MCP contracts in sections 4-8 hold.

---

## Source references

- Manifest validation: [`apps/server/src/services/manifest.ts`](../apps/server/src/services/manifest.ts)
- Types: [`apps/server/src/types.ts`](../apps/server/src/types.ts)
- Run routes: [`apps/server/src/routes/run.ts`](../apps/server/src/routes/run.ts)
- Jobs routes: [`apps/server/src/routes/jobs.ts`](../apps/server/src/routes/jobs.ts)
- Hub routes: [`apps/server/src/routes/hub.ts`](../apps/server/src/routes/hub.ts)
- MCP routes: [`apps/server/src/routes/mcp.ts`](../apps/server/src/routes/mcp.ts)
- Webhook delivery: [`apps/server/src/services/webhook.ts`](../apps/server/src/services/webhook.ts)
- Triggers (schedule + webhook): [`apps/server/src/routes/triggers.ts`](../apps/server/src/routes/triggers.ts), [`apps/server/src/routes/webhook.ts`](../apps/server/src/routes/webhook.ts), [`apps/server/src/services/triggers.ts`](../apps/server/src/services/triggers.ts), [`apps/server/src/services/triggers-worker.ts`](../apps/server/src/services/triggers-worker.ts)
- Renderer sandbox: [`apps/server/src/routes/renderer.ts`](../apps/server/src/routes/renderer.ts)
- Example manifests: [`apps/server/src/db/seed.json`](../apps/server/src/db/seed.json)
- Auth + rate limit: [`apps/server/src/lib/auth.ts`](../apps/server/src/lib/auth.ts), [`apps/server/src/lib/rate-limit.ts`](../apps/server/src/lib/rate-limit.ts)
