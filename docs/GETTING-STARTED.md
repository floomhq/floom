# Getting started

Workeros is a source-available runtime for AI workers: small, versioned worker
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
SOC 2 evidence collection live outside the source-available runtime. This repo
provides the core runtime and local/self-hosted path.

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
# edit apps/api/.env and add E2B_API_KEY plus your model provider config
./scripts/dev.sh
```

Windows PowerShell:

```powershell
.\scripts\setup.ps1
# edit apps\api\.env and add E2B_API_KEY plus your model provider config
.\scripts\dev.ps1
```

Open `http://localhost:3000`. The API listens on `http://localhost:8000`.

## 2. Manual setup and configuration

The scripts above are the recommended path. Use the manual steps only when you
need to debug one side of the stack.

Backend:

```bash
cd apps/api
python3.11 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
# edit .env and add E2B_API_KEY plus your model provider config
python main.py
```

Windows PowerShell:

```powershell
cd apps\api
python -m venv venv
.\venv\Scripts\activate
pip install -r requirements.txt
Copy-Item .env.example .env
# edit .env and add E2B_API_KEY plus your model provider config
python main.py
```

Frontend:

```bash
cd apps/web
cp .env.example .env
npm install
npm run dev
```

Start the backend with `python main.py` during development. Avoid bare
`uvicorn main:app --reload`; the checked-in entry point excludes runtime
artifact directories from reload watching.

### Model providers

OpenAI is the zero-config default. To use another provider, set the role-specific
model variables to a litellm model id and provide that provider's credentials.

| Env var | Role | Default |
| --- | --- | --- |
| `WORKEROS_WORKER_AGENT_MODEL` | tool-calling worker agents | `gpt-5.5` |
| `WORKEROS_CHAT_MODEL` | Emily chat assistant | `gpt-5.4-mini` |
| `WORKEROS_CODEGEN_MODEL` | worker codegen, draft, and repair | `gpt-5.5` |
| `WORKEROS_SUGGEST_MODEL` | worker-edit conflict check | codegen model |

Example Bedrock configuration:

```bash
WORKEROS_WORKER_AGENT_MODEL=bedrock/us.anthropic.claude-sonnet-4-6
WORKEROS_CHAT_MODEL=bedrock/us.anthropic.claude-sonnet-4-6
WORKEROS_CODEGEN_MODEL=bedrock/us.anthropic.claude-sonnet-4-6
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
AWS_REGION_NAME=us-west-2
```

Other litellm providers work the same way:

| Provider | Model id example | Key |
| --- | --- | --- |
| Anthropic | `anthropic/claude-sonnet-4-6` | `ANTHROPIC_API_KEY` |
| Google Gemini | `gemini/gemini-2.5-pro` | `GEMINI_API_KEY` |
| Groq | `groq/llama-3.3-70b-versatile` | `GROQ_API_KEY` |

Vertex AI Gemini uses Google Application Default Credentials instead of
`GEMINI_API_KEY`. For local development, install from the normal requirements
file, then set a Vertex model id and Google auth environment:

```bash
WORKEROS_WORKER_AGENT_MODEL=vertex_ai/gemini-3.5-flash
WORKEROS_CHAT_MODEL=vertex_ai/gemini-3.5-flash
WORKEROS_CODEGEN_MODEL=vertex_ai/gemini-3.5-flash
VERTEX_PROJECT=your-gcp-project
VERTEXAI_PROJECT=your-gcp-project
VERTEX_LOCATION=global
VERTEXAI_LOCATION=global
GOOGLE_APPLICATION_CREDENTIALS=/absolute/path/to/application-default-or-wif.json
```

If `GOOGLE_APPLICATION_CREDENTIALS` points at an AWS workload identity
federation config, Google auth also needs AWS credentials and a region in the
backend process environment:

```bash
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
AWS_REGION=us-west-2
AWS_DEFAULT_REGION=us-west-2
```

Without those AWS variables, local machines may try the AWS instance metadata
endpoint (`169.254.169.254`) and Vertex calls will fail before reaching Gemini.

Emily and web-search workers use a provider-agnostic `web_search` function tool.
It defaults to DuckDuckGo; set `SERPER_API_KEY` for Google-quality results.

### Optional configuration

- `FLOOM_SECRET`: operator secret for API requests. Leave unset for local dev;
  set `WORKEROS_SHARED_SECRET_ROLE=admin` only when legacy admin-equivalent
  shared-secret access is required.
- `COMPOSIO_API_KEY` and `COMPOSIO_WEBHOOK_SIGNING_KEY`: OAuth apps and triggers.
- `SLACK_CLIENT_ID` and `SLACK_CLIENT_SECRET`: Slack integration.
- `WORKEROS_MAGIC_LINK_SECRET`: HMAC key for magic sign-in links.
- `FLOOM_WORKERS_DIR` and `FLOOM_CONTEXTS_DIR`: set both outside the source
  checkout to enable git-backed worker/context history.
- `WORKEROS_GIT_REMOTE`: optional remote for workspace history.

Worker secrets are stored encrypted in `.secrets.enc`. For local git setups,
back up `~/.config/workeros/secrets.key`; losing it means existing encrypted
secrets must be re-entered.

### Version history

Workers, contexts, and workspace settings can be committed to a local git
workspace. `workers.versions` and `contexts.versions` list commits; rollback
restores a version by writing a new commit, so you can roll forward again.

The workspace git root is the parent of `FLOOM_WORKERS_DIR`. The engine refuses
to commit history into its own source checkout, so point worker and context
directories somewhere else:

```bash
FLOOM_WORKERS_DIR=~/.workeros/workers
FLOOM_CONTEXTS_DIR=~/.workeros/contexts
```

That shared parent becomes a local git repo with no remote. Set
`WORKEROS_GIT_REMOTE` only if you want to push workspace history to your own git
host.

## 3. Build your first worker

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

### CLI deploy loop

```bash
npm i -g @floomhq/workeros
workeros login
workeros workers validate ./workers/<id>
workeros workers push ./workers/<id>
workeros run <id> --inputs-file inputs.json
```

### Example workers

Browse [`workers/`](../workers/) for the full set. A few useful examples:

- **csv_enricher:** enriches CSV rows using custom instructions.
- **research_brief:** generates markdown research briefs and can require
  approval.
- **github-digest:** summarizes recent activity on a GitHub repo.
- **outbound-approval-demo:** demonstrates a two-run human-in-the-loop approval
  pattern.
- **gmail-summarize-latest** / **gmail-smart-replies:** Gmail automation
  templates.

## 4. Deploy safely

For a self-hosted deployment:

1. Set `FLOOM_SECRET` so API requests require the `x-floom-secret` header. It is
   member-scoped by default; add `WORKEROS_SHARED_SECRET_ROLE=admin` only if this
   deployment intentionally uses the shared secret for admin operations.
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
