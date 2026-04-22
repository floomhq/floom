# Floom agent packages

Floom CLI works from any shell or agent. These packages add first-class support for
Claude Code and Cursor. Codex CLI, Aider, Continue, and any bash-capable agent can
shell out to `floom` directly.

## Packages

| Agent | Directory | What it provides |
|-------|-----------|-----------------|
| Claude Code | `skills/claude-code/` | `/floom-init`, `/floom-deploy`, `/floom-status` slash commands |
| Cursor | `skills/cursor/` | `floom.mdc` rules file; agent shells out to `floom` CLI |

## CLI first

All packages call the `floom` CLI. Install it once:

```bash
git clone --depth 1 https://github.com/floomhq/floom.git ~/.floom/repo
export PATH="$HOME/.floom/repo/cli/floom/bin:$PATH"
floom auth <your-api-key>
```

Key at https://floom.dev/me/settings/tokens.

## Any other agent

Shell out to `floom` directly:

```bash
floom init
floom deploy --dry-run
floom deploy
floom status
```

Works with Codex CLI, Aider, Continue, or any agent that can run bash.
