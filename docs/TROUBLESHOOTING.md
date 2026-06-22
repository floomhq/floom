# Troubleshooting

This page is the short index for common local setup, test, and runtime issues.
If a problem is not listed here, open a bug report with the template in
`.github/ISSUE_TEMPLATE/bug_report.md`.

## Setup

### Frontend shows a remote sign-in page

Copy the local web env file:

```bash
cd apps/web
cp .env.example .env
```

The local frontend should point at `http://localhost:8000`. Without that file it
may fall back to a remote API.

### PowerShell blocks setup scripts

Run once:

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
```

Then retry:

```powershell
.\scripts\setup.ps1
```

### Port 3000 or 8000 is already in use

Stop the existing process or set a different API port before starting the
backend:

```bash
WORKEROS_API_PORT=8010 ./scripts/dev.sh
```

## Runtime

### Workers fail before executing

Check `apps/api/.env`:

```text
E2B_API_KEY=...
```

Script workers run in E2B by default. A missing or invalid E2B key prevents the
sandbox from starting.

### Emily, agent workers, or worker generation fail

Check `apps/api/.env`:

```text
OPENAI_API_KEY=...
```

If you use Bedrock, Anthropic, Gemini, or another litellm provider, confirm the
model environment variables in the README match the credentials you provided.

### Backend restarts during a worker run

Start the API with the checked-in entry point:

```bash
cd apps/api
python main.py
```

Avoid bare `uvicorn main:app --reload` during development. `main.py` excludes
runtime artifact folders from reload watching.

### Version history is empty

Set worker and context directories outside the source checkout:

```bash
FLOOM_WORKERS_DIR=~/.workeros/workers
FLOOM_CONTEXTS_DIR=~/.workeros/contexts
```

The engine refuses to commit worker/context history into its own source repo.
That guard prevents accidental commits to the Floom checkout.

### Encrypted secrets cannot be read after moving machines

Back up and restore:

```text
~/.config/workeros/secrets.key
```

Without that key, existing `.secrets.enc` values cannot be decrypted and secrets
must be re-entered.

## Tests

### Which tests should I run?

Run the smallest relevant set first:

```bash
python -m pytest tests -q
cd apps/api && python -m pytest tests -q
cd apps/web && npm test && npm run lint
cd apps/mcp && npm test
```

Root runtime tests support parallel execution:

```bash
python -m pytest tests -q -n auto --dist loadscope
```

The full `apps/api/tests` suite is intentionally run serially because several
tests exercise shared process and fixture state.

### Tests fail because required services are missing

Many tests use local fakes, but integration-heavy paths may need environment
variables such as `FLOOM_SECRET`, `OPENAI_API_KEY`, `E2B_API_KEY`, or
`COMPOSIO_API_KEY`. Check the test failure and `apps/api/.env.example`.

## Getting help

When filing an issue, include:

- Commit SHA.
- OS, Python, and Node versions.
- Whether the problem is API, web, MCP, or worker runtime.
- Exact command or UI path.
- Redacted logs or screenshots.
