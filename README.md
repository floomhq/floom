# Workeros

The open-source, self-hosted runtime for AI workers. Sandboxed by default.

> Create a worker. Give it tools. Let it run. See everything.

## Worker execution model

Pure-script workers run in an **E2B sandbox by default** — isolated dependencies, no host process access, contained resource usage. Agent workers (`SKILL.md`) run through the API-hosted AgentDriver tool loop. There is no supported local in-process worker runner.

You pay only for sandbox execution time (E2B bills per second of run time), with **no per-task or per-execution caps** — unlike task-metered automation platforms. Tune schedules and worker code to keep run time low.

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
- `OPENAI_API_KEY` — the default model provider (powers Emily, agent-mode workers, and codegen)
- `E2B_API_KEY` — sandbox execution (get one at e2b.dev)

**Model providers (OpenAI by default, or AWS Bedrock / Claude):**

The backend is provider-agnostic: each model call is selected by a *model id* and
routed through litellm. OpenAI is the zero-config default. To use another provider,
point the per-role model vars at that provider's id and supply its credentials:

| Env var | Role | Default |
| --- | --- | --- |
| `WORKEROS_WORKER_AGENT_MODEL` | tool-calling worker agents | `gpt-5.5` |
| `WORKEROS_CHAT_MODEL` | Emily (chat assistant) | `gpt-5.4-mini` |
| `WORKEROS_CODEGEN_MODEL` | worker codegen / draft / repair | `gpt-5.5` |
| `WORKEROS_SUGGEST_MODEL` | worker-edit conflict check | codegen model |

Example — AWS Bedrock (Claude Sonnet 4.6):

```bash
WORKEROS_WORKER_AGENT_MODEL=bedrock/us.anthropic.claude-sonnet-4-6
WORKEROS_CHAT_MODEL=bedrock/us.anthropic.claude-sonnet-4-6
WORKEROS_CODEGEN_MODEL=bedrock/us.anthropic.claude-sonnet-4-6
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
AWS_REGION_NAME=us-west-2
```

Anthropic models on Bedrock require submitting the one-time "use case details" form
in the Bedrock console (per region). Prompt caching of the static system prompt is
applied automatically on Anthropic/Bedrock codegen calls; OpenAI caches prefixes
server-side.

**Recommended for production:**
- `FLOOM_SECRET` — operator secret that gates all API requests. Omit entirely for unauthenticated local dev.

**Optional integrations:**
- `COMPOSIO_API_KEY` + `COMPOSIO_WEBHOOK_SIGNING_KEY` — Connections feature (OAuth apps, triggers)
- `SLACK_CLIENT_ID` + `SLACK_CLIENT_SECRET` — Slack integration (Emily in Slack, magic sign-in links)
- `WORKEROS_MAGIC_LINK_SECRET` — dedicated HMAC key for magic sign-in links; falls back to `FLOOM_SECRET` then a per-process key if unset

**Version history (recommended):**
- `FLOOM_WORKERS_DIR` + `FLOOM_CONTEXTS_DIR` — point these to a directory **outside the cloned repo** (e.g. `~/.workeros/workers` and `~/.workeros/contexts`) to enable git-backed version history and rollback. Left at their in-repo defaults, the engine **refuses to version into its own source checkout** (and logs a warning), so worker/context versions stay empty. See [Workspace & versioning](#workspace--versioning).
- `WORKEROS_GIT_REMOTE` *(optional)* — a git remote (`https://{token}@github.com/{owner}/{repo}.git`) to push version history to. Unset = local history only.

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
python main.py
```

**Windows**
```powershell
cd apps/api
venv\Scripts\activate
python main.py
```

The API serves on `http://localhost:8000` with auto-reload. Start it with **`python main.py`**, not a bare `uvicorn main:app --reload`: `main.py` configures the reloader to exclude `data/` and the workers directory. Without that, every run — which stages a bundle under `data/run-bundles/` — would trip the file-watcher and **restart the API mid-execution**. For production, run without reload, e.g. `uvicorn main:app --host 0.0.0.0 --port 8000`.

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
- `run.py` — script-mode worker. It is launched as `python run.py` inside the sandbox: read inputs from `inputs.json` and **write `result.json`** in the form `{"status": "success", "outputs": { ... }, "artifacts": [ ... ]}` (use `"status": "error"` + `"error"` on failure). There is **no** in-process `run(inputs, context)` entrypoint — the old `hybrid` mode was removed (migration #603); a bare `def run(...)` that only `return`s a value produces no result.
- `SKILL.md` — agent prompt (agent mode); mutually exclusive with `run.py`
- `requirements.txt` — Python dependencies

Minimal `run.py`:

```python
import json

with open("inputs.json") as f:
    inputs = json.load(f)

with open("result.json", "w") as f:
    json.dump({"status": "success", "outputs": {"greeting": f"Hello, {inputs.get('name', 'world')}"}}, f)
```

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

### Example workers

A few of the workers shipped in [`workers/`](workers/) — browse the directory for the full set:

- **weekly_update** — Turns raw notes into a polished weekly update (AI, requires approval)
- **csv_enricher** — Enriches CSV rows using custom instructions (AI)
- **research_brief** — Generates markdown research briefs on any topic (AI, requires approval)
- **search_console_insights** — Pulls Google Search Console data and summarises performance

---

## Workspace & versioning

Every change to a worker, context, or workspace setting is committed to a **git "workspace" repo** — that's your version history. `workers.versions` / `contexts.versions` list the commits; rollback restores any of them (and writes a *new* commit, so you can roll forward again too).

The workspace git root is the **parent of `FLOOM_WORKERS_DIR`**, which by default is this cloned repo. To avoid versioning into — and accidentally pushing to — its own source tree, **the engine refuses to commit when the workspace root is the engine checkout**, so with the defaults versioning is off and a one-time warning is logged.

**To enable versioning**, point `FLOOM_WORKERS_DIR` and `FLOOM_CONTEXTS_DIR` at a directory **outside** the checkout that share a parent:

```bash
FLOOM_WORKERS_DIR=~/.workeros/workers
FLOOM_CONTEXTS_DIR=~/.workeros/contexts
```

That shared parent (`~/.workeros`) becomes a local git repo with **no remote** — versioned locally, never pushed. Copy the shipped example workers into `FLOOM_WORKERS_DIR` once if you want them tracked. To also push history to your own git host (never the engine's repo), set `WORKEROS_GIT_REMOTE`.

---

## Contexts (brain packs)

Contexts are reusable file bundles you attach to workers as reference material, stored in `contexts/<name>/`. Manage them via the API/MCP (`contexts.create`, `contexts.write`, `contexts.read`, …) or the UI, then list a context under a worker's `contexts:` in `worker.yml`.

Contexts are **sensitive by default** and excluded from git (they may hold credentials). To put one under version control, create it with `sensitive: false` — its history then appears in `contexts.versions` and is restorable via `contexts.rollback`, exactly like workers.

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
