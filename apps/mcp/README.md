# Workeros MCP

Workeros lets agents create, update, run, watch, and delete production worker automations through a local stdio MCP server backed by the Workeros API. The package installs into Claude Code, Cursor, or Continue and exposes worker lifecycle and run observability tools without requiring custom agent-side code.

## Install

```bash
npx @floomhq/workeros install
```

The installer uses `WORKEROS_API_SECRET` from the environment when present, otherwise it prompts for it. It patches the first existing config file it finds in this order: `~/.claude/settings.json`, `~/.cursor/mcp.json`, `~/.continue/.continuerc.json`. Re-running the installer updates the existing `workeros` entry instead of duplicating it.

## Manual Config

Claude Code (`~/.claude/settings.json`):

```json
{
  "mcpServers": {
    "workeros": {
      "command": "npx",
      "args": ["-y", "@floomhq/workeros"],
      "env": {
        "WORKEROS_API_SECRET": "<WORKEROS_API_SECRET>"
      }
    }
  }
}
```

Cursor (`~/.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "workeros": {
      "command": "npx",
      "args": ["-y", "@floomhq/workeros"],
      "env": {
        "WORKEROS_API_SECRET": "<WORKEROS_API_SECRET>"
      }
    }
  }
}
```

Continue (`~/.continue/.continuerc.json`):

```json
{
  "mcpServers": [
    {
      "name": "workeros",
      "command": "npx",
      "args": ["-y", "@floomhq/workeros"],
      "env": {
        "WORKEROS_API_SECRET": "<WORKEROS_API_SECRET>"
      }
    }
  ]
}
```

The server targets `https://workers-api.floom.dev` by default. For development, set `WORKEROS_API_BASE`.

## Tools

| Tool | Description |
| --- | --- |
| `workers.list` | List available Workeros workers. |
| `workers.get` | Read one worker, including config and recent run metadata. |
| `workers.create` | Create a worker from `worker_yml` and `run_py`; documented secrets and connections are auto-filled when absent. |
| `workers.update` | Patch trigger, cron, default inputs, documented capabilities, or rotate a webhook secret. |
| `workers.delete` | Delete a worker and dependent run data. |
| `workers.run` | Start a manual worker run with input values. |
| `runs.list` | List runs, optionally filtered by worker id or status. |
| `runs.get` | Read one run with logs, outputs, artifacts, and approval state. |
| `runs.watch` | Stream run events until a terminal state or close event. |
