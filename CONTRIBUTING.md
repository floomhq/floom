# Contributing to Workeros

Thanks for your interest in contributing. This guide covers local setup, how the
repo is organized, and what we look for in a pull request.

## Repository layout

- `apps/api` — FastAPI backend (the worker runtime, auth, workspaces, contexts).
- `apps/web` — Next.js web app.
- `apps/mcp` — MCP server / CLI.
- `workers/` — bundled demo + engine workers (the example templates that ship).
- `docs/` — architecture, design system, integration guides, security model.

## Local development (backend)

```bash
cd apps/api
python3.11 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
cp .env.example .env   # then fill in the values you need
```

Run the test suite. The repo's tests are I/O heavy; on a small machine, run them
in chunks rather than all at once:

```bash
cd apps/api
python -m pytest tests/ -q
```

Some tests expect a few environment variables to be set (for example
`FLOOM_SECRET` and, for connection tests, `COMPOSIO_API_KEY`); see
`.env.example` for the full list.

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

## License

By contributing, you agree that your contributions will be licensed under the
[MIT License](LICENSE) that covers this project.
