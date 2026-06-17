# Workeros CLI + MCP

Workeros lets agents create, update, run, watch, and delete worker automations through an HTTP MCP endpoint backed by the Workeros API. The package installs into Claude Code, Cursor, VS Code, Windsurf, Continue, or any harness that accepts an MCP HTTP or stdio server entry.

Workeros ships as a single npm package that exposes:

- **`workeros` CLI** - `login`, `workspaces`, `workers`, `run`, `runs`, `secrets`, `mcp`, `whoami`, `logout`, plus an `install` shortcut that wires the MCP server into Claude Code / Cursor / Continue. `floom` remains a compatibility alias for older installs.
- **HTTP MCP endpoint** - `workeros mcp install` writes an HTTP transport entry (`url` + `headers`) pointing at `/mcp-tools/serve` on the Workeros API. No local subprocess is required.
- **`workeros-mcp` stdio server** - legacy stdio path; still works when run directly as `npx -p @floomhq/workeros workeros-mcp` (or `node dist/server.js`). Use this for harnesses that do not support HTTP MCP transport.

The CLI targets local, self-hosted, and cloud deployments:

| Mode | API base | Auth | Workspaces |
|------|----------|------|------------|
| **OSS/self-hosted** (default) | `http://localhost:8000` or your API URL | `x-floom-secret` when `FLOOM_SECRET` is set | local workspace |
| **Cloud** | `https://workeros-api.floom.dev` (workeros.floom.dev dashboard) | Supabase refresh token -> JWT bearer, `X-Workeros-Workspace` header | multi-workspace |

## OSS quickstart

```bash
npm i -g @floomhq/workeros@latest
workeros login --api http://localhost:8000
workeros workers list
workeros run <worker-id> --input key=value
```

If your local API runs without `FLOOM_SECRET`, login is not required for basic local development. For a protected self-hosted API, set `FLOOM_SECRET` on the backend and use the matching secret when the CLI prompts.

Credentials live at `~/.config/workeros/credentials.json` (mode 0600). `workeros logout` clears them.

## MCP install

```bash
npx -y @floomhq/workeros mcp install
```

Auto-detects the first existing config file. To target a specific harness:

```bash
workeros mcp install --target claude     # ~/.claude/settings.json
workeros mcp install --target cursor     # ~/.cursor/mcp.json
workeros mcp install --target vscode     # .vscode/mcp.json  (workspace-local)
workeros mcp install --target windsurf   # ~/.codeium/windsurf/mcp_config.json
workeros mcp install --target continue   # ~/.continue/.continuerc.json
workeros mcp install --target generic    # prints JSON snippet for manual paste
```

## Switching the active context

```bash
workeros workspace list             # all workspaces your credentials can access, active marked with *
workeros workspace switch <name>    # by name or id; fails (exit 1) if not authenticated for it
workeros mcp list                   # configured MCP servers (connections of kind "mcp")
workeros mcp switch <name>          # set the active MCP server by label
workeros mcp test [name]            # live probe (initialize + tools/list); defaults to the active server
```

Switches persist in `~/.config/workeros/credentials.json` and apply to every later CLI invocation. `workspaces`/`use` remain as aliases of `workspace`/`switch`. Workspace switching works in both modes: cloud scopes by membership, OSS scopes local workspaces via the `x-workeros-workspace` header (which the CLI now sends on every request, and `mcp install` bakes into the client config - re-run `mcp install` after switching to repoint installed MCP clients).

Re-running the installer updates the existing `workeros` entry instead of duplicating it.

## Supported targets

| Target | Config file written | Config shape |
|---|---|---|
| `claude` | `~/.claude/settings.json` | `{ mcpServers: { workeros: {...} } }` |
| `cursor` | `~/.cursor/mcp.json` | `{ mcpServers: { workeros: {...} } }` |
| `vscode` | `.vscode/mcp.json` (workspace) | `{ mcpServers: { workeros: {...} } }` |
| `windsurf` | `~/.codeium/windsurf/mcp_config.json` | `{ mcpServers: { workeros: {...} } }` |
| `continue` | `~/.continue/.continuerc.json` | `{ mcpServers: [ { name:"workeros", ... } ] }` |
| `generic` | (no file) | prints JSON snippet to stdout |

All targets write **HTTP MCP transport** (`url` + `headers`) - no local subprocess is spawned. The MCP endpoint is hosted on the Workeros API server.

