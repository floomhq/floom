# Quickstart — your first Floom app in 5 minutes

By the end of this page you'll have a live Floom app with:

- a shareable URL at `https://floom.dev/p/<your-slug>`
- an MCP server any AI agent can call
- an HTTP endpoint (`POST /api/run/<your-slug>`)

All three from one `floom.yaml` manifest. No container ops, no API gateway wiring.

## 1. Install the CLI

```bash
curl -fsSL https://raw.githubusercontent.com/floomhq/floom/main/cli/floom/install.sh | bash
```

This installs the `floom` binary to `~/.local/bin/floom`. Add that to your `$PATH` if it isn't already, then verify:

```bash
floom --version
```

## 2. Sign in

```bash
floom auth login
```

The CLI opens `floom.dev` in your browser. Sign in (email or GitHub / Google OAuth), create an API key, and paste it back. The key lives in `~/.config/floom/credentials` — don't commit it.

## 3. Scaffold your first app

```bash
floom init hello-floom
cd hello-floom
```

You'll get four files:

```
floom.yaml        # manifest — inputs, output, auth, secrets
main.py           # your code — runs inside a sandbox
requirements.txt  # Python deps
README.md
```

Open `floom.yaml`. It's a single action called `run` with one text input and a text output. That's enough for your first deploy — no edits needed yet.

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
✓ Deployed hello-floom
  https://floom.dev/p/hello-floom
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
      "url": "https://floom.dev/mcp/<your-slug>"
    }
  }
}
```

Restart the agent. Your app shows up as a callable tool. Ask Claude to "use hello-floom with input 'hi' and show me the output".

### From a script

```bash
curl -X POST https://floom.dev/api/run/<your-slug> \
  -H "Authorization: Bearer $FLOOM_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"input_text": "hello"}'
```

All three transports share the same auth, rate limits, secret injection, and output log.

## 6. Iterate

Edit `main.py` — do whatever real work you want (call an LLM, hit an API, process a file). Bump a secret into `floom.yaml`'s `secrets_needed` list if you need one. Then:

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
