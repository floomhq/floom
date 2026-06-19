# Workeros

[![CI](https://github.com/floomhq/workeros/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/floomhq/workeros/actions/workflows/ci.yml)
[![License: SUL-1.0](https://img.shields.io/badge/License-SUL--1.0-blue.svg)](LICENSE)

The source-available, self-hosted runtime for AI workers. Sandboxed by default.

> Create a worker. Give it tools. Let it run. See everything.

New here? Start with [docs/GETTING-STARTED.md](docs/GETTING-STARTED.md) for the
short path from "why Workeros exists" to your first worker and a safe self-hosted
deployment checklist.

Workeros is being released as a clean source-available v1.0 after roughly 2,000
internal commits of development, hardening, and production testing. See
[HISTORY.md](HISTORY.md) for the provenance story and
[docs/releases/v1.0.0.md](docs/releases/v1.0.0.md) for release notes.

## Worker Execution Model

Pure-script workers run in an **E2B sandbox by default**: isolated dependencies,
no host process access, and contained resource usage. Agent workers (`SKILL.md`)
run through the API-hosted AgentDriver tool loop. There is no supported local
in-process worker runner.

You pay only for sandbox execution time (E2B bills per second of run time), with
**no per-task or per-execution caps** unlike task-metered automation platforms.
Tune schedules and worker code to keep run time low.

## Quick Start

**Linux / macOS**

```bash
./scripts/setup.sh
# edit apps/api/.env and add a model provider key and E2B_API_KEY
./scripts/dev.sh
```

**Windows PowerShell**

```powershell
.\scripts\setup.ps1
# edit apps\api\.env and add a model provider key and E2B_API_KEY
.\scripts\dev.ps1
```

Requires Python 3.11+, Node.js 20+, Git, a model provider key, and an E2B key
from [e2b.dev](https://e2b.dev). On Windows, run commands from PowerShell.

Open [http://localhost:3000](http://localhost:3000) and sign in. That is the
whole setup: no auth secret required for local dev, and the example workers are
seeded on first boot.

For manual setup, model provider configuration, optional integrations, and safe
self-hosting notes, see [docs/GETTING-STARTED.md](docs/GETTING-STARTED.md).
For common setup/runtime issues, see
[docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md).

## Architecture

```text
apps/web      Next.js + TypeScript + Tailwind + shadcn/ui
apps/api      FastAPI + SQLite + Pydantic
apps/mcp      MCP server + CLI  (@floomhq/workeros)
workers/      Worker folders (worker.yml + run.py or SKILL.md)
data/         SQLite DB + run artifacts
```

**Platform support:** Linux, macOS, Windows (Python 3.11+, Node 18+).

## Core Concepts

- **Workers:** folders under `workers/<name>/` with `worker.yml` plus either a
  script entrypoint (`run.py`) or an agent prompt (`SKILL.md`).
- **Runs:** every execution records logs, outputs, tool calls, approval state,
  and replay/rollback context.
- **Contexts:** reusable file bundles attached to workers as reference material;
  sensitive by default.
- **Workspace history:** workers, contexts, and settings can be versioned in a
  git-backed workspace for rollback.

Write your first worker in [docs/GETTING-STARTED.md](docs/GETTING-STARTED.md),
then use [docs/AUTHORING.md](docs/AUTHORING.md) for the full manifest and
runtime contract.

## Docs

- [Getting started](docs/GETTING-STARTED.md) - why Workeros exists, first run,
  first worker, and safe self-hosting checklist.
- [Authoring workers](docs/AUTHORING.md) - full `worker.yml` schema, execution
  modes, secrets, connections, triggers, and approvals.
- [Agent cookbook](docs/AGENT-COOKBOOK.md) - agent-assisted worker authoring
  recipes.
- [API overview](docs/API.md) - curated endpoint map plus the OpenAPI location.
- [Troubleshooting](docs/TROUBLESHOOTING.md) - setup, runtime, and test fixes.
- [Project history](HISTORY.md) - why the public repo starts from a clean
  release commit.
- [v1.0.0 release notes](docs/releases/v1.0.0.md) - launch highlights, limits,
  and provenance.
- [Contributing](CONTRIBUTING.md) - local checks, first-contribution map, and PR
  expectations.
- [Licensing](docs/LICENSING.md) - what SUL-1.0 allows and what needs a
  commercial agreement.

## API

For a curated endpoint map, see [docs/API.md](docs/API.md). For the exhaustive
reference, start the API and open `http://localhost:8000/docs`.

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

The full GitHub Actions matrix currently runs on project self-hosted runners, so
external contributors should include the local commands they ran in the PR.

## Security

To report a vulnerability, please follow [SECURITY.md](SECURITY.md) and report it
privately rather than opening a public issue.

## License

[Sustainable Use License 1.0](LICENSE) (c) Workeros contributors. Workeros is
free for internal business use, non-commercial use, and personal use. Offering
Workeros itself as a paid hosted service or commercial product requires a
separate commercial agreement.
