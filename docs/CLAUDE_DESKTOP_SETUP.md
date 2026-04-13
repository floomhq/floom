# Claude Desktop Setup

Connect any Floom app as an MCP server in Claude Desktop.

## Adding a Floom app

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "flyfast": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://preview.floom.dev/mcp/app/flyfast"]
    },
    "floom-search": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://preview.floom.dev/mcp/search"]
    }
  }
}
```

Replace `flyfast` with any app slug from [preview.floom.dev](https://preview.floom.dev). The `/mcp/search` endpoint lets Claude search all available apps.

## Self-hosted instance

If you're running Floom locally (see [SELF_HOST.md](./SELF_HOST.md)):

```json
{
  "mcpServers": {
    "my-app": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "http://localhost:3051/mcp/app/my-app"]
    }
  }
}
```

## Verification

The MCP handshake is verified working. These curl commands reproduce what Claude Desktop sends:

```bash
# Initialize
curl -s -X POST https://preview.floom.dev/mcp/app/flyfast \
  -H "content-type: application/json" \
  -H "accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"0.0.1"}}}'

# List tools
curl -s -X POST https://preview.floom.dev/mcp/app/flyfast \
  -H "content-type: application/json" \
  -H "accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'

# Call a tool
curl -s -X POST https://preview.floom.dev/mcp/app/flyfast \
  -H "content-type: application/json" \
  -H "accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"search","arguments":{"prompt":"Berlin to Lisbon"}}}'
```

All three return valid JSON-RPC responses. The `accept` header must include both `application/json` and `text/event-stream` — this is required by the MCP Streamable HTTP transport spec.

## Available apps

| Slug | Description |
|------|-------------|
| `flyfast` | Flight search |
| `blast-radius` | Find files affected by git changes |
| `bouncer` | Gemini quality audit |
| `openpaper` | Paper research assistant |
| `opendraft` | Document drafting |
| ...and 10 more | See `/api/hub` |

Full list: `curl https://preview.floom.dev/api/hub | jq '.[].slug'`
