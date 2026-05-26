# Workeros MCP

Local stdio MCP server for managing Workeros workers and runs from agents.

```bash
npx -y @floomhq/workeros-mcp
```

Set `WORKEROS_API_SECRET` in the agent environment. The server targets `https://workers-api.floom.dev` by default. For development, set `WORKEROS_API_BASE`.

## Claude Code

```json
{
  "mcpServers": {
    "workeros": {
      "command": "npx",
      "args": ["-y", "@floomhq/workeros-mcp"],
      "env": {
        "WORKEROS_API_SECRET": "..."
      }
    }
  }
}
```

## Cursor

```json
{
  "mcpServers": {
    "workeros": {
      "command": "npx",
      "args": ["-y", "@floomhq/workeros-mcp"],
      "env": {
        "WORKEROS_API_SECRET": "..."
      }
    }
  }
}
```

## Continue

```json
{
  "mcpServers": [
    {
      "name": "workeros",
      "command": "npx",
      "args": ["-y", "@floomhq/workeros-mcp"],
      "env": {
        "WORKEROS_API_SECRET": "..."
      }
    }
  ]
}
```

## Tools

- `workers.list`
- `workers.get`
- `workers.create`
- `workers.update`
- `workers.delete`
- `workers.run`
- `runs.list`
- `runs.get`
- `runs.watch`

`workers.create` accepts WorkerContract YAML in `worker_yml` and Python source in `run_py`. Capabilities are optional documentation and are passed through without MCP-side enforcement.
