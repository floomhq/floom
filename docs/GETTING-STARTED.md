# Getting started

Workeros is an open-source runtime for AI workers: small, versioned worker
bundles that can read inputs, use approved tools/connections, run in a sandbox,
and leave behind logs, outputs, approvals, and history.

Use it when a team has repeatable knowledge-work workflows that need more
control than a prompt in a chat window: scheduled reports, inbox triage, CSV
enrichment, CRM updates, approval-gated actions, research briefs, or internal
ops automation.

## What you get locally

The local setup runs the same core pieces used by hosted deployments:

- FastAPI backend with SQLite persistence.
- Next.js web app.
- E2B sandbox execution for script workers.
- Agent-mode workers powered by the configured LLM provider.
- Local workspace data, contexts, run logs, approvals, and version history.

Hosted-only concerns such as commercial billing, managed enterprise SSO, and
SOC 2 evidence collection live outside the OSS runtime. The OSS repo provides
the core runtime and local/self-hosted path.

## 1. Run the app

Prerequisites:

- Python 3.11 or newer.
- Node.js 20 or newer.
- Git.
- `OPENAI_API_KEY` for Emily, agent workers, and worker generation.
- `E2B_API_KEY` for sandboxed script-worker execution.

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

## 2. Build your first worker

Create a folder:

```text
workers/hello-worker/
  worker.yml
  run.py
```

`workers/hello-worker/worker.yml`:

```yaml
schema_version: "0.3"
name: hello-worker
title: Hello Worker
description: Greets a person from an input.
version: 0.1.0
entrypoint: run.py
exec:
  command: python run.py
  runtime: python311
  runner: e2b
  inputs:
    - name: name
      kind: scalar
      type: string
      required: true
      label: Name
      default: world
  outputs:
    - name: greeting
      kind: file
      media_type: text/plain
      path: out/greeting.txt
      required: true
      label: Greeting
```

`workers/hello-worker/run.py`:

```python
import json
from pathlib import Path

inputs = json.loads(Path("inputs.json").read_text(encoding="utf-8"))
name = inputs.get("name") or "world"

Path("out").mkdir(exist_ok=True)
Path("out/greeting.txt").write_text(f"Hello, {name}!\n", encoding="utf-8")
Path("result.json").write_text(
    json.dumps(
        {
            "status": "success",
            "outputs": {"greeting": "out/greeting.txt"},
            "artifacts": [],
            "error": None,
        }
    ),
    encoding="utf-8",
)
```

Reload workers in the UI or restart the dev server, then run `Hello Worker` from
the Workers page.

For the full schema, agent workers, approvals, triggers, secrets, and
connections, read [AUTHORING.md](AUTHORING.md).

## 3. Deploy safely

For a self-hosted deployment:

1. Set `FLOOM_SECRET` so API requests require the `x-floom-secret` header.
2. Run the API without reload:

   ```bash
   cd apps/api
   uvicorn main:app --host 0.0.0.0 --port 8000
   ```

3. Point the web app at that API with `FLOOM_API_BASE` and, if needed,
   `FLOOM_API_SECRET`.
4. Keep `FLOOM_WORKERS_DIR` and `FLOOM_CONTEXTS_DIR` outside the source checkout
   if you want git-backed worker/context history.
5. Back up `data/`, your workspace directories, and
   `~/.config/workeros/secrets.key` if you use local encrypted secrets.

Production hardening checklist:

- Terminate TLS at a reverse proxy or load balancer.
- Store secrets in your platform secret manager, not in committed files.
- Use E2B for untrusted worker execution; do not add an in-process runner.
- Restrict network access to the API and logs.
- Run the relevant tests before upgrading.

For release tasks and packaging status, see [RELEASE-CHECKLIST.md](RELEASE-CHECKLIST.md).
