# Floom

Deploy Python scripts as cloud automations. No infra, no Docker, no YAML. Just use this skill, get a shareable web UI with scheduling, managed secrets, and execution history.

## Install (Claude Code)

Paste this into Claude Code:

```
curl -sL https://dashboard.floom.dev/install-skill.sh | bash
```

Then:

1. Get your API key from [dashboard.floom.dev/settings](https://dashboard.floom.dev/settings)
2. Add it to `~/.claude/floom-config.json`
3. Type `/floom` to deploy your first script

## What it does

- Adapts your Python script to a cloud-ready format
- Tests it in a secure sandbox before deploying
- Gives you a shareable URL where your agents or coworkers can run it
- Manages secrets, scheduling, and version history
