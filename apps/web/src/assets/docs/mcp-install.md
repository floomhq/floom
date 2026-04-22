# Install Floom in an MCP client

Every Floom app exposes itself as an MCP server. Wire it up in Claude Desktop, Claude Code, Cursor, Codex CLI, or any MCP-compliant client, and the agent can run the app like any other tool.

## Three surfaces

Floom surfaces three URLs that matter to an MCP client. Pick the one that matches what you're doing.

| Surface | URL | What it does | Auth |
|---|---|---|---|
| **Run an app** | `https://mcp.floom.dev/app/<slug>` | One MCP endpoint per published app. Invoke with JSON input, get structured JSON back. | None for public apps. Bearer token for private / paid apps. |
| **Discover apps** | `https://mcp.floom.dev/search` | List and search every public app. The agent can pick a tool at runtime. | None. |
| **Manage your apps** | `https://floom.dev/studio` | Web UI to create, update, redeploy, rotate secrets. **Not** an MCP endpoint. | Your Floom account. |

Most users wire `/search` plus one or two `/app/<slug>` endpoints and do everything else from the Studio.

## Claude Desktop

Open the config file and add entries under `mcpServers`.

- **Mac:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "floom-search":       { "url": "https://mcp.floom.dev/search" },
    "floom-lead-scorer":  { "url": "https://mcp.floom.dev/app/lead-scorer" },
    "floom-resume-screener": {
      "url": "https://mcp.floom.dev/app/resume-screener",
      "headers": { "Authorization": "Bearer flm_live_..." }
    }
  }
}
```

Quit Claude Desktop (Cmd+Q on Mac), reopen it, then ask: *"What Floom apps exist for lead scoring?"* Claude will call `floom-search`, then hit `floom-lead-scorer` on the one you pick. Add the `Authorization` header only on apps that require a key.

## Claude Code

Claude Code reads `~/.config/claude-code/mcp.json` (Mac / Linux) or the equivalent `%APPDATA%` path on Windows. The schema is identical to Claude Desktop.

```json
{
  "mcpServers": {
    "floom-lead-scorer": { "url": "https://mcp.floom.dev/app/lead-scorer" }
  }
}
```

Restart Claude Code after editing. The app appears as a tool in the next session.

## Cursor

Cursor reads `~/.cursor/mcp.json`. Same shape as Claude Desktop.

```json
{
  "mcpServers": {
    "floom-lead-scorer": { "url": "https://mcp.floom.dev/app/lead-scorer" },
    "floom-competitor":  { "url": "https://mcp.floom.dev/app/competitor-analyzer" }
  }
}
```

Reload Cursor after editing (Cmd+Shift+P → "Reload Window").

## Codex CLI

Codex CLI reads `~/.codex/mcp.json`. Same schema.

```json
{
  "mcpServers": {
    "floom-search":     { "url": "https://mcp.floom.dev/search" },
    "floom-competitor": { "url": "https://mcp.floom.dev/app/competitor-analyzer" }
  }
}
```

## Any other MCP client

Anything that speaks the MCP spec works: VS Code Continue, Zed, OpenAI ChatGPT's MCP bridge. The URL shape never changes:

- Specific app: `https://mcp.floom.dev/app/<slug>`
- Discovery: `https://mcp.floom.dev/search`

If your client requires a different transport (stdio instead of HTTP), run the self-hosted Floom image locally and point the client at `http://localhost:3051/mcp/app/<slug>`.

## Authenticated apps

Private apps and paid apps require a bearer token. Get one from `floom.dev/me/settings` and add it to the `headers` block for that specific server:

```json
{
  "mcpServers": {
    "floom-private-app": {
      "url": "https://mcp.floom.dev/app/my-private-app",
      "headers": { "Authorization": "Bearer flm_live_..." }
    }
  }
}
```

Public apps need no auth. The token is per-account; rotate it from the same settings page.

## Per-app install flow

Every app page on floom.dev has an **Install in Claude** button that opens a dedicated page at `floom.dev/install/<slug>` with the JSON already filled in for that app. Copy, paste, done.

## Related pages

- [/docs/self-host](/docs/self-host)
- [/docs/runtime-specs](/docs/runtime-specs)
- [/docs/api-reference](/docs/api-reference)
