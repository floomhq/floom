# MCP Read/Run Tools

Phase 2B adds an agent-token MCP server at `POST /mcp`. When the request uses `Authorization: Bearer floom_agent_<token>`, `tools/list` exposes these read/run tools instead of the legacy unauthenticated admin toolset.

All examples use Streamable HTTP JSON-RPC:

```bash
curl -sS https://floom.dev/mcp \
  -H 'accept: application/json, text/event-stream' \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer floom_agent_<token>' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

## Scope Rules

- `read`: discovery, app skill reads, run reads, run history, and running `public_live` apps.
- `read-write`: all `read` access plus running apps owned by the token user, including private apps.
- `publish-only`: run history listing only in Phase 2B. Read and run tools return `forbidden_scope`.

`public_live` means `status=active`, `visibility=public`, and `publish_status=published`. Private or auth-required apps are visible to the token user only when the app is owned by that user.

## `discover_apps`

Args:

```json
{ "category": "data", "q": "summarize", "limit": 50, "cursor": "0" }
```

Returns:

```json
{
  "apps": [
    {
      "slug": "lead-scorer",
      "name": "Lead Scorer",
      "description": "Score a lead",
      "category": "sales",
      "visibility": "public_live",
      "runtime": "python",
      "public_link": "https://floom.dev/p/lead-scorer"
    }
  ],
  "next_cursor": null
}
```

REST:

```bash
curl -sS 'https://floom.dev/api/agents/apps?q=summarize&limit=20' \
  -H 'authorization: Bearer floom_agent_<token>'
```

## `get_app_skill`

Args:

```json
{ "slug": "lead-scorer" }
```

Returns:

```json
{ "slug": "lead-scorer", "skill_md": "# Lead Scorer\n...", "etag": "sha256hex" }
```

REST equivalent for the wrapped shape:

```bash
curl -sS https://floom.dev/api/agents/apps/lead-scorer/skill \
  -H 'authorization: Bearer floom_agent_<token>'
```

The public markdown route remains:

```bash
curl -sS https://floom.dev/p/lead-scorer/skill.md
```

## `run_app`

Args:

```json
{ "slug": "lead-scorer", "action": "run", "inputs": { "company": "Acme" } }
```

Returns after the run reaches a terminal state:

```json
{
  "run_id": "run_...",
  "slug": "lead-scorer",
  "action": "run",
  "status": "success",
  "output": { "score": 87 },
  "dry_run": false,
  "model": "python",
  "duration_ms": 1240,
  "started_at": "2026-04-26 12:00:00",
  "completed_at": "2026-04-26 12:00:01"
}
```

REST:

```bash
curl -sS -X POST https://floom.dev/api/agents/run \
  -H 'authorization: Bearer floom_agent_<token>' \
  -H 'content-type: application/json' \
  -d '{"slug":"lead-scorer","inputs":{"company":"Acme"}}'
```

BYOK-gated launch apps (`lead-scorer`, `competitor-analyzer`, `resume-screener`) share the same 5 free runs per user/IP across web, MCP, and REST. After that budget is used, agents must pass `gemini_api_key` in `inputs`, forward `X-User-Api-Key`, or rely on a `GEMINI_API_KEY` already configured in the user's account secrets.

## `get_run`

Args:

```json
{ "run_id": "run_..." }
```

Returns:

```json
{
  "run_id": "run_...",
  "slug": "lead-scorer",
  "status": "success",
  "output": { "score": 87 },
  "started_at": "2026-04-26 12:00:00",
  "completed_at": "2026-04-26 12:00:01",
  "duration_ms": 1240
}
```

REST:

```bash
curl -sS https://floom.dev/api/agents/runs/run_... \
  -H 'authorization: Bearer floom_agent_<token>'
```

The token user must own the run. Explicitly shared runs from public live apps can be read through this endpoint.

## `list_my_runs`

Args:

```json
{ "slug": "lead-scorer", "limit": 20, "cursor": "opaque", "since_ts": "2026-04-26 00:00:00" }
```

Returns:

```json
{
  "runs": [
    {
      "run_id": "run_...",
      "slug": "lead-scorer",
      "status": "success",
      "started_at": "2026-04-26 12:00:00",
      "duration_ms": 1240,
      "dry_run": false
    }
  ],
  "next_cursor": null
}
```

REST:

```bash
curl -sS 'https://floom.dev/api/agents/runs?slug=lead-scorer&limit=20' \
  -H 'authorization: Bearer floom_agent_<token>'
```

## Error Types

REST endpoints return HTTP status plus:

```json
{ "error": "forbidden_scope", "message": "..." }
```

MCP tool calls return `isError: true` with the same JSON object in text content.

Error codes:

- `auth_required` (`401`)
- `forbidden_scope` (`403`)
- `not_found` (`404`)
- `not_accessible` (`403`)
- `invalid_input` (`400`)
- `rate_limit_exceeded` (`429`)
- `runtime_error` (`500`)

## Deferred To Phase 2D

Write tools are not part of Phase 2B. `create_app`, `publish_app`, visibility updates, secret writes, delete, and token rotation remain deferred to Phase 2D.
