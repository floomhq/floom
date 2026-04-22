# API reference

The HTTP endpoints that matter. Full router source: [`apps/server/src/routes/`](https://github.com/floomhq/floom/tree/main/apps/server/src/routes).

Base URL:

- **Cloud:** `https://api.floom.dev`
- **Self-host:** `http://localhost:3051` (or wherever you published the container)

## Auth

Every authenticated endpoint accepts:

```
Authorization: Bearer <api-key>
```

Get an API key from `floom.dev/me/settings`. Keys start with `flm_live_` (production) or `flm_test_` (dev). Public endpoints (`/api/hub`, `/api/health`, and public app runs) accept unauthenticated calls.

For self-host with a shared token, set `FLOOM_AUTH_TOKEN` and pass it as the bearer.

## Health

```
GET /api/health
```

Returns `200 OK` + `{"ok": true, "version": "v0.3.0"}`. Open even when `FLOOM_AUTH_TOKEN` is set. Use for Docker healthchecks.

## Hub (app catalog)

### `GET /api/hub`

List every public app on this instance.

```bash
curl https://api.floom.dev/api/hub | jq '.[0]'
```

Returns an array of `AppRecord` summaries. Backs the `/apps` directory page and the MCP `/search` surface.

### `GET /api/hub/:slug`

Detail view of a single app — manifest, owner, visibility, run counts.

```bash
curl https://api.floom.dev/api/hub/lead-scorer
```

### `POST /api/hub/detect`

Preview an OpenAPI spec before ingesting. Returns the parsed manifest so the `/build` UI can show a spec preview.

```bash
curl -X POST https://api.floom.dev/api/hub/detect \
  -H "Content-Type: application/json" \
  -d '{"url": "https://petstore3.swagger.io/api/v3/openapi.json"}'
```

Auth required. Blocks private-IP targets (see #378).

### `POST /api/hub/ingest`

Publish an app. Accepts either an OpenAPI spec URL (proxied) or a tarball of a hosted app.

```bash
curl -X POST https://api.floom.dev/api/hub/ingest \
  -H "Authorization: Bearer $FLOOM_KEY" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://petstore3.swagger.io/api/v3/openapi.json", "slug": "petstore"}'
```

Returns the new app record + permalink.

### `GET /api/hub/mine`

Apps owned by the caller's workspace. Auth required.

### `DELETE /api/hub/:slug`

Delete an app. Creator-only. Irreversible.

## Running apps

### `POST /api/apps/:slug/run`

Short form: `POST /api/:slug/run`. Start a synchronous run.

```bash
curl -X POST https://api.floom.dev/api/lead-scorer/run \
  -H "Authorization: Bearer $FLOOM_KEY" \
  -H "Content-Type: application/json" \
  -d '{"action": "score", "inputs": {"icp": "B2B SaaS CFOs", "data": {"__file": true, "name": "leads.csv", "content_base64": "..."}}}'
```

Returns:

```json
{ "run_id": "run_abc123" }
```

### `POST /api/run`

Generic form — slug lives in the body.

```bash
curl -X POST https://api.floom.dev/api/run \
  -H "Authorization: Bearer $FLOOM_KEY" \
  -d '{"app": "lead-scorer", "action": "score", "inputs": {...}}'
```

### `GET /api/run/:id`

Poll a run for final status and outputs.

```json
{
  "id": "run_abc123",
  "status": "completed",
  "outputs": { "rows": [...], "total": 47 },
  "started_at": "2026-04-22T10:00:00Z",
  "completed_at": "2026-04-22T10:00:42Z"
}
```

### `GET /api/run/:id/stream`

SSE stream of stdout + stderr lines for a running job. Closes when the run finishes.

### `POST /api/run/:id/share`

Create a public permalink for the run at `/r/<token>`. Returns the token.

## Async jobs

For long-running work (>5 min sync timeout), use the job queue. Enable per-app in `apps.yaml` with `async: true`.

### `POST /api/:slug/jobs`

Enqueue an async job.

```bash
curl -X POST https://api.floom.dev/api/openpaper/jobs \
  -H "Authorization: Bearer $FLOOM_KEY" \
  -d '{"action": "generate_paper", "inputs": {...}}'
```

Returns `{"job_id": "job_xyz"}`.

### `GET /api/:slug/jobs/:job_id`

Poll a job for status + output.

### `POST /api/:slug/jobs/:job_id/cancel`

Cancel a queued or running job.

## Me (user-scoped)

### `GET /api/me/runs`

Recent runs for the authenticated user.

### `GET /api/me/runs/:id`

Detail view of one of your runs.

### `GET /api/session`

Session shape for the browser. Used by the web client, safe to call from your own integrations if you use Floom's auth.

## MCP

All MCP surfaces live under `/mcp/*`. Point an MCP client at:

- `/mcp/search` — app discovery.
- `/mcp/app/:slug` — run a specific app as an MCP tool.

See [MCP install](/docs/mcp-install) for the client config.

## Error shape

Every 4xx / 5xx response follows this shape:

```json
{
  "error": "code_like_this",
  "message": "Human-readable description.",
  "retry_after_ms": 45000
}
```

Rate-limit errors (429) include `retry_after_ms`. Manifest validation errors (400 `manifest_error`) include a `details` object pointing at the offending field.

## Related pages

- [/docs/mcp-install](/docs/mcp-install)
- [/docs/runtime-specs](/docs/runtime-specs)
- [/docs/cli](/docs/cli)
- [/protocol](/protocol) — full on-the-wire spec
