# Floom CLI

The Floom CLI scaffolds, validates, and deploys apps from the terminal.

- Install script: [`cli/floom/install.sh`](https://github.com/floomhq/floom/blob/main/cli/floom/install.sh)
- Source: [`cli/floom/`](https://github.com/floomhq/floom/tree/main/cli/floom)

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/floomhq/floom/main/cli/floom/install.sh | bash
```

The script installs the `floom` binary to `~/.local/bin/floom`. Add that to your `$PATH` if it isn't already.

Verify:

```bash
floom --version
```

## `floom init`

Scaffold a new hosted app in the current directory.

```bash
floom init my-app
cd my-app
ls
# floom.yaml  main.py  requirements.txt  README.md
```

The generated `floom.yaml` has a single `run` action with a text input and a text output. Edit it before your first deploy.

## `floom deploy`

Deploy the current directory's app to Floom Cloud, or to a self-hosted instance.

```bash
# Deploy to Floom Cloud (default)
floom deploy

# Deploy to a self-hosted instance
floom deploy --endpoint https://floom.mycompany.com
```

The CLI:

1. Validates `floom.yaml` against the manifest schema.
2. Builds a tarball of the working directory.
3. Uploads via `POST /api/hub/ingest`.
4. Prints the live app URL: `https://floom.dev/p/<slug>`.

First deploy can take up to 10 minutes (container image build). Subsequent deploys reuse cached layers.

## `floom status`

Check the status of the current app or a specific slug.

```bash
# Status of the app in the current directory
floom status

# Status of any app by slug
floom status --slug lead-scorer
```

Prints: last deploy time, run count (last 24h), last run status, error rate.

## `floom auth`

Sign in to the CLI. Opens a browser to `floom.dev/me/settings` and pastes back the API key you create there.

```bash
floom auth login
floom auth status
floom auth logout
```

The API key lives in `~/.config/floom/credentials`. Don't commit it.

## Use with CI/CD

For GitHub Actions or any CI runner:

```yaml
# .github/workflows/deploy.yml
- name: Deploy to Floom
  env:
    FLOOM_API_KEY: ${{ secrets.FLOOM_API_KEY }}
  run: |
    curl -fsSL https://raw.githubusercontent.com/floomhq/floom/main/cli/floom/install.sh | bash
    ~/.local/bin/floom deploy
```

`FLOOM_API_KEY` takes precedence over `~/.config/floom/credentials` when both are present.

## Claude Code skill

There's also a Claude Code skill that wraps the CLI and adds a narrative wrapper: see [`skills/claude-code/`](https://github.com/floomhq/floom/tree/main/skills/claude-code) in the repo. Point Claude Code at a directory and it will scaffold, deploy, and iterate on an app conversationally.

## Related pages

- [/docs/runtime-specs](/docs/runtime-specs) — `floom.yaml` reference
- [/docs/self-host](/docs/self-host) — where `--endpoint` points
- [/docs/api-reference](/docs/api-reference) — the HTTP surface the CLI uses
