# Workeros

The open-source, self-hosted runtime for AI workers. Sandboxed by default.

> Create a worker. Give it tools. Let it run. See everything.

## Worker execution model

Every worker runs in an **E2B sandbox by default** — isolated dependencies, no host process access, contained resource usage. The local in-process runner (`runner: local`) is available as an explicit opt-out for trusted bundles where you want zero cold-start latency.

**Cost comparison at typical use (100 runs/day × 30s average):**

| Service | Cost per month | Volume cap |
|---|---|---|
| **workeros + E2B (self-hosted)** | **~$15** | unlimited, $0.20/hr sandbox time |
| Zapier Professional | $49 | 2,000 tasks |
| Zapier Pro Plus | $103 | 5,000 tasks |
| n8n Cloud Pro | $50 | 5,000 executions |
| n8n Cloud Business | $200 | 25,000 executions |
| Make.com Pro | $16 | 10,000 operations |

For workers that fire every few seconds or need offline operation, switch to `runner: local` in `worker.yml`.

---

## Quick Start

### 1. Install backend dependencies

**Linux / macOS**
```bash
cd apps/api
python3.11 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

**Windows**
```powershell
cd apps/api
python -m venv venv
venv\Scripts\activate
pip install -r requirements.txt
```

### 2. Set up secrets

```bash
cp apps/api/.env.example apps/api/.env
# Edit apps/api/.env and fill in at minimum: OPENAI_API_KEY, E2B_API_KEY
```

**Required:**
- `OPENAI_API_KEY` — powers all agent-mode workers
- `E2B_API_KEY` — sandbox execution (get one at e2b.dev)

**Recommended for production:**
- `FLOOM_SECRET` — operator secret that gates all API requests. Omit entirely for unauthenticated local dev.

**Optional integrations:**
- `COMPOSIO_API_KEY` + `COMPOSIO_WEBHOOK_SIGNING_KEY` — Connections feature (OAuth apps, triggers)
- `SLACK_CLIENT_ID` + `SLACK_CLIENT_SECRET` — Slack integration (Emily in Slack, magic sign-in links)
- `WORKEROS_MAGIC_LINK_SECRET` — dedicated HMAC key for magic sign-in links; falls back to `FLOOM_SECRET` then a per-process key if unset

**Secrets encryption key (`.secrets.enc`):**

Worker secrets are stored encrypted in `.secrets.enc` in your workspace. The decryption key is stored out-of-band:

| Setup | Key location |
|---|---|
| Cloud (workeros.floom.dev) | Supabase Vault — managed automatically |
| Self-hosted + GitHub remote | GitHub repo Variable `WORKEROS_SECRETS_KEY` — set automatically on first use |
| Self-hosted, local git only | `~/.config/workeros/secrets.key` (mode 600) — generated automatically on first use |

For local git setups, back up `~/.config/workeros/secrets.key`. Losing it means existing `.secrets.enc` is unreadable and secrets must be re-entered.

### 3. Start the backend

**Linux / macOS**
```bash
cd apps/api
source venv/bin/activate
uvicorn main:app --host 0.0.0.0 --port 8000 --reload
```

**Windows**
```powershell
cd apps/api
venv\Scripts\activate
uvicorn main:app --host 0.0.0.0 --port 8000 --reload
```

### 4. Start the frontend

```bash
cd apps/web
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

---

## Architecture

```
apps/web      Next.js + TypeScript + Tailwind + shadcn/ui
apps/api      FastAPI + SQLite + Pydantic
apps/mcp      MCP server + CLI  (@floomhq/workeros)
workers/      Worker folders (worker.yml + run.py or SKILL.md)
data/         SQLite DB + run artifacts
```

**Platform support:** Linux, macOS, Windows (Python 3.11+, Node 18+).

---

## Workers

Workers live in `workers/<name>/` and contain:

- `worker.yml` — manifest (inputs, outputs, secrets, trigger, runtime)
- `run.py` — worker code exposing a `run(inputs, context)` function (script mode)
- `SKILL.md` — agent prompt (agent mode); mutually exclusive with `run.py`
- `requirements.txt` — Python dependencies

**Writing workers with an AI agent (Claude Code / Cursor):** see [docs/AGENT-COOKBOOK.md](docs/AGENT-COOKBOOK.md) for end-to-end recipes including porting Claude skill bundles.

**Writing workers by hand:** see [docs/AUTHORING.md](docs/AUTHORING.md) for the full `worker.yml` schema, execution modes, secrets, connections, and triggers.

### CLI deploy loop

```bash
npm i -g @floomhq/workeros
workeros login
workeros workers validate ./workers/<id>
workeros workers push ./workers/<id>
workeros run <id> --inputs-file inputs.json
```

### Included workers

- **weekly_update** — Turns raw notes into a polished weekly update (AI, requires approval)
- **csv_enricher** — Enriches CSV rows using custom instructions (AI)
- **research_brief** — Generates markdown research briefs on any topic (AI, requires approval)
- **search_console_insights** — Pulls Google Search Console data and summarises performance

---

## API

Base URL: `http://localhost:8000`

All endpoints require the `x-floom-secret` header (set `FLOOM_SECRET` in `.env`). Omit `FLOOM_SECRET` entirely to run in unauthenticated local dev mode.

**Workers**

| Endpoint | Method | Description |
|---|---|---|
| `/workers` | GET | List workers |
| `/workers/{id}` | GET | Worker detail (includes `missing_secrets`, `missing_connections`) |
| `/workers/reload` | POST | Reload workers from disk |
| `/workers/{id}/runs` | POST | Trigger a run — returns 422 with named items if secrets/connections missing |
| `/workers/import-from-share` | POST | Import a worker from a public share token |

**Runs**

| Endpoint | Method | Description |
|---|---|---|
| `/runs` | GET | List runs |
| `/runs/{id}` | GET | Run detail (includes `tool_calls`, `approval_trail`, `can_replay`, `total_tokens`) |
| `/runs/{id}/approve` | POST | Approve a pending run |
| `/runs/{id}/reject` | POST | Reject a pending run |
| `/approvals` | GET | List pending approvals |

**Connections & Secrets**

| Endpoint | Method | Description |
|---|---|---|
| `/connections` | GET | List connections |
| `/connections/{id}` | GET | Connection detail |
| `/connections/{id}/activity` | GET | Recent runs that used this connection |
| `/connections/{id}/peek` | GET | Recent emails for active Gmail connections (trust signal) |
| `/connections/secrets` | GET | List secret metadata |

**Auth (multi-member mode)**

| Endpoint | Method | Description |
|---|---|---|
| `/auth/magic-link` | POST | Issue a 15-minute personal sign-in URL (authenticated) |
| `/auth/magic/{token}` | GET | Consume a magic-link token and create a session (unauthenticated) |

**System**

| Endpoint | Method | Description |
|---|---|---|
| `/composio-events` | POST | Signed Composio webhook receiver |
| `/healthz` | GET | Health check |
| `/system/overview` | GET | Overview stats, attention items, setup-incomplete alerts |
