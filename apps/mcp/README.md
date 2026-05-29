# Workeros CLI + MCP

Workeros lets agents create, update, run, watch, and delete production worker automations through a local stdio MCP server backed by the Workeros API. The package installs into Claude Code, Cursor, VS Code, Windsurf, Continue, or any harness that accepts an MCP stdio server entry.

Workeros ships as a single npm package that exposes:

- **`floom` / `workeros` CLI** – `login`, `workspaces`, `workers`, `run`, `runs`, `secrets`, `mcp`, `whoami`, `logout`, plus an `install` shortcut that wires the MCP server into Claude Code / Cursor / Continue.
- **`workeros-mcp` stdio server** – the production MCP surface (workers / runs / secrets / connections / triggers) used by agents.

The CLI targets both deployments:

| Mode | API base | Auth | Workspaces |
|------|----------|------|------------|
| **OSS** (default) | `https://workers-api.floom.dev` | per-CLI `x-floom-secret` minted by `floom login` | n/a |
| **Cloud** | `https://workeros-api.floom.dev` (workeros.floom.dev dashboard) | Supabase refresh token → JWT bearer, `X-Workeros-Workspace` header | multi-workspace |

## Cloud quickstart (workeros.floom.dev)

```bash
npm i -g @floomhq/workeros@latest
floom login --cloud           # opens workeros.floom.dev/app/cli-auth
floom workspaces list
floom workspaces use <name>   # persists to ~/.config/workeros/credentials.json
floom workers list
floom run <worker-id> --input key=value
```

`floom login` auto-detects cloud when the verification URL the API returns is `workeros.floom.dev` or contains `/app/`, so `--cloud` is only needed if you also set `WORKEROS_API_BASE` to a non-default host. `WORKEROS_CLOUD=1` is equivalent to `--cloud`.

Credentials live at `~/.config/workeros/credentials.json` (mode 0600). `floom logout` clears them.

## OSS quickstart (workers.floom.dev)

```bash
npx @floomhq/workeros install
```

Auto-detects the first existing config file. To target a specific harness:

```bash
floom mcp install --target claude     # ~/.claude/settings.json
floom mcp install --target cursor     # ~/.cursor/mcp.json
floom mcp install --target vscode     # .vscode/mcp.json  (workspace-local)
floom mcp install --target windsurf   # ~/.codeium/windsurf/mcp_config.json
floom mcp install --target continue   # ~/.continue/.continuerc.json
floom mcp install --target generic    # prints JSON snippet for manual paste
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

## Tools

> **For full worked examples per tool, end-to-end recipes (deploy a worker from prompt, port a Claude skill, schedule + webhook + composio triggers), and the agent draft contract, see [docs/AGENT-COOKBOOK.md](../../docs/AGENT-COOKBOOK.md).**

| Tool | Description |
| --- | --- |
| `workers.list` | List available Workeros workers. |
| `workers.get` | Read one worker, including config and recent run metadata. |
| `workers.create` | Create a worker from `worker_yml` and either `run_py` (script mode) or `skill_md` (agent mode). |
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
  name: "text-summarizer",
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
  worker_id: "text-summarizer",
  inputs: { text: "Lorem ipsum dolor sit amet..." },
});

// 3. Watch until terminal
for await (const part of runs.watch({ run_id })) {
  if (part.type === "tool-call") console.log("tool:", part.name);
  if (part.type === "finish") break;
}

// 4. Verify
const { run } = await runs.get({ id: run_id });
console.log(run.status); // "succeeded"
console.log(run.outputs.summary);
```

See [docs/AGENT-COOKBOOK.md §1](../../docs/AGENT-COOKBOOK.md) for the full annotated walkthrough plus six more recipes (agent mode, Gmail trigger, cron schedule, webhook, approval gate, claude-skill port).
