# Self-host Floom

Floom is [MIT-licensed](https://github.com/floomhq/floom/blob/main/LICENSE) and ships as a single Docker image. Run a full instance — web UI, MCP server, HTTP API — on any machine with Docker.

The reference container image is `ghcr.io/floomhq/floom`. The live showcase instance lives at [docker.floom.dev](https://docker.floom.dev).

## Quick start with Docker Compose

Copy the reference compose file from the repo:

```bash
git clone https://github.com/floomhq/floom.git
cd floom/docker
cp apps.yaml.example apps.yaml
docker compose up -d
```

Open `http://localhost:3000`. The web UI, MCP server, and HTTP API are all on that port.

Verify it's alive:

```bash
curl http://localhost:3000/api/health
curl http://localhost:3000/api/hub | jq 'length'
```

## Quick start with plain docker run

If you don't want to clone the repo, a single `docker run` works:

```bash
docker run -d --name floom \
  -p 3000:3000 \
  -v floom_data:/data \
  -v "$(pwd)/apps.yaml:/app/config/apps.yaml:ro" \
  -e FLOOM_APPS_CONFIG=/app/config/apps.yaml \
  ghcr.io/floomhq/floom-monorepo:latest
```

Point it at your own `apps.yaml` and the hub populates on boot.

## Environment variables

Source: [`docker/docker-compose.yml`](https://github.com/floomhq/floom/blob/main/docker/docker-compose.yml) and [`docs/SELF_HOST.md`](https://github.com/floomhq/floom/blob/main/docs/SELF_HOST.md).

### Core

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `3000` | HTTP port inside the container. |
| `DATA_DIR` | `/data` | Where SQLite + per-app state live. Mount a volume here to persist across restarts. |
| `PUBLIC_URL` | `http://localhost:$PORT` | URL the server advertises in MCP payloads. |
| `FLOOM_APPS_CONFIG` | — | Path to an `apps.yaml` file. When set, Floom ingests it on boot. |
| `FLOOM_AUTH_TOKEN` | — | When set, `/api/*`, `/mcp/*`, `/p/*` require `Authorization: Bearer <token>`. `/api/health` stays open. |
| `FLOOM_SEED_APPS` | `false` | Seed the 15 bundled Docker demo apps. Requires the Docker socket mount. |
| `FLOOM_MASTER_KEY` | auto-generated | AES-256-GCM key that wraps per-workspace secret encryption keys. Persist this. |

### Rate limits

Every run endpoint enforces these caps. Set `FLOOM_RATE_LIMIT_DISABLED=true` to skip for local dev and tests.

| Variable | Default | What it limits |
|---|---|---|
| `FLOOM_RATE_LIMIT_IP_PER_HOUR` | `150` | Anon callers, across all apps. |
| `FLOOM_RATE_LIMIT_USER_PER_HOUR` | `300` | Signed-in users, across all apps. |
| `FLOOM_RATE_LIMIT_APP_PER_HOUR` | `500` | Per `(IP, app)` pair. Stops one hot app draining the budget. |
| `FLOOM_RATE_LIMIT_MCP_INGEST_PER_DAY` | `10` | Max MCP `ingest_app` calls per user per day. |

### Jobs queue

| Variable | Default | What it does |
|---|---|---|
| `FLOOM_JOB_POLL_MS` | `1000` | Worker poll interval. Lower = faster pickup, more CPU. |
| `FLOOM_DISABLE_JOB_WORKER` | — | Set `true` to stop the background worker. |

### Optional integrations

| Variable | Default | What it does |
|---|---|---|
| `RESEND_API_KEY` | — | Transactional email (password reset, welcome). Without it, emails are logged to stdout. |
| `RESEND_FROM` | — | From address for system email, e.g. `Floom <noreply@send.floom.dev>`. |
| `OPENAI_API_KEY` | — | Enables embedding-based app search. Keyword fallback without it. |
| `COMPOSIO_API_KEY` | — | Enables the Connect-a-tool ramp on `/build`. |

Any other env var matching a name in an app's `secrets:` list is picked up as a server-side secret for that app.

## Volumes and database

- Floom writes to `/data` by default. Mount a named volume (`floom_data:/data` above) to persist across container restarts.
- Database is **SQLite** in WAL mode. No external database needed.
- To back up: stop the container, `docker run --rm -v floom_data:/data alpine tar czf - /data > backup.tgz`.

## `apps.yaml` reference

`apps.yaml` is how you declare which apps live on your instance. Minimal entry for a proxied OpenAPI-based app:

```yaml
apps:
  - slug: petstore
    type: proxied
    openapi_spec_url: https://petstore3.swagger.io/api/v3/openapi.json
    display_name: Petstore
    description: "OpenAPI 3.0 reference pet store."
    category: developer-tools
```

Full schema including auth modes, secrets, async job configuration, and hosted Docker apps lives in [`docs/SELF_HOST.md`](https://github.com/floomhq/floom/blob/main/docs/SELF_HOST.md) in the repo.

## Update and rollback

```bash
# Update to latest
docker compose pull
docker compose up -d

# Pin to a specific version
docker pull ghcr.io/floomhq/floom-monorepo:latest
```

Tags are published for every tagged GitHub release. Use `:latest` for the bleeding edge, or a pinned version for production.

## Gating with a shared token

For private single-tenant deployments, set `FLOOM_AUTH_TOKEN` to a long random string:

```bash
docker run -d --name floom \
  -p 3000:3000 \
  -v floom_data:/data \
  -e FLOOM_AUTH_TOKEN="$(openssl rand -hex 32)" \
  ghcr.io/floomhq/floom-monorepo:latest
```

Every request to `/api/*`, `/mcp/*`, and `/p/*` must now include `Authorization: Bearer <token>`. `/api/health` stays open for probes.

## Related pages

- [/docs/mcp-install](/docs/mcp-install)
- [/docs/runtime-specs](/docs/runtime-specs)
- [/docs/api-reference](/docs/api-reference)