```json
{
  "mcpServers": {
    "workeros": {
      "url": "http://localhost:8000/mcp-tools/serve",
      "headers": {
        "x-floom-secret": "<WORKEROS_API_SECRET>"
      }
    }
  }
}
```

### HTTP transport (recommended - written by `workeros mcp install`)

Claude Code / Cursor / VS Code / Windsurf (`mcpServers` object shape):

```json
{
  "mcpServers": {
    "workeros": {
      "url": "http://localhost:8000/mcp-tools/serve",
      "headers": {
        "x-floom-secret": "<WORKEROS_API_SECRET>"
      }
    }
  }
}
```

The published binary stays connected for that handshake when launched as `npx -p @floomhq/workeros workeros-mcp`.

## Manual config

Claude Code / Cursor / VS Code / Windsurf (`mcpServers` object shape, HTTP MCP):

```json
{
  "mcpServers": {
    "workeros": {
      "url": "http://localhost:8000/mcp-tools/serve",
      "headers": {
        "x-floom-secret": "<WORKEROS_API_SECRET>"
      }
    }
  }
}
```

Continue (`~/.continue/.continuerc.json`, array shape, HTTP MCP):

```json
{
  "mcpServers": [
    {
      "name": "workeros",
      "url": "http://localhost:8000/mcp-tools/serve",
      "headers": {
        "x-floom-secret": "<WORKEROS_API_SECRET>"
      }
    }
  ]
}
```

Replace `http://localhost:8000` with your deployed API base URL when connecting to a remote self-hosted instance.

### Stdio transport (fallback - for harnesses that do not support HTTP MCP)

```json
{
  "mcpServers": {
    "workeros": {
      "command": "npx",
      "args": ["-p", "@floomhq/workeros", "workeros-mcp"],
      "env": {
        "WORKEROS_API_SECRET": "<WORKEROS_API_SECRET>",
        "WORKEROS_API_BASE": "http://localhost:8000"
      }
    }
  }
}
```

Or launch directly if the package is already installed: `node /path/to/@floomhq/workeros/dist/server.js`.

## Worker bundle CLI flow

Use this path when a fresh agent has a local `workers/<id>/` folder and needs a repeatable create/edit/deploy loop:

```bash
workeros login
workeros workers validate ./workers/<id>
workeros workers push ./workers/<id>
workeros run <id> --inputs-file docs/workers/inputs/<id>.json
workeros workers info <id>
```

`workers validate` is offline. It checks that `worker.yml` parses, the entry file exists, the runtime is declared, and E2B Composio workers do not use the local `composio execute` CLI. For structured connection declarations it also verifies that referenced tool slugs are covered by `allowed_tools`.

`workers push` uses `POST /workers` for new workers and `PUT /workers/{id}` for existing workers. If an older API returns 404/405 for source updates, upgrade the API before editing workers in place.

## Tools

> **For full worked examples per tool, end-to-end recipes (deploy a worker from prompt, port a Claude skill, schedule + webhook + composio triggers), and the agent draft contract, see [docs/AGENT-COOKBOOK.md](../../docs/AGENT-COOKBOOK.md).**

### Workers
| Tool | Description |
| --- | --- |
| `workers.list` | List available Workeros workers. |
| `workers.get` | Read one worker, including config and recent run metadata. |
| `workers.create` | Create a script-mode worker from `worker_yml` and `run_py`. |
| `workers.update` | Patch trigger, cron, default inputs, capabilities, or rotate webhook secret. |
| `workers.delete` | Delete a worker and dependent run data. |
| `workers.run` | Start a manual worker run with input values. |
| `workers.logs` | Fetch cross-run log history, filterable by level and time. |
| `workers.stats` | 7-day run statistics for a specific worker. |
| `workers.timeseries` | Daily run counts and success/failure trend over N days. |
| `workers.sample_input` | Get example input values for a worker's fields. |
| `workers.archive` | Archive a worker (reversible). |
| `workers.restore` | Restore an archived worker to active status. |
| `workers.reload` | Reload all workers from disk (OSS self-hosted). |
| `workers.versions` | List saved versions of a worker. |
| `workers.rollback` | Restore a worker to a previous version. |
| `workers.alerts.list` | List configured alerts for a worker. |
| `workers.alerts.create` | Add a failure/approval/success alert via webhook or email. |
| `workers.alerts.delete` | Remove a worker alert. |

### Runs
| Tool | Description |
| --- | --- |
| `runs.list` | List runs, optionally filtered by worker id or status. |
| `runs.get` | Read one run with logs, outputs, artifacts, and approval state. |
| `runs.watch` | Stream SSE run events until a terminal state. |
| `runs.cancel` | Cancel an in-progress run. |
| `runs.replay` | Replay a completed or failed run with the same inputs. |

