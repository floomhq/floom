# Workeros

The OS for Background Workers. Open-source, self-hosted, sandboxed by default.

> Create a worker. Give it tools. Let it run. See everything.

## Worker execution model

Every worker runs in an **E2B sandbox by default** — isolated dependencies, no host process access, contained resource usage. The local in-process runner (`runner: local`) remains available as an explicit opt-out for trusted bundles where you want zero cold-start latency.

**Cost comparison at typical use (100 runs/day × 30s average):**

| Service | Cost per month | Volume cap |
|---|---|---|
| **workeros + E2B (self-hosted)** | **~$15** | unlimited, $0.20/hr sandbox time |
| Zapier Professional | $49 | 2,000 tasks |
| Zapier Pro Plus | $103 | 5,000 tasks |
| n8n Cloud Pro | $50 | 5,000 executions |
| n8n Cloud Business | $200 | 25,000 executions |
| Make.com Pro | $16 | 10,000 operations |

For workers that fire every few seconds OR that need offline operation, switch to `runner: local` in `worker.yml`. The stock workers shipped with this repo are pinned to `local` because they're trusted bundles authored by Floom.

---

## Quick Start

### 1. Install backend dependencies

```bash
cd apps/api
python3.11 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

### 2. Set up secrets

```bash
cp .env.example .env
# Edit .env and add your OPENAI_API_KEY
```

For Composio-triggered workers, also set:

- `COMPOSIO_API_KEY` — Composio v3 API key used to enable/disable triggers.
- `COMPOSIO_WEBHOOK_SIGNING_KEY` — HMAC key used to verify `POST /composio-events` (`webhook-id`, `webhook-timestamp`, `webhook-signature`). The endpoint returns 503 when this is missing.

### 3. Start the backend

```bash
cd apps/api
source venv/bin/activate
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
workers/      Worker folders (worker.yml + run.py)
data/         SQLite DB + artifacts
```

---

## Workers

Workers live in `workers/<name>/` and contain:

- `worker.yml` — configuration (inputs, outputs, secrets, trigger, runtime)
- `run.py` — worker code exposing a `run(inputs, context)` function (script mode)
- `SKILL.md` — agent prompt (agent mode); mutually exclusive with `run.py`
- `requirements.txt` — Python dependencies

**See [docs/AUTHORING.md](docs/AUTHORING.md) for the full schema, both execution modes, deploying Claude-style skills, and the agent-side draft contract.** That doc is the source of truth; this section is the elevator pitch.

### Included workers

- **weekly_update** — Turns raw notes into a polished weekly company update (AI-powered, requires approval)
- **csv_enricher** — Enriches CSV rows using custom instructions (AI-powered)
- **research_brief** — Generates markdown research briefs on any topic (AI-powered, requires approval)

---

## API

Base URL: `http://localhost:8000`

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/workers` | GET | List all workers |
| `/workers/{id}` | GET | Worker detail |
| `/workers/reload` | POST | Reload workers from disk |
| `/workers/{id}/runs` | POST | Create a run |
| `/integrations/triggers` | GET | Cached Composio trigger catalog |
| `/composio-events` | POST | Signed Composio trigger webhook receiver |
| `/runs` | GET | List runs |
| `/runs/{id}` | GET | Run detail |
| `/runs/{id}/approve` | POST | Approve a run |
| `/runs/{id}/reject` | POST | Reject a run |
| `/approvals` | GET | List pending approvals |
| `/secrets` | GET | List secret metadata |

---

## Design

- **Frontend**: shadcn/ui components, warm off-white background, calm operational aesthetic
- **Backend**: SQLite for V0, local Python subprocess runner, optional E2B sandbox runner

---

## V0 Checklist

- [x] Worker discovery from `/workers` directory
- [x] UI generates run forms from `worker.yml`
- [x] Manual trigger execution
- [x] Log streaming and storage
- [x] Output display
- [x] Approval workflow (approve/reject)
- [x] Secret availability detection from `.env`
- [x] 3 real example workers with OpenAI integration
