# The Floom Protocol

Floom is the production layer for AI apps that do real work. This spec defines how a tool becomes a Floom app.

## One spec, every surface

A tool becomes a Floom app by providing an **OpenAPI spec**, either as a URL (proxied mode) or embedded in a repo (hosted mode). From that spec, Floom derives every agent-callable surface and wraps it in a full production layer.

## The manifest

Two modes:

### Proxied: wrap an existing API

```yaml
name: stripe
type: proxied
openapi_spec_url: https://raw.githubusercontent.com/stripe/openapi/master/openapi/spec3.json
base_url: https://api.stripe.com
auth: bearer
secrets: [STRIPE_SECRET_KEY]
```

### Hosted: Floom runs your app

```yaml
name: my-app
type: hosted
runtime: python3.12      # optional, auto-detected from pyproject.toml/requirements.txt
openapi_spec: ./openapi.yaml
build: pip install .
run: uvicorn my_app.server:app --port 8000
```

## What gets generated automatically

From the OpenAPI spec, Floom derives:

- **MCP server**: each OpenAPI operation becomes an MCP tool, with the operation's parameters as the tool's inputs and the response schema as the output.
- **HTTP API**: Floom proxies requests to the underlying service, injecting secrets at runtime and enforcing rate limits / access control.
- **Web**: inputs are rendered as a form (typed by the OpenAPI schema) and outputs are piped through a built-in renderer. Long-running operations stream output.
- **Typed SDKs**: openapi-generator spits out clients in any language.

## Plumbing layers (auto-applied)

Every Floom app gets:

- Secrets vault (injected as env vars at runtime)
- Rate limiting (global + per-IP, custom per-operation)
- Streaming output for long-running operations
- Run history + audit log
- (Coming soon) Access control, staging environments, version control, per-app databases, OAuth, payment / billing

## Plain-language launch docs

If you want the operational answers first:

- [/docs/limits](/docs/limits) for runtime caps, rate limits, concurrency, and scale path
- [/docs/security](/docs/security) for sandboxing, secrets, and BYOK
- [/docs/observability](/docs/observability) for logs, metrics, and error tracking
- [/docs/workflow](/docs/workflow) for CI, preview deploys, rollback, and publishing flow
- [/docs/ownership](/docs/ownership) for self-host and lock-in questions
- [/docs/reliability](/docs/reliability) for the current launch-week SLA stance
- [/docs/pricing](/docs/pricing) for cloud beta and monetization status

## Self-hosting

Floom is MIT licensed. Floom.dev is the hosted flagship, but you can run the full stack yourself.

**Via Docker** (one command):
```bash
docker run -p 3051:3051 \
  -e OPENAI_API_KEY=... \
  ghcr.io/floomhq/floom-monorepo:latest
```

**Same runtime on cloud and self-host.** v1 runs Docker everywhere. v1.1 adds Cloud Run scale-to-zero on floom.dev (invisible to creators, manifest format unchanged).

## Why OpenAPI?

OpenAPI is the industry-standard contract for describing an API. Every serious SaaS publishes one. Every code-generator tool reads one. Floom meeting creators at the OpenAPI layer means:

1. **Zero new format to learn**: you probably already have an OpenAPI spec
2. **Single source of truth**: the spec is the contract; every surface is derived mechanically
3. **No drift**: when the spec changes, every surface updates
4. **Instant ecosystem compatibility**: works with every tool that speaks OpenAPI

## API surface

```
GET  /api/hub                       -> list all apps
GET  /api/hub/:slug                 -> app detail + manifest
POST /api/pick  { prompt, limit }   -> ranked app picks for a query
POST /api/parse { prompt, app_slug, action } -> structured inputs from prose
POST /api/run   { app_slug, inputs, action, thread_id } -> { run_id, status }
GET  /api/run/:id                   -> run snapshot
GET  /api/run/:id/stream            -> SSE: log lines + status transitions
POST /api/thread                    -> create thread
POST /api/thread/:id/turn           -> save turn
GET  /api/health                    -> { ok: true, ... }
```

## MCP surface

Each app exposes a per-app MCP server at `/mcp/app/{slug}`. The MCP server uses HTTP+SSE transport (MCP spec 2024-11-05). Tools are generated from the OpenAPI spec: each operation becomes one MCP tool, with the operation's parameters mapped to JSON Schema properties.

```
GET  /mcp/app/stripe          -> SSE stream (MCP notifications)
POST /mcp/app/stripe          -> MCP JSON-RPC (tool calls, initialize, etc.)
```

## License

MIT. Open source. Self-hostable. Fork welcome.