### Approvals
| Tool | Description |
| --- | --- |
| `approvals.list` | List pending approval requests across all workers. |
| `approvals.approve` | Approve a pending run so it continues executing. |
| `approvals.reject` | Reject a pending run, stopping it. |

### Secrets
| Tool | Description |
| --- | --- |
| `secrets.list` | List secret names and status. |
| `secrets.set` | Create or update a secret value. |
| `secrets.delete` | Delete a secret. |
| `secrets.test` | Verify a secret exists without revealing its value. |

### Connections
| Tool | Description |
| --- | --- |
| `connections.list` | List configured app connections. |
| `connections.add_mcp` | Add an MCP server connection. |
| `connections.delete` | Remove a connection. |
| `connections.status` | Check connection health and auth status. |
| `connections.test` | Run a live connectivity check on a connection. |

### Contexts (Brain Packs)
| Tool | Description |
| --- | --- |
| `contexts.list` | List context folders. |
| `contexts.create` | Create a new brain pack context. |
| `contexts.delete` | Delete a brain pack and all its files. |
| `contexts.read` | Read a file from a context. |
| `contexts.write` | Create or update a file in a context. |
| `contexts.upload` | Upload a binary file to a context. |
| `contexts.delete_file` | Delete a specific file from a context. |
| `contexts.versions` | List saved versions of a brain pack. |
| `contexts.rollback` | Restore a brain pack to a previous version. |

### Triggers & Integrations
| Tool | Description |
| --- | --- |
| `triggers.list` | List integration triggers, globally or per worker/app. |
| `integrations.catalog` | Browse all available integrations. |

### Workspace
| Tool | Description |
| --- | --- |
| `workspace.chat` | Send a message to the workspace agent and get a reply. |
| `workspace.instructions.get` | Read current workspace agent system prompt. |
| `workspace.instructions.set` | Update workspace agent system prompt. |
| `workspace.versions` | List version history of workspace instructions. |
| `workspace.rollback` | Restore workspace instructions to a previous version. |

### Conversations
| Tool | Description |
| --- | --- |
| `conversations.list` | List past workspace agent conversations. |
| `conversations.get` | Retrieve a full conversation by ID. |

### System
| Tool | Description |
| --- | --- |
| `system.overview` | Full workspace dashboard - health, runs, pending approvals, alerts. |
| `system.stats` | 7-day aggregate run statistics across the whole workspace. |
| `system.info` | Platform version and configuration flags. |
| `system.alerts` | Active system-wide alerts. |

## Quick example - write + deploy + verify a worker in one MCP session

```js
// 1. Create
await workers.create({
  worker_yml: `
schema_version: "0.3"
name: text-summarizer
title: Text Summarizer
description: Summarizes any text in 3 bullets using GPT-4.1.
entrypoint: run.py
exec:
  command: python run.py
  runtime: python311
  runner: e2b
  entry: run.py
  inputs:
    - { name: text, kind: scalar, type: textarea, required: true, label: Text }
  outputs:
    - { name: summary, kind: file, media_type: text/markdown, path: out/summary.md, required: true, label: Summary }
  secrets: [OPENAI_API_KEY]
capabilities:
  secrets: [OPENAI_API_KEY]
  network: { egress: true }
trigger: { type: manual }
`,
  run_py: `
def run(inputs, context):
    client = context.openai()
    r = client.chat.completions.create(
        model="gpt-4.1-mini",
        messages=[
            {"role": "system", "content": "Summarize in 3 bullets."},
            {"role": "user", "content": inputs["text"]},
        ],
    )
    summary = r.choices[0].message.content
    context.write_output("summary", summary)
    return {"summary": summary}
`,
});

// 2. Run
const { run_id } = await workers.run({
  id: "text-summarizer",
  inputs: { text: "Lorem ipsum dolor sit amet..." },
});

// 3. Watch until terminal
const watched = await runs.watch({ id: run_id });
console.log(watched.status);

// 4. Verify
const { run } = await runs.get({ id: run_id });
console.log(run.status); // "succeeded"
console.log(run.output?.summary);
```

See [docs/AGENT-COOKBOOK.md section 1](../../docs/AGENT-COOKBOOK.md) for the full annotated walkthrough plus six more recipes (agent mode, Gmail trigger, cron schedule, webhook, approval gate, claude-skill port).
