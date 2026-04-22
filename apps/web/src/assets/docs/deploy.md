# Deploy

Three ways to run Floom. Pick one. All three speak the same protocol, so apps move between them without rewriting.

## 1. Cloud — floom.dev (easiest)

Use the hosted instance at [floom.dev](https://floom.dev).

```
https://floom.dev/studio/build
```

Sign in, paste an OpenAPI spec URL (or upload a `floom.yaml` + source), publish. You get a permalink at `floom.dev/p/<slug>` and an MCP server at `floom.dev/mcp/app/<slug>`. Secrets live in an encrypted per-user vault. Free during beta.

Use this when you want to ship today and don't want to run a server.

## 2. Self-host — Docker (free, your infrastructure)

One command brings up the full Floom stack — web form, output renderer, MCP server, HTTP endpoint — on any machine with Docker.

```bash
# 1. Describe which apps you want
cat > apps.yaml <<'EOF'
apps:
  - slug: resend
    type: proxied
    openapi_spec_url: https://raw.githubusercontent.com/resend/resend-openapi/main/resend.yaml
    auth: bearer
    secrets: [RESEND_API_KEY]
    display_name: Resend
    description: Transactional email API.
EOF

# 2. Start Floom
docker run -d --name floom \
  -p 3051:3051 \
  -v floom_data:/data \
  -v "$(pwd)/apps.yaml:/app/config/apps.yaml:ro" \
  -e FLOOM_APPS_CONFIG=/app/config/apps.yaml \
  -e RESEND_API_KEY=re_your_key_here \
  ghcr.io/floomhq/floom-monorepo:latest

# 3. Check it's up
curl http://localhost:3051/api/health
```

Open `http://localhost:3051/p/resend` in a browser, or point your agent at `http://localhost:3051/mcp/app/resend`.

Use this when you want full control, air-gapped deployments, no third-party data path, or simply to run Floom for free forever. MIT licensed.

**Docs:** [full self-host guide](https://github.com/floomhq/floom/blob/main/docs/SELF_HOST.md) covers auth modes, persistence, environment variables, HTTPS setup, and upgrades.

## 3. Hybrid — self-hosted runtime + Floom cloud UI

You run the Floom server on your own box (for the data path, secrets, and app execution) and let your team use [floom.dev](https://floom.dev) as the front door — browsing, sharing runs, installing MCP servers.

This is the pattern big teams use: keep sensitive runs on a private host, use the cloud UI for collaboration and discovery. Setup is identical to self-host; the cloud app points at your runtime URL.

Use this when compliance requires self-hosted execution but you still want a polished team UI.

## Auth (important before you deploy)

Floom ships two independent auth layers that share the same HTTP header. Enable only one per deployment.

- **`FLOOM_AUTH_TOKEN`** — a single operator-wide token. When set, every request must carry `Authorization: Bearer <token>`. Good for a solo box, a CI sandbox, or a staging guard.
- **`FLOOM_CLOUD_MODE=true`** — turns on multi-user sign-in (email + password, GitHub, Google) and per-user API keys. Your teammates each sign up and get their own vault.

A single header can only carry one token. If you enable both on the same deployment, signed-in users get locked out of the API. Read the comment block above `FLOOM_AUTH_TOKEN` in [`docker/.env.example`](https://github.com/floomhq/floom/blob/main/docker/.env.example) before turning either on.

## Persistence

The default image keeps SQLite and per-app state under `/data`. Mount a volume (`-v floom_data:/data`) to survive restarts.

For production, set `PUBLIC_URL` to the URL your users see (Floom uses it in MCP install snippets and share links), put Floom behind a TLS-terminating proxy (nginx, Caddy, Traefik), and set `FLOOM_AUTH_TOKEN` or `FLOOM_CLOUD_MODE` before exposing port 3051.

## Next

- [Limits](./limits) — runtime, memory, file size, and rate-limit numbers.
- [Self-host guide](https://github.com/floomhq/floom/blob/main/docs/SELF_HOST.md) — the long-form version: every environment variable, every auth mode, upgrades, rollbacks.
- [Rollback runbook](https://github.com/floomhq/floom/blob/main/docs/ROLLBACK.md) — rolling back a bad floom.dev deploy.
