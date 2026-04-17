<div align="center">
  <img src="./docs/assets/hero-landing.png" alt="Floom" width="900" />

  <h1>Floom</h1>

  <p><strong>Production infrastructure for AI apps that do real work.</strong><br/>
  Vibe-coding speed, production-grade safety.</p>

  <p>
    <a href="https://github.com/floomhq/floom/blob/main/LICENSE"><img src="https://img.shields.io/github/license/floomhq/floom?color=111&label=license" alt="License"/></a>
    <a href="https://github.com/floomhq/floom/pkgs/container/floom-monorepo"><img src="https://img.shields.io/badge/ghcr.io-floom--monorepo-0969da" alt="Docker image"/></a>
    <a href="https://github.com/floomhq/floom/commits/main"><img src="https://img.shields.io/github/last-commit/floomhq/floom" alt="Last commit"/></a>
    <a href="https://floom.dev"><img src="https://img.shields.io/badge/live-floom.dev-22c55e" alt="Live at floom.dev"/></a>
  </p>

  <p>
    <a href="https://floom.dev/build">Try it</a> ·
    <a href="./docs/SELF_HOST.md">Self-host</a> ·
    <a href="./spec/protocol.md">Protocol</a> ·
    <a href="./docs/ROADMAP.md">Roadmap</a>
  </p>
</div>

---

Point Floom at an OpenAPI spec or a repo. In seconds you get a web form, an MCP server an agent can call, an HTTP endpoint, and a CLI command. All from the same manifest, all with auth, rate limits, secret injection, and a shareable output page.

## What it does

- **One manifest, four surfaces.** Web form at `/p/:slug`, MCP server at `/mcp/app/:slug`, HTTP endpoint at `/api/:slug/run`, CLI via `@floom/cli`.
- **Two ingest modes.** Proxied (wrap an existing API) or hosted (Floom runs your Docker container).
- **Production layer included.** Bearer/API-key auth, per-operation rate limits, secret injection, run history, shareable result URLs.
- **Async job queue + custom renderers.** Long-running ops stream status. JSON output can be rendered with your own HTML template.
- **Agent-native.** Every app exposes MCP tools out of the box. Four MCP admin tools (`ingest_app`, `list_apps`, `search_apps`, `get_app`) let an agent add new apps over MCP.

## Who it's for

- **Vibecoder creators** shipping weekend apps (OpenDraft, FlyFast, OpenPaper shape). Paste an OpenAPI URL, publish a shareable page, get an MCP tool your friends can install.
- **Biz users** running internal tooling and productivity apps. Wrap a Stripe-style API in a form your ops team can fill out, with runs logged and outputs rendered cleanly.

Two equal ICPs. Two CTAs side by side. Two dashboards (`/me` for consumers, `/creator` for publishers).

## How it works

```
OpenAPI spec ──▶ Floom manifest ──▶ 4 surfaces
                                    ├─ Web form + output page  (/p/:slug)
                                    ├─ MCP server              (/mcp/app/:slug)
                                    ├─ HTTP endpoint           (/api/:slug/run)
                                    └─ CLI                     (floom run :slug)
```

Floom reads each OpenAPI operation, turns its parameters into a form field or MCP tool input, injects secrets at runtime, and renders the response. No glue code.

<p align="center">
  <img src="./docs/assets/demo-product-page.png" alt="A published Floom app" width="420" />
  &nbsp;
  <img src="./docs/assets/demo-dashboard.png" alt="Creator dashboard" width="420" />
</p>

## Quickstart (cloud)

1. Sign in at [floom.dev](https://floom.dev).
2. Paste an OpenAPI spec URL at [floom.dev/build](https://floom.dev/build).
3. Publish. Share the `/p/:slug` URL, or install the MCP server in your agent.

## Self-host (60 seconds)

```bash
cat > apps.yaml <<'EOF'
apps:
  - slug: resend
    type: proxied
    openapi_spec_url: https://raw.githubusercontent.com/resend/resend-openapi/main/resend.yaml
    base_url: https://api.resend.com
    auth: bearer
    secrets: [RESEND_API_KEY]
    display_name: Resend
    description: "Transactional email API."
EOF

docker run -d --name floom \
  -p 3051:3051 \
  -v floom_data:/data \
  -v "$(pwd)/apps.yaml:/app/config/apps.yaml:ro" \
  -e FLOOM_APPS_CONFIG=/app/config/apps.yaml \
  -e RESEND_API_KEY=re_... \
  ghcr.io/floomhq/floom-monorepo:v0.4.0-mvp.4
```

Then open `http://localhost:3051/p/resend`, or point your agent at `http://localhost:3051/mcp/app/resend`.

Full guide: [docs/SELF_HOST.md](./docs/SELF_HOST.md) · Protocol spec: [spec/protocol.md](./spec/protocol.md)

## The manifest

Two shapes, same surfaces.

```yaml
# Proxied — wrap an existing API
name: stripe
type: proxied
openapi_spec_url: https://docs.stripe.com/api/openapi.json
base_url: https://api.stripe.com
auth: bearer
secrets: [STRIPE_SECRET_KEY]
```

```yaml
# Hosted — Floom runs your container
name: flyfast
type: hosted
runtime: python3.12
openapi_spec: ./openapi.yaml
build: pip install .
run: uvicorn flyfast.server:app --port 8000
```

See real manifests under [`examples/`](./examples).

## Repo layout

- `apps/web` — floom.dev web surface (React, form + output renderer)
- `apps/server` — backend (Hono + SQLite + Docker runner)
- `packages/runtime` — `@floom/runtime`, execution layer
- `packages/cli` — `@floom/cli`, command-line tool
- `packages/detect` — auto-detection for runtimes and build systems
- `packages/manifest` — manifest schema + parser
- `spec/protocol.md` — Floom Protocol spec
- `examples/` — manifests for the launch apps

## Development

```bash
pnpm install
pnpm dev
```

Runs the web app on `:5173` and the server on `:3051` with hot reload.

## Roadmap

High level: job-queue UI, custom-renderer upload UI, workspaces, Composio connections, Stripe Connect, per-user app memory. See [docs/ROADMAP.md](./docs/ROADMAP.md) for the full list with priorities.

## Community

- File an issue: [github.com/floomhq/floom/issues](https://github.com/floomhq/floom/issues)
- Security reports: see [SECURITY.md](./SECURITY.md)
- Contribute: see [CONTRIBUTING.md](./CONTRIBUTING.md)

Built in Hamburg by [@federicodeponte](https://github.com/federicodeponte).

## License

MIT. See [LICENSE](./LICENSE).
