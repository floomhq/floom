# Self-hosting

Run a full Floom instance — web form, MCP servers, HTTP endpoints, CLI target — on any machine with Docker. No external dependencies, no registry keys, no build step.

## Prerequisites

- Docker (any recent version)
- 512 MB RAM available to the container
- A free port on the host (default: `3051`)
- Optional: a public URL if you want Claude Desktop or other remote MCP clients to reach the instance

## Quick start

Create an `apps.yaml` declaring what apps the instance should host, then run Floom with that file mounted:

```bash
cat > apps.yaml <<'EOF'
apps:
  - slug: petstore
    type: proxied
    openapi_spec_url: https://petstore3.swagger.io/api/v3/openapi.json
    display_name: Petstore
    description: "OpenAPI 3.0 reference pet store."
    category: developer-tools

  - slug: resend
    type: proxied
    openapi_spec_url: https://raw.githubusercontent.com/resend/resend-openapi/main/resend.yaml
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
  -e RESEND_API_KEY=re_xxx \
  ghcr.io/floomhq/floom-monorepo:v0.4.0-mvp.4
```

Verify:

```bash
curl http://localhost:3051/api/health
curl http://localhost:3051/api/hub | jq 'length'
```

Open `http://localhost:3051` in a browser or point an MCP client at `http://localhost:3051/mcp/app/petstore`.

As of v0.2.0 the default image boots with an empty hub. You declare every app via `apps.yaml`. No Docker socket mount is needed for proxied apps.

## Environment variables

| Var | Default | Description |
|-----|---------|-------------|
| `PORT` | `3051` | HTTP port inside the container |
| `DATA_DIR` | `/data` | Where SQLite + per-app state live. Mount a volume here to persist across restarts |
| `PUBLIC_URL` | `http://localhost:$PORT` | What the server advertises as its own URL in MCP payloads |
| `FLOOM_APPS_CONFIG` | — | Path to an `apps.yaml` file. Ingested on boot when set |
| `FLOOM_SEED_APPS` | `false` | Set to `true` to seed the 15 bundled hosted apps. Requires `/var/run/docker.sock` mounted |
| `FLOOM_AUTH_TOKEN` | — | When set, all `/api/*`, `/mcp/*`, `/p/*` requests require `Authorization: Bearer <token>`. `/api/health` stays open |
| `FLOOM_MAX_ACTIONS_PER_APP` | `200` | Hard cap on how many operations one OpenAPI spec exposes. `0` = unlimited (needed for Stripe, GitHub) |
| `FLOOM_JOB_POLL_MS` | `1000` | Background worker poll interval for the async job queue |
| `FLOOM_RATE_LIMIT_DISABLED` | — | Set to `true` to skip every rate limit (tests, admin scripts) |
| `FLOOM_RATE_LIMIT_IP_PER_HOUR` | `20` | Runs per IP per hour for anonymous callers |
| `FLOOM_RATE_LIMIT_USER_PER_HOUR` | `200` | Runs per authenticated user per hour |
| `FLOOM_RATE_LIMIT_APP_PER_HOUR` | `50` | Runs per (IP, app) pair per hour |
| `FLOOM_RATE_LIMIT_MCP_INGEST_PER_DAY` | `10` | MCP `ingest_app` calls per user per day |
| `OPENAI_API_KEY` | — | Optional. Enables embedding-based app search. Keyword fallback without it |

Any other env var matching a name in an app's `secrets` list (e.g. `RESEND_API_KEY`) is picked up as a server-side secret for that app.

## Enabling cloud features

### Better Auth (Google OAuth, email + password)

Floom Cloud uses Better Auth for multi-user sign-in. Switch to Cloud mode by setting:

```
FLOOM_CLOUD_MODE=true
BETTER_AUTH_SECRET=<32-byte-random-hex>
BETTER_AUTH_URL=https://your-floom-host
DATABASE_URL=postgresql://user:pass@host:5432/floom
```

