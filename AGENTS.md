# AGENTS.md — Floom

Self-hosted runtime for AI **workers** (script- or agent-mode jobs that run in E2B
sandboxes). FastAPI + SQLite backend (`apps/api`), Next.js frontend (`apps/web`),
MCP server (`apps/mcp`). Deeper docs: `README.md`, `ARCHITECTURE.md`, `CONTRIBUTING.md`.

## Setup (once)
- macOS/Linux: `./scripts/setup.sh` · Windows: `.\scripts\setup.ps1`
- Creates the backend venv, installs backend + frontend deps, scaffolds `apps/api/.env`.
- **Setup cannot complete without secrets only the user has.** At minimum
  `OPENAI_API_KEY` + `E2B_API_KEY` (or Bedrock: `WORKEROS_*_MODEL=bedrock/...` plus
  AWS creds). Ask the user for these — never invent, guess, or commit them.

## Run
- macOS/Linux: `./scripts/dev.sh` · Windows: `.\scripts\dev.ps1`
- Starts backend (http://localhost:8000) + frontend (http://localhost:3000).
- **It blocks** — it runs both servers in the foreground until Ctrl+C. If you are an
  agent, run it in the background, or start the two halves yourself:
  `cd apps/api && ./venv/bin/python main.py` (Windows: `venv\Scripts\python.exe main.py`)
  and `cd apps/web && npm run dev`.
- No auth secret is needed for local dev; the first sign-in creates the account.

## Test / lint
- Backend: `cd apps/api && ./venv/bin/python -m pytest tests/ -q`
- Frontend: `cd apps/web && npm test` (vitest) · `npm run build` · `npm run lint`

## Hard rules (do not violate)
- **Never commit `apps/api/.env`, the root `.env`, or `data/`** — they hold API
  keys, secrets, OAuth tokens, sessions, and PATs. They are gitignored; keep it so.
- **OSS has ZERO telemetry.** No analytics / PostHog / capture in this repo — it is
  a trust/privacy line. Anything like that lives only in the closed cloud layer.
- **Don't let worker edits auto-push to this public repo.** For real work point
  `FLOOM_WORKERS_DIR` / `WORKEROS_WORKSPACE_DIR` outside the checkout; the engine
  refuses to version into its own source tree by default.
- **No em-dashes (—)** in web copy strings (`npm run lint:emdash` fails the build)
  or in `.ps1` scripts (Windows PowerShell 5.1 mis-decodes them). Keep scripts ASCII.

## Layout
- `apps/api` — FastAPI + SQLite (Python 3.11+). Entry: `main.py`.
- `apps/web` — Next.js 16 + Turbopack. **Read `apps/web/AGENTS.md` first** — it is a
  newer Next.js than your training data; consult the local docs before editing.
- `apps/mcp` — MCP server / CLI (`@floomhq/floom`).
- `workers/` — example worker bundles, seeded into the DB on first boot.
