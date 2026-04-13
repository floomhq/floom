# Self-host Floom

Run a full Floom instance — chat UI, MCP server, HTTP endpoint — on any machine with Docker.

## Quick start

```bash
# 1. Create your apps config
cat > apps.yaml <<'EOF'
apps:
  - slug: httpbin
    type: proxied
    openapi_spec_url: https://httpbin.org/spec.json
    base_url: https://httpbin.org
    auth: none
    display_name: HTTPBin
    description: "Echo any HTTP request."
    category: developer-tools
EOF

# 2. Run Floom
docker run -d --name floom \
  -p 3051:3051 \
  -v $(pwd)/apps.yaml:/app/config/apps.yaml:ro \
  -e FLOOM_APPS_CONFIG=/app/config/apps.yaml \
  ghcr.io/floomhq/floom-monorepo:latest

# 3. Verify
sleep 10
curl http://localhost:3051/api/health
```

Open `http://localhost:3051` in your browser.

## Config schema

`apps.yaml` contains a list of apps. Each app supports these fields:

| Field | Required | Description |
|-------|----------|-------------|
| `slug` | yes | Unique identifier. Used in URLs: `/api/:slug/run`, `/mcp/app/:slug` |
| `type` | yes | `proxied` (external API via URL) or `hosted` (docker-based app) |
| `openapi_spec_url` | for proxied | Public URL to an OpenAPI 3.x spec (JSON or YAML) |
| `base_url` | for proxied | Base URL of the external API |
| `auth` | no | `bearer`, `apikey`, or `none` (default: `none`) |
| `secrets` | no | List of env var names needed for auth |
| `display_name` | no | Human-readable name |
| `description` | no | Short description shown in the UI |
| `category` | no | Category tag (e.g. `developer-tools`, `analytics`) |
| `icon` | no | URL to an icon image |

## Auth modes

### No auth
```yaml
auth: none
```

### Bearer token (OAuth / JWT)
```yaml
auth: bearer
secrets: [MY_SERVICE_TOKEN]
```

Pass the secret at runtime:
```bash
docker run ... -e MY_SERVICE_TOKEN=sk_live_xxx ghcr.io/floomhq/floom-monorepo:latest
```

### API key header
```yaml
auth: apikey
secrets: [MY_API_KEY]
```

Injected as `X-API-Key: <value>`.

## Secrets handling

Secrets are passed as environment variables at container startup. They are stored in the local SQLite database (at `DATA_DIR`, default `/data`) and injected into requests at runtime. They are never logged.

Persistent data lives at `/data` — mount a volume to preserve across restarts:
```bash
docker run -v floom_data:/data ...
```

## MCP client integration

Every registered app exposes an MCP server at `/mcp/app/:slug`.

### Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "httpbin": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "http://localhost:3051/mcp/app/httpbin"]
    }
  }
}
```

See [CLAUDE_DESKTOP_SETUP.md](./CLAUDE_DESKTOP_SETUP.md) for more detail.

### Any MCP client

The endpoint uses the MCP Streamable HTTP transport. Required headers:
```
content-type: application/json
accept: application/json, text/event-stream
```

Example:
```bash
# List tools
curl -X POST http://localhost:3051/mcp/app/httpbin \
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

Returns `{ run_id, status }` immediately. Poll `GET /api/run/:run_id` for the result.

## Proxied vs hosted mode

| Mode | How it works | When to use |
|------|-------------|-------------|
| `proxied` | Floom fetches the OpenAPI spec and routes requests to `base_url` | Any public or private API with an OpenAPI spec |
| `hosted` | Floom pulls and runs a Docker image with the app's code | Custom apps that need code execution |

The 15 apps bundled with Floom (flyfast, blast-radius, etc.) all use hosted mode with pre-built Docker images. OpenAPI ingest adds proxied apps on top.

## docker-compose

See `docker/docker-compose.yml` for a full compose reference:

```bash
cp apps.yaml docker/apps.yaml
docker compose -f docker/docker-compose.yml up -d
```

## Troubleshooting

**"App not found" on /api/:slug/run**
The slug in the URL must match exactly. Check `GET /api/hub` for the list.

**Proxied app returns error but the direct API works**
Check that `base_url` doesn't have a trailing slash and that `openapi_spec_url` is accessible from inside the container. Test: `docker exec floom curl <openapi_spec_url>`.

**httpbin spec fails to parse**
httpbin's spec is Swagger 2.0, not OpenAPI 3.x. Floom handles both — the operation names are generated from `operationId` or `METHOD_path`.

**Embeddings backfill fails with 401**
Embeddings (used for the "pick" feature) need a valid `OPENAI_API_KEY`. If you don't have one, the app still works — pick/search just won't rank results.

**Port already in use**
Change the host port: `docker run -p 8080:3051 ...` and open `http://localhost:8080`.
