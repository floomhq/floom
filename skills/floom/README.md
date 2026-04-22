# Floom skill for Claude Code

Build and deploy AI apps to Floom from Claude Code. Three slash commands:

- `/floom-init` — scaffold a `floom.yaml` in the current directory
- `/floom-deploy` — publish the app to floom.dev, return a live URL + MCP install snippet
- `/floom-status` — list your published apps + recent runs

## Install

Copy the `floom/` directory into your Claude Code skills folder:

```bash
cp -r skills/floom ~/.claude/skills/floom
```

Or clone this repo and symlink:

```bash
ln -s "$(pwd)/skills/floom" ~/.claude/skills/floom
```

Then restart Claude Code. Verify:

```
/floom-init
```

The first run will prompt you for an API token and an instance URL.

## Requirements

- `curl`
- `python3` with `PyYAML` (`pip install pyyaml`)
- `yq` (for `/floom-deploy`, used to read `floom.yaml` fields)

Missing `yq`? `brew install yq` or `snap install yq`.

## Auth

The skill stores your config at `~/.claude/floom-skill-config.json`:

```json
{
  "base_url": "https://floom.dev",
  "token": "<your-token>",
  "token_type": "session_cookie"
}
```

Two ways to get a token today:

1. **Cloud (floom.dev)**: the API-key UI is landing in v1.1. Until then, sign in at https://floom.dev/login, open DevTools > Application > Cookies, and copy the `better-auth.session_token` value. Set `token_type` to `session_cookie`.

2. **Self-host**: if you're running Floom from `docker.floom.dev` or the OSS repo, paste the value of `FLOOM_AUTH_TOKEN` from your server env. Set `token_type` to `bearer`. Point `base_url` at your instance (e.g. `http://localhost:3051`).

The config file is chmod 600. Do not check it into git.

## What gets deployed

- **OpenAPI apps** (any URL pointing at a `swagger.json` / `openapi.json`) deploy via `POST /api/hub/ingest`. The skill does the ingest call and returns the live URL.
- **Custom Python/Node apps** (like `examples/lead-scorer`) can't be published via HTTP yet. For now the skill points you at opening a PR against `github.com/floomhq/floom` under `examples/<slug>/`. A direct publish endpoint for custom runtimes is on the roadmap.

## Dry-run

Prefix any deploy call with `FLOOM_DRY_RUN=1` to print the request without sending:

```bash
FLOOM_DRY_RUN=1 bash scripts/floom-api.sh POST /api/hub/ingest '{"openapi_url":"..."}'
```

Useful for reviewing the request body before committing.

## Layout

```
skills/floom/
  SKILL.md                     # the skill spec Claude Code loads
  README.md                    # this file
  scripts/
    floom-api.sh               # auth'd curl wrapper
    floom-validate.sh          # floom.yaml validator
```

## License

Same as the parent repo (Floom is open-source under the repo's LICENSE).
