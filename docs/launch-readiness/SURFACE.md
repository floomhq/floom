# Workeros — Surface Discovery (Phase 1)

**Generated**: 2026-05-26
**Repo**: floomhq/workeros
**Frontend**: https://workers.floom.dev (Vercel; deployment protection ON → returns 401 to anonymous traffic)
**API**: https://workers-api.floom.dev (Cloudflare tunnel → self-hosted server FastAPI on :8011; CF WAF requires `x-floom-secret`)
**MCP package**: `@floomhq/workeros@0.1.0` (live on npm)

## API endpoints (30 routes)

### Workers
- `GET /workers` — list
- `GET /workers/{id}` — detail
- `POST /workers` — create from YAML
- `PUT /workers/{id}` — full replace
- `PATCH /workers/{id}` — partial update (trigger, cron, inputs, capabilities, webhook_secret_rotate)
- `DELETE /workers/{id}` — delete + cleanup
- `POST /workers/{id}/pause` / `POST /workers/{id}/unpause`
- `POST /workers/reload` — re-read worker.yml from disk
- `POST /workers/{id}/runs` — manual trigger
- `POST /workers/{id}/webhook-secret/rotate`

### Runs
- `GET /runs` — list (filter by worker_id, limit)
- `GET /runs/{id}` — detail (status, output, artifacts)
- `GET /runs/{id}/logs`
- `GET /runs/{id}/events` — SSE stream
- `GET /runs/{id}/artifacts/{artifact_id}/download`
- `POST /runs/clear`

### Approvals
- `GET /approvals` — pending
- `POST /runs/{id}/approve` / `POST /runs/{id}/reject`

### Secrets
- `GET /secrets` · `POST /secrets/{name}` · `DELETE /secrets/{name}` · `POST /secrets/{name}/test`

### Connections + Integrations
- `GET /integrations/catalog` — full Composio app list (~1000)
- `GET /connections` — connected accounts
- `POST /connections` — initiate OAuth
- `GET /connections/callback` — OAuth redirect landing (auth-exempt)
- `GET /connections/{id}/status`

### Files
- `POST /uploads` — content-hashed sha256 file blob

### Triggers (auth-exempt, signature-verified)
- `POST /webhooks/{worker_id}` — HMAC-SHA256
- `POST /composio-events` — Composio-signed

### Health
- `GET /healthz` — liveness (auth-exempt)

## Frontend routes (Next.js 16 + React 19)

- `/` — landing
- `/workers` — list with folder tree + tag chips + empty state
- `/workers/[id]` — detail (description, sample, run form, transcript tab)
- `/workers/[id]/edit`
- `/workers/new` — YAML generator
- `/connections` — connected accounts (logos + scopes)
- `/connections/browse` — full Composio catalog (~1000)
- `/connections/callback` — OAuth redirect
- `/runs` — run list
- `/runs/[id]` — run detail + SSE-streamed events + transcript
- `/secrets`
- `/settings`

## MCP tools (`@floomhq/workeros@0.1.0`)

9 tools via `npx -y @floomhq/workeros-mcp` (stdio):
- `workers.list`, `workers.get`, `workers.create`, `workers.update`, `workers.delete`, `workers.run`
- `runs.list`, `runs.get`, `runs.watch` (SSE stream)

Install command: `npx @floomhq/workeros install` → prompts for `WORKEROS_API_SECRET`, patches `~/.claude/settings.json` or `~/.cursor/mcp.json`.

## CLI (`cli/floom.py`, Click)

Local Python CLI (NOT published to PyPI):
- `floom dev` — start API + web locally
- `floom reload` — POST /workers/reload
- `floom run <worker> --inputs ...`
- `floom worker <subcommand>`

## Auth flows

- **Developer + agent surface**: `x-floom-secret` header (single shared key). Enforced at Cloudflare WAF (rejects without secret → 403) AND at FastAPI auth middleware (returns 401).
- **Webhooks**: HMAC-SHA256 per-worker rotatable secret on `/webhooks/{id}`.
- **Composio events**: Composio signing key on `/composio-events`.
- **OAuth**: Composio OAuth flow (Gmail, Slack, GitHub, etc.) via `/connections` init + `/connections/callback`.
- **No multi-user**: single shared secret. Multi-user explicitly post-launch (would belong to the separate `managed-deployment` repo).

## Personas

| Persona | How they interact | Auth |
|---|---|---|
| **Federico (owner)** | Frontend on workers.floom.dev, CLI from his Mac, MCP from Claude Code | x-floom-secret (his) |
| **Fresh AI agent** | `npx @floomhq/workeros install` → MCP via Claude/Cursor/Continue | x-floom-secret in config env |
| **Federico's tools** | Composio-connected SaaS apps (Gmail, Calendar, etc.) | OAuth tokens stored in Composio |
| **Webhook senders** | External services posting to `/webhooks/{id}` | HMAC per worker |
| **No anonymous public** | Frontend gated by Vercel deploy protection | n/a |

## Tech inventory

| Layer | Choice |
|---|---|
| Frontend | Next.js 16, React 19, Tailwind, shadcn/ui |
| Backend | FastAPI 0.111, Pydantic 2.7, SQLite |
| Worker runtime | Pure-script: E2B microVMs. Agent: AgentDriver in the API process (trusted platform-controlled bundles by policy). |
| LLM | OpenAI Python SDK 1.35.3, default `gpt-5-mini` |
| Integrations | Composio v3 API |
| Scheduler | croniter |
| Auth | Single `x-floom-secret` (env var) |
| Hosting | Vercel (frontend), self-hosted server + Cloudflare tunnel (API), npm (MCP) |
| Email/transactional | N/A — no outbound email from workeros itself |
| Payments | N/A — no payment surface |
| Multi-tenancy | N/A — single-tenant by design |

## Surfaces explicitly N/A for this audit

- Email deliverability — workeros doesn't send email
- Payments — no Stripe/billing
- Multi-tenant DB row-level security — single-tenant
- Public landing / SEO — Vercel deploy protection on, no anonymous traffic
- Mobile native — web only
- Skills marketplace install path — post-launch (separate skills.floom.dev integration)
