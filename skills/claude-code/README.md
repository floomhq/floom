# Floom skill for Claude Code

Build and deploy AI apps to Floom from Claude Code. Three slash commands:

- `/floom-init` — scaffold a `floom.yaml` in the current directory
- `/floom-deploy` — publish the app to floom.dev, return a live URL + MCP install snippet
- `/floom-status` — list your published apps + recent runs

This skill is a thin wrapper. It calls the `floom` CLI, which must be installed first.

## Install the CLI

```bash
git clone --depth 1 https://github.com/floomhq/floom.git ~/.floom/repo
export PATH="$HOME/.floom/repo/cli/floom/bin:$PATH"
floom --version
```

Or use the curl installer (when live):

```bash
curl -fsSL https://floom.dev/install.sh | bash
```

## Install this skill

Copy into your Claude Code skills folder:

```bash
cp -r skills/claude-code ~/.claude/skills/floom
```

Or symlink from the repo:

```bash
ln -s "$(pwd)/skills/claude-code" ~/.claude/skills/floom
```

Restart Claude Code. Verify: `/floom-init`.

## Requirements

- `floom` CLI on PATH (see above)
- `curl`
- `python3` (stdlib only; `PyYAML` optional)
- `yq` optional (falls back to python3 if missing)

## Auth

Run once after installing:

```bash
floom auth <your-api-key>
```

Get your key at https://floom.dev/me/api-keys.

For self-host:

```bash
floom auth <your-api-key> http://localhost:3051
```

Config is stored at `~/.floom/config.json` (chmod 600). Do not check it into git.

You can also set `FLOOM_API_KEY` as an env var (useful in CI):

```bash
export FLOOM_API_KEY=sk_live_xxx
floom status
```

## Layout

```
skills/claude-code/
  SKILL.md       the skill spec Claude Code loads
  README.md      this file
```

The CLI lives at `cli/floom/`. Scripts at `cli/floom/lib/`.

## License

Apache 2.0 (matches the parent repo).
