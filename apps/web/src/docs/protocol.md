# Protocol

One manifest, five surfaces. Every app registered on Floom — whether declared in `apps.yaml`, ingested at runtime via `POST /api/hub/ingest`, or created through the MCP admin surface — is reachable from five places at once. The protocol is transport-agnostic: HTTP, MCP per-app, MCP admin, CLI, and the Chat UI all drive the same runtime.

## 1. HTTP

Every app exposes a direct HTTP endpoint. Synchronous request, JSON in, JSON out, rate-limited.

```bash
curl -sX POST http://localhost:3051/api/petstore/run \
  -H 'content-type: application/json' \
  -d '{
    "action": "listPets",
    "inputs": { "limit": 3 }
  }'
```

Returns a `run_id` and the response payload. Status is `succeeded` when the upstream call completed, `error` when anything in the chain failed.

## 2. MCP per-app

Every registered app is also its own MCP server at `/mcp/app/:slug`. MCP protocol version `2024-11-05`. Claude Desktop compatible.

```bash
# Via @modelcontextprotocol/inspector
npx @modelcontextprotocol/inspector http://localhost:3051/mcp/app/petstore
```

Or via raw JSON-RPC:

```bash
curl -X POST http://localhost:3051/mcp/app/petstore \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

The per-app MCP server lists one tool per operation in the OpenAPI spec, with the full JSON Schema from the spec included as `inputSchema`. Apps that declare `secrets` get an extra `_auth` object on every tool so MCP clients can inject per-call credentials.

## 3. MCP admin (new in v0.4.0-mvp.5)

A separate admin MCP server lives at `/mcp` (no slug suffix) and exposes four tools so MCP clients can manage the hub without the web UI:

| Tool | Auth | Purpose |
|---|---|---|
| `ingest_app` | Cloud: signed-in. OSS: open. | Create or update an app from an OpenAPI spec. Accepts `openapi_url` or inline `openapi_spec`. Returns `{slug, permalink, mcp_url, created}`. |
| `list_apps` | Public | List active apps, optionally filtered by `category` or `keyword`. |
| `search_apps` | Public | Natural-language search. Uses OpenAI embeddings when `OPENAI_API_KEY` is set; keyword fallback otherwise. |
| `get_app` | Public | Fetch one app by slug with the full manifest including every operation's schema. |

Point any MCP client at `http://localhost:3051/mcp`:

```bash
curl -X POST http://localhost:3051/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

`ingest_app` mirrors the HTTP ingest auth rules. In Cloud mode, anonymous callers receive a structured `{error: "auth_required"}`. MCP ingest is separately rate-limited at 10 per day per caller.

## 4. CLI

The `@floom/cli` npm package wraps the HTTP surface for terminal workflows:

```bash
npm install -g @floom/cli
floom run petstore/listPets --inputs '{"limit": 3}'
```

`floom deploy <github-repo>` is a shortcut for publishing an app from a repo with a `floom.yaml` at its root. The CLI reads your local `~/.floom/auth.json` for API tokens.

## 5. Chat UI

Every app also renders as a web form at `/p/:slug`. No code path, no CLI, no MCP client — you paste inputs, click run, and watch the response render with the per-app output card.

Open the URL, paste a prompt, watch the run. The same runtime that serves HTTP and MCP serves this render loop. Share the `?run=<id>` URL to send the run result to someone else.

## Self-host

The protocol runs anywhere Docker runs. See [Self-hosting](/docs/self-hosting) for the full guide: `apps.yaml`, env vars, Better Auth, Supabase, the async job queue, and troubleshooting.
