# The Floom Protocol

Floom is the production layer for AI apps that do real work. This spec defines how a tool becomes a Floom app.

## One spec, every surface

In v17, a tool becomes a Floom app by landing an **OpenAPI contract** through a supported ingest path. A **GitHub repository URL** runs in hosted mode: Floom reads `apps.yaml` and/or an OpenAPI file at the repo root and runs the app. An **OpenAPI spec URL** runs in proxied mode: we fetch the contract and forward to your existing origin. The same spec drives the web form, MCP tools, HTTP API, and clients—**GitHub** is the recommended starting point when you can use a repo so Floom owns the runtime, while **OpenAPI URL** is the escape hatch for an API you already host.

- **GitHub repo URL (hosted):** public repo; Floom reads `apps.yaml` and/or an OpenAPI file from the root.
- **OpenAPI URL (proxied):** paste a public spec URL; Floom uses it in proxied mode against your `base_url`.

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

Write the spec once. Floom turns it into four things your users actually touch:

- **Agent-callable tools** (MCP server). MCP — Model Context Protocol — is how agents like Claude, Cursor, and ChatGPT discover and call external tools. Every operation in your spec becomes one tool your agent can call, using the spec's parameters as inputs and the response schema as structured output.
- **A web UI** that users can run without any agent. Floom reads the spec's input types and renders the right form controls automatically (a date picker for a date, a file uploader for a file, a text area for a long string). Output flows through a built-in renderer; long-running operations stream their progress live so the page doesn't just spin.
- **An HTTP API** that anyone — your own code, another team's service, a curl command — can hit. Floom handles the auth tokens, rate limits, and keeps secrets out of your codebase.
- **Client libraries in any language** (TypeScript, Python, Go, Java, Rust, …). We use [openapi-generator](https://openapi-generator.tech/) — a standard tool that reads your spec and outputs a ready-to-install SDK — so your users can `pip install` or `npm install` and skip the raw HTTP step entirely.

## Plumbing layers (auto-applied)

Every Floom app gets these for free. We split what's shipped from what's on the roadmap so you don't build a mental model around features that don't exist yet.

### Shipped

- Secrets vault (injected as env vars at runtime)
- Rate limiting (global + per-IP, custom per-operation)
- Streaming output for long-running operations
- Run history + audit log

### Roadmap

- Access control
- Staging environments
- Version control
- Per-app databases
- OAuth
- Payment / billing

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

Each app exposes its own MCP server at `/mcp/app/{slug}` that agents like Claude, Cursor, and ChatGPT can connect to directly — point them at the URL, they discover the tools, your users can say "run this" in plain English.

Under the hood we speak the current MCP standard (version 2024-11-05, transported over HTTP with server-sent events — SSE — for the push channel). You don't have to know any of this to use Floom; we only call it out here so the few people writing their own MCP clients can verify compatibility.

Tools are generated straight from your OpenAPI spec: one operation → one tool, with each parameter mapped to a JSON Schema field the agent can fill.

```
GET  /mcp/app/stripe          -> SSE stream (server-sent events — MCP notifications push here)
POST /mcp/app/stripe          -> MCP JSON-RPC (tool calls, initialize, etc.)
```

## License

MIT. Open source. Self-hostable. Fork welcome.
