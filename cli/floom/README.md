# Floom CLI

Deploy AI apps to Floom from any shell or agent.

Built-in Claude Code + Cursor packages ship alongside. Works with Codex CLI, Aider, Continue, or any bash-capable agent.

## Install

Curl installer (preferred, when live):

```bash
curl -fsSL https://floom.dev/install.sh | bash
```

Manual install (works today):

```bash
git clone https://github.com/floomhq/floom.git ~/.floom/repo
export PATH="$HOME/.floom/repo/cli/floom/bin:$PATH"
floom --help
```

> Manual install above works without the hosted installer path if you want a fully transparent setup.

> **Do not run `npm install floom`.** The unscoped `floom` name on npm belongs to an unrelated third-party streaming tool; installing it will not give you the Floom CLI. Use the curl installer or the manual clone above.

> **Do not run `npm install floom`.** The unscoped `floom` name on npm belongs to an unrelated third-party streaming tool; installing it will not give you the Floom CLI. Use the curl installer or the manual clone above.

## Requirements

- `bash` (4+ preferred, works on 3.2)
- `curl`
- `python3` (stdlib only; `PyYAML` helps if `yq` missing)
- `yq` optional for `floom deploy` (falls back to `python3 -c "import yaml"`)

## Commands

```text
floom init                     scaffold a floom.yaml in the current directory
floom deploy [--dry-run]       validate + publish the current app
floom status                   list your apps and recent runs
floom auth <api-key> [url]     save API key to ~/.floom/config.json
floom --help                   show usage
floom --version                print version
```

## Auth

Order of resolution:

1. `FLOOM_API_KEY` env var (+ optional `FLOOM_API_URL`, default `https://floom.dev`)
2. `~/.floom/config.json` with `{"api_key": "...", "api_url": "https://floom.dev"}`
3. Legacy `~/.claude/floom-skill-config.json` (from the old Claude Code skill)

Get your API key at https://floom.dev/me/api-keys, then:

```bash
floom auth sk_live_xxx
```

Self-host:

```bash
floom auth sk_live_xxx http://localhost:3051
```

Env-only (CI):

```bash
export FLOOM_API_KEY=sk_live_xxx
export FLOOM_API_URL=https://floom.dev
floom status
```

## Typical flow

```bash
# wrap an existing OpenAPI service
floom init --name "Lead Scorer" --description "Score leads" --openapi-url https://example.com/openapi.json
floom deploy --dry-run     # preview the request
floom deploy               # publish
floom status               # see it listed
```

## Network allowlist

Hosted Docker apps declare outbound access in `floom.yaml`:

```yaml
network:
  allowed_domains:
    - api.openai.com
    - "*.example-api.com"
```

Use `allowed_domains: []` to block all outbound network. The validator rejects
`*`, URLs, ports, IP literals, invalid domains, and lists over 20 entries.

## Agent packages

- **Claude Code**: `skills/claude-code/` — drop into `~/.claude/skills/floom/`, provides `/floom-init`, `/floom-deploy`, `/floom-status`.
- **Cursor**: `skills/cursor/` — `floom.mdc` Cursor rules file.
- **Anything else**: shell out to `floom` directly. Aider, Continue, Codex CLI, etc. all work.

## Layout

```text
cli/floom/
  bin/floom              entrypoint (dispatches subcommands)
  lib/floom-api.sh       auth'd curl wrapper
  lib/floom-validate.sh  floom.yaml validator
  lib/floom-init.sh      init subcommand
  lib/floom-deploy.sh    deploy subcommand
  lib/floom-status.sh    status subcommand
  lib/floom-auth.sh      auth subcommand
  VERSION                semver
  install.sh             curl-installable bootstrapper
```

## Dry-run

```bash
floom deploy --dry-run
# or
FLOOM_DRY_RUN=1 floom deploy
```

Prints the exact request without sending.

## Exit codes

- `0` success
- `1` bad args, missing config, validation failure, missing floom.yaml
- `2` non-2xx HTTP response (body printed to stdout, status to stderr)

## License

Apache 2.0 (matches the parent repo).
