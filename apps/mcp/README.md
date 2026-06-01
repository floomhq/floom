# Workeros CLI + MCP

Workeros lets agents create, update, run, watch, and delete production worker automations through a local stdio MCP server backed by the Workeros API. The package installs into Claude Code, Cursor, VS Code, Windsurf, Continue, or any harness that accepts an MCP stdio server entry.

Workeros ships as a single npm package that exposes:

- **`workeros` CLI** – `login`, `workspaces`, `workers`, `run`, `runs`, `secrets`, `mcp`, `whoami`, `logout`, plus an `install` shortcut that wires the MCP server into Claude Code / Cursor / Continue. `floom` remains a compatibility alias for older Floom operator workflows.
- **`workeros-mcp` stdio server** – the production MCP surface (workers / runs / secrets / connections / triggers) used by agents.

The CLI targets both deployments:

| Mode | API base | Auth | Workspaces |
|------|----------|------|------------|
| **OSS** (default) | `https://workers-api.floom.dev` | per-CLI `x-floom-secret` minted by `workeros login` | n/a |
| **Cloud** | `https://workeros-api.floom.dev` (workeros.floom.dev dashboard) | Supabase refresh token → JWT bearer, `X-Workeros-Workspace` header | multi-workspace |

## Cloud quickstart (workeros.floom.dev)

```bash
npm i -g @floomhq/workeros@latest
workeros login --cloud           # opens workeros.floom.dev/app/cli-auth
workeros workspaces list
workeros workspaces use <name>   # persists to ~/.config/workeros/credentials.json
workeros workers list
workeros run <worker-id> --input key=value
```

`workeros login` auto-detects cloud when the verification URL the API returns is `workeros.floom.dev` or contains `/app/`, so `--cloud` is only needed if you also set `WORKEROS_API_BASE` to a non-default host. `WORKEROS_CLOUD=1` is equivalent to `--cloud`.

Credentials live at `~/.config/workeros/credentials.json` (mode 0600). `workeros logout` clears them.

## OSS quickstart (workers.floom.dev)

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

All targets use stdio transport (`command: npx`, `args: ["-y", "@floomhq/workeros"]`). There is no HTTP/SSE variant — the MCP server starts in-process via stdio.

## Manual config

Claude Code / Cursor / VS Code / Windsurf (`mcpServers` object shape):

```json
{
  "mcpServers": {
    "workeros": {
      "command": "npx",
      "args": ["-y", "@floomhq/workeros"],
      "env": {
        "WORKEROS_API_SECRET": "<WORKEROS_API_SECRET>",
        "WORKEROS_API_BASE": "https://workers-api.floom.dev"
      }
    }
  }
}
```

Continue (`~/.continue/.continuerc.json`, array shape):

```json
{
  "mcpServers": [
    {
      "name": "workeros",
      "command": "npx",
      "args": ["-y", "@floomhq/workeros"],
      "env": {
        "WORKEROS_API_SECRET": "<WORKEROS_API_SECRET>",
        "WORKEROS_API_BASE": "https://workers-api.floom.dev"
      }
    }
  ]
}
```

The server targets `https://workers-api.floom.dev` by default. For development, set `WORKEROS_API_BASE`.

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

`workers push` uses `POST /workers` for new workers and `PUT /workers/{id}` for existing workers. If an older API returns 404/405 for source updates, upgrade the API before editing production workers in place.

## Tools

> **For full worked examples per tool, end-to-end recipes (deploy a worker from prompt, port a Claude skill, schedule + webhook + composio triggers), and the agent draft contract, see [docs/AGENT-COOKBOOK.md](../../docs/AGENT-COOKBOOK.md).**

| Tool | Description |
| --- | --- |
| `workers.list` | List available Workeros workers. |
| `workers.get` | Read one worker, including config and recent run metadata. |
| `workers.create` | Create a script-mode worker from `worker_yml` and `run_py`. Use CLI `workeros workers push <dir>` for `SKILL.md` bundles. |
| `workers.update` | Patch trigger, cron, default inputs, documented capabilities, or rotate a webhook secret. |
| `workers.delete` | Delete a worker and dependent run data. |
| `workers.run` | Start a manual worker run with input values. |
| `runs.list` | List runs, optionally filtered by worker id or status. |
| `runs.get` | Read one run with logs, outputs, artifacts, and approval state. |
| `runs.watch` | Stream SSE run events (text / tool-call / tool-result / reasoning / step-start / finish) until a terminal state. |
| `secrets.list` / `secrets.set` / `secrets.delete` | Manage env-var secrets the worker can read. |
| `connections.list` | List configured Composio app connections. |
| `triggers.list` | List configured Composio triggers, globally or per worker/app. |

## Quick example — write + deploy + verify a worker in one MCP session

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

See [docs/AGENT-COOKBOOK.md §1](../../docs/AGENT-COOKBOOK.md) for the full annotated walkthrough plus six more recipes (agent mode, Gmail trigger, cron schedule, webhook, approval gate, claude-skill port).
