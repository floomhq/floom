# Floom

Deploy Python scripts as cloud automations. No infra, no Docker, no YAML. Just use this skill, get a shareable web UI with scheduling, managed secrets, and execution history.

## Install (Claude Code)

```bash
curl -sL https://dashboard.floom.dev/install-skill.sh | bash
```

Then type `/floom` in Claude Code to deploy your first script. It will ask for your API key on first use — get it from [dashboard.floom.dev/settings](https://dashboard.floom.dev/settings).

### Alternative: clone manually

```bash
git clone https://github.com/floomhq/floom.git ~/.claude/skills/floom-repo
~/.claude/skills/floom-repo/scripts/setup
```

## What it does

- Adapts your Python script to a cloud-ready format
- Tests it in a secure sandbox before deploying
- Gives you a shareable URL where your agents or coworkers can run it
- Manages secrets, scheduling, and version history