Better Auth migrations run automatically on boot when `FLOOM_CLOUD_MODE=true`. Mount the Postgres DB at `DATABASE_URL` — SQLite is fine for solo mode, but multi-user auth needs Postgres for row-level auth tables.

Configure OAuth providers through Better Auth env vars (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`). Email + password works out of the box.

### Supabase

If you want to point Floom at an existing Supabase Postgres instance instead of running your own, set `DATABASE_URL` to the Supabase pooler connection string. Everything else stays the same.

Anonymous visitors carry a `floom_device` cookie (HttpOnly, SameSite=Lax, 10-year TTL). On first login, every device-scoped row (memory, runs, threads, secrets) is atomically re-keyed to the user's account via `rekeyDevice`. Idempotent — re-running is a no-op. Same pattern Linear documented in 2022.

## Docker compose

```yaml
version: "3.9"
services:
  floom:
    image: ghcr.io/floomhq/floom-monorepo:v0.4.0-mvp.4
    ports:
      - "3051:3051"
    volumes:
      - floom_data:/data
      - ./apps.yaml:/app/config/apps.yaml:ro
    environment:
      FLOOM_APPS_CONFIG: /app/config/apps.yaml
      # FLOOM_AUTH_TOKEN: "choose_a_long_random_string"
    restart: unless-stopped

volumes:
  floom_data:
```

## Persistence

Everything lives at `/data`:

- `floom-chat.db` + `floom-chat.db-wal` + `floom-chat.db-shm` — SQLite database
- `apps/` — per-app working directories (hosted apps only)
- `renderers/` — compiled custom renderer bundles

Always mount `/data` to a named volume or a host directory. `docker run --rm` without a volume throws away all state including ingested apps.

## Security

- Never expose port 3051 to the public internet without setting `FLOOM_AUTH_TOKEN`. With no auth, anyone with your URL can call any app and exhaust your API quotas.
- Avoid mounting `/var/run/docker.sock` unless you trust everyone who can reach port 3051. The Docker socket inside a networked container grants host root.
- `FLOOM_SEED_APPS` is off by default for exactly this reason: it requires the Docker socket mount.
- `visibility: auth-required` in `apps.yaml` lets you keep some apps public while gating specific ones behind `FLOOM_AUTH_TOKEN`.

## Troubleshooting

**`App not found` on `/api/:slug/run`**
Check `GET /api/hub` for the list of slugs. Comparison is case-sensitive.

**Proxied app returns 404 but the upstream API works**
Before v0.2, the runner dropped the path prefix of `base_url`. Upgrade to `v0.2.0` or later. If you're already on `v0.2`, check `docker logs floom` — the `[proxied] GET <url>` line shows the exact URL being requested.

**OpenAPI spec fetch fails**
Verify the URL is reachable from inside the container: `docker exec floom wget -qO- <url>`. Firewalls and VPN-only endpoints need extra network config.

**Data gone after restart — no `/data` volume**
Always run with `-v floom_data:/data` or a host mount. Without it, the SQLite DB and every ingested app disappear on container recreate.

**Stale DB after an upgrade**
Always mount the same `/data` volume across image upgrades. Schema migrations run automatically on boot, but a pristine volume wipes every row.

**Port already in use**
`docker run -p 8080:3051 ...` swaps the host-side port. The container still listens on `3051` internally.

**Large specs are truncated to 200 operations**
Set `FLOOM_MAX_ACTIONS_PER_APP=0` to lift the cap. The `docker logs` output shows a truncation warning with the spec's total operation count.

**`OPENAI_API_KEY missing` warning**
Embeddings-based app search needs it. Safe to ignore — search falls back to keyword matching.

Full env var reference and advanced topics (proxied vs hosted mode, multi-tenant schema, secrets vault, per-user memory) live in [`docs/SELF_HOST.md`](https://github.com/floomhq/floom-monorepo/blob/main/docs/SELF_HOST.md) in the repo.
