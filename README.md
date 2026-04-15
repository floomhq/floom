# Floom

**Infra for agentic work.**

One manifest, four surfaces. Any CLI, MCP server, or Python library becomes an MCP tool, an HTTP endpoint, a CLI command, and a web form in 10 seconds.

## What's in this repo

- `apps/web` — the Floom.dev web surface (form input + output renderer at `/p/:slug`)
- `apps/server` — backend (Hono + SQLite + Docker runner)
- `packages/runtime` — `@floom/runtime`, the e2b-backed execution layer
- `packages/cli` — `@floom/cli`, the command-line tool
- `packages/detect` — `@floom/detect`, auto-detect rules for runtimes and build systems
- `packages/manifest` — `@floom/manifest`, manifest schema and parser
- `spec/protocol.md` — the Floom Protocol spec
- `examples/*` — example manifests for the 15 launch apps

## Self-host in 60 seconds

```bash
# Create your apps config
cat > apps.yaml <<'EOF'
apps:
  - slug: stripe
    type: proxied
    openapi_spec_url: https://docs.stripe.com/api/openapi.json
    base_url: https://api.stripe.com
    auth: bearer
    secrets: [STRIPE_SECRET_KEY]
    display_name: Stripe
    description: "Payment processing API."
EOF

# Run Floom
docker run -p 3051:3051 \
  -v $(pwd)/apps.yaml:/app/config/apps.yaml:ro \
  -e FLOOM_APPS_CONFIG=/app/config/apps.yaml \
  -e STRIPE_SECRET_KEY=sk_... \
  ghcr.io/floomhq/floom:latest
```

Floom boots, fetches the Stripe OpenAPI spec, generates a web form + MCP server + HTTP endpoint + CLI. Point your agent at `http://localhost:3051/mcp/app/stripe`.

See [docs/SELF_HOST.md](./docs/SELF_HOST.md) for the full guide.

## Install

```bash
npm install -g @floom/cli
floom deploy owner/repo
```

## The manifest

```yaml
name: flyfast
runtime: python3.12
build: pip install .
run: python -m flyfast.search "${query}"
inputs:
  - name: query
    type: string
    required: true
```

Read the full spec: [`spec/protocol.md`](spec/protocol.md)

## Development

```bash
pnpm install
pnpm dev
```

## License

MIT © 2026 Federico De Ponte
