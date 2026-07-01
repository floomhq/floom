# Quickstart — your first Floom app in 5 minutes

By the end of this page you'll have a live Floom app with:

- a shareable URL at `https://floom.dev/p/<your-slug>`
- an MCP server any AI agent can call
- an HTTP endpoint (`POST /api/<your-slug>/run`)

All three from one `floom.yaml` manifest. No container ops, no API gateway wiring.

## 1. Install the CLI

```bash
curl -fsSL https://floom.dev/install.sh | bash
```

This installs the `floom` binary to `~/.local/bin/floom`. Add that to your `$PATH` if it isn't already, then verify:

```bash
floom --version
```

## 2. Sign in

```bash
floom auth <api-key>
```

Create an API key at `https://floom.dev/me/api-keys`, then save it with the command above. The key lives in `~/.floom/config.json` — don't commit it.

## 3. Scaffold your first app

```bash
mkdir hello-floom
cd hello-floom
floom init \
  --name "Petstore" \
  --description "List and create pets from the Swagger Petstore API." \
  --openapi-url https://petstore3.swagger.io/api/v3/openapi.json
```

You'll get one manifest:

```
floom.yaml        # manifest — OpenAPI URL, slug, visibility, metadata
```

Open `floom.yaml`. It wraps the OpenAPI service and lets Floom expose the same app through the web UI, MCP, and HTTP.

## 4. Deploy

```bash
floom deploy
```

The CLI:

1. Validates `floom.yaml` against the manifest schema.
2. Tarballs the working directory.
3. Uploads via `POST /api/hub/ingest`.
4. Prints the live app URL.

The first deploy builds a container image (≤ 10 min). Subsequent deploys reuse cached layers and finish in seconds.

When it's done you'll see:

```
Published: Petstore
  App page:    https://floom.dev/p/petstore
  MCP URL:     https://floom.dev/mcp/app/petstore
```

## 5. Run it

You can run your app three ways. All three hit the same code.

### From the browser

Open the URL the CLI printed. Fill in the input, hit **Run**, see the output. Every run gets its own permalink under `/r/<run-id>` that you can share.

### From an MCP-capable agent

Add this to your Claude Desktop or Cursor config (`~/.config/claude-desktop/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "floom": {
      "url": "https://floom.dev/mcp/app/<your-slug>"
    }
  }
}
```

Restart the agent. Your app shows up as callable tools from its OpenAPI actions.

### From a script

```bash
curl -X POST https://floom.dev/api/<your-slug>/run \
  -H "Authorization: Bearer $FLOOM_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"action": "listPets", "inputs": {}}'
```

All three transports share the same auth, rate limits, secret injection, and output log.

## 6. Iterate

Edit `floom.yaml` to change metadata, visibility, retention, or the OpenAPI URL. Then:

```bash
floom deploy
```

Each deploy is a new revision. Users hitting your slug get the latest. Old runs keep their original code reference.

## What to read next

- [Manifest reference](/docs/runtime-specs) — every field in `floom.yaml`, with examples.
- [Inputs and outputs](/docs/ownership) — file uploads, structured output, output panels.
- [Runtime limits](/docs/limits) — memory, CPU, timeout, rate limits per plan.
- [Self-host](/docs/self-host) — run your own Floom cluster in Docker Compose.
- [MCP install](/docs/mcp-install) — full setup for Claude Desktop, Cursor, Codex CLI.

## Troubleshooting

**`floom deploy` fails with `upstream_outage`**
Usually means the build container couldn't reach an external dependency. Re-run after a minute; if it persists, check [status.floom.dev](https://status.floom.dev).

**CLI can't find `floom` after install**
`~/.local/bin` isn't in your `$PATH`. Add `export PATH="$HOME/.local/bin:$PATH"` to `~/.zshrc` (or `~/.bashrc`) and restart your shell.

**I don't want to sign up — can I just try it?**
Run the featured apps at [floom.dev/apps](https://floom.dev/apps) (lead scoring, competitor analysis, resume screening). They're free, no signup required. When you're ready to build your own, come back here.
