# Floom for agents

Short, stable reference for AI coding agents (Claude Code, Cursor, Codex, Aider, Continue, or any bash-capable agent) pointed at https://floom.dev. Machine-parseable service descriptor lives at `/.well-known/floom.json`.

## What Floom is

The protocol and runtime for agentic work. Point Floom at an OpenAPI spec (or a repo containing a `floom.yaml`) and you get:

- A **web page** a human can use (`https://floom.dev/p/<slug>`)
- An **MCP server** a Claude/Cursor agent can install (`https://floom.dev/mcp/app/<slug>`)
- A **typed HTTP endpoint** (`POST https://floom.dev/api/<slug>/<operation>`)

Built-in auth, rate limits, secret injection, and run history.

## Install the CLI

Supported install path (Linux or macOS):

```bash
curl -fsSL https://floom.dev/install.sh | bash
```

Manual install (works today, no install.sh dependency):

```bash
git clone https://github.com/floomhq/floom.git ~/.floom/repo
export PATH="$HOME/.floom/repo/cli/floom/bin:$PATH"
floom --help
```

> **Do NOT run `npm install floom`.** The unscoped `floom` name on npm belongs to an unrelated third-party streaming tool — it will not give you the Floom CLI. Use the curl installer or the manual clone above.

Full CLI reference: https://github.com/floomhq/floom/blob/main/cli/floom/README.md

## Publish an app (three commands)

```bash
export FLOOM_API_KEY=floom_...          # mint one at https://floom.dev/me/api-keys
floom auth --check                      # verify the key reaches the API
floom deploy <path-to-floom.yaml>       # or `floom init --openapi-url <spec-url>` first
```

`floom deploy` reads a `floom.yaml`. If you only have an OpenAPI URL, scaffold one first:

```bash
floom init --name "Resend" --openapi-url https://raw.githubusercontent.com/resend/resend-openapi/main/resend.yaml
floom deploy
```

## Machine-readable endpoints

- Service descriptor: https://floom.dev/.well-known/floom.json
- OpenAPI spec: https://floom.dev/openapi.json
- App catalog (JSON): `GET https://floom.dev/api/hub`
- Single app metadata: `GET https://floom.dev/api/hub/:slug`
- Run over HTTP: `POST https://floom.dev/api/:slug/run` (or `POST /api/:slug/:operation` for typed operations)
- MCP server for one app: `https://floom.dev/mcp/app/:slug`
- MCP aggregator (all apps): `https://floom.dev/mcp`
- Ingest an app: `POST https://floom.dev/api/hub/ingest` (bearer auth)
- Protocol spec: https://floom.dev/protocol

## Auth

```
Authorization: Bearer floom_<your-api-key>
```

Mint keys at https://floom.dev/me/api-keys. The CLI also accepts `FLOOM_API_KEY` via env or `~/.floom/config.json`.

## Self-host

Single Docker container, same codebase as the hosted cloud:

```bash
docker run -p 3010:3010 ghcr.io/floomhq/floom-monorepo:latest
```

Full guide: https://github.com/floomhq/floom/blob/main/docs/SELF_HOST.md

## Links

- Repo: https://github.com/floomhq/floom (MIT license)
- Docs: https://floom.dev/docs
- Discord: https://discord.gg/8fXGXjxcRz
- Issues: https://github.com/floomhq/floom/issues
