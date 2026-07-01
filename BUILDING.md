# Building Floom Workers

This is the machine-readable build contract for creating, deploying, and running a Floom worker from this repository.

## Definition

Floom is an open-source runtime for background AI workers: versioned worker folders that declare inputs, outputs, triggers, secrets, and execution mode, then run with logs, outputs, approvals, REST API access, UI access, and MCP tools.

## Current Protocol

The current OSS worker protocol in this repo is:

```text
workers/<worker-id>/
  worker.yml        # required manifest
  run.py            # script-mode entrypoint, or SKILL.md for agent mode
  requirements.txt  # optional Python dependencies
  other files       # optional bundled helper files
```

Protocol selection rule:

- Use `worker.yml` plus `run.py` for deterministic Python, shell, or Node workers.
- Use `worker.yml` plus `SKILL.md` for LLM-driven agent workers.
- Do not use `floom.yaml`, `from floom import app`, or `@app.action` for this repo unless those APIs are added to the codebase. Repository search currently shows no implementation of that contract.

## What You Get After Deploy

Deploying a worker to Floom gives you:

- A worker page in the Floom UI.
- A Run form generated from `worker.yml` inputs.
- Stored run logs, output files, artifacts, approval state, replay, and rollback history.
- A REST run endpoint: `POST /workers/<worker-id>/runs`.
- MCP tools for agents: create, list, run, watch, inspect, archive, restore, and delete workers.
- Optional schedule, webhook, or Composio event triggers declared in the manifest.

Local defaults:

```text
UI:        http://localhost:3000
REST API:  http://localhost:8000
API docs:  http://localhost:8000/docs
MCP:       http://localhost:8000/mcp-tools/serve
```

## Minimal Complete Python Worker

Create this folder:

```text
workers/hello-worker/
  worker.yml
  run.py
  requirements.txt
```

`workers/hello-worker/worker.yml`:

```yaml
schema_version: "0.3"
name: hello-worker
title: Hello Worker
description: Writes a greeting for a provided name.
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
  secrets: []
capabilities:
  secrets: []
  network:
    egress: false
trigger:
  type: manual
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

`workers/hello-worker/requirements.txt`:

```text
# Add Python packages here, one per line.
```

## Deploy And Run

Run Floom locally:

```bash
git clone https://github.com/floomhq/floom.git
cd floom
./scripts/setup.sh
# edit apps/api/.env and add E2B_API_KEY plus your model provider config
./scripts/dev.sh
```

Deploy the worker:

```bash
npm i -g @floomhq/floom
floom login --local
floom workers validate ./workers/hello-worker
floom workers push ./workers/hello-worker
floom run hello-worker --input name=Floom
floom workers info hello-worker
```

If your local API runs without `FLOOM_SECRET`, login is not required for basic local development.

`floom workers validate` is an offline manifest and bundle check. `floom workers push`, `floom run`, REST API calls, UI runs, and MCP runs require a running Floom API.

## REST API Run

Run the same worker through the REST API:

```bash
curl -X POST http://localhost:8000/workers/hello-worker/runs \
  -H "Content-Type: application/json" \
  -d '{"inputs": {"name": "Floom"}}'
```

For a protected API, add the shared secret header:

```bash
curl -X POST http://localhost:8000/workers/hello-worker/runs \
  -H "x-floom-secret: <FLOOM_SECRET>" \
  -H "Content-Type: application/json" \
  -d '{"inputs": {"name": "Floom"}}'
