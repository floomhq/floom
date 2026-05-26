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

## Architecture (target shape, not yet implemented)

```
┌───────────────────────────────────────────────────────────┐
│  workeros.floom.dev   (Next.js, Vercel)                   │
│  - Supabase auth (Google OAuth + email)                   │
│  - Per-user dashboard                                     │
│  - Billing (Stripe)                                       │
└──────────────┬────────────────────────────────────────────┘
               │
               │ Supabase JWT
               │
┌──────────────▼────────────────────────────────────────────┐
│  api.workeros.floom.dev   (FastAPI, hosted)               │
│  - Auth = Supabase JWT verification (auth.uid())          │
│  - RLS on every table (worker, run, skill_version, etc.)  │
│  - Multi-tenant cron scheduler (per-user croniter)        │
│  - Quotas + billing meters                                │
│  - Webhook receivers use HMAC + tenant routing            │
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

## Stack (target)

| Layer | Choice |
|---|---|
| Frontend | Next.js (Vercel) — `workeros.floom.dev` |
| Backend | FastAPI hosted (likely Hetzner via cloudflared) — `api.workeros.floom.dev` |
| Auth | Supabase Auth (Google OAuth + email magic link) |
| DB | Supabase Postgres with row-level security |
| Sandbox | E2B (per-user, sandboxed by default for hosted) — no local subprocess |
| LLM | OpenAI (default model `gpt-5-mini`, user-configurable) |
| Integrations | Composio v3 (per-user accounts) |
| Billing | Stripe (usage-metered) |
| Email | Resend or Postmark |
| Observability | PostHog + Sentry |

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

**Pre-implementation.** This repo currently only contains the architecture spec. Implementation queued after the open-source `workeros` reaches launch readiness and dogfooding stabilizes Federico's own use case.

## Roadmap

Phase 0 — spec (this README)

Phase 1 — Supabase setup
- New Supabase project
- Schema migration (workers, skill_versions, runs, artifacts, logs, secrets, composio_connections — all with owner_id + RLS)
- Auth providers: Google OAuth, email magic link
- Storage bucket for artifacts per owner

Phase 2 — API auth layer
- Vendor workeros runtime as a submodule or pip install from git
- Wrap with FastAPI middleware that verifies Supabase JWT and injects auth.uid() into every request
- Replace x-floom-secret middleware with JWT middleware
- Adapt run_service + worker_registry to take owner_id

Phase 3 — Frontend
- Port workeros UI from open-source repo
- Add login / signup
- Per-user dashboard

Phase 4 — CLI login flow
- Update @floomhq/workeros to detect hosted vs self-hosted at runtime
- Add `workeros login` subcommand
- Browser-based OAuth dance to mint a CLI JWT

Phase 5 — Billing + quotas
- Stripe subscription
- Usage meters (run counts, agent tokens)
- Quota enforcement at run_service level

Phase 6 — Multi-tenant cron + webhooks
- Per-user cron scheduler
- Webhook URLs include tenant slug
- Composio events routed by connection_id → owner_id

## Notes

- Federico standing 2026-05-26: "the hosted version should be a separate git project as well" — this repo is that project.
- Same primitive logic as the open-source workeros + skills-neo, per `[[workeros-skills-neo-relationship]]` memory.
- This README is the source of truth until implementation starts; do not delete or shrink without an explicit replacement.

## License

Private. Floom internal.
