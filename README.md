# Workeros

[![CI](https://github.com/floomhq/workeros/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/floomhq/workeros/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

The open-source, self-hosted runtime for AI workers. Sandboxed by default.

> Create a worker. Give it tools. Let it run. See everything.

New here? Start with [docs/GETTING-STARTED.md](docs/GETTING-STARTED.md) for the
short path from "why Workeros exists" to your first worker and a safe self-hosted
deployment checklist.

## Worker execution model

Pure-script workers run in an **E2B sandbox by default** — isolated dependencies, no host process access, contained resource usage. Agent workers (`SKILL.md`) run through the API-hosted AgentDriver tool loop. There is no supported local in-process worker runner.

You pay only for sandbox execution time (E2B bills per second of run time), with **no per-task or per-execution caps** — unlike task-metered automation platforms. Tune schedules and worker code to keep run time low.

---

## Quick Start

**Fastest path** — two scripts. You need an OpenAI key and an E2B key ([e2b.dev](https://e2b.dev)).

### Prerequisites

- Python 3.11 or newer.
- Node.js 20 or newer, with npm.
- Git.
- An `OPENAI_API_KEY` for Emily, agent workers, and code generation.
- An `E2B_API_KEY` for sandboxed script-worker execution.
- On Windows, run setup and dev commands from PowerShell. If script execution is
  blocked, run `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` once.

**Linux / macOS**
```bash
./scripts/setup.sh                # venv + deps + scaffolds apps/api/.env  (run once)
# edit apps/api/.env → add OPENAI_API_KEY and E2B_API_KEY
./scripts/dev.sh                  # starts backend (:8000) + frontend (:3000); Ctrl+C stops both
```

**Windows (PowerShell)**
```powershell
.\scripts\setup.ps1               # venv + deps + scaffolds apps\api\.env  (run once)
# edit apps\api\.env → add OPENAI_API_KEY and E2B_API_KEY
.\scripts\dev.ps1                 # starts backend (:8000) + frontend (:3000); Ctrl+C stops both
```

Open [http://localhost:3000](http://localhost:3000) and sign in. That's the
whole setup: no auth secret required for local dev, and the example workers are
seeded on first boot.

For manual setup, model provider configuration, optional integrations, and safe
self-hosting notes, see [docs/GETTING-STARTED.md](docs/GETTING-STARTED.md).
For common setup/runtime issues, see
[docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md).

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

## Docs

- [Getting started](docs/GETTING-STARTED.md) — why Workeros exists, first run,
  first worker, and safe self-hosting checklist.
- [Authoring workers](docs/AUTHORING.md) — full `worker.yml` schema, execution
  modes, secrets, connections, triggers, and approvals.
- [Agent cookbook](docs/AGENT-COOKBOOK.md) — agent-assisted worker authoring
  recipes.
- [API overview](docs/API.md) — curated endpoint map plus the OpenAPI location.
- [Troubleshooting](docs/TROUBLESHOOTING.md) — setup, runtime, and test fixes.
- [Contributing](CONTRIBUTING.md) — local checks, first-contribution map, and PR
  expectations.

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

- **csv_enricher** — Enriches CSV rows using custom instructions (AI)
- **research_brief** — Generates markdown research briefs on any topic (AI, requires approval)
- **github-digest** — Summarises recent activity on a GitHub repo
- **outbound-approval-demo** — Two-run human-in-the-loop approval pattern demo
- **openblog** / **opendraft** — Bundled upstream content-generation engine demos
- **gmail-summarize-latest**, **gmail-smart-replies** — Gmail automation templates (connect your own account)

---

## Workspace & versioning

Workers, contexts, and workspace settings can be versioned in a git-backed
workspace so rollback writes a new commit and can be rolled forward again. To
enable history, set `FLOOM_WORKERS_DIR` and `FLOOM_CONTEXTS_DIR` outside the
source checkout. See [docs/GETTING-STARTED.md](docs/GETTING-STARTED.md) for the
setup notes.

---

## Contexts (brain packs)

Contexts are reusable file bundles you attach to workers as reference material.
They are sensitive by default and excluded from git unless explicitly created as
non-sensitive. See [docs/AUTHORING.md](docs/AUTHORING.md) for manifest usage.

---

## API

For a curated endpoint map, see [docs/API.md](docs/API.md). For the exhaustive
reference, start the API and open `http://localhost:8000/docs`.

---

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for local setup,
the first-contribution map, and PR guidelines.

For quick local checks from the repo root:

```bash
npm run test:api
npm run lint:web
npm run test:web
npm run test:mcp
```

The full GitHub Actions matrix currently runs on project GitHub-hosted runners, so
external contributors should include the local commands they ran in the PR.

## Security

To report a vulnerability, please follow [SECURITY.md](SECURITY.md) and report it
privately rather than opening a public issue.

## License

[MIT](LICENSE) © Workeros contributors
