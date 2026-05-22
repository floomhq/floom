# Floom V0

The OS for Background Workers.

> Create a worker. Give it tools. Let it run. See everything.

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
- `run.py` — worker code exposing a `run(inputs, context)` function
- `requirements.txt` — Python dependencies

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
