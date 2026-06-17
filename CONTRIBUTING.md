# Contributing to Workeros

Thanks for your interest in contributing. This guide covers local setup, how the
repo is organized, and what we look for in a pull request.

## Repository layout

- `apps/api` - FastAPI backend: worker runtime, auth, workspaces, contexts.
- `apps/web` - Next.js web app.
- `apps/mcp` - MCP server and CLI package.
- `workers/` - bundled demo and engine workers.
- `docs/` - architecture, design system, integrations, and security docs.
- `tests/` - root backend/runtime regression suite.

## First local run

The fastest path is the checked-in setup script for your OS. It creates the
backend virtualenv, installs frontend dependencies, and scaffolds local `.env`
files without overwriting existing ones.

Linux / macOS:

```bash
./scripts/setup.sh
# edit apps/api/.env and add OPENAI_API_KEY + E2B_API_KEY
./scripts/dev.sh
```

Windows PowerShell:

```powershell
.\scripts\setup.ps1
# edit apps\api\.env and add OPENAI_API_KEY + E2B_API_KEY
.\scripts\dev.ps1
```

Open `http://localhost:3000`. The API listens on `http://localhost:8000`.

## Manual backend setup

```bash
cd apps/api
python3.11 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
cp .env.example .env   # then fill in the values you need
```

On Windows PowerShell:

```powershell
cd apps\api
python -m venv venv
.\venv\Scripts\activate
pip install -r requirements.txt
Copy-Item .env.example .env
```

## Test matrix

Run the smallest relevant set before opening a PR. The full backend suite is I/O
heavy, so on a small machine it is fine to run focused files first and note that
in the PR.

```bash
# Backend focused or full root suite
python -m pytest tests/test_api_endpoints.py -q
python -m pytest tests -q

# API package tests
cd apps/api
python -m pytest tests -q

# Web
cd apps/web
npm run lint
npm test

# MCP package
cd apps/mcp
npm test

# Root convenience scripts for common checks
npm run test:api
npm run lint:web
npm run test:web
npm run test:mcp
```

Some tests expect a few environment variables to be set, for example
`FLOOM_SECRET` and, for connection tests, `COMPOSIO_API_KEY`. See
`.env.example` and `apps/api/.env.example` for the full list.

## CI expectations

CI runs ruff, secret scanning, backend pytest, web lint/tests, and MCP tests.
The project currently uses self-hosted GitHub Actions runners for the full CI
matrix, so contributors should paste the commands they ran locally in the PR
template. Maintainers will use the CI result as the merge gate.

## Picking an issue

Good first contributions are small, testable fixes. Pick one of these lanes:

- **Docs:** clarify setup, add examples, improve troubleshooting, or fix stale
  references.
- **Worker examples:** add or improve one worker bundle under `workers/` with a
  focused use case and sample inputs.
- **API/runtime:** fix a narrow bug and add the smallest pytest that fails before
  the change.
- **MCP/CLI:** improve validation, help text, or command behavior with a package
  test.
- **Web:** polish a contained UI state that already has an established component
  pattern.

Avoid first PRs that combine backend, frontend, worker examples, and docs in one
change. Smaller PRs are easier to review and easier to merge.

If you are not sure where to start:

1. Run the app with [docs/GETTING-STARTED.md](docs/GETTING-STARTED.md).
2. Scan issues labeled `good first issue` or `docs`.
3. Reproduce the problem locally.
4. Add the smallest test or documentation change that proves the fix.
5. Open the PR with the commands you ran.

## Pull requests

- Keep changes focused and write a clear description of the problem and the fix.
- Add or update tests for behavior changes. A bug fix should come with a test
  that fails before and passes after.
- Match the surrounding code style; do not reformat unrelated code.
- Do not commit secrets, real customer data, or personal information. Use
  `example.com` addresses and synthetic data in tests and fixtures.
- Run the relevant tests before opening the PR and note what you ran.

## Reporting bugs and security issues

Open a GitHub issue for ordinary bugs. For anything security-sensitive, follow
[SECURITY.md](SECURITY.md) and report it privately instead.

For common local setup and runtime issues, check
[docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) before filing.

## License

By contributing, you agree that your contributions will be licensed under the
[MIT License](LICENSE) that covers this project.
