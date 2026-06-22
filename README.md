# Floom

[![CI](https://github.com/floomhq/floom/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/floomhq/floom/actions/workflows/ci.yml)
[![License: Floom Source Available](https://img.shields.io/badge/License-Floom%20Source%20Available-blue.svg)](LICENSE)

Floom is a source-available AI runtime for creating, running, and supervising
background AI workers. Sandboxed by default.

> Create a worker. Give it tools. Let it run. See everything.

<p align="center">
  <img src="docs/media/hero.gif" alt="Describe a worker in plain English, approve the draft, and watch it run on the record" width="900">
</p>

New here? Start with [docs/GETTING-STARTED.md](docs/GETTING-STARTED.md) for the
short path from "why Floom exists" to your first worker and a safe self-hosted
deployment checklist.

Floom is being released as a clean source-available v1.0 with its development
history preserved and private/internal artifacts filtered out. See
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
apps/mcp      MCP server + CLI  (@floomhq/floom)
workers/      Worker folders (worker.yml + run.py or SKILL.md)
data/         SQLite DB + run artifacts
```

**Platform support:** Linux, macOS, Windows (Python 3.11+, Node 20+).

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

- [Getting started](docs/GETTING-STARTED.md) - why Floom exists, first run,
  first worker, and safe self-hosting checklist.
- [Authoring workers](docs/AUTHORING.md) - full `worker.yml` schema, execution
  modes, secrets, connections, triggers, and approvals.
- [Agent cookbook](docs/AGENT-COOKBOOK.md) - agent-assisted worker authoring
  recipes.
- [API overview](docs/API.md) - curated endpoint map plus the OpenAPI location.
- [Troubleshooting](docs/TROUBLESHOOTING.md) - setup, runtime, and test fixes.
- [Project history](HISTORY.md) - what was scrubbed and how the public history is
  preserved.
- [v1.0.0 release notes](docs/releases/v1.0.0.md) - launch highlights, limits,
  and provenance.
- [Contributing](CONTRIBUTING.md) - local checks, first-contribution map, and PR
  expectations.
- [Licensing](docs/LICENSING.md) - what the Floom Source Available License
  allows and what needs a commercial agreement.
- [Third-party licenses](docs/THIRD-PARTY-LICENSES.md) - dependency inventory
  and SBOM release process.
- [Generated SBOM](docs/sbom/floom-sbom.spdx.json) - SPDX inventory generated
  from the checked-in dependency manifests.

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

GitHub Actions runs lint and test coverage on GitHub-hosted Linux runners, with
Windows runtime tests included as advisory coverage. External contributors should
also include the local commands they ran in the PR.

## Security

To report a vulnerability, please follow [SECURITY.md](SECURITY.md) and report it
privately rather than opening a public issue.

## License

[Floom Source Available License 1.0](LICENSE) (c) Floom contributors.
Floom is free for internal business use, non-commercial use, personal use,
building your own products or services, and consulting/integration work for
permitted deployments. Offering Floom itself as a hosted service, managed
platform, white-label product, or competing commercial service requires a
separate commercial agreement.
