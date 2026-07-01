# Floom CLI

The Floom CLI scaffolds, validates, and deploys apps from the terminal.

- Install script: [`https://floom.dev/install.sh`](https://floom.dev/install.sh)
- Source: [`cli/floom/`](https://github.com/floomhq/floom/tree/main/cli/floom)

## Install

```bash
curl -fsSL https://floom.dev/install.sh | bash
```

The script installs the `floom` binary to `~/.local/bin/floom`. Add that to your `$PATH` if it isn't already.

Verify:

```bash
floom --version
```

## `floom init`

Scaffold a new hosted app manifest in the current directory.

```bash
mkdir my-app
cd my-app
floom init --name "My App" --description "Echo text input." --type custom
ls
# floom.yaml  main.py  Dockerfile
```

The generated `floom.yaml` has a single `run` action with a text input and a text output. Edit it before your first deploy.

## `floom deploy`

Deploy the current directory's app to Floom Cloud, or to a self-hosted instance configured with `floom auth <api-key> <api-url>`.

```bash
# Deploy to Floom Cloud (default)
floom deploy

# Deploy to a self-hosted instance
floom auth <api-key> https://floom.mycompany.com
floom deploy
```

The CLI:

1. Validates `floom.yaml` against the manifest schema.
2. Publishes proxied OpenAPI apps via `POST /api/hub/ingest`.
3. Prints the live app URL: `https://floom.dev/p/<slug>`.

First deploy can take up to 10 minutes (container image build). Subsequent deploys reuse cached layers.

## `floom status`

List the apps owned by the caller and recent runs.

```bash
floom status
```

Prints: owned apps and recent runs. The command exits non-zero when either API request fails.

## `floom auth`

Save, inspect, or clear the CLI API key. Create the key at `https://floom.dev/me/api-keys`.

```bash
floom auth <api-key>
floom auth --show
floom auth --clear
```

The API key lives in `~/.floom/config.json`. Do not commit it.

## Use with CI/CD

For GitHub Actions or any CI runner:

```yaml
# .github/workflows/deploy.yml
- name: Deploy to Floom
  env:
    FLOOM_API_KEY: ${{ secrets.FLOOM_API_KEY }}
  run: |
    curl -fsSL https://floom.dev/install.sh | bash
    ~/.local/bin/floom deploy
```

`FLOOM_API_KEY` takes precedence over `~/.floom/config.json` when both are present.

## Claude Code skill

There's also a Claude Code skill that wraps the CLI and adds a narrative wrapper: see [`skills/claude-code/`](https://github.com/floomhq/floom/tree/main/skills/claude-code) in the repo. Point Claude Code at a directory and it will scaffold, deploy, and iterate on an app conversationally.

## Related pages

- [/docs/runtime-specs](/docs/runtime-specs) — `floom.yaml` reference
- [/docs/self-host](/docs/self-host) — where `--endpoint` points
- [/docs/api-reference](/docs/api-reference) — the HTTP surface the CLI uses