```

## MCP Setup For Agents

Install the Floom MCP server into an agent harness:

```bash
npx -y @floomhq/floom mcp install --target claude
```

Supported targets include `claude`, `cursor`, `vscode`, `windsurf`, `continue`, and `generic`.

The HTTP MCP config points at:

```json
{
  "mcpServers": {
    "floom": {
      "url": "http://localhost:8000/mcp-tools/serve",
      "headers": {
        "x-floom-secret": "<FLOOM_SECRET>"
      }
    }
  }
}
```

## Manifest Fields Agents Must Emit

Required fields:

- `schema_version`
- `name`
- `title`
- `description`
- `entrypoint`
- `exec.runtime`
- `exec.runner`
- `exec.inputs`
- `exec.outputs`
- `trigger`

Common script-mode fields:

- `exec.command`: shell command to run, usually `python run.py`; TypeScript workers use `npx --yes tsx run.ts`.
- `exec.runtime`: `python311` or `node22`.
- `exec.runner`: `e2b`.
- `exec.inputs`: fields shown in the UI and passed through `inputs.json`.
- `exec.outputs`: files collected after the run.
- `exec.secrets`: environment variables the worker can read.
- `capabilities.network.egress`: set `true` only if the worker calls external APIs.

## Script Runtime Contract

At run time, Floom:

1. Copies the worker folder into the run sandbox.
2. Writes scalar and file inputs into `inputs.json` and declared input paths.
3. Exposes declared secrets as environment variables.
4. Runs `exec.command`.
5. Collects declared outputs from `exec.outputs[].path`.
6. Reads `result.json` to determine status and output mapping.

`result.json` success shape:

```json
{
  "status": "success",
  "outputs": {
    "greeting": "out/greeting.txt"
  },
  "artifacts": [],
  "error": null
}
```

Error shape:

```json
{
  "status": "error",
  "outputs": {},
  "artifacts": [],
  "error": "Missing required input: name"
}
```

## Agent Mode

For LLM-driven workers, use `SKILL.md` instead of `run.py`:

```text
workers/research-worker/
  worker.yml
  SKILL.md
```

Set:

```yaml
entrypoint: SKILL.md
exec:
  runtime: skill
  runner: e2b
  inputs:
    - name: topic
      kind: scalar
      type: string
      required: true
      label: Topic
  outputs:
    - name: brief
      kind: file
      media_type: text/markdown
      path: out/brief.md
      required: true
      label: Brief
  entry: SKILL.md
capabilities:
  secrets: []
  network:
    egress: true
trigger:
  type: manual
```

Minimal `SKILL.md`:

```markdown
# Research Worker

You receive:

- `topic`: the topic to research.

Write a concise markdown brief for the topic.

When finished, call `finish_with_outputs` with:

- `brief`: the complete markdown brief
```

The `SKILL.md` file is the system prompt for the agent loop. The loop can use declared tools, file tools, and output writers. Agent-mode workers complete by writing declared outputs through the agent output tools such as `finish_with_outputs`; script-mode workers complete by writing `result.json`. See `docs/AUTHORING.md` and `docs/AGENT-COOKBOOK.md` for the full agent-mode contract.

## Triggers

Manual trigger:

```yaml
trigger:
  type: manual
```

Schedule trigger:

```yaml
trigger:
  type: schedule
  cron: "0 9 * * MON"
  timezone: "Europe/Berlin"
```

Webhook trigger:

```yaml
trigger:
  type: webhook
  webhook:
    secret: true
    allowed_methods: [POST]
```

Composio event trigger:

```yaml
trigger:
  type: composio
  composio:
    event: "gmail.new_message"
    connection_id: "ca_<id>"
    filters: {}
```

## Build Checklist For AI Agents

1. Pick a unique lowercase `worker-id`.
2. Create `workers/<worker-id>/worker.yml`.
3. Add `run.py` for deterministic script mode or `SKILL.md` for agent mode.
4. Add `requirements.txt` only when Python packages are needed.
5. Declare every input, output, secret, connection, and trigger in `worker.yml`.
6. For script workers, read `inputs.json`, write files under `out/`, and write `result.json`.
7. Run `floom workers validate ./workers/<worker-id>`.
8. Deploy with `floom workers push ./workers/<worker-id>`.
9. Smoke-test with `floom run <worker-id> --input key=value`.
10. Inspect the worker through the UI, REST API, or MCP.

## Deeper References

- `README.md`: product overview and local setup.
- `docs/GETTING-STARTED.md`: local setup and first worker.
- `docs/AUTHORING.md`: full manifest schema and execution modes.
- `docs/AGENT-COOKBOOK.md`: agent recipes for CLI and MCP flows.
- `apps/mcp/README.md`: Floom CLI and MCP details.
- `workers/`: runnable worker examples.
