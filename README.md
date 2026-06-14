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
| Backend | FastAPI hosted (likely Hetzner via cloudflared) — `api.workeros.floom.dev` |
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

## Hosting & worker storage (read before touching cloud workers/deploys)
workeros.floom.dev = CLOUD = **Railway** backend (manual `railway up`) + Vercel frontend. workers.floom.dev = OSS = AX41. Cloud workers are stored portably in Supabase `_files` (never a disk path). Full model: [docs/CLOUD-WORKER-STORAGE-MODEL.md](docs/CLOUD-WORKER-STORAGE-MODEL.md).
