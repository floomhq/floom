---
name: floom
description: Build and deploy AI apps to Floom from Claude Code. Use when the user says "deploy to Floom", "publish this to Floom", "/floom-init", "/floom-deploy", or "/floom-status". Creates a floom.yaml manifest, publishes the app to floom.dev, and returns a live URL plus an MCP install snippet.
---

# Floom Skill for Claude Code

Thin wrapper around the `floom` CLI. Three slash commands:

- `/floom-init` — scaffold a `floom.yaml` in the current directory
- `/floom-deploy` — publish the current app, return live URL + MCP snippet
- `/floom-status` — list the caller's published apps and recent runs

Docs: https://floom.dev/docs. Examples: https://github.com/floomhq/floom/tree/main/examples.

---

## One-time setup (auth)

The `floom` CLI resolves auth in this order:

1. `FLOOM_API_KEY` env var (+ optional `FLOOM_API_URL`, default `https://floom.dev`)
2. `~/.floom/config.json` written by `floom auth`
3. Legacy `~/.claude/floom-skill-config.json` (backward-compatible)

Check on first run:

```bash
floom auth --show 2>/dev/null || echo "NOT_CONFIGURED"
```

If not configured, prompt the user for their API key:

```
Get your Floom API key at https://floom.dev/me/api-keys, then run:

  floom auth <your-api-key>

Or for self-host:

  floom auth <your-api-key> http://localhost:3051
```

Run `floom auth <key>` — the CLI writes `~/.floom/config.json` (chmod 600).

Verify with `floom status` (expects JSON or "No apps yet", not an auth error).

---

## `/floom-init` — scaffold a new app

Ask one question at a time:

1. "What's the app called? (e.g. 'Lead Scorer')"
2. "One-sentence description?"
3. "Type? (a) wraps an existing OpenAPI service, or (b) custom Python code"
4. If `a`: "OpenAPI spec URL?"
5. If `b`: "Secrets needed? (comma-separated, e.g. GEMINI_API_KEY)"

Derive slug: lowercase, dashes only, matches `^[a-z0-9][a-z0-9-]{0,47}$`.

Then run:

```bash
floom init
```

The CLI prompts interactively. If a flag shortcut is needed, run with `--name`, `--description`, etc. (see `floom init --help`).

Stop after scaffolding. Do NOT deploy from `/floom-init`.

---

## `/floom-deploy` — publish to Floom

```bash
floom deploy
```

Or for a dry-run preview:

```bash
floom deploy --dry-run
```

On success the CLI prints:

```
Published: <name>
  App page:    https://floom.dev/p/<slug>
  MCP URL:     https://floom.dev/mcp/app/<slug>
  Owner view:  https://floom.dev/me/apps/<slug>

Add to Claude Desktop config:
  {"mcpServers":{"floom-<slug>":{"command":"npx","args":["-y","mcp-remote","https://floom.dev/mcp/app/<slug>"]}}}
```

On 409 `slug_taken`: show the response `suggestions` array, ask the user to pick one, update `floom.yaml`, retry.

**Python/Node (custom code):** no public publish HTTP API yet. The CLI will print:

```
Custom Python/Node apps can't be published via HTTP yet. Options:
  1. Open a PR against floomhq/floom with your dir under examples/<slug>/.
  2. Wrap your code in a thin HTTP server, publish an OpenAPI spec, and re-run 'floom deploy'.
```

---

## `/floom-status` — my apps + recent runs

```bash
floom status
```

Render two tables from the output: `slug / visibility / status / runs / last_run`, and `run_id / app / action / status / duration`. If empty:

```
No apps yet. Run /floom-init to scaffold one.
```

---

## Error handling

| HTTP | Code | What to say |
|------|------|-------------|
| 401 | auth_required | "Floom token isn't working. Run `floom auth --clear` then `floom auth <key>` to re-auth." |
| 400 | invalid_body | Show `details` from response, point at the bad field. |
| 400 | detect_failed | "Couldn't reach or parse <url>. Does `curl <url>` return valid JSON/YAML?" |
| 409 | slug_taken | Show `suggestions`, ask user to pick, retry. |
| 5xx | — | "Floom returned <code>. Retry in a minute or check https://floom.dev/status." |

Never retry on 4xx. 5xx may retry once with 2s backoff.

---

## Gaps flagged for launch

1. **No publish endpoint for custom runtimes.** `POST /api/hub/ingest` only accepts OpenAPI URLs; Python/Docker apps like `lead-scorer` get seeded from `examples/` on server boot. The skill routes users to open a PR.
2. **No server-side dry-run.** Skill simulates dry-run client-side via `FLOOM_DRY_RUN=1`. A `?dry_run=1` on `/api/hub/ingest` would let users preview the parsed manifest.
