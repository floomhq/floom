# workeros-cloud

Hosted multi-tenant workeros. Supabase auth, CLI login, runs on Floom infra.

This is the **hosted product**. The runtime engine — agent runtime, sandbox, triggers, manifest parsing — lives in the open-source [`floomhq/workeros`](https://github.com/floomhq/workeros) repo. This repo wraps it with tenancy, auth, billing, and the cloud-native UX.

## Relationship to `workeros` (open source)

```
floomhq/workeros            (open source, MIT)        single-tenant runtime, x-floom-secret auth
        |
        | imported / forked into
        v
floomhq/workeros-cloud      (private, hosted)         Supabase auth, RLS multi-tenant, billing
```

- Both speak the **same WorkerContract manifest** (`schema_version: 0.3`)
- Both expose the **same MCP tool surface** (`workers.list/get/create/update/delete/run` + `runs.list/get/watch`)
- The cloud version's `@floomhq/workeros` MCP package switches `WORKEROS_API_BASE` and uses Supabase JWT instead of `x-floom-secret`

## Architecture (current shape)

```
┌───────────────────────────────────────────────────────────┐
│  workeros.floom.dev   (Next.js, Vercel)                   │
│  - Supabase auth (Google OAuth + email)                   │
│  - Per-user dashboard at /app                             │
│  - Workspace switcher + cloud shell overlay               │
└──────────────┬────────────────────────────────────────────┘
               │
               │ Supabase JWT
               │
┌──────────────▼────────────────────────────────────────────┐
│  workeros-api.floom.dev   (FastAPI, hosted)               │
│  - Auth = Supabase JWT verification (auth.uid())          │
│  - Supabase repositories for workers/runs/secrets/etc.    │
│  - Workspace-scoped data via x-workeros-workspace/cookie  │
│  - Cloud scheduler guarded by Postgres advisory lock      │
│  - Cloud webhook wrapper at /api/webhooks/{worker_id}     │
└──────────────┬────────────────────────────────────────────┘
               │
               │ delegates execution to
               │
┌──────────────▼────────────────────────────────────────────┐
│  workeros runtime (vendored from floomhq/workeros)        │
│  - AgentDriver, sandbox abstractions, run_service         │
│  - Composio integration                                   │
│  - LLM tool loop                                          │
└───────────────────────────────────────────────────────────┘
```

## Persistence & durability

Supabase (Postgres + Storage) is the source of truth; API servers are **stateless** and hydrate workers, git history (versioning/rollback), and contexts from Supabase on demand. Point a new server at the same Supabase — with a writable workers/git dir and the usual creds — and it reconstructs everything as if nothing changed. Sensitive contexts are deliberately kept out of git but still backed up to the `contexts` Storage bucket. Full model: [`docs/GIT-WORKSPACE-CLOUD.md`](docs/GIT-WORKSPACE-CLOUD.md).

## CLI login (mirrors skills-neo pattern)

```bash
npx @floomhq/workeros@latest login
# → opens browser to workeros.floom.dev/cli-auth
# → Supabase OAuth (Google / email)
# → returns short-lived code
# → CLI stores at ~/.workeros/credentials.json
```

After login, the MCP package detects credentials and uses Supabase JWT for API calls. `WORKEROS_API_SECRET` env var continues to work for self-hosted users.

## Stack

| Layer | Choice |
|---|---|
| Frontend | Next.js (Vercel) — `workeros.floom.dev` |
| Backend | FastAPI on Railway - `workeros-api.floom.dev` |
| Auth | Supabase Auth (Google OAuth + email magic link) |
| DB | Supabase Postgres with row-level security |
| Sandbox | E2B (per-user, sandboxed by default for hosted) — no local subprocess |
| LLM | OpenAI (default model `gpt-5-mini`, user-configurable) |
| Integrations | Composio v3 (per-user accounts) |
| Billing | Planned |
| Email | Planned |
| Observability | Runtime health endpoints + planned product telemetry |

## Scheduler Lock

Cloud scheduler boot acquires Postgres advisory lock `87452311` before starting
the in-process cron loop. If another instance already holds the lock, the second
API process logs the conflict and exits instead of double-firing scheduled runs.

## Cloud Runtime Env

Canonical deployment checklist: [docs/CLOUD_DEPLOYMENT.md](docs/CLOUD_DEPLOYMENT.md).

Set these on the Railway `workeros-cloud-api` service for performant E2B repeat
runs:

```bash
WORKEROS_E2B_WARM_POOL_ENABLED=1
WORKEROS_E2B_WARM_POOL_SIZE_PER_KEY=1
WORKEROS_E2B_WARM_POOL_MAX_AGE_SECONDS=900
```

Warm pooling reuses successful read-only local-context sandboxes for the same
worker/template/context shape. Workers with writeable memory/context mounts or
git-backed contexts intentionally stay on the cold path.

Workers that need more sandbox memory declare `resources.memory_mb` in
`worker.yml`. E2B memory is template-backed, so Cloud must provide matching
template ids for the sizes it supports:

```bash
WORKEROS_E2B_PYTHON_TEMPLATE_MEMORY_2048=tpl-python-2gb
WORKEROS_E2B_NODE_TEMPLATE_MEMORY_2048=tpl-node-2gb
```

Requests are capped by `WORKEROS_MAX_WORKER_MEMORY_MB` in the engine, defaulting
to 8192 MB. If a worker requests a size without a matching template env var, the
engine logs a warning and uses the normal runtime template.

LLM-heavy workers, such as NovaSearch judge runs, should declare
`llm_intensive: true` in `worker.yml`. Set the shared provider-concurrency cap on
the Railway `workeros-cloud-api` service so those runs queue instead of stacking
into Vertex/Gemini 429s:

```bash
WORKEROS_MAX_CONCURRENT_LLM_RUNS=1
```

For pooled provider quota and shared 429 backoff, deploy the engine's
`ops/llm-gateway` LiteLLM service with Redis, then set:

```bash
WORKEROS_LLM_GATEWAY_URL=https://<gateway-host>/v1
WORKEROS_LLM_GATEWAY_KEY=<litellm-virtual-key>
```

Leaving the gateway vars unset is the kill switch; workers call their configured
provider directly. The scheduling cap is still useful without the gateway.

## Tenancy model

- Single Supabase project shared across all users
- RLS policies on every row: `auth.uid() = workers.owner_id`
- Per-user storage namespace for artifacts
- E2B sandbox session per user
- Composio user_id = Supabase auth.uid()
- Cron jobs partitioned by owner_id

## Pricing (TBD — placeholder)

Free tier: 100 agent runs / month, 5 workers, 1 Composio connection.
Pro: $29/mo, 5k runs, unlimited workers + connections, custom models.
Team: $99/mo, multi-seat, shared workers.

## Status

Implemented cloud wrapper pieces in this repo include:

- FastAPI cloud wrapper mounted at `/api` with Supabase auth, workspace routes, CLI auth routes, and the vendored engine API.
- Next.js app shell under `/app` with dashboard routes including `/app/assistant`, `/app/connections`, `/app/workers`, and `/app/settings`.
- Workspace switching via `GET/POST /api/workspaces` and `POST /api/workspaces/{id}/select`.
- Workspace Agent instruction storage via `workspace_agent_settings`, with cloud overrides for the engine's `/workspace`, `/chat`, and `/system/workspace-agent` paths.
- Cloud webhook entrypoint at `POST /api/webhooks/{worker_id}`.

Open product gaps are tracked in dated status notes under `docs/`.

## Roadmap Snapshot

Phase 0 — spec (this README) - complete

Phase 1 — Supabase setup
- Supabase schema and repositories exist for the active cloud path.
- Auth providers are wired through Supabase.

Phase 2 — API auth layer
- Engine is vendored as the `engine` submodule.
- SupabaseAuthProvider is registered during cloud startup.
- Repository calls are scoped by user/workspace.

Phase 3 — Frontend
- The Workeros UI is mirrored under `web/app` and cloud overlay routes.
- Login routes and per-user dashboard shell are present.

Phase 4 — CLI login flow
- `@floomhq/workeros` supports `workeros login`, cloud credentials, workspace selection, and `workeros workers push`.

Phase 5 — Billing + quotas
- Billing remains planned.

Phase 6 — Multi-tenant cron + webhooks
- Cloud scheduler and cloud webhook wrapper exist.
- Slack-specific event, slash command, and interactivity endpoints are not present in this repo.

## Notes

- Federico standing 2026-05-26: "the hosted version should be a separate git project as well" — this repo is that project.
- Same primitive logic as the open-source workeros + skills-neo, per `[[workeros-skills-neo-relationship]]` memory.
- Current implementation status is split between this README and dated notes under `docs/`.

## License

Private. Floom internal.
